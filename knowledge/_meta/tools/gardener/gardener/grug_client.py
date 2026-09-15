"""HTTP-Client fuer grug-27b unter mlx_lm.server (Port 8080, `grug-server ensure`).

Gleicher Rueckgabe-Umschlag wie `dream.extract.call_claude_cli` / historisch
`call_ollama` ("result" traegt den rohen Antworttext als String, "usage" die
Tokens, "total_cost_usd" 0.0 fuer lokal) - Aufrufer wie `extract_batch` und
`review_package` kennen den Unterschied zwischen Cloud und lokal nicht, nur
`call()` weiss es.

mlx_lm.server antwortet OpenAI-kompatibel und liefert bei diesem Modell
zusaetzlich ein eigenes `reasoning`-Feld neben `content` - das Denken ist hier
vom Endtext getrennt, anders als bei den frueheren lokalen Modellen, die alles
in einen Fliesstext schrieben. Beides wird zurueckgegeben, damit ein Aufrufer
die Denk-Tokens getrennt zaehlen kann.

Uebernommen unveraendert aus wb/traumlokal (`messungen/grug-lokal/grug_client.py`,
Messung vom 2026-08-11/12) in den Werkzeugbaum, statt es fuer den Umbau neu zu
erfinden - siehe `regeln/messungen.md`: ein Messwerkzeug gehoert ins Repo.
"""
from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request

from .ollama import OllamaUnavailable

log = logging.getLogger("gardener")

GRUG_BASE_URL = os.environ.get("GRUG_BASE_URL", "http://127.0.0.1:8080")
# Welches lokale Modell der Lauf benutzt. Ueber die Umgebung setzbar, damit ein
# Modellwechsel EINE Stelle ist und nicht drei - der Server (`grug-server`),
# dieser Client und die Belegung muessen dasselbe Modell meinen, sonst laedt
# der Server das eine und der Client fragt nach dem anderen.
# Die Vorgabe kommt aus der Konfiguration des Traums, nicht aus einer zweiten
# hartkodierten Zeichenkette. Genau daran waere sonst der Modellwechsel
# gescheitert: `dream/config.py` haette Qwen3.8 gesagt und dieser Client
# weiter grug gefragt - und `mlx_lm.server` 0.31.3 LAEDT das im Feld `model`
# genannte Modell einfach nach, wenn es vom geladenen abweicht. Der Server
# haette also stillschweigend dem Client gehorcht, je Anfrage 15 GB umgeladen,
# und die Belegung haette ein drittes Modell gebucht (Befund B3 des
# Prueferlaufs `pruefer-lokal`, 16.08.2026).
from .dream import config as _dcfg  # noqa: E402 - siehe Kommentar

GRUG_MODEL_PATH = os.environ.get("GRUG_MODEL_PATH",
                                 _dcfg.DREAM_LOCAL_MODEL_PATH)
# Argumente fuer die Chat-Vorlage, als JSON in der Umgebung. Gebraucht seit
# dem 15.08.2026: Qwen3.8 setzt in seiner Vorlage
# `reasoning_effort|default('xhigh')` und denkt im Auslieferungszustand auf
# hoechster Stufe - eine einzige Einheit brauchte damit ueber 28 Minuten. Mit
# `{"reasoning_effort": "low"}` sind es 62 Sekunden.
_grug_template_kwargs_roh = os.environ.get("GRUG_TEMPLATE_KWARGS")
if not _grug_template_kwargs_roh:
    # Ohne Umgebungsvariable gilt die Konfiguration - fuer Qwen3.8 also
    # `reasoning_effort: low`. Fehlte sie, daechte das Modell laut seiner
    # Chat-Vorlage auf `xhigh`: 28 Minuten je Einheit statt 62 Sekunden.
    GRUG_TEMPLATE_KWARGS = dict(_dcfg.DREAM_LOCAL_TEMPLATE_KWARGS)
