#!/usr/bin/env python3
"""Der Ablehnungsverlauf (guard-blocks.log) und seine monatliche Rotation.

Entscheidung vom 09.10.2026: der Verlauf wird MONATLICH rotiert. Alte Monate
liegen als guard-blocks.YYYY-MM.log.gz neben der aktiven Datei (fuer Analysen
erhalten), die aktive Datei haelt nur den aktuellen Monat, die App zeigt nur diesen.
Gemessen vorher: 2,3 MB, wachsend, vom Kern in jedem 2-s-Takt komplett gelesen.

WIE ROTIERT WIRD: beim Schreiben, nie per Uhr (Hausregel „keine automatischen
Laeufe"). `anhaengen()` sieht an der ersten Zeile der aktiven Datei (`"ts"` steht
in jeder Zeile an erster Stelle), ob sie Eintraege eines aelteren Monats traegt, und
rotiert dann selbst.

KEIN ZEILENVERLUST:
  * Alle Schreiber dieses Moduls halten eine geteilte Sperre (flock LOCK_SH auf
    <log>.lock) von vor dem Oeffnen bis nach dem Schreiben; die Rotation haelt die
    ausschliessliche (LOCK_EX). Ein Schreiber kann also nie in eine Datei schreiben, die
    gerade umbenannt und gelesen wird.
  * Auch der Kern (freigaben.ts `verlaufAnhaengen`; Node hat kein flock) und die beiden
    Schreibstellen in shell/wb-freigabe gehen seit 09.10.2026 (Auftrag perf-aufgaben)
    durch dieses Modul: sie rufen `guard_log.py anhaengen --log PFAD` mit der Zeile auf
    stdin. Wer das Modul nicht findet oder wessen Aufruf scheitert, schreibt die Zeile
    wie bisher selbst, ohne Sperre (eine Zeile ohne Sperre ist besser als keine).
  * Solche Schreiber ohne Sperre oeffnen die Datei und schreiben Mikrosekunden
    spaeter. Die Rotation benennt die Datei um und wartet GNADE_SEKUNDEN, bevor sie liest:
    eine Zeile, die noch in den umbenannten Inode faellt, ist dann drin. Ein Schreiber,
    der zwischen Oeffnen und Schreiben laenger als diese Frist angehalten wird, ist der
    einzige nicht gedeckte Fall -- und nur noch der Rueckfall.
  * Die Rotation loescht die umbenannte Datei erst, nachdem jedes Archiv per
    Ersetzen (os.replace) fertig auf der Platte liegt. Bricht sie vorher ab, bleibt
    <log>.rotiert-<pid> liegen und wird von der naechsten Rotation nachgeholt (dabei
    kann ein Monat doppelt im Archiv stehen -- Duplikat statt Verlust).
  * Archive wachsen als gzip-Glieder (mehrere Glieder hintereinander sind ein
    gueltiges gzip, `zcat`/`gzip.open` lesen sie als eine Folge).

Aufruf als Werkzeug (eine Zeile von stdin anhaengen; Bestand einmalig rotieren, mit Trockenmodus):
    guard_log.py anhaengen [--log PFAD]                 Zeile auf stdin, Exit 0 = geschrieben
    guard_log.py rotieren [--log PFAD]                  Trockenmodus: nur zaehlen
    guard_log.py rotieren --ausfuehren [--log PFAD] [--snapshot-dir DIR]
"""
import errno
import fcntl
import glob
import gzip
import os
import re
import shutil
import sys
import time

GNADE_SEKUNDEN = 0.2
SPERR_FRIST_SEKUNDEN = 3.0
_TS = re.compile(rb'"ts":\s*"(\d{4})-(\d{2})')


def log_pfad():
    return os.environ.get('AWB_GUARD_LOG') or os.path.expanduser('~/.pi-workers/guard-blocks.log')


def monat_jetzt(jetzt=None):
    t = time.gmtime(jetzt)
    return '%04d-%02d' % (t.tm_year, t.tm_mon)


def monat_der_zeile(zeile):
    """'YYYY-MM' aus dem Zeitstempel am Anfang einer Zeile (bytes), sonst None."""
    m = _TS.search(zeile[:96])
    return '%s-%s' % (m.group(1).decode(), m.group(2).decode()) if m else None


