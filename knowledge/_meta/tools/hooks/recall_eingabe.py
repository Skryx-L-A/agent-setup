"""Welche Eingaben der Recall-Hook gar nicht erst sucht (b7-recall, 2026-09-29).

Der Hook feuert bei JEDER Eingabe des UserPromptSubmit, also auch bei Hintergrundmeldungen,
Nachrichten anderer Sitzungen, Texten der Kontextwache und Folge-Nachrichten des Orchestrators.
`maschinell(prompt)` sagt, welche Regel eine Eingabe als maschinell erkennt (Name) oder None.

Befund 29.09. (Stichprobe 69 Einspielungen aus 7 Tagen Transkripten, geschichtet nach Art,
~/.pi-workers/results/b7-recall/): Orchestrator-Nachrichten ohne Auftragsdatei 1 von 58
eingespielten Notizen passend, Texte der Kontextwache 0 von 3, Fortsetzungs-Texte nach der
Kompaktierung 0 von 6, Hintergrundmeldungen 0 von 11; menschliche Eingaben 11 von 28.
Orchestrator-Nachrichten erreichen den Hook OHNE den Vorsatz "Another Claude session sent a
message:", den das Transkript zeigt - der alte Filter griff deshalb nie (146 von 296
Einspielungen). Der Hook ruft das Modul im ersten python-Start auf, es kostet keinen eigenen.

Jede Regel hat einen Schalter: BRAIN_RECALL_FILTER_<NAME>=0 schaltet sie ab (NAME in
Grossbuchstaben, z. B. BRAIN_RECALL_FILTER_ORCHESTRATOR=0). Die ersten fuenf Regeln sind die
bisherigen Muster aus `auto-recall.sh` (2026-09-23/24), unveraendert in der Wirkung.
Der Auftrags-Recall (auftrag_query.py) laeuft vorher: eine Orchestrator-Nachricht, die auf eine
Auftragsdatei zeigt, wird weiter ueber den Auftrag gesucht.
"""
from __future__ import annotations

import os

# Hintergrundmeldungen des Harness (Task-Ende, Monitor-Ereignisse).
def _task_notification(t: str) -> bool:
    return "<task-notification>" in t or "[SYSTEM NOTIFICATION" in t


# Nachrichten anderer Sitzungen und Zustellhinweise.
def _sitzungsnachricht(t: str) -> bool:
    return (t.startswith("<cross-session-message") or t.startswith("[Cross-session")
            or t.startswith("Another Claude session sent a message")
            or '<cross-session-message from="' in t)


def _system_reminder(t: str) -> bool:
    return "<system-reminder>" in t


def _wb_marker(t: str) -> bool:
    return t.startswith("[wb-freigabe]")


# Zustellung des Werkbank-Orchestrators ueber die Sitzungs-Inbox (Kopfzeile bzw. bei manchen
# Harnesses nur der Arbeitsverzeichnis-Absatz). Mit Auftragsdatei greift vorher der
# Auftrags-Recall; hier landen Nachtraege, "Pause beendet", GPU-Absprachen und Zeiger ohne Datei.
# Seit 10.10.2026 steht vor jeder wb-inbox-Zustellung die gemessene Herkunftszeile; ohne sie im
# Tupel ging keine dieser Nachrichten mehr durch den Filter (53 im Nutzungsprotokoll, 10.-13.10.).
_ORCHESTRATOR = (
    "Auftrag deines Orchestrators (Werkbank)",
    "[Arbeitsverzeichnis] Dieser Auftrag laeuft in einem eigenen Worktree",
    "[Herkunft laut wb-inbox",
)


def _orchestrator(t: str) -> bool:
    return t.lstrip().startswith(_ORCHESTRATOR)


# Kontextwache (~/.local/bin/context-guard): Warnungen kommen als eingefuegter Text, oft in
# <pasted_content> gehuellt, daher nicht nur am Anfang gesucht.
def _kontextwache(t: str) -> bool:
    return "KONTEXT-WARNUNG (automatisch)" in t[:600]


# Fortsetzungs-Texte derselben Wache nach einer Kompaktierung.
_FORTSETZUNG = (
    "WEITERARBEITEN (automatisch nach der Kompaktierung",
    "Weiter nach der Kompaktierung: lies ",
)


def _fortsetzung(t: str) -> bool:
    return t.lstrip().startswith(_FORTSETZUNG)


# Meldungen der Tafel an den Halter oder die Warteschlange ("wb-tafel: dran -- ...", Fristen,
# Stoerungen); sie kommen ohne Herkunftszeile, wenn die Tafel direkt zustellt (Pruefbericht 14.10.2026:
# 6 Einspielungen auf solche Meldungen).
def _tafel(t: str) -> bool:
    return t.lstrip().startswith("wb-tafel: ")


# Gedaechtnis-Konsolidierung eines Harness (lange Vorlage, lief 28.09. zweimal in die Frist).
def _memory_agent(t: str) -> bool:
    return t.lstrip().startswith("## Memory Writing Agent")


REGELN = (
    ("task_notification", _task_notification),
    ("sitzungsnachricht", _sitzungsnachricht),
    ("system_reminder", _system_reminder),
    ("wb_marker", _wb_marker),
    ("orchestrator", _orchestrator),
    ("tafel", _tafel),
    ("kontextwache", _kontextwache),
    ("fortsetzung", _fortsetzung),
    ("memory_agent", _memory_agent),
)


def aktiv(name: str, env=None) -> bool:
    env = os.environ if env is None else env
    return env.get(f"BRAIN_RECALL_FILTER_{name.upper()}", "1").strip() != "0"


def maschinell(prompt: str, env=None) -> str | None:
    """Name der ersten eingeschalteten Regel, die `prompt` als maschinell erkennt, sonst None."""
    t = prompt or ""
    for name, trifft in REGELN:
        if aktiv(name, env) and trifft(t):
            return name
    return None
