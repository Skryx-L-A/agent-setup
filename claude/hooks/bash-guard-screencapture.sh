#!/bin/bash
# Zweck: seit 2026-08-22 nur noch der interaktive Auswahlmodus (-i/-w/-W),
#        siehe ENTSCHEIDUNG unten. Bis dahin: blockte jeden `screencapture`-
#        Aufruf, der die Aufnahme NICHT auf einen Ausschnitt begrenzt.
# Event: PreToolUse, matcher Bash.
# NICHT REGISTRIERT: Klassifikationslogik seit 2026-08-05 in hooks/lib/
#        screencapture_classify.py, von bash-guard.py (dessen PreToolUse/Bash-
#        Sammelpunkt) importiert und unveraendert ausgefuehrt -- diese Datei
#        traegt nur noch die Original-Begruendung, kein Eintrag in
#        settings.json zeigt hierher.
#
# GEAENDERT 2026-08-22 (Freigabe, woertlich): "Die Maschine gehoert
#        Dir, Du kannst Bildschirmfotos machen, Bildschirmaufnahmen, auch vom
#        ganzen Bildschirm, vollkommen egal, alles Deins, mach wie es am
#        besten funktioniert." Das Vollbild-Verbot unten (Warum/Policy) ist
#        damit AUFGEHOBEN; es steht als Herkunft von `wb-shot` weiter da.
#        Fenstergenau bleibt die bessere Wahl, wo sie ohne Aufwand zu haben
#        ist -- ein Fehlschlag dort ist jetzt ein Grund, aufs Vollbild
#        auszuweichen, statt die Aufnahme zu melden und zu lassen. Wortlaut:
#        regeln/aufnahmen.md.
#
# Warum (UEBERHOLT seit 2026-08-22, siehe oben): Stehende Regel (2026-07-25,
#        regeln/aufnahmen.md): "NIEMALS den
#        gesamten Bildschirm aufnehmen -- jede Aufnahme wird exakt auf das
#        gemeinte Fenster begrenzt", Orchestrator UND Worker, beide Maschinen.
#        Durchgesetzt hat das bisher nur `wb-shot`, und zwar nur fuer den
#        eigenen Aufrufweg: wer `screencapture` direkt aufruft, umgeht die
#        Regel vollstaendig. Der Grund fuer die Regel ist nicht Aesthetik --
#        ein Vollbild erfasst alles Nebenherlaufende, also fremde Fenster,
#        Nachrichten, geoeffnete Dokumente.
# Policy (UEBERHOLT seit 2026-08-22, siehe oben): Deny. Erlaubt blieb genau
#        das, was die Aufnahme technisch begrenzt:
#        -l <windowid> (auch mit einer Fenster-ID aus einer Variablen -- eine
#        ungueltige ID laesst screencapture scheitern, sie faellt nicht auf
#        Vollbild zurueck) und -R x,y,w,h. Alles andere -- der blanke Aufruf,
#        -D <display>, -m (nur Hauptmonitor, aber eben ganz) -- nahm einen
#        ganzen Schirm auf und wurde geblockt.
#
# ENTSCHEIDUNG zum Grenzfall -i / -w / -W (interaktive Auswahl): bleibt
#        BLOCKIERT, auch nach der Freigabe vom 2026-08-22 -- aber jetzt aus
#        einem rein TECHNISCHEN Grund statt dem alten Regelgrund: der Modus
#        legt ein Fadenkreuz ueber den Bildschirm und WARTET auf eine
#        Eingabe (Klick oder ESC). Sitzt niemand davor, haengt der Aufruf,
#        bis ihn jemand abbricht -- das ist ein Automatisierungsproblem, kein
#        Fokus- oder Privatsphaerenproblem. Die alte, jetzt UEBERHOLTE
#        Begruendung stand auf zwei Beinen und ist unten stehengelassen, weil
#        das zweite (Fensterbegrenzung) den heutigen Grund vorwegnimmt:
#        (1) Fensterbegrenzung: `screencapture -i` startet im
#        Rechteck-Modus; ein Druck auf die Leertaste wechselt zur Fensterauswahl,
#        ein weiterer zurueck, und ein Klick auf den Hintergrund nimmt den
#        gesamten Bildschirm auf. Die Begrenzung haengt also an einer
#        Bedienhandlung, nicht am Aufruf -- der Hook kann sie nicht zusichern,
#        und genau das soll er. (2) Fokus (UEBERHOLT als Regelgrund, das
#        Warten selbst traegt die Entscheidung jetzt allein): derselbe Absatz
#        der alten Regel sagt "der FOKUS des Nutzers wird nie verschoben". Ein
#        Agent, der -i aufruft, legt
#        unangekuendigt ein Fadenkreuz ueber den Bildschirm und blockiert die
#        Eingabe, bis jemand klickt oder ESC drueckt. Das ist ein Eingriff in
#        eine laufende Sitzung, kein Screenshot. Wenn ein Mensch selbst einen
#        Ausschnitt waehlen will, macht er das ueber Cmd-Shift-4, ohne Agenten.
#        Der Umweg fuer den Agenten heisst `wb-shot --list` + `wb-shot <muster>`,
#        seit 2026-08-22 ersatzweise auch `screencapture` ohne -i/-w/-W direkt.
#
# Reichweite: erkannt werden auch Aufrufe, die nicht am Zeilenanfang stehen --
#        in einer Pipeline, hinter && / ; / Zeilenumbruch, mit absolutem Pfad
#        (/usr/sbin/screencapture), hinter sudo/env/nohup, in `eval "..."`,
#        in `bash -c "..."` und in einem `ssh <host> '...'`-Kommando (die Regel
#        gilt auf BEIDEN Maschinen; die Pruefung ist rein syntaktisch und
#        braucht dafuer keinen Blick ins entfernte Dateisystem).
#        Ein blosses Vorkommen des Wortes als TEXT (`grep -r screencapture`,
#        `echo "screencapture"`) loest NICHT aus -- entschieden wird nur ueber
#        das Kommando in Kommandoposition, wie bei bash-guard-kill-pattern.
# Default-Deny bei unentscheidbaren Formen: Argumente aus einer nicht
#        aufloesbaren Variablen/Kommandosubstitution ohne literal sichtbares
#        -l/-R, unausgeglichene Anfuehrungszeichen, zu tiefe Verschachtelung.
set -uo pipefail

# Eigenes Verzeichnis robust bestimmen (siehe bash-guard-kill-pattern): ein
# Aufruf ohne Pfadpraefix wuerde die Hilfsdatei sonst unter <skript>/lib/ suchen.
HOOKSELFDIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Interpreter absolut aufrufen (Haertung 2026-07-28, Stress-Befund B02): mit
# gestripptem PATH faende der Hook sonst weder cat noch python3, endete auf 0 --
# also ERLAUBEN. Ein Deny-Hook, der sein Werkzeug nicht findet, blockt.
/usr/bin/python3 "$HOOKSELFDIR/lib/screencapture_classify.py"
exit $?