def archiv_pfad(pfad, monat):
    basis = pfad[:-4] if pfad.endswith('.log') else pfad
    return '%s.%s.log.gz' % (basis, monat)


def _erster_monat(pfad):
    try:
        with open(pfad, 'rb') as fh:
            return monat_der_zeile(fh.read(128))
    except OSError:
        return None


def veraltet(pfad, jetzt=None):
    """Traegt die aktive Datei (laut ihrer ersten Zeile) Eintraege eines aelteren Monats, oder liegt ein Rotationsrest?"""
    if glob.glob(glob.escape(pfad) + '.rotiert-*'):
        return True  # Rest einer abgebrochenen Rotation: nachholen
    erster = _erster_monat(pfad)
    return erster is not None and erster < monat_jetzt(jetzt)


class _Sperre:
    """flock auf <pfad>.lock; scheitert die Sperre in der Frist, laeuft der Aufrufer ohne sie."""

    def __init__(self, pfad):
        self.pfad = pfad + '.lock'
        self.fh = None
        self.art = None

    def holen(self, art):
        self.freigeben()
        try:
            fh = open(self.pfad, 'a')
        except OSError:
            return False
        ende = time.monotonic() + SPERR_FRIST_SEKUNDEN
        while True:
            try:
                fcntl.flock(fh.fileno(), art | fcntl.LOCK_NB)
                self.fh, self.art = fh, art
                return True
            except OSError as e:
                if e.errno not in (errno.EAGAIN, errno.EACCES) or time.monotonic() > ende:
                    fh.close()
                    return False
                time.sleep(0.01)

    def freigeben(self):
        if self.fh is not None:
            try:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            finally:
                self.fh.close()
                self.fh = None
                self.art = None


def _in_archiv(ziel, daten):
    """Haengt `daten` als gzip-Glied an `ziel` (atomar ueber Ersetzen)."""
    tmp = '%s.tmp%d' % (ziel, os.getpid())
    # 0600 wie die aktive Datei: Archive enthalten dieselben abgelehnten Befehle. Ein Rest mit
    # derselben PID (abgestuerzter Lauf) behielte seinen alten Modus, daher erst entfernen.
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as aus:
        if os.path.exists(ziel):
            with open(ziel, 'rb') as alt:
                shutil.copyfileobj(alt, aus)
        aus.write(gzip.compress(daten))
        aus.flush()
        os.fsync(aus.fileno())
    os.replace(tmp, ziel)


def _anhaengen_roh(pfad, daten):
    fd = os.open(pfad, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, daten)
    finally:
        os.close(fd)


def _verteilen(quelle, pfad, jetzt, nur_zaehlen=False):
    """Zeilen aus `quelle` auf Archive (aeltere Monate) und aktive Datei (Rest) verteilen.

    Zeilen ohne lesbaren Zeitstempel und Zeilen des aktuellen oder eines kuenftigen
    Monats bleiben in der aktiven Datei. Gibt {monat: (zeilen, bytes)} der Archive zurueck.
    """
    aktuell = monat_jetzt(jetzt)
    with open(quelle, 'rb') as fh:
        zeilen = fh.read().splitlines(keepends=True)
    alt, bleibt = {}, []
    for z in zeilen:
        if not z.endswith(b'\n'):
            z += b'\n'
        m = monat_der_zeile(z)
        if m is not None and m < aktuell:
            alt.setdefault(m, []).append(z)
        else:
            bleibt.append(z)
    bericht = {m: (len(zl), sum(len(z) for z in zl)) for m, zl in sorted(alt.items())}
    bericht['aktiv'] = (len(bleibt), sum(len(z) for z in bleibt))
    if nur_zaehlen:
        return bericht
    for m, zl in sorted(alt.items()):
        _in_archiv(archiv_pfad(pfad, m), b''.join(zl))
    if bleibt:
        _anhaengen_roh(pfad, b''.join(bleibt))
    return bericht


def rotieren(pfad, jetzt=None):
    """Die aktive Datei auf Archive und aktuellen Monat verteilen. Der Aufrufer haelt LOCK_EX."""
    # Liegengebliebenes einer abgebrochenen Rotation zuerst.
    reste = sorted(glob.glob(glob.escape(pfad) + '.rotiert-*'))
    tmp = '%s.rotiert-%d' % (pfad, os.getpid())
    try:
        os.rename(pfad, tmp)
        reste.append(tmp)
        time.sleep(GNADE_SEKUNDEN)
    except FileNotFoundError:
        pass
    for rest in reste:
        _verteilen(rest, pfad, jetzt)
        os.unlink(rest)
    return bool(reste)


