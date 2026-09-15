# regeln/vorfuehrung.md

Inhalt: was gilt, wenn jemand einer Sitzung zusieht. Gilt seit: 2026-09-07.

Auslöser: bevor eine Sitzung beginnt oder weiterläuft, die ein Dritter mitliest —
Bildschirmfreigabe, Vorstellungsgespräch, Vorführung, jemand sitzt daneben.

## Der Ordner, in dem so gearbeitet wird

`~/AI/Demo` ist die Bühne. Seine `CLAUDE.md` trägt die vollständigen Anweisungen für
mitverfolgte Sitzungen und wird beim Start automatisch geladen: keine Namen, keine
Zugangsdaten, keine privaten Themen, kein Blick in andere Ordner oder in den
Wissensspeicher, keine außenwirksamen Handlungen, und kein `/clear` während der
Vorführung, weil die Hooks beim Sitzungsstart Angaben in den Kontext schreiben, die dort
nicht hingehören. Der Ordner enthält absichtlich keine vorbereitete Aufgabe.

Eine Vorführung läuft in einer eigenen Sitzung in diesem Ordner, nie in einer laufenden
Arbeitssitzung.

## Was in der Werkbank sichtbar bleibt

Die Sitzungsliste der Werkbank kommt aus den Zustandsdateien in
`~/.claude/workbench/sessions/`. Wer eine Sitzung aus der Liste nehmen will, verschiebt
ihre Zustandsdatei; die tmux-Sitzung läuft dabei ungestört weiter, und der Weg zurück ist
das Zurücklegen der Datei. Am 07.09.2026 galt dabei Maßgabe des Nutzers: die Sitzungen
unter `~/AI` durften stehen bleiben, alles andere und die führende Sitzung selbst wurden
versteckt. Snapshot und Rückweg lagen in
`~/.local/trash-snapshots/2026-09-07-workbench-sessions/` mit `wiederherstellen.sh`.

Der Name der Maschine steht in der Fußleiste der Werkbank und kommt aus dem Feld
`machine` in `~/.claude/workbench/settings.json` (sonst aus dem Hostnamen). Er wird beim
Programmstart gelesen, eine Änderung wirkt also erst beim nächsten Start.
