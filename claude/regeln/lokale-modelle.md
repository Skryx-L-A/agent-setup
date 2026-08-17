# regeln/lokale-modelle.md

Inhalt: Local model standards, vollständiger Abschnitt aus CLAUDE.md. Gilt seit: 2026-07-12.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor ein lokales Modell gestartet, gewechselt oder eingeplant wird.

## Local model standards (2026-07-12) — orchestrator + all agents

- **Context: alle NICHT-pi-Programme servieren weiterhin 64K.** `OLLAMA_CONTEXT_LENGTH=65536` lives in
  `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist` (global for every Ollama model; reload the
  LaunchAgent after changes, verify the `ollama ps` CONTEXT column). Pi's `~/.pi/agent/models.json`
  `contextWindow` must stay ≤ the served value (65536) for any model WITHOUT a dedicated
  `-<ctx>k`-suffixed Ollama tag.
  **Seit 2026-08-15 hebt pi die Fenster ueber eigene Tag-Varianten an (Anweisung des Nutzers, je
  Modell GEMESSEN):** jedes der neun lokalen Ollama-Modelle hat eine Variante mit eingebranntem
  `num_ctx` (`ollama create <name>-<ziel>k`, `FROM <original>` + `PARAMETER num_ctx <ziel>`;
  geteilte Gewichts-Blobs, kein doppelter Speicher). Ziel 262144 (256K) bei 4-Bit-Quantisierung
  (Q4_K_M, nvfp4) = natives Maximum, 131072 (128K) bei Q6_K (Korrektur des Nutzers vom 15.08.:
  „richtige Groesse", nicht runde 200k/100k); GEMESSEN wurde die Passung bei 200000/100000
  (100 % GPU, kein Spill), die Endwerte sind daraus gerechnet (KV waechst linear, Spielraum zur
  43-GB-Grenze bei allen Modellen mehrere GB) — Lasttest bei 256K steht aus, nie ueber dem
  nativen Maximum aus `ollama show`
  (`huihui_ai/qwen3-abliterated:4b` bleibt bei 40960). Nur `~/.pi/agent/models.json` zeigt auf
  diese Varianten; pis Teilstring-Modellaufloesung leitet Aufrufe mit dem alten Namen automatisch
  auf die Variante um — `pi-worker` und die Registry-`modelRef`s blieben unveraendert, die
  Workbench-Registry traegt nur die neuen `contextWindow`-Werte. Alle anderen Programme (goose,
  crush, qwen-code, jcode, llama.cpp) behalten die globale 65536er-Vorgabe. Fuer `grug` (MLX)
  gilt 131072 ERRECHNET, nicht lastgetestet (0,0625 MiB/Token aus der Architektur, 16 von 64
  Schichten mit wachsendem KV) — die Kernel-Panik-Regel weiter unten bleibt in Kraft. Beleg:
  `~/.pi-workers/results/pictx/20260815-165844.md`.
  **Korrigiert 2026-08-03, nachdem die Regel zwei Wochen falsch war.** Sie nannte 131072, die
  plist steht aber seit dem 2026-07-19 auf 65536, und acht Modelle in `models.json` waren auf
  131072 deklariert — ein pi-Worker lief damit in stille Trunkierung, ohne dass irgendwo ein
  Fehler erschien. Die Zahl wird deshalb nie aus dieser Datei zitiert, sondern gemessen:
  `ollama ps` zeigt die tatsächlich servierte Länge in der CONTEXT-Spalte.
  Wer auf 131072 zurück will, entscheidet damit über KV-Cache-Speicher und muss die Folge für
  ein 35B-Modell nachrechnen, bevor er die plist ändert.
- **Quant for serious coding models: Q6_K minimum, Q8_0 preferred** — Metal-native **GGUF (or MLX)**
  as the default; NVFP4 targets NVIDIA Blackwell, not Apple Metal, so it is never the *first*
  choice. HARD ceiling: GPU-addressable ~43 GB of 48 → a 35B at 128K context caps at **Q6_K**
  (Q8 spills to CPU), a 27B takes **Q8_0**. Confirm 100% GPU / no CPU spill (`ollama ps` or
  llama.cpp load log) before accepting a model.
  **Belegte Ausnahme (gemessen 2026-08-03):** `qwen3.6:35b-a3b-coding-nvfp4`, der als
  Zweitmeinung geroutete `qwen`, läuft hier trotz NVFP4 **100 % auf der GPU** mit
  **73,5 tok/s** bei 65K Kontext — Ollama konvertiert das Format beim Laden. Das blanke
  Verbot hätte ein funktionierendes Modell aussortiert. Es gilt weiter als Regel für die
  Auswahl NEUER Modelle, aber ein NVFP4-Modell wird nicht ungemessen verworfen: erst laden,
  `ollama ps` lesen, tok/s messen — die Zahl entscheidet, nicht der Formatname.
  **Nachgemessen 2026-08-04 (Setup-Punkt B3), diesmal mit Qualitaet und Speicher, nicht nur
  Tempo:** `qwen3.6:35b-a3b-coding-nvfp4` gegen `ornith:35b` (Q4_K_M, gleiche Groessenklasse,
  naechstliegende lokale Alternative — eine quant-andere GGUF-Fassung von
  qwen3.6-a3b-coding liegt lokal nicht vor, nur die NVFP4-Tags). Testsatz `dod-judge/pruef3`
  (50 Faelle, Prompt H, temperature 0, je ein Durchlauf je Modell, Median ueber die 50
  Einzelmessungen): Trefferquote 44/50 (88,0 %) NVFP4 vs. 45/50 (90,0 %) Q4_K_M — ein Fall
  Unterschied bei n=50, kein belastbarer Qualitaetsabstand. Speicher geladen 21 GB vs. 22 GB,
  beide 100 % GPU, kein Spill. Durchsatz-Median 74,5 vs. 72,5 tok/s (NVFP4 minimal schneller,
  aber deutlich groessere Streuung: 44,6-80,0 vs. 69,4-74,4 tok/s). Time-to-first-token-Median
  0,885 s vs. 0,427 s — NVFP4 braucht gut doppelt so lange bis zum ersten Token, vermutlich die
  Dequantisierung, die Ollama fuer das Blackwell-Format auf Metal einschiebt. Fazit: kein
  Qualitaets- oder Speichernachteil, ein realer aber kleiner Latenznachteil bei jedem Aufruf.
  Die Ausnahme fuer das bereits installierte `qwen3.6:35b-a3b-coding-nvfp4` bleibt bestehen,
  jetzt mit Qualitaet und Speicher statt nur Tempo belegt. `qwen3.6:27b-coding-nvfp4` liegt
  ebenfalls nur als NVFP4-Tag lokal vor (keine Alternative installiert) — nicht nachgemessen,
  offener Punkt.
- **Standard-Coder ist seit 2026-08-11 `grug` (grug-27b über MLX), nicht mehr `ornith:35b` —
  aber NUR auf dem Mac.** MLX gibt es nur auf Apple Silicon; auf Peer-Rechner existiert weder
  `mlx_lm.server` noch `grug-server`, dort bleibt `ornith` der lokale Coder. Diese Datei liegt
  auf beiden Maschinen, die Wahl gilt für die, auf der Du sitzt.
  Gemessen gegen zwei Alternativen am selben Testsatz: MLX 17,7 Tok/s einzeln und 28,1 aggregiert
  bei vier gleichzeitigen Anfragen, Ollama 15,3 und serialisiert, llama.cpp 14,1 bei nur 45 von 50
  Treffern. Ollama verweigert Nebenläufigkeit auch bei DICHTEN Modellen, nicht nur bei MoE — für
  eine Worker-Flotte scheidet es damit aus. Zahlen und Herleitung:
  [[messung-2026-08-11-lokale-coder-grug-kat-ornith]].
  **KEIN Dauerbetrieb, Entscheidung des Nutzers vom 2026-08-11 („kein server dauerhaft warm").**
  `pi-worker … grug …` ruft `grug-server ensure` selbst auf, und nach der Arbeit gehört
  `grug-server stop` dazu. Der Preis ist rund eine Minute Ladezeit beim ersten Worker; der Grund
  ist, dass 15 GB dauerhaft belegt Bild- und Videoerzeugung blockieren, die denselben Speicher
  brauchen. Ein LaunchAgent für diesen Server wird NICHT gebaut — wer das für eine Verbesserung
  hält, hat den Trade-off nicht gesehen, nicht die Entscheidung übersehen.
- **Seit 2026-08-13 erledigt `wb-modell-proxy` Start und Leerlauf-Stopp automatisch, auch für
  interaktives `pi`.** launchd hält 127.0.0.1:8080 per Socket-Aktivierung (Job
  `agent-workbench.modell-proxy` — KEIN Widerspruch zur Regel darüber: kein RunAtLoad, kein
  KeepAlive, im Leerlauf läuft null Prozess); die erste Verbindung startet den Proxy, der
  `grug-server ensure` ruft (Backend jetzt Port 8081, alle Sicherheitsprüfungen unverändert),
  nach 20 min Leerlauf `grug-server stop` ausführt und sich selbst beendet. pi's `models.json`
  zeigt unverändert auf 8080. Ein manuelles `grug-server stop` nach der Arbeit bleibt erlaubt,
  ist aber nicht mehr nötig. Fremd gestartete Backends stoppt der Proxy nie
  (`stopForeign=false`); Eigentum entscheidet der Portzustand unmittelbar vor seinem
  ensure-Aufruf — wer ein Backend von zwei Seiten startet, teilt sich die Sperre über
  `wb-belegung`. Konfiguration `~/.config/wb-modell-proxy/backends.json` (neue Backends =
  ein Eintrag dort + ein Socket in der plist). Herleitung und Befunde:
  [[session-2026-08-13-modellproxy]] im Vault.
- **Eine Tokenrate über der Speicherbandbreite ist ein Messfehler, keine Entdeckung
  (2026-08-11).** Für llama-server meldete die Strecke 42,4 Tok/s; bei 16,5 GB Gewichten hätte das
  653 GB/s verlangt, gemessen sind 276. Ursache war die client-seitige Zeitmessung zwischen erstem
  und letztem Stromabschnitt bei einem Server, der Tokens gebündelt schickt. Die
  Bandbreitenrechnung — Gewichte mal Tokenrate gegen die gemessene Leserate — gehört als
  Plausibilitätsprüfung neben jede Durchsatzzahl.
- **Das Kleinere darf gewinnen (2026-08-11, Anweisung des Nutzers — hebt den Zwang aus „Q6_K
  minimum, Q8_0 preferred" auf).** Ist eine kleinere Stufe oder ein kleineres Modell **nicht
  messbar schlechter UND gleichzeitig schneller**, wird sie genommen. Der Punkt darüber gilt
  weiter als Auswahlhilfe für Modelle OHNE eigene Messung; wo gemessen wurde, entscheidet die
  Messung, nicht die Formatregel.
  „Nicht messbar schlechter" ist eine Bedingung mit Zähnen, sonst wird daraus „hat gut
  ausgesehen": derselbe Testsatz, dieselben Bedingungen, und ein Unterschied innerhalb des
  Rauschens zählt als gleich. Bei den 50 Fällen aus `dod-judge/pruef3` ist ein einzelner Fall
  Unterschied kein Abstand. Ohne Messung gibt es keinen Freibrief nach unten.
  Belegender Fall: grug-27b unter MLX bei 4 Bit trifft 49 von 50 und läuft mit 17,7 Tok/s;
  bei 8 Bit trifft es dieselben 49 von 50 und läuft mit 9,9 Tok/s. Die stärkere Quantisierung
  kostete 44 Prozent Tempo und die halbe Nebenläufigkeit, ohne Qualität zu kaufen. Zahlen:
  [[messung-2026-08-11-lokale-coder-grug-kat-ornith]].
- **Auswahlkriterium für NEUE lokale Modelle (2026-08-10, Anweisung des Nutzers): auf diesen Mac
  optimiert, so schnell wie möglich, und mit der höchsten erreichbaren Nebenläufigkeit.** Ein
  Modell wird deshalb nie allein am Einzeldurchsatz beurteilt. Pflichtachsen vor einer Empfehlung:
  (1) MLX gegen GGUF am selben Modell gemessen — MLX ist der Apple-native Weg und war in fremden
  Messungen 15 bis 30 Prozent schneller bei 10 Prozent weniger Speicher, geglaubt wird trotzdem
  nur die eigene Zahl; (2) **Nebenläufigkeit über die Messstrecke
  `~/Knowledge/_meta/messungen/strecken/nebenlaeufigkeit/`**, die beide Endpunkte kennt. Der Grund
  ist gemessen: Ollama verweigert für die Architektur `qwen35moe` parallele Anfragen komplett
  („model architecture does not currently support parallel requests", 2026-08-09) und arbeitet
  seriell, egal was `OLLAMA_NUM_PARALLEL` sagt. Wer lokale Nebenläufigkeit mit einem 35B-MoE
  braucht, nimmt `mlx_lm.server`. Ein Modell ohne gemessene Nebenläufigkeitskurve ist nicht
  bewertet, sondern nur angetestet.
- **Eine abgelehnte oder zusammengebrochene Nebenläufigkeitsstufe wird NIE von Hand nachgefordert
  (2026-08-11).** Der Weg in den GPU-Speichermangel ist auf diesem Mac der Weg in eine
  Kernel-Panik: erst `kIOGPUCommandBufferCallbackErrorOutOfMemory` im Metal-Befehlspuffer, dann
  `completeMemory() prepare count underflow` in `IOGPUFamily`, dann ist der Rechner weg. Zweimal
  in zwei Stunden, beide Male aus `mlx_lm.server`. Die Vorabprüfung hatte die tödliche Stufe
  korrekt abgelehnt, der Folgeauftrag hat sie nachgefordert. Lehnt die Messstrecke eine Stufe ab,
  IST das das Ergebnis („nicht messbar, Grund X") und kein Anlass für einen zweiten Versuch.
  Mechanisch erzwungen von `speicher-sperre.json` und der Notbremse in `sweep.py`, beide ohne
  Umgehungsweg — wer sie lockert, ist ein Mensch. Zweitens: der dort angenommene KV-Bedarf von
  0,11 MiB je Token ist für große Modelle bis zu zehnmal zu niedrig (KAT gemessen: 1,05), eine
  Speicherplanung stützt sich nie ungemessen darauf. Hergang:
  [[incident-2026-08-11-kernel-panik-durch-gpu-speichermangel]].
- **Runtime = whatever runs best per model:** Ollama for its native-engine models (ornith:35b native
  RENDERER/PARSER) + text GGUF + embeddings; **llama.cpp** (`llama-server`, brew — fastest on Apple
  Silicon, handles vision mmproj + Q8 that Ollama can't) for Qwen3.6-VL coding GGUF at Q6/Q8; MLX
  (mflux / mlx_audio) for image/audio. Benchmark (`llama-bench` / tok/s) when unsure.
- **Uncensored/abliterated local coders available:** `huihui_ai/*abliterated*`, Ornith-1.0-35B
  uncensored (heretic GGUF), Qwen3.6-35B-A3B abliterated. Details + current model↔runtime map: vault
  `10-global/pi-local-models-setup.md`.
- **Memory budget (Mac 48 GB unified, Peer-Rechner 32 GB RAM / 12 GB VRAM — diese Datei liegt auf beiden
  Maschinen, die Zahl gilt für die, auf der Du sitzt; welche das ist, sagt der Maschinen-Kopf in
  `~/.claude/CLAUDE.md`):** one big local model at a time. Before starting ANY model, on either
  machine, run `check-resources` first (`~/.local/bin/check-resources`: free VRAM/RAM, GPU processes,
  loaded ollama models, PROTECTED list) — never start a model blind, locally or via `ssh`/`run-on`;
  on conflict the Konfliktregel applies (der Nutzer fragen, nie eigenmächtig killen; full ladder in the
  `regeln/maschinen.md`, Abschnitt Cross-Machine Compute). Before local video generation stop Ollama models (`ollama stop <model>`); image
  gen (~15 GB) coexists with the 9B but not with a 35B under load. Check with `ollama ps`.
