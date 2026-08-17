---
name: debugging-protocol
description: Structured root-cause debugging workflow — form an explicit hypothesis, find the smallest reproducing case, change exactly one thing per iteration, verify with a regression test, and record which hypotheses were falsified (null results), not only the fix that worked. Use when a bug resists a quick fix, comes back after being "fixed", or the cause is unclear after one or two attempts — not for trivial, obvious one-line fixes. Triggers include "debug this", "this bug keeps coming back", "root cause", "why does this keep happening", "hartnaeckiger Bug", "wiederkehrender Fehler", "Root-Cause-Analyse", "das Problem taucht immer wieder auf", "finde die Ursache".
---

# Debugging Protocol

Root-cause debugging for bugs that resist a quick fix or keep recurring. Not for a bug whose
fix is obvious on sight — that just gets fixed. This is for the case where a first fix didn't
stick, or the cause isn't obvious after a look or two.

## Wann anwenden

- Ein Bug ist nach einem ersten Fix-Versuch wieder aufgetaucht (gleiches oder verwandtes Symptom).
- Die Ursache ist nach 1-2 Blicken in den Code nicht klar.
- Mehrere plausible Ursachen konkurrieren und geraten wuerde teuer (Produktionscode, Live-System).

Nicht anwenden bei: einem offensichtlichen Tippfehler, einer klaren Off-by-one-Stelle, einem
Fix, den man in unter einer Minute sieht und verifiziert. Dafuer reicht der normale Edit-Test-
Zyklus — dieses Protokoll waere dort reine Bremse.

## Ablauf

Jede Iteration durchlaeuft alle vier Schritte, in dieser Reihenfolge, bevor die naechste beginnt.

### 1. Hypothese formulieren

Explizit aufschreiben, nicht nur im Kopf behalten: "Ich vermute, X verursacht Y, weil Z."
Eine schwache oder vage Hypothese ("irgendwas mit Timing") ist ein Signal, zuerst mehr zu lesen
(Logs, Stacktrace, betroffenen Code), bevor die erste Aenderung gemacht wird.

### 2. Kleinster reproduzierender Fall

Den Bug auf den kleinstmoeglichen Input/Zustand reduzieren, der ihn noch zeigt — kleinster
Testfall, kleinste Konfiguration, wenigste Schritte. Ein Bug, der nur "irgendwo in der grossen
Testsuite" auftritt, ist nicht isoliert genug, um eine Hypothese sauber zu pruefen. Diesen Fall
als tatsaechlichen (Regressions-)Test festhalten, nicht nur manuell reproduzieren.

### 3. Genau EINE Aenderung

Pro Iteration wird genau eine Sache geaendert, die direkt aus der aktuellen Hypothese folgt.
Mehrere Aenderungen gleichzeitig verschleiern, welche gewirkt hat — und ob die Hypothese
ueberhaupt stimmte oder nur zufaellig etwas anderes den Bug maskiert hat.

### 4. Verifizieren + Ergebnis festhalten

Den kleinsten reproduzierenden Fall (Schritt 2) erneut laufen lassen. Zwei Ausgaenge:

- **Hypothese bestaetigt, Bug weg:** weiter zu Regressionstest (unten).
- **Hypothese widerlegt (Null-Resultat):** genau das festhalten — welche Hypothese, welcher Test,
  welches Ergebnis, warum sie ausscheidet. Nicht ueberschreiben oder verwerfen: eine spaetere
  Iteration (oder eine andere Person/Session) soll nicht denselben Holzweg nochmal gehen.
  Zurueck zu Schritt 1 mit einer NEUEN Hypothese, die das Null-Resultat mit einbezieht.

Format fuer das Festhalten, laufend waehrend der Session (Tabelle oder Liste, sichtbar im
Chat-Output, nicht nur intern gedacht):

```
| # | Hypothese                          | Test                     | Ergebnis          |
|---|------------------------------------|--------------------------|--------------------|
| 1 | Race Condition beim Worker-Spawn   | 100x Spawn in Schleife   | widerlegt: kein... |
| 2 | Stale Cache-Eintrag nach Restart   | Cache-Key nach Restart   | bestaetigt         |
```

### 5. Regressionstest

Sobald die Ursache gefunden und behoben ist: den kleinsten reproduzierenden Fall aus Schritt 2
in einen dauerhaften Test ueberfuehren (nicht nur manuell verifizieren und wegwerfen). Der Test
faengt exakt das urspruengliche Symptom ab, damit derselbe Bug nicht unbemerkt zurueckkommt.

## Wenn nichts greift

Nach mehreren widerlegten Hypothesen in Folge (grob: 3+) lohnt ein Schritt zurueck: ist die
Frage ueberhaupt noch "wo ist der Bug" oder schon "ist das Design/die Architektur hier falsch"?
Bei einer echten Design-Entscheidung mit mehreren validen Wegen: [[council]]-Skill fuer
strukturierten Widerspruch statt weiter im Klein-Klein zu debuggen.

## Abgrenzung

- Fertige Diffs/PRs pruefen: `code-review`-Skill, nicht dieses hier.
- Architektur-/Tradeoff-Entscheidungen mit mehreren validen Wegen: `council`-Skill.
- Dieses Protokoll ist fuer die SUCHE nach der Ursache eines bestehenden Bugs, nicht fuer neue
  Feature-Planung.
