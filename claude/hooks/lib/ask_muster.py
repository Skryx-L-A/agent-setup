#!/usr/bin/env python3
# Die mittlere Stufe zwischen "vom Guard geblockt" und "laeuft durch".
#
# Zweck: Die acht Guards in bash-guard.py kennen genau zwei Antworten --
#        durchlassen oder ablehnen. Dieses Modul fuegt die Stufe dazwischen
#        hinzu: ein Befehl, der weder harmlos noch verboten ist, sondern EINE
#        FRAGE WERT. Er wird angehalten, taucht in der Freigabe-Ansicht auf,
#        und geht nach einer EINMALIGEN Freigabe durch.
#
# Wo diese Stufe steht: GANZ UNTEN, nach allen acht Guards. Das ist keine
#        Reihenfolge-Laune, sondern die tragende Eigenschaft: was heute hart
#        abgelehnt wird, kommt hier nie an, also kann kein Muster hier eine
#        bestehende Ablehnung aufweichen. Die Stufe ist fuer das, was heute
#        durchlaeuft, obwohl man zweimal hinsehen moechte.
#
# Was eine Freigabe NICHT ist:
#   * kein Freibrief fuer einen Worker -- gebunden an den BEFEHL im Wortlaut,
#     dazu Pane und Arbeitsverzeichnis, nicht an ein Muster und nicht an eine
#     Pane allein;
#   * nicht wiederverwendbar -- sie wird beim Einloesen GELOESCHT, bevor der
#     Befehl ueberhaupt laeuft, also auch dann verbraucht, wenn er scheitert;
#   * nicht dauerhaft -- sie laeuft von selbst ab (MAX_TTL_SEKUNDEN als harte
#     Obergrenze HIER, unabhaengig davon, was in der Datei steht);
#   * nicht selbst erteilbar -- dieses Modul liest Freigaben nur, geschrieben
#     werden sie von der Freigabe-Ansicht, also von einem Menschen.
#
# NACHGEMESSEN 2026-08-07, und der letzte Punkt stimmte nicht: eine Freigabe
#        war eine gewoehnliche JSON-Datei in einem Verzeichnis, in das jeder
#        Agent schreiben darf. Gemessen: `sudo launchctl list` wird angehalten;
#        nach einer SELBST geschriebenen Freigabedatei laeuft derselbe Befehl
#        durch. Der Satz "geschrieben werden sie von einem Menschen" war eine
#        Erwartung, keine Pruefung.
#        Seitdem traegt jede Freigabe einen HERKUNFTSNACHWEIS: wer sie erteilt
#        hat (gemessen, nicht behauptet -- `wb-mensch`, also steuerndes
#        Terminal oder das Programmfenster als nachgewiesener Ahne) und eine
#        Signatur ueber genau die Werte, an die sie gebunden ist. Ohne gueltige
#        Signatur zaehlt sie nicht, und der angehaltene Befehl bleibt
#        angehalten -- die sichere Richtung.
#        Der Schluessel liegt neben den Freigaben (SCHLUESSEL_NAME, Modus
#        0600) und wird von `wb-freigabe` angelegt, wenn ein GEMESSENER Mensch
#        zum ersten Mal etwas freigibt. Ein Agent kommt an ihn nicht heran,
#        ohne einen Befehl auszufuehren, den die Hook-Kette ablehnt
#        (bash-guard.py, Guard `freigabe-pfad`).
#        GRENZE, offen benannt -- dieselbe wie in wb-mensch: Als derselbe
#        Benutzer gibt es kein Versteck, das gegen einen Agenten haelt, der
#        seine Spuren aktiv verwischt. Was hier faellt, ist der gemessene Fall:
#        die Datei, die sich ein Agent selbst hinlegt. Wer den Schluessel
#        wirklich liest, kann faelschen; dafuer muss er an einem Guard vorbei,
#        der genau das ablehnt.
#
# Die Musterliste steht NICHT in diesem Code, sondern in den EINSTELLUNGEN
#        (~/.claude/workbench/settings.json, Schluessel "askPatterns") --
#        sichtbar und pruefbar, wie die Ausschlussliste der Ordneransicht.
#        Sie lag bis zum 06.08. in der Programmdatei
#        (~/.config/agent-workbench/config.json) und ist in die GETEILTE Datei
#        gewandert: das Einstellungsmenue muss jeden Eintrag einzeln
#        abschalten koennen, und der einzige Schreibweg dorthin ist
#        `wb-state settings set` -- derselbe Weg, der die Sperre nimmt und
#        jede Aenderung mit Urheber protokolliert.
#        STANDARD_MUSTER unten ist die mitgelieferte Vorgabe fuer den Fall,
#        dass die Datei den Schluessel nicht traegt; dieselbe Liste steht ein
#        zweites Mal als VORGABE_ASK_MUSTER in app/src/main/einstellungen.ts,
#        aus demselben Grund, aus dem excludeGlobs dort und die Secret-Muster
#        hier je eine eigene Kopie haben: Hook und Programm sollen einzeln
#        lauffaehig sein. shell/tests/test-app-muster.sh vergleicht beide
#        Listen gegeneinander, damit die Kopien nicht auseinanderlaufen.
#        Ein Eintrag mit "aus": true bleibt in der Liste STEHEN und wirkt
#        nicht -- anders als beim Loeschen sieht man danach noch, dass es ihn
#        gab (Vorgabe vom 06.08.).
import calendar
import hashlib
import hmac
import json
import os
import re
import sys
import time

