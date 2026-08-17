# Linux-Fassungen der Medien-Kette

Die vier Werkzeuge in diesem Ordner sind eigenständige Linux/CUDA-Ports der
gleichnamigen Mac-Werkzeuge in `shell/`. Sie wurden mit `diff` gegen die
jeweilige Mac-Fassung verglichen: in allen vier Fällen unterscheidet sich der
Inhalt so stark, dass beide Fassungen aufgenommen wurden, nicht nur eine.
Die CLI (Optionen, Reihenfolge der Argumente, Ausgabepfade) ist bewusst
identisch zur Mac-Fassung gehalten; ausgetauscht ist ausschließlich das
Backend darunter.

## bild

Die Mac-Fassung ruft `mflux-generate-*` auf und nutzt MLX-Modelle unter
`~/AI/models`. Die Linux-Fassung läuft über eine eigene Python-Umgebung
(`~/AI/media-linux/venvs/diffusers`) und einen eigenen Treiber
(`_bild_gen.py`), der die Modelle per `diffusers` auf CUDA lädt, mit
4-Bit-Quantisierung und CPU-Offload, weil die Ziel-GPU nur 12 GB VRAM hat.
Die Modellpfade zeigen auf ein eigenes Verzeichnis (`~/AI/models-linux`), das
absichtlich getrennt von den Mac-Gewichten liegt. Auch Detailschritte wie das
Auslesen der Bildgröße einer Quelldatei laufen anders: die Mac-Fassung nutzt
das mac-eigene Werkzeug `sips`, die Linux-Fassung `ffprobe`. Am Ende öffnet
die Mac-Fassung das Ergebnis mit `open`, die Linux-Fassung mit `xdg-open`.

## stt

Größter Unterschied: Die Mac-Fassung nutzt standardmäßig `parakeet-mlx` und
fällt bei Bedarf auf `mlx_whisper` zurück. Die Linux-Fassung setzt
standardmäßig auf eine bereits vorhandene, CUDA-13-native Installation von
`whisper.cpp` (Modelle liegen schon lokal, kein zusätzlicher Download nötig)
und bietet daneben zwei weitere Engines an, `faster-whisper` und ein
NVIDIA-NeMo-Modell (`parakeet`), die beide über eine eigene Python-Umgebung
laufen. Ein Kommentar im Kopf der Datei hält fest, warum: der ursprünglich
vorgesehene Whisper-Pfad verlangt eine ältere CUDA-Bibliotheksversion, die
auf der Zielmaschine nicht mehr passt.

## tts

Auch hier bleibt die CLI gleich, die Engines darunter sind andere
Pakete: statt der MLX-Audio-Modelle laufen PyTorch/CUDA-native Pakete
(`kokoro`, `chatterbox-tts`, `qwen-tts`) über eine eigene Python-Umgebung
und einen eigenen Treiber (`_tts_gen.py`). Ein Kommentar hält eine
Umgebungs-Falle fest: die Python-Version der virtuellen Umgebung muss 3.12
sein, weil eine der Abhängigkeiten mit einer neueren Version nicht baut. Die
Wiedergabe-Option spielt das Ergebnis mit `aplay` oder `ffplay` ab statt mit
dem mac-eigenen `afplay`.

## video

Die Mac-Fassung nutzt den MLX-Port `ltx-2-mlx`. Die Linux-Fassung nutzt
stattdessen die offizielle CUDA-Pipeline des Modells über `diffusers`
(`LTX2Pipeline`), mit fp8-Quantisierung und Offload, weil die Ziel-GPU nur
12 GB VRAM hat, während das Mac-Werkzeug den gesamten Arbeitsspeicher der
Apple-Silicon-Maschine ausnutzt. Auch die Warnung vor gleichzeitig
geladenen Ollama-Modellen ist angepasst: die Linux-Fassung prüft auf mehr
Modellgrößen, weil hier ein VRAM- statt ein RAM-Konflikt droht.

## peer-code und orch-launch

Diese beiden Werkzeuge haben keine Mac-Fassung und tauchen deshalb nicht in
der Diff-Liste oben auf: Sie leben ausschließlich auf der zweiten Maschine
(Peer-Rechner) und wurden von dort direkt geholt, nicht aus dem Linux-Bündel unter
`~/AI/claude-setup-share/bundle/bin-linux/`.

`peer-code` startet oder übernimmt auf Peer-Rechner selbst eine Claude-Orchestrator-
Sitzung im Werkbank-Stil, in einem gewählten Ordner. Ohne Ordnerangabe fragt
es interaktiv nach, indem es die Unterordner von `~/AI` auflistet. Es wird
von der VS-Code-Werkbank auf dem Mac aus aufgerufen, über ein eigenes
Terminal-Profil für „peer — new session", und reicht die Auswahl an
`wb-code` auf Peer-Rechner weiter.

`orch-launch` startet einen Claude-Orchestrator oder -Worker in die feste
tmux-Sitzung `wb-orch` auf Peer-Rechner und richtet das Werkbank-Raster ein
(Orchestrator groß oben, Worker als Spalten darunter). Nur der allererste
Aufruf in eine leere `wb-orch`-Sitzung erzeugt den Orchestrator selbst;
jeder spätere Aufruf startet einen Worker, den `pi-worker` bereits korrekt
als Worker markiert hat — diese Markierung darf der Aufruf nicht
überschreiben. Ein Kommentar im Kopf der Datei hält fest, dass dieses
Skript bis zum 13.08.2026 ausschließlich auf Peer-Rechner lag und in keinem Repo
stand, weshalb keine Änderung daran nachvollziehbar oder wiederherstellbar
war.

## Was bewusst nicht geholt wurde

`workbench`, ebenfalls auf Peer-Rechner unter `~/.local/bin`, wurde absichtlich
nicht in dieses Verzeichnis übernommen: Das Werkzeug beschreibt sich in
seinem eigenen Kopf als von der VS-Code-Werkbank abgelöst, die ihrerseits
inzwischen von der Electron-Anwendung abgelöst wurde — es ist damit ein
Rückstand aus einer früheren Ausbaustufe, kein aktives Werkzeug.

## Die vier Hilfsdateien

`_bild_gen.py`, `_stt_gen.py`, `_tts_gen.py` und `_video_gen.py` sind die
Python-Treiber, die die vier Shell-Werkzeuge oben aufrufen. Ohne sie läuft
keines der vier Linux-Werkzeuge; sie wurden deshalb unabhängig von der
Diff-Frage in jedem Fall aufgenommen. Jede der vier Dateien trägt im Kopf den
Hinweis, dass sie auf diesem Mac ungetestet ist, weil hier keine NVIDIA-GPU
steckt, und erst auf der Zielmaschine überprüft werden kann.

## Stand

Aufgenommen am 2026-08-17, verglichen gegen den Stand von
`~/AI/claude-setup-share/bundle/bin-linux/` zum selben Zeitpunkt. Diese
Dateien sind ein Abzug von dort, keine gepflegte Kopie mit eigenem
Änderungsverlauf — bei künftigen Änderungen an der Quelle bitte erneut
abgleichen.
