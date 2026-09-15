---
name: recherche
description: >-
  Wie im Haus recherchiert wird: welche Suchwege es gibt, in welcher Reihenfolge sie benutzt
  werden, wie Quellen belegt werden und wie ein Bericht am Ende maschinell geprüft wird.
  Verwende dieses Skill für JEDE Aufgabe, die Wissen von außerhalb des eigenen Kopfes braucht –
  "recherchiere", "such raus", "finde heraus", "vergleiche die Anbieter", "was ist der Stand
  bei X", "gibt es dafür ein Werkzeug", "research this", "look this up", "compare these
  options", "what is the state of the art", "find sources on". Auch dann, wenn nur EIN Fakt
  geprüft werden soll und die Antwort im Modellwissen zu stehen scheint. Gilt für den
  Orchestrator und für jeden Worker, lokal wie Cloud, und es steuert das VERFAHREN, nicht die
  Formulierung des Berichts – die regelt texte-schreiben. Nicht zuständig für plattform- oder
  logingesperrte Inhalte (Twitter, Reddit, LinkedIn, Instagram): dafür ist agent-reach da.
---

# Recherche

Eine Recherche ist erst fertig, wenn jede Aussage darin auf etwas zeigt, das abgerufen wurde.
Alles andere ist Modellwissen mit Fußnoten.

## Die zwei Regeln, die alles tragen

**1. Was du nicht abgerufen hast, hast du nicht.** Am 29.07.2026 lieferten drei Worker in zwei
Minuten drei gut gegliederte Berichte mit 48 Quellen. 17 dieser URLs gaben kein HTTP 200, Zitate
standen so nirgends, ein Repo hatte den falschen Eigentümer. Aufgefallen ist es nicht durch eine
Prüfung, sondern durch eine Lücke: die zwei bekanntesten Projekte des Feldes fehlten in allen
drei Berichten. Wer wirklich gesucht hätte, hätte sie nicht übersehen können.

**2. Rohtext gehört in eine Datei, nie in den Verlauf.** Eine abgerufene Seite hat schnell
20.000 Zeichen. Drei davon im Kontext, und der Rest der Aufgabe wird durch ein volles Fenster
gedacht. Das trifft lokale Modelle früher, aber es trifft alle.

## Reihenfolge

1. **`brain search "<frage>" -k 5`** – vieles steht schon im Haus, und was dort steht, ist
   bereits geprüft.
2. **Suchen.** Erst SearXNG, dann Exa als zweite Meinung. Zwei verschiedene Suchmaschinen finden
   zusammen mehr als eine, zweimal befragt.
3. **Auswählen, bevor gelesen wird.** Aus zwanzig Treffern die drei bis fünf, die das Lesen wert
   sind. `python3 recherche/rerank.py --frage "…" --treffer <datei.json> --top 5` nimmt die
   Auswahl ab. Das Lesen kostet Kontext, und Kontext ist der teuerste Posten einer Recherche.
4. **Volltext holen**, in eine Datei, mit Beiblatt (siehe unten).
5. **Verdichten**, jede Quelle einzeln, bevor irgendetwas verglichen wird.
6. **Lücke suchen.** Fehlt das Naheliegendste, wurde nicht gesucht – das ist ein besseres
   Prüfmittel als jede Stichprobe im Ergebnis.
7. **Belegen und prüfen lassen.**

## Die Werkzeuge, mit gemessenen Zeiten

| Zweck | Befehl | Zeit |
|---|---|---:|
| Websuche, unbegrenzt | `ssh peer 'curl -s "http://127.0.0.1:8888/search?q=<abfrage>&format=json"'` | 1,0 s |
| Websuche, zweite Meinung | `mcporter call exa.web_search_exa query="…" numResults=5` | 2,6 s |
| Seite als Markdown | `mcporter call exa.web_fetch_exa urls=<url> maxCharacters=8000` | 1,6 s |
| Volltext einer Seite | `curl -s https://r.jina.ai/<url>` | 0,4 s |
| GitHub-Fakten | `gh api repos/<owner>/<repo>` | 0,6 s |
| Wissenschaft | `curl -s "https://api.openalex.org/works?search=<abfrage>"` | 1,0 s |
| Wissenschaft | `curl -s "https://api.crossref.org/works?query=<abfrage>&rows=5"` | 0,5 s |
| YouTube-Untertitel | `yt-dlp --write-auto-subs --skip-download <url>` | – |
| PDF zu Text | `pdftotext <datei> -` | – |

SearXNG läuft als Container auf peer, ohne Konto und ohne Kontingent. Direkt über das
Tailscale-Netz ist der Port vom Mac aus nicht erreichbar, deshalb der Umweg über `ssh`; das
kostet rund 0,3 s und spart eine Firewall-Änderung.

