# B1 engine API

`EngineRegistry.from_file()` reads `engines.yaml` (or `BRAIN_ENGINES`) and
`pick({"logprobs", ...})` returns only a reachable endpoint with every requested
capability; it returns `None` otherwise.  Reachability is cached for the registry
run, not globally.

`generate(endpoint, messages, json_schema=..., max_tokens=..., think=False)`
uses the provider-specific structured-output field and obeys the endpoint's
`max_parallel` limit.  It returns the provider response unchanged.

`decide(state, questions, ...)` is the B2/B3 classification entry point.
`Question(text, type, options)` accepts `choice`, `noul`, and `score`; every
choice automatically gets `unklar` unless `mit_unklar=False` (a list whose options
already cover every case, e.g. projects plus `keins`).  `top_logprobs` is capped at
20 (Ollama and the OpenAI API answer HTTP 400 above; measured 2026-09-24 with 24
options): the chosen token is always among them, options outside the top 20 get
probability 0.  Ollama 0.32.5 returns `logprobs` on the top level of `/api/chat`,
older versions under `message`; both are read.  `options=` goes to Ollama's
`options` (e.g. `num_ctx`).  It uses exactly one `num_predict=1` request
per question with thinking disabled, derives probabilities only from the returned
top logprobs, renormalizes the available labels with the explicit calibration
temperature, assigns absent labels probability zero, and marks low-confidence or
`unklar` answers as `unsicher`.  It raises `EngineUnavailable`/`EngineResponseError`
instead of falling back to a weaker endpoint or a text answer.

## Stufen von `brain run` (`"stufen"` in `engines.yaml`)

Seit B4 (2026-09-23) nennt `engines.yaml` je Pipeline-Stufe den Motor und die Modelle in
Vorzugsreihenfolge: Extraktion `gemma4:12b` (Rückfall `qwen3.5:9b`), Paarurteil `gemma4:12b`
mit Schwelle 0,65, Einbettung `embeddinggemma`, alle auf peer; Mac-Splash nur für Einheiten
in `wartet-grossmodell`. Gelesen von `gardener/lauf/motoren.py`; ein nicht installiertes
Modell wird übersprungen (`/api/tags`), ein vom Lauf geladenes Modell am Ende entladen.

`nebenlaeufig` (Stufe `extraktion`, seit B6): so viele Fenster gleichzeitig im Flug; Vorgabe 1.
Auf peer 2 (gemessen 2026-09-23, 20 Backlog-Einheiten, gemma4:12b, `OLLAMA_NUM_PARALLEL` 1/2/3:
5,13 / 8,06 / 8,52 Einheiten je Minute, VRAM-Spitze 9.892 / 10.500 / 10.941 MiB). Der Wert gehört
zu `OLLAMA_NUM_PARALLEL` des peer-Benutzerdienstes; mehr Nebenläufigkeit als Server-Plätze wartet
nur in der Warteschlange.

Seit p2 (2026-09-24, Messung j2, `_meta/tools/eval/jev-pipeline/BEFUNDE.md`):

- `paarurteil.gleich_cos` (0,62): im Abgleich gilt ein Paar ab dieser Einbettungs-Kosinus-
  Ähnlichkeit als `gleich` (Status `cos`), ohne Modellaufruf; darunter bleibt das Paket neu.
  Test-Genauigkeit 0,91 gegen 0,75 der Modellfrage. `BRAIN_ABGLEICH_COS_ALLEIN=0` stellt das
  Modellurteil (`schwelle`, Kandidaten ab 0,65) wieder her.
- `projektwahl` (`gemma4:12b`, `num_ctx` 8192): Lückenfüller für Einheiten ohne Projekt, eine
  Auswahlfrage über die Projekte plus `keins`; Ergebnis nur als Vorschlag im Buch und in der
  Review-Queue. `BRAIN_PROJEKT_LUECKE=0` schaltet ihn ab.
- `abgleichen` wartet wie `extrahieren` bis `start_warten_s` (Vorgabe 600 s) auf Einbettung
  (und im Modellmodus Paarurteil), baut dazwischen den SSH-Tunnel neu auf und scheitert sonst
  laut; es rechnet nie mehr still mit Wortüberlappung.
- `mac-ollama` meldet `logprobs: true` (Ollama 0.32.5 liefert sie).
