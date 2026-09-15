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

### 01.09.2026 — Wer zurückrudert, sagt zuerst, dass er Lust hat

der Nutzer hat den Entwurf beim Absenden an zwei Stellen selbst ergänzt. Beides fehlte, und
beides fehlte aus demselben Grund: Der Text war auf die Sachlage konzentriert und ließ die
Haltung weg.

Die Lage: Er hatte einer WG abgesagt, sie hatte überzeugend geantwortet, und nun ging es
darum, doch einen Termin zu machen.

- **Vorher:** „Hi Markus, danke für die schnelle und klare Antwort. Bei mir ist gerade etwas
  Zeitdruck drin: …"
- **Nachher:** „Hi Markus, danke für die schnelle und klare Antwort, ich hätte dann durchaus
  Lust euch kennenzulernen. Bei mir ist gerade etwas Zeitdruck drin: …"

Ohne den Zusatz beginnt die Nachricht mit einer Frist und liest sich wie eine Terminforderung,
obwohl sie das Gegenteil sein soll: die Rücknahme einer Absage. Dazu kam am Ende die
Handynummer mit dem Angebot, über WhatsApp zu schreiben — wo es schnell gehen muss, gehört der
schnellere Kanal dazu.

**Regel:** Wenn ein Text eine frühere Absage zurücknimmt oder um etwas bittet, steht das
Interesse im ersten Satz, vor jeder Bedingung und jeder Frist. Und wenn eine Frist im Text
steht, gehört der schnellste erreichbare Kanal dazu.

### 01.09.2026 — Eine Zusage wird nicht bekräftigt, und der Kontext wird nicht nacherzählt

**Sein Einwand, zweimal am selben Tag:** „Ich bin dabei. -- weg" und, zum nächsten Absatz:
„Ein Hinweis vorab: Ich bin gerade in Spanien, deshalb geht nur online. … -- weg, termin ist
eh online."

Zwei Sätze, zwei verschiedene Fehler, beide aus demselben Reflex, einer Nachricht noch etwas
mitzugeben.

- **Vorher:** „morgen um 17:30 Uhr passt mir, ich bin dabei."
- **Nachher:** „morgen um 17:30 Uhr passt mir."

„Passt mir" ist die Zusage. „Ich bin dabei" sagt dasselbe noch einmal und klingt dabei
aufgekratzt. Derselbe Einwand kam schon bei der Zusage an das Ketteler-Wohnheim.

- **Vorher:** „Ein Hinweis vorab: Ich bin gerade in Spanien, deshalb geht nur online. Sobald
  ich zurück in Deutschland bin, komme ich gern auch persönlich vorbei."
- **Nachher:** (gestrichen)

Der Termin war ohnehin als Online-Besichtigung angeboten. Der Hinweis erklärte eine
Einschränkung, die niemanden mehr betraf, und machte aus einer Zusage eine Rechtfertigung.

**Regel:** Nach einer Zusage kommt keine Bekräftigung. Und ein erklärender Nebensatz gehört
nur in den Text, wenn er etwas ändert — was die Gegenseite selbst vorgeschlagen hat, muss ihr
nicht erklärt werden.

### 01.09.2026 — Kein Erfolgswunsch an die Gegenseite, wenn man selbst der Bewerber ist

**Sein Einwand:** „Viel Erfolg bei der Suche und viele Grüße -- ich suche die wohnung, nicht
sie!"

Eine Absage an eine WG endete mit „Viel Erfolg bei der Suche und viele Grüße". Der Satz stammt
aus dem Schlussrepertoire des Absagenden, der über eine Bewerbung entscheidet. Hier war die
Lage umgekehrt: der Nutzer bewirbt sich, die WG vergibt das Zimmer. Der gut gemeinte Wunsch dreht
die Rollen um und klingt herablassend.

- **Vorher:** „Viel Erfolg bei der Suche und viele Grüße"
- **Nachher:** „Viele Grüße"

**Regel:** Vor jedem freundlichen Schlusssatz prüfen, wer in dieser Sache wem gegenübersteht.
Ein Bewerber wünscht der Gegenseite kein Glück bei ihrer Auswahl, ein Gast dem Gastgeber kein
gutes Gelingen. Im Zweifel steht dort nur der Gruß.