import cmdshell as cs

# Vorgabe. Ein Eintrag beschreibt eine STELLE in der zerlegten Befehlszeile,
# nicht eine Zeichenkette irgendwo im Text:
#
#   befehl       Regulaerer Ausdruck, der auf den NAMEN des Befehls passen
#                muss (vollstaendig, ohne Pfad: aus /usr/bin/git wird git).
#                Pflichtfeld -- ohne ihn waere ein Eintrag wieder eine
#                Textsuche.
#   unterbefehl  Optional. Muss als GANZES Argument-Token vorkommen. Das ist
#                die Stelle, an der die Zerlegung wirkt: `git commit -m
#                "push --force"` hat das Token `push --force`, nicht `push`.
#   muster       Optional. Regulaerer Ausdruck ueber die Argumente.
#   grund        Der eine Satz, der in der Freigabe-Ansicht erklaert, warum
#                hier gefragt wird. Pflichtfeld.
#
# Alles ohne Ruecksicht auf Gross-/Kleinschreibung. Bewusst alles Befehle, die
# HEUTE durch die acht Guards laufen -- gemessen gegen bash-guard.py.
#
# Warum diese Form (Befund aus dem Betrieb, 2026-08-05): die erste Fassung
# prueft die rohe Befehlszeichenkette am Stueck. Damit loeste schon das
# SCHREIBEN ueber einen riskanten Befehl die Stufe aus -- ein Absatz fuer
# SESSION-STATE.md, der den git-Aufraeumbefehl als Beispiel nennt, wurde
# angehalten, obwohl nur eine Datei geschrieben wurde. Eine Sicherung, die bei
# jeder Dokumentation fragt, erzieht zum Wegklicken und traegt sich selbst ab.
STANDARD_MUSTER = [
    {'befehl': 'sudo',
     'grund': 'Laeuft mit Systemrechten -- ausserhalb dessen, was ein Auftrag ueblich macht.'},
    {'befehl': 'chmod', 'muster': r'(^|\s)-[A-Za-z]*R(\s|$)',
     'grund': 'Aendert Rechte eines ganzen Baums auf einmal.'},
    {'befehl': 'chmod', 'muster': r'(^|\s)0?777(\s|$)',
     'grund': 'Gibt Schreibrecht an alle.'},
    {'befehl': 'chown', 'muster': r'(^|\s)-[A-Za-z]*R(\s|$)',
     'grund': 'Uebereignet einen ganzen Baum an einen anderen Besitzer.'},
    {'befehl': 'git', 'unterbefehl': 'push',
     'muster': r'(^|\s)(--force|--force-with-lease|-f)(\s|$)',
     'grund': 'Ueberschreibt veroeffentlichte Geschichte -- nach dem Druecken nicht zurueckzuholen.'},
    {'befehl': 'git', 'unterbefehl': 'reset', 'muster': r'(^|\s)--hard(\s|$)',
     'grund': 'Verwirft uncommittete Arbeit ohne Nachfrage.'},
    {'befehl': 'git', 'unterbefehl': 'clean', 'muster': r'(^|\s)-[A-Za-z]*f[A-Za-z]*(\s|$)',
     'grund': 'Loescht nicht versionierte Dateien im Arbeitsbaum.'},
    {'befehl': 'npm|pnpm|yarn|cargo', 'unterbefehl': 'publish',
     'grund': 'Veroeffentlicht nach aussen -- eine Version draussen laesst sich nicht zurueckziehen.'},
    {'befehl': 'twine', 'unterbefehl': 'upload',
     'grund': 'Veroeffentlicht nach aussen -- eine Version draussen laesst sich nicht zurueckziehen.'},
    {'befehl': 'gh', 'unterbefehl': 'release', 'muster': r'(^|\s)create(\s|$)',
     'grund': 'Veroeffentlicht nach aussen -- eine Version draussen laesst sich nicht zurueckziehen.'},
    {'befehl': 'launchctl', 'unterbefehl': 'unload|bootout|disable|remove',
     'grund': 'Haelt einen Hintergrunddienst an, der danach nicht von selbst wiederkommt.'},
    {'befehl': 'crontab', 'muster': r'(^|\s)-[A-Za-z]*r(\s|$)',
     'grund': 'Loescht die gesamte Zeitplan-Tabelle.'},
    {'befehl': 'diskutil', 'unterbefehl': r'erase[A-Za-z]*|reformat|partitionDisk',
     'grund': 'Legt einen Datentraeger neu an -- der Inhalt ist danach weg.'},
    {'befehl': r'mkfs(\.[A-Za-z0-9]+)?',
     'grund': 'Legt ein Dateisystem neu an -- der Inhalt ist danach weg.'},
]

