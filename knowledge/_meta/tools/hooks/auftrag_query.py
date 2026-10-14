"""Auftrags-Recall fuer Worker (v2-ki-nutzung T2, 2026-09-24).

Die erste Eingabe eines Workers ist nur ein Zeiger ("Lies und erledige den Auftrag in
/private/tmp/.../scratchpad/tasks/x.md"), und seit T1 spielt der Recall-Hook auf
Sitzungsnachrichten gar nichts mehr ein. Der Auftrag selbst erreichte die Suche also nie.
Vorversuch (eval/v2-ki-nutzung/BEFUNDE.md): eine Suche auf dem bereinigten Auftragstext
findet in 16 von 24 Auftraegen eine passende Notiz, die weder im Auftrag noch im KERN steht.

Dieses Modul ist rein und ohne Vault testbar:
- `task_file(prompt)` findet eine existierende `.md` unter einem Scratchpad oder `tasks/`,
- `query_for(text)` baut die Anfrage: Ueberschrift + die ersten 500 Zeichen Auftragstext,
  nachdem die Standardabsaetze der Auftraggeber entfernt sind,
- `named_in(rel, text)` sagt, ob eine Notiz im Auftrag (oder KERN) schon genannt ist.

Standardabsaetze werden ueber eine EXAKTE Vorlagenliste entfernt, nicht ueber Stichwoerter:
im Vorversuch loeschte ein Stichwortfilter 6 von 30 Auftraegen ganz. Die Liste stammt aus
einer Haeufigkeitszaehlung ueber 161 Auftragsdateien (24.09.): Abschnitte und Saetze, die
woertlich in mindestens vier Auftraegen stehen. Eine neue Vorlage gehoert hier dazu, sobald
sie woertlich wiederkehrt.

Aufruf aus `auto-recall.sh`: Prompt auf stdin, Ausgabe zwei Zeilen (Datei, Anfrage) oder nichts.
Eine leere Anfrage heisst: Auftrag erkannt, aber nichts suchen (der Hook schweigt dann).
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

MAX_BYTES = 20_000
BODY_CHARS = 500

# Pfade im Prompt: absolut oder ~/..., endet auf .md. Nur Scratchpads und tasks/-Ordner
# gelten als Auftragsablage; eine beliebige erwaehnte Notiz loest nichts aus.
_PATH = re.compile(r"(?:~|/)[^\s`'\"<>()\[\]]+?\.md\b")

# Abschnitte, deren Ueberschrift woertlich so lautet, fallen bis zur naechsten Ueberschrift
# gleicher oder hoeherer Ebene weg.
STANDARD_SECTIONS = (
    "## Rahmen (gilt für jeden Brain-5-Auftrag)",       # Vault-Orchestrator, 18 Auftraege
    "## Rahmen (für alle drei Verbesserungs-Spuren gleich)",  # Vault-Orchestrator, 4
)

# Saetze/Zeilen, die woertlich entfernt werden (Leerraum normalisiert).
STANDARD_TEXT = (
    "Nische fuer diese Sitzung: core/cross-niche",  # Myproject, 8
    "Rolle: Worker (`~/.claude/roles/agent.md`).",  # Vault-Orchestrator
    "Du bist ein Worker, kein Orchestrator.",       # Myproject
    "Eigene Prozesse beenden, bevor du DONE meldest.",
    "Antworte danach DONE.",
)

# Was der SessionStart-Hook ohnehin einspielt (dazu kommt der KERN des Projekts).
ALWAYS_IN_CONTEXT = ("CRITICAL-FACTS.md", "HOT.md", "IDENTITY.md")

# Stamm allein ist bei diesen Namen zu unscharf (jedes Projekt hat einen KERN).
_GENERIC_STEMS = {"kern", "moc", "status", "readme", "index", "agents", "state", "plan"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


# Auftragsdateien der Werkbank-Zustellung (b7-recall, 29.09.): "Lies ~/.pi-workers/results/<name>/
# <zeit>.auftrag.txt und arbeite ihn ab." 15 von 22 Orchestrator-Nachrichten der Stichprobe waren
# solche Zeiger; gesucht wurde bisher der Zeiger samt Zustelltext (0 von 43 Notizen passend).
# Nur unter `.pi-workers/results/`. Abschalter: BRAIN_RECALL_AUFTRAG_TXT=0.
_TXT_PATH = re.compile(r"(?:~|/)[^\s`'\"<>()\[\]]+?\.auftrag\.txt\b")


def _kandidaten(prompt: str):
    for m in _PATH.finditer(prompt):
        raw = m.group(0)
        if "/scratchpad/" in raw or "/tasks/" in raw:
            yield m.start(), raw
    if os.environ.get("BRAIN_RECALL_AUFTRAG_TXT", "1").strip() != "0":
        for m in _TXT_PATH.finditer(prompt):
            raw = m.group(0)
            if "/.pi-workers/results/" in raw:
                yield m.start(), raw


def task_file(prompt: str) -> Path | None:
    for _, raw in sorted(_kandidaten(prompt or "")):
        p = Path(raw).expanduser()
        try:
            if p.is_file():
                return p
        except OSError:
            continue
    return None


def read_task(path: Path) -> str:
    with open(path, "rb") as fh:
        return fh.read(MAX_BYTES).decode("utf-8", errors="replace")


def strip_standard(text: str) -> str:
    out, skip_level = [], 0
    for line in text.splitlines():
        s = line.strip()
        m = re.match(r"^(#+)\s", s)
        if m:
            level = len(m.group(1))
            if skip_level and level <= skip_level:
                skip_level = 0
            if s in STANDARD_SECTIONS:
                skip_level = level
                continue
        if skip_level:
            continue
        out.append(line)
    return "\n".join(out)


def query_for(text: str) -> str:
    cleaned = strip_standard(text)
    heading = ""
    rest = []
    for line in cleaned.splitlines():
        s = line.strip()
        if not heading and s.startswith("#"):
            heading = s.lstrip("#").strip()
            continue
        if s.startswith("#"):
            continue  # Unterueberschriften tragen wenig, sie fressen nur Zeichen
        rest.append(line)
    body = _norm("\n".join(rest))
    for tpl in STANDARD_TEXT:
        body = _norm(body.replace(_norm(tpl), " "))
    return _norm(f"{heading} {body[:BODY_CHARS]}")


def named_in(rel: str, text: str) -> bool:
    """Steht die Notiz schon im Text - als Pfad, als Stamm oder als [[Wikilink]]?"""
    if not rel or not text:
        return False
    low = text.lower()
    rel_low = rel.lower()
    if rel_low in low:
        return True
    p = Path(rel_low)
    stem = p.stem
    if stem in _GENERIC_STEMS:
        # "20-projects/brain3/KERN.md" nur, wenn Ordner und Name zusammen dastehen.
        return f"{p.parent.name}/{p.name}" in low or f"{p.parent.name}/{stem}" in low
    # Stamm als ganzes Wort (nicht "kern" in "kernsache"), und erst ab vier Zeichen.
    return len(stem) >= 4 and re.search(
        rf"(?<![a-z0-9_-]){re.escape(stem)}(?![a-z0-9_-])", low) is not None


# Vault-Notizen, die ein Auftrag selbst nennt: Pfad unter einem Zweig oder [[Wikilink]].
_VAULT_REF = re.compile(r"(?:\b(?:\d\d-[a-z]+|_meta)/[^\s`'\"()<>]+?\.md\b|\[\[[^\]]+\]\])")
CURATED_MIN = 2


def curated(text: str) -> bool:
    """Nennt der Auftrag schon mindestens zwei Vault-Notizen, hat der Auftraggeber selbst im
    Vault gesucht; eine automatische Suche bringt dann fast nur Aelteres zum selben Thema.
    Gemessen 24.09. (eval/v2-ki-nutzung/auftrag_recall_hook.py): die 10 Vault-Auftraege nennen
    2-5 Notizen, die 20 aus Werkbank und Myproject keine; ohne diese Regel spielte der Hook in
    8 von 8 Auftraegen ohne neuen Treffer etwas ein (Altplaene BRAIN2-4, BUILD-STATE), mit ihr
    in 2. Kosten: 2 von 16 Auftraegen mit neuem Treffer bleiben still."""
    return len(set(_VAULT_REF.findall(text))) >= CURATED_MIN


def main() -> int:
    prompt = sys.stdin.read()
    path = task_file(prompt)
    if path is None:
        return 0
    try:
        text = read_task(path)
    except OSError:
        return 0
    # Nur die Datei, keine Anfrage: der Hook schweigt, statt den Zeiger selbst zu suchen.
    q = "" if curated(text) else query_for(text)
    if len(q) < 20:
        q = ""
    sys.stdout.write(f"{path}\n{q}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