Für mehrstufige Recherchen gibt es den Treiber: `wb-recherche "<frage>"`. Er besitzt die
Schleife, legt das Laufverzeichnis an und ruft das Modell je Schritt einmal auf, statt es
dreißig Schritte am Stück laufen zu lassen.

## Auf peer gilt zweierlei anders (Stand 01.09.2026)

Dieses Skill ist auf dem Mac geschrieben und nennt Pfade und Wege von dort. Auf peer:

- **SearXNG laeuft HIER.** Der Umweg `ssh peer curl ...` aus der Werkzeugtabelle ist auf dieser
  Maschine falsch -- `curl -s "http://127.0.0.1:8888/search?q=<abfrage>&format=json"` direkt,
  ohne ssh und ohne die 0,3 s Aufschlag.
- **Die Hilfsskripte fehlen.** `recherche/rerank.py`, `belege.py`, `abschnitte.py` und
  `messstrecke.py` liegen in `~/AI/claude-workbench/recherche/`, und dieses Repo gibt es nur auf
  dem Mac. `wb-recherche` selbst ist hier installiert und laeuft; wer die Belegpruefung braucht,
  holt die Datei per scp vom Mac oder laesst den Bericht dort pruefen.

## Der Treiber, seit dem 31.08.2026

```
wb-recherche "<frage>" [--minuten 25] [--quellen 8] [--runden 3]
                       [--leser auto|aus|<ollama-modell>] [--tor 0.35]
                       [--form bericht|json] [--fortsetzen --lauf <verzeichnis>]
                       [--ohne-suche --lauf <verzeichnis>] [--kein-speicher]

wb-recherche "<frage>" --tief [--teilfragen 4] [--vertiefen 2]   # Deep Research
```

**Eine Frage oder eine Untersuchung?** Für eine Frage mit einer Antwort genügt der normale Lauf.
Sobald die Frage mehrere Dinge auf einmal will – mehrere Systeme vergleichen, einen Gegenstand
von mehreren Seiten beschreiben, eine Entwicklung über die Zeit –, gehört `--tief` dazu. Der
Unterschied liegt im Zuschnitt, nicht in der Gründlichkeit. `--tief` zerlegt die Frage
zuerst in Teilfragen, recherchiert jede einzeln und gibt jeder mit, was die vorherigen schon
gefunden haben. Am Ende steht ein Bericht über alle Teilfragen, mit einem gemeinsamen Belegteil.

`--vertiefen` sagt, wie viele Teilfragen sich der Lauf am Ende noch selbst anhängen darf, wenn
die Lückenprüfung etwas vermisst. Das ist die Stelle, an der aus einer Liste von Fragen eine
Untersuchung mit Tiefe wird; die Zahl ist die Grenze, die sie beenden lässt.

**Grenze, gemessen am 01.09.2026 und noch offen:** die ABSCHLIESSENDE Synthese eines
`--tief`-Laufs verdichtet über alle Quellennotizen, nicht über die fertigen Teilberichte. Bei 96
Quellen wog der Prompt 64144 von 32768 Token und der Lauf brach ab — nach fast drei Stunden, mit
sauberer Meldung und allen sechs Teilberichten fertig auf der Platte. Bis der Schnitt
hierarchisch ist, gilt: **bei mehr als etwa vierzig Quellen sind die Teilberichte das Ergebnis**,
und der Zusammenzug wird von Hand oder in einem zweiten Lauf über sie gemacht. Ein größeres
`WB_RECHERCHE_FENSTER` verschiebt die Grenze nur.

`wb-recherche "<frage>" --tief --nur-plan` zeigt die Zerlegung, ohne etwas zu holen. Ein Blick
darauf kostet zehn Sekunden und sagt mehr über den kommenden Lauf als jede Voreinstellung.

Was dabei anders läuft als vorher, jeweils mit dem Grund:

- **Gelesen wird ein Fenster, das zur Frage passt.** Bis dahin bekam das Modell die ersten
  12.000 Zeichen jeder Quelle. Im Beweislauf vom 30.08. begann die Antwort bei Zeichen 42.528
  einer 143.912 Zeichen langen Handbuchseite; von 820.573 geholten Zeichen sah das Modell 17
  Prozent. `recherche/abschnitte.py` wählt jetzt die Abschnitte aus, die zur Frage passen.
- **Die Seiten liest ein kleines Modell, mehrere gleichzeitig.** Der MLX-Server bricht bei zwei
  gleichzeitigen Anfragen ab, Ollama nicht. Das große Modell plant, beurteilt die Lücke und
  schreibt die Synthese. Abschalten mit `--leser aus`.
