# Hook-Konsolidierung — Stand 2026-08-04

## Nachtrag 2026-08-05: die mittlere Stufe (Rueckfrage statt Ablehnung)

Die acht Guards kannten zwei Antworten: durchlassen oder ablehnen. Seit heute
gibt es die Stufe dazwischen — ein Befehl, der weder harmlos noch verboten ist,
sondern eine Frage wert. Er wird angehalten, erscheint in der Freigabe-Ansicht
der Workbench und laeuft nach einer EINMALIGEN Freigabe durch.

Sie steht als neunte und letzte Pruefung in `bash-guard.py`. Das ist die
tragende Eigenschaft und keine Reihenfolge-Laune: was die acht Guards hart
ablehnen, kommt hier nie an, also kann kein Muster eine bestehende Ablehnung
aufweichen — die Stufe wirkt nur auf das, was heute durchlaeuft. Aus demselben
Grund wird eine Freigabe erst hier gelesen; sie ist nie ein Weg an einem der
acht Guards vorbei.

Eine Freigabe ist an den Befehl im Wortlaut gebunden, dazu Pane und
Arbeitsverzeichnis; sie wird beim Einloesen geloescht (also auch dann
verbraucht, wenn der Befehl scheitert) und laeuft von selbst ab —
`MAX_TTL_SEKUNDEN` in `lib/ask_muster.py` deckelt das hart, unabhaengig davon,
was in der Freigabedatei steht. Erteilt wird sie ausschliesslich von einem
Menschen in der Ansicht; dieses Modul liest nur.

Die Musterliste steht nicht im Code, sondern in den Einstellungen
(`~/.config/agent-workbench/config.json`, Schluessel `askPatterns`).
`STANDARD_MUSTER` in `lib/ask_muster.py` ist die mitgelieferte Vorgabe fuer den
Fall, dass die Datei den Schluessel nicht traegt; eine ausdruecklich leere
Liste schaltet die Stufe ab, eine fehlende Datei nicht.

Belege: `tests/test-ask-muster.sh` (52 Faelle, ohne Programm) und
`shell/tests/test-app-muster.sh` (33 Faelle, ganzer Weg mit echtem Fenster).

### Zwei Nachbesserungen aus dem ersten Betriebslauf (05.08., abends)

**Eine Rueckfrage ueberlebt den naechsten Befehl derselben Pane.** `clear_block()`
lief am Anfang jedes Hook-Aufrufs und raeumte den Merker weg — richtig fuer eine
harte Ablehnung (die ist erledigt, sobald der Worker weitermacht), falsch fuer
eine Frage (die ist erst erledigt, wenn ein Mensch entschieden hat). Ein Worker,
der nach der Rueckfrage irgendetwas anderes tat, loeschte damit seine eigene
Frage aus der Ansicht. Jetzt bleibt sie stehen, bis eine Freigabe eingeloest,
sie abgelehnt oder ihre Frist um ist (`expires_ts` im Merker, dieselbe Dauer wie
die Freigabe). Eine wartende Frage wird von nichts ueberschrieben — auch nicht
von einer harten Ablehnung und nicht von einer zweiten Rueckfrage: die aeltere
gewinnt, weil eine Freigabe am Befehl im Wortlaut haengt und ein Eintrag, der
sich zwischen Lesen und Klicken aendert, eine Zustimmung zu etwas Ungelesenem
waere.

**Ein Eintrag bindet an eine Stelle in der zerlegten Zeile, nicht an Text.**
Die erste Fassung prueft die rohe Befehlszeichenkette — damit hielt schon das
SCHREIBEN ueber einen riskanten Befehl den Guard an (ein Absatz fuer
SESSION-STATE.md, der den git-Aufraeumbefehl als Beispiel nennt). Eine
Sicherung, die bei jeder Dokumentation fragt, erzieht zum Wegklicken. Jetzt
zerlegt die Stufe mit `lib/cmdshell.py` wie die acht Guards darueber und prueft
jede Pipeline-Stufe einzeln: `befehl` gegen den Befehlsnamen, `unterbefehl`
gegen ein GANZES Argument-Token, `muster` gegen die Argumente. Weil eine
Zeichenkette in Anfuehrungszeichen nach der Zerlegung EIN Token ist, trifft
`git commit -m "push --force"` das Token `push` nie. Laesst sich gar nichts
zerlegen, wird gefragt statt geraten — aber nur, wenn ueberhaupt einer der
gesuchten Befehlsnamen im Rohtext steht, dieselbe Bauart wie `FAILCLOSED_RE` in
`snapshot_classify` und `kill_pattern_classify`.

## Nachtrag 2026-08-05: Falsch-Positive statt Default-Deny

An einem Abend haben die Guards fuenfmal eine harmlose Handlung abgelehnt,
jedes Mal mit derselben Begruendung: die Kommandozeile liess sich nicht
zerlegen, also Default-Deny. Die Absicht dahinter bleibt richtig, aber die
Zerlegung war zu grob — ein Wort mit einem Dollarzeichen darin galt pauschal
als unentscheidbar, und der Inhalt eines Heredocs wurde wie Code gelesen.

Geaendert wurde ausschliesslich, WIE fein zerlegt wird, nie WAS als gefaehrlich
gilt. Die fuenf Punkte im Einzelnen:

1. `cmdshell.all_statements()` haelt eine Kommandosubstitution als EIN Token
   zusammen, statt sie an jedem Leerzeichen zu zerreissen. Vorher landete
   `P=$(mktemp -d)` als `P=$(mktemp` in der Variablenkarte.
2. `cmdshell.strip_heredocs()` ist von `snapshot_classify` nach `cmdshell`
   gezogen; `kill_pattern_classify` und `push_gate_classify` benutzen es
   jetzt ebenfalls. Ein Apostroph im Heredoc-Text ist damit kein Grund mehr,
   den ganzen Aufruf zu blockieren.
3. Ein nicht zerlegbares Kommando wird nur noch dann fail-closed behandelt,
   wenn im Rohtext auch tatsaechlich eine einschlaegige Form steht
   (`FAILCLOSED_RE` in `kill_pattern_classify` und `push_gate_classify` —
   `snapshot_classify` und `screencapture_classify` hatten diesen Vorfilter
   schon).
4. Bei `eval` und `<shell> -c` entscheidet nicht mehr, OB im Text eine
   Substitution vorkommt, sondern ob sie an der Stelle des KOMMANDOS steht.
   `bash -c "$CMD"` bleibt geblockt, `bash -c 'echo $(date)'` geht durch.
5. Zwei Aussagen lassen sich jetzt beweisen statt nur vermuten: ein
   Socketname mit literalem Anteil kann nachweislich nicht `default` sein
   (`socket_cannot_be_default`), und ein Ziel unter `$(mktemp)` ist
   nachweislich frisch angelegt (`substitute_fresh_temp`). `$!` zaehlt als
   PID eines Prozesses, den derselbe Aufruf selbst gestartet hat.

Zu jeder dieser Lockerungen steht in den Suiten ein Fall daneben, der die
Grenze festhaelt (Abschnitt 19 in `tests/test-hooks.sh`, der Block
"Falsch-Positive-Runde" in `tests/test-new-guards.sh`, Abschnitt 10 in
`tests/test-guard-parity.sh`). Alle 56 Blockfaelle, die es vor dem Umbau gab,
blocken unveraendert weiter.

Die drei Suiten mit fest eingetragenem `$HOME/.claude/hooks` nehmen den
Pruefling jetzt aus ihrem eigenen Verzeichnis (`tests/..`) und lassen sich
ueber die Umgebungsvariable `HOOKS_DIR` umlenken. Aus `~/.claude/hooks/tests/`
heraus aufgerufen ergibt das denselben Pfad wie vorher.

## Nachtrag 2026-08-05, zweite Runde

Der wichtigste Punkt zuerst, weil er keine Feinheit ist: **der Rumpf jeder
Schleife und jeder Bedingung war fuer ALLE Guards unsichtbar.**
`cs.resolve_command()` las das einleitende Wort als das Kommando, also `do`
oder `then`, und weil kein Guard ein Kommando dieses Namens kennt, wurde der
Rest des Teilbefehls nie angesehen. Gemessen: `for x in a; do pkill -f wb-;
done` und `if true; then pkill -f wb-; fi` gingen glatt durch, obwohl der
nackte Befehl blockiert. Behoben ueber `BLOCK_KEYWORDS`.

Dazu drei Punkte aus der Abnahme:

1. **Eine `for`-Schleife mit rein literaler Werteliste nennt ihre Werte
   vollstaendig.** `cs.expand_literal_for_loops()` setzt den Rumpf je Wert
   einmal ein; blockt einer, blockt der Befehl. Eine Liste mit Expansion
   (`*.sh`, `$(ls)`) bleibt unangetastet und damit unentscheidbar.
2. **Eine Zuweisung gilt erst ab ihrer Stelle.** `cs.assignment_prefixes()`
   ersetzt `collect_assignments()` in allen vier Klassifikatoren. Die alte
   Karte sammelte ueber den ganzen Befehl und loeste in
   `rm -rf $D/unterordner; D=/tmp/x` ein `$D` auf, das zur Laufzeit leer ist —
   die Zeile loescht `/unterordner`. Falsch in die gefaehrliche Richtung.
