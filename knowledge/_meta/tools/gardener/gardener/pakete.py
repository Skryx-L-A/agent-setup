"""Typed package extraction per event window (Brain 5, B2).

The model receives the window as numbered sentences and returns packages
under a JSON schema whose ``belege`` items are an enum of the window's
sentence IDs.  Code then applies the gates:

1. every package names at least one evidence ID and every ID exists in the
   window (the schema should already guarantee it; the gate does not trust
   the engine to enforce the schema);
2. every identifier in ``aussage`` and ``gegenmittel`` -- path, file name,
   command or flag, number, hash, code identifier -- occurs in the cited
   sentences.  A package that introduces an identifier its evidence does not
   contain is dropped with a reason, never repaired.

``datum`` and ``projekt`` come from the unit's metadata (deterministic routing,
BRAIN5-PIPELINE Leitentscheidung 6), not from the model.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import os
import re
import time
from typing import Any, Callable

from .saetze import Satz, darstellung, nach_id, zitat

TYPEN = ("entscheidung", "fehler", "lehre", "fakt", "offen")
MAX_PAKETE = 6
MAX_PAKETE_B = 4


def prompt_version(version: str | None = None) -> str:
    """Active extraction prompt: ``a`` (default) or ``b`` via BRAIN_EXTRAKTION_PROMPT=b."""
    raw = version if version is not None else os.environ.get("BRAIN_EXTRAKTION_PROMPT", "")
    return "b" if str(raw).strip().lower() == "b" else "a"

SYSTEM_PROMPT = """Du extrahierst dauerhaftes Wissen aus einem Ausschnitt einer Arbeitssitzung,
eines Worker-Ergebnisses oder einer Projektdoku. Jeder Satz trägt eine ID wie [S12].

Gib nur Pakete aus, die in künftigen Sitzungen nützen:
- entscheidung: eine getroffene, geltende Festlegung (was gilt, und warum, falls genannt)
- fehler: etwas ging schief oder war falsch; gegenmittel = wie man es vermeidet oder behebt
- lehre: eine verallgemeinerbare Regel aus Erfahrung; gegenmittel = was man künftig tut
- fakt: eine belastbare, nicht offensichtliche Tatsache über System, Werkzeug, Maschine oder Projekt
- offen: eine ausdrücklich offene Frage oder ein ungeklärter Punkt, der später wichtig ist

Nicht extrahieren: Smalltalk, Fortschrittsmeldungen ("ich lese jetzt ..."), Pläne ohne Ergebnis,
Einmaliges ohne Wirkung über diese Sitzung hinaus, Inhalte aus Werkzeugausgaben ohne Einordnung.

Regeln:
- aussage: höchstens 2 Sätze, auf Deutsch, ohne den Ausschnitt verständlich (nenne das Subjekt
  ausdrücklich, keine Wörter wie "dies", "hier", "oben").
- Jeder Pfad, Dateiname, Befehl, jede Zahl, jeder Hash und Code-Bezeichner in aussage oder
  gegenmittel muss wörtlich in den belegten Sätzen stehen. Nichts hinzuerfinden.
- belege: die IDs der Sätze, die die Aussage tragen (mindestens eine).
- ausloeser: was man gerade tat, als es relevant wurde (Dateimuster, Befehl, Handlung), sonst "".
- gegenmittel nur bei fehler und lehre, sonst "".
- Enthält der Ausschnitt nichts Dauerhaftes, gib {"pakete": []} aus. Wenige gute Pakete sind
  besser als viele schwache."""

# b (d2, recall-nachgeschärft): die Diät aus V-C, aber fakt/offen bleiben (der Nutzer Nr. 37,
# anpassen statt entfernen): offen nur in Worker-Ergebnissen, fakt nur mit Pflichtfeld
# ``betrifft`` und nie als Ersatzform für entscheidung/fehler/lehre (Dev-Messung: ein
# Drittel der E/F/L-Verluste waren als fakt getippte Lehren); ``dauerhaft`` markiert nur
# (Warnung, kein Filter); maxItems 4; die „meist nichts"-Aussage neutralisiert.
# Hinter BRAIN_EXTRAKTION_PROMPT=b, Standard bleibt A.
SYSTEM_PROMPT_B = """Du extrahierst dauerhaftes Wissen aus einem Ausschnitt einer Arbeitssitzung,
eines Worker-Ergebnisses oder einer Projektdoku. Jeder Satz trägt eine ID wie [S12]. Höchstens 4 Pakete.

