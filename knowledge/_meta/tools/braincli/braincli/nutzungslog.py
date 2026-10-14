"""Nutzungsprotokoll des Brains (Firmenniveau-Plan M3, b6-zugang, 2026-09-28).

Je Auslieferung eine JSON-Zeile: Zeit, Kanal (search | recall | sessionstart | dienst | mcp | chat), Rolle
(haupt | worker | gast | app, falls ermittelbar), geschwaerzte Anfrage, Top-Pfade mit Score,
Leer-Grund (frist | kalt | tor | filter | fehler | keine_treffer, sonst null) und Dauer in ms.

Entscheidung der Nutzer 28.09. (E3): Anfragetext nur geschwaerzt ueber den vorhandenen
`secrets_scan` des Gaertners, Protokoll lokal je Maschine, gitignoriert, nie synchronisiert.
Deshalb liegt es unter `_meta/tools/state/nutzung/` (gitignoriert, maschinenlokal), eine
Datei je UTC-Tag; `anhaengen` loescht Tagesdateien, die aelter als AUFBEWAHRUNG_TAGE sind.

Ohne Abhaengigkeit ausser der Standardbibliothek und (optional) `gardener.dream.secrets_scan`:
der Recall-Hook ruft das Modul mit dem System-python3 (3.9) auf. Fehlt der Scanner, wird kein
Anfragetext gespeichert (lieber leer als ungeschwaerzt). Schreibt nie eine Ausnahme nach aussen.

Schalter: BRAIN_NUTZUNGSLOG=0 schaltet ab; BRAIN_NUTZUNGSLOG_DIR lenkt das Verzeichnis um
(Tests, Dienst). BRAIN_NUTZUNG ist etwas anderes (Transkript-Monitor in doctor.py).
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

AUFBEWAHRUNG_TAGE = 30
ANFRAGE_MAX = 300          # Zeichen der geschwaerzten Anfrage, die gespeichert werden
TREFFER_MAX = 5
KANAELE = ("search", "recall", "sessionstart", "dienst", "mcp", "chat")
GRUENDE = ("frist", "kalt", "tor", "filter", "fehler", "keine_treffer")
GESCHWAERZT = "[geschwaerzt]"


def aktiv() -> bool:
    return os.environ.get("BRAIN_NUTZUNGSLOG", "1") != "0"


def verzeichnis(vault: Path | str | None = None, ordner: Path | str | None = None) -> Path:
    """BRAIN_NUTZUNGSLOG_DIR vor `ordner` (Dienst: data_dir/nutzung) vor dem Vault-Zustand."""
    eigen = os.environ.get("BRAIN_NUTZUNGSLOG_DIR", "").strip()
    if eigen:
        return Path(eigen).expanduser()
    if ordner:
        return Path(ordner)
    basis = Path(vault) if vault else Path.home() / "Knowledge"
    return basis / "_meta" / "tools" / "state" / "nutzung"


# --- Schwaerzen ---------------------------------------------------------------------------

def _scanner():
    """`gardener.dream.secrets_scan` oder None. Im braincli-venv ist `gardener` installiert;
    fuer das System-python des Hooks wird der Quellbaum daneben eingehaengt."""
    try:
        from gardener.dream import secrets_scan
        return secrets_scan
    except Exception:
        pass
    quelle = Path(__file__).resolve().parents[2] / "gardener"
    if quelle.is_dir() and str(quelle) not in sys.path:
        sys.path.insert(0, str(quelle))
        try:
            from gardener.dream import secrets_scan
            return secrets_scan
        except Exception:
            return None
    return None


def schwaerzen(text: str) -> str | None:
    """Anfrage mit denselben Mustern wie der Geheimnis-Scan des Gaertners schwaerzen.

    Jeder Lauf, den `secrets_scan` als geheimnisfoermig erkennt (bekannte Praefixe, Entropie,
    base64 mit Polster, Hex/Base32 hinter einem Zugangswort), wird ersetzt. Bleibt danach
    trotzdem ein Treffer (etwa ueber eigene Muster), wird die ganze Anfrage ersetzt.
    None, wenn kein Scanner verfuegbar ist: dann speichert das Protokoll keinen Text."""
    if not text:
        return ""
    s = _scanner()
    if s is None:
        return None
    try:
        cfg = s.dcfg
        out = text
        for run in set(s._RUN_RE.findall(out)):
            if run.startswith(cfg.SECRET_KNOWN_PREFIXES):
                out = out.replace(run, GESCHWAERZT)
        for run in set(s._ENTROPY_RUN_RE.findall(out)):
            if s._shannon_entropy(run) >= cfg.SECRET_ENTROPY_THRESHOLD:
                out = out.replace(run, GESCHWAERZT)
        for run in set(s._BASE64_PADDED_RUN_RE.findall(out)):
            if s._shannon_entropy(run.rstrip("=")) >= cfg.SECRET_ENTROPY_THRESHOLD_BASE64:
                out = out.replace(run, GESCHWAERZT)
        for m in list(s._NARROW_RUN_RE.finditer(out)):
            run = m.group(0)
            if not s._is_narrow_alphabet(run):
                continue
            fenster = out[max(0, m.start() - cfg.SECRET_CONTEXT_WINDOW):m.start()]
            if s._CREDENTIAL_WORD_RE.search(fenster):
                out = out.replace(run, GESCHWAERZT)
        if s.content_hit(out):
            return GESCHWAERZT
        return out
    except Exception:
        return None


# --- Rolle --------------------------------------------------------------------------------

def rolle(cwd: str = "") -> str | None:
    """haupt | worker | gast, soweit aus Umgebung und tmux ermittelbar, sonst None.

    Gast: WB_PERSON oder die tmux-Option @wb_person (wie auto-recall.sh). Worker/Haupt: die
    tmux-Paneoption @wb_role der Werkbank (worker bzw. orchestrator), ersatzweise ein
    Arbeitsordner unter ~/.pi-workers/worktrees/."""
    import re
    import subprocess
    person = os.environ.get("WB_PERSON", "")
    wb_rolle = ""
    pane = os.environ.get("TMUX_PANE", "")
    if pane:
        try:
            r = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#{@wb_person}|#{@wb_role}"],
                               capture_output=True, text=True, timeout=1)
            teile = (r.stdout.strip() + "|").split("|")
            person = person or teile[0]
            wb_rolle = teile[1]
        except (OSError, subprocess.SubprocessError):
            pass
    if person and re.fullmatch(r"[a-z0-9_-]+", person):
        return "gast"
    if not cwd:
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = ""
    if wb_rolle == "worker" or "/.pi-workers/worktrees/" in cwd:
        return "worker"
    if wb_rolle:
        return "haupt"
    return None


# --- Schreiben ----------------------------------------------------------------------------

def eintrag(kanal: str, anfrage: str = "", treffer: list | None = None, grund: str | None = None,
            dauer_ms: float | None = None, rolle_: str | None = None, **extra) -> dict:
    """Die Zeile, die `anhaengen` schreibt. `treffer`: Liste von (rel, score) oder dicts mit
    rel/score. `extra` nimmt kanalspezifische Felder auf (gezeigt, detail, teile, ...)."""
    tr = []
    for h in (treffer or [])[:TREFFER_MAX]:
        if isinstance(h, dict):
            rel, score = h.get("rel") or h.get("pfad") or "", h.get("score")
        else:
            rel, score = h[0], (h[1] if len(h) > 1 else None)
        if not rel:
            continue
        tr.append({"rel": str(rel), "score": round(float(score), 3) if isinstance(score, (int, float)) else None})
    text = schwaerzen(anfrage or "")
    d = {
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "kanal": kanal,
        "rolle": rolle_,
        "anfrage": None if text is None else text[:ANFRAGE_MAX],
        "treffer": tr,
        "leer": grund if grund in GRUENDE else None,
        "dauer_ms": None if dauer_ms is None else int(round(dauer_ms)),
    }
    d.update({k: v for k, v in extra.items() if v is not None})
    return d


def _rotieren(ordner: Path, heute: dt.date) -> None:
    grenze = heute - dt.timedelta(days=AUFBEWAHRUNG_TAGE)
    try:
        for f in ordner.glob("*.jsonl"):
            try:
                if dt.date.fromisoformat(f.stem) < grenze:
                    f.unlink()
            except ValueError:
                continue
    except OSError:
        pass


def anhaengen(zeile: dict, vault: Path | str | None = None, ordner: Path | str | None = None) -> bool:
    """Eine Zeile an die Tagesdatei haengen (ein write im Append-Modus, damit gleichzeitige
    Schreiber sich nicht zerschneiden). Die erste Zeile eines Tages rotiert."""
    if not aktiv():
        return False
    try:
        ordner = verzeichnis(vault, ordner)
        ordner.mkdir(parents=True, exist_ok=True)
        heute = dt.datetime.now(dt.timezone.utc).date()
        pfad = ordner / f"{heute.isoformat()}.jsonl"
        neu = not pfad.exists()
        daten = (json.dumps(zeile, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        fd = os.open(str(pfad), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, daten)
        finally:
            os.close(fd)
        if neu:
            _rotieren(ordner, heute)
        return True
    except Exception:
        return False


def protokolliere(kanal: str, vault: Path | str | None = None, ordner: Path | str | None = None,
                  **kw) -> bool:
    """eintrag + anhaengen, nie eine Ausnahme."""
    if not aktiv():
        return False
    try:
        return anhaengen(eintrag(kanal, **kw), vault, ordner)
    except Exception:
        return False


# --- Lesen --------------------------------------------------------------------------------

def lesen(vault: Path | str | None = None, tage: int = 7, now: dt.datetime | None = None,
          ordner: Path | str | None = None) -> list[dict]:
    """Alle Zeilen der letzten `tage` Tage (ueber die Tagesdateien, dann nach ts gefiltert)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    grenze = now - dt.timedelta(days=tage)
    ordner = verzeichnis(vault, ordner)
    out = []
    try:
        dateien = sorted(ordner.glob("*.jsonl"))
    except OSError:
        return out
    for f in dateien:
        try:
            if dt.date.fromisoformat(f.stem) < grenze.date():
                continue
            zeilen = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except (ValueError, OSError):
            continue
        for z in zeilen:
            try:
                d = json.loads(z)
                ts = dt.datetime.fromisoformat(str(d.get("ts", "")).replace("Z", "+00:00"))
            except (ValueError, TypeError):
                continue
            if ts >= grenze:
                d["_ts"] = ts
                out.append(d)
    return out
