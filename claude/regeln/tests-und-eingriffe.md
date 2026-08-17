# regeln/tests-und-eingriffe.md

Inhalt: Tests, die über den eigenen Prozess hinauswirken. Gilt seit: 2026-07-25 bis 2026-07-29.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor ein Test geschrieben oder ausgeführt wird, der die Live-Umgebung, eine
laufende tmux-Session, ein Fenster vom Nutzer, fremde Prozesse oder die Umgebung
(Ton, Kamera, Vollbild) berührt — und bevor eine fremde CLI mit Autonomie-Flags startet.

## Standing rules — Tests und Eingriffe

- **Tests, die in die Umgebung wirken, erst nach Rückfrage (2026-07-28), Orchestrator UND Worker:**
  alles, was über den Bildschirm hinaus wahrnehmbar wird — Ton über Lautsprecher, Sprachausgabe,
  Benachrichtigungstöne, Kamera, Blitzen/Vollbild, alles was Umstehende mitbekommen — wird VORHER
  gefragt, nie einfach ausgeführt. der Nutzer arbeitet oft an Orten mit anderen Menschen. Messaufbauten
  ohne solche Wirkung bauen; geht es nicht, als offenen Punkt benennen statt heimlich doch zu messen.
  Gehört in jedes Worker-Prompt, dessen Aufgabe so etwas berühren kann.
- **Autonomie-Flags dürfen nie eine sichtbare Aktion auslösen (2026-07-28):** `--yes-always`/`--yolo`
  beantworten auch Erststart-Fragen — bei `aider` riss das ein Browserfenster auf. Fremde CLIs immer
  mit `BROWSER=/usr/bin/true` plus harness-eigenen Flags (`--no-show-release-notes --no-browser`)
  starten; `wb-harness-probe` tut das zentral, Registry-Einträge tragen die Flags.
- **Ein fremdes Installationsskript läuft nicht unbesehen (2026-08-09):** vor `curl … | bash` und
  vor jedem `npm i -g`/`uv tool install` eines unbekannten Werkzeugs wird das Skript GELESEN, und
  was es außerhalb des Projekts anfasst, gehört in die Notizen des Harness. Gemessen an jcode: es
  schrieb PATH-Zeilen in `~/.zshenv`, `~/.bashrc` und `~/.profile` und richtete einen LaunchAgent
  mit globaler Tastenkombination ein — beides ungefragt. **`~/.zshenv` ist dabei der teure Teil:**
  zsh liest die Datei bei JEDEM Aufruf, auch nicht-interaktiv, und der veränderte PATH kippte drei
  Testsuiten, weil ein wiederbelebter Pane statt des Test-Stellvertreters das echte Werkzeug traf.
  Nach so einer Installation nachsehen: `~/.zshenv`, `~/.bashrc`, `~/.profile`,
  `~/Library/LaunchAgents/`, und was dazugekommen ist, entweder entfernen (mit Snapshot) oder
  der Nutzer nennen. Verwandt: [[session-2026-08-07-launchd-umgebung]].
