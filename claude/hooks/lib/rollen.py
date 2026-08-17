#!/usr/bin/env python3
# Woher die Rolle eines Panes kommt.
#
# BEFUND, der diese Datei ausgeloest hat (Durchsicht 2026-08-07, gemessen auf
#        eigenem Socket): `@wb_role` ist eine tmux-Pane-Option, und der
#        Bewachte darf sie selbst schreiben. Ein Worker, der
#        `tmux set -p -t <pane> @wb_role worker` auf den Orchestrator-Pane
#        anwendet, darf danach in dessen Chat tippen; loescht er die Option auf
#        seinem EIGENEN Pane, darf er pushen. Beides lief mit genau einem
#        erlaubten Befehl davor. Drei Sicherungen hingen an dieser einen
#        Behauptung: Push-Verbot, Schutz des Orchestrator-Panes und das
#        Kompaktier-Gate.
#
# DIE ANTWORT: zwei UNABHAENGIGE Quellen, und die STRENGSTE Lesart gewinnt.
#   Quelle 1  die tmux-Pane-Option `@wb_role` (wie bisher),
#   Quelle 2  dieses Register -- eine Datei je Pane, die beim Spawn von
#             `wb-rolle` geschrieben und sonst beim ERSTEN Guard-Lauf dieses
#             Panes festgehalten wird (Erstsicht).
#
# Warum "strengste Lesart" und nicht "Register schlaegt Option": weil dann die
#        Frage, welche Quelle gewinnt, selbst wieder ein Angriffsziel waere.
#        So dagegen muss ein Angreifer BEIDE Quellen umschreiben, und keine
#        einzelne Faelschung lockert je etwas:
#          * Ziel-Pane gilt als Orchestrator, sobald EINE Quelle das sagt
#            (und weiter auch dann, wenn KEINE etwas sagt -- fail-closed wie
#            bisher).
#          * Der eigene Pane gilt als Worker, sobald EINE Quelle das sagt.
#        Ein gefaelschtes Register kann eine Entscheidung damit nur
#        VERSCHAERFEN, nie oeffnen -- und genau deshalb ist es unschaedlich,
#        dass das Register unter $HOME liegt wie alles andere auch.
#
# ERSTSICHT (trust on first use): Der Eintrag entsteht beim ersten Bash-Aufruf
#        eines Panes, also bevor der Agent in diesem Pane irgendetwas
#        ausfuehren konnte -- die Option traegt zu diesem Zeitpunkt noch, was
#        der Spawner gesetzt hat. Ein Agent kann seine eigene Erstsicht nicht
#        vorwegnehmen: sein erster Bash-Aufruf IST der, der sie festhaelt, und
#        die Hook-Kette laeuft vor dem Befehl, nicht danach.
#        Festgehalten wird ausschliesslich der EIGENE Pane. Fremde Panes
#        werden nie aus einem fremden Lauf heraus eingetragen, sonst koennte
#        ein Angreifer eine Luege zementieren, die er vorher in die Option
#        geschrieben hat.
#
# VERALTETE EINTRAEGE: Ein Eintrag gilt nur, solange er zum lebenden Pane
#        passt -- verglichen werden Socket, Pane-Kennung UND die pane_pid.
#        tmux vergibt Pane-Kennungen je Server aufsteigend und nie doppelt;
#        nach einem Serverneustart oder einem `respawn-pane` (pi-worker bei
#        einem toten Worker, wb-revive) aendert sich die pane_pid, der alte
#        Eintrag faellt weg und die Erstsicht greift neu. Damit gibt es keinen
#        Zustand, in dem ein Pane wegen eines alten Eintrags dauerhaft die
#        falsche Rolle traegt.
#
# GRENZE, offen benannt (dieselbe wie in wb-mensch und wb-pane-write): Wer
#        seine Spuren aktiv verwischt, kommt auch hier durch -- ein Skript,
#        das die Option setzt, steht als Text nicht in der Befehlszeile, und
#        wer beide Quellen erreicht, hat beide. Abgewehrt wird der gemessene
#        Fall: der eine erlaubte Befehl, der bisher genuegte.
import hashlib
import json
import os
import re
import subprocess
import time

# Wie bei den Guard-Verzeichnissen: die Variable steht in der Umgebung des
# HOOK-Prozesses, die der Harness setzt. Ein Agent erreicht sie mit einem
# Praefix vor seinem eigenen Befehl (`VAR=1 tmux ...`) nicht -- und selbst wenn
# er sie erreichte, koennte er damit nur Eintraege VERBERGEN, nie eine
# Entscheidung oeffnen (siehe "strengste Lesart" oben).
def verzeichnis():
    return (os.environ.get('AWB_ROLLEN_DIR')
            or os.path.join(os.path.expanduser('~'), '.pi-workers', 'rollen'))


