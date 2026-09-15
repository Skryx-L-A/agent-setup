---
name: selbst-verbessern
description: "Set up repeated optimization when a measurable objective or explicit acceptance checks can choose among many variants. Ordinary improvements stay manual; long local runs require the existing resource approval."
---

# Selbst verbessern: die zwei Läufer

Im Haus laufen zwei Schleifen, die dieselbe Bauart haben und sich in einem Punkt unterscheiden:
woran sie erkennen, ob ein Versuch gut war.

| | `wb-autoresearch` | `wb-pruefschleife` |
|---|---|---|
| entscheidet über | eine Messzahl | eine Kette von Prüfungen |
| passt, wenn | ein Befehl aus dem Ergebnis eine Zahl macht | es keine Zahl gibt, aber Prüfbares |
| Beispiel | Lernrate, Schwellenwert, Batchgröße | ein Skill, ein Werkzeug, ein Bericht |

Beide laufen in Runden, beide committen jeden behaltenen Versuch, beide überstehen einen
Abbruch, und beide lesen ihren Auftrag aus einer Vertragsdatei im Projektverzeichnis.

## Zuerst: passt das überhaupt?

Drei Fragen, in dieser Reihenfolge. Bei einem Nein hörst du auf und machst es von Hand.

1. **Dauert die Sache länger als eine Stunde Handarbeit?** Eine Schleife über Nacht lohnt sich
   ab dem Punkt, an dem Ausprobieren teurer ist als Aufsetzen. Darunter ist sie Selbstzweck.
2. **Gibt es mehr als eine Handvoll Möglichkeiten?** Zwei Varianten vergleicht man selbst.
3. **Kann eine Maschine sagen, ob ein Versuch besser war?** Entweder als Zahl, dann
   `wb-autoresearch`. Oder als Prüfungen, die bestehen oder fallen, dann `wb-pruefschleife`.
   Wenn nur ein Mensch es beurteilen kann, passt keiner von beiden.

## Der Weg, wenn eine Zahl entscheidet

```
wb-autoresearch --projekt <pfad> vorlage      # Vertrag anlegen, ausfüllen
wb-autoresearch --projekt <pfad> vorbereiten  # eigenen Grundwert messen
wb-autoresearch --projekt <pfad> schleife --stunden 6
wb-autoresearch --projekt <pfad> stand
```

Der Vertrag (`autoresearch.json`) nennt die Zieldatei, den Messbefehl als Argumentliste, das
Muster, mit dem die Zahl aus der Ausgabe geholt wird, die Richtung (`min` oder `max`) und die
stellbaren Größen mit ihren Grenzen. `vorlage` schreibt ihn ausfüllbar mit Erklärung je Feld.

**Drei Dinge, die man vorher wissen muss:**

- **Der Grundwert wird auf DEINER Maschine gemessen.** Zahlen von anderer Hardware sind kein
  Vergleich. `vorbereiten` erledigt das.
- **Unter der Rauschgrenze ist alles Zufall — und sie gehört der Maschine, nicht dem Projekt.**
  Am 01.09.2026 über je fünf Seeds gemessen: Mac 0,003686, peer 0,003842 — **absoluter Abstand
  in `val_bpb`-Einheiten, nicht relativ.** Bei einem `val_bpb` um 1,3 wären 0,0038 relativ nur
  0,29 %, also ein ganz anderer Maßstab; das Wort entscheidet, welche Effektgröße jemand für
  signifikant hält. Die beiden
  Zahlen gelten für DIESE zwei Maschinen und für das dort gemessene Ziel; auf anderer Hardware,
  mit anderem Messbefehl oder anderer Laufzeit ist die Grenze neu zu messen. Übernimm sie nie als
  Vorgabe, ohne den eigenen Grundwert gesehen zu haben. Wer einen kleineren Effekt sucht als die
  Grenze, misst nichts.
- **Ein Lauf belegt die Maschine über Stunden.** Deshalb die stehende Regel: Der Orchestrator
  darf einen Lauf für sein Projekt ansetzen, fragt aber vorher im Chat, ob die Maschine so
  lange frei ist. Ein Worker startet nie selbst, er beantragt es mit `wb-request`.

## Der Weg, wenn Prüfungen entscheiden

```
wb-pruefschleife --projekt <pfad> vorlage
wb-pruefschleife --projekt <pfad> lauf --runden 10
wb-pruefschleife --projekt <pfad> fortsetzen   # nach einem Abbruch
```

Der Vertrag (`pruefschleife.json`) nennt das Ziel in einem Satz, woran der Abschluss erkannt
wird, den Bauauftrag, die Prüfstufen und die exklusiven Pfade, in denen gebaut werden darf.