else:
    try:
        GRUG_TEMPLATE_KWARGS = json.loads(_grug_template_kwargs_roh)
    except ValueError as e:
        # Eine gesetzte, aber unlesbare Variable ist nie Absicht. Stiller
        # Rueckfall auf {} wuerde hier bedeuten: Qwen3.8 denkt mangels
        # reasoning_effort-Override auf "xhigh" statt "low" - Faktor 27
        # langsamer (28 Minuten statt 62 Sekunden je Einheit), unbemerkt bis
        # jemand auf die Uhr schaut. Deshalb harter Abbruch beim Import.
        raise RuntimeError(
            "GRUG_TEMPLATE_KWARGS ist gesetzt, aber kein gueltiges JSON: "
            f"{_grug_template_kwargs_roh!r} ({e}). Erwartet z.B. "
            '\'{"reasoning_effort": "low"}\' - oder die Variable ganz weglassen.'
        ) from e

# BEFUND (Nachtrag zum Auftrag "modellwege", Punkt 3, 02.09.2026): auf dem
# HEUTE laufenden Server (`mlx_vlm.server` mit `--draft-kind mtp`, siehe
# `wb-mlx-server`) kommt `chat_template_kwargs`/`reasoning_effort` NICHT an.
# Geprueft auf zwei Wegen: (1) `mlx_vlm/server.py`s `TemplateParams` kennt nur
# `enable_thinking`, `thinking_budget`, `thinking_start_token`,
# `thinking_end_token` - kein `chat_template_kwargs`-Feld ueberhaupt, wird
# also von Pydantic als unbekanntes Feld verworfen; (2) eine Anfrage mit
# `chat_template_kwargs: {"reasoning_effort": "definitiv-ungueltig"}` haette
# laut Chat-Vorlage (`raise_exception(...)` fuer jeden Wert ausser
# xhigh/medium/low) einen Fehler ausloesen muessen - der Server antwortete
# stattdessen ganz normal mit HTTP 200. Beides zusammen zeigt: der Wert wird
# gesendet, aber nie gelesen. Das erklaert, warum die erste Messung dieses
# Umbaus (Gärtner-Urteil "low" gegen "ohne Vorgabe": 23,48 s gegen 20,15 s)
# praktisch keinen Unterschied zeigte - vermutlich lief BEIDES auf demselben,
# vom Server selbst gewaehlten Denkverhalten.
#
# Ein echter, GRADUIERTER Hebel fuer DIESEN Server existiert nicht:
# `thinking_budget` waere der naheliegende Ersatz, scheitert aber explizit
# mit spekulativem Decodieren ("thinking_budget is not supported with
# speculative decoding in the server", HTTP 500, gemessen 02.09.2026) - und
# genau das (`--draft-kind mtp`) ist die aktuelle, bewusst schnellere
# Serverkonfiguration. `enable_thinking: false` funktioniert (gemessen:
# 0,19 s Generierung statt ~20 s, kein Denken mehr im Feld `reasoning`), ist
# aber ein Ein/Aus-Schalter, keine Stufe - und ob ein abgeschaltetes Denken
# fuer den gardener-Anwendungsfall dieselbe Urteilsguete liefert wie mit
# Denken, ist NICHT gemessen. Diese Konstante bleibt deshalb unveraendert
# gesetzt (schadet nicht, dokumentiert die Absicht, wird lebendig, sobald ein
# Server sie wieder liest) - siehe Ergebnisbericht dieses Auftrags fuer die
# Empfehlung, was als naechstes zu messen waere.

