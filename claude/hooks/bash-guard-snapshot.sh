#!/bin/bash
# Zweck: blockt destruktive Befehle, wenn von den betroffenen Daten kein
#        Snapshot existiert.
# Event: PreToolUse, matcher Bash.
# Warum: Stehende Regel (CLAUDE.md): "Snapshot before destructive ops: copy
#        non-trivial data to ~/.local/trash-snapshots/<date>-<name>/ before
#        deleting or overwriting it." Bisher reine Disziplin -- wer sie
#        vergisst, merkt es erst, wenn die Daten weg sind.
# Erfasste Formen: rm -r / rm -rf, mv auf ein existierendes Ziel, Umleitung '>'
#        auf eine existierende Datei, truncate, shred, dd of=, git checkout --
#        <pfad> / git restore <pfad> auf Dateien mit uncommitteten Aenderungen,
#        git clean -fd, git reset --hard bei schmutzigem Working Tree.
#
# MASS -- der wichtigste Teil dieses Hooks. Er feuert bei ALLTAGSARBEIT, und
#        ein Guard, der staendig falsch anschlaegt, wird binnen einer Woche
#        umgangen oder abgeschaltet; dann ist er schaedlicher als keiner.
#        Deshalb gilt: geblockt wird nur, wenn ALLE vier Aussagen zutreffen.
#        (1) Das Ziel liegt nicht an einem Wegwerf-Ort.
#        (2) Es haengt ueberhaupt Inhalt dran -- ein nicht existierender Pfad,
#            ein leeres Verzeichnis, eine 0-Byte-Datei und ein Symlink sind
#            trivial und gehen durch. Auch ein Glob, der auf nichts passt --
#            fuer `rm -r`/`rm -rf` mit einem reinen Glob-Ziel (2026-08-04,
#            N6 der Masterliste) sogar EXPLIZIT: die CLI fragt bei jedem
#            Glob-Ziel unabhaengig von diesem Hook selbst nach ("Dangerous rm
#            operation on statically-unresolvable target"), ein stilles
#            Nichts-dagegen-haben unterdrueckt das nicht. Deshalb meldet
#            snapshot_classify.py fuer den verifiziert-leeren Fall ein
#            explizites 'allow' mit Begruendung, statt nur zu schweigen --
#            siehe rm_verified_empty_glob_reason() dort fuer die genauen
#            Grenzen (ein Statement, keine Verkettung, wirklich jedes
#            Argument ein leerer Glob).
#        (3) Der Inhalt liegt nicht bereits vollstaendig und unveraendert in
#            git. Ein committeter, sauberer Pfad IST gesichert -- dafuer noch
#            einen Snapshot zu verlangen, waere Zeremonie ohne Nutzen.
#        (4) Es gibt keinen Snapshot: weder im selben Befehl (ein cp/rsync/
#            ditto/tar nach ~/.local/trash-snapshots/, das denselben Pfad
#            nennt) noch als frischer Eintrag dort aus den letzten zwei Stunden.
#        Die Wegwerf-Orte und die Schwellen stehen NICHT hier, sondern in
#        snapshot-guard-exempt.conf neben diesem Skript -- eine Liste im Code
#        veraltet und wird dann durch Abschalten des Guards "gepflegt".
# Default-Deny bei unentscheidbaren Formen: ein Zielpfad aus einer nicht
#        aufloesbaren Variablen/Kommandosubstitution, unausgeglichene
#        Anfuehrungszeichen bei gleichzeitig destruktiver Form, oder ein
#        git-Zustand, den der Hook nicht lesen kann.
#
# BEWUSST NICHT erfasst (Begruendung, damit die Luecken bekannt sind statt
#        unbemerkt): nicht-rekursives `rm <datei>` und `cp` auf ein
#        existierendes Ziel -- beide kommen im Minutentakt vor und wuerden den
#        Guard in Rauschen ertraenken; und destruktive Befehle hinter `ssh` --
#        deren Pruefung braucht Aussagen ueber das ENTFERNTE Dateisystem
#        (existiert der Pfad, ist er leer, liegt er in git), die lokal nicht zu
#        haben sind. Ein Hook, der dort raet, blockt entweder alles oder nichts.
#
# Der Hook veraendert NICHTS: er liest Dateigroessen und ruft git ausschliesslich
#        lesend auf (status --porcelain, ls-files, clean -n als Trockenlauf),
#        jeweils mit --no-optional-locks, damit nicht einmal der git-Index
#        angefasst wird.
set -uo pipefail

HOOKSELFDIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Interpreter absolut aufrufen (Haertung 2026-07-28, Stress-Befund B02).
/usr/bin/python3 "$HOOKSELFDIR/lib/snapshot_classify.py"
exit $?