### 01.09.2026 — Wer „wir" ist, entscheidet der Absender, nicht der Empfänger

**Sein Einwand:** „uns kennenzulernen. -- ich bin eine person"

In einer Absage an eine WG stand: „danke für die Rückmeldung und für das Angebot, uns
kennenzulernen." Die WG hatte selbst geschrieben, sie wolle „dich und du uns" kennenlernen —
und daraus war beim Schreiben ein „uns" geworden, das nun der Nutzer meinte. Er bewirbt sich
allein.

- **Vorher:** „danke für die Rückmeldung und für das Angebot, uns kennenzulernen."
- **Nachher:** „danke für die Rückmeldung und für das Angebot, euch kennenzulernen."

Der Fehler entsteht beim Spiegeln: Formulierungen aus der eingehenden Nachricht werden
übernommen, ohne die Perspektive zu drehen. Aus ihrem „uns" muss im Antworttext „euch" werden.

**Regel:** In jedem Text, der in Namen des Nutzers hinausgeht, steht „ich", nie „wir" — er ist
eine Person und bewirbt sich allein. Vor dem Absenden jedes Personalpronomen daraufhin prüfen,
wen es bezeichnet, besonders bei Wörtern, die aus der Gegennachricht stammen.

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

---

**5 · Der Betreff aus dem fremden Verlauf (27.08.2026, Ansage des Nutzers: „nie wieder so einen
Betreff").** Eine Antwort im Verlauf erbt technisch die Message-ID, nicht die Betreffzeile.
Wer den internen Betreff des Absenders stehen lässt, verschickt dessen Aktenzeichen: Avision
hatte die Gesprächseinladung unter „AW: Neue Bewerbung eingetroffen" verschickt, einer
Hausbetreffzeile aus dem Bewerbermanagement. Zurückgeschickt liest sie sich, als hätte
niemand hingesehen.

- **Vorher:** `AW: Neue Bewerbung eingetroffen`
- **Nachher:** `AW: Einladung zum Kennenlernen – 07.09., 13:00 Uhr passt mir`

**Regel:** Der Betreff einer Antwort wird gelesen und entschieden wie jeder andere Satz. Er
sagt in einer Zeile, worum es in dieser Mail geht. Übernommen wird ein fremder Betreff nur
dann, wenn er den Vorgang wirklich benennt – etwa der eigene Bewerbungsbetreff, der die Stelle
trägt. Das Threading hängt an `In-Reply-To`, ein geänderter Betreff bricht den Verlauf nicht.

**Und die Auflösung desselben Tages – so gilt es (Entscheidung des Nutzers, sie hebt die Regel
oben auf):** Bei Avision ist am Ende Yvonnes Betreffzeile stehen geblieben, „AW: Neue Bewerbung
eingetroffen". Beide Gegenvorschläge – ein freier Betreff und ein „AW:" mit umbenanntem
Vorgang – hat er verworfen. Der Grund liegt beim Empfänger und nicht beim Text: Im Postfach
soll die Mail sichtbar an derselben Zeile hängen wie alles andere in diesem Vorgang.

**Was daraus für den nächsten Fall folgt:** Die Betreffzeile einer Antwort wird nicht
eigenmächtig umgeschrieben. Sie ist Entscheidung des Nutzers. Fällt sie schlecht aus, wird sie
ihm im Entwurf angeboten – ein Satz genügt –, und er sagt, ob geändert wird. Ungefragt
geändert wird sie nicht.

**6 · „sie hat mich gefreut" (27.08.2026).** Das Verb braucht im Deutschen die Person als
Subjekt oder ein klares Bezugswort. Ein Rückverweis mit „sie" auf ein Substantiv im Satz davor
klingt gestelzt und trifft die Wärme nicht, die gemeint war.

- **Vorher:** „danke für die Einladung, sie hat mich gefreut."
- **Nachher:** „vielen Dank für die Einladung." – und die Freude einmal, am stärksten Platz:
  „Auf das Gespräch mit dir und Carsten Rietzschel freue ich mich sehr."

**Regel:** Freude wird einmal ausgedrückt, nicht zweimal, und sie steht dort, wo sie einem
konkreten Gegenüber gilt – meist am Schluss. Sie wird nur geschrieben, wenn der Nutzer sie
selbst geäußert hat.

**7 · Die zu entschiedene Verfügbarkeit (27.08.2026).** „Zwischen 10:00 und 22:00 Uhr gehe ich
zuverlässig ran, außerhalb davon eher nicht" macht aus einer Auskunft eine Zusage und hängt
eine Einschränkung an, nach der niemand gefragt hat. Der Nachsatz sagt dem Empfänger vor
allem, wann er es gar nicht erst versuchen soll.

- **Vorher:** „Telefonisch erreichst du mich unter <Nummer>. Zwischen 10:00 und 22:00 Uhr gehe
  ich zuverlässig ran, außerhalb davon eher nicht."
- **Nachher:** „Telefonisch bin ich unter <Nummer> zwischen 10:00 und 22:00 Uhr meistens gut zu
  erreichen."

**Regel:** Eine Angabe über die eigene Erreichbarkeit bleibt weich („meistens", „in der Regel")
und nennt nur das Zeitfenster, das gilt. Was außerhalb davon ist, wird nicht ausbuchstabiert.

**8 · Die aufgezählten Gesprächsteilnehmer im Schlusssatz (27.08.2026, Ansage des Nutzers: „gehört
so nicht wirklich in eine Bewerbungsemail").** Wer im letzten Satz die Namen aller Beteiligten
aufzählt, zeigt vor allem, dass er die Einladung genau gelesen hat. Es klingt bemüht und
verschiebt den Schluss von der Sache auf eine Namensliste.

- **Vorher:** „Auf das Gespräch mit dir und Carsten Rietzschel freue ich mich sehr."
- **Nachher:** „Auf das Gespräch mit euch freue ich mich."

**Regel:** Der Schlusssatz einer Bewerbungsmail bleibt schlicht. Namen stehen in der Anrede,
nicht im Abschluss; die Steigerung („sehr") entfällt, wenn der Nutzer sie nicht selbst gesagt hat.

**9 · Nichts zurückspiegeln, was der Empfänger selbst geschrieben hat (28.08.2026, Streichungen des Nutzers an der Bestätigungsmail an Avision).** Eine Bestätigung wiederholt gern den Termin,
den die Gegenseite gerade bestätigt hat, und zählt nach, worauf sie geantwortet hat. Beides sagt
dem Empfänger nur, was er selbst eine Stunde vorher geschrieben hat. Es verlängert die Mail und
wirkt wie ein Protokoll.

- **Vorher:** „der Link ist angekommen. Montag, der 07.09., um 13:00 Uhr steht bei mir, Kamera
  ist an. / Danke für die Antwort auf meine beiden Fragen."
- **Nachher:** „der Link ist angekommen, danke für die Antwort."

**Regel:** In einer Bestätigung steht nur, was der Empfänger noch nicht weiß. Termin, Uhrzeit,
Kanal und die Zahl der beantworteten Fragen weiß er. Auch der Zusatz zu einer Bitte, die man
ohnehin erfüllt („Kamera ist an"), gehört nicht hinein — sie wurde nicht verhandelt.

**10 · Ein WG-Anschreiben ist keine Bewerbung (31.08.2026, Ansage des Nutzers: „jetzt klingt es wie
eine Stellenbewerbung, es geht aber um eine Wohnung, sie wollen von mir erfahren und nicht was
die Wohnung bietet").** Wer sich um ein WG-Zimmer bewirbt, bekommt aus dem Modell zuverlässig
einen Lebenslauf in Absatzform: Abschluss, Auslandsjahr, Ehrenamt, Projekte. Das ist die falsche
Gattung. Die WG sucht keine Qualifikation, sondern die Person, mit der sie ab Oktober eine Küche
teilt. Ebenso falsch ist es, der WG ihre eigene Wohnung zu beschreiben („zehn Minuten zum
Campus, das ist genau die Lage, die ich suche") — sie wissen, wo sie wohnen.

- **Vorher:** „Mein Abitur habe ich im Mai an der Deutschen Schule Barcelona gemacht, davor war
  ich ein Schuljahr in Australien. Neben der Schule baue ich seit Jahren eigene
  Software-Projekte, im letzten Jahr habe ich ehrenamtlich in einem Rettungszentrum für
  Meerestiere gearbeitet."
- **Nachher:** „Ich bin eher ruhig, sitze abends oft an eigenen Programmierprojekten und koche
  gern — auch für andere mit."

**Regel:** Im WG-Anschreiben steht, wie jemand lebt: Tagesrhythmus, Lautstärke, Kochen, Gäste,
Rauchen, Haustiere, Sport. Lebenslauf-Stationen höchstens in einem Halbsatz, und nur, wenn sie
das Zusammenleben erklären. Was die Wohnung bietet, wird nicht aufgezählt.

**11 · Die Anrede richtet sich nach der Zahl der Bewohner, nicht nach der WG-Größe (31.08.2026,
Einwand des Nutzers: „bei einer Zweier-WG sind es aber nur 2 Leute, also ich und die andere
Person, also eher mit ‚deine Zimmer' anschreiben").** „Euer Zimmer" an eine 2er-WG schreibt
gegen eine Person im Plural. Vor dem Schreiben wird gezählt: WG-Größe minus das freie Zimmer
ergibt, wie viele schon dort wohnen. Ist es eine, wird geduzt im Singular; sind es mehrere,
im Plural. Vermieteranzeigen ohne Mitbewohner werden gesiezt.

**Regel:** Erst die Anzeige lesen — WG-Größe, Zusammensetzung und wer sie aufgegeben hat —,
dann die Anrede wählen. Bei einer 2er-WG heißt es „dein Zimmer", nicht „euer Zimmer".

**12 · Eine laue Aussage nicht zur Begeisterung hochschreiben (31.08.2026, Einwand des Nutzers:
„übertrieben, ich will nicht der sein der später für alle immer kochen muss, mir macht es nicht
viel aus aber wirklich gerne mache ich es auch nicht").** Sagt der Nutzer „geht alles" oder „macht
mir nichts aus", steht im Text schnell „mache ich gern". Das ist nicht nur eine Verschiebung im
Ton, sondern eine Zusage, die er später einlösen muss — in einer WG-Bewerbung wird daraus die
Rolle des festen Kochs. Gleichgültigkeit ist eine Angabe, keine Lücke, die mit Begeisterung
gefüllt werden darf.

- **Vorher:** „Kochen mache ich gern, und es ist mir egal, ob jeder für sich kocht oder wir das
  zusammen machen – ich koche auch gern für andere mit."
- **Nachher:** „Beim Kochen bin ich unkompliziert: Ob jeder für sich kocht oder wir zusammen,
  ist mir gleich, und für andere mitkochen macht mir nichts aus. Der feste WG-Koch wäre ich
  aber nicht."

**Regel:** Die Temperatur der Vorlage wird gehalten. „Gern", „liebe ich", „besonders wichtig ist
mir" stehen nur da, wo der Nutzer sie selbst gesagt hat. Wo er abgrenzt, gehört die Grenze in den
Text — sie schützt ihn vor einer Erwartung, die er nie geäußert hat. Verwandt mit der stehenden
Regel, nie zu erfinden, was er denkt, fühlt oder bevorzugt.

**13 · Der Aufzählungs-Gag als Schlusspointe (31.08.2026, Einwand des Nutzers: „der Satz macht
teilweise keinen Sinn").** Um „wenig Besuch" zu sagen, baut das Modell eine Steigerung mit
Pointe: erst zählen, dann eine absurde Zahl dagegensetzen. Gesprochen funktioniert das,
geschrieben stolpert es — der Leser rechnet mit, statt die Aussage aufzunehmen.

- **Vorher:** „Wenn ich Besuch habe, ist das eine Person oder sind es zwei, nicht zwölf."
- **Nachher:** „Wenn Besuch kommt, sind es ein, zwei Leute."

**Regel:** Die Aussage steht für sich, ohne Kontrastzahl und ohne Pointe. Wer sagen will, dass
es wenige sind, nennt die Zahl und hört auf.

**14 · Keine konstruierte Gemeinsamkeit mit dem Empfänger (31.08.2026, Streichung des Nutzers an
der WG-Anfrage).** Wenn im Anzeigentext ein Studienfach, ein Hobby oder ein Arbeitgeber steht,
baut das Modell daraus prompt eine Brücke: „da gäbe es also Überschneidung", „das liegt gleich
nebenan", „dann haben wir ja etwas gemeinsam". Das wirkt angelesen und leicht anbiedernd — der
Empfänger sieht, dass seine eigene Anzeige gegen ihn verwendet wird.

- **Vorher:** „…fange im Oktober an der TU mit Informatik an – mit Ozan gäbe es also
  Überschneidung, Wirtschaftsinformatik liegt gleich nebenan."
- **Nachher:** „…fange im Oktober an der TU mit Informatik an."

**Regel:** Der Anzeigentext bestimmt, WELCHE Themen der eigene Text anspricht — Freiraum,
Kochen, Ordnung, Sport. Er wird aber nicht zitiert, gespiegelt oder zu einer Gemeinsamkeit
verknüpft. Wer Volleyball spielt, schreibt das; er schreibt nicht dazu, dass die anderen ja
Basketball spielen und das doch fast dasselbe sei.

**15 · Keine vorbeugende Verteidigung gegen eine nicht gestellte Frage (01.09.2026, Einwand des Nutzers zur WG-Anfrage: „schreibst du das ich keine Partys mag und generell klingt das sehr
abweisend ihnen gegenüber … nach Partys ist ja gar nicht so gefragt").** Wer eine Eigenschaft
nennt, die niemand erfragt hat, und sie gleich verneint, klingt defensiv und im schlechtesten
Fall abweisend. „Partys gebe ich keine" beantwortete in neun von neunzehn WG-Anfragen eine
Frage, die keine Anzeige gestellt hatte – und stand ausgerechnet in einer Anfrage an eine WG,
die ausdrücklich unternehmungslustige Leute suchte.

- **Vorher:** „Ich bin eher der ruhige Typ. Ihr schreibt, dass ihr unternehmungslustige Leute
  sucht – auf gemeinsames Kochen und den Garten habe ich Lust, auf Partys eher nicht."
- **Nachher:** „Ihr schreibt, dass ihr unternehmungslustige Leute sucht – da bin ich dabei.
  Zusammen kochen, Abende in der Küche, den Garten nutzen: genau darauf habe ich Lust. Ich bin
  dabei eher der ruhige Typ, aber ganz sicher keiner, der sich im Zimmer einschließt."

**Regel:** Erst prüfen, ob die Gegenseite die Frage überhaupt gestellt hat. Wenn nicht, wird die
Eigenschaft positiv formuliert oder weggelassen – nie als Verneinung nachgeschoben. Was jemand
NICHT tut, gehört nur dann in den Text, wenn ausdrücklich danach gefragt wurde.

**16 · Keine Verfügbarkeit zusagen, ohne den Kalender zu lesen (04.09.2026, Einwand des Nutzers
zur Mail an das Studierendenwerk: „halt, nicht jeder tag am montag ist ein termin für einen
studentenjob").** „Ich habe jederzeit Zeit" ist keine Höflichkeitsformel, sondern eine
Tatsachenbehauptung über einen fremden Kalender. Sie war falsch: Am Montag um 13:00 Uhr lief
ein Vorstellungsgespräch, am Sonntag um 12:00 Uhr eine Besichtigung. Wer so etwas schreibt,
riskiert einen Terminvorschlag, den der Absender wieder absagen muss – und das wiegt schwerer
als der gewonnene Eindruck von Flexibilität.

- **Vorher:** „Ich bin an jedem Tag und zu jeder Uhrzeit abkömmlich. Der Termin liegt ganz bei
  Ihnen."
- **Nachher:** „Fest liegen bei mir nur der Sonntagmittag und der Montagmittag, sonst richte
  ich mich nach Ihnen."

**Regel:** Bevor ein Text Verfügbarkeit zusagt, werden die bekannten Termine geprüft. Steht
etwas im Weg, wird es benannt; ist nichts bekannt, bleibt die Zusage offen formuliert („in
den nächsten Tagen", „nach Absprache") statt absolut. Dasselbe gilt für jede andere Zusage
über Zeit, Geld oder Unterlagen, die der Absender einhalten muss.

**17 · Nie um etwas bitten, das die Gegenseite längst veröffentlicht hat (04.09.2026,
Einwand des Nutzers zur Mail an das Studierendenwerk: „gibt es nicht schon fotos?").** Die Bitte
um Fotos stand in einer Mail an einen Vermieter, dessen Website eine Bildergalerie der
Wohnanlage führt – dieselben Bilder waren im eigenen Wohnheimvergleich schon verarbeitet. Eine
solche Bitte sagt dem Empfänger, dass der Absender sich sein Angebot nicht angesehen hat.

- **Vorher:** „Falls es dabei bleibt, wären mir Fotos des Zimmers oder ein Grundriss eine
  Hilfe."
- **Nachher:** „Falls es dabei bleibt: Die Bildergalerie auf Ihrer Website kenne ich, sie zeigt
  aber ein Musterzimmer. Gibt es Aufnahmen oder einen Grundriss des Zimmers in WG 33, um das es
  hier geht?"

**Regel:** Vor jeder Bitte um Material wird geprüft, was schon vorliegt – auf der Website des
Empfängers, in seinen Anlagen, in den eigenen Unterlagen. Was es gibt, wird benannt; erbeten
wird nur die Lücke. Das kostet zwei Minuten Prüfung und ist der Unterschied zwischen einer
präzisen Frage und einer, die Arbeit zurückgibt.

**18 · Eine beauftragte Frage bleibt eine Frage (04.09.2026, Streichung des Nutzers in der
zweiten Mail an das Studierendenwerk: „Falls Sie es zur Hand haben: In welchem Stockwerk liegt
Zimmer 1, wohin geht das Fenster, und gehört ein Balkon dazu? -- weg").** Der Auftrag lautete,
nach dem Gebäude zu fragen. Daraus wurden vier Fragen, drei davon selbst erfunden. Ein
Fragenkatalog verschiebt Arbeit zur Gegenseite und senkt die Wahrscheinlichkeit, dass die eine
Frage, um die es ging, überhaupt beantwortet wird.

- **Vorher:** „In welchem Haus der Anlage liegt die WG 33? … Falls Sie es zur Hand haben: In
  welchem Stockwerk liegt Zimmer 1, wohin geht das Fenster, und gehört ein Balkon dazu?"
- **Nachher:** „In welchem Haus der Anlage liegt die WG 33, interne VO-Nummer 065-0C-03-31-2?"

**Regel:** Wer eine Frage in Auftrag gibt, bekommt eine Frage. Weitere Punkte werden
vorgeschlagen, nicht mitgeschickt – und „falls Sie es zur Hand haben" macht eine
ungefragte Zusatzfrage nicht kleiner, sondern nur höflicher.

**19 · Eine Mail, die nur Dokumente weiterreicht, ist eine Inhaltsangabe (11.09.2026,
Korrektur des Nutzers an der Mail mit den TU-Unterlagen an sich selbst und seine Eltern: „ohne
anrede und verabschiedung, nur info was drin ist").** Der Entwurf war als Brief gebaut, mit
„Hallo zusammen", einem Einleitungssatz und „Liebe Grüße". Bei einer Mail, deren Zweck die
Anhänge sind, liest der Empfänger nur, was drin ist.

- **Vorher:** „Hallo zusammen, anbei meine Unterlagen von der TU Darmstadt fürs
  Wintersemester 2026/27: – Studienbescheinigung … Liebe Grüße, der Nutzer"
- **Nachher:** „Unterlagen der TU Darmstadt, Wintersemester 2026/27: – Studienbescheinigung:
  Nachweis der Immatrikulation, Informatik B.Sc., 1. Fachsemester, gültig vom 1. Oktober 2026
  bis 31. März 2027 – …"

**Regel:** Geht eine Mail an den Nutzer selbst oder an die Familie und trägt vor allem Anhänge,
entfallen Anrede, Einleitung und Grußformel. Der Text sagt je Anhang in einer Zeile, was drin
steht und wofür er gilt.
