# Katalog: woran Maschinentext erkannt wird

Zwei Quellen speisen diese Datei. Erstens die Recherche vom 03.08.2026 zu den Mustern, nach
denen im deutschsprachigen Raum aussortiert wird. Zweitens — und wichtiger — die konkreten
Fälle, in denen der Nutzer eine Formulierung zurückgewiesen hat, jeweils mit Vorher und Nachher
im Wortlaut. Der zweite Teil wächst mit jeder Rückmeldung.

Quellen der Recherche:
[ContentConsultants](https://www.contentconsultants.de/ki-texte-erkennen-warum-man-texte-besser-selbst-schreibt/) ·
[t3n](https://t3n.de/news/ki-texte-erkennen-5-merkmale-chatgpt-1745388/) ·
[korrektur.de](https://korrektur.de/ki-texte-erkennen-merkmale-checkliste) ·
[ahead-ai](https://www.ahead-ai.de/blog-posts/ki-text-erkennen-woran-man-ki-generierte-inhalte-wirklich-erkennt)

---

## 1 · Satzfiguren

### 1.1 Antithese „nicht X, sondern Y"

Die häufigste Figur in Modelltext, und sie tritt selten allein auf. Drei Vorkommen in einem
Text von 670 Wörtern waren der Befund am 03.08.2026.

- **Vorher:** „Ein Agent scheitert nicht sichtbar — er wird still schlechter."
- **Nachher:** „Ein Agent, dessen Fenster volläuft, sagt nichts. Er wird langsam schlechter."
- **Vorher:** „Bei mir ist das kein Ausprobieren, sondern eine Entscheidung mit Regel."
- **Nachher:** „Ein Prompt an einen Worker sieht bei mir aus wie ein Arbeitsauftrag: …"
- **Vorher:** „Das ist für mich kein Hinderungsgrund, sondern der Grund, warum …"
- **Nachher:** „Von Siegen aus sind es rund 30 Kilometer zu euch."

Regel: höchstens einmal pro Text, und nur, wenn der Gegensatz die eigentliche Aussage ist.

### 1.2 Ketten paralleler Verben oder Adjektive

Drei oder vier gleichgebaute Glieder hintereinander sind ein Rhythmus, den Modelle lieben und
Menschen beim Sprechen nicht durchhalten.

- **Vorher:** „Es schneidet Aufgaben zu, wählt je Aufgabe das passende Modell, verteilt sie an
  Worker-Agenten und nimmt deren Ergebnisse ab."
- **Nachher:** „Heute verteilt ein Orchestrator die Arbeit an mehrere Worker-Agenten und sucht
  je Aufgabe das Modell aus, das dafür am besten passt."

Dasselbe für kommagetrennte Dreierlisten von Adjektiven.

### 1.3 Essayistischer Aufhänger

Formeln, die einen Aufsatz eröffnen, aber kein Gespräch: „Interessant wird es an der Stelle,
an der …", „Spannend ist dabei, dass …", „In der heutigen Zeit …", „In einer Welt, in der …",
„Immer mehr Menschen fragen sich …".

- **Vorher:** „Interessant wurde es an der Stelle, an der das aufhört zu tragen."
- **Nachher:** „Zu eng wurde es mir an dem Punkt, an dem in einem Chat immer nur ein Modell
  sitzt."

### 1.4 Gestelzte Nominalisierung

Wo dem Modell ein Verb fehlt, baut es ein Substantiv.

- **Vorher:** „Bei mir ist daraus Gebautes geworden."
- **Nachher:** „Ich mache seit Monaten wenig anderes."

### 1.5 Vage Absicherung

„Dies könnte hilfreich sein, um …", „Es ist wichtig zu beachten, dass …", „Ein guter Weg,
dies zu erreichen, ist …", „Viele Experten sind sich einig, dass …". Entweder die Aussage
stimmt, dann steht sie da, oder sie stimmt nicht, dann fällt sie weg.

### 1.6 Floskel-Schluss

„Abschließend lässt sich sagen …", „Zusammenfassend …", „Über eine Rückmeldung würde ich mich
freuen", „Denken Sie daran: Jeder kleine Schritt zählt". Ein Schluss ist entweder ein
konkretes Angebot, eine konkrete Frage oder eine Aussage darüber, was man will.

---

## 2 · Wortwahl

Übernutzt und deshalb verdächtig: **präzise, strukturell, sauber, eintauchen, umfassend,
ganzheitlich, nahtlos, robust, maßgeschneidert, Mehrwert, zukunftssicher, entscheidend,
essenziell**. Keines ist verboten; gehäuft sind sie ein Befund.

Superlative über sich selbst (führend, beste, einzigartig, revolutionär) fallen immer weg.

---

## 3 · Typografie

- **Halbgeviertstrich – statt Geviertstrich —.** Im deutschen Satz ist – mit Leerzeichen
  richtig; — ist ein amerikanisches Zeichen und ein reines Maschinen-Artefakt. Am 03.08.2026
  standen sieben Geviertstriche in einem Brieftext; das allein hätte gereicht.
- **Deutsche Anführungszeichen „so", nicht "so".**
- **Keine Emojis.** Nirgends, auch nicht in Aufzählungen.
- **Listen sparsam.** Ein Stichpunkt für jeden Sachverhalt ist selbst ein Merkmal. Eine Liste
  ist richtig, wenn der Leser genau danach sucht — etwa bei einer Aufzählung von Projekten mit
  Links. Sie ist falsch als Ersatz für einen Absatz.

---

## 4 · Rhythmus und Tiefe

- **Satzlänge muss schwanken.** Ein Median um 15 bis 18 Wörter bei einer Spanne von etwa 5 bis
  35 ist unauffällig. Gleichförmigkeit ist das Merkmal, nicht die Länge selbst.
- **Plateau-Abstraktion vermeiden.** Bleibt jeder Absatz auf demselben Abstraktionsgrad, ist
  der Text maschinell, auch wenn jeder einzelne Satz stimmt. Gegenmittel sind Details, die
  niemand erfinden würde: „eine Umbenennung über zwanzig Dateien braucht kein teures Modell",
  „von Siegen aus sind es rund 30 Kilometer", „3,8 Sekunden je Gesprächszug, gemessen vom
  Aufnahmeende bis zum Wiedergabestart".
- **Starre Dreiteilung** (Einleitung, Hauptteil, Fazit, dazu drei Argumente) ist ein Merkmal.
  Ein Fazit, das nur wiederholt, was schon dastand, wird gestrichen.

---

## 5 · Fälle aus der Praxis

Chronologisch, jeweils mit Einwand des Nutzers im Wortlaut.

### 03.08.2026 — Die Hinführung muss der wahre Grund sein

**Sein Einwand:** „Ich habe die Workbench nicht allein gebaut wegen dem Kontextfenster. Das
Kontextfenster war nur eine kleine Erweiterung, die Überwachung. Da muss die Hinführung noch
ein wenig schöner und passender werden."

Der Text hatte aus einem späteren, kleinen Zusatz die Gründungsgeschichte gemacht, weil das
dramaturgisch besser trug. Das ist eine Formulierungsentscheidung mit Wahrheitsfolge: Wer den
Anlass umbaut, damit der Absatz besser klingt, behauptet etwas Falsches über sich.

- **Vorher:** „Gekippt ist es an einer Stelle, die man erst nach ein paar Wochen sieht: Ein
  Agent, dessen Kontextfenster volläuft, sagt nichts. … Also habe ich mir die Schicht darüber
  gebaut."
- **Nachher:** „Zu eng wurde es mir an dem Punkt, an dem in einem Chat immer nur ein Modell
  sitzt, eine Aufgabe nach der anderen abarbeitet, und man ihm bei jedem Ergebnis glauben
  muss. … Später kam ein kleiner Wächter über die Kontextauslastung dazu."

**Regel daraus:** Die Hinführung nennt den tatsächlichen Auslöser. Eine gute Beobachtung, die
chronologisch später kam, darf im Text auch später stehen — sie verliert nichts dadurch.

### 03.08.2026 — Kein widersprüchlicher Zustand in einem Satz

**Sein Einwand:** „Dieser Satz ist ein bisschen widersprüchlich und nicht schön formuliert."

- **Vorher:** „… fange im Oktober in Siegen mit Informatik an; der Studiengang ist
  zulassungsfrei, meine Einschreibung läuft gerade."
- **Nachher:** „… fange im Oktober in Siegen mit Informatik an."

Der Nebensatz sollte absichern und stellte stattdessen infrage, was der Hauptsatz behauptet.
**Regel:** Eine Absicherung, die den eigenen Hauptsatz schwächt, gehört gestrichen, nicht
umformuliert.

### 03.08.2026 — Die Überschrift hält, was sie ankündigt

**Sein Einwand:** „Übersetzer raus, dazu gibt es kein Repo, das können Sie sich nicht ansehen
und du hast es unter ‚das könnt ihr euch ansehen' geschrieben."

Unter einer Überschrift stand ein Eintrag, der ihre Zusage nicht einlöst. **Regel:** Was eine
Überschrift oder ein Einleitungssatz ankündigt, gilt für jeden Eintrag darunter ohne Ausnahme.
Ein Eintrag mit Einschränkung gehört woanders hin oder weg.

### 03.08.2026 — Wer im Satz handelt, muss auch der Handelnde sein

**Sein Einwand:** „Worker-Ergebnisse liest hauptsächlich Du als Orchestrator, nicht immer ich.
Ich kontrolliere Deine Ergebnisse hauptsächlich."

- **Vorher:** „Jeder Worker legt sein Ergebnis als Datei ab, damit ich es nachlesen kann, statt
  es zu glauben."
- **Nachher:** „Jeder Worker legt sein Ergebnis als Datei ab, der Orchestrator liest sie und
  nimmt sie ab; kontrollieren muss ich am Ende nur ihn."

Der Satz klang gut und schrieb dem Erzähler eine Rolle zu, die eine andere Instanz hat. So
etwas fällt beim Nachfragen sofort auf. **Regel:** Bei jedem Satz über einen Ablauf prüfen, wer
darin wirklich handelt — besonders bei „ich", wenn mehrere Beteiligte im Spiel sind.

### 03.08.2026 — Das eigene Werk nicht kleiner benennen, als es ist

**Sein Einwand:** „Ich habe zum Beispiel mein gesamtes Setup geteilt. Dann musst du den Eintrag
noch ein wenig verlängern, dass es sich nicht nur um die Workbench mit Agent und Modell
handelt, sondern auch um Brain und Skills und alles Weitere."

- **Vorher:** „das Setup von oben, MIT-lizenziert und installierbar, unabhängig von
  Betriebssystem, Agent und Modell"
- **Nachher:** ein Eintrag, der auch Wissensspeicher, Skill-Mechanik, Hooks, Modell-Registry
  und die mitgelieferte Erweiterung nennt.

Knappheit ist eine Tugend, bis sie das Vorgestellte unter Wert verkauft. **Regel:** Bei einem
Verweis auf etwas Eigenes prüfen, ob die Beschreibung den vollen Umfang trägt. Im Zweifel
nachsehen, was wirklich drin ist, statt aus dem Gedächtnis zu kürzen.

### 03.08.2026 — Bei einer Aufgabenliste des Empfängers ins Detail gehen

**Sein Einwand:** „Den Prompt-Engineering-Satz noch ein wenig erweitern. Der klingt gut, aber
ich will, dass du noch mehr darauf eingehst, wie die Prompts aufgebaut sind und warum."

**Regel:** Wenn der Empfänger eine Tätigkeit ausdrücklich als Aufgabe ausschreibt, ist der
Absatz dazu der falsche Ort für Knappheit. Dort wird gezeigt, wie gearbeitet wird und warum
es so gebaut ist — ein Satz mehr ist dort mehr wert als drei Sätze woanders.

### 11.08.2026 — Vorfeld-Umstellung macht aus einer Freude eine Formel

**Sein Einwand:** „Der ‚ich freue mich'-Abschnitt ist noch nicht gut, es soll eher so klingen:
Ich freue mich schon auf das Gespräch."

- **Vorher:** „Auf das Gespräch freue ich mich."
- **Nachher:** „Ich freue mich schon auf das Gespräch."

Beides ist knapp, beides ist korrekt. Die Umstellung ins Vorfeld („Auf das Gespräch …") betont
das Objekt und lässt den Satz gemessen klingen; im Sprechdeutsch beginnt so ein Satz mit „ich".
Das „schon" trägt die Vorfreude, ohne dass ein Steigerungswort nötig wäre.

**Regel:** In Schlussformeln und anderen kurzen persönlichen Sätzen die gerade Wortstellung
nehmen — Subjekt zuerst. Die Umstellung ins Vorfeld ist ein Stilmittel für Kontrast und Betonung
und wirkt an dieser Stelle steif.

### 16.08.2026 — Die Nachfassmail, die nach Rechnungsstellung klingt

**Sein Einwand:** „bei grundwerk klingt das ‚Zwei Wochen später frage ich nach: Läuft das
Verfahren noch, und wann rechnet ihr mit einer Entscheidung?' sehr unfreundlich, braucht
umformulierung. Generel die ganze Grundwerk mail sehr unfreundlich, mache sie persöhnlicher,
auch über meine projekte muss da nicht viel oder gar nicht geredet werden, die informationen
hben sie ja schon."

Drei Muster stecken darin, alle drei treten in Nachfassmails gemeinsam auf.

**1 · Die vergangene Zeit als Vorhaltung.** Wer die Frist ausrechnet, stellt eine Rechnung.
Der Empfänger hört „ihr seid zu langsam", und genau das war nicht gemeint.

- **Vorher:** „In der Mail stand, es könne ein paar Tage dauern. Zwei Wochen später frage ich
  nach: Läuft das Verfahren noch, und wann rechnet ihr mit einer Entscheidung?"
- **Nachher:** „Seitdem habe ich nichts gehört, deshalb melde ich mich einmal kurz: Wie sieht
  es bei euch aus? Ich weiß, dass bei euch viele Bewerbungen ankommen und dass so etwas
  dauert."

Der Unterschied ist nicht die Länge. Die zweite Fassung stellt dieselbe Frage, rechnet aber
nicht vor und räumt dem Empfänger seinen Grund ein, bevor er ihn nennen muss.

**2 · Zwei Fragen in einem Satz sind eine Aufforderung.** „Läuft das noch, und wann
entscheidet ihr?" verlangt eine Auskunft mit Termin. Eine offene Frage („Wie sieht es bei
euch aus?") lässt dem Empfänger die Wahl, wie genau er antwortet — und wird eher beantwortet.

**3 · Was der Empfänger schon hat, wird nicht wiederholt.** Wer sich beworben hat, hat seine
Projekte, seinen Stack und seine Belege bereits geschickt. Sie in der Nachfassmail erneut
aufzuzählen, liest sich wie ein zweiter Bewerbungsversuch und verschiebt den Zweck der Mail.

- **Vorher:** „Am Interesse hat sich nichts geändert. Der Stack, den ihr fahrt, ist der, in
  dem ich täglich arbeite: n8n läuft bei mir selbst gehostet mit vier ausgerollten Workflows,
  Claude Code ist meine Arbeitsumgebung, und was ich an Agenten-Orchestrierung gebaut habe,
  liegt offen unter github.com/<your-github-user>/agent-workbench."
- **Nachher:** „Mein Interesse ist unverändert – ich würde wirklich gern bei euch anfangen.
  Falls euch für die Entscheidung noch etwas von mir fehlt, sagt einfach Bescheid, ich
  schicke es sofort."

**Der Fall gilt auch für Selbstverständliches über die eigene Lage (17.08.2026.** Rückmeldung des Nutzers an einer Dankesmail nach dem Gespräch: „du machst immer wieder den fehler das du
informationen mit verpackst die die person schon kennt, wie hier, das nur ich meine sachen
benutze". Gemeint war ein Halbsatz, der erklärte, wofür er seine Projekte bisher gebaut hat —
etwas, das aus Bewerbung und Gespräch längst bekannt war. Solche Einschübe fühlen sich beim
Schreiben wie Kontext an und lesen sich beim Empfänger wie Fülltext.

- **Vorher:** „Die Aufgaben aus der Anzeige sind genau das, womit ich mich seit Monaten
  täglich beschäftige, bisher allerdings nur für mich selbst. Das in einem echten Unternehmen
  anzuwenden, an Sachen, die jemand wirklich benutzt, ist der Schritt, den ich als nächstes
  machen will."
- **Nachher:** „Die Aufgaben selbst liegen mir ohnehin."

**Prüffrage vor jedem Nebensatz:** Weiß der Empfänger das schon, weil es in der Bewerbung
stand, im Gespräch fiel oder sich von selbst versteht? Dann streichen, ohne Ersatz.

**Und nach einem persönlichen Gespräch geht es um die Menschen, nicht um die Sache
(17.08.2026, derselbe Fall).** Lief das Gespräch fast ausschließlich persönlich, greift eine
Nachfassmail über Aufgaben und Technik daneben. Der Anschluss liegt bei den Personen: mit
wem man arbeiten würde, von wem man lernt, wie nah man an den Entscheidungen sitzt.

**4 · Der kühle Ausstieg.** „Falls ihr euch anders entschieden habt, ist das auch eine
Antwort" klingt nach eingezogenem Kopf und gibt dem Empfänger die Absage in die Hand, bevor
er sie ausgesprochen hat. Wer diesen Gedanken braucht, formuliert ihn als Bitte statt als
Rückzug: „Falls ihr euch anders entschieden habt, ist das völlig in Ordnung. Dann hätte ich
nur eine Bitte: eine Zeile dazu, was gefehlt hat."

**Regel für die Gattung:** Eine Nachfassmail ist kurz, nennt den Anlass ohne Zeitrechnung,
stellt EINE offene Frage, räumt dem Empfänger seinen Grund ein und bietet etwas an. Sie
wiederholt nichts, was in der Bewerbung schon stand.
