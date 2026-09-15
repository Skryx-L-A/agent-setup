---
name: brain-harvest
description: "Process an explicit Harvest-Manifest into the Knowledge vault: integrate notes, copy durable assets and link their MOC. Run as the lead; no publishing or additions outside the manifest."
---

# Brain-Harvest — Manifest verarbeiten

Du bekommst ein **Harvest-Manifest**: Bullet-Liste mit zwei Teilen —
(a) Entities mit 1-Zeile-was-neu, (b) Files mit Dauerwert + Zielbranch.
Arbeite es MECHANISCH ab, Zeile für Zeile. Kein Interpretationsspielraum außerhalb
dieser Anleitung. Bei echter Unklarheit (nicht: fehlende Kreativität) markiere die
Zeile im Result als offen — nicht raten.

Verboten: `git commit`, `git push`, `git add`. Nur Datei-Operationen im Vault.
Vault-Root: `~/Knowledge`. Niemals `90-secrets/` lesen, schreiben oder referenzieren.

KEIN Cap: alles Substanzielle aus dem Manifest wird abgearbeitet, keine Auswahl treffen.

## 1. Pro Entity-Zeile

Format der Zeile: `<Entity-Name>: <was ist neu>` (+ optional Zielbranch).

1. Suche eine bestehende Note; ergänze die exakte Suche nur bei unklarem Treffer:
   - `brain search "<Entity-Name> <was ist neu>" -k 5` findet die Note auch dann, wenn sie
     die Entity beschreibt, ohne sie wörtlich zu nennen.
   - `rg -il "<Entity-Name>" ~/Knowledge --glob '!90-secrets/**'` für die wörtliche Nennung.
   Prüfe auch `aliases:` im Frontmatter der Treffer (Entity-Name kann Alias sein).
2. **Treffer gefunden** → Note öffnen, **rewrite-over-append**:
   - Bestehenden Fließtext so umschreiben, dass die neue Information eingearbeitet ist.
   - Widersprüche zu altem Text auflösen (alte Aussage korrigieren/streichen, nicht
     als Nachtrag stehenlassen).
   - Zeitabhängige Aussage bekommt/aktualisiert Marker `Stand: YYYY-MM` (aktueller Monat).
   - Frontmatter `type`/`branch` unverändert lassen, außer die Manifest-Zeile nennt
     explizit einen neuen Zielbranch — dann Note per `mv` in den neuen Branch-Ordner
     verschieben und `branch:` im Frontmatter anpassen.
3. **Kein Treffer** → neue Note aus `~/Knowledge/templates/note.md` anlegen:
   - Zielordner = Zielbranch aus Manifest (`10-global/`, `20-projects/<projekt>/`,
     `30-topics/<topic>/`). Fehlt der Branch im Manifest, nimm den plausibelsten
     bestehenden Projekt-/Topic-Ordner (Namensabgleich); bei echter Unklarheit im
     Result als offen markieren, NICHT in `10-global/` raten.
   - `title` = Entity-Name, `type: note`, `created` = heutiges Datum, `permalink`
     nach Konvention der Nachbarnotes im selben Ordner.
   - Body: 1-2 Sätze aus der Manifest-Zeile, `Stand: YYYY-MM` Marker.
4. **Anlinken:** passende Projekt-MOC (`20-projects/<p>/MOC.md`) oder Topic-MOC
   (`30-topics/<t>/MOC.md`) suchen und dort eine Wikilink-Zeile zur (neuen oder
   aktualisierten) Note ergänzen, falls sie dort noch nicht verlinkt ist. Existiert
   keine MOC für den Branch, Note trotzdem anlegen/updaten, MOC-Verlinkung im
   Result als offen vermerken.

## 2. Pro File-Zeile

Format der Zeile: `<Filepfad> — <Dauerwert-Grund> — Zielbranch: <branch>`.

1. Ziel: `~/Knowledge/<branch>/_assets/<filename>`. Ordner anlegen falls fehlt.
2. Datei kopieren (nicht verschieben, Original bleibt wo es war, außer Manifest
   sagt explizit "verschieben"). Cap 50 MB — größere Datei NICHT kopieren, stattdessen
   Stub mit externem Pfad (siehe unten) und im Result als "zu groß, nicht kopiert"
   vermerken.
3. Stub-Note aus `~/Knowledge/templates/asset-stub.md` daneben anlegen
   (`<branch>/_assets/<filename>.md` oder gleicher Ordner nach Konvention der
   Nachbar-Stubs — prüfe bestehende Stubs im selben `_assets/`-Ordner für die
   exakte Namenskonvention):
   - `path: _assets/<filename>` (relativ zum Branch), `mime` per Dateiendung,
     `source` = Herkunft aus Manifest-Zeile, `created` = heute.
   - Body: kurze Beschreibung aus dem Dauerwert-Grund, „wann öffnen"-Satz.
4. Anlinken: Projekt-MOC oder Topic-MOC des Zielbranch bekommt Wikilink-Zeile zur
   Stub-Note (Sektion „Assets" falls vorhanden, sonst anlegen).

## 3. Nicht tun

- Keine Session-Notes anlegen oder verändern (die sind immutable, gehören dem
  Orchestrator/der Session selbst).
- Keine Gardener-Aufgaben (Lint, Topic-Hub-Vorschläge, Embeddings) — diese gehören nicht zum Manifestauftrag.
- Keine eigenen Ergänzungen erfinden, die nicht im Manifest stehen.
- Kein `git commit`/`git push`/`git add`.

## 4. Abschluss

Liste im Result JEDE Änderung einzeln:
- `updated: <pfad>` (Note aktualisiert)
- `created: <pfad>` (Note neu angelegt)
- `copied: <quelle> -> <ziel>` (Asset kopiert)
- `linked: <MOC-Pfad> -> <Note>` (MOC-Verlinkung ergänzt)
- `open: <manifest-zeile> — <grund>` (nicht eindeutig zuordenbar, übersprungen)

Keine Zusammenfassung in Prosa nötig — die Liste ist das Ergebnis. Orchestrator
reviewt den Diff.
