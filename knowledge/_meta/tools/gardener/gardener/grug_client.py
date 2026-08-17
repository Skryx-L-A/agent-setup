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

import json
import os
import time
import urllib.error
import urllib.request

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


class GrugCallError(Exception):
    pass


def call_grug(prompt: str, *, system: str, max_tokens: int = 8192,
              timeout: float = 300.0, temperature: float = 0.0) -> dict:
    rumpf = {
        "model": GRUG_MODEL_PATH,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if GRUG_TEMPLATE_KWARGS:
        rumpf["chat_template_kwargs"] = GRUG_TEMPLATE_KWARGS
    body = json.dumps(rumpf).encode("utf-8")
    req = urllib.request.Request(
        GRUG_BASE_URL + "/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            rohtext = resp.read()
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
    if not isinstance(content, str) or not content.strip():
        raise GrugCallError(f"empty content: {data}")
    reasoning = message.get("reasoning") or ""
    finish_reason = choices[0].get("finish_reason")
    usage = data.get("usage") or {}
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
