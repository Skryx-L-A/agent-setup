"""`brain undo` - eine Ruecknahme in der Sprache, in der ein Mensch sie stellt.

Der Rueckweg aus einem Maschinenschreibvorgang besteht heute aus einem
git-Schnappschuss und `applied.json`. Beides ist Material, keine Antwort: die
Frage, die tatsaechlich gestellt wird, lautet „nimm zurueck, was der Traum
gestern an dieser Notiz getan hat", und niemand kann sie stellen. Dieses Modul
ist die Abfrage darueber, gebaut nach ChronoMem (arXiv 2607.27773): eine
Versionsschicht ueber dem Agentengedaechtnis, die Ruecknahmeabsichten ueber
hybride Suche auf Versionen abbildet und danach MISST, ob sich das System
wirklich so verhaelt, als haette es das Spaetere nie gesehen.

Der Anlass steht im Vault: am 29.07.2026 hat ein Wartungslauf 114
handgeschriebene Zeilen durch Modelltext ersetzt. Der DREAM-PLAN nennt diesen
Vorfall als tragenden Grund fuer D2. Vor dem Kaltstart des Traums, der zum
ersten Mal in grossem Umfang schreibt, soll der Rueckweg vorhanden sein.

Drei Grenzen, die im Code stehen und nicht in der Dokumentation:

1. **Es wird nie geloescht und nie Historie umgeschrieben.** Eine fruehere
   Fassung wird als NEUER Stand hergestellt, mit eigenem Commit, und die
   Ruecknahme ist selbst wieder ruecknehmbar. Kein `git reset`, kein
   `git revert --no-commit` in fremde Arbeit hinein, kein Loeschen einer Notiz,
   die ein Lauf angelegt hat.
2. **Es zeigt immer erst, was es taete.** Ausgefuehrt wird erst nach
   Bestaetigung. Ein Werkzeug, das auf einen unscharfen Satz hin ungefragt
   Dateien zuruecksetzt, ist gefaehrlicher als das Problem, das es loest.
3. **Es fasst nur an, was Traum oder Gaertner geschrieben haben.** Eine
   handgeschriebene Aenderung desselben Zeitraums bleibt stehen; liegen beide
   in derselben Datei, sagt das Werkzeug das und tut nichts.

Zur Zuordnung - die Frage, an der die Ehrlichkeit des Werkzeugs haengt:
`applied.json` ist die BEHAUPTUNG (welcher Lauf welche Notiz angefasst hat),
die git-Historie ist der BELEG (welche Bytes vorher dastanden). Keins von
beiden genuegt allein. Der git-Autor taugt nicht zur Unterscheidung, weil der
Gaertner unter eigener des Nutzers Identitaet committet (`config.GIT_AUTHOR`);
unterscheidbar ist nur die Commit-Nachricht, und die ist Konvention, kein
Beweis. Deshalb verlangt jede Ruecknahme hier ZWEI Zeugen und verweigert die
Arbeit, sobald die beiden sich widersprechen - die Faelle stehen in
`REFUSALS`.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from gardener import config

# Vault-relative Ablage. Die Pruefspur des Traums ist versioniert, unsere ist
# es auch: eine Ruecknahme, die nur auf der Maschine steht, ist fuer den
# naechsten Menschen nicht nachvollziehbar.
DREAM_AUDIT_DIR = "_meta/state/dream"
UNDO_AUDIT_DIR = "_meta/state/undo"
APPLIED_FILE = "applied.json"
OUTCOME_APPLIED = "applied"

# Wie ein Maschinen-Commit erkannt wird. Bewusst eine kurze, wortwoertliche
# Liste statt einer klugen Heuristik: wer hier zu grosszuegig ist, erklaert
# einen handgeschriebenen Commit zur Maschinenarbeit und setzt ihn zurueck.
MACHINE_SUBJECT_RE = re.compile(r"^\s*(dream|traum|gardener|gaertner|gärtner)\b[: ]",
                                re.IGNORECASE)
# Die eigenen Commits dieses Werkzeugs. Sie zaehlen nicht als fremde Arbeit an
# einer Datei - sonst meldet die zweite Ruecknahme derselben Stelle einen
# Fremdanteil, den es nicht gibt, und verdeckt die richtige Auskunft („die
# fruehere Fassung steht bereits da"). Gemessen am 11.08.2026 im Rauchtest.
UNDO_SUBJECT_RE = re.compile(r"^\s*undo \d{8}-\d{6}\b")
RUN_ID_RE = re.compile(r"\b(\d{8}-\d{6})\b")


def is_machine_commit(subject: str) -> bool:
    return bool(MACHINE_SUBJECT_RE.match(subject) or UNDO_SUBJECT_RE.match(subject))

ACTOR_TRAUM = "traum"
ACTOR_GAERTNER = "gaertner"

# Wie lange auf die Suche gewartet wird. Sie ruft Ollama, und Ollama teilt sich
# die GPU mit allem anderen auf der Maschine: gemessen am 11.08.2026 stand ein
# `brain undo` zwei Minuten lang still, weil ein Modell nebenan rechnete. Die
# Suche ist hier Kuer - sie ordnet Kandidaten und stellt die Verhaltensprobe -,
# also wartet dieses Werkzeug eine begrenzte Zeit und sagt danach, dass es
# nicht gewartet hat, statt zu haengen.
SEARCH_TIMEOUT = 20.0


def search_with_deadline(vault: Path, query: str, k: int, timeout: float = SEARCH_TIMEOUT):
    """`(hits, fallback)` oder None, wenn die Suche nicht rechtzeitig antwortet.

    Der Aufruf laeuft in einem Hintergrundfaden, der als Daemon markiert ist:
    eine haengende HTTP-Verbindung laesst sich nicht abbrechen, aber das
    Programm muss trotzdem beenden koennen.
    """
    import queue
    import threading

    from . import search as search_mod

    antwort: "queue.Queue" = queue.Queue(maxsize=1)

    def lauf() -> None:
        try:
            antwort.put(("ok", search_mod.search(Path(vault), query, k)))
        except Exception as e:                      # noqa: BLE001
            antwort.put(("fehler", e))

    threading.Thread(target=lauf, daemon=True).start()
    try:
        art, wert = antwort.get(timeout=timeout)
    except queue.Empty:
        return None
    if art == "fehler":
        raise wert
    return wert


# ---------------------------------------------------------------------------
# git, sehr klein gehalten
# ---------------------------------------------------------------------------

def git(vault: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(vault), *args],
                          capture_output=True, text=True, timeout=60, check=check)


def git_out(vault: Path, *args: str) -> str | None:
    p = git(vault, *args)
    return p.stdout if p.returncode == 0 else None


def blob_at(vault: Path, sha: str, rel: str) -> str | None:
    """Der Text einer Datei in einem Commit, oder None wenn es sie dort nicht
    gab. None ist eine Aussage, kein Fehler: die Datei wurde von diesem Commit
    ANGELEGT, und eine Ruecknahme waere ein Loeschen."""
    return git_out(vault, "show", f"{sha}:{rel}")


def commit_subject(vault: Path, sha: str) -> str:
    return (git_out(vault, "log", "-1", "--format=%s", sha) or "").strip()


def commit_files(vault: Path, sha: str) -> list[str]:
    out = git_out(vault, "show", "--name-only", "--format=", sha) or ""
    return [line.strip() for line in out.splitlines() if line.strip()]


def commits_touching_since(vault: Path, sha: str, rel: str) -> list[str]:
    out = git_out(vault, "log", "--format=%H", f"{sha}..HEAD", "--", rel) or ""
    return [line.strip() for line in out.splitlines() if line.strip()]


def worktree_dirty(vault: Path, rel: str) -> bool:
    out = git_out(vault, "status", "--porcelain", "--", rel) or ""
    return bool(out.strip())


def head(vault: Path) -> str:
    return (git_out(vault, "rev-parse", "HEAD") or "").strip()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Was die Maschine geschrieben hat
# ---------------------------------------------------------------------------

@dataclass
class MachineWrite:
    """Ein Schreibvorgang, den ein autonomer Lauf fuer sich behauptet."""
    run_id: str
    actor: str
    rel: str
    op: str
    hunk_id: str
    at: dt.datetime
    commit: str | None = None          # der Commit, der ihn traegt
    parent: str | None = None          # dessen Vorgaenger - dort steht die alte Fassung

    @property
    def anchored(self) -> bool:
        return bool(self.commit and self.parent)


def run_time(run_id: str) -> dt.datetime:
    """Die Lauf-Kennung IST der Zeitstempel (`20260810-223126`). Wo sie sich
    nicht lesen laesst, gilt der Anfang der Zeitrechnung - so faellt der Lauf
    aus jedem Zeitfenster heraus, statt zufaellig in eines zu geraten."""
    try:
        return dt.datetime.strptime(run_id, "%Y%m%d-%H%M%S")
    except ValueError:
        return dt.datetime.min


def load_applied(vault: Path) -> list[MachineWrite]:
    """Alle uebernommenen Hunks aus allen `applied.json` des Vaults.

    Nur `outcome == applied` zaehlt: was der Lauf abgelehnt, uebersprungen oder
    eskaliert hat, steht nicht in der Datei und darf nicht zurueckgenommen
    werden - man kann nichts zuruecknehmen, was nie geschah.
    """
    writes: list[MachineWrite] = []
    root = Path(vault) / DREAM_AUDIT_DIR
    for applied in sorted(root.glob(f"*/{APPLIED_FILE}")):
        try:
            data = json.loads(applied.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("dry_run"):
            continue
        run_id = str(data.get("run_id") or applied.parent.name)
        for hunk in data.get("hunks") or []:
            if hunk.get("outcome") != OUTCOME_APPLIED:
                continue
            target = hunk.get("target")
            if not target:
                continue
            writes.append(MachineWrite(
                run_id=run_id, actor=ACTOR_TRAUM, rel=str(target),
                op=str(hunk.get("op") or ""), hunk_id=str(hunk.get("hunk_id") or ""),
                at=run_time(run_id)))
    return writes


def anchor(vault: Path, writes: list[MachineWrite]) -> list[MachineWrite]:
    """Jede Behauptung an ihren Commit binden.

    Gesucht wird der Commit, dessen Nachricht die Lauf-Kennung traegt UND der
    die Datei anfasst. Findet sich keiner, bleibt der Schreibvorgang
    unverankert - dann gibt es keine frueheren Bytes, und das Werkzeug sagt das,
    statt zu raten.
    """
    by_run: dict[str, list[str]] = {}
    log = git_out(vault, "log", "--format=%H%x00%s") or ""
    for line in log.splitlines():
        if "\x00" not in line:
            continue
        sha, subject = line.split("\x00", 1)
        found = RUN_ID_RE.search(subject)
        if found and MACHINE_SUBJECT_RE.match(subject):
            by_run.setdefault(found.group(1), []).append(sha)
    for w in writes:
        for sha in by_run.get(w.run_id, []):
            if w.rel in commit_files(vault, sha):
                w.commit = sha
                w.parent = (git_out(vault, "rev-parse", f"{sha}^") or "").strip() or None
                break
    return writes


# ---------------------------------------------------------------------------
# Absicht: was der Satz bedeutet
# ---------------------------------------------------------------------------

@dataclass
class Intent:
    actor: str | None = None
    since: dt.datetime | None = None
    until: dt.datetime | None = None
    newest_run_only: bool = False
    note_hint: str = ""
    raw: str = ""


DATE_PATTERNS = (
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), ("y", "m", "d")),
    (re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b"), ("d", "m", "y")),
    (re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(?!\d)"), ("d", "m")),
)


def parse_intent(satz: str, now: dt.datetime | None = None) -> Intent:
    """Aus einem Satz das machen, wonach sich suchen laesst: wer, wann, welche
    Notiz. Bewusst regelbasiert und klein. Ein Modell haette hier mehr Sprache
    verstanden und weniger Verlaesslichkeit gebracht - was es falsch versteht,
    faellt in einem Vorschau-Dialog auf, aber die Vorschau selbst muss
    reproduzierbar sein."""
    now = now or dt.datetime.now()
    heute = now.replace(hour=0, minute=0, second=0, microsecond=0)
    low = satz.lower()
    intent = Intent(raw=satz)

    if re.search(r"\btraum|\bdream", low):
        intent.actor = ACTOR_TRAUM
    elif re.search(r"g[aä]rtner|gaertner|gardener", low):
        intent.actor = ACTOR_GAERTNER

    if "vorgestern" in low:
        intent.since, intent.until = heute - dt.timedelta(days=2), heute - dt.timedelta(days=1)
    elif "gestern" in low or "letzte nacht" in low or "heute nacht" in low:
        intent.since, intent.until = heute - dt.timedelta(days=1), heute
    elif "heute" in low:
        intent.since, intent.until = heute, heute + dt.timedelta(days=1)
    elif "diese woche" in low:
        intent.since = heute - dt.timedelta(days=heute.weekday())
    elif "letzte woche" in low:
        intent.since = heute - dt.timedelta(days=heute.weekday() + 7)
        intent.until = heute - dt.timedelta(days=heute.weekday())
    if re.search(r"letzt\w*\s+lauf|j[uü]ngst\w*\s+lauf|letzten durchlauf", low):
        intent.newest_run_only = True

    for pattern, order in DATE_PATTERNS:
        m = pattern.search(satz)
        if not m:
            continue
        parts = dict(zip(order, m.groups()))
        year = int(parts.get("y") or now.year)
        try:
            tag = dt.datetime(year, int(parts["m"]), int(parts["d"]))
        except ValueError:
            continue
        intent.since, intent.until = tag, tag + dt.timedelta(days=1)
        break

    intent.note_hint = satz
    return intent


def in_window(w: MachineWrite, intent: Intent) -> bool:
    if intent.since and w.at < intent.since:
        return False
    if intent.until and w.at >= intent.until:
        return False
    if intent.actor and w.actor != intent.actor:
        return False
    return True


PATH_RE = re.compile(r"[\w./-]+\.md\b")


def rank_candidates(vault: Path, writes: list[MachineWrite], intent: Intent
                    ) -> list[MachineWrite]:
    """Die hybride Haelfte: der Ereignisspeicher liefert die Kandidaten, die
    Suche die Reihenfolge.

    Steht im Satz ein Pfad, gilt der Pfad. Sonst wird `brain search` ueber den
    Satz gelegt und die Trefferliste als Rangfolge UEBER die Kandidaten
    verwendet - Notizen, die kein Lauf angefasst hat, koennen dabei nicht
    gewinnen, weil sie gar nicht im Kandidatenkreis sind. Faellt die Suche aus
    (kein Modell erreichbar), bleibt die zeitliche Ordnung, neueste zuerst.
    """
    kandidaten = [w for w in writes if in_window(w, intent)]
    if intent.newest_run_only and kandidaten:
        neuester = max(k.run_id for k in kandidaten)
        kandidaten = [k for k in kandidaten if k.run_id == neuester]
    if not kandidaten:
        return []

    pfade = {p for p in PATH_RE.findall(intent.note_hint)}
    if pfade:
        genannt = [k for k in kandidaten
                   if any(k.rel == p or k.rel.endswith("/" + p) for p in pfade)]
        if genannt:
            return sorted(genannt, key=lambda k: (k.at, k.rel), reverse=True)

    rang: dict[str, int] = {}
    try:
        ergebnis = search_with_deadline(Path(vault), intent.note_hint, 20)
        if ergebnis is not None:
            rang = {h.rel: i for i, h in enumerate(ergebnis[0])}
    except Exception:                      # noqa: BLE001 - Suche ist Kuer, nicht Pflicht
        rang = {}
    return sorted(kandidaten,
                  key=lambda k: (rang.get(k.rel, 10_000), -k.at.timestamp(), k.rel))


# ---------------------------------------------------------------------------
# Plan und Verweigerung
# ---------------------------------------------------------------------------

REFUSALS = {
    "unverankert": "kein Commit traegt diesen Lauf - es gibt keine frueheren Bytes",
    "angelegt": "die Notiz wurde von diesem Lauf ANGELEGT - brain undo loescht nie",
    "fremdanteil": "nach dem Lauf hat jemand anderes an dieser Datei gearbeitet",
    "unsauber": "die Datei hat uncommittete Aenderungen im Arbeitsbaum",
    "gemischt": "der Commit des Laufs enthaelt Dateien, die applied.json nicht nennt",
    "unveraendert": "die fruehere Fassung steht bereits in der Datei",
}


@dataclass
class Plan:
    write: MachineWrite
    rel: str
    current: str
    restored: str
    refusal: str | None = None
    detail: str = ""
    foreign_commits: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.refusal is None

    def to_dict(self) -> dict:
        return {"rel": self.rel, "run_id": self.write.run_id,
                "actor": self.write.actor, "at": self.write.at.isoformat(),
                "commit": self.write.commit, "restore_from": self.write.parent,
                "refusal": self.refusal, "detail": self.detail,
                "foreign_commits": self.foreign_commits,
                "hash_now": sha256(self.current) if self.current else None,
                "hash_after": sha256(self.restored) if self.restored else None}


def build_plan(vault: Path, w: MachineWrite, applied_targets: set[str]) -> Plan:
    """Prueft einen Schreibvorgang gegen alle Grenzen und gibt entweder eine
    ausfuehrbare Ruecknahme oder eine begruendete Verweigerung zurueck."""
    vault = Path(vault)
    pfad = vault / w.rel
    aktuell = pfad.read_text(encoding="utf-8") if pfad.exists() else ""

    if not w.anchored:
        return Plan(w, w.rel, aktuell, "", "unverankert", REFUSALS["unverankert"])

    fremde_im_commit = [f for f in commit_files(vault, w.commit)
                        if f.endswith(".md") and f not in applied_targets
                        and not f.startswith(DREAM_AUDIT_DIR)]
    if fremde_im_commit:
        return Plan(w, w.rel, aktuell, "", "gemischt",
                    REFUSALS["gemischt"] + ": " + ", ".join(sorted(fremde_im_commit)[:5]))

    vorher = blob_at(vault, w.parent, w.rel)
    if vorher is None:
        return Plan(w, w.rel, aktuell, "", "angelegt", REFUSALS["angelegt"])

    spaeter = [c for c in commits_touching_since(vault, w.commit, w.rel)]
    fremd = [c for c in spaeter if not is_machine_commit(commit_subject(vault, c))]
    if fremd:
        return Plan(w, w.rel, aktuell, vorher, "fremdanteil",
                    REFUSALS["fremdanteil"] + f" ({len(fremd)} Commit(s), "
                    f"zuletzt {commit_subject(vault, fremd[0])[:60]})",
                    foreign_commits=fremd)

    if worktree_dirty(vault, w.rel):
        return Plan(w, w.rel, aktuell, vorher, "unsauber", REFUSALS["unsauber"])

    if aktuell == vorher:
        return Plan(w, w.rel, aktuell, vorher, "unveraendert", REFUSALS["unveraendert"])

    return Plan(w, w.rel, aktuell, vorher)


def plan_undo(vault: Path, satz: str, now: dt.datetime | None = None,
              limit: int = 5) -> tuple[Intent, list[Plan]]:
    vault = Path(vault)
    writes = anchor(vault, load_applied(vault))
    ziele = {w.rel for w in writes}
    intent = parse_intent(satz, now=now)
    kandidaten = rank_candidates(vault, writes, intent)[:limit]
    return intent, [build_plan(vault, w, ziele) for w in kandidaten]


# ---------------------------------------------------------------------------
# Ausfuehren
# ---------------------------------------------------------------------------

def undo_id(now: dt.datetime | None = None) -> str:
    return (now or dt.datetime.now()).strftime("%Y%m%d-%H%M%S")


def apply_plans(vault: Path, plans: list[Plan], *, uid: str | None = None,
                commit: bool = True) -> dict:
    """Stellt die frueheren Fassungen als NEUEN Stand her.

    Reihenfolge mit Absicht: erst der Zustandseintrag, dann die Dateien, dann
    der Commit. Bricht etwas in der Mitte ab, liegt der Eintrag schon da und
    sagt, was gewollt war - ein halber Zustand mit Protokoll ist wiederherstell-
    bar, ein halber ohne nicht.
    """
    vault = Path(vault)
    uid = uid or undo_id()
    machbar = [p for p in plans if p.ok]
    eintrag = {
        "undo_id": uid,
        "head_before": head(vault),
        "entries": [{"rel": p.rel, "run_id": p.write.run_id,
                     "undone_commit": p.write.commit,
                     "restored_from": p.write.parent,
                     "hash_before_undo": sha256(p.current),
                     "hash_after_undo": sha256(p.restored)} for p in machbar],
        "refused": [p.to_dict() for p in plans if not p.ok],
    }
    audit = vault / UNDO_AUDIT_DIR / uid
    audit.mkdir(parents=True, exist_ok=True)
    (audit / "undone.json").write_text(
        json.dumps(eintrag, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")

    for p in machbar:
        (vault / p.rel).write_text(p.restored, encoding="utf-8")

    eintrag["committed"] = False
    if commit and machbar:
        rels = [p.rel for p in machbar] + [f"{UNDO_AUDIT_DIR}/{uid}/undone.json"]
        laeufe = sorted({p.write.run_id for p in machbar})
        msg = (f"undo {uid}: restore {len(machbar)} note(s) written by run(s) "
               f"{', '.join(laeufe)}")
        git(vault, "add", "--", *rels)
        r = git(vault, "commit", "--only", "-m", msg, "--", *rels)
        eintrag["committed"] = r.returncode == 0
        eintrag["undo_commit"] = head(vault) if r.returncode == 0 else None
        (audit / "undone.json").write_text(
            json.dumps(eintrag, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8")
    return eintrag


def last_undo(vault: Path) -> dict | None:
    eintraege = sorted((Path(vault) / UNDO_AUDIT_DIR).glob("*/undone.json"))
    if not eintraege:
        return None
    return json.loads(eintraege[-1].read_text(encoding="utf-8"))


def revert_undo(vault: Path, eintrag: dict, commit: bool = True) -> dict:
    """Die Ruecknahme der Ruecknahme. Der Text von vor der Ruecknahme steht im
    Commit davor - deshalb muss nichts kopiert werden, und deshalb darf nie
    Historie umgeschrieben werden."""
    vault = Path(vault)
    zurueck = []
    for e in eintrag.get("entries", []):
        text = blob_at(vault, eintrag["head_before"], e["rel"])
        if text is None:
            continue
        (vault / e["rel"]).write_text(text, encoding="utf-8")
        zurueck.append(e["rel"])
    if commit and zurueck:
        git(vault, "add", "--", *zurueck)
        git(vault, "commit", "--only", "-m",
            f"undo {eintrag['undo_id']} zurueckgenommen", "--", *zurueck)
    return {"reverted": zurueck, "undo_id": eintrag.get("undo_id")}


# ---------------------------------------------------------------------------
# Der Index - ohne ihn ist eine Ruecknahme keine
# ---------------------------------------------------------------------------

def refresh_index(vault: Path, rels: list[str]) -> list[tuple[str, str, str]]:
    """Zieht die semantische Haelfte auf den wiederhergestellten Text nach.

    Notwendig, weil `braincli.search.load_all_embeddings` die Vektoren OHNE
    Hash-Vergleich laedt: nach einer Ruecknahme steht der Vektor des
    zurueckgenommenen Textes weiter im Index und wird weiter gefunden. Genau
    das ist die Ruecknahme, die keine ist.

    Ist kein Modell erreichbar, wird der veraltete Vektor GELOESCHT statt
    stehengelassen. Die Notiz verliert damit bis zum naechsten Einbettungslauf
    ihre semantische Haelfte - das kostet Trefferquote. Ein stehengelassener
    Vektor dagegen liefert weiter genau den Text aus, der zurueckgenommen
    wurde. Von zwei unvollkommenen Zustaenden ist der stille Verlust der
    ehrlichere.
    """
    from gardener.linking import cache_key, embed_document
    from gardener.ollama import OllamaClient, OllamaError
    from gardener.store import Store
    from gardener.vault import parse_note

    from .extra_embed import extra_db_path

    ergebnis: list[tuple[str, str, str]] = []
    stores = [Store(config.STATE_DIR / "gardener.db")]
    extra = extra_db_path(Path(vault))
    if extra.exists():
        stores.append(Store(extra))
    client = None
    try:
        for rel in rels:
            pfad = Path(vault) / rel
            if not pfad.exists():
                continue
            note = parse_note(Path(vault), pfad)
            vec = None
            try:
                client = client or OllamaClient()
                vec = embed_document(client, note.embed_text)
            except (OllamaError, OSError):
                vec = None
            for store in stores:
                if vec is None:
                    store.conn.execute("DELETE FROM embeddings WHERE rel=?", (rel,))
                    store.conn.commit()
                else:
                    store.put_embedding(rel, cache_key(note), vec)
            ergebnis.append((rel, "neu eingebettet" if vec else "Vektor geloescht",
                             cache_key(note)))
    finally:
        for store in stores:
            store.close()
    return ergebnis


# ---------------------------------------------------------------------------
# Pruefprotokoll (ChronoMem): verhaelt sich das System, als haette es das
# Spaetere nie gesehen?
# ---------------------------------------------------------------------------

OK, FAIL, OFFEN = "ok", "fail", "unpruefbar"

WORT_RE = re.compile(r"[\wäöüß]{5,}", re.IGNORECASE)


def probe_terms(entfernt: str, geblieben: str, n: int = 6) -> list[str]:
    """Woerter, die NUR im zurueckgenommenen Text standen. Sie sind die Sonde:
    findet die Suche die Notiz noch ueber sie, hat das System das Spaetere
    nicht vergessen."""
    weg = [w.lower() for w in WORT_RE.findall(entfernt)]
    bleibt = {w.lower() for w in WORT_RE.findall(geblieben)}
    einmalig = [w for w in dict.fromkeys(weg) if w not in bleibt]
    return einmalig[:n]


def verify(vault: Path, eintrag: dict, plans: list[Plan]) -> list[dict]:
    """Vier Fragen, jede einzeln beantwortet und einzeln berichtet."""
    vault = Path(vault)
    befunde: list[dict] = []
    plan_by_rel = {p.rel: p for p in plans if p.ok}

    for e in eintrag.get("entries", []):
        rel = e["rel"]
        pfad = vault / rel
        ist = pfad.read_text(encoding="utf-8") if pfad.exists() else ""
        befunde.append({
            "pruefung": "datei", "rel": rel,
            "status": OK if sha256(ist) == e["hash_after_undo"] else FAIL,
            "detail": "Inhalt entspricht der wiederhergestellten Fassung"})

        lebt = git(vault, "cat-file", "-e", f"{e['undone_commit']}^{{commit}}").returncode == 0
        befunde.append({
            "pruefung": "historie", "rel": rel,
            "status": OK if lebt else FAIL,
            "detail": "der zurueckgenommene Commit ist weiterhin abrufbar - "
                      "nichts wurde geloescht oder umgeschrieben"})

        befunde.append(_index_befund(vault, rel, ist))

        plan = plan_by_rel.get(rel)
        befunde.append(_verhalten_befund(vault, rel, plan))

    befunde.append({
        "pruefung": "ruecknehmbar", "rel": "-",
        "status": OK if eintrag.get("head_before") and
        git(vault, "cat-file", "-e", f"{eintrag['head_before']}^{{commit}}").returncode == 0
        else FAIL,
        "detail": "der Stand vor der Ruecknahme ist abrufbar, die Ruecknahme "
                  "ist also selbst ruecknehmbar"})
    return befunde


def _index_befund(vault: Path, rel: str, text: str) -> dict:
    """Traegt der Index den Vektor des WIEDERHERGESTELLTEN Textes?"""
    from gardener.linking import cache_key
    from gardener.store import Store
    from gardener.vault import parse_note

    db = config.STATE_DIR / "gardener.db"
    if not Path(db).exists():
        return {"pruefung": "index", "rel": rel, "status": OFFEN,
                "detail": "kein Einbettungs-Index vorhanden"}
    store = Store(db, read_only=True)
    try:
        row = store.conn.execute("SELECT hash FROM embeddings WHERE rel=?", (rel,)).fetchone()
    finally:
        store.close()
    if row is None:
        return {"pruefung": "index", "rel": rel, "status": OFFEN,
                "detail": "kein Vektor zu dieser Notiz - die semantische Haelfte "
                          "fehlt bis zum naechsten Einbettungslauf"}
    erwartet = cache_key(parse_note(Path(vault), Path(vault) / rel))
    passt = row[0] == erwartet
    return {"pruefung": "index", "rel": rel, "status": OK if passt else FAIL,
            "detail": "der gespeicherte Vektor gehoert zum wiederhergestellten Text"
            if passt else "der Index traegt noch den Vektor des zurueckgenommenen Textes"}


HOOK_GATE_FILE = "_meta/tools/hooks/auto-recall.sh"
DEFAULT_GATE = 0.40


def recall_gate(vault: Path) -> float:
    """Die Schwelle, ab der eine Einspielung als Treffer gilt - gelesen aus dem
    Hook, der sie tatsaechlich anwendet, nicht hier zum zweiten Mal
    festgeschrieben. Fehlt die Datei, gilt der gemessene Wert von 0,40."""
    pfad = Path(vault) / HOOK_GATE_FILE
    try:
        m = re.search(r'SCORE_THRESHOLD="?([0-9.]+)', pfad.read_text(encoding="utf-8"))
    except OSError:
        return DEFAULT_GATE
    return float(m.group(1)) if m else DEFAULT_GATE


def _verhalten_befund(vault: Path, rel: str, plan: Plan | None) -> dict:
    """Die eigentliche ChronoMem-Frage: liefert die SUCHE den
    zurueckgenommenen Text noch aus?

    Ein Treffer allein beweist das nicht. In einem kleinen Bestand gibt die
    semantische Haelfte jede Notiz auf jede Frage zurueck, einfach weil es
    nichts anderes gibt - im Rauchtest vom 11.08.2026 meldete die Probe
    deshalb einen Fehler, wo keiner war. Als Beleg zaehlt daher nur:
    entweder steht eines der Sondenwoerter noch im heutigen Text der Notiz
    (lexikalischer Grund), oder die semantische Aehnlichkeit liegt ueber der
    Schwelle, mit der der Auto-Recall-Hook tatsaechlich einspielt.
    """
    if plan is None:
        return {"pruefung": "verhalten", "rel": rel, "status": OFFEN,
                "detail": "kein Plan zu dieser Datei - Sonde nicht bildbar"}
    sonden = probe_terms(plan.current, plan.restored)
    if not sonden:
        return {"pruefung": "verhalten", "rel": rel, "status": OFFEN,
                "detail": "der zurueckgenommene Text hatte kein eigenes Wort - "
                          "keine Sonde moeglich"}
    try:
        ergebnis = search_with_deadline(Path(vault), " ".join(sonden), 5)
    except Exception as e:                 # noqa: BLE001
        return {"pruefung": "verhalten", "rel": rel, "status": OFFEN,
                "detail": f"Suche nicht lauffaehig ({e})"}
    if ergebnis is None:
        return {"pruefung": "verhalten", "rel": rel, "status": OFFEN,
                "detail": f"die Suche hat in {SEARCH_TIMEOUT:.0f} s nicht geantwortet - "
                          "die Verhaltensprobe steht aus"}
    hits, fallback = ergebnis
    treffer = next((h for h in hits if h.rel == rel), None)
    zusatz = " (nur BM25, kein Modell erreichbar)" if fallback else ""
    if treffer is None:
        return {"pruefung": "verhalten", "rel": rel, "status": OK,
                "detail": f"Sonde {sonden[:3]}: die Notiz wird darueber nicht "
                          f"mehr gefunden{zusatz}"}

    heutiger_text = ""
    pfad = Path(vault) / rel
    if pfad.exists():
        heutiger_text = pfad.read_text(encoding="utf-8").lower()
    lexikalisch = [s for s in sonden if s in heutiger_text]
    gate = recall_gate(vault)
    semantisch = getattr(treffer, "cosine", 0.0) >= gate

    if lexikalisch:
        return {"pruefung": "verhalten", "rel": rel, "status": FAIL,
                "detail": f"Sonde {sonden[:3]}: {lexikalisch} steht noch im Text "
                          f"der Notiz - die Ruecknahme ist unvollstaendig{zusatz}"}
    if semantisch:
        return {"pruefung": "verhalten", "rel": rel, "status": FAIL,
                "detail": f"Sonde {sonden[:3]}: die Notiz kommt mit Kosinus "
                          f"{getattr(treffer, 'cosine', 0.0):.2f} ueber der "
                          f"Einspielschwelle {gate:.2f} zurueck - der Index traegt "
                          f"den zurueckgenommenen Text noch{zusatz}"}
    return {"pruefung": "verhalten", "rel": rel, "status": OK,
            "detail": f"Sonde {sonden[:3]}: die Notiz erscheint zwar in der Liste, "
                      f"aber ohne Bezug zur Sonde (kein Sondenwort im Text, Kosinus "
                      f"{getattr(treffer, 'cosine', 0.0):.2f} unter {gate:.2f}){zusatz}"}


# ---------------------------------------------------------------------------
# Darstellung
# ---------------------------------------------------------------------------

def diff_stat(plan: Plan) -> tuple[int, int]:
    """Wieviele Zeilen kommen zurueck, wieviele verschwinden."""
    jetzt = plan.current.splitlines()
    dann = plan.restored.splitlines()
    gemeinsam = set(jetzt) & set(dann)
    return (len([z for z in dann if z not in gemeinsam]),
            len([z for z in jetzt if z not in gemeinsam]))


def render_plans(intent: Intent, plans: list[Plan]) -> str:
    zeilen = ["brain undo - Vorschau, es wird noch nichts geaendert", ""]
    fenster = "alles" if not (intent.since or intent.until) else \
        f"{(intent.since or dt.datetime.min):%d.%m.%Y} bis " \
        f"{(intent.until or dt.datetime.max):%d.%m.%Y}"
    zeilen.append(f"  Verstanden als: Urheber {intent.actor or 'beliebig'}, "
                  f"Zeitraum {fenster}"
                  + (", nur der juengste Lauf" if intent.newest_run_only else ""))
    zeilen.append("")
    if not plans:
        zeilen.append("  Kein Schreibvorgang von Traum oder Gaertner passt dazu.")
        return "\n".join(zeilen)
    for i, p in enumerate(plans, 1):
        kopf = f"  {i}. {p.rel}  (Lauf {p.write.run_id}, {p.write.at:%d.%m.%Y %H:%M})"
        if p.ok:
            zurueck, weg = diff_stat(p)
            zeilen.append(kopf)
            zeilen.append(f"     stellt {zurueck} Zeile(n) wieder her, nimmt "
                          f"{weg} Zeile(n) zurueck; Quelle {p.write.parent[:9]}")
        else:
            zeilen.append(kopf + "  ABGELEHNT")
            zeilen.append(f"     {p.detail or REFUSALS.get(p.refusal, p.refusal)}")
    zeilen += ["", "  Ausfuehren stellt die frueheren Fassungen als NEUEN Stand her.",
               "  Nichts wird geloescht, nichts umgeschrieben, die Ruecknahme ist "
               "wieder ruecknehmbar."]
    return "\n".join(zeilen)


def render_verify(befunde: list[dict]) -> str:
    zeichen = {OK: "ok    ", FAIL: "FEHLER", OFFEN: "offen "}
    zeilen = ["", "Pruefprotokoll der Ruecknahme:", ""]
    for b in befunde:
        zeilen.append(f"  [{zeichen[b['status']]}] {b['pruefung']:11s} "
                      f"{b['rel']}: {b['detail']}")
    return "\n".join(zeilen)
