# Schema: Fallenbuch je Projekt (`FALLEN.yaml`)

Grundlage: [[brain5-forschung-gedaechtnis]] I2 (Tripwires), I6 (Entscheidungsbuch mit
Gültigkeit), I10 (verifizierte Erinnerung). Eine Datei je Projekt unter
`20-projects/<projekt>/FALLEN.yaml`. Wird von `tripwire.sh` (`PreToolUse`) und später vom
Relevanztor/Generator (KERN.md, I5) gelesen — nie von Hand aus einem Fließtext abgeleitet,
sondern selbst die Quelle.

## Datei

```yaml
version: 1
projekt: a machine-bound project
fallen:
  - id: tb26
    falle: "Rundung nur in einer von zwei Rechnungen."
    gegenmittel: "Vor beiden Rechnungen runden, nicht nur einer."
    quelle: "2026-09-11-eine-rundung-an-zwei-stellen"
    seit: "2026-09-11"
    status: gilt
    abgeloest_durch: null
    schaden: 2
    ausloeser:
      - diff: "round\\("
        pfad: "ProjectX/*.py"
    anker: "ProjectX/daily/profit_guard.py"
```

## Felder je Eintrag

| Feld | Pflicht | Typ | Bedeutung |
|---|---|---|---|
| `id` | ja | String | stabil, projektweit eindeutig (bevorzugt das `tb<nn>`-Kürzel aus der Quelle, sonst `<projekt>-<lfd>`) |
| `falle` | ja | String, 1 Satz | was schiefging, knapp und konkret |
| `gegenmittel` | ja | String, 1 Satz | was stattdessen zu tun ist |
| `quelle` | ja | String | Vault-Notiz **ohne** `.md`, relativ zum Vault (z. B. `20-projects/a machine-bound project/2026-09-11-eine-rundung-an-zwei-stellen` oder nur der Notiz-Slug, wenn eindeutig) |
| `seit` | ja | String `JJJJ-MM-TT` | Datum, ab dem die Falle gilt |
| `status` | ja | `gilt` \| `abgeloest` | abgelöste Einträge werden nie eingespielt, bleiben aber in der Datei sichtbar (Gültigkeitsidee, I6) |
| `abgeloest_durch` | nein | String oder `null` | `id` des ablösenden Eintrags oder Freitext-Verweis; nur bei `status: abgeloest` gefüllt |
| `schaden` | ja | Ganzzahl 1–3 | grobe Schadenshöhe (1 = kosmetisch/Zeitverlust, 2 = falsches Ergebnis/Nacharbeit, 3 = Konto-/Datenschaden), Grundlage für spätere Priorisierung (I5: erwarteter Nutzen je Token) |
| `ausloeser` | nein | Liste von Trigger-Objekten | fehlt dieses Feld, bleibt der Eintrag ohne Hook-Wirkung — er zählt trotzdem für KERN.md/Suche. Ein Eintrag **ohne** sinnvollen Auslöser bekommt lieber gar keinen als einen, der bei jedem Aufruf feuert (Auftragsvorgabe) |
| `anker` | nein | String | Datei (`pfad/zur/datei.py`) oder `pfad/zur/datei.py:Symbolname`, das existieren muss. Fehlt es, markiert der Hook den Treffer als „veraltet?" statt ihn normal auszugeben (I10) |

## Trigger-Objekt (Einträge der `ausloeser`-Liste)

Jedes Element ist ein Objekt mit einem oder mehreren der folgenden Schlüssel. **Innerhalb
eines Elements müssen alle angegebenen Schlüssel zugleich zutreffen (UND)**, die Elemente
der Liste sind Alternativen (ODER) — ein Eintrag feuert, sobald irgendein Element vollständig
zutrifft.

| Schlüssel | Bedeutung | Geprüft gegen |
|---|---|---|
| `pfad` | Glob, relativ zum Repo-Wurzelverzeichnis (`fnmatch`-Syntax) | bei `Edit`/`Write`: `file_path` des Aufrufs; bei `Bash`: jedes Pfad-artige Token im Befehlstext |
| `befehl` | Python-Regex (`re.search`, `IGNORECASE`) | der volle `command`-String eines `Bash`-Aufrufs |
| `diff` | Python-Regex (`re.search`, `IGNORECASE`) | der neue Text: `new_string` bei `Edit`, `content` bei `Write` |
| `ohne_text` | `true` (nur mit `befehl`) | `befehl` prüft dann nur Shell-Code: Inhalte von Quotes, Kommentaren und Heredoc-Rümpfen zählen nicht; was eine Shell trotzdem ausführt, zählt weiter (Strings für `ssh HOST '…'`/`bash -c '…'`, Backticks, `$(…)`, Heredocs an `bash`/`sh`/`ssh`). Ein Skript, das per Heredoc in eine Datei geschrieben wird, prüft er wie `Write` nicht. Eingeführt 13.10.2026 für `g-killmuster` (8 von 21 Rauschwarnungen der Beobachtung 09.–13.10. waren `grep -n "pkill"` oder Text in Heredocs) |

