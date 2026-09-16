#!/usr/bin/env python3
"""Das Brain (Vault ``~/Knowledge``) fuer Agenten: eigener Bereich, Notiz ueber den Dienstweg, Suche.

Entscheidung vom 16.09.2026 (docs/AGENTS-PLAN.md, Abschnitt 16): Das Gedaechtnis eines Agenten bleibt kurz,
alles Weitere liegt im Brain, und Agenten lesen das Brain mit.

- Bereich je Agent: ``20-projects/<projekt>/agenten/<agent-id>/`` (globale Welt:
  ``10-global/agenten/<agent-id>/``). Darin ``lehren.md`` (Archiv des Gedaechtnisses, datierte Lehren
  chronologisch) und Themen-Notizen nach Bedarf, im Brain-Format (Frontmatter mit ``id``, ``schema: 4``,
  ``type: note``, Tags mit Welt und Agent).
- Geschrieben wird nie aus der Sandbox: der Traeger schreibt (``notiz``), prueft die Grenze (nur der eigene
  Ordner; der Hauptagent zusaetzlich ``20-projects/<projekt>/``), committet im Vault mit der git-Identitaet
  des Menschen und gleicht nach den Regeln aus CRITICAL-FACTS ab: ``git pull --rebase``, bei Merge-Commits in
  der eigenen Historie ``git fetch`` und ``git merge --ff-only``, dann ``git push``, nie force. Scheitert der
  Abgleich, bleibt der Commit lokal und ``sync`` nennt den Grund.
- Gelesen wird im Zug ueber ``brain search`` (Huelle ``huelle``: nur ``search``, optional ``--pfad`` fuer den
  eigenen Bereich) oder ueber den Dienstweg ``suche``. Die Stichwortsuche hier braucht nur die
  Standardbibliothek und ist der Rueckfall, wenn das Werkzeug des Vaults nicht laeuft.

``90-secrets/`` und ``.secrets-sync/`` sind fuer jede Operation gesperrt; die Suche uebergeht sie.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import fcntl
import json
import math
import os
import re
import secrets as _secrets
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402

GEHEIM = ("90-secrets", ".secrets-sync")
AGENTEN_ORDNER = "agenten"
LEHREN = "lehren"
GLOBAL_ZWEIG = "10-global"
PROJEKT_ZWEIG = "20-projects"
BEREICHE_SUCHE = ("eigen", "welt", "alles")
BEREICHE_NOTIZ = ("eigen", "projekt")
TITEL_LIMIT = 200
TEXT_LIMIT = 32 * 1024
NOTIZ_LIMIT = 512 * 1024
FRAGE_LIMIT = 500
K_LIMIT = 20
AUSZUG_LIMIT = 300
DATEI_LESE_LIMIT = 256 * 1024
NAME_LIMIT = 80
GIT_FRIST_S = 20.0
NETZ_FRIST_S = 45.0
WERKZEUG_FRIST_S = 30.0
SPERRDATEI = "wb-brain.lock"
WERKZEUG_REL = "_meta/tools/braincli/.venv/bin/brain"
PYVENV_REL = "_meta/tools/braincli/.venv/pyvenv.cfg"
# Die Stichwortsuche uebergeht, was das Werkzeug des Vaults ebenfalls nicht durchsucht.
SUCHE_OHNE_ORDNER = {"_meta", ".obsidian", ".git", "node_modules", "__pycache__"} | set(GEHEIM)
# Offensichtliche Zugangsdaten landen nie in einer Notiz; das Vault wird gepusht.
GEHEIMNIS_MUSTER = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}"), re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"), re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), re.compile(r"\bsk-[A-Za-z0-9]{32,}"),
)
ZUG_MARKE = "<!-- wb-zug: %s -->"
TOKEN_RE = re.compile(r"[\w']+", re.UNICODE)
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "ae", "Ö": "oe", "Ü": "ue"})


class BrainFehler(ad.AgentsError):
    """Abgewiesene Brain-Operation; der Grund steht im Text."""


# ---------------------------------------------------------------------------
# Orte
# ---------------------------------------------------------------------------

def vault_pfad(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Das Vault: ausdruecklich, sonst ``WB_BRAIN_VAULT``, sonst ``~/Knowledge``; nie ein Symlink."""
    raw = explicit or os.environ.get("WB_BRAIN_VAULT") or str(Path.home() / "Knowledge")
    path = Path(os.path.abspath(os.path.expanduser(str(raw))))
    if path.is_symlink() or not path.is_dir():
        raise BrainFehler("Brain-Vault fehlt oder ist ein Symlink: %s" % path)
    return path


