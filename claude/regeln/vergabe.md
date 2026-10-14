# vergabe — welcher Worker, welches Modell, welches Kontingent

Auslöser: vor jedem Start eines Workers. Stand: 2026-09-18, Codex-Free-Umstellung 2026-10-13, Neufassung der Zuteilung
2026-10-13 nach Artificial-Analysis-Zahlen (Auftrag des Nutzers, die Vergabe eindeutig zu machen). Diese Datei ist der einzige maßgebliche Ort für Reihenfolge und
Parallelität. Sie ersetzt die Reihenfolgen in den Abschnitten 06, 07, 08 und 22 von
`regeln/orchestrierung.md`; jene bleiben als Herkunft und für Einzelfakten lesbar.

## 1. Was ein Worker ist

Ein Worker ist ein sichtbarer Werkbank-Pane, gestartet mit `pi-worker` oder `claude-worker`.
Ein eigenes tmux-Fenster nach der Vorgabe `workerLayout=window` gilt als sichtbar (der Nutzer,
2026-09-25); bei der Meldung „arbeitet unsichtbar“ dem Menschen den Weg zum Fenster nennen.
Native Subagenten des Harness (Agent-/Task-Werkzeug, Workflow) sind kein Worker. Sie sind nur
zulässig, wenn der Nutzer ausdrücklich „Subagent" sagt oder die Sitzung ohne tmux-Werkbank läuft;
dann wird das im Chat gesagt. Der eigene Pane ist `$TMUX_PANE`, nie `tmux display -p` ohne Ziel.
**Haiku-Subagenten in Workern (der Nutzer, 2026-10-13):** „du kannst aber zum beisiel die arbeit weiter aufteilen
(lassen) auf mehr worker und denen auch erlauben subagents mit haiku5.5 zu benutzen.“ Ein Worker darf native
Subagenten auf `haiku` (Haiku 5.5) nutzen, wenn sein Auftrag das ausdrücklich nennt. Er startet weiter keine
Worker, prüft die Ergebnisse seiner Subagenten selbst und gibt ihnen dieselben Grenzen (Pfade, Tafel, keine
Geheimnisse, kein Push).

## 2. Vor der ersten Vergabe einer Sitzung messen

```
wb-kontingent auffrischen && wb-kontingent zeigen
wb-budget --limit
```

`zeigen` ohne `auffrischen` liefert den Stand des letzten Laufs. „unbekannt" heißt nicht
gemessen, also nicht „frei". Steht nach dem Auffrischen weiter „unbekannt" da (heute: `agy`),
gilt die Spur als kostenloses Kontingent ohne Zähler nach Abschnitt 4.

## 3. Erst die Stufe, dann die Spur

Die Stufe folgt der Aufgabe nach der Tabelle in Abschnitt 3a (seit 2026-10-13 maßgeblich; die Kurztabelle in
`orchestrierung.md`, Abschnitt 13, ist Herkunft), nie dem Kontostand. Trägt die nächste freie Spur die Stufe nicht, geht der Auftrag eine Spur weiter oder
wartet; er geht nie an ein schwächeres Modell.

Die Spuren in fester Reihenfolge. Es gewinnt die erste, die die Stufe trägt und Luft hat:

| Rang | Spur | Modell | trägt | Luft hat sie, wenn |
|---|---|---|---|---|
| 1 | lokal | `qwen38` (seit 2026-09-20 über Splash; weitere in `lokale-modelle.md`) | enge Aufgaben, Bulk, DSGVO, Recherche; **auch Coding**, solange die Aufgabe klar zugeschnitten ist und wenig Lesestoff braucht | höchstens VIER Ströme am Server (wird durchgesetzt), Speicher reicht; nichts Latenzkritisches; **nicht bei viel Repo-Lesen**; **nicht, wenn eine Kette oder der Nutzer auf das Ergebnis wartet** (2026-10-13: „schneller arbeiten“) |
| 2 | kostenlose Kontingente | `agy-*`, OpenRouter `:free`, Copilot Free, **Codex Free (`codex-luna`, seit 2026-10-13)** | Recherche, Bulk, kurze klare Aufträge; Codex Luna zusätzlich die Luna-Zeilen der Kurztabelle (auch Coding) | `wb-kontingent pruefen <spur>` gibt 0 und auf der Spur läuft kein anderer Worker |
| 3 | Claude (seit 2026-10-13 allein; bis dahin gleichrangig mit dem Codex-Abo) | nach Tabelle 3a | alles | Verbrauch unter der Tageslinie aus `wb-budget --limit` |
| 4 | Cline Pass (seit 2026-10-09 hinter den Abos, der Nutzer) | `opencode-cline-pass-glm-5-3-flash` | nur kurze, eng geschnittene Aufträge ohne Sichtbares und ohne Belegrecherche | Claude über der Tageslinie und Codex Free erschöpft; alle drei Pass-Fenster unter dem Tagesanteil; 15-Minuten-Beleg |