# Harte Obergrenze der Gueltigkeit, HIER durchgesetzt und nicht aus der Datei
# gelesen: eine Freigabe, die jemand mit einem Ablaufdatum in ferner Zukunft
# hinschreibt, waere genau der Freibrief, den diese Stufe nicht sein darf.
MAX_TTL_SEKUNDEN = 900

# Vorgabe-Gueltigkeit, die das Programm beim Erteilen einsetzt.
# GEMESSEN (shell/tests/test-app-muster.sh, 2026-08-05): vom Anhalten bis zum
# Erscheinen im gezeichneten Bild vergehen 1948 ms, ohne dass jemand die
# Ansicht anstoesst. Der Weg, den der Mensch nicht beeinflussen kann, kostet
# also rund zwei Sekunden; alles Weitere ist seine Bedenkzeit. Fuenf Minuten
# geben ihm die, ohne dass eine vergessene Freigabe lange herumliegt --
# Minuten, nicht Stunden, und nie mehr als MAX_TTL_SEKUNDEN.
STANDARD_TTL_SEKUNDEN = 300


def config_pfad():
    """Die PROGRAMM-Konfiguration (AWB_CONFIG dort wie hier).

    Sie traegt noch, was nur das Programm zum Hochfahren braucht -- hier also
    die Freigabe-Frist und das Verzeichnis der Freigaben. Die Musterliste
    steht seit dem 06.08. nebenan, siehe einstellungen_pfad().
    """
    aus_umgebung = os.environ.get('AWB_CONFIG')
    if aus_umgebung:
        return aus_umgebung
    return os.path.join(os.path.expanduser('~'), '.config', 'agent-workbench', 'config.json')


def einstellungen_pfad():
    """Die GETEILTE Einstellungsdatei -- dieselbe, die `wb-state settings get`
    beantwortet und die das Einstellungsmenue schreibt."""
    aus_umgebung = os.environ.get('AWB_SETTINGS_FILE')
    if aus_umgebung:
        return aus_umgebung
    return os.path.join(os.path.expanduser('~'), '.claude', 'workbench', 'settings.json')


def lade_muster(pfad=None):
    """Die Musterliste aus den Einstellungen, sonst die mitgelieferte Vorgabe.

    Eine fehlende oder unlesbare Datei heisst "Vorgabe gilt", nicht "Stufe
    aus" -- eine Sicherung, die sich durch das Loeschen einer Datei
    abschalten laesst, waere keine. Ein einzeln abgeschalteter Eintrag
    ("aus": true) faellt dagegen heraus: das ist eine ausgesprochene
    Entscheidung, getroffen im Menue und im Aenderungsprotokoll vermerkt.
    """
    p = pfad or einstellungen_pfad()
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            daten = json.load(fh)
    except (OSError, ValueError):
        return list(STANDARD_MUSTER)
    if not isinstance(daten, dict):
        return list(STANDARD_MUSTER)
    roh = daten.get('askPatterns')
    if roh is None:
        return list(STANDARD_MUSTER)
    if not isinstance(roh, list):
        return list(STANDARD_MUSTER)
    raus = []
    for eintrag in roh:
        if not isinstance(eintrag, dict):
            continue
        if eintrag.get('aus') is True:
            # Einzeln abgeschaltet. Er bleibt in der Datei stehen, damit man
            # ihn wiederfindet -- hier wirkt er nicht.
            continue
        befehl = str(eintrag.get('befehl') or '')
        if not befehl:
            # Ohne Befehlsnamen waere der Eintrag wieder eine Textsuche ueber
            # die ganze Zeile -- genau das, woran die erste Fassung dieser
            # Stufe gescheitert ist. Er faellt aus, statt still zu wirken.
            sys.stderr.write("bash-guard-muster: Eintrag ohne 'befehl' uebersprungen\n")
            continue
        neu = {'befehl': befehl, 'grund': str(eintrag.get('grund') or '')}
        if eintrag.get('unterbefehl'):
            neu['unterbefehl'] = str(eintrag['unterbefehl'])
        if eintrag.get('muster'):
            neu['muster'] = str(eintrag['muster'])
        raus.append(neu)
    # Eine ausdruecklich leere Liste ist eine Entscheidung des Betreibers und
    # wird respektiert -- anders als eine fehlende Datei.
    return raus


def lade_ttl(pfad=None):
    """Gueltigkeitsdauer aus denselben Einstellungen, gedeckelt auf MAX_TTL_SEKUNDEN."""
    p = pfad or config_pfad()
    wert = STANDARD_TTL_SEKUNDEN
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            daten = json.load(fh)
        if isinstance(daten, dict) and isinstance(daten.get('askGrantTtlSeconds'), (int, float)):
            wert = int(daten['askGrantTtlSeconds'])
    except (OSError, ValueError):
        pass
    if wert < 1:
        wert = STANDARD_TTL_SEKUNDEN
    return min(wert, MAX_TTL_SEKUNDEN)


def _voll(ausdruck, text):
    """Vollstaendiger Treffer, ohne Ruecksicht auf Gross-/Kleinschreibung."""
    try:
        return re.fullmatch(ausdruck, text, re.IGNORECASE) is not None
    except re.error:
        return None  # kaputter Ausdruck -- der Aufrufer meldet ihn