def _unter(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def slug(text: str) -> str:
    """Dateiname aus Titel oder Thema: Kleinbuchstaben, Ziffern und '-', hoechstens 80 Zeichen."""
    value = unicodedata.normalize("NFKD", str(text).translate(_UMLAUTE))
    value = "".join(ch for ch in value if not unicodedata.combining(ch)).lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")[:NAME_LIMIT].strip("-")
    if not value:
        raise BrainFehler("Titel oder Thema ergibt keinen Dateinamen (Buchstaben oder Ziffern noetig)")
    return value


def projekt(root: Path, vault: Optional[Path] = None) -> Optional[str]:
    """Ordnername des Projekts unter ``20-projects/``; ``None`` fuer die globale Welt.

    Ohne Projektordner nach Plan-Layout traegt der Weltname. Gibt es im Vault schon einen Projektordner, der
    sich nur in der Schreibweise unterscheidet, gilt dessen Name."""
    import agents_skills as ask  # spaet: die Huelle im Zug braucht das Modul nicht

    world = ad.read_world(root)
    if world.get("kind") == "global":
        return None
    folder = ask.world_project(root)
    name = slug(folder.name if folder is not None else (world.get("name") or world["id"]))
    base = vault / PROJEKT_ZWEIG if vault is not None else None
    if base is not None and base.is_dir():
        for item in sorted(base.iterdir()):
            if not item.is_dir() or item.is_symlink():
                continue
            try:
                if item.name.casefold() == name or slug(item.name) == name:
                    return item.name
            except BrainFehler:
                continue
    return name


def bereich(root: Path, agent_id: str, art: str = "eigen", vault: Optional[Path] = None) -> str:
    """Relativer Vaultpfad: ``eigen`` (Agentenordner), ``welt``/``projekt`` (Projekt- oder globaler Zweig)."""
    ad.valid_id(agent_id, "Agentenkennung")
    name = projekt(root, vault)
    basis = GLOBAL_ZWEIG if name is None else "%s/%s" % (PROJEKT_ZWEIG, name)
    if art in ("welt", "projekt"):
        return basis
    if art != "eigen":
        raise BrainFehler("Bereich muss eigen, welt oder projekt sein")
    return "%s/%s/%s" % (basis, AGENTEN_ORDNER, agent_id)


def _geheim(rel: str) -> bool:
    return bool(set(Path(rel).parts) & set(GEHEIM))


def einbindung(vault: str | os.PathLike[str] | None) -> Optional[dict[str, Any]]:
    """Was ein Zug vom Brain sieht: Vault nur lesbar, Geheimordner als leeres tmpfs, Python des Werkzeugs.

    ``None`` ohne Vault. ``lese_pfade`` sind die nur lesbaren Einbindungen (Vault und, falls ausserhalb von
    ``/usr``, die Python-Installation, auf die die venv des Werkzeugs zeigt); ``verdeckt`` die Ordner, ueber
    die der Launcher ein leeres tmpfs legt; ``werkzeug`` das Skript ``brain`` der venv oder ``None``."""
    if not vault:
        return None
    try:
        path = vault_pfad(vault)
    except BrainFehler:
        return None
    lese = [path]
    werkzeug = path / WERKZEUG_REL
    cfg = path / PYVENV_REL
    if cfg.is_file() and werkzeug.is_file():
        for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "home" and value.strip():
                home = Path(value.strip())
                python_root = home.parent if home.name == "bin" else home
                kandidaten = [python_root]
                if Path(os.path.realpath(python_root)) != python_root:
                    # uv legt venvs seit 0.12 auf den Versionslink an (cpython-3.13-… -> cpython-3.13.14-…); im Zug
                    # muss der Link selbst sichtbar sein, also sein Ordner, und das Ziel. Gemessen auf peer, 16.09.2026.
                    kandidaten.insert(0, python_root.parent)
                for kandidat in kandidaten:
                    real = Path(os.path.realpath(kandidat))
                    if real.is_absolute() and real.is_dir() and not _unter(real, Path("/usr")) \
                            and not _unter(real, Path(os.path.realpath(path))) \
                            and real not in (Path("/"), Path(os.path.realpath(Path.home()))) and real not in lese:
                        lese.append(real)
    return {"vault": path, "lese_pfade": tuple(lese), "verdeckt": tuple(path / name for name in GEHEIM),
            "werkzeug": werkzeug if werkzeug.is_file() else None}


# ---------------------------------------------------------------------------
# Notiz
# ---------------------------------------------------------------------------

def ulid(now_ms: Optional[int] = None) -> str:
    """ULID wie ``gardener.identity.ulid`` (48 Bit Millisekunden, 80 Bit Zufall, Crockford-Base32)."""
    ts = int(time.time() * 1000) if now_ms is None else now_ms
    value = (ts << 80) | _secrets.randbits(80)
    return "".join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def _tags(world: dict[str, Any], agent_id: str) -> list[str]:
    return ["agenten", "welt-%s" % slug(world.get("name") or world["id"]), "agent-%s" % slug(agent_id)]


def frontmatter(rel: str, titel: str, tags: list[str], datum: str) -> str:
    """Frontmatter im Brain-Format (Brain 4: ``id``, ``schema``, ``permalink``, ``branch``, ``class``)."""
    parts = Path(rel).parts
    zweig = "/".join(parts[:2]) if parts[0] == PROJEKT_ZWEIG else parts[0]
    permalink = "main/%s/%s" % (Path(rel).parent.as_posix(), slug(Path(rel).stem))
    return "\n".join([
        "---", "id: %s" % ulid(), "schema: 4", "title: %s" % json.dumps(titel, ensure_ascii=False), "type: note",
        "permalink: %s" % permalink, "branch: %s" % zweig, "tags: [%s]" % ", ".join(tags),
        "created: %s" % datum, "class: knowledge", "stand: %s" % datum[:7], "---", ""])


def frontmatter_lesen(text: str) -> Optional[dict[str, str]]:
    """Schluessel und Rohwerte des Frontmatters; ``None`` ohne gueltigen Block."""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 3)
    if end == -1:
        return None
    result = {}
    for line in text[4:end].splitlines():
        key, sep, value = line.partition(":")
        if not sep or not re.fullmatch(r"[a-z][a-z0-9_-]*", key):
            return None
        result[key] = value.strip()
    return result