Feste Ausnahmen, unabhängig vom Rang: Sichtbares für Menschen geht an `opus:high`
(bis 2026-10-12 auch `codex-sol:high`; Sol gibt es im Free-Plan nicht), auch Website-Design. **Fable wird nicht mehr eingesetzt** (der Nutzer,
2026-09-23: Opus 5.5 ist laut Tests besser als Fable 5.1, der Aufpreis lohnt sich für keine Aufgabe). **`opus` heißt immer das neueste Opus** (der Nutzer, 2026-09-23;
heute Opus 5.5, `claude-opus-5-5`): Opus 5.5 ersetzt Opus 5 für Worker und Orchestratoren,
und ein neu erscheinendes Opus löst das vorige ohne neue Regel ab. Wo ältere Abschnitte
`opus5` schreiben, ist das neueste Opus gemeint. Bezahlte OpenRouter-Modelle sind gesperrt, bis der Nutzer auflädt.
Breite Vergleiche über viele Systeme überspringen Rang 1; das wird im Chat mit einem Satz
begründet. Die frühere Begründung („das lokale Fenster reicht dafür nicht") gilt nicht mehr — das
Fenster ist 262144 Token und wurde am 20.09. mit einer Anfrage über 191.361 Token gefahren. Der
Grund ist jetzt ein anderer und gemessen: **lange Eingaben kosten Zeit, nicht Platz.**

**Was Rang 1 am 21.09. gemessen NICHT trägt, mit Zahlen statt Gefühl.** Zwei qwen38-Worker an
einem großen TypeScript-Baum liefen 2 h 40 min und 2 h 12 min, ohne eine einzige Datei zu ändern:
8 bis 11 Tok/s bei 70k bis 75k Kontext, Prefill zuletzt 1097 s. Sie hingen nicht, sie waren zu
langsam. Zum Vergleich dieselbe Spur mit kurzen Eingaben: 58 Tok/s bei einem Strom, 108 Tok/s bei
vier zusammen. Die Regel daraus: **Aufgabe mit viel Repo-Lesen geht nicht an Rang 1**, auch wenn
sie inhaltlich passt. Ein enger Fix, ein Test, eine klar benannte Änderung über wenige Dateien:
ja, und ausdrücklich auch Coding (der Nutzer, 21.09.). Gegenmessung 23.09.: ein eng zugeschnittener
Auftrag (zwei Shell-Dateien, ein Test) blieb bei qwen38 nach 70 Minuten ohne Commit (85k Kontext,
12 Tok/s); Codex Terra erledigte denselben Auftrag in 13 Minuten. Lesestoff in Shell-Skripten von
über 1000 Zeilen zählt als „viel Repo-Lesen"; Frist für Rang 1 bei Coding: 30 Minuten ohne
Zwischenstand, dann Spur wechseln.

**Lokale Worker starten mit etwa 130k Kontext** (der Nutzer, 2026-09-26): 130k bis 140k ist in Ordnung, genommen wird der Wert, den der Server annimmt, z. B. die Stufe 131072 (`pi-worker --kontext 131072 <name> <lokales-modell> …`, Stufen: `wb-kontext stufen <modell>`); nie das volle Fenster.

**Vier Ströme sind die Obergrenze am gemeinsamen Splash-Server**, gemessen: vier zusammen
108 Tok/s, sechs 102, acht 101, und die Wartezeit bis zum ersten Token steigt von 0,84 s auf
4,87 s. `pi-worker` weist einen fünften Strom seit dem 21.09. ab, statt nur zu warnen. Mitgezählt
wird JEDER lebende Pane am Server, auch ein Orchestrator — läuft einer vom Nutzer, bleiben drei.
Offen und noch nicht gemessen: ob vier Ströme mit je 70k sich über den Präfix-Cache gegenseitig
ausbremsen. Solange das offen ist, gilt bei großen Kontexten Zurückhaltung statt der vollen Zahl.

**Cline Pass herabgestuft (2026-10-09, der Nutzer nach Messung):** In der Nacht zum 09.10. lieferten fünf
Cline-Pass-Worker (`glm-5.3-flash`) in drei Sitzungen nichts Brauchbares: ein Rechercheauftrag
schrieb in 4 Minuten einen erfundenen Rahmen ohne einen geladenen Beleg, drei Bau-Worker änderten in
35 Minuten nichts, ein Bau-Worker schrieb in 37 Minuten keine Zeile und las stattdessen fremde
Dateien im Hauptbaum. der Nutzer hat am 09.10. entschieden: Cline Pass steht hinter Claude und Codex (Rang 4). Zusätzlich gilt: Nach 15 Minuten
muss eine Änderung im Worktree oder ein Zwischenstand mit Beleg vorliegen, sonst wechselt der Auftrag
sofort auf die nächste Spur. Recherche mit Belegpflicht geht nicht mehr an Rang 3.

## 3a. Effort: neue Modelle brauchen weniger (der Nutzer, 2026-09-23)

Vorgabe des Nutzers: Die neuen Modelle schaffen dieselbe Aufgabe mit niedrigerem Effort, zum
Beispiel ist Opus 5.5 auf `medium` besser als Fable 5.1 auf `max`. Diese Tabelle ersetzt die
Effort-Werte der Kurztabelle (`orchestrierung.md`, Abschnitt 13) und der Routing-Tabelle aus
der Registry, wo sie höher liegen. Die Stufe (welches Modell) bleibt wie dort.

| Arbeit | Claude | Codex Free |
|---|---|---|
| mechanisch, eng und prüfbar: Rename, Config, Format, Zusammenfassen, Klassifizieren, Logauszug, Nachschlagen im Repo | `haiku:medium` | `codex-luna:low` |
| kurz, gut spezifiziert: ein bis drei Dateien, ein klarer Fix mit Test, Testanpassung, Logauswertung, Recherche mit Belegpflicht aus geladenen Seiten (seit 2026-10-13; vorher `sonnet:medium`) | `haiku:high` | `codex-luna:medium` |
| größer, Spezifikation klar: Mehrdatei-Refactor, Testsuite, Doku-Sweep, mehrstufige Terminal- oder Automationsarbeit; Recherche mit Synthese über viele Quellen | `sonnet:high` (Recherche `sonnet:medium`) | `codex-luna:high` (scheitert sie: Claude-Spalte) |
| lang, mehrstufig, Debugging, Architektur, Mehrdeutigkeit | `opus:medium` | — (Sol nicht im Free-Plan) |
| unabhängiger Review, Beurteilung von Messproben | `opus:low` bis `opus:medium` | — (Sol nicht im Free-Plan) |
| Sichtbares für Menschen | `opus:high` | — (Sol nicht im Free-Plan) |

**Neufassung 2026-10-13 (der Nutzer: „schneller arbeiten […] mehr worker […] haiku 5.5 ist jetzt ein wirklich gutes
worker modell und kann mehr als ihm die regeln gerade zusprechen […] achtung opus trotzdem vor sonnet“).** Gemessen
von Artificial Analysis (Intelligence Index v4.3.2, Leaderboard und Modellseiten am 13.10. geladen, Opus/Sonnet „with
fallback“; Spalten Index / Kosten je Index-Aufgabe / Tok/s):

| Modell | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| Opus 5.5 | 42 / $0.55 / 80 | 51 / $1.34 / 79 | 54 / $1.82 / 82 | 56 / $3.46 / 81 | 58 / $5.98 / 96 |
| Sonnet 5.5 | 36 / $0.35 / 100 | 41 / $0.48 / 95 | 47 / $0.88 / 96 | 52 / $2.01 / 103 | 56 / $5.46 / 135 |
| Haiku 5.5 | 29 / $0.02 / 164 | 34 / $0.05 / 171 | 38 / $0.08 / 175 | 41 / $0.12 / 187 | 43 / $0.21 / 236 |
| GPT-6 Luna | 22 | 30 | 33 | 35 | 38 / $0.07 / 135 |
| GLM-5.3-Flash | | | | | 42 / $0.28 / 67 |
| Qwen3.8 27B (API) | 26 | 28 | | 34 / $1.01 / 46 | |

Einzelwerte (AA-Modellseiten, Nachtrag in der Belegdatei), Haiku `high` / Sonnet `medium` / Opus `medium`: Terminal-Bench 4.0
21,7 / 29,8 / 52,5 %, AutomationBench-AA 33,7 / 54,9 / 61,2 %, GDPval-AA 1418 / 1323 / 1584 Elo, SciCode 48,7 / 52,9 /
59,3 %, AA-Omniscience-Halluzinationsrate 44,5 / 51,2 / 68,4 % (Haiku weiß weniger, rät aber seltener). Einen Coding-
oder Agentic-Index führt AA nicht. Probe in der Werkbank am 13.10.: `haiku:high` bearbeitete 33 Socket-Hinweise über
neun Testdateien in rund zwölf Minuten, ließ jede geänderte Suite grün laufen, nahm die Tafel und meldete Unklares
sauber als OPEN.

Daraus: Haiku 5.5 `high` (38) liegt 3 Punkte unter Sonnet `medium` (41) bei einem Sechstel der Kosten je Aufgabe und
schont damit das Wochenlimit, das mehr gleichzeitige Worker trägt; deshalb geht „kurz, gut spezifiziert“ jetzt an
Haiku. Haiku braucht dafür viele Ausgabetoken (bei `high` rund dreimal so viele wie Sonnet `medium`); trotz doppelter
Tok/s ist ein Haiku-Auftrag deshalb nicht schneller fertig als einer auf Sonnet `medium`, nur billiger. Zählt die
Wanduhr mehr als das Limit (der Nutzer oder eine Kette wartet), darf die Zeile `sonnet:medium` nehmen. **Opus steht vor
Sonnet:** Opus 5.5 liegt auf jeder Stufe vorn (medium 51 gegen 41, high 54 gegen 47); wo die Tabelle `opus` nennt,
geht der Auftrag nie an Sonnet. Scheitert Haiku einmal an einem Auftrag, geht er an die nächste Zeile (`sonnet`), nicht
ein zweites Mal an Haiku. Belege: `~/AI/_recherche/aa-benchmarks-2026-10-13.md`.

- **Codex-Abo nicht verlängert, Codex Free bleibt nutzbar (der Nutzer, 2026-10-13):** „codex abo wird nicht
  verlängert […], das kostenlose ist weiterhin nutzbar.“ Gemessen (`wb-kontingent`, wham/usage): Plan `free` seit
  12.10. etwa 21:13 (vorher `prolite`), ein 30-Tage-Fenster (bis 11.11.), um 00:54 zu 78 % verbraucht. Im Free-Plan
  weist das Konto alle Sol-Modelle ab (`gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-sol`, gemessen 12.10. 23:13); `gpt-6-luna`
  antwortet. Daraus: Codex steht als **Codex Free (`codex-luna`) in Rang 2**, nicht mehr gleichrangig mit Claude in
  Rang 3; die Sol-Zeilen der Kurztabelle gehen an die Claude-Spalte (`opus`), nicht an Luna (kein Ausweichen auf eine
  schwächere Stufe). `codex-sol` meldet „keins verfügbar“, die Sol-Einträge sind in der Registry aus. Erst nach einer
  bestandenen `wb-state models probe codex-gpt-6-1-sol` (etwa nach einem neuen Abo) gilt Sol wieder.
- **Familien-Aliase statt fester IDs** (der Nutzer, 10.10.: neue Modelle automatisch nutzen): `codex-sol`,
  `codex-luna`, `codex-terra` lösen auf das neueste geprüfte Modell der Familie auf (am 10.10.: `codex-gpt-6-1-sol`,
  `codex-gpt-6-luna`, `codex-gpt-5-6-terra`), wie `opus`, `sonnet`, `haiku`. Neue Modelle findet `wb-modelle entdecken`
  nach jedem Harness-Update, prüft sie mit einem Kurzaufruf und meldet sie in leitung. Gesperrt je Familie (auch künftige):
  `codex-astra` und Fable nur auf Anweisung des Nutzers, `codex-reserve` nie.
- **GPT-6 statt GPT-5.6** (der Nutzer, 2026-09-23; Sol seit 10.10. GPT-6.1): Codex-Spur nutzt `codex-sol` und `codex-luna`
  (ab Codex-CLI 0.156; mit 0.146 lehnte der Server sie ab — CLI aktuell halten: `npm install -g
  @openai/codex@latest`). **Terra wird nicht mehr als Worker vergeben** (der Nutzer, 2026-10-12: im Preisvergleich zu Opus lohnt sie sich nicht mehr); „größer, klar" geht an `codex-luna:high`, nach einem gescheiterten Versuch an die Claude-Spalte (seit 13.10.; vorher `codex-sol:medium`). Der frühere Eintrag (der Nutzer, 2026-09-23: `codex-gpt-5-6-terra` für „größer, klar") ist damit abgelöst. Die
  Effort-Stufen der GPT-6-Zeilen sind nach der Regel oben hergeleitet, nicht gemessen. `codex-gpt-6-astra`
  weiterhin nur auf ausdrückliche des Nutzers Anweisung (Registry-Eintrag).