- **`--tor`** überspringt eine geholte Seite, deren bester Abschnitt der Frage zu unähnlich ist,
  bevor sie einen Modellaufruf kostet.
- **`--minuten`** begrenzt das Sammeln. Die Synthese läuft immer, auch wenn das Budget aufgebraucht
  ist; im Kopf des Berichts steht dann, dass er auf unvollständigem Material steht.
- **`--ohne-suche`** verdichtet die Seiten, die ein Lauf schon geholt hat, noch einmal, statt
  zu suchen. Zwei Anlässe. Wer an der Kette etwas ändert – am Lesefenster, an der Verdichtung,
  an der Belegprüfung –, misst die Änderung damit am GLEICHEN Material; sonst steckt in jedem
  Vergleich die Laune der Suchmaschine. Und wenn die Suchdienste dicht sind, läuft die Arbeit
  trotzdem weiter. Am 31.08.2026 war das der Normalfall: SearXNG meldete für brave, duckduckgo,
  google cse und startpage „Suspended: too many requests" oder CAPTCHA, Exa antwortete mit
  HTTP 429 auf das Kontingent der freien Schnittstelle. Eine Messstrecke, die dann läuft, misst
  die Sperre.
- **`--fortsetzen`** führt einen abgebrochenen Lauf weiter. Jede Notiz liegt sofort in
  `notizen.jsonl`, seit am 30.08. sechzehn Verdichtungen und vierzig Minuten Rechenzeit an einem
  Wecker verfielen.
- **`--form json`** lässt die Prosa weg. `belege.json` entsteht in jedem Fall und ist für einen
  Agenten als Empfänger das brauchbarere Ergebnis.

Im Laufverzeichnis liegen danach: `bericht.md`, `belege.json` (geprüfte Fundstellen,
maschinenlesbar), `notizen.jsonl` (jede Notiz sofort), `notizen.json` (am Ende), `lauf.jsonl`
(jeder Schritt mit Dauer und Token) und `quellen/`. Bei `--tief` kommen `teilfragen.json` und je
Teilfrage ein Unterverzeichnis `teil-<n>/` dazu; `quellen/` bleibt gemeinsam, damit keine Seite
zweimal gelesen wird und der Prüfer am Ende alles auf einmal sieht.

Der erste Schritt jedes Laufs ist `brain search`. Was dabei herauskommt, steuert die Suche und
steht nie im Belegteil: eine Vault-Notiz hat keine URL, gegen die ein Zitat zu halten wäre.

**Messstrecke.** Zehn geprüfte Fragen liegen in `recherche/fragen.json`, fünf davon mit einer
Antwort weit hinten im Dokument. Ein fertiger Lauf wird bewertet mit
`python3 recherche/messstrecke.py --lauf <verzeichnis> --id <frage-id>`. Am meisten sagt dabei
der Wert `quelle_da`. Steht die Antwort im Bericht, ohne dass die Seite je abgerufen wurde,
stammt sie aus dem Modellwissen und der Lauf gilt als verdächtig.

## Das Ablageformat

Es ist vorgegeben, damit der Prüfer am Ende etwas zu prüfen hat:

```
<lauf>/quellen/<id>.txt     reiner Text der abgerufenen Seite
<lauf>/quellen/<id>.json    id, url, http_status, fetched_at, title, fetcher
```

Die `<id>` ist der Anfang des SHA-1 über die normalisierte Adresse. Dieselbe Seite unter zwei
Schreibweisen bekommt damit dieselbe Kennung – am 30.08. holte ein Lauf `www.gnu.org.` und
`www.gnu.org` getrennt und verdichtete beide, bei 174 Sekunden je Verdichtung.

Im Bericht steht ein Zitat in deutschen Anführungszeichen, unmittelbar gefolgt von `[Q<id>]`:

> Aus dem technischen Bericht: „the agent is not conditioned on the complete history" [Qa3f1]

## Belegpflicht

Zu jeder Quelle gehören URL, HTTP-Status, das Datum von der Seite selbst und ein wörtliches
Zitat von mindestens fünfzehn Wörtern. Sternzahlen, Versionsnummern und Messwerte kommen aus
`gh api` oder von der Seite, nie aus der Erinnerung. Was sich nicht belegen lässt, steht in
einem eigenen Abschnitt **„unbelegt (aus Modellwissen)"** – dort gehört es hin, und dort schadet
es niemandem.

Drei Bedingungen kommen aus der Messstrecke vom 31.08.2026 dazu, weil sie dort einzeln
gescheitert sind.