def _stand_setzen(text: str, datum: str) -> str:
    fm = frontmatter_lesen(text)
    if fm is None or "stand" not in fm:
        return text
    end = text.find("\n---\n", 3)
    head = re.sub(r"(?m)^stand:.*$", "stand: %s" % datum[:7], text[:end], count=1)
    return head + text[end:]


def _text_pruefen(text: Any, label: str = "Text") -> str:
    if not isinstance(text, str) or not text.strip():
        raise BrainFehler("%s fehlt" % label)
    text = text.replace("\r\n", "\n").strip("\n")
    if len(text.encode("utf-8")) > TEXT_LIMIT:
        raise BrainFehler("%s ist groesser als %d Bytes" % (label, TEXT_LIMIT))
    if "\x00" in text:
        raise BrainFehler("%s enthaelt ein Nullzeichen" % label)
    for muster in GEHEIMNIS_MUSTER:
        if muster.search(text):
            raise BrainFehler("%s sieht nach einem Zugangsschluessel aus; Geheimnisse gehoeren nie ins Brain, "
                              "hoechstens ein Hinweis, wo sie liegen" % label)
    return text


def _ordner(vault: Path, rel_dir: str) -> Path:
    """Legt den Zielordner an; jede Komponente unter dem Vault ist ein echter Ordner, kein Symlink."""
    real_vault = Path(os.path.realpath(vault))
    current = vault
    for part in Path(rel_dir).parts:
        if part in ("", ".", "..") or part in GEHEIM or part.startswith("."):
            raise BrainFehler("Zielordner ist ungueltig: %s" % rel_dir)
        current = current / part
        if current.is_symlink():
            raise BrainFehler("Zielordner enthaelt einen Symlink: %s" % current.relative_to(vault))
        if not current.exists():
            current.mkdir(mode=0o755)
        if not current.is_dir():
            raise BrainFehler("Zielordner ist kein Ordner: %s" % current.relative_to(vault))
    if not _unter(Path(os.path.realpath(current)), real_vault):
        raise BrainFehler("Zielordner liegt ausserhalb des Vaults")
    return current


def ziel(vault: Path, rel_dir: str, name: str, erlaubt: str) -> Path:
    """Zieldatei einer Notiz: ``name`` ist ein Slug, der Pfad liegt kanonisch unter ``erlaubt``."""
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?", name):
        raise BrainFehler("Dateiname der Notiz ist ungueltig")
    rel = Path(rel_dir)
    if not _unter(rel, Path(erlaubt)) or ".." in rel.parts or _geheim(rel_dir):
        raise BrainFehler("Notizen schreibt ein Agent nur in seinen eigenen Bereich (%s)" % erlaubt)
    folder = _ordner(vault, rel_dir)
    target = folder / (name + ".md")
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise BrainFehler("Zieldatei ist ein Symlink oder keine Datei")
    real_allowed = Path(os.path.realpath(vault / erlaubt))
    if not _unter(Path(os.path.realpath(target.parent)), real_allowed):
        raise BrainFehler("Notizen schreibt ein Agent nur in seinen eigenen Bereich (%s)" % erlaubt)
    return target