def _teil(ausdruck, text):
    try:
        return re.search(ausdruck, text, re.IGNORECASE) is not None
    except re.error:
        return None


def _stufen_teile(stufe, varmap):
    """(Wrapper-Namen, Befehlsname, Argumente) einer Pipeline-Stufe.

    Spiegelt cmdshell.resolve_command() Schritt fuer Schritt -- mit dem einen
    Unterschied, dass die WRAPPER mitgegeben werden statt uebersprungen zu
    werden. `sudo` ist fuer die anderen Guards nur eine Huelle um den echten
    Befehl; fuer diese Stufe IST es der Befund.
    """
    wrapper = []
    i, n = 0, len(stufe)
    flaggen_ueberspringen = False
    while i < n:
        roh = stufe[i]
        if roh in cs.BLOCK_KEYWORDS or _NUR_KLAMMERN_RE.match(roh):
            # Die Klammer-Zeile hier war die ERSTE Haelfte der Reparatur: sie
            # entstand, als diese Stufe gebaut wurde und cmdshell eine
            # Unterschale noch gar nicht auftrennte -- `(` war dort der
            # Befehlsname, alles dahinter nur Argument.
            # Seit 2026-08-05 trennt cmdshell selbst: _quote_aware_prepass()
            # behandelt eine unquotete Klammer als Befehlsgrenze, fuer ALLE
            # Guards. Damit erreicht eine Klammer aus einer Unterschale diese
            # Stelle nicht mehr -- und das war noetig, denn die hiesige
            # Fassung deckte nur `( C )` ab: in der geklebten Form `(C)` heisst
            # das Token `(git`, worauf _NUR_KLAMMERN_RE nicht passt. Gemessen
            # 2026-08-05: 3 von 4 protokollierten Rueckfragen liefen als `(C)`
            # durch, obwohl diese Zeile hier stand.
            # Sie bleibt trotzdem stehen: eine GESCHRIEBENE oder escapte
            # Klammer (`echo "("`) kommt weiterhin als eigenes Token an, und
            # ein Befehlsname wird daraus nie.
            i += 1
            continue
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', roh):
            i += 1
            continue
        if flaggen_ueberspringen and roh.startswith('-'):
            i += 1
            continue
        wort = cs.resolve_vars(roh, varmap)
        name = wort.split('/')[-1]
        if name in cs.WRAPPER_CMDS:
            wrapper.append(name)
            flaggen_ueberspringen = True
            i += 1
            continue
        return wrapper, name, [cs.resolve_vars(t, varmap) for t in stufe[i + 1:]]
    return wrapper, None, []


def _eintrag_passt(eintrag, wrapper, name, argumente):
    """Passt dieser Eintrag auf diese eine, bereits zerlegte Stufe?"""
    befehl = eintrag.get('befehl')
    if not befehl:
        return False

    getroffen = False
    for w in wrapper:
        if _voll(befehl, w):
            getroffen = True
            break
    if not getroffen:
        if name is None:
            return False
        if not _voll(befehl, name):
            return False

    unterbefehl = eintrag.get('unterbefehl')
    if unterbefehl:
        # Als GANZES Token, nie als Teil eines Textes: eine in Anfuehrungs-
        # zeichen stehende Zeichenkette ist nach der Zerlegung EIN Token, also
        # trifft `git commit -m "push --force"` das Token `push` nie.
        if not any(_voll(unterbefehl, t) for t in argumente):
            return False

    muster = eintrag.get('muster')
    if muster and not _teil(muster, ' '.join(argumente)):
        return False
    return True


def _eintrag_uebersetzbar(eintrag):
    """Ein Eintrag mit einem kaputten Ausdruck faellt aus, statt die ganze
    Stufe stillzulegen -- und wird dabei genannt, nie stillschweigend."""
    if not isinstance(eintrag, dict) or not eintrag.get('befehl'):
        return False
    for feld in ('befehl', 'unterbefehl', 'muster'):
        wert = eintrag.get(feld)
        if wert is None:
            continue
        try:
            re.compile(wert)
        except re.error:
            sys.stderr.write(
                "bash-guard-muster: Ausdruck nicht uebersetzbar, Eintrag uebersprungen (%s): %s\n"
                % (feld, wert))
            return False
    return True


def eintrag_label(eintrag):
    """Kurzform eines Eintrags fuer Anzeige und Verlauf."""
    teile = [str(eintrag.get('befehl', ''))]
    if eintrag.get('unterbefehl'):
        teile.append(str(eintrag['unterbefehl']))
    if eintrag.get('muster'):
        teile.append(str(eintrag['muster']))
    return ' '.join(t for t in teile if t)


def _befehlsnamen_im_rohtext(command, eintraege):
    """Kommt ueberhaupt einer der gesuchten Befehlsnamen im Rohtext vor?

    Nur fuer den Fall gedacht, in dem sich nichts zerlegen laesst. Ein Treffer
    beweist nichts -- er heisst bloss, dass eine Rueckfrage moeglich waere und
    deshalb gestellt wird.
    """
    for eintrag in eintraege:
        befehl = eintrag.get('befehl')
        if not befehl:
            continue
        if _teil(r'(^|[^A-Za-z0-9_./-])(%s)([^A-Za-z0-9_-]|$)' % befehl, command):
            return True
    return False