- `opus` im Spawn heißt das neueste Opus: `claude-worker <name> opus:<effort> …` löst über die
  Familie auf (am 2026-09-23 geprüft: `claude-opus-5-5`). `opus5` zeigt fest auf Opus 5. Ebenso heißt `sonnet` das neueste Sonnet (seit 2026-09-30 Sonnet 5.5, `claude-sonnet-5-5`); `sonnet5` zeigt fest auf Sonnet 5.
- Eine Stufe höher nur mit konkretem Grund: ein gescheiterter Versuch auf der niedrigeren Stufe,
  ausdrücklich tiefes Debugging oder eine Architekturentscheidung mit großer Tragweite.
  `xhigh` braucht denselben Grund und wird im Chat genannt. `max` wird nie gespawnt.
- **Haiku 5.5 statt Haiku 4.5 (der Nutzer-Auftrag, 2026-10-09):** `haiku` heißt das neueste Haiku
  (seit 2026-10-07 Haiku 5.5, `claude-haiku-5-5`; im Abo am 09.10. mit `claude -p` geprüft). `haiku45`
  wird nicht mehr gespawnt. Belegt (platform.claude.com, Modellseite und Modellwahl, am 09.10. selbst
  geladen): 1M Kontext, 128K Ausgabe, erste Haiku-Stufe mit Effort (Standard `medium`), gedacht für
  „classification, routing, extraction, and subagent tasks“. Grenzen aus Anthropics Prompting-Leitfaden
  und Herstellerzahlen: bei `low` bricht Haiku 5.5 in langen Agentenaufträgen früh ab und meldet
  Codeänderungen ohne Prüfung als fertig; deshalb nie unter `medium` und jeder Auftrag verlangt
  „bis fertig weiterarbeiten“ und eine echte Prüfung vor „fertig“. Terminal-Bench 4.0 39,2 % gegen
  Sonnet 5.5 70,6 % (Hersteller; Artificial Analysis maß 33 %), AA-Omniscience-Halluzinationsrate 40 %:
  kein Mehrdatei-Coding, keine mehrstufige Terminalarbeit, keine Recherche mit Belegpflicht an Haiku.
  **Gelockert 2026-10-13** (der Nutzer, Neufassung oben): Haiku `high` übernimmt kurze, gut spezifizierte Arbeit über
  ein bis drei Dateien samt Test sowie das Ablesen von Zahlen von genannten Seiten; weiter nicht an Haiku: lange
  mehrstufige Terminal- und Automationsarbeit (AA: halb so stark wie Sonnet), größere Refactors, Synthese über viele
  Quellen. Die Halluzinationsrate von 40 % oben gilt nicht mehr als Gegengrund: AA misst sie bei Sonnet und Opus höher.
  Erste eigene Messung (Vault, 2026-10-09): Als latenzkritische Sortierstufe in `brain` brauchte
  Haiku 5.5 im Median 9,1 s gegen 3,6 s bei Haiku 4.5 und lief teils in die 8-s-Frist; Vault hat die
  Stufe deshalb fest auf `claude-haiku-4-5` gepinnt. Für feste, gemessene Werkzeugaufrufe mit enger
  Zeitgrenze bleibt ein Pin auf 4.5 erlaubt; für Worker gilt Haiku 5.5. Volle Belege:
  Vault `20-projects/claude-workbench/2026-10-09-modellverteilung-haiku55.md`.