3. **Eine Variable, die nirgends im Befehl zugewiesen wird, zaehlt an einer
   Toetungs-Stelle nicht mehr als sichere PID.** Vorher war es genau verkehrt
   herum: `kill $CPID` MIT Zuweisung wurde abgelehnt, OHNE durchgelassen.
   Gemessen an fuenfzehn realistischen `kill`-Formen: vier werden neu
   abgelehnt, und keine davon tut, was sie soll.

## Nachtrag 2026-08-05, dritte Runde: eine Klammer hob die Guards auf

`rm -rf <pfad>` wurde abgelehnt. `( rm -rf <pfad> )` lief durch. Zwei Zeichen
genuegten. Die Ursache lag eine Ebene tiefer als der einzelne Guard, naemlich in
der gemeinsamen Zerlegung: `lib/cmdshell.py` kannte `{` und `}` als
Block-Woerter, aber nicht `(` und `)`. In einer Unterschale wurde `(` als
Befehlsname gelesen, der eigentliche Befehl rutschte ins Argument, und
`resolve_command()` lieferte etwas, das kein Guard mehr erkennt.

Vor der Reparatur wurde erhoben statt behauptet. Material waren 73 Befehle aus
dem echten Guard-Verlauf, die heute nachweislich abgelehnt werden, jeder in drei
Formen. In der Form `( C )` liefen 49 davon durch, in der geklebten Form `(C)`
sogar 57. Betroffen waren die Guards aber unterschiedlich, und das ist der
Grund, warum eine einzige Zeile nicht gereicht hat:

- `kill-pattern`, `push-gate`, `screencapture` und `snapshot` zerlegen ueber
  `cmdshell` und fielen in BEIDEN Klammerformen aus.
- `secrets` und `commit-trailer` tokenisieren absichtlich naiv (Whitespace bzw.
  eine Zeichenklasse im regulaeren Ausdruck). Sie hielten `( C )` stand und
  fielen nur bei `(C)` aus, weil dort `(git` ein Wort ist.
- `live-config` und `media-cloud` lesen den Rohtext und waren gar nicht
  betroffen.
- Die Rueckfrage-Stufe hatte sich lokal gegen `( C )` abgesichert, deckte damit
  aber nur die Form mit Leerzeichen ab: 3 von 4 protokollierten Rueckfragen
  liefen als `(C)` durch.

Repariert ist es an der Wurzel. `_quote_aware_prepass()` behandelt eine
unquotete Klammer wie ein `;`, weil bash sie genauso liest: als Befehlsgrenze.
Der naheliegende Weg, `(` und `)` einfach in `BLOCK_KEYWORDS` einzutragen,
reicht nachweislich nicht — er trifft `(rm` gar nicht, laesst in
`(cd /tmp && rm -rf /x)` den Pfad `/x)` stehen statt `/x`, und `cat <(ls /x)`
bleibt unsichtbar, weil `strip_redirections()` das `<(ls` frisst. Als
Trennzeichen loesen sich alle drei Faelle mit derselben Zeile. Fuer `secrets`
und `commit-trailer` kam je eine Wortgrenze dazu, wortgleich im alten Skript
und in der Portierung in `bash-guard.py`.

Die Klammer zaehlt nur, wo bash sie auch als Unterschale liest. `echo "(x)"`,
`echo '(x)'` und `find . \( -name a -o -name b \)` behalten ihre Klammer als
Text oder als Argument; `$( … )` und Backticks erreichen die Stelle ohnehin
nicht, weil `_protect_substitutions()` sie vorher ersetzt. Deshalb sitzt die
Entscheidung im quote-bewussten Vorlauf und nicht spaeter — nach dem
Tokenisieren waere eine geschriebene Klammer von einer ausgefuehrten nicht mehr
zu unterscheiden.

Nach der Reparatur liefen 0 von 73 durch, in beiden Formen. Die Gleichheits-
Suite `tests/test-guard-parity.sh` brauchte dafuer keine Ausnahme. Sie fragt, ob
alte Kette und neuer Einstiegspunkt dasselbe sagen; ob ein Guard heute wie
gestern entscheidet, ist eine andere Frage. Beide fuehren dieselben `lib/`-Module aus,
also landet die Aenderung von selbst auf beiden Seiten. Nur `secrets` und
`commit-trailer` tragen ihre Logik doppelt, und dort wurde die alte Kette
mitrepariert. Die neue, absichtlich geaenderte Entscheidung steht als eigene
Zusage in Abschnitt 21 von `tests/test-hooks.sh`, samt Gegenproben.


Diese Datei ist der Fundort fuer "warum ruehrt hier niemand mehr etwas an" (Punkt E18
der Masterliste). Wer eine Regel in einem der unten genannten alten Skripte
aendert, aendert NICHTS Wirksames — die aktiven Hook-Eintraege in `settings.json` zeigen
auf die neuen, konsolidierten Dateien.

## Retiriert, absichtlich liegen gelassen — NICHT mehr pflegen

Diese Skripte werden von KEINEM Hook-Eintrag in `settings.json` mehr aufgerufen. Sie
bleiben als Beleg und Differenz-Test-Referenz liegen, nicht geloescht.

**Fuer den `PreToolUse`/`Bash`-Matcher** (ersetzt durch `bash-guard.py`, ein Prozess statt
acht, seit 2026-08-04 morgens):
- `bash-guard-secrets.sh`
- `bash-guard-kill-pattern.sh`
- `bash-guard-live-config.sh` — NUR der Bash-Zweig ist hier retiriert; siehe unten, das
  Skript selbst ist fuer den Write|Edit-Matcher weiter aktiv.
- `push-gate-worker.sh`
- `media-cloud-guard.sh` — NUR der Bash-Zweig war ab dem Morgen retiriert; seit dem
  Nachmittag ist das GANZE Skript retiriert, siehe naechster Absatz.
- `bash-guard-screencapture.sh`
- `bash-guard-snapshot.sh`
- `bash-guard-commit-trailer.sh`

Beleg: `tests/test-guard-parity.sh`, 48/48 Faelle gruen (alte Kette vs. `bash-guard.py`
identisch klassifiziert). Gemessen: alte Kette (acht Prozesse) 221,4 ms Median, neuer
Einstiegspunkt 37,8 ms Median (~5,9x). Details im Kopf-Kommentar von `bash-guard.py`.

**Fuer die Matcher `WebFetch` und die MCP-Medien-Konnektoren** (ersetzt durch
`media-cloud-guard.py`, seit 2026-08-04 nachmittags):
- `media-cloud-guard.sh` — komplett retiriert, kein Matcher ruft es mehr auf (weder fuer
  Bash noch fuer WebFetch/MCP).

Beleg: `tests/test-guard-parity2.sh`, 15/15 Faelle gruen. Gemessen: alte Kette
(bash+jq+grep-Schleife ueber bis zu 20 Domains) 53,3 ms Median im haeufigsten Fall
(WebFetch, kein Treffer, voller Scan), neuer Einstiegspunkt 23,9 ms Median (~2,2x).
Details im Kopf-Kommentar von `media-cloud-guard.py`.

## Bewusst NICHT konsolidiert — mit Zahl begruendet

- **`bash-guard-live-config.sh`** bleibt fuer den `Write|Edit`-Matcher aktiv und
  unveraendert. Gemessen: das Original (bash + zwei jq-Aufrufe) braucht 14,0-18,1 ms.
  Ein Python-Umbau desselben Skripts wurde gebaut und gemessen: 25,5-25,8 ms — LANGSAMER,
  weil der reine Python3-Interpreter-Start auf dieser Maschine ~20,5 ms kostet (gemessen
  mit `python3 -c pass`), mehr als das ganze alte bash+jq-Skript zusammen. Der Umbau
  wurde deshalb verworfen, das alte Skript bleibt die aktive, gepflegte Quelle.
- **`sessionstart-baseline.sh`** und `~/Knowledge/_meta/tools/session-context.sh`
  (SessionStart, zwei Skripte) wurden gemessen (105,3 ms bzw. 147,6 ms Median), aber NICHT
  konsolidiert: sie laufen genau einmal pro Session, nicht pro Tool-Aufruf wie Write/Edit
  oder Read — der absolute Zeitgewinn eines Umbaus waere session-weit vernachlaessigbar.
  `sessionstart-baseline.sh` forkt zudem echte externe Binaries (`lsof`, `ollama`, `ps`),
  die sich nicht in einen einzigen Prozess einbetten lassen.

## Ausserhalb der Grenzen dieses Umbaus (liegen in `~/Knowledge`, nicht `~/.claude/hooks`)