- **Tests hängen nie an ausgelieferten Presets oder am Rechnerzustand (2026-07-29):** Ein Testfall,
  der ein echtes Preset als Stellvertreter benutzt („codex ist nicht installiert", „gemini ist
  ungemessen"), prüft den Zustand der Maschine statt den Code — er wird grün oder rot, je nachdem
  was gerade installiert, gemessen oder abgekündigt ist. Heute traf das viermal zu. Immer eine
  eigene Wegwerf-Fixture anlegen. Ebenso: während eines Testlaufs NICHT deployen, das erzeugt
  Fehlschläge, die nichts mit dem Code zu tun haben.
- **Tests fassen nie die Live-Umgebung an (2026-07-25):** Kein Test verändert die ECHTEN
  Konfigurationsdateien (z. B. `~/.claude/workbench/`) und keine LIVE-tmux-Session. tmux-Tests auf
  eigenem Socket (`tmux -L wbtest`), Konfig-Tests mit `HOME=$(mktemp -d)`, und ganz oben im Skript
  `unset TMUX TMUX_PANE` — `$TMUX` schlägt `TMUX_TMPDIR`, sonst redet jeder aufgerufene Helfer mit
  dem Live-Server (gemessen). Braucht ein Test die echte Datei oder die gerade benutzte Session,
  ist der Test falsch gebaut. Hergang: [[incident-2026-07-25-laufende-worker-unsichtbar]].
- **Ein Test STELLT seine Voraussetzung HER, er setzt sie nie voraus (2026-08-04):** Jede
  Bedingung, die eine Prüfung braucht — keine grafische Sitzung, kein Netz, leeres Verzeichnis,
  fehlendes Programm — wird im Test erzwungen (unerreichbare Adresse, `HOME=$(mktemp -d)`, PATH
  ohne den Kandidaten). Ein Test, dessen Ergebnis davon abhängt, ob jemand angemeldet ist oder
  welche Maschine ihn ausführt, wird irgendwann rot, ohne dass etwas kaputt ist — und dann
  gewöhnt man sich an, ihn zu ignorieren. Gemessen an `test-peer-shot.sh`: Der Satz „dieser
  Rechner hat kein KWin/DBus" stimmt auf dem Mac immer und auf peer nur, solange niemand
  angemeldet ist; der Lauf mit laufender KDE-Sitzung meldete drei Fehlschläge ohne Ursache.
  Dieselbe Familie wie feste Socketnamen: beides nimmt die Umgebung an, statt sie zu bauen.
- **Der Prüfling wird an den Testsocket GEBUNDEN, nicht nur der Test selbst (2026-08-04):** Eine
  Shell-Funktion wie `tm() { tmux -L "$SOCKET" "$@"; }` gilt nicht im Kindprozess. Startet ein Test
  ein Programm, das SELBST `tmux` aufruft, landet dieses auf `default` — und `%0` ist auf jedem
  Socket ein gültiger Pane, es gibt also keine Fehlermeldung, nur einen stillen Fehlgriff. Der Weg
  ist ein `tmux`-Schirm vorn im PATH der Testumgebung, der jeden Aufruf auf den Testsocket zwingt
  (Vorlage: `shell/tests/betriebslauf.sh`). Lässt ein Prüfling sich nicht binden, wird die Suite
  mit sichtbarem Grund übersprungen. **Der zuverlässige Weg ist ein Pane des Testservers:** tmux
  setzt jeder Pane-Shell ein `$TMUX`, das auf den erzeugenden Server zeigt, und ein ungeflaggter
  `tmux`-Aufruf des Kindprozesses folgt ihm automatisch. Ein Prüfling, der direkt aus der
  Test-Shell gestartet wird, hat diesen Anker nicht. Anlass: `test-context-guard-backfill.sh`
  startete `context-guard` direkt statt in einem Pane; dessen eigene tmux-Aufrufe fielen auf den
  Standard-Socket und landeten im LIVE-Orchestrator-Pane, wo eine Fertigmeldung als Prompt
  erschien. Derselbe Weg tippt bei einer Kontextschwelle `/compact` in eine fremde, arbeitende
  Session. Hergang: [[incident-2026-08-04-testsuite-tippte-in-live-session]].
- **Ein fester PORT ist derselbe Fehler wie ein fester Socket (2026-08-16, gemessen).** Wer einen
  Dienst prüft, biegt seinen Port auf einen freien hohen um UND bricht ab, wenn dort schon etwas
  lauscht; erst dann darf die Suite laufen. Prozess-Attrappen reichen nicht: die Stopp-Suite des
  Modellservers
  hatte `pgrep` sauber abgeschirmt, aber das Werkzeug sucht seinen Server über `lsof` auf Port 8081
  — die Suite (`shell/tests/test-grug-server-stop.sh`) fand den ECHTEN, laufenden
  15-GB-Modellserver und beendete ihn. Bemerkt wurde es
  erst, weil zwei Sitzungen unabhängig davon rätselten, warum ein Server verschwand; der Gesamtlauf
  einer dritten hat ihn dann noch einmal getroffen. Dieselbe Prüfung gehört vor jeden Test, der
  einen Port, eine Datenbank, einen Cache oder ein Sperrverzeichnis anfasst: die Adresse gehört der
  Maschine, nicht dem Test. Die Fassung mit Umbiegung steht im Repo claude-workbench ab
  Commit `4dff08d`.
- **Dieselbe Klasse trifft die WARTEBEDINGUNG, nur stiller (2026-08-16, dreimal an einem Abend).**
  Ein `pgrep -f`-Muster, das den eigenen Wartelauf mittreffen kann, scheitert nicht — es wartet
  ewig, weil der Watcher sich selbst als „läuft noch" liest. Das Muster wird deshalb so eng
  gefasst, dass es den beobachtenden Prozess ausschließt (eigene PID ausnehmen, `[c]`-Trick
  reicht NICHT, wenn der Text im eigenen argv steht), oder es wird gar nicht über `pgrep`
  gewartet, sondern über die Datei, die die Arbeit erzeugt. Gegenprobe vor dem Warten: das
  Muster einmal laufen lassen und zählen, wie viele Treffer es hat, BEVOR die beobachtete
  Arbeit startet — jeder Treffer dort ist ein Fehlalarm in spe.
- **Ein eigener Socket erbt trotzdem `~/.tmux.conf` (2026-08-04, von zwei Workern unabhängig
  gefunden):** Ein frischer Testserver lädt die installierte Konfiguration mit, samt ihrer
  global gebundenen tmux-Hooks pane-died, pane-exited und after-split-window — und die zeigen per
  absolutem Pfad auf die INSTALLIERTEN Werkzeuge unter `~/.local/bin`, nicht auf die Fassung, die
  der Test prüfen will. Wer das Verhalten dieser Hooks misst, schaltet sie für den Lauf
  ausdrücklich ab; sonst prüft der Test einen anderen Stand als den beabsichtigten.
- **Ein Hintergrundjob wird per PID beendet, nicht durch das Abräumen seiner Umgebung
  (2026-08-04):** Dieselbe Datei startete den Prüfling mit `… &` und räumte im `cleanup` nur
  `tmux kill-server` ab. Der tmux-Server war weg, der Prozess lief weiter — bis zu 22 Sekunden
  über das Testende hinaus, mitten in die nächste Suite hinein, die dann fälschlich als
  Verursacher dastand. Wer einen Hintergrundjob startet, merkt sich seine PID und beendet sie
  im `trap`.
- **Nie in Fenstern des Nutzers testen (2026-07-25, seine Anweisung):** Tests, die in einem Programm
  stattfinden, das dem Nutzer gerade benutzt, und die seine Experience verändern könnten, laufen NIE in
  dem Fenster, das er benutzt. Dafür wird ein eigenes TESTFENSTER geöffnet — bei VSCode ein neues
  Fenster im Hintergrund (`open -g -na "Visual Studio Code" --args --new-window …`; das `-g`
  verhindert den Fokuswechsel), sinnvollerweise mit eigenem Profil/Ordner. Gilt für jede
  GUI-Anwendung, die er offen hat, nicht nur VSCode. Zusammen mit der Regel darüber: eigener
  tmux-Socket, umgeleitetes HOME, eigenes Fenster.
- **Ein Testfenster läuft HINTER seinen Fenstern und nimmt nie den Fokus (2026-08-09, verschärft
  2026-08-10 nach zweitem Verstoß; global und dauerhaft):** ein Test darf ein echtes Fenster
  öffnen. Es startet ohne Fokus, liegt hinter Fenstern des Nutzers, und seine Sicht ändert sich
  dabei NICHT. Verboten: Fokuswechsel, `activate` / `set frontmost` / `AXRaise`, Space-Wechsel,
  Vollbild, und jedes Fenster, das sich vor eines seiner Fenster legt.
  **Der Weg, gemessen:** `open -g` (bzw. `-gj`) startet ohne Aktivierung; in Electron zeigt
  `showInactive()` ein Fenster, ohne es nach vorn zu holen. Fotografiert wird mit `wb-shot`, das
  `screencapture -x -o -l <windowid>` benutzt — **das erfasst genau dieses eine Fenster, auch wenn
  es verdeckt ist, und hebt es dabei nicht an**. Verdecktsein ist also kein Hindernis, sondern der
  Normalfall.
  **Ein eigener Schreibtisch ist KEINE Lösung und wird nicht gebaut (2026-08-10, gemessen):**
  macOS hat keinen unterstützten Weg, ein Fenster programmatisch auf einen anderen Space zu legen
  (nur Fremdwerkzeuge mit abgeschaltetem SIP), und `wb-shot` sieht ohnehin nur Fenster des
  AKTUELLEN Space (`optionOnScreenOnly`) — auf einem anderen Schreibtisch wäre das Fenster nicht
  mehr fotografierbar. der Nutzer hat diesen Weg ausdrücklich freigegeben, falls er nicht geht.
  **Echtes Vollbild ist die eine Sache, die sich nicht verstecken lässt:** macOS legt dafür immer
  einen eigenen Space an und schaltet dorthin. Eine Zusage, die echtes Vollbild braucht, läuft
  deshalb NICHT auf seinem Mac — sondern auf peer über einen VIRTUELLEN Bildschirm, der niemandem
  etwas wegnimmt: `ssh peer 'cd ~/AI/claude-workbench && xvfb-run -a --server-args="-screen 0
  1920x1200x24" bash shell/tests/<suite>.sh'` (10.08. gemessen, dort 17/0). Ohne Xvfb scheitert
  Electron über ssh sofort mit „Could not open the default X display" — dann laufen die Zusagen
  NIRGENDS, und genau das war nach der Umstellung kurz der Fall. Anlass: der Steuerkanal-Aufruf
  „fenster vollbild" (in den Suiten die Kurzform ctl, kein eigenes Werkzeug) in
  `test-app-groessensprung.sh` riss ihm zweimal den Bildschirm weg; der Steuerkanal verweigert
  echtes Vollbild jetzt ohne `AWB_ERLAUBE_ECHTES_VOLLBILD=1`.
  Nach dem Test wird das Fenster wieder geschlossen (`regeln/prozess-hygiene.md`). Gilt für
  Orchestrator und Worker, auf beiden Maschinen, und gehört in jeden Worker-Auftrag, der ein
  Fenster öffnen könnte.
- **Vor jedem Koordinatenklick wird das ZIELFENSTER nach vorn geholt UND gegengeprüft
  (2026-08-09, gemessen):** `cliclick`/CGEvent-Klicks treffen das vorderste Fenster an der
  Bildschirmstelle, nicht das gemeinte. der Nutzer hatte drei Safari-Fenster mit identischen
  Maßen offen; jeder Klick landete in einer Jobbörse, während im Zielfenster sichtbar
  nichts geschah — eine halbe Stunde Fehlersuche am falschen Ende, und Klicks in ein
  fremdes Fenster sind ein Eingriff in seine Arbeit. Richtig: Zielfenster per
  `set index of w to 1` nach vorn, danach die URL/den Titel von window 1 (AppleScript-Objekt,
  kein aufrufbares Werkzeug) ZURÜCKLESEN und erst dann klicken. Umrechnung Bild → Bildschirm über `window.screenX/screenY` und den
  Faktor aus Bildbreite zu Fensterpunkten; die Aufnahme kommt fenstergenau von `wb-shot`
  (siehe `regeln/aufnahmen.md`). Ein Menschentest (Captcha, Schieberätsel) wird nie
  umgangen: Vorgang bis dorthin vorbereiten, der Nutzer löst ihn, danach weiterarbeiten.
- **Tippautomatik und Geheimnisse schließen sich aus (2026-08-13, nach zwei Vorfällen an
  einem Abend):** Eingeblendete Vorschläge — Chromes Passkey-Kasten, macOS-Autofill — legen
  sich über das Zielfeld und schlucken eine eingefügte Zeichenkette; sie landet dann im
  nächsten sichtbaren Feld, und eine Kontrollaufnahme trägt sie in den Sitzungsverlauf.
  Beide Male ist genau das passiert. Deshalb: Geheimnisse zuletzt eingeben, danach KEINE
  Aufnahme, solange ein Wert in einem unmaskierten Feld stehen kann; Vorschlagskästen mit
  Tab umgehen statt mit Escape wegdrücken (Escape schließt die Maske und verschiebt den
  Fokus); Passwörter nur über die Zwischenablage, nie als Argument, Zwischenablage danach
  leeren. Ein sichtbar gewordenes Passwort wird sofort gewechselt.
  **`cliclick kd:cmd t:down` tippt das WORT** — mit gehaltener Befehlstaste wurden daraus
  Cmd+D/O/W/N samt Lesezeichen, Öffnen-Dialog und geschlossenem Tab; für Sondertasten `kp:`
  oder das AppleScript-Kommando "key code". Zwei Prüfklicks auf dieselbe Stelle sind ein Doppelklick und öffnen, was
  darunter liegt. Hergang und die vollständige Liste: [[gui-automatisierung-fallen]].
- **Kein Kill-Muster, das über die eigenen Testprozesse hinausreicht (2026-07-25):**
  `pkill`/`killall`/`kill $(pgrep -f …)` immer so eng fassen, dass nur eigene Prozesse getroffen
  werden — eigener Test-Sessionname oder Socketname IM Muster, besser die selbst gestartete PID
  merken und danach mit `pgrep` gegenprüfen. Ein Muster, das auf einem gemeinsamen Präfix wie
  `wb-` oder `claude` endet, ist nie eng genug. Hergang:
  [[incident-2026-07-25-killmuster-beendete-live-client]].
  **Über SSH trifft das Muster die eigene Befehlszeile (2026-08-04, gemessen):** `ssh host
  'pgrep -f "foo"'` findet den fernen `sshd`/`bash`-Prozess mit, weil „foo" in dessen argv
  steht — ein `pkill -f` in derselben Form beendet die eigene Fernsitzung, und eine Zählung
  meldet Treffer, die es nicht gibt (zwei „laufende Spiele" waren der Prüfbefehl selbst).
  Am Prozess-NAMEN messen (`ps -eo comm=`, `pgrep -x`), nicht an der Kommandozeile.

- **Ein umgelenktes `HOME` isoliert KEINEN Netzzugriff (2026-08-05, gemessen).** Eine Testsuite lief
  mit `HOME=$(mktemp -d)` und griff trotzdem auf die echte zweite Maschine zu: Tailscales MagicDNS
  löst den Kurznamen `peer` systemweit auf, unabhängig von `$HOME`, und ein laufender `ssh-agent`
  authentifiziert über `SSH_AUTH_SOCK`, das die Umleitung nicht anfasst. Der Test meldete sechs
  echte Fremd-Sessions und erwartete vier. **Wer Netzzugriff isolieren will, entfernt das Ziel,
  statt die Umgebung umzubiegen:** kein eingebauter Vorgabewert für eine Gegenstelle, sondern eine
  leere Vorgabe, die ausdrücklich gesetzt werden muss. Kein Test darf sich auf einen automatischen
  Netzzugriff verlassen.