- **Codex Spark ist abgeschaltet** (OpenAI: „GPT-5.3-Codex-Spark retired on September 14, 2026“);
  mechanische Codex-Arbeit geht an `codex-gpt-6-luna:low`. OpenAI empfiehlt GPT-6.1 Sol für komplexes
  Coding; im ChatGPT-Konto lehnte codex-cli 0.157.1 es am 09.10. ab („not supported when using Codex
  with a ChatGPT account“). Nachprüfung 10.10. mit codex-cli 0.162.1: `gpt-6.1-sol` antwortet im
  ChatGPT-Konto, `gpt-6.1-luna` wird weiter abgelehnt. Seit 10.10. CLI global 0.162.1 und
  `codex-gpt-6-1-sol` in der Registry (über `wb-state models discover codex`); er ersetzt `codex-gpt-6-sol`
  in allen Zeilen oben (der Nutzer, 10.10.: neue Modelle automatisch nutzen; Familien-Aliase folgen mit
  dem Auftrag modell-auto). Für Luna bleibt `codex-gpt-6-luna`.
- Anthropic: „Tuning effort is often a better lever than switching models.“ Deckt sich mit der Regel
  oben: erst Effort anpassen, dann die Stufe.
- Fable wird nicht eingesetzt, auch nicht für Websites (oben); in der Registry abgeschaltet. Erscheint ein
  neues Fable-Modell, wird neu verglichen und der Nutzer entscheidet, ob sich das ändert (2026-09-23).