def anhaengen(pfad, zeile, jetzt=None):
    """Eine Zeile (str, ohne Zeilenende) an den Verlauf haengen; rotiert vorher bei Bedarf.

    Wirft OSError nur, wenn das Schreiben selbst scheitert; ein Fehler der Rotation
    haelt die Zeile nicht auf.
    """
    d = os.path.dirname(pfad)
    if d:
        os.makedirs(d, exist_ok=True)
    daten = (zeile + '\n').encode('utf-8')
    sperre = _Sperre(pfad)
    try:
        if veraltet(pfad, jetzt) and sperre.holen(fcntl.LOCK_EX):
            try:
                if veraltet(pfad, jetzt):
                    rotieren(pfad, jetzt)
            except Exception as e:  # noqa: BLE001 -- die Zeile geht vor der Rotation
                sys.stderr.write('guard_log: Rotation fehlgeschlagen: %s\n' % e)
        # Geteilt schreiben; scheitert die Sperre, wird trotzdem geschrieben (eine Zeile
        # ohne Sperre ist besser als keine).
        sperre.holen(fcntl.LOCK_SH)
        _anhaengen_roh(pfad, daten)
    finally:
        sperre.freigeben()


def _werkzeug(argv):
    import argparse
    p = argparse.ArgumentParser(prog='guard_log.py')
    p.add_argument('befehl', choices=['rotieren', 'anhaengen'])
    p.add_argument('--log', default=None)
    p.add_argument('--ausfuehren', action='store_true', help='ohne diese Angabe nur zaehlen (Trockenmodus)')
    p.add_argument('--snapshot-dir', default=None,
                   help='Vorgabe ~/.local/trash-snapshots/<Datum>-guard-blocks')
    a = p.parse_args(argv)
    pfad = a.log or log_pfad()
    if a.befehl == 'anhaengen':
        zeile = sys.stdin.buffer.read().decode('utf-8', 'replace').rstrip('\r\n')
        if not zeile:
            print('guard_log: keine Zeile auf stdin', file=sys.stderr)
            return 2
        try:
            anhaengen(pfad, zeile)
        except OSError as e:
            print('guard_log: nicht geschrieben: %s' % e, file=sys.stderr)
            return 1
        return 0
    if not os.path.exists(pfad):
        print('%s: keine aktive Datei, nichts zu tun' % pfad)
        return 0
    bericht = _verteilen(pfad, pfad, None, nur_zaehlen=True)
    print('Aktive Datei: %s (%d Bytes)' % (pfad, os.path.getsize(pfad)))
    for m, (n, b) in bericht.items():
        if m == 'aktiv':
            print('  bleibt aktiv:  %6d Zeilen, %9d Bytes' % (n, b))
        else:
            print('  -> %s: %6d Zeilen, %9d Bytes  (%s)' % (m, n, b, os.path.basename(archiv_pfad(pfad, m))))
    if not a.ausfuehren:
        print('Trockenmodus: nichts geaendert. Mit --ausfuehren rotieren (vorher Snapshot).')
        return 0
    if len(bericht) == 1:
        print('Nichts zu rotieren.')
        return 0
    snap = a.snapshot_dir or os.path.expanduser(
        '~/.local/trash-snapshots/%s-guard-blocks' % time.strftime('%Y-%m-%d'))
    os.makedirs(snap, exist_ok=True)
    ziel = os.path.join(snap, os.path.basename(pfad))
    if os.path.exists(ziel):
        ziel += time.strftime('.%H%M%S')
    shutil.copy2(pfad, ziel)
    print('Snapshot: %s' % ziel)
    sperre = _Sperre(pfad)
    if not sperre.holen(fcntl.LOCK_EX):
        print('Sperre %s.lock nicht zu bekommen -- nichts geaendert.' % pfad, file=sys.stderr)
        return 1
    try:
        rotieren(pfad)
    finally:
        sperre.freigeben()
    print('Rotiert. Aktive Datei jetzt %d Bytes.' % os.path.getsize(pfad))
    return 0


if __name__ == '__main__':
    sys.exit(_werkzeug(sys.argv[1:]))