- **`~/Knowledge/_meta/tools/hooks/auto-recall.sh`** (`UserPromptSubmit`, feuert bei
  JEDEM Prompt): gemessen 1545,8 ms Median — mit Abstand die teuerste Einzelmessung in
  dieser ganzen Untersuchung, dominiert von `brain search` (Embedding-Modell-Ladezeit),
  nicht von Prozess-Start-Overhead. Eine Konsolidierung im Sinne "mehrere Skripte zu
  einem" haette hier nichts gebracht — das Problem ist Rechenzeit, nicht Prozessanzahl.
  Liegt ausserhalb `~/.claude/hooks/`, daher nicht angefasst; gehoert der Vault-Pflege,
  nicht diesem Auftrag.
- **`~/Knowledge/_meta/tools/hooks/read-tracking.sh`** (`PostToolUse`/`Read`, feuert bei
  JEDEM Read): gemessen 13,1 ms Median — bereits am Prozess-Start-Boden (reines
  grep/sed, kein eigener `python3`-Fork laut eigenem Kommentar im Skript). Nichts zu
  konsolidieren, unabhaengig vom Ort.

## Faustregel fuer's naechste Mal

Ein Python-Umbau lohnt sich nur, wenn das ALTE Skript mehrere zusaetzliche Prozesse pro
Aufruf forkt (mehrfach `jq`, eine Schleife mit `grep`/`printf` pro Zeile, mehrere externe
Skripte nacheinander). Ein einzelnes bash+jq-Skript ohne Schleife liegt auf dieser
Maschine schon bei 10-20 ms — unter dem reinen `python3`-Interpreter-Start (~20 ms) — und
wird durch einen Umbau eher langsamer als schneller. Erst messen, dann entscheiden.

## Stop-Hook für Werkbank-Aufgaben: Wecker am Zugende (2026-09-10, Agents-Plan Bau-Schritt 2)

