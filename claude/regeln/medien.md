# regeln/medien.md

Inhalt: LOCAL-FIRST media, vollständiger Abschnitt aus CLAUDE.md. Gilt seit: 2026-07-11.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor ein Bild, Video, Tonstück oder Transkript erzeugt wird.

## Die Sperre vom 07.08. ist am 08.08. aufgehoben

Vom 07.08. bis zum 08.08.2026 waren jedes lokale Modell und jeder Download untersagt; der Nutzer hat
das aufgehoben („downloads wieder erlaubt"). Der LOCAL-FIRST-Weg unten gilt damit wieder
vollständig — `bild`, `video`, `tts` und `stt` sind benutzbar, Gewichte und Pakete dürfen geladen
werden.

Was aus der Sperrzeit bleibt, weil es sich bewährt hat: **ein Symbol oder eine einfache Grafik
wird von Hand als Vektor gebaut** (SVG, gerastert mit `rsvg-convert`). So entstand am 06.08. das
App-Symbol, und die 32-Pixel-Probe daran war aussagekräftiger als jedes generierte Bild.

## LOCAL-FIRST media (all agents, 2026-07-11)

Any needed media asset — website/landing-page images (hero, illustrations, icons, og-images), product
shots, app icons, speech audio, short video clips, transcription — is generated with the LOCAL stack
by default, never a paid cloud model/connector; pass this rule into every worker/teammate prompt that
might touch media.
- `bild "prompt"` (--schnell/--text/--unzensiert), `video "prompt"` (--hq/--bild img), `tts "text"`
  (Kokoro, ENGLISH default — German models only when the user explicitly asks; `--de` Qwen3-TTS,
  `--expressive` Chatterbox), `stt file.wav` (parakeet default, `--whisper` fallback/timestamps) —
  all in ~/.local/bin, offline-capable. Benchmarked: images rival cloud output; ranking + defaults in
  `~/Knowledge/10-global/local-audio-models.md`.
- Generate real assets instead of stock photos/placeholders — raises quality, costs nothing. Medien-UI
  app = user's own GUI for the same stack; Draw Things = interactive GUI.
- Cloud media ONLY when local quality is demonstrably insufficient for the concrete task (e.g.
  high-end/fast video) or the user asks — and say so explicitly.