class Unentscheidbar(Exception):
    """Die Befehlszeile liess sich nicht so weit zerlegen, dass eine Aussage
    moeglich waere. Dieselbe Haltung wie beim snapshot-Guard: lieber fragen
    als durchlassen."""

    def __init__(self, was):
        Exception.__init__(self, was)
        self.was = was


def passendes_muster(command, muster_liste):
    """Der erste Eintrag, der auf eine wirklich ausgefuehrte Stelle passt.

    Geprueft wird NICHT die rohe Zeichenkette, sondern jede Stufe jeder
    Anweisung, so wie die acht Guards ueber dieser Stufe es auch tun
    (cmdshell.py). Ein Muster soll auf einen Teilbefehl passen, der ausgefuehrt
    wird -- nicht auf Text, der als Argument, in einem Here-Dokument oder in
    einer Zeichenkette vorbeikommt.

    Wirft Unentscheidbar, wenn die Zeile sich nicht zerlegen laesst oder der
    Name eines Befehls erst zur Laufzeit feststeht.
    """
    if not command:
        return None

    brauchbare_eintraege = [e for e in muster_liste if _eintrag_uebersetzbar(e)]

    # Der Rumpf eines Here-Dokuments ist Text, kein Code -- cmdshell schneidet
    # ihn weg, aus genau demselben Grund, aus dem er hier stoert.
    anweisungen = cs.all_statements(cs.strip_heredocs(command))
    if anweisungen == [None]:
        # Nicht zerlegbar. Gefragt wird trotzdem nur, wenn ueberhaupt einer der
        # Befehlsnamen im Rohtext vorkommt -- dieselbe Bauart wie FAILCLOSED_RE
        # in snapshot_classify und kill_pattern_classify, und dieselbe Grenze:
        # `echo "unbalanced` ist unzerlegbar, kann aber nichts von dem
        # enthalten, wonach diese Stufe sucht.
        # Hier, und NUR hier, wird der Rohtext durchsucht. Das ist genau das
        # Verfahren, das den Befund vom 05.08. ausgeloest hat -- als
        # ENTSCHEIDUNG waere es falsch, als letzte Notbremse dort, wo keine
        # Zerlegung moeglich ist, ist es die vorsichtigere Seite.
        if _befehlsnamen_im_rohtext(command, brauchbare_eintraege):
            raise Unentscheidbar(
                'die Befehlszeile liess sich nicht zerlegen (unausgeglichene Anfuehrung)')
        return None

    varmap = cs.collect_assignments(anweisungen)
    brauchbar = [a for a in anweisungen if a]
    for anweisung in brauchbar:
        for stufe in cs.split_pipeline(anweisung):
            wrapper, name, argumente = _stufen_teile(stufe, varmap)
            if name is None:
                continue
            if _UNAUFGELOEST_RE.search(name):
                # Der Name des Befehls steht erst zur Laufzeit fest. Hier ist
                # keine Aussage moeglich, weder in die eine noch in die andere
                # Richtung -- also gefragt statt geraten. Bewusst NUR der Name:
                # eine Variable in einem ARGUMENT sagt nichts darueber, WELCHER
                # Befehl laeuft, und wuerde die Stufe bei jedem zweiten Aufruf
                # ausloesen.
                raise Unentscheidbar(
                    "der Name des Befehls steht erst zur Laufzeit fest (%s)" % cs.stage_text(stufe))
            for eintrag in brauchbare_eintraege:
                if _eintrag_passt(eintrag, wrapper, name, argumente):
                    return eintrag
    return None


_UNAUFGELOEST_RE = re.compile(r'\$\{?[A-Za-z_@*#?!0-9]|`')
_NUR_KLAMMERN_RE = re.compile(r'^[()]+$')


def stempel(zeit=None):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(zeit if zeit is not None else time.time()))


def ablauf_stempel(ttl_sekunden, jetzt=None):
    """Wann eine Rueckfrage von selbst verfaellt -- dieselbe Dauer wie die
    Freigabe, die sie beantworten wuerde. Eine Frage, die laenger steht als
    ihre moegliche Antwort gilt, ist keine Frage mehr, sondern Altlast."""
    basis = jetzt if jetzt is not None else time.time()
    return stempel(basis + min(int(ttl_sekunden), MAX_TTL_SEKUNDEN))


def merker_abgelaufen(eintrag, jetzt=None):
    """Ein Rueckfrage-Merker ist abgelaufen, sobald sein expires_ts vorbei ist.

    FEHLT der Zeitstempel, gilt er als abgelaufen. Das ist Absicht: ein Merker,
    der den naechsten Befehl im selben Pane ueberlebt, braucht ein Ende, das
    nicht davon abhaengt, dass irgendjemand ihn wegraeumt -- sonst haengt eine
    unbeantwortete Frage fuer immer in der Ansicht. Alte Merker aus der Zeit
    vor dieser Stufe tragen das Feld nicht und fallen damit sofort weg.
    """
    laeuft_ab = _als_zeit((eintrag or {}).get('expires_ts'))
    if laeuft_ab is None:
        return True
    return (jetzt if jetzt is not None else time.time()) > laeuft_ab


