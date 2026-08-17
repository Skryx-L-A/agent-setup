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

## bm, orch-bare, pi, voice-toggle und work

Diese fünf Werkzeuge kamen am 17.08.2026 aus der zweiten Prüfrunde der neuen
Sorte-D-Erkennung dazu: Sie lagen ebenfalls nur auf Peer-Rechner, standen aber nicht
in der ersten, von Hand zusammengestellten Liste.

`bm` ruft die per `uv tool install basic-memory` installierte
Basic-Memory-CLI über den Vault `~/Knowledge` auf. Der Kopf der Datei hält
fest, warum sie überhaupt als eigenes Skript existiert: Die Mac-Fassung
verweist fest auf den Python-Pfad der uv-Werkzeug-Umgebung, und dieser Pfad
ist maschinenspezifisch — auf Peer-Rechner übernimmt der Wrapper stattdessen, was
gerade auf dem `PATH` steht.

`orch-bare` startet, ähnlich wie `orch-launch`, einen Claude-Orchestrator in
einer eigenen tmux-Sitzung, aber ohne einen Auftrag mitzuschicken: Der
Startaufruf bleibt in der Eingabezeile stehen, bis ein Mensch ihn selbst
abschickt. Gedacht ist das Werkzeug für ein VSCode-Remote-SSH-Fenster, in dem
jemand von Hand zusieht.

`pi` ist ein Wrapper um die CLI des Programmier-Agenten „pi", unabhängig von
`nvm` und dem aktuellen `PATH`. Er leitet Inferenz-Anfragen über einen
SSH-Tunnel an eine Ollama-Instanz auf dem Mac weiter, damit auf Peer-Rechner kein
eigenes Modell dafür laufen muss.

`voice-toggle` schaltet eine Sprachaufnahme per Tastendruck an und aus:
Beim ersten Aufruf startet die Aufnahme, beim zweiten stoppt sie, schickt
die Aufnahme an einen lokalen Transkriptionsserver und legt den erkannten
Text in die Zwischenablage. Kein Projekt beansprucht dieses Werkzeug als
sein eigenes; es scheint ein eigenständiges, nirgends sonst verwaltetes
Hilfsmittel zu sein.

`work` hängt eine tmux-Sitzung ein oder legt sie neu an, damit eine
Terminal-Sitzung eine SSH-Trennung übersteht. Das Werkzeug ist vollständig
plattformneutral (kein Linux-spezifischer Pfad oder Aufruf); es liegt trotzdem
hier, weil bislang nur eine Fassung auf Peer-Rechner bekannt ist.

## Was zu anderen Projekten gehört, nicht hierher

Die zweite Prüfrunde fand weitere Werkzeuge auf Peer-Rechner, die zunächst wie
eigene Werkbank-Werkzeuge aussahen, sich bei genauerem Hinsehen aber als
Teil eines ANDEREN, eigenen Repositorys herausstellten. Sie wurden deshalb
nicht in dieses Verzeichnis aufgenommen, nur ihre Zugehörigkeit ist hier
festgehalten:

- `msync-arrive`, `msync-handoff`, `msync-link-env` sind Symlinks auf
  `~/AI/machine-sync/bin/…` und gehören zum Repository
  `<your-github-user>/machine-sync`.
- `project-kit` ist ein Symlink auf `~/AI/project-kit/bin/project-kit` und
  gehört zum Repository `<your-github-user>/project-kit`.
- `unreal-editor` startet den Unreal Editor für ein Projekt namens
  „a project"; das zugehörige Repository ist `<your-github-user>/a project`.
- `another service-ctl`, `another service-pill`, `another service-type` und `another serviced` gehören zum
  Sprach- und Hotkey-Werkzeug „another service". Der lokale Ordner heißt
  `~/AI/a project`, sein Git-Fernverweis zeigt aber auf das Repository
  `<your-github-user>/another service`.
- `launch-odysseus.sh` startet ein Projekt namens „Odysseus", das im
  Wissens-Tresor unter `20-projects/odysseus` dokumentiert ist. Das
  Anwendungsverzeichnis, auf das das Skript fest verweist
  (`~/AI/odysseus`), existiert auf Peer-Rechner zum Zeitpunkt dieser Prüfung
  nicht mehr — ob das Projekt umgezogen oder das Skript veraltet ist,
  wurde nicht weiter verfolgt.

## Ein gemeldeter Kandidat, der sich als Fremdprogramm herausstellte

`ecal` stand in der ersten, von Hand zusammengestellten Liste als
vermutlich eigenes Werkzeug. Der Inhalt der Datei zeigt aber, dass sie der
Einstiegspunkt des PyPI-Pakets `exchange_calendars` ist (`from
exchange_calendars.ecal import main`), bestätigt durch dessen eigene
RECORD-Datei, die genau diese Datei als von ihr installiert aufführt. `ecal`
wurde deshalb nicht aufgenommen.

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

Zweite Prüfrunde, ebenfalls am 2026-08-17: `peer-code` und `orch-launch`
byteweise gegen den aktuellen Stand auf Peer-Rechner verglichen, beide unverändert.
`bm`, `orch-bare`, `pi`, `voice-toggle` und `work` neu aufgenommen (siehe
oben); ihr Inhalt wurde vor der Aufnahme auf Personenbezug geprüft (siehe
Ergebnisdatei der Prüfung).