`stop-aufgabe-zugende.sh` (Event `Stop`) ist der Wecker, den der Hauptagent
einer Werkbank-Aufgabe am Ende jedes Zuges auslöst (docs/AGENTS-PLAN.md,
Abschnitt 3 „Die Sicherung", Abschnitt 8 „Hooks sind Wecker, nie Wahrheit").
Die gesamte Logik liegt in `lib/stop_aufgabe.py`; die Bash-Hülle startet sie
und erzwingt die Fristen. Er tut alles nur, wenn die Sitzung mit
WB_AUFGABE_ID, WB_AUFGABE_PROJEKT und WB_AUFGABE_BASE gestartet wurde —
Fehlt die Kennung, verlässt er sich sofort und lautlos, interaktive
Sitzungen bleiben unberührt. Bei einer Aufgabe liest er Stand und Pfade über
wb-aufgabe zeigen, erkennt am Ende des Transkripts ein Rate-Limit (HTTP 429,
„rate limit", „usage limit", „resets at" — die Reset-Zeit liest er bewusst
nie aus dem Text, die holt der Träger aus wb-budget --json), legt die
Wecker-Datei unter `<base>/.claude/workbench/vorrat/.wecker/<id>` an (eine
Zeile: ISO-Zeit und Grund `limit` oder `zugende`, der Träger sieht sie je
Takt, löscht sie und entscheidet) und schreibt die Verlaufsarten `zugende`,
`limit` und, wenn nichts committet werden konnte, `offen-nicht-committet`
über wb-aufgabe verlauf --von hauptagent. Den Checkpoint-Commit macht er
nur, wenn der Stand `pausiert*`, `wartet auf …` (der Stand, der den Menschen braucht) oder `aufgegeben*`
ist (also auch „aufgegeben (Modell)") oder WB_AUFGABE_SITZUNGSENDE=1
gesetzt ist, und nur die Pfade aus `pfade` — die Einträge müssen relative
Pfade innerhalb des Repos sein; `.`, `..`, leere Einträge und Einträge mit
einem `..`-Segment werden verworfen, nie `git add -A` — im Repo unter
WB_AUFGABE_PROJEKT oder — wenn cwd ein
Worktree desselben Repos ist — im Worktree; kein Push, nie. Er blockiert den
Stop nie (immer Exit 0, nie eine decision-Ausgabe) und läuft nie länger als
zehn Sekunden: `timeout` fehlt auf macOS, darum setzt der Hook-Kern sich
selbst per signal.alarm eine Frist von acht Sekunden und die Hülle legt mit
`perl -e alarm 9` nach — der Alarm überlebt das exec, weil setitimer
prozessweit gilt.

Die Registrierung liegt bewusst NICHT in der lebenden
`~/.claude/settings.json` (dort steht der Companion-Hook unter `Stop` und
bleibt unangetastet), sondern in
`stop-aufgabe-zugende.settings-snippet.json`: Der Orchestrator trägt den
einzigen Eintrag aus dessen `hooks.Stop`-Block als WEITERES Element in das
bestehende `hooks.Stop`-Array der lebenden Einstellungen ein (anhängen, nicht
ersetzen), mit `"timeout": 10` und dem Aufruf
`bash "$HOME/.claude/hooks/stop-aufgabe-zugende.sh"` — der Pfad gilt der
installierten Kopie, wie bei den übrigen Hook-Einträgen. Der Hook ruft
wb-aufgabe aus dem PATH; solange es nicht ausgerollt ist, schreibt er nur
die Wecker-Datei. Die Meldung dafür (und jeder andere stderr des Kerns) wird
von der Hülle an die Logdatei
`<base>/.local/state/wb-stop-aufgabe/<id>.log` angehängt (`base` aus
WB_AUFGABE_BASE, sonst $HOME); die stdout bleibt verworfen, damit nie eine
decision-Ausgabe entstehen kann.

Beleg: `tests/test-stop-aufgabe-zugende.sh` — ohne Kennung passiert nichts;
`zugende` mit session_id und die Wecker-Datei entstehen; ein Transkript mit
429-Zeile erzeugt `limit` samt Grund `limit`; der Commit greift nur bei den
genannten Ständen oder Sitzungsende und nur für die Pfade aus `pfade` (eine
fremde geänderte Datei bleibt uncommittet), im Worktree landet er im
Worktree; leere `pfade` erzeugen `offen-nicht-committet`; ein Transkript
mit 50.000 Zeilen bleibt unter zehn Sekunden; ein git-Schirm färbt die Suite
rot, sobald ein Push aufgerufen würde; ein tmux-Fall auf eigenem Socket
belegt, dass die Wecker-Datei aus der Pane-Umgebung heraus entsteht
(Umgebungsvererbung in tmux, nicht Claude selbst). Je Review-Befund gibt es
einen eigenen Fall: ein `pfade`-Eintrag `.` erweitert den Commit nicht auf
alle Dateien, ein Symlink in `.wecker` wird nicht verfolgt, ein hängendes
git stirbt samt Prozessgruppe mit der Frist, die stderr-Meldung landet in
der Logdatei, ein fehlgeschlagenes `git add` trägt den Grund im
offen-Eintrag, `aufgegeben (Modell)` bekommt den Checkpoint; dazu Robustheit
(fehlendes git, kaputtes JSON, `index.lock` — je Exit 0, Wecker-Datei,
unter zehn Sekunden).

## Drei Prüfungs-Hooks für Werkbank-Aufgaben (2026-09-10, Agents-Plan Bau-Schritt 5)

Drei weitere `PreToolUse`-Hooks, alle nur für Claude-Sitzungen, alle nur
aktiv, wenn eine Umgebungsvariable der Werkbank-Aufgabe gesetzt ist — ohne
sie tun sie nichts, wie beim Stop-Hook oben. Sie sind Wecker und Bremsen,
nie Wahrheit (docs/AGENTS-PLAN.md, Abschnitt 8): jeder blockiert höchstens
das eine Werkzeug, das ihn ausgelöst hat, keiner hält den Prozess
insgesamt an. Läuft bei `ergebnis-beleg-gate.sh` und `testschutz-gate.sh`
die eigene Frist ab (`signal.alarm` im Python-Kern, `perl -e alarm 9` in
der Bash-Hülle, dieselbe Bauart wie `stop-aufgabe-zugende.sh`, weil
`timeout` auf macOS fehlt), kommt keine Ausgabe, und das Werkzeug bleibt
erlaubt (fail-open). Die beiden sind Bremsen gegen Abkürzungen: hinge
einer von ihnen und verweigerte dann, stünde jeder Bash- oder
Write-Aufruf des Workers still, und die eigentliche Prüfung bleibt der
Reviewer-Pass vor der Abnahme. `reviewer-sperre.sh` verweigert dagegen
auch bei Fristablauf, weil es eine Sandbox-Zusage ist (siehe unten). Wie
beim Stop-Hook liegt die Registrierung bewusst NICHT in der lebenden
`~/.claude/settings.json`, sondern je Hook in einem eigenen
`*.settings-snippet.json`; der Orchestrator trägt die Einträge beim
Ausrollen an das bestehende `hooks.PreToolUse`-Array an.

**`ergebnis-beleg-gate.sh`** (Matcher `Write|Edit`, Logik in
`lib/ergebnis_beleg.py`) verweigert eine Ergebnisdatei, solange die
Sitzung keinen Testlauf ausgeführt hat (docs/AGENTS-PLAN.md, Abschnitt 4
„Vergeben und prüfen": „ein Hook verweigert die Ergebnisdatei einer
Claude-Sitzung, solange sie keine Belegdatei gelesen hat … nachgewiesen an
ihren Werkzeugaufrufen, nicht an einem Eintrag, den sie selbst schreibt").
Aktiv nur mit `WB_AUFGABE_ID`. Zwei Ziele zählen als Ergebnisdatei: ein
Pfad unter `~/.pi-workers/results/` (ein Worker; `~` ist das echte `$HOME`
des Hook-Prozesses, geprüft werden Schreibweise und kanonischer Pfad) und
der Ergebnispfad des Hauptagenten (`verlauf.ergebnis.pfad` aus
`wb-aufgabe zeigen <id> --json --base <base>`). Für einen Worker zählt
als Beleg ein ausgeführter `Bash`-Aufruf, von dessen Teilbefehlen einer mit
`test`, `npm test`, `npm run test`, `cargo test`, `pytest`, `python3 -m
pytest`, `go test`, `make test` oder `bash shell/tests/` beginnt oder ein
Testskript mit einer Shell startet; `cd x && bash hooks/tests/test-y.sh`
zählt also. Für den Hauptagenten muss jeder Eintrag aus
`auftrag.gate_commands` ausgeführt worden sein. Ohne `gate_commands` gibt
es nichts zu belegen, dann verweigert der Hook nicht. Ein Ziel, das weder
unter `~/.pi-workers/results/` liegt noch der bekannte Ergebnispfad ist,
bleibt unberührt.

Ausgeführt heißt seit der zweiten Runde (Reviewer-Befund 7): zum
`tool_use` steht ein `tool_result` mit nicht leerer Ausgabe, das entweder
kein Fehler ist oder mit `Exit code N` beginnt. Ein roter Testlauf ist
also gelaufen und darf ehrlich berichtet werden. Eine Verweigerung oder
ein Abbruch trägt dieses Präfix nicht und zählt nicht. Ein `Read` zählt
gar nicht mehr, auch nicht auf eine Datei, die wie ein Testprotokoll
heißt: in der ersten Runde genügte dafür ein leeres `test-empty.log`.

Das Transkript wird auch nicht mehr auf die letzten 8 MB beschnitten; in
langen Sitzungen fiel ein früher Testlauf dort heraus, und das Gate
verweigerte zu Unrecht. Stattdessen schreibt der Hook je Aufgabe und
Transkript eine Zustandsdatei fort
(`<base>/.local/state/wb-ergebnis-beleg/<id>.<hash>.json`). Darin stehen
die Leseposition, die Bash-Aufrufe, die noch auf ihr Ergebnis warten, und
höchstens 2000 ausgeführte Befehle. Jeder Aufruf liest nur, was seitdem
dazukam. Ein ausgetauschtes, gekürztes oder an Ort und Stelle
umgeschriebenes Transkript (erkennbar am geänderten Anfang) wird von vorn
gelesen. Gemessen: ein 12-MB-Transkript mit dem Testlauf in der ersten
Zeile braucht beim ersten Aufruf 34 ms, die Fortschreibung danach 25 ms.
Ob das Transkript selbst echt ist, prüft der Hook nicht. Wer Transkript
oder Zustandsdatei fälscht, muss an einem anderen Schutz scheitern.

Beleg: `tests/test-ergebnis-beleg.sh` mit 28 Fällen. Ohne `WB_AUFGABE_ID`
passiert nichts, ein normaler Pfad bleibt unberührt. Ohne Beleg wird
verweigert, mit einem ausgeführten Testlauf erlaubt. Ein Aufruf ohne
`tool_result`, mit leerer Ausgabe oder mit abgelehntem Aufruf zählt
nicht; ein roter Lauf mit `Exit code 1` zählt. Ein `Read`, auch auf ein
nicht leeres `lauf.log`, zählt nicht. Ein erst später nachgereichtes
Ergebnis zählt über die Zustandsdatei. Der Hauptagenten-Pfad mit
vollständigem Gate-Protokoll wird erlaubt, mit einem fehlenden
Gate-Befehl verweigert, und die Begründung nennt ihn. `Edit` wird wie
`Write` geprüft, ein Lauf bleibt unter zwei Sekunden, und ein tmux-Fall
auf eigenem Socket belegt die Verweigerung aus einem echten Worker-Pane.

**`testschutz-gate.sh`** (Matcher `Bash` und `Write|Edit`, Logik in
`lib/testschutz.py`) sperrt für eine Aufgabe mit `gate_commands` das
Löschen, Umbenennen und Aushöhlen ihrer Tests. Aktiv nur mit
`WB_AUFGABE_ID` und nicht leeren `gate_commands`; ohne verabredete
Gate-Befehle gibt es nichts, das als „die Tests" gilt. Geschützt ist ein
Pfad, der in einem Gate-Befehl genannt wird, samt jedem Ordner darüber und
allem darin. Geschützt ist auch jeder Pfad, der generisch nach Test
aussieht (ein Pfadbestandteil `test`/`tests`/`spec`, oder ein Dateiname
wie `test_x.py`, `x_test.go`, `x.spec.ts`). Jeder Pfad wird vor der
Entscheidung mit `realpath` aufgelöst. Ein Symlink auf einen Test ist
damit selbst geschützt, und ein Pfad, der sich nicht eindeutig auflösen
lässt, wird verweigert (Reviewer-Befund 2).

Auf `Bash` prüft der Hook jede Lösch- und Schreibprimitive (Reviewer-Befund
1): `rm`, `unlink`, `rmdir`, `shred`, `mv` mit Quelle und überschriebenem
Ziel, `cp`, `install`, `ln`, `rsync`, `git rm`, `git mv`, `git checkout`,
`git restore`, `git clean`, `git stash -u`, `git reset --hard`, `find
-delete` und `find -exec`, `truncate`, `dd of=`, `tee`, `sed -i`, `perl
-i`, `ruby -i`, `ditto`, `git worktree remove`, die Archivwerkzeuge `zip`,
`tar`, `unzip` und `cpio` und die Umleitungen `>` und `>>`. Dazu kommt Code in
`python*`, `perl`, `ruby` und `node` (über `-c`, `-e`, Here-Doc oder
Here-String), der eine Schreib- oder Löschfunktion aufruft. Verfolgt
werden `eval`, `<shell> -c` auch als `-lc`, Here-Docs an eine Shell, `$( )`
und Backticks, Wrapper samt ihren Optionen (`nice -n 5`, `env -u X`, `env
-S`) und Befehlswörter aus Variablen. Was sich nicht sicher analysieren
lässt, wird verweigert, und die Begründung nennt die Form. Beispiele sind
`xargs` oder `find -exec` mit einem schreibfähigen Befehl, eine Pipe in
eine Shell oder einen Interpreter, `${IFS}` und ein Ziel aus einer
unbekannten Variablen innerhalb des Arbeitsbaums.

Überschreibende Formen sperren nur, wenn das Ziel schon existiert: `cat >
tests/test_neu.py <<EOF` legt einen neuen Test an und bleibt erlaubt.
Ebenso erlaubt bleiben der Gate-Lauf selbst, `find … -exec grep`, `… |
xargs wc -l`, `while IFS= read …` und `rm /tmp/x-$$`. Für `Write` und
`Edit` auf eine Testdatei, auch über einen Symlink, gilt die Regel der
ersten Runde: verweigert wird nur, wenn der neue Inhalt eine Umgehung
einführt, die im alten Inhalt auf der Platte noch nicht stand (`skip`,
`xit`, `@pytest.mark.skip`, `#[ignore]`, `exit 0` als erste
Inhaltszeile, oder eine Leerung unter 20 % der alten Größe). Das
Hinzufügen und Ändern von Testinhalt bleibt erlaubt, am einfachsten über
das Edit-Werkzeug.

Ein Archiv überschreibt, was es enthält. Vor `tar -x` und `unzip` liest der
Hook deshalb das Archiv selbst, bis 50 MB und 20 000 Dateien. Er sperrt,
sobald eine enthaltene Datei im Zielordner schon existiert und geschützt
ist oder ein Pfad aus dem Zielordner hinausführt. Lässt sich das Archiv
vorab nicht lesen, etwa bei `tar -xf -` oder bei `cpio -i`, das immer von
stdin liest, zählt der ganze Zielordner: liegt er über einem Test oder ist
er selbst einer, wird verweigert. `zip` und `tar -c` sperren, wenn das
Archiv selbst ein vorhandener Test ist; `zip -m` und `tar --remove-files`
sperren, wenn sie einen Test als Quelle löschen würden.

Grenzen: die generische Test-Erkennung sieht nur den Pfad, der gelöscht
wird, nicht den Inhalt eines gelöschten Ordners. `rm -rf src` trifft einen
Test unter `src/` nur, wenn ein Gate-Befehl ihn nennt. Ebenso undurchsichtig
bleiben `patch`, `git apply` und `git am`: sie ändern, was im Patch steht,
und der Hook liest keine Patches. Ein Patch, der einen Test löscht, kommt
also durch; der Reviewer-Pass vor der Abnahme sieht ihn im Diff.

Beleg: `tests/test-testschutz.sh` mit 124 Fällen. Dazu gehören die
Grundfälle der ersten Runde, alle 33 Formen aus dem Reviewer-Pass (R01 bis
R33), 50 weitere Formen (X01 bis X50, davon X31 bis X50 aus der
Nachprüfung) und 21 Positivfälle (P01 bis P21), die erlaubt bleiben müssen.
Zwei Fälle führen `Write` und `Edit` über einen Symlink. Der langsamste
Matrix-Fall braucht 77 ms, und ein tmux-Fall auf eigenem Socket belegt die
Verweigerung aus einem echten Worker-Pane.

**`reviewer-sperre.sh`** (Matcher `Write|Edit|NotebookEdit`, `Bash` und
`Skill`, Logik in `lib/reviewer_sperre.py`) hält die Werkzeug- und
Bash-Muster-Sperre einer Rolle mechanisch nach (docs/AGENTS-PLAN.md,
Abschnitt 4 „Rollen im Team", Absatz „Wie die Sperre hält"), und zwar für
jede Rolle mit `WB_ROLLE=<name>`, nicht nur für den Reviewer. Aktiv nur
mit gültiger `WB_AUFGABE_ID` und gesetzter `WB_ROLLE`; fehlt eins davon,
gibt der Hook nichts aus (Reviewer-Befund 3). Das Profil kommt über
`wb-profil zeigen <rolle> --json`. Schlägt das fehl, wird verweigert:
anders als die beiden Hooks oben ist dies eine Sandbox-Zusage, keine
Beleg-Erinnerung.

Drei Prüfungen. (1) `Write`/`Edit`/`NotebookEdit` nur für Rollen mit
Schreibsperre (`WB_ROLLE == reviewer` oder das Profilfeld `schreibsperre:
true`, die einzige Änderung an `shell/wb-profil`). Erlaubt ist
ausschließlich der eine Ergebnispfad dieses Workers, gelesen aus dessen
Auftragsbuch `auftraege.tsv` (letzte Zeile, Spalte `result`; der
Worker-Name kommt aus der tmux-Sitzung über `lib/rollen.py`) oder
ersatzweise aus `WB_ERGEBNISPFAD`. Er muss kanonisch unter
`~/.pi-workers/results/<worker>/` liegen und darf selbst kein Symlink
sein, auch keiner auf das Ergebnis eines anderen Workers (Reviewer-Befund
5). (2) `Bash` gegen das Profilfeld `bash` als Erlaubnisliste
(Reviewer-Befund 4). Jede Pipeline-Stufe muss auf ein Muster passen, auch
jede Stufe in `$( )`, Backticks, `<shell> -c`, `eval`, einem Here-Doc an
eine Shell und hinter einem Wrapper (`env`, `nice`, `nohup`, `command`,
`builtin`, `exec`, `time`, `sudo`, `xargs`). Liest eine Shell ihr Skript
aus einer Prozess-Substitution (`bash <( )`, `source <( )`), wird
verweigert, weil das Skript erst zur Laufzeit feststeht. Ein Muster ohne `*` passt auf
den Befehl selbst und auf ihn mit weiteren Argumenten. Ein `*` steht für
beliebigen Text, so wie die Profile unter `profile/rollen/` es schreiben:
`git diff *` passt auf `git diff` und `git diff --stat`, nicht auf `git
diffevil`. Ein Muster, das einen Wrapper, `xargs`, `eval`, `source` oder
einen nackten Interpreter (`bash`, `python3 *`) freigeben würde, gibt
nichts frei, und die Verweigerung nennt es. Die Umleitungen `>` und `>>`
sind nur auf den Ergebnispfad und nach `/dev/null` erlaubt. Ein leeres
oder fehlendes `bash`-Feld erlaubt nichts. (3) `Skill` gegen das
Profilfeld `skills`.

Die Frist ist fail-closed (Reviewer-Befund 6). Der Python-Kern schreibt
bei seinem Alarm nach 7 s selbst ein deny. Hängt er trotzdem, beendet die
Hülle nach 8 s seine Prozessgruppe samt Kindern und verweigert. Sie
verweigert ebenso, wenn der Kern oder `perl` fehlt oder der Kern ohne
Entscheidung abbricht. Beides liegt vor der 10-Sekunden-Grenze des
Settings-Eintrags, nach der Claude Code das Werkzeug sonst ohne
Entscheidung laufen ließe. Die Hülle reicht stdin ausdrücklich an den Kern
durch: ein Hintergrundjob bekäme ohne Job-Steuerung `/dev/null`, der Kern
sähe kein Hook-JSON und ließe alles durch.

Grenze: ein Muster wie `git diff *` gibt jedes Argument frei, auch eines,
mit dem das Programm selbst schreibt (`git diff --output=datei`). Die
Argumente eines erlaubten Programms prüft dieser Hook nicht; das bleibt
Sache des Musters.

Beleg: `tests/test-reviewer-sperre.sh` mit 82 Fällen. Dazu gehören die
Grundfälle der ersten Runde und die 28 verschiedenen Formen aus dem
Reviewer-Pass (R01 bis R28; der Pass spricht von 29, seine Tabelle zählt
9 und 19 auf). Es folgen 32 weitere Formen und Positivfälle (X01 bis
X32), darunter Glob-Muster, generische Muster, ein Symlink auf ein
fremdes Ergebnis, eine Funktionsdefinition und `bash <( )`. Fünf Fälle laufen Ende zu Ende durch die Shell-Hülle:
stdin kommt an, ein erlaubter Befehl ist nach 68 ms fertig gelesen, ohne
Aufgabe gibt es keine Ausgabe, ein hängender Kern wird nach 8,2 s
verweigert und samt Kindprozess beendet, und ein abbrechender Kern wird
verweigert.

### Zweite Runde: Löcher in der gemeinsamen Zerlegung (2026-09-11)

Beim Umbau fielen in `lib/cmdshell.py` Löcher auf, die jeden Guard
betrafen, der über diese Datei zerlegt, nicht nur die drei Hooks oben.
Gemessen gegen `bash-guard.py` mit `pkill -f wb-` als Nutzlast gingen
fünf Formen durch, obwohl der nackte Befehl blockiert: `echo "<<X"`,
`true # <<X` und der Here-String `cat <<< x`, jeweils vor einem
Zeilenumbruch, dazu `nice -n 5 …` und `env -u FOO …`. Zwei gleichartige
Formen kamen beim Beheben dazu: ein Kommentar ohne `<<` vor einem
Zeilenumbruch und `env -S 'cmd'`.

Die Ursachen waren drei. Die Here-Doc-Erkennung achtete weder auf
Anführung noch auf Kommentar noch auf `<<<` und verschluckte alles bis zu
einer Zeile `X`, ohne Abschluss also den ganzen Rest. Der Vorlauf machte
das Zeilenende eines Kommentars zu `;`, worauf shlex den Kommentar bis
zum Ende des ganzen Befehls las. Und die Wrapper-Auflösung übersprang nur
Optionen, nicht deren Argumente, und hielt `5` oder `FOO` für den Befehl.

Behoben ist das in der gemeinsamen Datei. `heredoc_split()` erkennt
Here-Docs nur ungequotet und außerhalb von Kommentaren und liefert Rumpf
und Empfänger mit; `strip_heredocs()` ist eine dünne Hülle darum.
Kommentare entfernt der Vorlauf, `tokenize()` liest `#` nicht mehr als
Kommentarzeichen. `WRAPPER_ARG_OPTS` kennt die Wrapper-Optionen mit
Argument, und `ask_muster.py` benutzt dieselbe Tabelle. Neu sind
`command_substitutions()` (achtet auf doppelte Anführung und Arithmetik),
`shell_c_script()`, `interpreter_program()` und `xargs_inner()`. `xargs`
steht bewusst nicht in `WRAPPER_CMDS`, weil `kill_pattern_classify.py`
`pgrep … | xargs kill` am Namen erkennt (Fall G15 in `test-hooks.sh`).
`bash-guard.py` sperrt alle sieben Formen jetzt, belegt in `test-hooks.sh`
Abschnitt 18b; `test-guard-parity.sh`, `test-guard-parity2.sh`,
`test-ask-muster.sh`, `test-new-guards.sh` und `test-stop-aufgabe-zugende.sh`
bleiben grün.

### Nachprüfung: Funktionen, Prozess-Substitution, Unterschale vor einer Pipe (2026-09-11)

Die Nachprüfung (hooks5rev2) fand drei weitere Formen derselben Art. Alle
drei sitzen an der Stelle, an der der Vorlauf eine Klammer zur
Anweisungsgrenze macht. Aus der leeren Klammer einer Funktionsdefinition
`f(){ pkill -f wb-; }; f` wurde `f;;{ …`, und shlex fasste die beiden
Semikola zu dem Token `;;` zusammen, das nicht trennte. Der Befehl im Rumpf
war damit nur ein Argument von `f`. Eine Prozess-Substitution als
Skriptquelle, `bash <(printf 'pkill -f wb-')`, sah aus wie ein nacktes
`bash`, weil `strip_redirections()` das übrige `<` verschluckte. Bei
`(echo pkill -f wb-) | bash` schließlich begann die Anweisung nach der
Klammer mit `|`, und die Pipe hatte für die Wächter keine linke Seite mehr.
Gemessen gingen alle drei an `bash-guard-kill-pattern.sh` und
`push-gate-worker.sh` vorbei, zwei ausgerollten Verbotslisten-Wächtern.

Jetzt zerlegt `tokenize()` jede Folge aus `;` und `|` in ihre echten
Trenner, und `;;`, `;&` und `;;&` stehen in `STATEMENT_SEPS`.
`resolve_command()` überspringt `function f` samt Namen, ebenso `coproc`
(auch `coproc NAME { … }`), das beim Nachziehen als vierte Form derselben
Art auffiel. An der Stelle
einer Prozess-Substitution steht das Stellvertreter-Wort `PROCSUB_TOKEN`.
Liest eine Shell, `source` oder ein Interpreter sie als Skript, liefert
`all_statements()` `[None]`, und jeder Wächter behandelt den Befehl als
unzerlegbar; `process_substitution_script()` nennt die Form beim Namen.
Eine Anweisung, die mit `|` beginnt, bekommt `SUBSHELL_TOKEN` als linke
Stufe. `diff <(sort a) <(sort b)`, `case … ;; esac` und eine harmlose
Funktion bleiben erlaubt. Belegt in `test-hooks.sh`, Abschnitt 18b (HZ10
bis HZ25), über `bash-guard.py` und über beide Hüllen direkt; die
push-gate-Fälle laufen aus einer eigenen Worker-Pane auf dem Test-Socket.


## Skills-Sperre für Agentenzüge (2026-09-14, Agents-Plan Abschnitt 3 und 14)

**`skills-sperre.sh`** (Matcher `Bash`, `Skill`, `Read|Grep|Glob` und
`Write|Edit|MultiEdit|NotebookEdit`, Logik in `lib/skills_sperre.py`,
Registrierung in `skills-sperre.settings-snippet.json`, nicht ausgerollt)
hält die Sperre gegen fremde Skills aus docs/AGENTS-PLAN.md, Abschnitt 3
„Die Sperre", mechanisch nach. Aktiv nur in einem Agentenzug: der Träger
setzt `WB_AGENT_ID` und `WB_WELT` (Vorlage: `agents_skills.skills_umgebung`
in `shell/`). Fehlen beide, gibt der Hook nichts aus. Ist nur eine gesetzt,
die Kennung ungültig oder `WB_SKILLS_JSON` auf eine andere Datei gerichtet,
wird verweigert.

Maßgeblich ist `<WB_WELT>/agents/<id>/skills.json`, das Skill-Verzeichnis
aus docs/AGENTS-SKILLS.md. Fehlt die Datei, ist sie kaputt, gehört sie
einem anderen Agenten oder nennt ein Eintrag einen Pfad außerhalb seiner
Ebene, verweigert der Hook jedes geprüfte Werkzeug, auch ein harmloses
`ls`. Wie die Rollen-Sperre ist das eine Sandbox-Zusage; Frist und Hülle
sind dieselbe Bauart (Kern 7 s, Hülle beendet nach 8 s die Prozessgruppe
und verweigert, fehlender Kern oder `perl` verweigert). stderr geht nach
`<WB_WELT>/agents/<id>/skills-sperre.log`.

Als Skillordner gilt ein Ordner unter einer Skillwurzel: `~/.claude/skills`,
`~/.agents/skills`, `~/.agent-skills`, `<welt>/skills`,
`<welt>/agents/*/skills` und die Bibliothek aus `skills.json`. Dazu kommt in
versteckten Ordnern direkt unter `$HOME`, wo Harnesses und Plugins Skills
ablegen, jeder Ordner mit einer `SKILL.md`. Projektbäume gelten nicht als
Skills, auch wenn sie `SKILL.md` enthalten: dort liegt Arbeitsmaterial, das
ein Agent bearbeiten darf. Für jeden Pfad, den ein Werkzeug berührt:

| Skillordner | lesen, ausführen | schreiben |
|---|---|---|
| eigener (`<welt>/agents/<id>/skills/<name>`) | erlaubt | erlaubt |
| Welt- oder Bibliotheksskill aus `skills.json` | nur bei passender Version | verweigert, nur über `wb-skill vorschlag` |
| jeder andere (Hausskill, Plugin, fremder Agent, nicht verzeichnet) | verweigert | verweigert |

**Gespeicherte Skripte** (docs/AGENTS-SKILLS.md, „Gespeicherte Skripte“) gelten
genauso: `<welt>/skripte`, `<welt>/agents/*/skripte` und die Skriptbibliothek
aus `skills.json` (`skript_bibliothek`) sind Wurzeln, ihre Ordner Einheiten mit
derselben Tabelle; Einträge mit `art: "skript"` müssen unter der passenden
Skriptwurzel liegen. Das Skill-Werkzeug gibt nur Namen mit `art: "skill"`
frei. Belegt in `tests/test-skills-sperre.sh`, Abschnitt 8, mit Repro-Tabelle
(ein gespeichertes Skript mit `rm -rf` ist ohne Kette erlaubt, mit Kette
verweigert; ein Python-Skript bleibt die benannte Grenze).

Ein `skills.json` unter `<welt>/agents/*/` ist gegen Schreibzugriffe über Pfade gesperrt
(Umleitung, `Write`, `Edit`, schreibende Befehle): sonst trüge sich ein Agent einen nicht
verzeichneten Bibliotheksskill selbst ein. Schreiben darf es nur `wb-skill`.

Die Version ist dieselbe SHA-256 wie in `agents_skills.files_version`;
`shell/tests/test-wb-agents-skills.py` hält beide Rechnungen gleich. Eine
Die Wurzeln der Hausskills und die Skillwurzeln anderer Agenten sind ganz
gesperrt, auch für `ls` und `find`; Welt-, eigene und Bibliothekswurzel
lassen sich auflisten, ihre Skills gelten wie in der Tabelle.

Im Bash-Befehl prüft der Hook ausgeführte Pfade, die Skriptdatei einer
Shell oder eines Interpreters, `source` und `.`, jedes Pfadargument (bei
`rm`, `mv`, `cp`-Ziel, `tee`, `sed -i` und ähnlichen als Schreibzugriff),
Aus- und Eingabeumleitungen (`bash < datei` gilt als Skriptaufruf), `cd`
und Globs in Skillwurzeln. Verfolgt werden `$( )`,
Backticks, `eval`, `<shell> -c`, Here-Docs an eine Shell, Wrapper und
`xargs` über `lib/cmdshell.py`. Variablen löst er aus Zuweisungen im Befehl
und aus der eigenen Umgebung auf, die der Harness auch dem Befehl mitgibt.
Ein Skriptpfad mit Kommandosubstitution (`bash "$(git rev-parse
--show-toplevel)/x.sh"`) ist nicht prüfbar und wird verweigert. Ein Befehl,
der Skills nennt und nicht zerlegbar ist, ebenso. Das Skill-Werkzeug ist
nur für Namen aus `skills.json` frei.

**Skripte unter denselben Regeln.** Ruft ein Befehl ein Shell-Skript eines
eigenen oder verzeichneten Skills auf (`bash|sh|zsh|dash|ksh <datei>`,
`source`, direkt mit Shell-Shebang), liest der Hook die Datei (höchstens
512 KB, kein Symlink) und setzt wörtliche Aufrufargumente für `$1` bis
`$9`, `$@` und `$*` ein. Den Inhalt prüft er wie einen direkten Befehl:
mit sich selbst (ein Skript, das einen Hausskill aufruft, fällt auf) und
mit der Prüfkette neben ihm, `bash-guard.py`, `testschutz-gate.sh` und
`reviewer-sperre.sh`, soweit vorhanden, je 2,5 s. Deren deny, `ask` oder
Exit 2 wird zur Verweigerung am Aufruf. Die Kette bekommt
`WB_SKILLS_SPERRE_KETTE=1`, damit nichts im Kreis prüft. Belegt in
`tests/test-skills-sperre.sh`, Abschnitt 5:

| Fall | Form | bash-guard | Testschutz | Sperre ohne Kette | Sperre mit Kette |
|---|---|---|---|---|---|
| R1 | `rm -rf <geschützt>` direkt | deny | allow | allow | allow |
| R2 | `bash scripts/wipe.sh` (dasselbe `rm -rf` im Skript) | allow | allow | allow | deny |
| R3 | `scripts/wipe.sh` direkt (Shebang bash) | allow | allow | allow | deny |
| R4 | `source scripts/wipe.sh` | allow | allow | allow | deny |
| R5 | `sh scripts/wipe-arg.sh <geschützt>` (`rm -rf "$1"`) | allow | allow | allow | deny |
| R6 | `sh scripts/wipe-arg.sh <nicht vorhanden>` | allow | allow | allow | allow |
| R7 | `rm tests/test_kern.py` direkt (Gate-Pfad) | allow | deny | allow | allow |
| R8 | `sh scripts/tests-weg.sh` (dasselbe `rm` im Skript) | allow | allow | allow | deny |
| R9 | `sh scripts/ruft-haus.sh` (Hausskill im Skript) | allow | allow | deny | deny |
| R10 | `sh scripts/ok.sh` | allow | allow | allow | allow |
| R11 | `ziel=$(…); rm -rf "$ziel"` direkt | deny | deny | allow | allow |
| R12 | `sh scripts/dynamisch.sh` (dasselbe im Skript) | allow | allow | allow | deny |
| R13 | `bash -c "$(cat scripts/wipe.sh)"` | deny | deny | deny | deny |
| R14 | `sh < scripts/wipe.sh` (Skript über stdin) | allow | allow | allow | deny |
| G1 | `python3 scripts/wipe.py` (`shutil.rmtree`) | allow | allow | allow | allow |
| G2 | Skill-Skript ruft ein Projektskript mit `rm -rf` | allow | allow | allow | allow |

Die Spalten „bash-guard" und „Testschutz" sind der jeweilige Hook allein,
die beiden Sperrspalten die Skills-Sperre mit Agentenumgebung und laufender
Aufgabe; direkte Befehle prüft die Sperre nicht nach, dafür sind die
anderen Hooks selbst registriert.

Grenzen, wo keine Prüfung möglich ist:

- **Nicht-Shell-Skripte** (G1): Python, Perl, Node und andere Interpreter
  lesen ihren Code selbst; die Bash-Regeln passen nicht darauf. Der Hook
  prüft nur, dass das Skript zu einem erlaubten Skill gehört.
- **Skripte außerhalb von Skills** (G2): geprüft wird nur der Inhalt eigener
  und verzeichneter Skill-Skripte, nicht jedes Skript, das diese aufrufen.
- **Laufzeitinhalt:** Was ein Skript erst beim Laufen erzeugt, herunterlädt
  oder aus einer Datei außerhalb des Skills liest, sieht die Prüfung nicht;
  wo die Wächter solche Formen erkennen (R11 bis R13), verweigern sie auch
  im Skript.
- **Pfade aus einer Pipeline:** Was erst ein vorheriger Befehl als Pfad
  ausgibt (`find <bibliothek> -name SKILL.md | xargs cat`), sieht der Hook
  nicht; nur die fremden Wurzeln selbst sind dafür ganz gesperrt.
- **Positionsargumente** werden nur wörtlich eingesetzt; `shift`, `getopts`
  und Variablen aus Argumenten folgt die Prüfung nicht.
- **Skill-Werkzeug:** freigegeben wird der Name. Welcher Ordner hinter dem
  Namen geladen wird, bestimmt der Harness; der Träger muss ihn auf die
  Pfade aus `skills.json` richten.
- **Code statt Pfad:** Schreibt ein Interpreter-Einzeiler (`python3 -c
  "open('skills.json','w')"`) oder ein Programm aus eigener Logik in einen
  Skillordner, sieht der Hook keinen Pfad; das bleibt Sache der Weltgrenze.
  Ebenso das Profil `agent.json`, dessen `skills`-Liste die Bibliotheksskills
  bestimmt: es schützen die Rechte-Hooks, nicht diese Sperre.
- **Eigene Skills** prüft der Hook ohne Version, weil der Agent sie selbst
  ändert. Die Weltgrenze und die Sandbox des Laufs bleiben die eigentliche
  Grenze für alles, was ein Skript zur Laufzeit tut.

Beleg: `tests/test-skills-sperre.sh`, eigene Kopie der Hooks, eigenes HOME,
eigene Welt und Bibliothek, Snapshot-Guard mit eigener Konfiguration.


## Profil-Sperre für Agentenzüge (2026-09-14, Agents-Plan Abschnitt 3 und 8)

**`profil-sperre.sh`** (Matcher `*`, Logik in `lib/profil_sperre.py`,
Registrierung in `profil-sperre.settings-snippet.json`, nicht ausgerollt)
hält die Sperre aus docs/AGENTS-PLAN.md, Abschnitt 3 „Die Sperre", und
Abschnitt 8, Regel 5 „Kein Eingriff außerhalb der Welt", mechanisch nach.
Aktiv nur in einem Agentenzug mit `WB_AGENT_ID` und `WB_WELT`; die übrige
Umgebung liefert `agents_skills.profil_umgebung` (`WB_AGENT_PROFIL`,
`WB_WELT_PROJEKT`, `WB_AGENT_WORKTREE`, `WB_AGENT_TMP`), dazu aus der
Skills-Umgebung `WB_SKILL_PFADE`, `WB_SKILL_BIBLIOTHEK`, `WB_SKRIPT_PFADE` und
`WB_SKRIPT_BIBLIOTHEK` (gespeicherte Skripte, lesbar wie Skills). Fehlen beide
Kennungen, gibt der Hook nichts aus. Halbe Umgebung, ungültige Kennung,
`WB_AGENT_PROFIL` auf eine andere Datei, ein fehlendes, kaputtes oder
fremdes `agent.json`, eine nicht ladbare oder leere Hausliste und ein
Projektordner `/` oder `$HOME` verweigern jedes Werkzeug. Frist und Hülle
wie bei Rollen- und Skills-Sperre (Kern 7 s, Hülle 8 s, fail-closed); stderr
nach `<WB_WELT>/agents/<id>/profil-sperre.log`.

Maßgeblich ist `<WB_WELT>/agents/<id>/agent.json`, geprüft in drei Stufen:

1. **Werkzeugliste** `tools`: jedes andere Werkzeug wird verweigert, auch
   `Skill`, `Task`, `WebFetch` und MCP-Werkzeuge. `MultiEdit` zählt als
   `Edit`.
2. **Bash-Muster** `bash`: jede Stufe, auch in `$( )`, Backticks, `eval`,
   `<shell> -c`, Here-Docs an eine Shell, hinter Wrappern und in `xargs`,
   muss auf ein Muster passen. Die Mustersprache ist die der Rollen-Sperre
   (`reviewer_sperre.muster_passt`, auf Basisnamen oder vollen Aufruf);
   generische Muster (`bash`, `python3 *`, `env *`) geben nichts frei. Frei
   sind Shell-Bausteine ohne eigene Wirkung (`set`, `echo`, `printf`,
   `test`, `[`, `read`, `export` …), Kontrollwörter (`if`, `while`, `for`,
   `case`) und im selben Befehl definierte Funktionen; deren Rümpfe prüft der
   Hook wie jeden Befehl. `sudo`, `doas`, `su` und `pkexec` sind gesperrt.
   Zusätzlich gilt die **Hausliste** aus `wb-profil-gesperrt.json`, gelesen
   über `wb-profil` auf dem `PATH`, unabhängig vom Muster: eine
   Programmregel trifft den Programmnamen (Basisname, NFKC, ohne Groß- und
   Kleinschreibung) und ihre `erfordert`-Teile die Argumente, ein
   Kurzoptionsbündel auch zerlegt (`rm -r -f`). Eine Musterregel
   (`.claude/settings`, `--dangerously-skip-permissions`) trifft den ganzen
   Befehl. Ein Programmname im Argument (`git commit -m "kill"`) zählt nicht.
3. **Weltgrenze und Kontextgrenze** für Bash-Pfade (Argumente, Aus- und
   Eingabeumleitungen, `cd`, ausgeführte Programme, Arbeitsverzeichnis) und
   für `Read`, `Write`, `Edit`, `Glob` und `Grep`:

| Zugriff | erlaubt unter |
|---|---|
| lesen | Projektordner, Worktree, Weltablage, eigenes Temp-Verzeichnis, Skill- und Skriptpfade und beide Bibliotheken, `~/Knowledge`, `~/.local/bin` |
| ausführen | wie lesen, dazu `/bin`, `/usr/bin`, `/usr/sbin`, `/sbin`, `/usr/local/bin`, `/usr/libexec` und die Ordner aus `PATH` außerhalb von `$HOME` |
| schreiben | im Projektordner nur `work/`, dazu Worktree (`WB_AGENT_WORKTREE`, der private Arbeitsordner mit dem git-Worktree darin), eigenes Agentenverzeichnis, eigenes Temp-Verzeichnis; Hauptagent zusätzlich `~/Knowledge` |
| nie schreiben | in der Weltablage alles außer dem eigenen Agentenverzeichnis; dort `agent.json`, `skills.json`, `history.json`, `runtime.json`, `postfach/`; überall `freigaben.json`, `traeger.json`, `zugaenge.json`, `mail-versand.jsonl` und alles in einem `.git`-Ordner oder die `.git`-Datei eines Worktrees |

Die **Kontextgrenze** `context_limit` ist ein Satz. Der Hook liest daraus nur
Pfade: Text in Backticks und Wörter, die mit `/`, `~/` oder `./` beginnen;
relative Angaben gelten unter dem Projektordner. Diese Pfade sind auch zum
Lesen gesperrt. Der Projektordner ist bei einer Projektwelt der Ordner über
`.werkbank/agents`, bei der globalen Welt `~/AI`.

Ein Bash-Argument gilt als Pfad, wenn es absolut ist und sein erster
Bestandteil existiert (`/api/v1` in `grep` ist keiner), mit `~`, `./` oder
`../` beginnt oder im Arbeitsverzeichnis existiert; bei schreibenden
Befehlen (`rm`, `mv`, `cp`-Ziel, `touch`, `tee`, `sed -i` …) jedes Wort.
Variablen löst der Hook aus Zuweisungen im Befehl und aus seiner Umgebung
auf. Ein Schreibziel oder Programm aus einer Variablen, die erst zur Laufzeit
feststeht (Schleifenvariable, `read`, `$1`), und ein Ziel mit
Kommandosubstitution werden verweigert.

**Zugänge der Welt (15.09.2026).** Liegt in der Weltablage `zugaenge.json`
und hat der Träger die Zugänge im Zug bereitgestellt (`WB_ZUGAENGE` nennt den
Zugangsordner mit `<name>/` und den Hüllen `ssh`, `scp`, `rsync`), erlaubt die
Sperre `ssh <name> <befehl>`, `scp` und `rsync` mit diesem Namen als Ziel —
nur als nacktes Programm, ohne Option hinter dem Namen, ohne Wrapper, `PATH`
oder `hash`; der entfernte Befehl geht durch die Hausliste. Der Zugangsordner
ist für Read, Grep, Glob und Bash-Pfade gesperrt, `zugaenge.json` für jedes
Schreiben. Ohne Bereitstellung gibt eine Welt mit Zugängen nichts frei
(`docs/AGENTS-SPERREN.md`, Abschnitt „Zugänge der Welt").

**Projekt und Web-Werkzeuge (15.09.2026).** Der Träger bindet das Projekt der
Welt (`WB_WELT_PROJEKT`) nur lesbar in den Zug ein und seinen Ordner `work/`
beschreibbar; die Sperre kannte den Projektordner schon, ohne Einbindung sah
der Zug ihn nur nicht. `WebFetch` und `WebSearch` stehen auf der Positivliste
der Werkzeuge und greifen nur, wenn das Profil sie nennt; ein Pfad hängt an
ihnen nicht, die Weltgrenze bleibt unberührt. Das Netz bekommt der Zug
weiterhin nur über die Zugänge der Welt, die seit demselben Tag drei Arten
haben: `ssh`, `web` (nur Netz) und `mail` (Passwortdateien und Hüllen der
lesenden Postfachwerkzeuge `<ein eigenes Mailwerkzeug>`, `<ein eigenes Mailwerkzeug>` im Zugangsordner). Die Hülle
läuft über das normale Bash-Muster des Profils (`<ein eigenes Mailwerkzeug> *`); die Passwortdatei
liegt im Zugangsordner und ist damit wie ein ssh-Schlüssel gesperrt
(`tests/test-profil-sperre.sh`, Fälle 8m bis 8o). `<ein eigenes Mailwerkzeug>` und `msmtp`
bleiben auf der Hausliste: über einen Zugang wird nie gesendet.

**Mail senden (16.09.2026).** `<ein eigenes Mailwerkzeug> senden …` erlaubt die Sperre nur,
wenn der Agent in `freigaben.json` der Welt eine gültige Freigabe `email`
hält; dann ersetzt die Freigabe das Bash-Muster, eine `--von`-Adresse muss in
ihr stehen. Ohne Freigabe verweigert sie mit dem Hinweis auf `wb-welt freigabe`
(Mensch) und `freigabe.weitergeben` (Hauptagent). Gesendet wird nicht im Zug,
sondern vom Controller außerhalb der Sandbox; `mail-versand.jsonl` steht mit
`freigaben.json` auf der Liste der Dateien, die ein Agent nie schreibt
(`tests/test-profil-sperre.sh`, Abschnitt 10; `docs/AGENTS-SPERREN.md`,
„Mail senden“).

**Worktree je Agent (16.09.2026).** Im Projekt schreibt die Sperre nur noch
in `work/`; am Projekt arbeitet ein Agent in seinem eigenen git-Worktree auf
`agent/<id>` im privaten Arbeitsordner (docs/AGENTS-TRAEGER.md, „Worktree je
Agent“). Für `git` gilt zusätzlich zu den Mustern: `git merge` nur für
Teamleiter (Zweige `agent/<id>` von Mitgliedern des eigenen Teams laut deren
`agent.json`) und den Hauptagenten (jeder Agentenzweig), ohne `-s`; kein
`git worktree`, kein `git switch`, `git checkout` nur als
`git checkout -- <pfade>`; `git rebase` nur mit harmlosen Optionen (kein
`--exec`, kein `-i`) und ohne zweiten Zweig; keine globalen Optionen `-c`,
`--config-env`, `--exec-path`, `--git-dir`, `--work-tree`, `--namespace`. Kein
Befehl setzt, exportiert oder entfernt eine `GIT_*`-Variable (auch nicht
`env -i`, `env -u` oder `exec -c` vor `git`): der Träger setzt sie über die
Einstellungsdatei des Zuges und schaltet damit Hooks, fsmonitor und Editor ab.
`git push` bleibt auf der Hausliste (`tests/test-profil-sperre.sh`, Fall 9).

**Prüfkette.** Die Profil-Sperre steht in der `PRUEFKETTE` der
Skills-Sperre. Der Inhalt eines Skill-Skripts wird damit auch gegen
Werkzeugliste, Muster, Hausliste und Weltgrenze geprüft
(`tests/test-profil-sperre.sh`, Abschnitt 6):

| Fall | Form | Profil-Sperre allein | Skills-Sperre, Kette ohne Profil | Skills-Sperre mit Kette |
|---|---|---|---|---|
| P1 | `curl …` direkt | deny | allow | allow |
| P2 | `sh scripts/curl.sh` (curl im Skript) | allow | allow | deny |
| P3 | `sh scripts/nach-draussen.sh` (touch außerhalb) | allow | allow | deny |
| P4 | `sh scripts/push.sh` (git push im Skript) | allow | allow | deny |
| P5 | `sh scripts/status.sh` (if + git status) | allow | allow | allow |
| P6 | `sh scripts/ok.sh` (set, echo) | allow | allow | allow |
| P7 | `sh skripte/curl-skript/curl-skript.sh` (gespeichert, curl) | allow | allow | deny |
| P8 | `sh skripte/ok-skript/ok-skript.sh` (gespeichert) | allow | allow | allow |
| P9 | `sh <skriptbibliothek>/lib-status/lib-status.sh` (git status) | allow | allow | allow |

Der Aufruf `sh <skill>/scripts/x.sh` passt in P2 bis P4 auf das Muster
`sh */scripts/*.sh`, der eines gespeicherten Skripts in P7 bis P9 auf
`sh */skripte/*/*.sh`; verweigert wird erst, was das Skript tut.

Weltgrenze, belegt in Abschnitt 5 derselben Suite (Auszug): Lesen außerhalb
(`cat <draußen>/geheim.txt`, `ls /etc`, `cd /etc`, `../../` aus dem Worktree)
wird verweigert, `~/Knowledge` und `~/.local/bin` sind lesbar, beschreibbar
nur für den Hauptagenten beziehungsweise nie. `cp ~/Knowledge/note.md
<worktree>/` ist erlaubt, `cp <worktree>/a.txt <draußen>/` nicht. `/tmp` ist
ohne `WB_AGENT_TMP` nicht beschreibbar. Das eigene Agentenverzeichnis ist
beschreibbar, `agent.json`, `skills.json` und das Postfach darin nicht; fremde
Agentenordner, `kanal.jsonl`, `freigaben.json` und `traeger.json` nie. Die
Kontextgrenze sperrt `secrets/` im Projekt und `~/.ssh` auch für `Read` und
`Glob`.

Grenzen, wo keine Prüfung möglich ist:

- **Code in Interpretern und Programmen:** Was `python3 skript.py`,
  `make`, Git-Hooks oder `find -exec` intern ausführen oder schreiben, sieht
  der Hook nicht; er prüft den Aufruf gegen das Muster und dessen
  Pfadargumente.
- **Pfaderkennung ist eine Näherung:** ein relatives Wort, das nicht
  existiert und keine `..` enthält, gilt beim Lesen nicht als Pfad; ein
  absolutes Wort, dessen erster Bestandteil nicht existiert, ebenso nicht.
  `Glob` und `Grep` werden an ihrem Ausgangsordner gemessen.
- **Kontextgrenze in Worten** („keine Produktionsdaten") setzt kein Hook
  durch; nur genannte Pfade.
- **Laufzeit:** Umgebungsvariablen und Arbeitsverzeichnis sind die des
  Hooks und des Werkzeugaufrufs; was ein früherer Befehl verändert hat,
  kennt der Hook nicht.
- **Shell-Bausteine** sind frei; ihr Schreiben über Umleitungen prüft der
  Hook, ihre Argumente nicht.
- Die Durchsetzung auf Prozessebene (Dateirechte, Sandbox des Laufs) bleibt
  die eigentliche Grenze; dieser Hook ist die Sperre des Harness-Wegs.

Beleg: `tests/test-profil-sperre.sh`, eigene Kopien der Hooks und von
`wb-profil` samt Hausliste, eigenes HOME, eigene Welt.
