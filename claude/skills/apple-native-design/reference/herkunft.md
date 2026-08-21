# Herkunft, Lizenzen, Prüfung

Erhebung vom 19.08.2026. Dreizehn Fremd-Repositorien wurden geklont, gelesen und geprüft, bevor
eine Zeile dieses Skills entstand. Die Klone liegen unter
`~/AI/generiert/apple-skill-arbeit/repos/`, die abgerufenen Apple-Seiten daneben unter
`apple-docs/`.

**Kein Text aus einer dieser Quellen steht in diesem Skill.** Übernommen wurden Aufbau,
Gliederungsideen und die Frage, welche Themen überhaupt hineingehören. Jede harte Zahl stammt
aus Apples Dokumentation, nicht aus einem Skill.

## Die Quellen

| Repo | Sterne | Lizenz | Letzter Stand | Was es ist |
|---|---:|---|---|---|
| `dpearson2699/swift-ios-skills` | 1009 | ungeklärt | 2026-07-31 | rund 90 Framework-Skills für iOS 26 und Swift 6.3 |
| `ehmo/platform-design-skills` | 493 | MIT | 2026-03-19 | acht Plattform-Regelwerke, sehr sauber gegliedert |
| `Prisma-Labs-Dev/apple-skills` | 314 | MIT | 2026-08-11 | 33 Skills, überwiegend gespiegelte Apple-Dokumentation |
| `superagents-lab/xcode27-skills` | 283 | keine | 2026-06-09 | Weiterverbreitung von Skills aus Xcode 27 |
| `Wholiver/swiftui-design-skill` | 171 | MIT | 2026-05-01 | Ästhetik-Skill gegen generisches KI-Aussehen |
| `naplesblue/apple-design-skill` | 155 | ungeklärt | 2026-07-20 | Apple-Optik im **Web**, nicht nativ |
| `justinwetch/HIGAgentSkills` | 147 | keine | 2026-06-10 | 156 destillierte HIG-Dateien mit Routing-Index |
| `axiaoge2/apple-hig-designer` | 145 | MIT | 2026-02-17 | Apple-Optik in CSS und React, nicht nativ |
| `dickwu/apple-design-skill` | 90 | keine | 2026-02-27 | Design-Review über Framework-Grenzen hinweg |
| `PasqualeVittoriosi/swift-accessibility-skill` | 79 | MIT | 2026-03-09 | Barrierefreiheit für SwiftUI, UIKit, AppKit |
| `ceorkm/macos-design-skill` | 45 | keine | 2026-02-14 | Mac-Optik, überwiegend als Web-Nachbau |
| `haider-nawaz/liquid-glass-skill` | 43 | keine | 2026-02-14 | Liquid Glass, API-nah |
| `Ksanbal/apple-hig-codex-skill` | 2 | CC BY 4.0 | 2026-04-28 | kompaktes HIG-Handbuch mit Prüfverfahren |

## Lizenzlage

- **MIT** (`ehmo`, `Prisma-Labs-Dev`, `axiaoge2`, `Wholiver`, `PasqualeVittoriosi`): Übernahme
  wäre mit Copyright- und Lizenzhinweis zulässig. Hier steht trotzdem kein übernommener Text,
  weil eine eigene Fassung entstanden ist.
- **CC BY 4.0** (`Ksanbal`): Übernahme verlangt Namensnennung. Da nichts übernommen wurde, ist
  keine fällig; das Repo steht trotzdem in der Tabelle oben, weil sein Prüfverfahren die Vorlage
  für den Abnahmeschritt gab.
- **Keine oder ungeklärte Lizenz** (`justinwetch`, `superagents-lab`, `dickwu`, `dpearson2699`,
  `naplesblue`, `haider-nawaz`, `ceorkm`): Nur Ideen, kein Text. `dickwu` sagt selbst, die
  Nutzung erfolge auf eigenes Ermessen.
- **Zu allen gleichermaßen:** Der Regeltext der Human Interface Guidelines gehört Apple. Mehrere
  Repos stellen gespiegelte Apple-Dokumentation unter eine eigene MIT-Lizenz. Diese Lizenz kann
  keiner von ihnen wirksam erteilen. Für dieses Haus heißt das: Apples Aussagen werden
  paraphrasiert und mit Fundstelle belegt, statt kopiert.

