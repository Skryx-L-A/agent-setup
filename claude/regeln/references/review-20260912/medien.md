# regeln/medien.md

Inhalt: Medien-Routing, vollständiger Abschnitt aus CLAUDE.md. Gilt seit: 2026-07-11, Bildweg geändert 2026-09-12.
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

## Bildgenerierung: GPT zuerst (2026-09-12; ersetzt LOCAL-FIRST nur für Bilder)

Entscheidung des Nutzers: Die in GPT/Codex verfügbare Bildgenerierung ist im vorhandenen Zugang
ohne knappes Bildkontingent nutzbar und liefert bessere Ergebnisse als die lokale Bilderzeugung.
Fotos, Illustrationen, Texturen, Mockups, Bildbearbeitung und daraus abgeleitete Varianten gehen
deshalb zuerst über das GPT-Bildwerkzeug. Ein klarer Auftrag läuft mit `gpt-5.6-luna:medium`,
komplexe Komposition, Text im Bild, Art Direction und iterative Sichtkritik mit
`gpt-5.6-sol:high`. Astra bleibt auch hier nur auf ausdrückliche Anweisung erlaubt.

Der lokale Befehl `bild` bleibt Rückfall für Offline-Arbeit, Daten, die die Maschine nicht
verlassen dürfen, oder einen Ausfall des GPT-Wegs. Symbole und einfache Grafiken bleiben Vektorarbeit
nach dem Abschnitt unten. Video, Ton und Transkription bleiben LOCAL-FIRST nach dem folgenden
Abschnitt, bis für ihre konkrete Cloud-Spur Qualität, Kontingent und Werkzeugweg belegt sind.

## LOCAL-FIRST für Video, Ton und Transkription (2026-07-11)

Speech audio, short video clips and transcription are generated with the LOCAL stack by default;
pass this rule into every worker/teammate prompt that might touch those media.
- `video "prompt"` (--hq/--bild img), `tts "text"`
  (Kokoro, ENGLISH default — German models only when the user explicitly asks; `--de` Qwen3-TTS, `--breeze` Breeze TTS 2 (seit 2026-09-10 eingebaut und gemessen: nur Englisch, Echtzeitfaktor 0,83, ~6 s bis zum ersten Wort, Gewichte nichtkommerziell; Vorgabestimme des Companions für Englisch, Deutsch bleibt piper),
  `--expressive` Chatterbox), `stt file.wav` (parakeet default, `--whisper` fallback/timestamps) —
  all in ~/.local/bin, offline-capable. Benchmarked: images rival cloud output; ranking + defaults in
  `~/Knowledge/10-global/local-audio-models.md`.
- Generate real assets instead of stock photos/placeholders. Medien-UI
  app = user's own GUI for the same stack; Draw Things = interactive GUI.
- Cloud video/audio only when local quality is demonstrably insufficient for the concrete task or the user asks — and say so explicitly.

## Symbole und einfache Grafiken von Hand als Vektor (Gewohnheit seit 2026-08)

Ein Symbol, ein Piktogramm oder eine einfache Grafik wird als SVG gebaut und mit
`rsvg-convert` gerastert, nicht als Bild erzeugt. Entstanden waehrend der Download-Sperre vom
07.08.2026 (am 08.08. wieder aufgehoben), geblieben ist sie aus einem eigenen Grund: eine
Vektorzeichnung ist scharf in jeder Groesse, aenderbar und kostet keinen Modelllauf. Fuer
Fotos, Illustrationen und alles Gegenstaendliche folgt dem GPT-Bildweg oben.