**Das Zitat muss die Antwort tragen.** Ein Bericht kann elf geprüfte Zitate führen und die
gestellte Frage trotzdem nur im eigenen Fließtext beantworten. Im Referenzlauf der Worker war
genau das der einzige Ausfall: die Frage nach `parse_intermixed_args` war richtig beantwortet,
das belegte Zitat handelte von etwas anderem. Vor dem Abschluss also prüfen, ob mindestens ein
wörtliches Zitat die eigentliche Antwort enthält, und wenn nicht, gezielt danach suchen.

**Ein Zitat wird nie übersetzt.** Steht die Fundstelle auf Englisch, bleibt sie auf Englisch;
die Erklärung darum herum ist deutsch. Ein übersetztes Zitat fällt in der Prüfung durch, und das
zu Recht – es ist keine Abschrift mehr. Dasselbe gilt für stille Glättungen: kein Wort tauschen,
keine Klammer einfügen, keine Auslassung ohne Kennzeichnung.

**`site:` in der Frage ist eine Bedingung, keine Anregung.** Nennt die Frage einen Wirt, zählt
nur Material von diesem Wirt. Der lokale Treiber erzwingt das seit dem 31.08.2026 selbst; wer
von Hand recherchiert, prüft es von Hand. Im Basislauf wurde trotz `site:en.wikipedia.org` eine
spanischsprachige Seite von git-scm.com gelesen, und der Bericht war damit wertlos, obwohl er
sauber gearbeitet war.

Am Ende läuft der Prüfer, und seine Ausgabe hängt am Bericht:

```
python3 recherche/belege.py <bericht.md> --lauf <laufverzeichnis>
```

Er prüft dreierlei: gibt es die Quelldatei, stand dort HTTP 200, und **kommt das Zitat wörtlich
in der abgerufenen Datei vor**. Der dritte Punkt ist der wichtige. Eine URL-Prüfung beweist nur,
dass es die Seite gibt; die häufigste Halluzination ist eine echte Seite mit einem erfundenen
Zitat daraus.

Gelesen wird die Ausgabe nach Fehlerart, nicht nach Anzahl. Ein 404, ein DNS-Fehler oder ein nie
existierender Pfad ist der Fingerabdruck einer Erfindung. Ein 403 ist es nicht: Verlage sperren
Bots systematisch aus, und eine wissenschaftliche Recherche besteht überwiegend aus solchen
Hosts. Eine saubere Runde brachte 21 von 76 URLs ohne HTTP 200 – ausnahmslos 403 oder TLS, kein
einziger 404. Wer solche Zahlen roh liest, wirft gute Arbeit weg.

## Vier Wachen gegen den Zerfall in langen Schleifen

Ein Modell in einer dreißig Schritte langen Recherche bricht nicht ab. Es zerfällt leise, und
kleine Modelle zerfallen früher. Gegen jede Form gibt es eine billige Wache:

| Zerfall | Was passiert | Wache |
|---|---|---|
| Anweisungen verblassen | die Regel aus Schritt 1 gilt in Schritt 25 nicht mehr | die kritische Regel unmittelbar vor dem Schritt wiederholen, in dem sie gilt |
| Werkzeugaufrufe driften | ein Argument ist knapp falsch, ein nachsichtiger Parser biegt es zurecht | Argumente streng prüfen und bei Abweichung abweisen statt zurechtbiegen |
| Verlust in der Mitte | ein Fakt aus Schritt 3 fehlt in Schritt 30 | eine Merkzeile früh setzen und vor der Synthese abfragen; fehlt sie, verdichten statt weitermachen |
| Selbstsicherer Irrweg | ein plausibler falscher Plan wird ohne Zögern durchgezogen | bei teuren Urteilen zweimal ziehen; bei Uneinigkeit hochstufen |

## Lokal oder Cloud

Recherche läuft lokal, solange ein lokales Modell verfügbar ist. Ein Cloud-Modell bekommt die
Aufgabe erst, wenn das lokale ihr nachweislich nicht gewachsen ist – und dann wird gesagt, woran
es gescheitert ist. Entscheidung des Nutzers vom 28.08.2026; der Grund ist das Kontingent, nicht
die Qualität.

Woran ein lokales Modell tatsächlich scheitert: an der Breite. Zehn Systeme nebeneinander
vergleichen sprengt das Fenster, sobald mehr als eine Handvoll Quellen im Spiel ist. Eng
umrissene Fragen mit fünf bis zehn Quellen laufen lokal ohne Qualitätsverlust, wenn Rohtext in
Dateien bleibt.

## Verdächtig schnelle Ergebnisse

Acht Videos auswerten oder ein Repo aus erster Hand lesen dauert länger als zwei Minuten. Kommt
ein Bericht schneller als die Arbeit dauern kann, ist er nicht gemacht worden. Ein leeres
Kontingent meldet dabei keinen Fehler; die CLI schreibt einen stillen Modellwechsel höchstens
einmal beim Start in den Pane.