Gib nur Pakete aus, die in künftigen Sitzungen nützen:
- entscheidung: eine Festlegung, die ein Mensch oder der Orchestrator ausdrücklich getroffen hat und
  die über diese Sitzung hinaus gilt. KEINE Empfehlung, kein Vorschlag, keine offene Frage. Eine
  Festlegung aus einem Auftrag ist eine Entscheidung, wenn sie über den Auftrag hinaus gelten soll.
- fehler: etwas ging schief, mit Ursache; gegenmittel = wie man es künftig vermeidet.
- lehre: eine verallgemeinerbare Regel aus einer Erfahrung in diesem Projekt; gegenmittel = was man
  künftig tut.
- fakt: eine belastbare, nicht offensichtliche Tatsache über ein System, ein Werkzeug oder eine
  Maschine, die auch in einem Monat noch gilt — selten, höchstens einen je Ausschnitt, und nur wenn
  keine andere Art passt: Eine Festlegung ist entscheidung, ein Fehlverlauf mit Ursache ist fehler,
  eine Regel für die Zukunft ist lehre; fakt ist keine Ersatzform. Was nur den Moment beschreibt
  (Zwischenstand, Stand einer Datei), ist kein fakt. Im Feld betrifft nenne das System, Werkzeug
  oder die Maschine; ein fakt ohne betrifft wird verworfen.
- offen: eine ausdrücklich offene Frage oder ein ungeklärter Punkt, der später wichtig ist. Nur in
  Worker-Ergebnissen (erkennbar an der Quelle); dort auch bei leichtem Zweifel aufnehmen.

Nie extrahieren (häufige falsche Pakete):
- Zwischenstände, Fortschritt, Pläne, Ergebnisse einer einzelnen Messung ohne Regel daraus.
- Einzelbugs mit Datei:Zeile, die im Ausschnitt schon behoben sind und keine allgemeine Regel ergeben.
- Protokoll-, Worktree- und Auftragsanweisungen ("Ergebnis in Datei X", "Commit ohne Push").
- Meldungen des Harness oder von Werkzeugen (blockierte Befehle, Hook-Fehler), Texte aus Skills.
- Allgemeine Arbeitsregeln, die für jedes Projekt gelten (Snapshot vor Löschen, Tests isolieren,
  einzelne Pfade committen, nicht force-pushen) — sie stehen schon in den Hausregeln.
- Triviales: Umbenennungen, Code-Details, Tippfehler, falscher Pfad bei grep/sed.
- Was sich direkt aus Code oder Git-Historie ablesen lässt.

Felder:
- aussage: höchstens 2 Sätze, Deutsch, ohne den Ausschnitt verständlich (Subjekt nennen).
- Jeder Pfad, Dateiname, Befehl, jede Zahl, jeder Hash und Code-Bezeichner in aussage oder
  gegenmittel muss wörtlich in den belegten Sätzen stehen.
- belege: die IDs der tragenden Sätze.
- dauerhaft: true, wenn die Aussage in einem Monat noch gilt und nützt; sonst false. false verwirft
  das Paket nicht, es wird nur markiert.