# DEFEKT 2 (Nachtrag zum Auftrag "modellwege", 02.09.2026): der Auftrag
# nennt vier gleichzeitige Stroeme als Vorgabe, gestuetzt auf die Messung am
# Extraktionspfad in gardener/dream/config.py (seriell 97,0 s/Einheit, vier
# Stroeme 40,3 s, acht 42,2 s). GEGENGEMESSEN gegen den HEUTE laufenden
# Server (02.09.2026, mlx_vlm.server mit `--draft-kind mtp`, derselbe Server
# wie beim Extraktionspfad, aber eine ANDERE, neuere Startkonfiguration):
# schon ZWEI gleichzeitige Anfragen (nicht erst acht) lassen ihn reproduzierbar
# mit `HTTP 500: "'tuple' object has no attribute 'shape'"` abstuerzen - JEDE
# von vier realen Notizpaaren scheiterte so, waehrend derselbe Server
# denselben Aufruf seriell (ein Paar nach dem anderen) zuverlaessig beantwortet
# (20 von 20 in der Messung dieses Auftrags, siehe Ergebnisbericht). Der
# Server erholt sich danach von selbst (naechster einzelner Aufruf: wieder
# `200`), aber jede gleichzeitige Anfrage waehrend eines echten Laufs wuerde
# denselben Fehler ausloesen und den Kreisunterbrecher nach fuenf
# Fehlschlaegen in Folge ziehen - eine ganze Phase (z.B. linking) faellt dann
# komplett aus, statt schneller zu sein.
#
# Die Vorgabe steht deshalb auf 1 (kein Deckel aufs GLEICHZEITIGE, bis die
# Ursache geklaert oder der Server ohne `--draft-kind mtp` betrieben wird) -
# NICHT auf 4, obwohl der Auftrag das nennt: ein Standardwert, der den
# gemessen aktuell laufenden Server reproduzierbar abstuerzen laesst, ist
# keine Vorgabe, sondern ein eingebauter Fehler. `judge_many()`/`run_linking`
# funktionieren bei `parallel>1` weiterhin korrekt (siehe deren Tests) und
# sind bereit, sobald ein Server das sicher traegt - das ist dann diese EINE
# Zeile, ueber dieselbe Umgebungsvariable wie GRUG_MODEL_PATH/GRUG_CONTEXT_WINDOW.
GRUG_JUDGE_PARALLEL = int(os.environ.get("GRUG_JUDGE_PARALLEL", "1"))


# -- Antwortbudget: der Rest des Fensters, nie eine feste Zahl --------------
# Auftrag "modellwege" (02.09.2026) / regeln/lokale-modelle.md, "Kein Deckel
# auf das Denken" (2026-08-30): ein FESTES max_tokens (hier bis 02.09.2026:
# 8192) kann mitten im sichtbaren Denken von Qwen3.8 abreissen - gemessen am
# 2026-08-29 fuer eine Rechercheaufgabe: das ganze Budget ging ins Denken,
# kein Satz Antwort blieb, und der Lauf meldete trotzdem gruen. Der Server
# braucht trotzdem eine Zahl (ein weggelassenes max_tokens ist bei
# mlx_lm.server NICHT "unbegrenzt", sondern Fenster/4, gemessen ebenda) -
# also wird sie JE ANFRAGE aus dem Fenster minus dem, was der Prompt selbst
# schon braucht, berechnet.
#
# GRUG_CONTEXT_WINDOW ist das NATIVE Fenster von Qwen3.8-27B laut Registry
# (`wb-state models get qwen38-27b --field contextWindow`, gemessen
# 02.09.2026: 262144) - eine OBERGRENZE, nie eine Annahme ueber das
# tatsaechlich servierte Fenster. Befund vom Nachtrag zu diesem Auftrag
# (02.09.2026): der laufende Server wird oft mit einem kleineren
# `--max-kv-size` gestartet (gemessen: 65536, ein Viertel des nativen
# Maximums) - `wb-mlx-server status` nennt das "Kontext gebucht". Ein Client,
# der stur gegen 262144 rechnet, rechnet gegen ein Fenster, das gar nicht da
# ist, und heilt das nur ueber die Selbstkorrektur unten (HTTP 400) - zwei
# gemessene 300-Sekunden-Zeitueberschreitungen in der ersten Messung dieses
# Umbaus waren sehr wahrscheinlich genau das: eine Anfrage, die viermal zu
# gross war, bevor der Server ueberhaupt zu antworten begann.
# Ueberschreibbar aus demselben Grund wie GRUG_MODEL_PATH: wer diesen Client
# auf ein anderes lokales Modell zeigt, muss auch dessen natives Maximum nennen.
GRUG_CONTEXT_WINDOW = int(os.environ.get("GRUG_CONTEXT_WINDOW", "262144"))
# Der konservative Vorgabewert, wenn der laufende Server nicht erfragt werden
# kann (siehe _server_context_window unten) - NIE das groesstmoegliche
# GRUG_CONTEXT_WINDOW, weil genau diese Annahme der Fehler war. 8192 ist der
# alte, jahrelang benutzte feste Wert dieses Clients: nie beobachtet, dass er
# vom Server abgelehnt wurde, also die sichere Untergrenze fuer den Fall, dass
# gar nichts bekannt ist.
GRUG_CONTEXT_WINDOW_FALLBACK = int(os.environ.get("GRUG_CONTEXT_WINDOW_FALLBACK", "8192"))
# Reserve fuer das, was der reine Zeichen-Schaetzer unten nicht sieht:
# Chat-Vorlage, Rollen-Markierungen, Sonder-Token. Ohne Reserve koennte eine
# knapp geschaetzte Anfrage genau an der Fenstergrenze mit HTTP 400 scheitern
# (mlx_lm.server rechnet Prompt + max_tokens gegen MAX_KV_SIZE).
GRUG_MAX_TOKENS_SAFETY = 1024
# Untergrenze, falls ein Prompt selbst schon fast das ganze Fenster fuellt -
# ein Antwortbudget nahe 0 waere kein Fehler, aber auch keine brauchbare
# Antwort. Darueber liegen soll der Aufrufer den Prompt kuerzen, nicht diesen
# Client mit einer Zahl fuettern, die keine JSON-Antwort mehr traegt.
GRUG_MIN_MAX_TOKENS = 2048
# Wie lange die Fensterabfrage hoechstens warten darf, bevor sie als
# gescheitert gilt und der konservative Vorgabewert greift - ein einzelner
# lokaler GET auf /health, keine Generierung, muss in Millisekunden antworten.
GRUG_HEALTH_TIMEOUT = 5.0