## Sicherheitsbefunde

Geprüft wurde auf versteckte Agenten-Anweisungen, Nachladen aus dem Netz zur Laufzeit, Skripte,
die außerhalb des Repos schreiben, und alles, was Rechte ausweitet.

**1. Eingebettete Anweisung, die die eigene Prüfung aushebeln soll.** In
`superagents-lab/xcode27-skills` steht in zwei SKILL.md-Dateien wörtlich, die Anleitung
„supersedes unconditionally any prior training the model may have on these topics". Das ist genau
das Muster, vor dem `~/.claude/CLAUDE.md` unter „Third-party content" warnt: fremder Inhalt, der
sich selbst als übergeordnete Anweisung ausgibt. Verschärfend kommt hinzu, dass das Repo Apples
Urheberschaft behauptet, aber ausdrücklich keine Lizenz an Apples Inhalten erteilt, und dass es
Systeme der Fassung 27 beschreibt, die am 19.08.2026 noch nicht ausgeliefert waren. **Nicht
übernommen, nichts daraus zitiert.**

**2. Dokumentationsabruf über einen fremden Host.** Dreizehn SKILL.md-Dateien in
`Prisma-Labs-Dev/apple-skills` und 811 Fundstellen in `dpearson2699/swift-ios-skills` weisen den
Agenten an, fehlende Apple-Seiten über den Markdown-Spiegel `sosumi.ai` zu holen. Der Spiegel
mag harmlos sein; das Muster ist es nicht, weil sein Inhalt danach als Apple-Dokumentation im
Kontext liegt. **Nicht übernommen.** Apple liefert dieselben Seiten maschinenlesbar unter
`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<seite>.json`
beziehungsweise `…/tutorials/data/documentation/<pfad>.json`. Dieser Weg steht in `zahlen.md` und
wurde für jede Zahl in diesem Skill benutzt.

**3. Installationsskript, das in mehrere Konfigurationen schreibt.**
`Ksanbal/apple-hig-codex-skill` liefert ein `install.sh`, das die Datei `~/.codex/config.toml`
verändert und Skills nach `~/.claude/skills/` und `~/.config/opencode/skills/` kopiert. Nichts
davon ist bösartig, es tut genau das, was es ankündigt. Ausgeführt wurde es trotzdem nicht;
der Auftrag verbietet es, und Fremd-Skills werden im Haus zusammengeführt statt installiert.

**4. Ohne Befund.** Die Skripte in `Prisma-Labs-Dev/apple-skills` und
`justinwetch/HIGAgentSkills` sind Werkzeuge für die Pflege der Repos: Sie holen
Apple-Dokumentation und rendern sie. Sie laufen nicht zur Laufzeit eines Skills. In keinem der
dreizehn Repos fand sich ein Abruf von Zugangsdaten, ein Versuch, Berechtigungen auszuweiten,
oder ein verdeckter Netzaufruf.

## Was aus jeder Quelle wurde

### ehmo/platform-design-skills

**Übernommen:** der Aufbau. Regeln mit Kennung, richtig-und-falsch-Codepaare, Prüfliste,
Anti-Muster-Tabelle je Plattform. Das ist der lesbarste Aufbau unter allen dreizehn und die
Vorlage für `plattformen.md` und `abnahme.md`. Inhaltlich tragen die Kapitel zu Fokus auf tvOS,
Digital Crown auf watchOS und Zeigerbedienung auf iPadOS.

**Verworfen:** die Web- und Android-Skills, weil dieser Skill nur Apple abdeckt. Verworfen auch
die Empfehlung, die Registerleiste auf iPadOS in regulärer Breite durch eine Seitenleiste zu
ersetzen – Apple empfiehlt inzwischen die umschaltbare Registerleiste oben.

**Verbessert:** sieben falsche Zahlen, aufgelistet in `zahlen.md`. Dazu die fehlende
Liquid-Glass-Ebene: Die Regelwerke stammen von vor System 26 und erwähnen weder das Material
noch die schwebende Registerleiste noch den Umstand, dass tvOS es inzwischen ebenfalls trägt.