## 4. Parallelität

- **Kostenloses Kontingent: höchstens ein Worker je Spur zur selben Zeit.** Eine Spur ist ein
  gemeinsames Kontingent: `agy-*` zusammen, alle OpenRouter-`:free`-Modelle zusammen, Copilot
  Free. Läuft das Limit aus, steht dann ein Worker und nicht mehrere. Weitere Aufträge für
  dieselbe Spur laufen nacheinander im selben Pane. Der Auftrag verlangt Zwischenstände in der
  Ergebnisdatei, damit ein Abbruch nicht alles kostet. Das wird geprüft, nicht angenommen: nach
  etwa zehn Minuten muss ein Zwischenstand auf der Platte liegen; fehlt er, den Worker im Pane
  daran erinnern. (Am 2026-09-18 ging ein agy-Auftrag nach rund 50 Minuten ganz verloren, weil
  der Worker die Vorgabe ignorierte und das Kontingent auslief.)
- **Abos und Bezahltes (Cline Pass, Claude): beliebig viele Worker**, solange die Spur
  nach Abschnitt 3 Luft hat. Unter der Linie wird nicht vorsorglich gespart.
  **Mehr Worker, schneller (der Nutzer, 2026-10-13):** „du und die anderen sitzungen können ruhig mehr worker
  benutzen.“ Jede Sitzung gibt unabhängige Spuren sofort parallel an Worker, typisch drei bis sechs zugleich, statt
  selbst nacheinander zu arbeiten; der Orchestrator steuert, nimmt ab und baut selbst nur Winziges. Einzelne
  Testsuiten nicht seriell vor einem Gesamtlauf abarbeiten: der Gesamtlauf prüft sie ohnehin. Haiku-Zeilen der
  Tabelle zuerst nutzen, damit das Wochenlimit die größere Zahl trägt.
  **Der Mac-Speicher zählt mit** (gemessen 2026-10-09 00:57): Ein opencode-Worker belegt etwa 1 GiB
  RSS. Neun gleichzeitige Worker ließen nur noch 11,9 GiB frei, und `wb-belegung` lehnte Splash ab,
  weil es 14,6 GiB braucht. Ist ein lokaler Modelllauf geplant, halten die Orchestratoren genug
  Speicher frei oder legen ihn in eine Zeit mit wenigen Workern.