Ein Schlüssel, dessen Datenquelle für den aktuellen Werkzeugaufruf nicht existiert (z. B.
`diff` bei einem `Bash`-Aufruf), macht das ganze Element ungültig — es wird nie geraten,
nur geprüft, was wirklich vorliegt. Ein Element ganz ohne bekannte Schlüssel zählt nie als
Treffer.

**Achtung `**` in `pfad`:** Python-`fnmatch` (anders als Shell-Globs) behandelt `/` NICHT
als besonderes Zeichen — ein einfaches `*` matcht bereits über beliebig viele
Verzeichnisebenen hinweg, `**` verhält sich identisch zu `*` und bringt nichts zusätzlich.
Der Fehler, der daraus entsteht: `"ProjectX/**/tests/**/*.py"` verlangt WÖRTLICH die
Zeichenfolge `/tests/` mit einem Schrägstrich davor — eine Datei direkt unter
`ProjectX/tests/x.py` (keine weitere Ebene davor) fällt dadurch durch. Richtig:
`"ProjectX/*tests/*.py"` (matcht `ProjectX/tests/x.py`, `ProjectX/dana/tests/x.py`
und `ProjectX/tests/deploy_gate/x.py` gleichermaßen). Ebenso `"ProjectX/*.py"` statt
`"ProjectX/**/*.py"` für „irgendeine Python-Datei unter ProjectX/, gleich wie tief".
Vor jedem neuen Muster mit `python3 -c "import fnmatch; print(fnmatch.fnmatch(PFAD, MUSTER))"`
gegen einen echten Beispielpfad gegenprüfen, nicht aus Shell-Glob-Gewohnheit übernehmen.

## Statuswechsel

Löst eine neue Entscheidung eine Falle ab: bestehenden Eintrag NICHT löschen, sondern
`status: abgeloest` und `abgeloest_durch` setzen. Der Hook liest nur `status: gilt`-Einträge.

## Wo geprüft

`_meta/tools/hooks/tripwire_core.py` (Import: `tripwire_for`) parst diese Datei, cached
nach `mtime` der YAML-Datei (kein Neuparsen bei unverändertem Stand), und wird von
`_meta/tools/hooks/tripwire.sh` (PreToolUse-Hook, Matcher `Bash|Edit|Write`) sowie vom
Replay-Adapter der Spur `replay-messung` (`_meta/tools/eval/replay/`) aufgerufen.

## Eingebaute Shell-Tripwires (ohne FALLEN.yaml)

Zwei Wiederholungsfehler hängen vom Befehl selbst ab und lassen sich nicht als `befehl`-Regex
ausdrücken. `tripwire_shell.py` prüft sie bei jedem `Bash`-Aufruf, **unabhängig vom Projekt**
(auch wenn der Arbeitsordner keinem Projekt zugeordnet ist), und hängt die Warnung an dieselbe
Ausgabe an (Kopf `Fallenbuch-Tripwire (Shell)`, `brain doctor` zählt sie mit). Gleicher Befund
höchstens einmal je Sitzung; blockiert nie. Abschalter: `BRAIN_TRIPWIRE_SHELL=0`.

| Klasse | Gewarnt wird | Nicht gewarnt |
|---|---|---|
| `pgrep-selbsttreffer` | `pgrep`/`pkill -f MUSTER`, wenn MUSTER auf den eigenen Befehlstext passt und die ausführende Shell Linux ist (lokal auf peer; Text für `ssh HOST '…'`, `limactl shell … bash -c '…'`) | macOS lokal ohne `-a` (BSD-pgrep schließt eigene Vorfahren aus), `-x`, `-u/-U/-g/-G/-P/-s/-t/-F`, `\| grep -v …`, `$$` in derselben Zeile, einziger oder letzter einfacher Befehl eines `-c`-Strings (die Shell ersetzt sich per exec), unquotierter Befehl nach `ssh HOST` |
| `backticks-in-shelltext` | Backticks, die eine Shell ausführt: in doppelten Quotes, ungequotet, im Rumpf eines ungequoteten Heredocs, in Text für `ssh`/`bash -c` | einfache Quotes, gequotete Heredocs (`<<'EOF'`, `<<"EOF"`, `<<\EOF`), `\``, Kommentare, leeres Paar |

Messung und Belege: Ergebnis des Auftrags b6-tripwire (28.09.2026).