- gegenmittel nur bei fehler und lehre, sonst "". betrifft nur bei fakt, sonst "".
- Enthält der Ausschnitt nichts Dauerhaftes, gib {"pakete": []} aus."""


def schema(ids: list[str], version: str | None = None) -> dict[str, Any]:
    if prompt_version(version) == "b":
        return {
            "type": "object",
            "properties": {
                "pakete": {
                    "type": "array", "maxItems": MAX_PAKETE_B,
                    "items": {
                        "type": "object",
                        "properties": {
                            "typ": {"type": "string", "enum": list(TYPEN)},
                            "aussage": {"type": "string"},
                            "gegenmittel": {"type": "string"},
                            "belege": {"type": "array", "minItems": 1,
                                       "items": {"type": "string", "enum": list(ids)}},
                            "dauerhaft": {"type": "boolean"},
                            "betrifft": {"type": "string"},
                        },
                        "required": ["typ", "aussage", "gegenmittel", "belege", "dauerhaft"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["pakete"],
            "additionalProperties": False,
        }
    return {
        "type": "object",
        "properties": {
            "pakete": {
                "type": "array", "maxItems": MAX_PAKETE,
                "items": {
                    "type": "object",
                    "properties": {
                        "typ": {"type": "string", "enum": list(TYPEN)},
                        "aussage": {"type": "string"},
                        "gegenmittel": {"type": "string"},
                        "ausloeser": {"type": "string"},
                        "belege": {"type": "array", "minItems": 1,
                                   "items": {"type": "string", "enum": list(ids)}},
                    },
                    "required": ["typ", "aussage", "gegenmittel", "ausloeser", "belege"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["pakete"],
        "additionalProperties": False,
    }


def nachricht(saetze: list[Satz], *, quelle: str = "", projekt: str | None = None,
              version: str | None = None) -> list[dict[str, str]]:
    head = []
    if quelle:
        head.append(f"Quelle: {quelle}")
    if projekt:
        head.append(f"Projekt: {projekt}")
    body = "\n".join(head + ["Ausschnitt:", darstellung(saetze)])
    system = SYSTEM_PROMPT_B if prompt_version(version) == "b" else SYSTEM_PROMPT
    return [{"role": "system", "content": system}, {"role": "user", "content": body}]


# ---------------------------------------------------------------------------
# Identifier gate
# ---------------------------------------------------------------------------

_BACKTICK_RE = re.compile(r"`([^`\n]{1,200})`")
_PATH_RE = re.compile(r"(?<![\w/~.-])(?:~|\.{1,2})?/?(?:[\w.@+-]+/)+[\w.@+-]*|"
                      r"(?<![\w/-])[\w@+-]+(?:\.[\w-]+)*\.(?:py|md|sh|json|jsonl|yaml|yml|toml|ts|tsx|js|"
                      r"swift|txt|db|log|html|css|rs|go|plist|service|conf|env|lock|ini|cfg|csv|sql|"
                      r"zsh|fish|lua|c|h|cpp|java|kt|rb|php|xml|gguf|safetensors)\b")
_FLAG_RE = re.compile(r"(?<![\w-])--[A-Za-z][\w-]*|(?<=\s)-[A-Za-z]\b")
_HASH_RE = re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b")
_NUMBER_RE = re.compile(r"(?<![\w.])\d+(?:[.,:]\d+)*")
_CODE_ID_RE = re.compile(r"\b[A-Za-z]\w*_\w+\b|\b[a-z]+[A-Z]\w*\b|\b\w+\.\w+\(\)|\b\w+\(\)")


def _norm(text: str) -> str:
    text = text.replace("`", "").replace("„", '"').replace("“", '"').replace("”", '"')
    text = re.sub(r"(?<=\d),(?=\d)", ".", text)
    return " ".join(text.lower().split())


def _norm_number(value: str) -> str:
    return value.replace(",", ".")


def bezeichner(text: str) -> list[str]:
    """Identifiers in ``text`` that must be covered by the evidence."""
    found: list[str] = []
    for match in _BACKTICK_RE.finditer(text):
        found.append(match.group(1).strip())
    stripped = _BACKTICK_RE.sub(" ", text)
    for regex in (_PATH_RE, _FLAG_RE, _HASH_RE, _CODE_ID_RE):
        for match in regex.finditer(stripped):
            token = match.group(0).strip().rstrip(".,;:")
            if len(token) >= 2 or regex is _FLAG_RE:
                found.append(token)
    for match in _NUMBER_RE.finditer(stripped):
        found.append(match.group(0).rstrip(".,:"))
    # stable order, no duplicates, no empty strings
    return [token for token in dict.fromkeys(found) if token]


def fehlende_bezeichner(text: str, beleg: str) -> list[str]:
    haystack = _norm(beleg)
    numbers = {_norm_number(m.group(0).rstrip(".,:")) for m in _NUMBER_RE.finditer(_BACKTICK_RE.sub(r" \1 ", beleg))}
    missing = []
    for token in bezeichner(text):
        if re.fullmatch(r"\d+(?:[.,:]\d+)*", token):
            if _norm_number(token) not in numbers:
                missing.append(token)
        elif _norm(token) not in haystack:
            missing.append(token)
    return missing


# ---------------------------------------------------------------------------
# Packages and gates
# ---------------------------------------------------------------------------

@dataclass
class Paket:
    typ: str
    aussage: str
    belege: list[str]
    gegenmittel: str = ""
    ausloeser: str = ""
    datum: str | None = None
    projekt: str | None = None
    zitat: str = ""
    warnungen: list[str] = field(default_factory=list)

    def als_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Verworfen:
    roh: dict[str, Any]
    grund: str


def pruefe(roh: dict[str, Any], index: dict[str, Satz], *, datum: str | None = None,
           projekt: str | None = None, version: str | None = None,
           quelle: str = "") -> Paket | Verworfen:
    """Apply the evidence and identifier gates to one raw model package.

    Version b (d2) additionally: ``fakt`` needs a non-empty ``betrifft``
    (system/tool/machine), ``offen`` is only kept in worker results (the
    ``quelle`` names the unit), and ``dauerhaft=false`` only warns.
    """
    version = prompt_version(version)
    typ = str(roh.get("typ", "")).strip().lower()
    if typ not in TYPEN:
        return Verworfen(roh, f"typ-ungueltig:{typ}")
    if version == "b":
        if typ == "fakt" and not str(roh.get("betrifft", "") or "").strip():
            return Verworfen(roh, "fakt-ohne-betrifft")
        if typ == "offen" and "worker-result" not in quelle:
            return Verworfen(roh, "offen-nur-worker-ergebnis")
    aussage = str(roh.get("aussage", "")).strip()
    if not aussage:
        return Verworfen(roh, "aussage-leer")
    belege = [str(b).strip() for b in (roh.get("belege") or []) if str(b).strip()]
    if not belege:
        return Verworfen(roh, "beleg-fehlt")
    unknown = [b for b in belege if b not in index]
    if unknown:
        return Verworfen(roh, "beleg-unbekannt:" + ",".join(unknown))
    belege = list(dict.fromkeys(belege))
    beleg_text = "\n".join(index[b].text for b in belege)
    gegenmittel = str(roh.get("gegenmittel", "") or "").strip()
    for feld, wert in (("aussage", aussage), ("gegenmittel", gegenmittel)):
        missing = fehlende_bezeichner(wert, beleg_text)
        if missing:
            return Verworfen(roh, f"bezeichner-unbelegt:{feld}:" + "|".join(missing[:5]))
    warnungen = []
    if version == "b" and roh.get("dauerhaft") is False:
        warnungen.append("nicht-dauerhaft")
    if len(re.findall(r"[.!?](?:\s|$)", aussage)) > 2:
        warnungen.append("aussage-mehr-als-2-saetze")
    if typ in ("fehler", "lehre") and not gegenmittel:
        warnungen.append("gegenmittel-fehlt")
    return Paket(typ=typ, aussage=aussage, belege=belege, gegenmittel=gegenmittel,
                 ausloeser=str(roh.get("ausloeser", "") or "").strip(), datum=datum,
                 projekt=projekt, zitat=zitat(index, belege), warnungen=warnungen)


def _content(response: dict[str, Any]) -> str:
    if "message" in response:
        return str((response.get("message") or {}).get("content") or "")
    choices = response.get("choices") or []
    if choices:
        return str((choices[0].get("message") or {}).get("content") or "")
    return ""


def parse(content: str) -> list[dict[str, Any]]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```\w*\s*|\s*```$", "", text)
    data = json.loads(text)
    pakete = data.get("pakete") if isinstance(data, dict) else data
    if not isinstance(pakete, list):
        raise ValueError("no 'pakete' list in model output")
    return [p for p in pakete if isinstance(p, dict)]


@dataclass
class Ergebnis:
    pakete: list[Paket]
    verworfen: list[Verworfen]
    sekunden: float
    roh: str = ""
    fehler: str | None = None


GenerateFn = Callable[[list[dict[str, str]], dict[str, Any]], dict[str, Any]]


def extrahiere(fenster_saetze: list[Satz], generate_fn: GenerateFn, *, quelle: str = "",
               datum: str | None = None, projekt: str | None = None,
               version: str | None = None) -> Ergebnis:
    """One model call for one window; gates applied to every package.

    ``generate_fn(messages, json_schema)`` returns the provider response, e.g.
    ``lambda m, s: engines.generate(endpoint, m, json_schema=s, max_tokens=...)``.
    """
    version = prompt_version(version)
    ids = [s.id for s in fenster_saetze]
    index = nach_id(fenster_saetze)
    started = time.perf_counter()
    try:
        response = generate_fn(nachricht(fenster_saetze, quelle=quelle, projekt=projekt,
                                         version=version), schema(ids, version=version))
        content = _content(response)
        raw = parse(content)
    except Exception as exc:  # the caller records a failed window, never a fake result
        return Ergebnis([], [], time.perf_counter() - started, fehler=f"{type(exc).__name__}: {exc}")
    elapsed = time.perf_counter() - started
    limit = MAX_PAKETE_B if version == "b" else MAX_PAKETE
    kept: list[Paket] = []
    dropped: list[Verworfen] = []
    for item in raw[:limit]:
        outcome = pruefe(item, index, datum=datum, projekt=projekt, version=version, quelle=quelle)
        (kept if isinstance(outcome, Paket) else dropped).append(outcome)
    return Ergebnis(kept, dropped, elapsed, roh=content)