- **Parallele Aufträge werden über die Spuren verteilt, nicht auf eine gestapelt.** Bei n
  gleichzeitigen Aufträgen bekommt jede freie Spur von Rang 2 genau einen, der Rest geht an
  Rang 3 und 4. Codex Free ist seit 2026-10-13 eine Spur von Rang 2: ein Codex-Worker zur Zeit,
  solange `wb-kontingent pruefen codex` 0 gibt (bis dahin teilten sich Claude und Codex als Abos
  die Aufträge abwechselnd nach Luft). So werden alle Kontingente genutzt und keines leergezogen.
- Lokal läuft, was der Speicher trägt (`lokale-modelle.md`).
- **Schwere Läufe über die Tafel** (der Nutzer, 2026-10-09): Vor jeder Zeitmessung, jedem
  Gesamtlauf, jedem großen Modell und jeder anderen schweren Arbeit erst `wb-tafel` lesen, dann
  `wb-tafel nimm <platz> --frist <dauer> --zweck "<satz>" --anstellen --warte <dauer> -- <lauf …>`
  (seit 2026-10-13 auf beiden Maschinen): Die Tafel startet den Lauf mit seiner Kennung
  (`WB_TAFEL_EINTRAG`), deckt damit auch abgelöste Testkinder, gibt den Exitcode durch und trägt
  danach selbst aus. Die alte Form `wb-tafel nimm …` ohne Lauf und am Ende `wb-tafel gib <eintrag>` bleibt gültig,
  deckt aber abgelöste Kinder nicht; `run-all.sh` nimmt seine Plätze selbst.
  Frist = erwartete Dauer × 1,5, oder `--frist vorschlag` aus der Historie. Läuft die Frist ab,
  kommt eine Meldung; wer nicht verlängert, verliert den Lauf nach 10 % Nachfrist. Wer ohne
  Eintrag startet, wird gewarnt und muss sofort nachtragen. Die Handliste der Slots entfällt;
  Plan: Vault `20-projects/claude-workbench/2026-10-09-plan-tafel-und-gruppen.md`.

## 5. Wenn eine Spur mitten im Auftrag ausfällt

Erschöpfung buchen (`wb-kontingent erschoepft <spur> --reset <dauer>`), den Zwischenstand aus
der Ergebnisdatei sichern, den Rest an die nächste Spur derselben Stufe geben. Ein 5xx des
Dienstes ist kein Limit: einmal neu senden, danach Spur wechseln.

## 6. Im Chat steht bei jeder Vergabe eine Zeile

Worker-Name, Modell mit Effort, Spur, und warum die Ränge davor ausfielen. Beispiel:
„rech-modelle auf `codex-luna:high` (Codex Free, Rang 2): lokal zu breit, agy belegt,
Codex Free frei und kein anderer Codex-Worker."

## 7. Kontext-Guard

`pi-worker` und `claude-worker` starten den Guard für den Orchestrator-Pane selbst. Kein
zweiter von Hand. Prüfen nach `kontext-guard.md`; für den eigenen Pane darf genau eine Zeile
stehen.
