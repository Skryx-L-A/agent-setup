"""Fallenbuch-Tripwire: Kernlogik, nur Standardbibliothek.

Grundlage: ~/Knowledge/20-projects/brain3/brain5-forschung-gedaechtnis.md, Ideen I2
(Fallen am Ort der Handlung), I6 (Entscheidungsbuch mit Gueltigkeit) und I10 (verifizierte
Erinnerung). Schema der Fallenbuch-Datei: FALLEN-SCHEMA.md in diesem Verzeichnis.

Importierbar fuer zwei Aufrufer:
  - tripwire_cli.py (der PreToolUse-Hook selbst, liest stdin-JSON, schreibt stdout-JSON)
  - die parallele Spur `replay-messung` (_meta/tools/eval/replay/), die denselben
    Entscheid gegen historische Werkzeugaufrufe nachrechnet, ueber `tripwire_for(...)`.

Dieses Modul haengt an nichts ausser der Python-Standardbibliothek: kein PyYAML, kein
Netzwerk, kein Modell, kein `git`-Unterprozess (Projekterkennung liest `.git/config`
direkt, siehe Kommentar dort -- ein Prozessstart je Werkzeugaufruf waere fuer die
50-ms-Frist zu teuer). Fehlt die Information, wird das Projekt einfach nicht gefunden
und der Hook bleibt still (fail-open, nie blockierend).
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
from pathlib import Path
from typing import Any

# ===========================================================================
# Minimaler YAML-Lader fuer genau das FALLEN.yaml-Schema
# ===========================================================================
# Kein PyYAML (Auftrag: "nur Standardbibliothek"). Unterstuetzt wird die in
# FALLEN-SCHEMA.md dokumentierte Teilmenge: verschachtelte Mappings/Sequenzen ueber
# Einrueckung (Leerzeichen, keine Tabs), Skalare als einfach/doppelt zitierte Strings,
# Ganzzahlen, `null`/`~`/leer als None, sonst roher String. Einzeilige Kommentare
# (Zeile beginnt nach dem Trimmen mit '#') werden uebersprungen; Inline-Kommentare
# werden NICHT unterstuetzt -- die selbst erzeugte Datei braucht keine.


class FallenYamlError(ValueError):
    pass


def _preprocess(text: str) -> list[tuple[int, str]]:
    out = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        stripped = line.lstrip(" ")
        if stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if "\t" in line[:indent]:
            raise FallenYamlError("Tabs in der Einrueckung sind nicht erlaubt")
        out.append((indent, stripped))
    return out


def _parse_scalar(text: str) -> Any:
    text = text.strip()
    if text == "":
        return None
    if text in ("null", "~", "Null", "NULL"):
        return None
    if text in ("true", "True", "TRUE"):
        return True
    if text in ("false", "False", "FALSE"):
        return False
    if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
        return text[1:-1].replace("''", "'")
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        inner = text[1:-1]
        return (
            inner.replace('\\"', '"')
            .replace("\\n", "\n")
            .replace("\\\\", "\\")
        )
    try:
        return int(text)
    except ValueError:
        return text


def _parse_mapping(lines: list[tuple[int, str]], idx: int, indent: int):
    result: dict[str, Any] = {}
    n = len(lines)
    while idx < n:
        cur_indent, content = lines[idx]
        if cur_indent != indent or content.startswith("- "):
            break
        if ":" not in content:
            raise FallenYamlError("Zeile ohne ':' in einem Mapping: %r" % content)
        key, _, rest = content.partition(":")
        key = key.strip()
        rest = rest.strip()
        idx += 1
        if rest == "":
            if idx < n and lines[idx][0] > indent:
                child_indent = lines[idx][0]
                value, idx = _parse_node(lines, idx, child_indent)
            else:
                value = None
        else:
            value = _parse_scalar(rest)
        result[key] = value
    return result, idx


def _parse_sequence(lines: list[tuple[int, str]], idx: int, indent: int):
    result: list[Any] = []
    n = len(lines)
    while idx < n:
        cur_indent, content = lines[idx]
        if cur_indent != indent or not content.startswith("-"):
            break
        marker_len = len(content) - len(content.lstrip("-"))
        after_dash = content[marker_len:]
        item_text = after_dash.lstrip(" ")
        virtual_indent = indent + (len(content) - len(item_text))
        idx += 1
        if item_text == "":
            if idx < n and lines[idx][0] > indent:
                child_indent = lines[idx][0]
                value, idx = _parse_node(lines, idx, child_indent)
            else:
                value = None
        elif ":" in item_text and not (
            item_text[0] in "'\"" or _looks_like_plain_scalar_with_colon(item_text)
        ):
            sub_lines = [(virtual_indent, item_text)]
            while idx < n and lines[idx][0] > indent:
                sub_lines.append(lines[idx])
                idx += 1
            value, _ = _parse_mapping(sub_lines, 0, virtual_indent)
        else:
            value = _parse_scalar(item_text)
        result.append(value)
    return result, idx


def _looks_like_plain_scalar_with_colon(text: str) -> bool:
    """True, wenn der ':' zu einem zitierten String gehoert statt einen Mapping-Key
    einzuleiten -- z.B. '- "a: b"'. Ohne Quote am Anfang gilt jedes ':' als Mapping."""
    return False


def _parse_node(lines: list[tuple[int, str]], idx: int, indent: int):
    if idx >= len(lines):
        return None, idx
    _cur_indent, content = lines[idx]
    if content.startswith("- ") or content == "-":
        return _parse_sequence(lines, idx, indent)
    return _parse_mapping(lines, idx, indent)


def yaml_load(text: str) -> Any:
    lines = _preprocess(text)
    if not lines:
        return {}
    value, idx = _parse_node(lines, 0, lines[0][0])
    return value


# ===========================================================================
# FALLEN.yaml laden, nach mtime gecacht
# ===========================================================================

_CACHE: dict[str, tuple[float, list[dict]]] = {}


def load_fallen(path: "os.PathLike | str") -> list[dict]:
    """Nur `status: gilt`-Eintraege mit mindestens einem `ausloeser`-Element.
    Kaputte/fehlende Datei -> leere Liste, still (nie eine Exception nach aussen)."""
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return []
    key = str(p)
    cached = _CACHE.get(key)
    if cached is not None and cached[0] == st.st_mtime:
        return _ohne_gelernte(cached[1])
    try:
        data = yaml_load(p.read_text(encoding="utf-8"))
        rows = data.get("fallen") if isinstance(data, dict) else None
        entries = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            if row.get("status") != "gilt":
                continue
            if not row.get("ausloeser"):
                continue
            entries.append(row)
    except Exception:
        entries = []
    _CACHE[key] = (st.st_mtime, entries)
    return _ohne_gelernte(entries)


def _ohne_gelernte(entries: list[dict]) -> list[dict]:
    """`BRAIN_TRIPWIRE_GELERNT=0` schaltet die von der Pipeline gelernten Eintraege
    (`id: brain-*`, Ausloeser aus d1) ab; Hand-Eintraege bleiben (Nr. 31: abschaltbar)."""
    if os.environ.get("BRAIN_TRIPWIRE_GELERNT", "1") != "0":
        return entries
    return [e for e in entries if not str(e.get("id", "")).startswith("brain-")]


GLOBAL_FALLEN = Path("10-global") / "FALLEN.yaml"


def globale_fallen(vault: "os.PathLike | str", vorhandene_ids: "set[str] | None" = None) -> list[dict]:
    """Projektunabhaengiges Fallenbuch `10-global/FALLEN.yaml` (Shell- und Commit-Fallen
    aus globalen Notizen). Gilt fuer jeden Arbeitsordner, auch ohne erkanntes Projekt.
    `BRAIN_TRIPWIRE_GLOBAL=0` schaltet es ab. Eintraege mit einer schon im Projekt-
    Fallenbuch vorhandenen `id` werden nicht doppelt geliefert."""
    if os.environ.get("BRAIN_TRIPWIRE_GLOBAL", "1") == "0":
        return []
    vorhandene_ids = vorhandene_ids or set()
    return [dict(e, _global=True) for e in load_fallen(Path(vault) / GLOBAL_FALLEN)
            if str(e.get("id") or "") not in vorhandene_ids]


# ===========================================================================
# Projekterkennung -- spiegelt session-context.sh (Git-Remote -> projekte.tsv,
# sonst Ordnername == Projektname unter 20-projects/), aber OHNE `git`-Unterprozess:
# ein PreToolUse-Hook feuert bei JEDEM Werkzeugaufruf, und ein Prozessstart je
# `git`-Aufruf kostet gemessen ~8-9 ms (`git remote get-url origin`, 20 Laeufe,
# Median) -- zusammen mit dem Python-Start (~20 ms) waere die 50-ms-Frist (I2)
# schon mit zwei Git-Aufrufen knapp. Gelesen wird deshalb direkt `.git/config`
# (bzw. bei einem Arbeitsverzeichnis/Worktree ueber `gitdir:`/`commondir` bis zur
# echten Config) -- dieselbe Information, ohne Prozessstart.


def _git_dir_for(repo_root: Path) -> Path | None:
    """Das tatsaechliche GIT_DIR fuer `repo_root`: der `.git`-Ordner direkt, oder bei
    einem Arbeitsverzeichnis (`.git` ist dort eine Datei mit `gitdir: <pfad>`) das
    Ziel dieser Datei."""
    dotgit = repo_root / ".git"
    if dotgit.is_dir():
        return dotgit
    if dotgit.is_file():
        try:
            first_line = dotgit.read_text(encoding="utf-8").splitlines()[0]
        except (OSError, IndexError):
            return None
        if not first_line.startswith("gitdir:"):
            return None
        target = first_line.split(":", 1)[1].strip()
        target_path = Path(target)
        if not target_path.is_absolute():
            target_path = (repo_root / target_path).resolve()
        return target_path if target_path.exists() else None
    return None


def _common_git_dir(git_dir: Path) -> Path:
    """Bei einem Arbeitsverzeichnis liegt `config` nicht im eigenen GIT_DIR, sondern im
    gemeinsamen GIT_DIR des Haupt-Checkouts, den `commondir` benennt."""
    commondir_file = git_dir / "commondir"
    try:
        rel = commondir_file.read_text(encoding="utf-8").strip()
    except OSError:
        return git_dir
    common = Path(rel)
    if not common.is_absolute():
        common = (git_dir / common).resolve()
    return common if common.is_dir() else git_dir


def repo_root_for(cwd: str) -> Path:
    """Naechster Vorfahre von `cwd` (cwd eingeschlossen), der ein `.git` traegt --
    entspricht `git rev-parse --show-toplevel`, ohne den Prozessstart. Findet sich
    keiner, gilt `cwd` selbst als Wurzel (derselbe Ausfall wie zuvor bei fehlgeschlagenem
    `git`-Aufruf: fail-open, kein Projekt erkennbar statt eines falschen)."""
    start = Path(cwd)
    if not start.is_absolute():
        try:
            start = start.resolve()
        except OSError:
            return start
    cur = start
    while True:
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            return start
        cur = cur.parent


def _remote_origin_url(repo_root: Path) -> str | None:
    git_dir = _git_dir_for(repo_root)
    if git_dir is None:
        return None
    config_path = _common_git_dir(git_dir) / "config"
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError:
        return None
    in_origin = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("["):
            in_origin = line.lower().replace(" ", "") == '[remote"origin"]'
            continue
        if in_origin and line.startswith("url"):
            _, _, value = line.partition("=")
            return value.strip()
    return None


def _load_projekte_tsv(vault: Path) -> dict[str, str]:
    path = vault / "_meta" / "projekte.tsv"
    mapping: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 2:
                mapping[parts[0].strip().lower()] = parts[1].strip()
    except OSError:
        pass
    return mapping


def project_for_cwd(cwd: str, vault: "os.PathLike | str") -> str | None:
    vault = Path(vault)
    root = repo_root_for(cwd)
    remote = _remote_origin_url(root)
    if remote:
        key = re.sub(r"^git@[^:]*:", "", remote)
        key = re.sub(r"^[a-z]+://[^/]*/", "", key)
        key = re.sub(r"\.git$", "", key).lower()
        mapping = _load_projekte_tsv(vault)
        if key in mapping:
            return mapping[key]
    name_lower = root.name.lower()
    proj_dir = vault / "20-projects"
    try:
        for d in proj_dir.iterdir():
            if d.is_dir() and d.name.lower() == name_lower:
                return d.name
    except OSError:
        pass
    return None


# ===========================================================================
# Auslöser gegen einen Werkzeugaufruf pruefen
# ===========================================================================

_TOKEN_RE = re.compile(r"'[^']*'|\"[^\"]*\"|\S+")


def _command_tokens(command: str) -> list[str]:
    return [t.strip("'\"") for t in _TOKEN_RE.findall(command)]


def _relpath(file_path: str, repo_root: Path) -> str:
    try:
        p = Path(file_path)
        if not p.is_absolute():
            return file_path
        return str(p.relative_to(repo_root))
    except ValueError:
        return file_path


def _pfad_glob_matches(glob_pat: str, candidate: str) -> bool:
    candidate = candidate.replace(os.sep, "/")
    if fnmatch.fnmatch(candidate, glob_pat):
        return True
    # Auch als Suffix pruefen, falls der Kandidat einen laengeren Pfad traegt
    # (z.B. Symlink-aufgeloester absoluter Pfad ausserhalb des Repos).
    return fnmatch.fnmatch(candidate.rsplit("/", 1)[-1], glob_pat.rsplit("/", 1)[-1]) and "/" not in glob_pat


def _befehlscode(command: str) -> str:
    """`ohne_text: true`: nur Shell-Code pruefen, nicht Text in Quotes, Kommentaren und
    Heredocs (tripwire_shell.befehlscode). Fehlt das Modul oder scheitert der Scan, gilt der
    volle Befehl -- lieber eine Warnung zu viel als eine verschluckte."""
    try:
        import tripwire_shell
        return tripwire_shell.befehlscode(command)
    except Exception:
        return command


def _trigger_matches(trigger: dict, tool_name: str, tool_input: dict, repo_root: Path) -> bool:
    keys_present = [k for k in ("pfad", "befehl", "diff") if trigger.get(k)]
    if not keys_present:
        return False
    for key in keys_present:
        pattern = trigger[key]
        if key == "befehl":
            if tool_name != "Bash":
                return False
            command = tool_input.get("command") or ""
            if trigger.get("ohne_text") is True:
                command = _befehlscode(command)
            if not re.search(pattern, command, re.IGNORECASE):
                return False
        elif key == "pfad":
            if tool_name in ("Edit", "Write", "NotebookEdit"):
                file_path = tool_input.get("file_path") or ""
                if not file_path:
                    return False
                rel = _relpath(file_path, repo_root)
                if not _pfad_glob_matches(pattern, rel):
                    return False
            elif tool_name == "Bash":
                command = tool_input.get("command") or ""
                if not any(_pfad_glob_matches(pattern, tok) for tok in _command_tokens(command)):
                    return False
            else:
                return False
        elif key == "diff":
            if tool_name == "Edit":
                text = tool_input.get("new_string") or ""
            elif tool_name == "Write":
                text = tool_input.get("content") or ""
            else:
                return False
            if not re.search(pattern, text, re.IGNORECASE):
                return False
    return True


def _anchor_missing(anker: str | None, repo_root: Path) -> bool:
    """True, wenn ein angegebener Anker NICHT (mehr) existiert."""
    if not anker:
        return False
    if ":" in anker:
        file_part, _, symbol = anker.partition(":")
    else:
        file_part, symbol = anker, ""
    p = repo_root / file_part
    if not p.is_file():
        return True
    if symbol:
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return True
        if symbol not in text:
            return True
    return False


# ===========================================================================
# Sitzungszustand (je Falle hoechstens einmal je Sitzung)
# ===========================================================================


def _state_path(state_dir: Path, session_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id) or "default"
    return state_dir / (safe + ".json")


def _load_shown(state_dir: Path, session_id: str) -> set[str]:
    try:
        raw = _state_path(state_dir, session_id).read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, list):
            return set(str(x) for x in data)
    except Exception:
        pass
    return set()


def _save_shown(state_dir: Path, session_id: str, shown: set[str]) -> None:
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        path = _state_path(state_dir, session_id)
        tmp = path.with_suffix(path.suffix + ".tmp.%d" % os.getpid())
        tmp.write_text(json.dumps(sorted(shown)), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


# ===========================================================================
# Der Haupteinstieg fuer Hook UND Replay-Adapter
# ===========================================================================


def tripwire_for(
    tool_name: str,
    tool_input: dict,
    cwd: str,
    vault: "os.PathLike | str",
    *,
    session_id: str | None = None,
    state_dir: "os.PathLike | str | None" = None,
    max_hits: int = 3,
    fallen_path: "os.PathLike | str | None" = None,
) -> list[dict]:
    """Liefert bis zu `max_hits` gefeuerte Fallenbuch-Eintraege fuer diesen
    Werkzeugaufruf, als Liste von {id, falle, gegenmittel, quelle, schaden, veraltet}.

    `fallen_path` ueberschreibt die Projekterkennung (fuer Tests/Replay auf einem
    bekannten Projekt ohne echtes Git-Repo). `session_id`/`state_dir` zusammen
    schalten das Einmal-je-Sitzung-Gedaechtnis ein; fehlt eines von beiden, wird
    nicht dedupliziert (z.B. fuer eine reine Bewertung ohne Sitzungsbindung).
    """
    tool_input = tool_input or {}
    vault_path = Path(vault)

    entries: list[dict] = []
    if fallen_path is not None:
        entries = load_fallen(Path(fallen_path))
    else:
        project = project_for_cwd(cwd, vault_path)
        if project:
            entries = load_fallen(vault_path / "20-projects" / project / "FALLEN.yaml")
    entries = entries + globale_fallen(vault_path, {str(e.get("id") or "") for e in entries})
    if not entries:
        return []

    repo_root = repo_root_for(cwd)

    dedup = session_id is not None and state_dir is not None
    shown: set[str] = set()
    if dedup:
        shown = _load_shown(Path(state_dir), session_id)

    hits: list[dict] = []
    newly_shown: set[str] = set()
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        if not entry_id:
            continue
        if dedup and entry_id in shown:
            continue
        triggers = entry.get("ausloeser") or []
        if not any(
            isinstance(t, dict) and _trigger_matches(t, tool_name, tool_input, repo_root)
            for t in triggers
        ):
            continue
        hits.append(
            {
                "id": entry_id,
                "falle": entry.get("falle") or "",
                "gegenmittel": entry.get("gegenmittel") or "",
                "quelle": entry.get("quelle") or "",
                "schaden": entry.get("schaden"),
                "veraltet": _anchor_missing(entry.get("anker"), repo_root),
                "global": bool(entry.get("_global")),
            }
        )
        newly_shown.add(entry_id)
        if len(hits) >= max_hits:
            break

    if dedup and newly_shown:
        _save_shown(Path(state_dir), session_id, shown | newly_shown)

    return hits


def format_hits(hits: list[dict], projekt: str | None = None) -> str:
    if not hits:
        return ""
    kopf = "Fallenbuch-Tripwire%s, %d Treffer:" % (
        (" (%s)" % projekt) if projekt else "",
        len(hits),
    )
    zeilen = [kopf]
    for h in hits:
        marker = "VERALTET? " if h.get("veraltet") else ""
        gegenmittel = (h["gegenmittel"] or "").rstrip(".")
        zeile = "- [%s] %s%s Gegenmittel: %s. Quelle: %s" % (
            h["id"],
            marker,
            h["falle"],
            gegenmittel,
            h["quelle"],
        )
        zeilen.append(zeile)
    return "\n".join(zeilen)