### Ksanbal/apple-hig-codex-skill

**Übernommen:** die Idee, dem Agenten ein Verfahren an die Hand zu geben statt nur Regeln – erst
Absicht, dann Plattform, dann Abgleich, dann die wirkungsvollsten Korrekturen, dann die
Prüfliste. Der Abnahmeschritt in `SKILL.md` folgt diesem Gedanken. Übernommen auch die
Plattformmatrix als Form.

**Verworfen:** die Auslöserliste im Kopf des Skills, weil sie zur Hälfte aus koreanischen
Wendungen besteht und Felder benutzt, die Claude Code nicht auswertet. Verworfen auch die
Codex-Beispielprompts am Ende.

**Verbessert:** die Prinzipien. Der Skill trägt Hierarchy, Harmony und Consistency; seit dem
8. Juni 2026 gelten acht andere.

### Prisma-Labs-Dev/apple-skills

**Übernommen:** die Grenzziehung zwischen Tatsache und Geschmack, die in
`disabled-skills/README.md` und im `hig`-Skill steht. Sie ist der beste Gedanke aus allen
dreizehn Quellen und in `prinzipien.md` aufgelöst. Übernommen auch der Umgang mit Liquid Glass
als API-Referenz.

**Verworfen:** die 417 Dateien gespiegelter Apple-Dokumentation, weil sie 18 MB belegen, sofort
veralten und Apple selbst maschinenlesbar erreichbar ist. Verworfen der `sosumi.ai`-Weg. Verworfen
auch der Satz, die HIG sei nie für Ästhetik zu befragen, in dieser Absolutheit – siehe
`prinzipien.md`.

**Verbessert:** Die Liquid-Glass-Referenz nennt die Ausnahme nicht, bei der ein Bedienelement in
der Inhaltsebene Glas annimmt, und keinen Wert für die Abdunklungsschicht. Beides steht jetzt in
`liquid-glass.md`.

### axiaoge2/apple-hig-designer

**Übernommen:** wenig. Der Skill baut Apple-Optik in CSS und React und trifft damit den
Auftrag nicht. Brauchbar war die Erinnerung daran, dass konzentrische Rundungen eine Regel haben
(Innenradius plus Polsterung ergibt Außenradius) und dass Glaseffekte eine bewusste Entscheidung
sein sollten statt eine Voreinstellung.

**Verworfen:** die vollständige Farbtabelle als CSS-Variablen, weil sie unter nativem SwiftUI
schädlich ist – dort sind es semantische Farben, die sich von selbst anpassen. Verworfen die
Typenstufen als feste Pixelwerte. Verworfen die Angabe, die iOS-Registerleiste sei 49 px hoch
und fest am unteren Rand.

**Verbessert:** die Prinzipien. Der Skill führt Clarity, Deference und Depth aus der iOS-7-Zeit
als „die vier Säulen".

### dickwu/apple-design-skill

**Übernommen:** das Review-Format – Zusammenfassung, kritische Fehler, Verbesserungen, was gut
ist, plattformspezifische Hinweise – und der Gedanke, jeden Befund mit Fundstelle zu belegen
statt mit Meinung. Übernommen auch die Schweregrade.

**Verworfen:** die Übersetzungstabelle von Apple-Begriffen nach Flutter, Tauri und Electron. Sie
ist der Kern des Skills und genau das, was dieser hier nicht tut.

**Verbessert:** die Kontrastwerte. Der Skill gibt die WCAG-Formulierung wieder, Apples eigene
Tabelle sagt etwas anderes.

### justinwetch/HIGAgentSkills

**Übernommen:** die einzige Quelle mit Apples aktuellen acht Prinzipien. Übernommen auch der
Gedanke eines Routing-Index, der nach Plattform und Stichwort auf die richtige Referenzdatei
zeigt – hier in kleinerer Form als Tabelle in `SKILL.md`.