def schluessel(pane, cwd, command):
    """Die Bindung: Befehl im Wortlaut, dazu Pane und Arbeitsverzeichnis.

    Der Schluessel benennt die Freigabedatei; ihr INHALT traegt dieselben drei
    Werte noch einmal im Klartext und wird beim Einloesen erneut verglichen --
    ein Treffer auf den Dateinamen allein soll nie genuegen.
    """
    roh = '\x00'.join([pane or '', cwd or '', command or ''])
    return hashlib.sha256(roh.encode('utf-8')).hexdigest()


def grants_dir():
    return (os.environ.get('AWB_GUARD_GRANTS_DIR')
            or os.path.join(os.path.expanduser('~'), '.pi-workers', 'guard-grants'))


# --- Herkunftsnachweis ------------------------------------------------------
# Der Schluessel liegt NEBEN dem Freigabe-Ordner, nicht darin: eine Freigabe
# wird nach dem Einloesen geloescht, und ein Aufraeumen des Ordners darf nie
# den Schluessel mitnehmen. Er folgt damit derselben Umleitung
# (AWB_GUARD_GRANTS_DIR) wie die Freigaben selbst -- eine Testsuite isoliert
# beides mit einem Schalter, ohne dass es einen zweiten braucht.
SCHLUESSEL_NAME = '.freigabe-schluessel'

# Wer eine Freigabe erteilen darf. Beides sind Messungen aus `wb-mensch`:
# 'mensch' ist ein steuerndes Terminal (M1), 'oberflaeche' das Programmfenster
# als nachgewiesener Ahne (M2). Was nicht in dieser Liste steht, zaehlt nicht.
HERKUNFT_ARTEN = ('mensch', 'oberflaeche')


def schluessel_datei():
    return os.path.join(os.path.dirname(os.path.normpath(grants_dir())), SCHLUESSEL_NAME)


def schluessel_lesen():
    """Der Signaturschluessel, oder None. Kein Schluessel heisst: keine
    Freigabe kann gelten -- der Fehler faellt in Richtung "haelt an"."""
    try:
        with open(schluessel_datei(), 'r', encoding='utf-8') as fh:
            wert = fh.read().strip()
    except OSError:
        return None
    return wert or None


def signatur(eintrag, geheim):
    """Die Signatur ueber GENAU die Werte, an die eine Freigabe gebunden ist.

    Bewusst inklusive Herkunft: sonst liesse sich ein gueltig signierter
    Herkunftsvermerk durch einen anderen ersetzen, und der Nachweis waere nur
    Zierde."""
    roh = '\x00'.join([
        str(eintrag.get('schluessel', '')), str(eintrag.get('pane', '')),
        str(eintrag.get('cwd', '')), str(eintrag.get('command', '')),
        str(eintrag.get('granted_ts', '')), str(eintrag.get('expires_ts', '')),
        str((eintrag.get('herkunft') or {}).get('art', '')),
        str((eintrag.get('herkunft') or {}).get('beleg', '')),
    ])
    return hmac.new(geheim.encode('utf-8'), roh.encode('utf-8'), hashlib.sha256).hexdigest()


def herkunft_pruefen(eintrag):
    """(gilt?, Begruendung) -- der Herkunftsnachweis einer Freigabe."""
    h = eintrag.get('herkunft')
    if not isinstance(h, dict):
        return False, ('ohne Herkunftsnachweis geschrieben -- eine Freigabe muss sagen, '
                       'WER sie erteilt hat, und das gemessen')
    art = str(h.get('art', ''))
    if art not in HERKUNFT_ARTEN:
        return False, "Herkunftsart '%s' ist keine gemessene Herkunft" % art
    if not str(h.get('beleg', '')).strip():
        return False, 'Herkunftsnachweis ohne Beleg'
    geheim = schluessel_lesen()
    if geheim is None:
        return False, ('kein Signaturschluessel vorhanden (%s) -- solange keiner da ist, '
                       'kann keine Freigabe gelten' % schluessel_datei())
    erwartet = signatur(eintrag, geheim)
    gegeben = str(h.get('sig', ''))
    if not hmac.compare_digest(erwartet, gegeben):
        return False, 'Signatur passt nicht zu den gebundenen Werten'
    return True, 'erteilt von %s (%s)' % (art, str(h.get('beleg', ''))[:120])


def _als_zeit(wert):
    """Ein UTC-Zeitstempel als Sekunden seit der Epoche.

    calendar.timegm und NICHT time.mktime: mktime liest den Zeitstempel als
    ORTSZEIT und verschiebt ihn damit um den Zonenversatz -- gemessen im
    ersten Lauf dieses Tests, wo eine gerade erteilte Freigabe wegen der
    Sommerzeit (eine Stunde) sofort als abgelaufen galt. Ein Ausgleich ueber
    time.timezone waere derselbe Fehler mit mehr Zeilen, weil er die
    Sommerzeit nicht kennt.
    """
    try:
        return calendar.timegm(time.strptime(str(wert), '%Y-%m-%dT%H:%M:%SZ'))
    except (ValueError, TypeError):
        return None


