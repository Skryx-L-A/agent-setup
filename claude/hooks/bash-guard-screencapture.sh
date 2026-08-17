#!/bin/bash
# Zweck: blockt jeden `screencapture`-Aufruf, der die Aufnahme NICHT auf einen
#        Ausschnitt begrenzt (-l <windowid> oder -R x,y,w,h).
# Event: PreToolUse, matcher Bash.
# Warum: Stehende Regel (2026-07-25, regeln/aufnahmen.md): "NIEMALS den
#        gesamten Bildschirm aufnehmen -- jede Aufnahme wird exakt auf das
#        gemeinte Fenster begrenzt", Orchestrator UND Worker, beide Maschinen.
#        Durchgesetzt hat das bisher nur `wb-shot`, und zwar nur fuer den
#        eigenen Aufrufweg: wer `screencapture` direkt aufruft, umgeht die
#        Regel vollstaendig. Der Grund fuer die Regel ist nicht Aesthetik --
#        ein Vollbild erfasst alles Nebenherlaufende, also fremde Fenster,
#        Nachrichten, geoeffnete Dokumente.
# Policy: Deny. Erlaubt bleibt genau das, was die Aufnahme technisch begrenzt:
#        -l <windowid> (auch mit einer Fenster-ID aus einer Variablen -- eine
#        ungueltige ID laesst screencapture scheitern, sie faellt nicht auf
#        Vollbild zurueck) und -R x,y,w,h. Alles andere -- der blanke Aufruf,
#        -D <display>, -m (nur Hauptmonitor, aber eben ganz) -- nimmt einen
#        ganzen Schirm auf und wird geblockt.
#
# ENTSCHEIDUNG zum Grenzfall -i / -w / -W (interaktive Auswahl): wird BLOCKIERT.
#        Begruendung: die Regel hat zwei Haelften, und der interaktive Modus
#        verletzt beide. (1) Fensterbegrenzung: `screencapture -i` startet im
#        Rechteck-Modus; ein Druck auf die Leertaste wechselt zur Fensterauswahl,
#        ein weiterer zurueck, und ein Klick auf den Hintergrund nimmt den
#        gesamten Bildschirm auf. Die Begrenzung haengt also an einer
#        Bedienhandlung, nicht am Aufruf -- der Hook kann sie nicht zusichern,
#        und genau das soll er. (2) Fokus: derselbe Absatz der Regel sagt
#        "der FOKUS des Nutzers wird nie verschoben". Ein Agent, der -i aufruft, legt
#        unangekuendigt ein Fadenkreuz ueber den Bildschirm und blockiert die
#        Eingabe, bis jemand klickt oder ESC drueckt. Das ist ein Eingriff in
#        eine laufende Sitzung, kein Screenshot. Wenn ein Mensch selbst einen
#        Ausschnitt waehlen will, macht er das ueber Cmd-Shift-4, ohne Agenten.
#        Der Umweg fuer den Agenten heisst `wb-shot --list` + `wb-shot <muster>`.
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