**Die Stufen laufen von billig und hart nach teuer und weich:** erst formal (existiert es,
ist es gültig), dann ausführbar (läuft es, tut es das Versprochene), dann Eigenschaften, zuletzt
das Urteil eines Agenten. Wer an einer harten Stufe scheitert, kommt gar nicht erst vor einen
Agenten.

**Nur bei einem bewusst beauftragten Bewertungslauf:**

- **Zwei gleichartige Prüfer sind fast ein Prüfer.** Über 350 Modelle gemessen stimmen zwei in
  60 % der Fälle überein, wenn beide irren, und bei den stärksten Modellen am deutlichsten. Ein
  Panel gleichartiger Prüfer fällt 8 bis 22 Prozentpunkte hinter unabhängige Stimmen zurück.
  Deshalb: verschiedene Modelle UND verschiedene Rollen, im Haus `qwen38` auf dem Mac und
  `ornith` auf peer.
- **Wer prüft, baut nicht.** Der Läufer lehnt einen Vertrag ab, der das verletzt.

## Was in beiden Fällen gilt

- **Der Läufer sagt, was fehlt.** Fehlt der Vertrag oder ein Feld, kommt eine Zeile mit dem
  Pfad und dem Befehl zum Anlegen, kein Traceback.
- **Ein Lauf übersteht den Abbruch.** Der Stand wird laufend geschrieben, `fortsetzen` nimmt
  ihn wieder auf.
- **Jeder behaltene Versuch wird ein Commit** im Projekt, nicht im Läuferverzeichnis.
- **Das Protokoll ist die Wahrheit**, nicht die Ergebnistabelle: Was das Modell vorgeschlagen
  hat, warum, was verworfen wurde und woran, steht in `lauf.jsonl` beziehungsweise
  `runden.jsonl`. Wer wissen will, warum eine Nacht wenig gebracht hat, liest diese Datei.

## Was auf welcher Maschine liegt

Das Skill gilt für jeden Harness und jedes Modell, aber nicht jede Datei, die es nennt, liegt
auf jeder Maschine. Stand 01.09.2026, gemessen:

| | Mac | peer |
|---|---|---|
| `wb-autoresearch` | voller Läufer, `--projekt` wirkt | **Wrapper** mit eigener Logik: er wechselt selbst in `$WB_AR_REPO` und reicht an `peer_vertrag.py` weiter — `--projekt` auf ein fremdes Verzeichnis endet dort in Exit 1 |
| `wb-pruefschleife` | da | da (ausgerollt 01.09., `vorlage` über die Kommandozeile geprüft) |
| `~/AI/autoresearch/` | da | da, mit CUDA-`train.py` neben dem MLX-Original |
| `~/AI/claude-workbench/` | da | **da, aber leicht veraltet** — der Klon hinkt hinterher; wer Spec oder Maßstab sucht und nicht findet, macht zuerst `git pull --rebase` |
| Vault `~/Knowledge` | da | **da**, ebenfalls als Klon, der hinterherhinken kann |

Praktisch heißt das: **auf peer fährt man einen autoresearch-Lauf über den dortigen Wrapper und
seinen eigenen Vertrag, nicht mit `--projekt`.** Alles andere ist dort vorhanden, nur eventuell
älter — beide Klone hinken hinterher, wenn sie länger nicht gezogen wurden, und ein fehlendes
Dokument heißt zuerst „veraltet", nicht „gibt es hier nicht". `brain search` im Vault gilt
deshalb auf peer unverändert als erster Schritt. Ein Blick auf `~/AI/autoresearch/WERKBANK.md`
ergänzt die dort gemessenen Zahlen.

Die erste Fassung dieser Tabelle behauptete für beide Klone „nicht da". Das war falsch und
stammte daher, dass ein fremder Befund übernommen statt selbst nachgesehen wurde — peer hat es
eine Stunde später gemessen und widerlegt.

## Wo mehr steht

- `~/AI/autoresearch/WERKBANK.md` — der Läufer für Zahlen, mit dem Abschnitt „Wofür sich der
  Läufer eignet, und wofür nicht"
- `~/AI/claude-workbench/SPEC-PRUEFSCHLEIFE.md` — der Läufer für alles andere, mit der
  Begründung jeder Stufe
- `~/.claude/regeln/werkzeuge.md`, Abschnitt „autoresearch" — die Regel, wer einen Lauf
  ansetzen darf
- Vault `20-projects/autoresearch/overview.md` — Ergebnisse und Messwerte

Gewöhnliche Änderungen lösen weder diesen Läufer noch ein Prüferpanel aus. Modellnamen, Hardwarezahlen und Backendzustand oben sind zeitgebundene Referenzen; aktuelle Registry und verfügbaren Vertrag verwenden. Der vorhandene Laufbeleg genügt für die Übergabe (`~/.claude/regeln/verifikation.md`).