def freigabe_einloesen(pane, cwd, command, verzeichnis=None, bericht=None):
    """Eine gueltige Freigabe fuer GENAU diesen Befehl einloesen.

    Rueckgabe: das Freigabe-Objekt, wenn eine gueltige vorlag, sonst None.
    Die Datei wird in JEDEM Fall geloescht, in dem sie gefunden wurde -- auch
    bei abgelaufener oder nicht passender Freigabe. Damit ist sie nach genau
    einem Durchlauf verbraucht, unabhaengig davon, wie der Befehl ausgeht:
    geloescht wird VOR der Ausfuehrung, nicht danach.

    `bericht`: eine Liste, in die der Grund einer VERWORFENEN Freigabe
    geschrieben wird. Ohne den bliebe der haeufigste Fall stumm -- da lag eine
    Freigabe, sie zaehlte nicht, und niemand erfuehre warum.
    """
    def vermerken(text):
        if bericht is not None:
            bericht.append(text)
    d = verzeichnis or grants_dir()
    pfad = os.path.join(d, schluessel(pane, cwd, command) + '.json')
    try:
        with open(pfad, 'r', encoding='utf-8') as fh:
            eintrag = json.load(fh)
    except (OSError, ValueError):
        return None
    try:
        os.remove(pfad)
    except OSError:
        pass
    if not isinstance(eintrag, dict):
        return None
    # Der Dateiname allein genuegt nicht: die drei bindenden Werte werden
    # woertlich verglichen.
    if str(eintrag.get('command', '')) != (command or ''):
        vermerken('die gefundene Freigabe galt einem anderen Befehl')
        return None
    if str(eintrag.get('pane', '')) != (pane or ''):
        vermerken('die gefundene Freigabe galt einem anderen Pane')
        return None
    if str(eintrag.get('cwd', '')) != (cwd or ''):
        vermerken('die gefundene Freigabe galt einem anderen Arbeitsverzeichnis')
        return None
    jetzt = time.time()
    erteilt = _als_zeit(eintrag.get('granted_ts'))
    laeuft_ab = _als_zeit(eintrag.get('expires_ts'))
    if laeuft_ab is None or jetzt > laeuft_ab:
        vermerken('die gefundene Freigabe war abgelaufen')
        return None
    # Obergrenze aus diesem Modul, nicht aus der Datei.
    if erteilt is None or jetzt > erteilt + MAX_TTL_SEKUNDEN:
        vermerken('die gefundene Freigabe war aelter als die harte Obergrenze')
        return None
    # Und zuletzt die Frage, die bis zum 07.08. niemand gestellt hat: WER hat
    # sie erteilt? Ohne gemessene Herkunft und passende Signatur zaehlt sie
    # nicht -- verbraucht ist sie trotzdem, denn geloescht wurde sie oben.
    gilt, warum = herkunft_pruefen(eintrag)
    if not gilt:
        vermerken('die gefundene Freigabe wurde verworfen: %s' % warum)
        return None
    vermerken('gueltige Freigabe: %s' % warum)
    return eintrag


def kuerzen_mitte(text, max_len=700, rand=300):
    """Voller Text bis max_len; darueber Anfang UND Ende, Mitte weg -- und die
    Kuerzung als solche erkennbar. Nie eine stille Abschneidung mitten im Wort:
    gemessen am Vorfall vom 2026-08-10, wo ein bei 300 Zeichen hart
    abgeschnittener Befehl mitten in `ls ~` endete und niemand sehen konnte,
    dass da noch mehr stand."""
    text = text or ''
    if len(text) <= max_len:
        return text
    fehlt = len(text) - 2 * rand
    return '%s\n    ...[%d Zeichen gekuerzt]...\n    %s' % (text[:rand], fehlt, text[-rand:])


def erster_unterschied(a, b):
    """Index der ersten Stelle, an der sich zwei Texte unterscheiden -- oder
    die Laenge des kuerzeren, wenn einer ein Praefix des anderen ist."""
    a, b = a or '', b or ''
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n


def freigabe_fuer_pane(pane, cwd, ausser_command, verzeichnis=None, jetzt=None):
    """Alle noch gueltigen Freigaben DIESES Panes, die NICHT dem gerade
    gesendeten Befehl gelten -- read-only, verbraucht nichts.

    Vorfall 2026-08-10: eine Freigabe fuer eine Pane wurde erteilt und war
    gueltig -- nur eben fuer einen Befehl mit anderem Wortlaut als dem, der
    als naechstes aus DERSELBEN Pane kam (der Agent hatte zwischen zwei
    Versuchen selbst eine Zeile veraendert). Ohne diese Suche sieht der Fall
    fuer den angehaltenen Agenten genauso aus wie eine ganz neue Rueckfrage,
    und der Mensch, der laengst zugestimmt hat, sieht scheinbar gar nichts
    passieren.

    Liest nur -- eine gefundene Freigabe wird NICHT geloescht. Ein
    Fehlversuch darf einer noch passenden Freigabe fuer den naechsten,
    richtigen Versuch nicht die Grundlage entziehen.
    """
    d = verzeichnis or grants_dir()
    jetzt = jetzt if jetzt is not None else time.time()
    treffer = []
    try:
        namen = sorted(os.listdir(d))
    except OSError:
        return treffer
    for name in namen:
        if not name.endswith('.json') or name.startswith('.'):
            continue
        try:
            with open(os.path.join(d, name), 'r', encoding='utf-8') as fh:
                eintrag = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(eintrag, dict):
            continue
        if str(eintrag.get('pane', '')) != (pane or ''):
            continue
        if str(eintrag.get('command', '')) == (ausser_command or ''):
            continue
        erteilt = _als_zeit(eintrag.get('granted_ts'))
        laeuft_ab = _als_zeit(eintrag.get('expires_ts'))
        if laeuft_ab is None or jetzt > laeuft_ab:
            continue
        if erteilt is None or jetzt > erteilt + MAX_TTL_SEKUNDEN:
            continue
        gilt, _ = herkunft_pruefen(eintrag)
        if not gilt:
            continue
        treffer.append(eintrag)
    treffer.sort(key=lambda e: str(e.get('granted_ts', '')), reverse=True)
    return treffer


