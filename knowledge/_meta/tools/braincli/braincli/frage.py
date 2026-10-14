"""`brain frage`: kurze Antwort aus dem Vault, jeder Satz mit `pfad:zeile`.

Ablauf (ana-zugang Empfehlung 6, brain-firmenniveau-plan Phase 3 Z6):

1. `search.search` wie `brain search` (Hybrid, Space-Filter, Rückfall BM25).
2. Aus den besten Treffern die 3-5 Abschnitte mit der größten Wortüberlappung
   zur Frage, jede Zeile mit ihrer Kennung `pfad:zeile`.
3. Ein Motor formuliert höchstens fünf Sätze, jeder mit genau einem Zitat.
   Motoren: `peer` (gemma4:12b über die Motor-Schicht `gardener.engines`,
   SSH-Tunnel) oder `claude` (`claude -p` in der mageren Form über das Abo,
   `10-global/claude-p-ueber-abo.md`). Kein großes Modell am Mac.
4. Deterministische Prüfung je Satz: Datei liegt im Vault (nie `secrets/`,
   nie `IDENTITY.md`), die Zeile existiert, und die zitierte Zeile samt
   Nachbarzeile trägt den Inhalt (Wortüberlappung, jede Zahl des Satzes steht
   dort). Unbelegte Sätze fliegen heraus; bleibt keiner, lautet die Antwort
   „Nicht im Vault belegt."

Nicht für den Recall-Hook gedacht (Frist 2,0 s); ein Motoraufruf dauert Sekunden.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field, replace
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Protocol

from . import llm_sort
from . import search as search_mod

MAX_SAETZE = 5
MAX_ABSCHNITTE = 5
GESETZT = 3                  # so viele beste Suchtreffer sind mit ihrem besten Block immer dabei
SUCH_K = 8
ABSCHNITT_ZEILEN = 18        # längere Blöcke werden um die beste Zeile herum geschnitten
AUSZUG_ZEICHEN = 9000        # Obergrenze für alle Auszüge zusammen
ZEILE_ZEICHEN = 400          # sehr lange Zeilen (Tabellen) werden gekürzt
NACHBARN = 1                 # Belegfenster: zitierte Zeile ± NACHBARN
MIN_DECKUNG = 0.5            # Anteil der Inhaltswörter des Satzes im Belegfenster
MIN_TREFFER = 2              # mindestens so viele gemeinsame Inhaltswörter
PRAEFIX = 5                  # Wortformen gelten gleich, wenn sie so viele Anfangszeichen teilen
NICHT_IM_VAULT = "Nicht im Vault belegt."
GESPERRT = ("secrets/",)
GESPERRT_DATEIEN = {"IDENTITY.md"}

DEFAULT_MOTOR = os.environ.get("BRAIN_FRAGE_MOTOR", "peer")
# Varianten (b7-frage, gemessen auf Satz v3; Vorgaben siehe eval/frage/BEFUNDE.md):
# WAHL = Abschnittswahl wort | rerank (Cross-Encoder-Dienst) | einbettung (embeddinggemma),
# FENSTER = Belegfenster in Nachbarzeilen oder "absatz", MARKER = Gueltigkeit in den Auszuegen.
WAHL = os.environ.get("BRAIN_FRAGE_WAHL", "wort")
FENSTER = os.environ.get("BRAIN_FRAGE_FENSTER", "absatz")   # der Nutzer 29.09.: Kandidat aus b7-frage ist Vorgabe
_R = os.environ.get("BRAIN_FRAGE_RERANK", "").strip().lower()
RERANK: bool | None = None if not _R else _R not in {"0", "aus", "false", "no", "nein", "off"}
# Frist fürs Umsortieren: länger als bei `brain search` (1 s), weil der Motor ohnehin Sekunden
# braucht und der Dienst nach Leerlauf erst lädt (3,3 s); gemessen 29.09.: mit 1 s bei 4 parallelen
# Fragen 8 von 15 Mal „zeit".
RERANK_FRIST_S = float(os.environ.get("BRAIN_FRAGE_RERANK_FRIST_MS", "6000")) / 1000
RERANK_STANDARD = True       # der Nutzer 29.09.: umsortieren wie `brain search` (Test R +0,057 ungesichert, R+T gesichert)
MARKER = os.environ.get("BRAIN_FRAGE_MARKER", "0").strip().lower() not in {"0", "", "aus", "false", "no"}
PEER_MODELL = os.environ.get("BRAIN_FRAGE_MODELL", "gemma4:12b")
# Fest auf das gemessene Modell: der Alias "haiku" zeigte am 09.10. (gemessen) auf claude-haiku-5-5 (langsamer, ungemessen).
CLAUDE_MODELL = os.environ.get("BRAIN_FRAGE_CLAUDE_MODELL", "claude-haiku-4-5")

ZITAT_RE = re.compile(r"^\s*\[?\s*(?P<pfad>[^\s\[\]]+?\.md):(?P<zeile>\d+)(?:-\d+)?\s*\]?\s*$")
RELATIONS_RE = re.compile(r"^#{1,6}\s*Relations\s*$", re.I)
LINKZEILE_RE = re.compile(r"^\s*[-*]\s*(?:[a-z-]+\s+)?\[\[[^\]]+\]\]\s*$")
PAAR_RE = re.compile(r'"text"\s*:\s*"(.*?)"\s*,\s*"zitat"\s*:\s*"([^"]*)"', re.S)
ZAHL_RE = re.compile(r"\d+(?:[.,]\d+)*")
_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "ae", "Ö": "oe", "Ü": "ue"})


# --------------------------------------------------------------------------
# Wörter

def _norm(text: str) -> str:
    return text.translate(_UMLAUTE).lower()


def inhaltswoerter(text: str) -> list[str]:
    """Wörter mit Bedeutung: ohne Stoppwörter, ohne ein- und zweistellige Reste."""
    return [w for w in search_mod.tokenize(_norm(text))
            if w not in search_mod.STOPWORDS and (len(w) > 2 or w.isdigit())]


def _gleich(a: str, b: str) -> bool:
    """Gleich oder dieselbe Wortform mit anderer Endung (Präfix ≥ PRAEFIX, höchstens
    drei Endzeichen Unterschied beim kürzeren Wort): „synchronisiert" ~ „synchronisieren"."""
    if a == b:
        return True
    if a.isdigit() or b.isdigit():
        return False
    gemeinsam = len(os.path.commonprefix([a, b]))
    return gemeinsam >= PRAEFIX and gemeinsam >= min(len(a), len(b)) - 3


def _zahlen(text: str) -> set[str]:
    return {z.replace(",", ".") for z in ZAHL_RE.findall(text)}


# --------------------------------------------------------------------------
# Abschnitte

@dataclass
class Abschnitt:
    rel: str
    titel: str
    zeilen: list[tuple[int, str]]      # (Zeilennummer ab 1, Text)
    wert: float = 0.0
    rang: int = 99           # Rang des Suchtreffers; der beste Block der ersten Treffer ist gesetzt
    marke: str = ""          # Gueltigkeit der Notiz, z. B. „abgelöst durch x.md" (nur mit MARKER)

    def darstellung(self) -> str:
        kopf = f"## {self.rel}" + (f" ({self.titel})" if self.titel else "")
        if self.marke:
            kopf += f" [{self.marke}]"
        return "\n".join([kopf, *(f"{self.rel}:{n} | {t[:ZEILE_ZEICHEN]}" for n, t in self.zeilen)])


def _bloecke(lines: list[str]) -> list[list[tuple[int, str]]]:
    """Absätze des Rumpfs (ohne Frontmatter) als Zeilenlisten; eine Überschrift
    beginnt einen neuen Block und bleibt dessen erste Zeile."""
    start = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start = i + 1
                break
    bloecke: list[list[tuple[int, str]]] = []
    aktuell: list[tuple[int, str]] = []
    for i in range(start, len(lines)):
        s = lines[i].rstrip()
        if RELATIONS_RE.match(s):
            break  # maschinelle Linkliste am Ende: trägt keine Aussage
        if LINKZEILE_RE.match(s):
            continue
        if not s.strip():
            if aktuell and not (len(aktuell) == 1 and aktuell[0][1].lstrip().startswith("#")):
                bloecke.append(aktuell)
                aktuell = []
            continue
        if s.lstrip().startswith("#") and aktuell:
            bloecke.append(aktuell)
            aktuell = []
        aktuell.append((i + 1, s))
    if aktuell:
        bloecke.append(aktuell)
    return bloecke


def _deckung(frage_w: set[str], text: str) -> int:
    woerter = set(inhaltswoerter(text))
    return sum(1 for f in frage_w if any(_gleich(f, w) for w in woerter))


def _zuschneiden(block: list[tuple[int, str]], frage_w: set[str]) -> list[tuple[int, str]]:
    if len(block) <= ABSCHNITT_ZEILEN:
        return block
    beste = max(range(len(block)), key=lambda i: _deckung(frage_w, block[i][1]))
    anfang = max(0, min(beste - ABSCHNITT_ZEILEN // 3, len(block) - ABSCHNITT_ZEILEN))
    return block[anfang:anfang + ABSCHNITT_ZEILEN]


def erlaubt(rel: str) -> bool:
    p = Path(rel)
    return (not p.is_absolute() and ".." not in p.parts
            and not any(rel.startswith(g) or f"/{g}" in rel for g in GESPERRT)
            and p.name not in GESPERRT_DATEIEN)


def marke(hit) -> str:
    """Gültigkeit eines Suchtreffers in Worten (Frontmatter `status`/`superseded-by`,
    offener Widerspruch, abgeleitete Seite); leer, wenn nichts dagegen spricht."""
    teile = []
    nach = list(getattr(hit, "superseded_by_rel", None) or getattr(hit, "superseded_by", None) or [])
    status = getattr(hit, "status", "") or ""
    if nach:
        teile.append("abgelöst durch " + ", ".join(str(n) for n in nach[:2]))
    elif status:
        teile.append({"superseded": "abgelöst", "archived": "archiviert",
                      "expired": "abgelaufen"}.get(status, status))
    if getattr(hit, "contradiction", False):
        teile.append("offener Widerspruch")
    if getattr(hit, "derived", False):
        teile.append("abgeleitete Seite, Quelle prüfen")
    return "; ".join(teile)


Bewerter = Callable[[str, list[str]], "list[float] | None"]


def abschnitte(vault: Path, hits: list, frage: str, *, max_abschnitte: int = MAX_ABSCHNITTE,
               je_notiz: int = 2, bewerter: Bewerter | None = None,
               marker: bool = False) -> list[Abschnitt]:
    """Beste Abschnitte der Treffer: je Notiz höchstens `je_notiz`, gewertet nach
    Wortüberlappung mit der Frage plus einem kleinen Rangbonus der Suche; im
    Zweifel der erste Rumpfblock der Notiz (ihr „Für künftige Sessions"-Satz).
    Mit `bewerter` (Frage, Blocktexte) -> Werte zählt dessen Wert statt der
    Wortüberlappung (Cross-Encoder oder Einbettung); liefert er nichts, gilt
    wieder die Wortüberlappung."""
    if bewerter is not None:
        gewertet = _abschnitte_bewertet(vault, hits, frage, bewerter, je_notiz, marker)
        if gewertet is not None:
            return _auswahl(gewertet, max_abschnitte)
    frage_w = set(inhaltswoerter(frage))
    kandidaten: list[Abschnitt] = []
    for rang, hit in enumerate(hits):
        if not erlaubt(hit.rel):
            continue
        try:
            text = (vault / hit.rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        bloecke = _bloecke(text.splitlines())
        if not bloecke:
            continue
        bonus = 1.0 / (rang + 2)
        gewertet = []
        for j, block in enumerate(bloecke):
            teil = _zuschneiden(block, frage_w)
            d = _deckung(frage_w, " ".join(t for _, t in teil))
            gewertet.append((d + bonus + (0.3 if j == 0 else 0.0), teil))
        gewertet.sort(key=lambda x: -x[0])
        for j, (wert, teil) in enumerate(gewertet[:je_notiz]):
            if wert < 1.0 and j:
                continue  # zweiter Block ohne jedes gemeinsame Wort bringt nichts
            kandidaten.append(Abschnitt(hit.rel, hit.title, teil, wert, rang if j == 0 else 99,
                                        marke(hit) if marker else ""))
    return _auswahl(kandidaten, max_abschnitte)


BLOECKE_JE_NOTIZ = 40        # mehr Blöcke je Notiz bewertet der Bewerter nicht (Sammelnotizen)


def _abschnitte_bewertet(vault: Path, hits: list, frage: str, bewerter: Bewerter,
                         je_notiz: int, marker: bool) -> list[Abschnitt] | None:
    frage_w = set(inhaltswoerter(frage))
    roh: list[tuple[int, Any, list[tuple[int, str]]]] = []
    for rang, hit in enumerate(hits):
        if not erlaubt(hit.rel):
            continue
        try:
            text = (vault / hit.rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for block in _bloecke(text.splitlines())[:BLOECKE_JE_NOTIZ]:
            roh.append((rang, hit, _zuschneiden(block, frage_w)))
    if not roh:
        return []
    texte = [f"{hit.title or Path(hit.rel).stem}: " + " ".join(t for _, t in teil)[:1500]
             for _, hit, teil in roh]
    try:
        werte = bewerter(frage, texte)
    except Exception:
        werte = None
    if not werte or len(werte) != len(roh):
        return None
    je: dict[str, list[tuple[float, int, Any, list]]] = {}
    for (rang, hit, teil), w in zip(roh, werte):
        je.setdefault(hit.rel, []).append((float(w), rang, hit, teil))
    kandidaten: list[Abschnitt] = []
    for liste in je.values():
        liste.sort(key=lambda x: -x[0])
        for j, (w, rang, hit, teil) in enumerate(liste[:je_notiz]):
            kandidaten.append(Abschnitt(hit.rel, hit.title, teil, w, rang if j == 0 else 99,
                                        marke(hit) if marker else ""))
    return kandidaten


def _auswahl(kandidaten: list[Abschnitt], max_abschnitte: int) -> list[Abschnitt]:
    # Die Suche hat schon gerankt: der beste Block der ersten GESETZT Treffer kommt
    # immer mit (sonst verdrängt Wortüberlappung den semantisch besten Treffer,
    # Messfall ot47), danach der Rest nach Wert.
    gesetzte = sorted({a.rang for a in kandidaten if a.rang < 99})[:GESETZT]
    kandidaten.sort(key=lambda a: (a.rang not in gesetzte, a.rang if a.rang in gesetzte else 0, -a.wert))
    gewaehlt: list[Abschnitt] = []
    zeichen = 0
    for a in kandidaten:
        laenge = len(a.darstellung())
        if len(gewaehlt) >= max_abschnitte or (gewaehlt and zeichen + laenge > AUSZUG_ZEICHEN):
            continue
        gewaehlt.append(a)
        zeichen += laenge
    # in Dateireihenfolge je Notiz: liest sich für das Modell natürlicher
    gewaehlt.sort(key=lambda a: (a.rel, a.zeilen[0][0]))
    return gewaehlt


def rerank_bewerter(budget_s: float = 8.0) -> Bewerter:
    """Blöcke mit dem Cross-Encoder des Umsortier-Dienstes werten (derselbe Dienst
    wie `brain search`, BGE v2-m3 auf peer)."""
    from . import rerank

    def werte(frage: str, texte: list[str]) -> list[float] | None:
        return rerank.scores(rerank.cli_url(), frage, texte, budget_s)
    return werte


def einbettung_bewerter() -> Bewerter:
    """Blöcke per Kosinus zur Frage werten (embeddinggemma über das lokale Ollama,
    wie die semantische Seite der Suche)."""
    from gardener.ollama import OllamaClient
    from . import einbettung
    client = OllamaClient()

    def werte(frage: str, texte: list[str]) -> list[float]:
        q = einbettung.normiert(client.embed(frage))
        return [sum(a * b for a, b in zip(q, einbettung.normiert(client.embed(t)))) for t in texte]
    return werte


def bewerter_fuer(wahl: str) -> Bewerter | None:
    if wahl == "rerank":
        return rerank_bewerter()
    if wahl == "einbettung":
        return einbettung_bewerter()
    if wahl in ("", "wort"):
        return None
    raise ValueError(f"unbekannte Abschnittswahl {wahl!r} (wort | rerank | einbettung)")


# --------------------------------------------------------------------------
# Motoren

SYSTEM = f"""Du beantwortest eine Frage ausschließlich aus Auszügen eines Wissensspeichers.
Jede Auszugszeile beginnt mit ihrer Kennung `pfad:zeile |`.
Regeln:
- Höchstens {MAX_SAETZE} kurze Sätze auf Deutsch, jeder Satz genau eine Aussage.
- Der erste Satz beantwortet die Frage direkt: bei „Wie" das Vorgehen, bei „Warum" den Grund,
  bei Ja/Nein-Fragen „Ja" oder „Nein" mit der Regel. Sätze, die nur das Problem der Frage wiederholen, weglassen.
- Jeder Satz ist allein verständlich: er nennt, worum es geht (Werkzeug, Projekt, Regel).
- Aktuelle Regeln (KERN, Entscheidungen) gehen älteren Sitzungsnotizen vor.
- Jeder Satz bekommt genau ein Zitat: die Kennung der Zeile, die die Aussage trägt, exakt wie vor dem `|`.
- Nutze die Wörter und Zahlen der zitierten Zeile; nichts hinzufügen, was dort nicht steht.
- Steht die Antwort nicht in den Auszügen, gib eine leere Liste zurück. Nicht raten.
Antworte nur mit JSON: {{"saetze": [{{"text": "...", "zitat": "pfad:zeile"}}]}}"""

SYSTEM_MARKER = """
- Eine Auszugsüberschrift mit [abgelöst …], [archiviert] oder [abgelaufen] ist überholt: nicht als
  geltende Antwort nennen, wenn ein anderer Auszug die geltende Regel trägt. [offener Widerspruch]
  heißt: die Notiz ist umstritten, bevorzuge andere Belege."""


def system_prompt(marker: bool = False) -> str:
    if not marker:
        return SYSTEM
    kopf, schluss = SYSTEM.rsplit("\nAntworte nur mit JSON", 1)
    return kopf + SYSTEM_MARKER + "\nAntworte nur mit JSON" + schluss

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"saetze": {"type": "array", "maxItems": MAX_SAETZE, "items": {
        "type": "object",
        "properties": {"text": {"type": "string"}, "zitat": {"type": "string"}},
        "required": ["text", "zitat"]}}},
    "required": ["saetze"],
}


def nutzer_prompt(frage: str, teile: list[Abschnitt]) -> str:
    return "Frage: " + frage.strip() + "\n\nAuszüge:\n\n" + "\n\n".join(a.darstellung() for a in teile)


class Motor(Protocol):
    name: str

    def __call__(self, system: str, nutzer: str, schema: dict[str, Any]) -> tuple[str, dict]: ...


class PeerMotor:
    """gemma4:12b (oder `modell`) auf peer über `gardener.engines`: derselbe
    Endpunkt `peer-ollama` aus engines.yaml, derselbe SSH-Tunnel. Als
    Kontextmanager benutzen; der Tunnel endet mit dem Block."""

    def __init__(self, modell: str = PEER_MODELL, endpunkt: str = "peer-ollama",
                 timeout: float = 180.0, keep_alive: str | None = None,
                 num_gpu: int | None = None):
        # keep_alive/num_gpu: gemma4:12b passt neben Chromium nicht ganz auf die 12-GB-Karte;
        # Ollama nimmt dann allen freien Grafikspeicher, und der Umsortier-Dienst endet mit
        # „vram" (gemessen 29.09.). num_gpu begrenzt die Schichten auf der Karte.
        keep_alive = keep_alive or os.environ.get("BRAIN_FRAGE_KEEP_ALIVE", "5m")
        if num_gpu is None:
            wert = os.environ.get("BRAIN_FRAGE_NUM_GPU", "24").strip()   # 0/leer = Ollama entscheidet
            num_gpu = int(wert) if wert not in {"", "0"} else None
        self.num_gpu = num_gpu
        from gardener import engines
        self._engines = engines
        self.modell = modell
        self.timeout = timeout
        self.registry = engines.EngineRegistry.from_file()
        roh = next((e for e in self.registry.endpoints if e.name == endpunkt), None)
        if roh is None:
            raise engines.EngineError(f"Motor {endpunkt!r} fehlt in engines.yaml")
        self.endpoint = replace(roh, model=modell,
                                capabilities={**roh.capabilities, "keep_alive": keep_alive})
        self.registry.endpoints = [self.endpoint]
        self.name = f"{endpunkt}/{modell}"

    def __enter__(self) -> "PeerMotor":
        self.registry.__enter__()
        if not self.registry.reachable(self.endpoint):
            self.registry.close()
            raise self._engines.EngineUnavailable(f"{self.name} nicht erreichbar")
        return self

    def __exit__(self, *exc: object) -> None:
        self.registry.close()

    def __call__(self, system: str, nutzer: str, schema: dict[str, Any]) -> tuple[str, dict]:
        antwort = self._engines.generate(
            self.endpoint, [{"role": "system", "content": system}, {"role": "user", "content": nutzer}],
            json_schema=schema, max_tokens=700, timeout=self.timeout,
            options={"temperature": 0, "num_ctx": 8192,
                     **({"num_gpu": self.num_gpu} if self.num_gpu is not None else {})})
        text = (antwort.get("message") or {}).get("content", "")
        return text, {"eingabe": antwort.get("prompt_eval_count"), "ausgabe": antwort.get("eval_count")}


class ClaudeMotor:
    """`claude -p` über das Abo in der mageren Form (rund 200 statt 60 000 Token
    Grundlast, `10-global/claude-p-ueber-abo.md`). API-Schlüssel werden aus der
    Umgebung entfernt, damit wirklich das Abo zahlt (wie `abo_bruecke`)."""

    def __init__(self, modell: str = CLAUDE_MODELL, timeout: float = 120.0):
        self.modell = modell
        self.timeout = timeout
        self.name = f"claude-p/{modell}"

    def __enter__(self) -> "ClaudeMotor":
        return self

    def __exit__(self, *exc: object) -> None:
        pass

    def __call__(self, system: str, nutzer: str, schema: dict[str, Any]) -> tuple[str, dict]:
        cmd = ["claude", "-p", nutzer, "--output-format", "json", "--model", self.modell,
               "--system-prompt", system, "--tools", "", "--strict-mcp-config",
               "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
               "--setting-sources", "", "--no-session-persistence", "--effort", "low"]
        env = {k: v for k, v in os.environ.items()
               if k not in {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}}
        # Ohne das denkt haiku trotz --effort low 8-14k Token lang (75-120 s je
        # Frage, gemessen 28.09.); ohne Denken 5,5 s und rund 300 Token.
        env["MAX_THINKING_TOKENS"] = "0"
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout, env=env,
                              cwd=llm_sort.leerer_ordner())
        if proc.returncode != 0:
            raise RuntimeError(f"claude -p exit {proc.returncode}: {proc.stderr[-300:]}")
        umschlag = json.loads(proc.stdout)
        u = umschlag.get("usage") or {}
        return umschlag.get("result", ""), {
            "eingabe": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
            + (u.get("cache_creation_input_tokens") or 0),
            "ausgabe": u.get("output_tokens")}


def motor_fuer(name: str, modell: str | None = None):
    if name == "peer":
        return PeerMotor(modell or PEER_MODELL)
    if name == "claude":
        return ClaudeMotor(modell or CLAUDE_MODELL)
    raise ValueError(f"unbekannter Motor {name!r} (peer | claude)")


# --------------------------------------------------------------------------
# Prüfung

@dataclass
class Satz:
    text: str
    zitat: str
    gueltig: bool = False
    grund: str = ""          # leer, wenn gültig; sonst warum entfernt
    deckung: float = 0.0


def _json_aus(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    # Ohne Schemazwang (claude -p) bricht deutsches „…" mit ASCII-Schlusszeichen
    # das JSON (gemessen 28.09.: 9 von 60 Antworten leer). Paare einzeln lesen;
    # ein Zitat enthält nie ein Anführungszeichen.
    paare = PAAR_RE.findall(text)
    return {"saetze": [{"text": t.replace('\\"', '"'), "zitat": z} for t, z in paare]} if paare else {}


def _fenster(zeilen: list[str], zeile: int, fenster: int | str) -> str:
    """Belegfenster: zitierte Zeile ± `fenster` Zeilen, oder mit „absatz" der ganze
    Block (Absatz samt Überschrift, wie `_bloecke`), in dem die Zeile steht."""
    if fenster == "absatz":
        for block in _bloecke(zeilen):
            if block[0][0] <= zeile <= block[-1][0]:
                return " ".join(t for _, t in block)
        fenster = NACHBARN
    n = int(fenster)
    return " ".join(zeilen[max(0, zeile - 1 - n):zeile + n])


def pruefe(vault: Path, satz: Satz, *, cache: dict[str, list[str] | None] | None = None,
           fenster: int | str = NACHBARN) -> Satz:
    """Setzt `gueltig`/`grund`/`deckung`. Gründe: `zitatform`, `gesperrt`,
    `datei_fehlt`, `zeile_fehlt` (= erfundenes Zitat), `traegt_nicht`, `zahl_fehlt`."""
    cache = {} if cache is None else cache
    # manche Modelle kopieren die ganze Auszugszeile „pfad:zeile | Text" als Zitat
    m = ZITAT_RE.match((satz.zitat or "").split("|", 1)[0])
    if not m:
        satz.grund = "zitatform"
        return satz
    rel, zeile = m.group("pfad"), int(m.group("zeile"))
    satz.zitat = f"{rel}:{zeile}"
    if not erlaubt(rel):
        satz.grund = "gesperrt"
        return satz
    if rel not in cache:
        pfad = (vault / rel)
        try:
            ok = pfad.resolve().is_relative_to(vault.resolve()) and pfad.is_file()
            cache[rel] = pfad.read_text(encoding="utf-8").splitlines() if ok else None
        except (OSError, UnicodeDecodeError):
            cache[rel] = None
    zeilen = cache[rel]
    if zeilen is None:
        satz.grund = "datei_fehlt"
        return satz
    if not 1 <= zeile <= len(zeilen) or not zeilen[zeile - 1].strip():
        satz.grund = "zeile_fehlt"
        return satz
    fenster = _fenster(zeilen, zeile, fenster)
    satz_w = set(inhaltswoerter(satz.text))
    fenster_w = set(inhaltswoerter(fenster))
    treffer = sum(1 for w in satz_w if any(_gleich(w, f) for f in fenster_w))
    satz.deckung = round(treffer / len(satz_w), 3) if satz_w else 0.0
    if treffer < min(MIN_TREFFER, len(satz_w)) or satz.deckung < MIN_DECKUNG:
        satz.grund = "traegt_nicht"
        return satz
    fehlend = _zahlen(satz.text) - _zahlen(fenster)
    if fehlend:
        satz.grund = "zahl_fehlt"
        return satz
    satz.gueltig = True
    return satz


ERFUNDEN = {"zitatform", "datei_fehlt", "zeile_fehlt"}


# --------------------------------------------------------------------------
# Ablauf

@dataclass
class Antwort:
    frage: str
    saetze: list[Satz]
    entfernt: list[Satz]
    quellen: list[str]
    motor: str
    fallback: bool = False
    dauer_s: dict[str, float] = field(default_factory=dict)
    token: dict[str, Any] = field(default_factory=dict)
    fehler: str = ""
    roh: str = ""            # Motorausgabe vor der Prüfung (nur für Messungen, nicht im JSON)
    auszuege: list = field(default_factory=list)  # (pfad, erste, letzte Zeile) je Auszug, für Messungen
    umsortiert: dict | None = None   # nur mit Umsortieren: {"an": bool, "grund": ...}

    @property
    def belegt(self) -> bool:
        return bool(self.saetze)

    def text(self) -> str:
        if not self.saetze:
            zeilen = [NICHT_IM_VAULT]
            if self.fehler:
                zeilen.append(f"(Motor: {self.fehler})")
            if self.quellen:
                zeilen.append("Nächste Treffer: " + ", ".join(self.quellen[:3]))
            return "\n".join(zeilen)
        return "\n".join(f"{s.text.strip()} [{s.zitat}]" for s in self.saetze)

    def als_json(self) -> dict:
        return {"frage": self.frage, "antwort": self.text(), "belegt": self.belegt,
                "saetze": [{"text": s.text, "zitat": s.zitat} for s in self.saetze],
                "entfernt": [{"text": s.text, "zitat": s.zitat, "grund": s.grund} for s in self.entfernt],
                "quellen": self.quellen, "motor": self.motor, "fallback": self.fallback,
                "dauer_s": self.dauer_s, "token": self.token,
                **({"umsortiert": self.umsortiert} if self.umsortiert is not None else {}),
                **({"fehler": self.fehler} if self.fehler else {})}


def antworte(vault: Path, frage: str, motor: Callable[..., tuple[str, dict]], *,
             k: int = SUCH_K, space: str | None = None,
             max_abschnitte: int = MAX_ABSCHNITTE,
             suche: Callable[..., tuple[list, bool]] | None = None,
             bewerter: Bewerter | None = None, fenster: int | str = NACHBARN,
             marker: bool = False) -> Antwort:
    suche = suche or search_mod.search
    t0 = time.monotonic()
    _UMSORTIEREN.info = None
    hits, fallback = suche(vault, frage, k, None, space)
    umsortiert = getattr(_UMSORTIEREN, "info", None)
    hits = [h for h in hits if erlaubt(h.rel)]
    t1 = time.monotonic()
    teile = abschnitte(vault, hits, frage, max_abschnitte=max_abschnitte, bewerter=bewerter,
                       marker=marker)
    t_auszug = round(time.monotonic() - t1, 3)
    t1 = time.monotonic()
    name = getattr(motor, "name", "motor")
    antwort = Antwort(frage, [], [], [h.rel for h in hits], name, fallback)
    if umsortiert is not None:
        antwort.umsortiert = {"an": bool(umsortiert.get("umsortiert")),
                              **({"grund": umsortiert["grund"]} if umsortiert.get("grund") else {})}
    if not teile:
        antwort.dauer_s = {"suche": round(t1 - t0, 3), "motor": 0.0}
        return antwort
    antwort.auszuege = [(a.rel, a.zeilen[0][0], a.zeilen[-1][0]) for a in teile]
    nutzer = nutzer_prompt(frage, teile)
    system = system_prompt(marker)
    try:
        roh, nutzung = motor(system, nutzer, SCHEMA)
    except Exception as exc:  # Motor aus: ehrlich „nicht belegt" statt Absturz
        antwort.fehler = f"{type(exc).__name__}: {str(exc)[:200]}"
        antwort.dauer_s = {"suche": round(t1 - t0, 3), "motor": round(time.monotonic() - t1, 3)}
        return antwort
    t2 = time.monotonic()
    daten = _json_aus(roh)
    cache: dict[str, list[str] | None] = {}
    roh_saetze = daten.get("saetze") if isinstance(daten, dict) else None
    for eintrag in (roh_saetze if isinstance(roh_saetze, list) else [])[:MAX_SAETZE]:
        if not isinstance(eintrag, dict):
            continue
        s = pruefe(vault, Satz(str(eintrag.get("text", "")), str(eintrag.get("zitat", ""))), cache=cache,
                   fenster=fenster)
        (antwort.saetze if s.gueltig else antwort.entfernt).append(s)
    antwort.dauer_s = {"suche": round(t1 - t0 - t_auszug, 3), "auszug": t_auszug,
                       "motor": round(t2 - t1, 3)}
    antwort.token = {"prompt_zeichen": len(system) + len(nutzer), **nutzung}
    antwort.roh = roh
    return antwort


_UMSORTIEREN = threading.local()   # Zustand des letzten Umsortierens in diesem Thread


def umsortierte_suche(vault: Path, frage: str, k: int, validity, space) -> tuple[list, bool]:
    """`search.search` auf die Top 20, dann vom Umsortier-Dienst umsortiert und auf
    k gekuerzt; bei Stoerung die Reihenfolge des Rangkerns (braincli.rerank).
    Der Dienst lehnt mit „vram" ab, wenn auf peer zu wenig Grafikspeicher frei ist
    (etwa solange gemma4:12b geladen ist); der Grund steht dann in der Antwort."""
    from . import rerank
    hits, fallback = search_mod.search(vault, frage, max(k, rerank.TOP_N), validity, space)
    info: dict = {}
    _UMSORTIEREN.info = info
    hits = rerank.umsortieren(frage, hits, rerank.vault_passage(vault), url=rerank.cli_url(),
                              budget_s=max(rerank.cli_budget_s(), RERANK_FRIST_S), info=info)
    # wie `brain search`: Standseiten nach dem Umsortieren wieder vorn (BRAIN_SEARCH_STAND)
    from . import rangkern
    hits = rangkern.apply_stand_rang(hits, frage, top_n=rerank.TOP_N)
    return hits[:k], fallback


def ausfuehren(vault: Path, frage_text: str, *, motor: str = DEFAULT_MOTOR, modell: str | None = None,
               k: int = SUCH_K, space: str | None = None, rerank: bool | None = None,
               wahl: str | None = None, fenster: int | str | None = None,
               marker: bool | None = None) -> Antwort:
    """Ein ganzer Aufruf samt Motor-Lebenszyklus (Tunnel zu, auch bei Fehlern).
    Ist der Motor nicht erreichbar, kommt „nicht belegt" mit den Suchtreffern.
    `None` heißt jeweils: Vorgabe (Umsortieren wie `brain search`, sonst Umgebung)."""
    if rerank is None:
        rerank = RERANK if RERANK is not None else RERANK_STANDARD
    opts = {"suche": umsortierte_suche if rerank else None,
            "bewerter": bewerter_fuer(WAHL if wahl is None else wahl),
            "fenster": fenster_von(FENSTER if fenster is None else fenster),
            "marker": MARKER if marker is None else marker}
    try:
        with motor_fuer(motor, modell) as m:
            return antworte(vault, frage_text, m, k=k, space=space, **opts)
    except Exception as exc:
        return antworte(vault, frage_text, _Aus(f"{motor}: {exc}"), k=k, space=space, **opts)


def fenster_von(wert: int | str) -> int | str:
    s = str(wert).strip().lower()
    return "absatz" if s == "absatz" else int(s)


def argumente(ap: argparse.ArgumentParser) -> argparse.ArgumentParser:
    """Dieselben Schalter für `python -m braincli.frage` und `brain frage`."""
    ap.add_argument("frage")
    ap.add_argument("--motor", default=DEFAULT_MOTOR, choices=["peer", "claude"],
                    help="peer = gemma4:12b über SSH-Tunnel (Standard), claude = claude -p über das Abo")
    ap.add_argument("--modell", default=None)
    ap.add_argument("-k", type=int, default=SUCH_K, help="Suchtreffer als Grundlage")
    ap.add_argument("--space", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--rerank", action="store_true", default=None,
                    help="Suchtreffer vom Umsortier-Dienst umsortieren (Vorgabe wie brain search)")
    ap.add_argument("--no-rerank", dest="rerank", action="store_false",
                    help="Reihenfolge des Rangkerns ohne Umsortieren")
    return ap


def cmd_frage(args) -> int:
    antwort = ausfuehren(Path(args.vault).expanduser(), args.frage, motor=args.motor,
                         modell=args.modell, k=args.k, space=args.space,
                         rerank=getattr(args, "rerank", None))
    print(json.dumps(antwort.als_json(), ensure_ascii=False) if args.json else antwort.text())
    return 0 if antwort.belegt else 1


def main(argv: list[str] | None = None) -> int:
    ap = argumente(argparse.ArgumentParser(
        prog="brain frage", description="Kurze Antwort aus dem Vault, jeder Satz mit pfad:zeile."))
    ap.add_argument("--vault", default=os.environ.get("BRAIN_VAULT", str(Path.home() / "Knowledge")))
    args = ap.parse_args(argv)
    from gardener import config
    config.bind_vault(Path(args.vault).expanduser())
    return cmd_frage(args)


class _Aus:
    def __init__(self, grund: str):
        self.name = "aus"
        self.grund = grund

    def __call__(self, *_a: Any) -> tuple[str, dict]:
        raise RuntimeError(self.grund)


if __name__ == "__main__":
    sys.exit(main())