def _dateiname(socket, pane):
    kurz = hashlib.sha256((socket or '').encode('utf-8')).hexdigest()[:12]
    sicher = re.sub(r'[^A-Za-z0-9_.-]', '_', pane or '')
    return '%s__%s.json' % (kurz, sicher)


def datei(socket, pane):
    return os.path.join(verzeichnis(), _dateiname(socket, pane))


# Ein anderer tmux-Server, nur ueber die Kommandozeile dieses Moduls zu
# waehlen (`-L <name>` / `-S <pfad>`) und ausschliesslich fuer die
# Shell-Werkzeuge gedacht, die auf einem eigenen Socket arbeiten -- Tests und
# `wb-rolle -L`. Die Hook-Kette setzt das nie: sie meint immer den Server, in
# dem sie selbst laeuft.
_TMUX_PREFIX = []


def tmux_server_waehlen(prefix):
    global _TMUX_PREFIX
    _TMUX_PREFIX = list(prefix or [])


def _tmux_da():
    for pfad in os.environ.get('PATH', '').split(os.pathsep):
        if pfad and os.path.isfile(os.path.join(pfad, 'tmux')):
            return True
    return False


def pane_fakten(pane):
    """Option, pane_pid und Socket des Panes -- in EINEM tmux-Aufruf.

    Rueckgabe: dict oder None, wenn sich nichts messen laesst. Drei Werte in
    einem Aufruf, weil dieser Aufruf auf dem Weg jedes Bash-Kommandos liegt.
    """
    if not pane or not _tmux_da():
        return None
    try:
        r = subprocess.run(
            ['tmux'] + _TMUX_PREFIX
            + ['display', '-p', '-t', pane,
               '#{@wb_role}\t#{pane_pid}\t#{socket_path}\t#{session_name}'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    teile = (r.stdout or '').rstrip('\n').split('\t')
    if len(teile) < 4:
        return None
    return {'rolle': teile[0].strip(), 'pane_pid': teile[1].strip(),
            'socket': teile[2].strip(), 'sitzung': teile[3].strip()}


def eintrag(pane, fakten=None):
    """Der gueltige Registereintrag dieses Panes, sonst None.

    Gueltig heisst: Datei da, JSON lesbar, und die pane_pid steht noch so in
    der Prozesstabelle von tmux, wie sie beim Eintragen stand.
    """
    if not pane:
        return None
    if fakten is None:
        fakten = pane_fakten(pane)
    if not fakten:
        return None
    try:
        with open(datei(fakten.get('socket', ''), pane), 'r', encoding='utf-8') as fh:
            e = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(e, dict):
        return None
    if str(e.get('pane', '')) != pane:
        return None
    if str(e.get('pane_pid', '')) != str(fakten.get('pane_pid', '')):
        return None   # anderer Prozess unter derselben Kennung -- veraltet
    return e


def registrieren(pane, rolle, quelle, fakten=None):
    """Eintrag schreiben. Darf nie einen Bash-Aufruf scheitern lassen."""
    if not pane or not rolle:
        return False
    if fakten is None:
        fakten = pane_fakten(pane)
    if not fakten:
        return False
    neu = {'pane': pane, 'rolle': rolle, 'pane_pid': fakten.get('pane_pid', ''),
           'socket': fakten.get('socket', ''), 'sitzung': fakten.get('sitzung', ''),
           'quelle': quelle,
           'stand': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        d = verzeichnis()
        os.makedirs(d, exist_ok=True)
        pfad = datei(fakten.get('socket', ''), pane)
        tmp = pfad + '.tmp%d' % os.getpid()
        with open(tmp, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(neu, ensure_ascii=False))
        os.replace(tmp, pfad)
        return True
    except Exception:
        return False


def socket_aus_umgebung():
    """Der Socket-Pfad des umgebenden tmux-Servers, OHNE tmux zu rufen --
    $TMUX traegt ihn im ersten Feld. Nur fuer den billigen Vorlauf unten."""
    t = os.environ.get('TMUX', '')
    if not t:
        return ''
    try:
        return os.path.realpath(t.split(',')[0])
    except Exception:
        return ''


def erstsicht(pane):
    """Die Rolle des EIGENEN Panes einmal je Pane-Leben festhalten.

    Diese Funktion liegt auf dem Weg JEDES Bash-Aufrufs, deshalb der billige
    Vorlauf: liegt schon eine Datei zu Socket+Pane, ist nichts zu tun -- ein
    stat, kein tmux. Erst wenn keine da ist, wird gemessen und geschrieben.
    Ein VERALTETER Eintrag (Pane respawnt, pane_pid anders) wird hier bewusst
    nicht erneuert: die Pruefung dafuer braucht tmux, und sie passiert ohnehin
    an der Stelle, an der es darauf ankommt (eintrag() verwirft ihn dann, und
    es zaehlt die Pane-Option -- also genau der Stand vor dieser Aenderung,
    nie ein schwaecherer)."""
    if not pane:
        return
    try:
        sock = socket_aus_umgebung()
        if sock and os.path.exists(datei(sock, pane)):
            return
        fakten = pane_fakten(pane)
        if not fakten:
            return
        if eintrag(pane, fakten) is not None:
            return
        if not fakten.get('rolle'):
            return   # ohne Rolle gibt es nichts festzuhalten
        registrieren(pane, fakten['rolle'], 'erstsicht', fakten)
    except Exception:
        return


# ---------------------------------------------------------------------------
# Die zwei Fragen, die die Guards wirklich stellen. Beide lesen BEIDE Quellen.
# ---------------------------------------------------------------------------

def ziel_ist_orchestrator(pane):
    """Gilt dieser Pane als Orchestrator-Pane (also: Schreiben verboten)?

    Ja, sobald EINE der beiden Quellen das sagt -- und weiter auch dann, wenn
    sich gar nichts bestimmen laesst (fail-closed wie bisher)."""
    fakten = pane_fakten(pane)
    option = (fakten or {}).get('rolle', '')
    e = eintrag(pane, fakten)
    registriert = (e or {}).get('rolle', '')
    if option == 'orchestrator' or registriert == 'orchestrator':
        return True, ('Register sagt orchestrator' if registriert == 'orchestrator'
                      else 'traegt @wb_role=orchestrator')
    if not option and not registriert:
        return True, 'Rolle nicht bestimmbar, gilt deshalb als Orchestrator'
    return False, 'Rolle %s' % (registriert or option)


def selbst_ist_worker(pane):
    """Gilt der EIGENE Pane als Worker (also: kein Push)?

    Ja, sobald EINE der beiden Quellen das sagt. Ein Worker, der seine
    Pane-Option loescht, bleibt damit ein Worker."""
    fakten = pane_fakten(pane)
    option = (fakten or {}).get('rolle', '')
    e = eintrag(pane, fakten)
    registriert = (e or {}).get('rolle', '')
    if option == 'worker' or registriert == 'worker':
        return True, ('Register sagt worker' if registriert == 'worker'
                      else '@wb_role=worker')
    return False, 'Rolle %s' % (registriert or option or 'unbestimmt')


def rolle_effektiv(pane):
    """Eine einzelne Rollenbezeichnung fuer Anzeige und Rollenfilter.
    Register vor Option, weil das Register die aeltere und damit
    unbestechlichere Aussage ist; ohne Eintrag bleibt es bei der Option."""
    fakten = pane_fakten(pane)
    e = eintrag(pane, fakten)
    return (e or {}).get('rolle', '') or (fakten or {}).get('rolle', '')


def main(argv):
    """Kleine Kommandozeile, damit die Shell-Werkzeuge (wb-rolle,
    wb-pane-write, push-gate-worker.sh, precompact-handoff-gate.sh) DIESELBE
    Logik benutzen statt sie ein zweites Mal nachzubauen."""
    prefix = []
    while len(argv) >= 2 and argv[0] in ('-L', '-S'):
        prefix.extend([argv[0], argv[1]])
        argv = argv[2:]
    tmux_server_waehlen(prefix)
    if len(argv) < 2:
        print('rollen.py [-L <socket>] lesen|streng-ziel|streng-selbst|setzen|erstsicht <pane> [rolle] [quelle]')
        return 2
    cmd, pane = argv[0], argv[1]
    if cmd == 'lesen':
        fakten = pane_fakten(pane) or {}
        e = eintrag(pane, fakten if fakten else None) or {}
        print('option\t%s' % fakten.get('rolle', ''))
        print('register\t%s' % e.get('rolle', ''))
        print('effektiv\t%s' % (e.get('rolle', '') or fakten.get('rolle', '')))
        return 0
    if cmd == 'streng-ziel':
        ist, grund = ziel_ist_orchestrator(pane)
        print('%s\t%s' % ('orchestrator' if ist else 'anders', grund))
        return 0 if ist else 1
    if cmd == 'streng-selbst':
        ist, grund = selbst_ist_worker(pane)
        print('%s\t%s' % ('worker' if ist else 'anders', grund))
        return 0 if ist else 1
    if cmd == 'setzen':
        if len(argv) < 3:
            return 2
        rolle = argv[2]
        quelle = argv[3] if len(argv) > 3 else 'werkzeug'
        return 0 if registrieren(pane, rolle, quelle) else 1
    if cmd == 'erstsicht':
        erstsicht(pane)
        return 0
    return 2


if __name__ == '__main__':
    import sys
    sys.exit(main(sys.argv[1:]))