def wortlaut_hinweis(freigabe, aktueller_befehl):
    """Text fuer den Fall, dass eine gueltige Freigabe fuer DIESEN Pane
    vorliegt -- nur fuer einen ANDEREN Wortlaut als den gerade angehaltenen.
    Nennt die Stelle, an der sich die beiden Texte unterscheiden: meist reicht
    schon eine veraenderte Zeile, um die eigene Freigabe zu verfehlen."""
    frei_cmd = str(freigabe.get('command', ''))
    jetzt_cmd = aktueller_befehl or ''
    idx = erster_unterschied(frei_cmd, jetzt_cmd)
    return (
        "RUECKFRAGE, keine Ablehnung -- fuer DIESEN Pane liegt bereits eine Freigabe, aber\n"
        "  fuer einen ANDEREN Wortlaut.\n"
        "  Freigegeben (erteilt %s):\n"
        "    %s\n"
        "  Jetzt gesendet:\n"
        "    %s\n"
        "  Die Texte unterscheiden sich ab Zeichen %d -- oft reicht schon eine veraenderte\n"
        "  Pruef- oder Verifikationszeile am Ende, um die eigene Freigabe zu verfehlen. Hast\n"
        "  Du den Wortlaut zwischen zwei Versuchen selbst veraendert, bist DU die Ursache.\n"
        "  Was DU tust: sende GENAU den freigegebenen Wortlaut oben, kein Zeichen anders --\n"
        "  keine neue Fassung bauen, keine weitere Rueckfrage abwarten.\n"
        "  Praxis, die das sicherstellt: den Wortlaut beim ERSTEN Anhalten wortwoertlich in\n"
        "  eine Datei schreiben und jeden weiteren Versuch nur noch von DORT lesen, nie neu\n"
        "  tippen."
        % (freigabe.get('granted_ts', '?'), kuerzen_mitte(frei_cmd), kuerzen_mitte(jetzt_cmd), idx)
    )


def deny_text(muster_eintrag, ttl_minuten):
    """Der Text, den der angehaltene Worker sieht.

    Er muss eines leisten: klarmachen, dass hier GEWARTET wird, nicht
    endgueltig abgelehnt. Ein Worker, der eine Ablehnung liest, baut eine
    Ausweichloesung -- an einer Frage vorbei, die in Sekunden beantwortet
    waere. Genau das hat am 2026-08-04 45 Minuten gekostet.
    """
    grund = muster_eintrag.get('grund') or 'Befehl aus der Musterliste der Einstellungen.'
    return (
        "RUECKFRAGE, keine Ablehnung -- dieser Befehl wartet auf eine einmalige Freigabe.\n"
        "  Angeschlagener Eintrag: %s\n"
        "  Warum gefragt wird: %s\n"
        "  Was jetzt passiert: der Befehl steht ab sofort in der Freigabe-Ansicht der\n"
        "  Workbench (Abschnitt \"Angehaltene Worker\") und wartet dort auf Annehmen oder\n"
        "  Ablehnen durch einen Menschen.\n"
        "  Was DU tust: kurz warten und DENSELBEN Befehl unveraendert noch einmal\n"
        "  ausfuehren. Keine Ausweichloesung bauen, keine Umformulierung -- die Freigabe\n"
        "  gilt fuer genau diesen Wortlaut in genau diesem Verzeichnis.\n"
        "  Praxis, die genau das sicherstellt (2026-08-10 gemessen: schon eine veraenderte\n"
        "  Pruefzeile am Ende macht aus der Freigabe eine fuer einen anderen Text): schreib\n"
        "  den Befehl JETZT, beim ersten Anhalten, wortwoertlich in eine Datei und fuehr bei\n"
        "  jedem weiteren Versuch NUR NOCH diese Datei aus, statt ihn neu zu tippen.\n"
        "  Die Freigabe gilt fuer EINEN Durchlauf und ist danach verbraucht; ohne\n"
        "  Entscheidung laeuft sie nach rund %d Minuten von selbst ab.\n"
        "  Angehalten von bash-guard-muster."
        % (eintrag_label(muster_eintrag), grund, ttl_minuten)
    )
