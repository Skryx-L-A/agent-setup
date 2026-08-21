# Gestaltungsprinzipien

Fundstelle: Apple, Human Interface Guidelines, „Design principles"
(<https://developer.apple.com/design/human-interface-guidelines/design-principles>), abgerufen
am 19.08.2026. Das Änderungsprotokoll der Seite nennt einen einzigen Eintrag: **8. Juni 2026 –
Gestaltungsprinzipien wieder eingeführt.**

## Warum das hier steht

Fast jeder Text über Apple-Design nennt einen Dreiklang, und fast jeder nennt einen anderen.
Beide Fassungen, die im Umlauf sind, gelten nicht mehr:

- **Clarity, Deference, Depth** stammt aus der iOS-7-Zeit. Der Skill `axiaoge2/apple-hig-designer`
  führt sie als „Die vier Säulen des Apple-Designs" und ergänzt Consistency.
- **Hierarchy, Harmony, Consistency** stand ab Juni 2025 auf der HIG-Startseite und beschrieb
  die Liquid-Glass-Umstellung. `Ksanbal/apple-hig-codex-skill`, `Prisma-Labs-Dev/apple-skills`
  und die Liquid-Glass-Skills tragen sie.

Seit dem 8. Juni 2026 hat Apple eine eigene Seite mit acht Prinzipien. Von dreizehn geprüften
Fremd-Skills trug am 19.08.2026 genau einer sie: `justinwetch/HIGAgentSkills`. Wer die alten
Dreiklänge zitiert, zitiert einen Stand von vor über einem Jahr.

Hierarchy, Harmony und Consistency sind damit nicht falsch geworden. Sie sind heruntergestuft:
Hierarchie und Konsistenz stehen jetzt als Teilaussagen unter Simplicity und Familiarity, und
Harmony ist in der Liquid-Glass-Beschreibung unter Materials aufgegangen. Als
Entwurfsleitlinien gelten die acht.

## Die acht Prinzipien

Apple beschreibt sie ausdrücklich als Werkzeuge zum Abwägen, nicht als Prüfliste. Sie sind dann
nützlich, wenn zwei vertretbare Entwürfe zur Wahl stehen und die Regeln nichts hergeben.

| Prinzip | Die Frage, die es stellt |
|---|---|
| **Purpose** | Wofür ist das da? Was macht dieses Produkt anders als das, was es schon gibt? |
| **Agency** | Behält der Nutzer die Kontrolle? Kann er den Weg verlassen, überspringen, zurücknehmen? |
| **Responsibility** | Ist klar, was hier geschieht und warum? Werden nur die Daten erhoben, die gebraucht werden? |
| **Familiarity** | Baut das auf etwas auf, das dem Nutzer schon kennt – aus der Welt oder aus anderen Apps? |
| **Flexibility** | Trägt das über Geräte, Eingabearten, Sprachen und Einschränkungen hinweg? |
| **Simplicity** | Ist alles hier nötig? Ist die Hierarchie sichtbar, ohne dass man sie erklären muss? |
| **Craft** | Stimmt jede Kleinigkeit – Wortwahl, Animation, Ton? Ist nach dem Ausliefern weitergearbeitet worden? |
| **Delight** | Welches Gefühl soll bleiben, und trägt die Gestaltung es, ohne den Zweck zu stören? |

Drei Stellen, an denen Apple deutlicher wird, als der Tabelleneintrag vermuten lässt:

**Simplicity ist nicht Minimalismus.** Apple sagt das ausdrücklich. Wegzulassen, was gebraucht
wird, ist kein einfacher Entwurf, sondern ein unvollständiger.

**Delight ist keine Dekoration.** Der Nutzer will eine Aufgabe erledigen. Ein Effekt, der um
seiner selbst willen da ist, arbeitet gegen den Zweck. Delight entsteht Apple zufolge als Summe
aus Freiheit, Sicherheit, Vertrautheit und Anpassungsfähigkeit, nicht aus einem Kunststück an
einer Stelle.

**Craft hört beim Ausliefern nicht auf.** Eine App, die zwei Systemfassungen alt aussieht, hat
kein Wartungsproblem, sondern ein Gestaltungsproblem.

## Der Streitpunkt zwischen den Quellen: Wer entscheidet den Geschmack?

Hier widersprechen sich die Quellen offen, und der Widerspruch ist ausgetragen worden, bevor
dieser Skill entstand.

`Prisma-Labs-Dev/apple-skills` hat drei eigene Skills bewusst abgeschaltet und begründet das in
`disabled-skills/README.md`: Sie gäben einen Geschmack vor, statt Tatsachen zu dokumentieren.
Der Kernsatz im aktiven `hig`-Skill lautet, die HIG sei für Tatsachen zu befragen, nie für
Ästhetik. Auf der anderen Seite steht `ios-ui-craft` aus demselben Repo, das ein
Anti-Muster-Verzeichnis führt („dunkel zuerst entwerfen", „Purpur-Indigo-Verläufe sind
KI-Schrott"), und `Wholiver/swiftui-design-skill` mit sechs Verboten gegen generisches
KI-Aussehen.

**Aufgelöst wird das so:** Prisma hat für die Ebene recht, die es beschreibt, und die
abgeschalteten Skills haben für eine andere recht.

- Was die Plattform **fordert** – Mindestgrößen, Dynamic Type, Sicherheitsbereiche,
  Navigationsformen, Barrierefreiheit, Systemgesten – ist keine Geschmacksfrage. Das steht in
  `zahlen.md`, `plattformen.md` und `barrierefreiheit.md` und wird eingehalten.
- Was die Plattform **anbietet** – Farbe, Typenwahl innerhalb der Textstile, Rhythmus,
  Bewegungscharakter, das eine Detail, an das man sich erinnert – ist eine
  Gestaltungsentscheidung. Sie wird pro App getroffen und nicht aus einer Regelliste abgeleitet.
- Was für **jeden** Entwurf gilt: Die Systemvorgabe ist der Boden, nicht die Decke. Apple sagt
  das unter Craft selbst. Eine App, die nur aus Standardkomponenten in Standardfarbe besteht,
  hat keine Fehler und keinen Charakter.

Wo Gestaltungsspielraum besteht, gehört der Auftrag durch `design-bausteine`, statt hier eine
zweite Ästhetik-Lehre aufzumachen. Die Anti-Muster, die tatsächlich tragen, weil sie eine
Plattformregel dahinter haben, stehen in `abnahme.md`.