@contextlib.contextmanager
def _sperre(vault: Path, frist_s: float = 30.0) -> Iterator[None]:
    """Ein Schreiber je Vault (Traeger mehrerer Welten); die Sperrdatei liegt unter ``.git``, nie im Baum."""
    git_dir = vault / ".git"
    folder = git_dir if git_dir.is_dir() and not git_dir.is_symlink() else None
    if folder is None:
        raise BrainFehler("Brain-Vault ist kein git-Repository")
    with (folder / SPERRDATEI).open("a+") as lock:
        deadline = time.monotonic() + frist_s
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise BrainFehler("Brain-Vault ist belegt (anderer Schreiber)")
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


Runner = Callable[..., Any]


class _Ergebnis:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def git(vault: Path, *args: str, frist: float = GIT_FRIST_S, runner: Runner = subprocess.run) -> _Ergebnis:
    """git im Vault, mit Frist, ohne Rueckfrage und ohne GIT_*-Umlenkung aus der Umgebung des Traegers."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", LC_ALL="C", LANG="C")
    try:
        result = runner(["git", "-C", str(vault), *args], capture_output=True, text=True, timeout=frist, env=env)
    except subprocess.TimeoutExpired:
        return _Ergebnis(124, "", "Frist von %d s ueberschritten" % frist)
    except OSError as exc:
        return _Ergebnis(127, "", str(exc))
    return _Ergebnis(result.returncode, result.stdout or "", result.stderr or "")


def _kurz(result: _Ergebnis) -> str:
    text = " ".join((result.stderr or result.stdout or "").split())
    return text[-300:] or "Exitcode %d" % result.returncode


def identitaet(vault: Path, runner: Runner = subprocess.run) -> dict[str, str]:
    """Name und Adresse aus der git-Konfiguration des Vaults: die Identitaet des Menschen dieses Hosts."""
    name = git(vault, "config", "--get", "user.name", runner=runner).stdout.strip()
    email = git(vault, "config", "--get", "user.email", runner=runner).stdout.strip()
    if not name or not email:
        raise BrainFehler("git-Identitaet (user.name, user.email) fehlt im Vault; ohne sie wird nichts geschrieben")
    return {"name": name, "email": email}


def commit(vault: Path, rels: list[str], nachricht: str, runner: Runner = subprocess.run) -> Optional[str]:
    """Committet genau diese Pfade (fremde vorgemerkte Aenderungen bleiben unberuehrt); ``None`` ohne Aenderung."""
    added = git(vault, "add", "--", *rels, runner=runner)
    if added.returncode != 0:
        raise BrainFehler("git add scheitert: %s" % _kurz(added))
    if not git(vault, "diff", "--cached", "--quiet", "--", *rels, runner=runner).returncode:
        return None
    done = git(vault, "commit", "-q", "-m", nachricht, "--", *rels, runner=runner)
    if done.returncode != 0:
        raise BrainFehler("git commit scheitert: %s" % _kurz(done))
    return git(vault, "rev-parse", "HEAD", runner=runner).stdout.strip() or None


def abgleich(vault: Path, runner: Runner = subprocess.run) -> dict[str, Any]:
    """Holen und pushen nach CRITICAL-FACTS; nie force. ``status``: gepusht, aktuell oder lokal (mit Grund)."""
    upstream = git(vault, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", runner=runner)
    if upstream.returncode != 0:
        return {"status": "lokal", "grund": "kein Upstream eingerichtet; der Commit bleibt lokal"}
    fetched = git(vault, "fetch", "--quiet", frist=NETZ_FRIST_S, runner=runner)
    if fetched.returncode != 0:
        return {"status": "lokal", "grund": "git fetch scheitert: %s" % _kurz(fetched)}
    merges = git(vault, "rev-list", "--merges", "@{u}..HEAD", runner=runner)
    if merges.stdout.strip():
        weg = "git fetch && git merge --ff-only"
        merged = git(vault, "merge", "--ff-only", "-q", "@{u}", runner=runner)
        if merged.returncode != 0:
            return {"status": "lokal", "weg": weg,
                    "grund": "eigene Historie mit Merge-Commits weicht vom Upstream ab; bewusst zu entscheiden: %s"
                             % _kurz(merged)}
    else:
        weg = "git pull --rebase"
        pulled = git(vault, "pull", "--rebase", "--quiet", frist=NETZ_FRIST_S, runner=runner)
        if pulled.returncode != 0:
            if (vault / ".git" / "rebase-merge").exists() or (vault / ".git" / "rebase-apply").exists():
                git(vault, "rebase", "--abort", runner=runner)
            return {"status": "lokal", "weg": weg, "grund": "git pull --rebase scheitert: %s" % _kurz(pulled)}
    ahead = git(vault, "rev-list", "--count", "@{u}..HEAD", runner=runner).stdout.strip()
    if ahead == "0":
        return {"status": "aktuell", "weg": weg}
    pushed = git(vault, "push", "--quiet", frist=NETZ_FRIST_S, runner=runner)
    if pushed.returncode != 0:
        return {"status": "lokal", "weg": weg, "grund": "git push scheitert: %s" % _kurz(pushed)}
    return {"status": "gepusht", "weg": weg}


def _anhaengen(before: str, abschnitt: str, datum: str) -> str:
    text = before if before.endswith("\n") else before + "\n"
    return _stand_setzen(text + "\n" + abschnitt, datum)


def schreiben(vault: Path, rel: str, inhalt_neu: Callable[[], str], abschnitt: str, marke: Optional[str], *,
              datum: str, anhaengen: bool, nachricht: str, runner: Runner = subprocess.run) -> dict[str, Any]:
    """Schreibt oder ergaenzt eine Notiz unter der Vaultsperre, committet und gleicht ab.

    ``marke`` macht das Anhaengen je Zug idempotent: steht sie schon in der Datei, bleibt die Datei, und nur
    ein offener Abgleich wird nachgeholt."""
    import atomar_schreiben

    target = vault / rel
    with _sperre(vault):
        existed = target.is_file()
        before = target.read_text(encoding="utf-8") if existed else ""
        if existed and marke and marke in before:
            status = "vorhanden"
            after = before
        elif existed and not anhaengen:
            raise BrainFehler("Notiz %s existiert; anhaengen=true haengt an, sonst ein anderes Thema waehlen" % rel)
        else:
            after = _anhaengen(before, abschnitt, datum) if existed else inhalt_neu()
            if len(after.encode("utf-8")) > NOTIZ_LIMIT:
                raise BrainFehler("Notiz waere groesser als %d Bytes; ein neues Thema beginnen" % NOTIZ_LIMIT)
            atomar_schreiben.schreiben(str(target), after, modus=0o644, dauerhaft=True)
            status = "angehaengt" if existed else "angelegt"
        sha = commit(vault, [rel], nachricht, runner=runner)
        ahead = git(vault, "rev-list", "--count", "@{u}..HEAD", runner=runner)
        sync = abgleich(vault, runner=runner) if sha or (ahead.returncode == 0 and ahead.stdout.strip() not in ("", "0")) \
            else {"status": "aktuell"}
        if sha and sync.get("status") != "lokal":
            sha = git(vault, "log", "-1", "--format=%H", "--", rel, runner=runner).stdout.strip() or sha
    return {"rel": rel, "pfad": str(target), "status": status, "commit": sha, "sync": sync}


def notiz(vault: str | os.PathLike[str] | None, root: Path, agent_id: str, titel: Any, text: Any, *,
          thema: Any = None, anhaengen: bool = False, bereich_art: str = "eigen", zug: Optional[str] = None,
          datum: Optional[str] = None, runner: Runner = subprocess.run) -> dict[str, Any]:
    """Operation ``brain.notiz``: eine Notiz im eigenen Bereich (Hauptagent: auch im Projekt).

    Dateiname ist das Thema, sonst der Titel. Ohne Thema traegt die Notiz den Titel; mit Thema ist die Notiz
    das Thema, und jeder Eintrag steht als datierter Abschnitt mit seinem Titel darin."""
    root = ad.world_path(str(root))
    vault_path = vault_pfad(vault)
    agent = ad.read_agent(root, agent_id)
    world = ad.read_world(root)
    if bereich_art not in BEREICHE_NOTIZ:
        raise BrainFehler("bereich muss eigen oder projekt sein")
    if bereich_art == "projekt":
        if agent.get("stage") != "hauptagent":
            raise BrainFehler("In den Projektbereich des Brains schreibt nur der Hauptagent; dein Bereich ist eigen")
        if projekt(root, vault_path) is None:
            raise BrainFehler("Die globale Welt hat keinen Projektbereich im Brain; nur den eigenen Bereich")
    if not isinstance(titel, str) or not " ".join(titel.split()):
        raise BrainFehler("titel fehlt")
    titel = " ".join(titel.split())
    if len(titel) > TITEL_LIMIT:
        raise BrainFehler("titel ist laenger als %d Zeichen" % TITEL_LIMIT)
    _text_pruefen(titel, "titel")
    text = _text_pruefen(text)
    if thema is not None and (not isinstance(thema, str) or not thema.strip()):
        raise BrainFehler("thema muss Text sein")
    thema = " ".join(thema.split()) if thema else None
    if not isinstance(anhaengen, bool):
        raise BrainFehler("anhaengen muss true oder false sein")
    name = slug(thema or titel)
    if name == LEHREN:
        raise BrainFehler("lehren.md fuehrt der Traeger (Lernschritt archiv); fuer Notizen ein anderes Thema")
    datum = datum or _dt.date.today().isoformat()
    eigen = bereich(root, agent_id, "eigen", vault_path)
    rel_dir = eigen if bereich_art == "eigen" else bereich(root, agent_id, "projekt", vault_path)
    erlaubt = rel_dir
    identitaet(vault_path, runner)
    target = ziel(vault_path, rel_dir, name, erlaubt)
    rel = target.relative_to(vault_path).as_posix()
    marke = ZUG_MARKE % zug if zug else None
    kopf = "## %s: %s" % (datum, titel) if thema else "## %s" % datum
    abschnitt = "\n".join(filter(None, [kopf, marke, "", text, ""]))

    def neu() -> str:
        body = ["Für künftige Sessions: Notiz von Agent `%s` (%s) der Welt „%s“; gezielt mit `brain search` holen, "
                "nicht auf Vorrat laden." % (agent_id, agent.get("stage"), world.get("name")), ""]
        if thema:
            body += ["# %s" % thema, "", abschnitt]
        else:
            body += ["# %s" % titel, ""] + ([marke, ""] if marke else []) + [text, ""]
        return frontmatter(rel, thema or titel, _tags(world, agent_id), datum) + "\n" + "\n".join(body)

    nachricht = "agents: note %s from %s/%s" % (rel, world.get("name") or world["id"], agent_id)
    result = schreiben(vault_path, rel, neu, abschnitt, marke, datum=datum, anhaengen=anhaengen,
                       nachricht=nachricht, runner=runner)
    return dict(result, bereich=rel_dir)


def lehren_anhaengen(vault: str | os.PathLike[str] | None, root: Path, agent_id: str, zeilen: list[str], *,
                     zug: str, datum: Optional[str] = None, runner: Runner = subprocess.run) -> dict[str, Any]:
    """Haengt Zeilen aus ``MEMORY.md`` an ``lehren.md`` im eigenen Bereich (Archiv, chronologisch)."""
    root = ad.world_path(str(root))
    vault_path = vault_pfad(vault)
    world = ad.read_world(root)
    if not zeilen:
        raise BrainFehler("keine Zeilen zum Archivieren")
    text = _text_pruefen("\n".join(zeilen), "Archivzeilen")
    datum = datum or _dt.date.today().isoformat()
    rel_dir = bereich(root, agent_id, "eigen", vault_path)
    identitaet(vault_path, runner)
    target = ziel(vault_path, rel_dir, LEHREN, rel_dir)
    rel = target.relative_to(vault_path).as_posix()
    marke = ZUG_MARKE % zug
    abschnitt = "\n".join(["## Archiviert %s" % datum, marke, "", text, ""])

    def neu() -> str:
        titel = "Lehren von %s (%s)" % (agent_id, world.get("name") or world["id"])
        return frontmatter(rel, titel, _tags(world, agent_id), datum) + "\n" + "\n".join([
            "Für künftige Sessions: Archiv des Gedächtnisses von Agent `%s` der Welt „%s“: datierte Lehren, "
            "chronologisch. Gilt nicht jeden Zug; vor der Arbeit gezielt mit `brain search` holen." % (
                agent_id, world.get("name")), "", "# %s" % titel, "", abschnitt])

    nachricht = "agents: archive memory of %s/%s into %s" % (world.get("name") or world["id"], agent_id, rel)
    return schreiben(vault_path, rel, neu, abschnitt, marke, datum=datum, anhaengen=True, nachricht=nachricht,
                     runner=runner)


# ---------------------------------------------------------------------------
# Suche
# ---------------------------------------------------------------------------

def _tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def _notizdateien(vault: Path, praefix: Optional[str]) -> Iterator[Path]:
    base = vault / praefix if praefix else vault
    if base.is_symlink() or not base.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SUCHE_OHNE_ORDNER
                             and not (here / d).is_symlink())
        for name in sorted(filenames):
            path = here / name
            if name.endswith(".md") and not path.is_symlink() and path.is_file():
                yield path


def _titel_und_auszug(text: str, stem: str) -> tuple[str, str, str]:
    fm = frontmatter_lesen(text)
    body = text
    title = ""
    if fm is not None:
        body = text[text.find("\n---\n", 3) + 5:]
        raw = fm.get("title") or ""
        try:
            title = json.loads(raw) if raw.startswith('"') else raw.strip("'")
        except ValueError:
            title = raw
    auszug = ""
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("# ") and not title:
            title = line[2:].strip()
            continue
        if line.startswith(("#", "<!--", "---")):
            continue
        auszug = line[:AUSZUG_LIMIT]
        break
    return (title or stem), auszug, body


def stichwortsuche(vault: Path, frage: str, k: int = 5, praefix: Optional[str] = None) -> list[dict[str, Any]]:
    """BM25 ueber die Notizen (Standardbibliothek), mit Titelbonus wie ``brain search``; ohne Geheimordner."""
    query = set(_tokens(frage))
    if not query:
        return []
    docs = []
    for path in _notizdateien(vault, praefix):
        try:
            with path.open("rb") as stream:
                text = stream.read(DATEI_LESE_LIMIT).decode("utf-8", "replace")
        except OSError:
            continue
        title, auszug, body = _titel_und_auszug(text, path.stem)
        tokens = _tokens(title + "\n" + body)
        docs.append((path.relative_to(vault).as_posix(), title, auszug, tokens))
    if not docs:
        return []
    avg = sum(len(d[3]) for d in docs) / len(docs) or 1.0
    frequency = {term: sum(1 for d in docs if term in set(d[3])) for term in query}
    scored = []
    for rel, title, auszug, tokens in docs:
        counts: dict[str, int] = {}
        for token in tokens:
            if token in query:
                counts[token] = counts.get(token, 0) + 1
        score = 0.0
        for term, tf in counts.items():
            n = frequency[term]
            idf = math.log((len(docs) - n + 0.5) / (n + 0.5) + 1.0)
            score += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75 * len(tokens) / avg))
        if score <= 0:
            continue
        score += 2.0 * len(query & set(_tokens(title)))
        scored.append((score, rel, title, auszug))
    scored.sort(key=lambda item: (-item[0], item[1]))
    top = scored[:k]
    best = top[0][0] if top else 1.0
    return [{"rel": rel, "titel": title, "score": round(score / best, 3), "auszug": auszug, "treffer": "text"}
            for score, rel, title, auszug in top]


def _werkzeugsuche(werkzeug: Path, vault: Path, frage: str, k: int, runner: Runner) -> tuple[list[dict], bool]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C.UTF-8",
           "HOME": os.environ.get("HOME") or "/tmp", "TMPDIR": os.environ.get("TMPDIR") or "/tmp"}
    result = runner([str(werkzeug), "--vault", str(vault), "search", frage, "-k", str(k), "--json"],
                    capture_output=True, text=True, timeout=WERKZEUG_FRIST_S, env=env)
    if result.returncode != 0:
        raise BrainFehler("brain search endet mit %d" % result.returncode)
    data = json.loads(result.stdout)
    hits = []
    for hit in data.get("hits") or []:
        rel = str(hit.get("rel") or "")
        if not rel or _geheim(rel):
            continue
        hits.append({"rel": rel, "titel": hit.get("title") or Path(rel).stem,
                     "score": round(float(hit.get("score") or 0.0), 3),
                     "auszug": " ".join(str(hit.get("snippet") or "").split())[:AUSZUG_LIMIT],
                     "treffer": hit.get("match") or "text"})
    return hits, bool(data.get("fallback"))


def suche(vault: str | os.PathLike[str] | None, root: Path, agent_id: str, frage: Any, k: Any = 5,
          bereich_art: str = "eigen", *, werkzeug: Optional[Path] = None,
          runner: Runner = subprocess.run) -> dict[str, Any]:
    """Operation ``brain.suche``: ``eigen`` (eigener Bereich), ``welt`` (Projekt oder 10-global), ``alles``."""
    root = ad.world_path(str(root))
    vault_path = vault_pfad(vault)
    ad.read_agent(root, agent_id)
    if not isinstance(frage, str) or not " ".join(frage.split()):
        raise BrainFehler("frage fehlt")
    frage = " ".join(frage.split())[:FRAGE_LIMIT]
    if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= K_LIMIT:
        raise BrainFehler("k muss eine Zahl von 1 bis %d sein" % K_LIMIT)
    if bereich_art not in BEREICHE_SUCHE:
        raise BrainFehler("bereich muss eigen, welt oder alles sein")
    praefix = None if bereich_art == "alles" else bereich(root, agent_id, bereich_art, vault_path)
    quelle, hinweis = "stichwort", None
    hits: list[dict[str, Any]] = []
    if praefix is None:
        tool = werkzeug if werkzeug is not None else vault_path / WERKZEUG_REL
        if tool.is_file():
            try:
                hits, rueckfall = _werkzeugsuche(tool, vault_path, frage, k, runner)
                quelle = "brain search" + (" (ohne Einbettungen)" if rueckfall else "")
            except (BrainFehler, OSError, ValueError, subprocess.SubprocessError) as exc:
                hinweis = "brain search nicht verfuegbar (%s); Stichwortsuche" % str(exc)[:120]
                quelle = "stichwort"
        else:
            hinweis = "Werkzeug brain fehlt im Vault; Stichwortsuche"
    if quelle == "stichwort":
        hits = stichwortsuche(vault_path, frage, k, praefix)
    result = {"frage": frage, "bereich": bereich_art, "pfad": praefix, "quelle": quelle,
              "treffer": [hit for hit in hits if not _geheim(hit["rel"])][:k]}
    if hinweis:
        result["hinweis"] = hinweis
    return result


# ---------------------------------------------------------------------------
# Huelle im Zug: brain search
# ---------------------------------------------------------------------------

def _pfad_praefix(vault: Path, raw: str) -> str:
    path = Path(raw)
    absolute = path if path.is_absolute() else vault / path
    real = Path(os.path.realpath(absolute))
    real_vault = Path(os.path.realpath(vault))
    if not _unter(real, real_vault):
        raise BrainFehler("--pfad liegt ausserhalb des Vaults: %s" % raw)
    rel = real.relative_to(real_vault).as_posix()
    if _geheim(rel):
        raise BrainFehler("--pfad nennt einen gesperrten Ordner")
    return "" if rel == "." else rel


def huelle(argv: list[str], *, runner: Runner = subprocess.run, out=None) -> int:
    """``brain`` im Zug: nur ``search``. Mit ``--pfad`` die Stichwortsuche in diesem Teilbaum, sonst das Werkzeug
    des Vaults (nur lesend) und bei Ausfall die Stichwortsuche ueber das ganze Vault."""
    out = out or sys.stdout
    if not argv or argv[0] != "search":
        print("brain: im Zug ist nur `brain search \"<frage>\" [-k N] [--pfad <ordner>] [--json]` erlaubt; "
              "schreiben geht ueber den Dienstweg brain.notiz", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(prog="brain search", add_help=True)
    parser.add_argument("query")
    parser.add_argument("-k", type=int, default=5)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--pfad")
    parser.add_argument("--no-validity", action="store_true")
    try:
        args = parser.parse_args(argv[1:])
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        vault = vault_pfad(os.environ.get("WB_BRAIN_VAULT") or None)
        k = max(1, min(int(args.k), K_LIMIT))
        frage = " ".join(args.query.split())[:FRAGE_LIMIT]
        hinweis, fallback = None, True
        if args.pfad is not None:
            praefix = _pfad_praefix(vault, args.pfad)
            hits = stichwortsuche(vault, frage, k, praefix or None)
            quelle = "stichwort in %s" % (praefix or ".")
        else:
            tool = vault / WERKZEUG_REL
            try:
                if not tool.is_file():
                    raise BrainFehler("Werkzeug fehlt")
                hits, fallback = _werkzeugsuche(tool, vault, frage, k, runner)
                quelle = "brain search"
            except (BrainFehler, OSError, ValueError, subprocess.SubprocessError) as exc:
                hinweis = "brain search nicht verfuegbar (%s); Stichwortsuche ueber das Vault" % str(exc)[:120]
                hits = stichwortsuche(vault, frage, k, None)
                quelle = "stichwort"
    except BrainFehler as exc:
        print("brain: %s" % exc, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"query": frage, "fallback": fallback, "quelle": quelle, "hinweis": hinweis,
                          "hits": [{"rel": h["rel"], "title": h["titel"], "score": h["score"],
                                    "snippet": h["auszug"], "match": h["treffer"]} for h in hits]},
                         ensure_ascii=False, indent=2), file=out)
        return 0
    if hinweis:
        print("[!] %s\n" % hinweis, file=out)
    if not hits:
        print("Keine Treffer.", file=out)
        return 0
    for hit in hits:
        print(hit["rel"], file=out)
        print("  Titel: %s  (score %.3f) [%s]" % (hit["titel"], hit["score"], hit["treffer"]), file=out)
        if hit["auszug"]:
            print("  %s" % hit["auszug"], file=out)
        print("", file=out)
    return 0


HUELLE = """#!/usr/bin/python3
# brain im Zug (agents_brain.huelle): nur `brain search`, Vault nur lesbar.
import os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
import agents_brain
raise SystemExit(agents_brain.huelle(sys.argv[1:]))
"""


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["search"]:
        return huelle(argv)
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("bereich")
    p.add_argument("world")
    p.add_argument("agent")
    p.add_argument("--vault")
    args = parser.parse_args(argv)
    try:
        root = ad.world_path(args.world)
        vault = vault_pfad(args.vault) if (args.vault or os.environ.get("WB_BRAIN_VAULT")
                                           or (Path.home() / "Knowledge").is_dir()) else None
        print(json.dumps({"eigen": bereich(root, args.agent, "eigen", vault),
                          "welt": bereich(root, args.agent, "welt", vault)}, ensure_ascii=False))
        return 0
    except ad.AgentsError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2


__all__ = ["BrainFehler", "GEHEIM", "abgleich", "bereich", "commit", "einbindung", "frontmatter", "frontmatter_lesen",
           "huelle", "identitaet", "lehren_anhaengen", "notiz", "projekt", "slug", "stichwortsuche", "suche",
           "vault_pfad", "ziel"]


if __name__ == "__main__":
    raise SystemExit(main())