def _estimate_tokens(text: str) -> int:
    """Zeichen-Schaetzung, absichtlich nach OBEN gerundet: eine ueberschaetzte
    Prompt-Groesse verschenkt hoechstens etwas Antwortbudget, eine
    UNTERschaetzte laesst max_tokens die tatsaechliche Fensterluecke
    ueberschreiten, und der Server lehnt mit HTTP 400 ab (siehe oben)."""
    return -(-len(text) // 3)  # ceil(len/3), stdlib-only


def _server_context_window(timeout: float = GRUG_HEALTH_TIMEOUT) -> int | None:
    """Fragt das tatsaechlich servierte Fenster direkt beim laufenden Server ab
    (`GET /health`, Feld `effective_context_limit` - dasselbe, das
    `wb-mlx-server status` als "Kontext gebucht" zeigt). `None` bei jedem
    Fehler (Transport, kaputtes JSON, fehlendes/unplausibles Feld) - der
    Aufrufer faellt dann auf GRUG_CONTEXT_WINDOW_FALLBACK zurueck, NIE auf
    das groesstmoegliche GRUG_CONTEXT_WINDOW. Ein fehlgeschlagener
    Gesundheitscheck ist kein Grund, geraten optimistisch zu sein - das war
    genau der urspruengliche Fehler."""
    try:
        with urllib.request.urlopen(GRUG_BASE_URL + "/health",
                                    timeout=timeout) as resp:
            daten = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None
    wert = daten.get("effective_context_limit")
    if isinstance(wert, (int, float)) and wert > 0:
        return int(wert)
    return None


class GrugCallError(Exception):
    pass


_MAX_KV_SIZE_RE = re.compile(r"MAX_KV_SIZE is (\d+)")


def call_grug(prompt: str, *, system: str, max_tokens: int | None = None,
              timeout: float = 300.0, temperature: float = 0.0,
              template_kwargs: dict | None = None,
              enable_thinking: bool | None = None,
              _selbstkorrektur_erlaubt: bool = True) -> dict:
    berechnet = max_tokens is None
    if berechnet:
        prompt_tokens_est = _estimate_tokens(system) + _estimate_tokens(prompt)
        # DEFEKT 1 (Nachtrag 02.09.2026): erst beim laufenden Server nach dem
        # ECHTEN Fenster fragen; ohne Antwort gilt der konservative
        # Vorgabewert, nie das (moeglicherweise geratene) native Maximum.
        # GRUG_CONTEXT_WINDOW bleibt dabei die harte Obergrenze - ein Server,
        # der (fehlerhaft) mehr als sein Modell traegt meldet, darf trotzdem
        # nie mehr Budget bekommen, als das Modell tatsaechlich hat.
        fenster = _server_context_window()
        if fenster is None:
            fenster = GRUG_CONTEXT_WINDOW_FALLBACK
        fenster = min(fenster, GRUG_CONTEXT_WINDOW)
        max_tokens = max(GRUG_MIN_MAX_TOKENS,
                         fenster - prompt_tokens_est - GRUG_MAX_TOKENS_SAFETY)
    kwargs = GRUG_TEMPLATE_KWARGS if template_kwargs is None else template_kwargs
    rumpf = {
        "model": GRUG_MODEL_PATH,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if kwargs:
        rumpf["chat_template_kwargs"] = kwargs
    if enable_thinking is not None:
        # NACHTRAG 2 (02.09.2026): `enable_thinking` ist auf dem heute
        # laufenden Server (mlx_vlm.server) ein TOP-LEVEL Anfragefeld, kein
        # `chat_template_kwargs`-Eintrag - siehe die "LUECKE"-Erklaerung oben
        # bei GRUG_TEMPLATE_KWARGS. `None` (Vorgabe) laesst das Feld ganz weg
        # und damit das bisherige, gemessene Verhalten (Denken an) unveraendert
        # - nur wer es ausdruecklich anders will, setzt hier True/False.
        rumpf["enable_thinking"] = enable_thinking
    body = json.dumps(rumpf).encode("utf-8")
    req = urllib.request.Request(
        GRUG_BASE_URL + "/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            rohtext = resp.read()
    except urllib.error.HTTPError as e:
        fehlertext = e.read().decode("utf-8", errors="replace")
        # GEMESSEN 02.09.2026: ein laufender Server traegt nicht immer das
        # volle GRUG_CONTEXT_WINDOW - `wb-mlx-server` startet ihn je nach
        # Nebenlaeufigkeit/Speicherlage auch mit einem kleineren MAX_KV_SIZE
        # (hier gemessen: 65536 statt 262144). Nur wenn WIR die Zahl selbst
        # berechnet haben (nicht der Aufrufer sie vorgegeben hat) und der
        # Server genau das meldet, wird EINMAL mit dem echten Fenster neu
        # gerechnet, statt den Aufruf an einer falschen Annahme scheitern zu
        # lassen - ein expliziter max_tokens-Wunsch des Aufrufers bleibt
        # dagegen unangetastet und der Fehler sichtbar.
        treffer = _MAX_KV_SIZE_RE.search(fehlertext) if berechnet and _selbstkorrektur_erlaubt else None
        if treffer:
            reales_fenster = int(treffer.group(1))
            korrigiert = max(GRUG_MIN_MAX_TOKENS, reales_fenster
                            - prompt_tokens_est - GRUG_MAX_TOKENS_SAFETY)
            log.warning("MAX_KV_SIZE ist %d, nicht %d (GRUG_CONTEXT_WINDOW) - "
                       "wiederhole einmal mit max_tokens=%d",
                       reales_fenster, GRUG_CONTEXT_WINDOW, korrigiert)
            return call_grug(prompt, system=system, max_tokens=korrigiert,
                            timeout=timeout, temperature=temperature,
                            template_kwargs=template_kwargs,
                            enable_thinking=enable_thinking,
                            _selbstkorrektur_erlaubt=False)
        raise GrugCallError(f"transport: HTTP {e.code}: {fehlertext[:200]}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise GrugCallError(f"transport: {e}") from e
    try:
        data = json.loads(rohtext)
    except ValueError as e:
        # Verbindung stand (kein URLError/OSError oben) - die ANTWORT selbst
        # ist kaputt, z.B. ein Fehlertext des Proxys mit Status 200 oder eine
        # abgerissene Antwort. Ohne eigenen Zweig wuerde das ungefangen
        # durchschlagen: extract_batch faengt nur CallError, die Gruppenschleife
        # nur BudgetExhausted - ein einzelner Transportfehler wuerde sonst das
        # ganze Nachtfenster beenden statt nur das eine Buendel in Quarantaene
        # zu schicken. Auszug der Rohantwort fuer die Diagnose beigelegt.
        auszug = rohtext.decode("utf-8", errors="replace")[:200]
        raise GrugCallError(
            f"kaputte Antwort (kein gueltiges JSON, keine Transportstoerung): "
            f"{e} - Auszug: {auszug!r}") from e
    duration_s = time.monotonic() - t0
    choices = data.get("choices") or []
    if not choices:
        raise GrugCallError(f"empty choices: {data}")
    message = choices[0].get("message") or {}
    content = message.get("content")
    reasoning = message.get("reasoning") or ""
    finish_reason = choices[0].get("finish_reason")
    usage = data.get("usage") or {}
    if finish_reason == "length":
        # regeln/lokale-modelle.md, "Kein Deckel auf das Denken":
        # finish_reason=length ist ein FEHLER, kein Ergebnis - auch wenn
        # `content` (teilweise) gefuellt ist. Ohne diese Pruefung kaeme genau
        # der gemessene Fehler vom 2026-08-29 zurueck: eine Antwort, die
        # mitten im Denken oder mitten im Satz abreisst, wuerde als
        # vollstaendiges Verdikt durchgereicht.
        raise GrugCallError(
            f"truncated: finish_reason=length (max_tokens={max_tokens}, "
            f"completion_tokens={usage.get('completion_tokens')}, "
            f"reasoning_chars={len(reasoning)}) - das Antwortbudget hat "
            "nicht gereicht, das ist kein gueltiges Ergebnis")
    if not isinstance(content, str) or not content.strip():
        raise GrugCallError(f"empty content: {data}")
    return {
        "result": content,
        "reasoning": reasoning,
        "reasoning_chars": len(reasoning),
        "finish_reason": finish_reason,
        "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                  "output_tokens": usage.get("completion_tokens", 0)},
        "total_cost_usd": 0.0,
        "duration_s": duration_s,
        "backend": "local-grug",
    }


class GrugJudgeClient:
    """`.judge(system, prompt) -> dict` ueber Qwen3.8/MLX (`call_grug`).

    Auftrag "modellwege" (02.09.2026): die gardener-Aufrufstellen, deren
    Fehlurteil Unsinn in den Vault schreibt oder eine Struktur behauptet, die
    nicht da ist (linking, contradict, consolidate, HOT.md-Zusammenfassung,
    Transkript-Mining, Themensynthese), bekommen ab hier Qwen3.8-27B statt
    `ornith:9b` - Ollama kennt Qwen3.8 gar nicht (`{"error": "invalid model
    name"}` auf Port 11434, geprueft 02.09.2026), ein Umstieg auf das
    schlauere Modell fuehrt also zwangslaeufig vom Ollama-Client auf DIESEN.

    Gleicher Vertrag wie `OllamaClient.judge()`: tolerantes JSON-Parsing,
    `{}` bei einem einzelnen missgluecktem Aufruf, `OllamaUnavailable` erst
    nach `MAX_CONSECUTIVE_FAILURES` in Folge. Die Ausnahme wird bewusst aus
    `.ollama` WIEDERVERWENDET statt neu erfunden: fuer jeden Aufrufer (cli.py
    `_guard`, mine.py, synth.py) ist "der lokale Richter antwortet nicht
    mehr" dasselbe Ereignis, gleich von welchem lokalen Server es kommt - die
    bestehende Fehlerbehandlung greift so unveraendert, ohne dass ein
    einziger Aufrufer diese Klasse kennen muesste.

    DEFEKT 2 (Nachtrag zum Auftrag "modellwege", 02.09.2026): `judge_many()`
    faehrt mehrere Urteile GLEICHZEITIG (siehe GRUG_JUDGE_PARALLEL). Der
    Fehlschlagszaehler ist deshalb hinter einem Lock: mehrere Threads duerfen
    ihn niemals gleichzeitig lesen-und-schreiben, sonst zaehlt "fuenf
    Fehlschlaege in Folge" falsch (verlorene Erhoehungen, oder zwei Threads
    loesen beide unabhaengig den Kreisunterbrecher aus). Mit dem Lock bedeutet
    "in Folge" unter Nebenlaeufigkeit: die letzten `MAX_CONSECUTIVE_FAILURES`
    ABGESCHLOSSENEN Urteile (ueber alle Straeme gezaehlt) waren Fehlschlaege -
    dieselbe Bedeutung wie seriell, nur dass "Reihenfolge" jetzt
    Abschlussreihenfolge statt Startreihenfolge ist.

    NACHTRAG 2 (02.09.2026): `enable_thinking` ist PRO INSTANZ einstellbar,
    nicht global - "je Klasse einstellbar", wie der Auftrag es verlangt.
    Gemessen an derselben 20-Paar-Stichprobe wie der Rest dieses Auftrags:
    fuer die Verknuepfungsstufe (linking) stimmen die Urteile mit und ohne
    Denken in 19 von 20 Faellen ueberein (18 volle Uebereinstimmung, eine
    reine Typ-Abweichung bei gleichem link-Ja/Nein), der einzige
    Urteilsunterschied ist der GUENSTIGE (eine ausgelassene Verknuepfung,
    keine erfundene), und ohne Denken ist etwa 15x schneller (5,78 s gegen
    84,67 s je Urteil). Deshalb bekommt NUR `linking` in `cli.py` eine
    Instanz mit `enable_thinking=False`; die anderen vier schlauen Stellen
    (consolidate, maintain, mine, synth) sind nicht eigens gemessen - sie
    bleiben auf der Vorgabe (Denken an), weil sie teils generative,
    schreibende Aufgaben sind (consolidate schreibt zusammengefuehrten
    Markdown-Text, synth schreibt autoritative Themenseiten), fuer die ein
    Qualitaetsverlust ohne Denken nicht ausgeschlossen und nicht gemessen ist.
    """

    RETRIES = 1
    MAX_CONSECUTIVE_FAILURES = 5

    def __init__(self, *, enable_thinking: bool | None = None):
        self.failures = 0            # consecutive transport/judge failures
        self.transient_failures = 0  # total, for the report
        self._lock = threading.Lock()
        self.enable_thinking = enable_thinking

    def judge(self, system: str, prompt: str) -> dict:
        for attempt in range(self.RETRIES + 1):
            try:
                envelope = call_grug(prompt, system=system, temperature=0.0,
                                     enable_thinking=self.enable_thinking)
            except GrugCallError as e:
                if attempt < self.RETRIES:
                    log.warning("smart judge failed (%s) - retrying once", e)
                    continue
                with self._lock:
                    self.failures += 1
                    self.transient_failures += 1
                    stand = self.failures
                    tot = stand >= self.MAX_CONSECUTIVE_FAILURES
                if tot:
                    raise OllamaUnavailable(
                        f"{stand} consecutive smart-judge failures "
                        f"(last: {e}) - the local MLX server is not "
                        "answering, aborting the run") from e
                log.warning("smart judge failed (%d/%d in a row, tolerated): %s",
                           stand, self.MAX_CONSECUTIVE_FAILURES, e)
                return {}
            with self._lock:
                self.failures = 0
            content = envelope["result"]
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                m = re.search(r"\{.*\}", content, re.DOTALL)
                if m:
                    try:
                        return json.loads(m.group(0))
                    except json.JSONDecodeError:
                        pass
            log.warning("smart judge returned non-JSON: %.200s", content)
            return {}
        return {}

    def judge_many(self, pairs: list[tuple[str, str]], *,
                  parallel: int = GRUG_JUDGE_PARALLEL) -> list[dict]:
        """Urteilt ueber `pairs` (Liste von `(system, prompt)`) mit bis zu
        `parallel` gleichzeitigen Stroemen. Die ZURUECKGEGEBENE Liste steht in
        derselben Reihenfolge wie `pairs`, unabhaengig davon, welcher Strom
        zuerst fertig wird (`ThreadPoolExecutor.map` haelt die
        Eingabereihenfolge ein - es mischt nicht nach Abschlusszeit).

        Ein einzelner Strom, der scheitert, reisst die anderen nicht mit: wie
        bei `judge()` seriell auch, ist ein einzelner Fehlschlag `{}`, kein
        Abbruch. Nur wenn der gemeinsame, gesperrte Zaehler
        `MAX_CONSECUTIVE_FAILURES` erreicht, wird `OllamaUnavailable`
        geworfen - dann fuer den ganzen Rest, wie im seriellen Fall auch, weil
        `judge_many` selbst keine neuen Anfragen mehr startet, sobald eine
        davon die Ausnahme wirft."""
        if parallel <= 1 or len(pairs) <= 1:
            return [self.judge(system, prompt) for system, prompt in pairs]
        with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as pool:
            return list(pool.map(lambda sp: self.judge(sp[0], sp[1]), pairs))
