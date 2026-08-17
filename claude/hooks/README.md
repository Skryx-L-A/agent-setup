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