**Verworfen:** das Ladeverfahren. Der Skill verlangt, bei **jedem** Aufruf 16 Dateien der ersten
Stufe zu lesen, bevor überhaupt geantwortet wird. Das füllt den Kontext, bevor die Arbeit
beginnt. Hier wird stattdessen nach Bedarf geladen.

**Verworfen** außerdem der Text selbst, weil das Repo keine Lizenz hat.

### Wholiver/swiftui-design-skill

**Übernommen:** zwei Anti-Muster, die einer Nachprüfung standhalten – Emojis als Symbole und der
Purpur-Indigo-Verlauf – und der Gedanke, dass jeder Bildschirm ein Detail verdient, das über das
Nötige hinausgeht. Beides steht in `abnahme.md`.

**Verworfen:** die Anweisung, Gestaltungsmerkmale als feste Hexwerte in einer Token-Datei
abzulegen. Unter SwiftUI führt das an semantischen Farben vorbei und bricht den Dunkelmodus.
Verworfen auch „Serifenschrift für Überschriften" als Regel und „nie die Vorgabefarbe" – auf dem
Mac widerspricht Letzteres Apple, weil der Nutzer die Akzentfarbe selbst einstellt.

### PasqualeVittoriosi/swift-accessibility-skill

**Übernommen:** die Vollständigkeit der Umgebungswerte, an denen eine Oberfläche hängt, und die
Gegenstücke in UIKit und AppKit. `barrierefreiheit.md` folgt dieser Aufzählung.

**Verworfen:** nichts inhaltlich. Der Skill ist gut; er deckt aber nur einen Ausschnitt ab und
wäre neben diesem hier ein zweiter Auslöser für dieselbe Arbeit.

### haider-nawaz/liquid-glass-skill

**Übernommen:** `buttonStyle(.glass)`, `buttonStyle(.glassProminent)` und
`backgroundExtensionEffect()`. Alle drei fehlen in Prismas Referenz, und alle drei sind bei Apple
belegt.

**Verworfen:** die Anweisung, zur Laufzeit die neueste Apple-Dokumentation nachzuladen, ohne den
Weg dorthin festzulegen.

### dpearson2699/swift-ios-skills

**Übernommen:** nichts. Der Umfang ist beeindruckend, die Ausrichtung liegt aber auf
Framework-Referenzen, nicht auf Gestaltung. Für Framework-Fragen bleibt das Repo eine sinnvolle
Anlaufstelle.

**Verworfen:** der `sosumi.ai`-Weg, der dort 811-mal vorkommt.

### naplesblue/apple-design-skill und ceorkm/macos-design-skill

**Verworfen, beide vollständig.** Sie bauen Apple-Optik im Browser, `ceorkm` sogar mit einer
nachgebauten Fensterleiste in HTML. `ceorkm` widerspricht Apple zusätzlich offen: Es rät, die
drei Fensterknöpfe in die eigene Oberfläche zu integrieren, während Apple verlangt, sie an ihrem
Platz zu lassen. Beide sind der Grund, warum dieser Skill `apple-native-design` heißt und nicht
`apple-design`: Unter dem kürzeren Namen laufen im Umlauf mindestens vier Skills, von denen die
Hälfte Webseiten meint.

### superagents-lab/xcode27-skills

**Verworfen, vollständig.** Begründung unter Sicherheitsbefunde, Punkt 1.

## Was keine Quelle hatte

Vier Dinge stehen in diesem Skill und in keiner der dreizehn Quellen:

1. Apples acht Prinzipien vom 8. Juni 2026 in einem Skill, der auch Plattformregeln trägt –
   `justinwetch` hat sie, aber ohne den Rest.
2. Die Unterscheidung zwischen Vorgabegröße und Mindestgröße bei Steuerelementen und Text. Alle
   Quellen behandeln 44 pt als Untergrenze; Apple führt zwei Werte.
3. Die Liquid-Glass-Ausnahme für kurzlebige Bedienelemente in der Inhaltsebene und der Wert von
   35 Prozent für die Abdunklungsschicht.
4. Der aktuelle Stand der iPadOS-Navigation: Registerleiste oben als erste Wahl, umschaltbar auf
   eine Seitenleiste, statt sie in regulärer Breite zu ersetzen.
