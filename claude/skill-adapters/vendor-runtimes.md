# Anbieter-Runtime-Adapter

Jede Zeile beschreibt Fähigkeit und offenen Fallback. Sie setzt keine
Claude-zu-Codex-Ersetzung voraus.

| Vendor-Fähigkeit | Nur bei tatsächlich verfügbarem Tool | Offener Fallback |
|---|---|---|
| Bildgenerierung oder Bildbearbeitung | Bild-Runtime des laufenden Harness | Fachabsicht beschreiben; vorhandene Haus-Medienregel anwenden |
| OpenAI-Dokumentation | offizielle Doku-Suche des aktuellen Harness | offizielle Quelle manuell benennen oder als nicht abrufbar melden |
| Plugin anlegen/installieren | passender Plugin-Manager | Struktur/Manifest planen, keine Installation behaupten |
| Verlauf oder Computer-History | bereitgestellte Ereignisquelle | nur vom Nutzer gelieferter Kontext oder lokales benanntes Artefakt |
| Interaktive Visualisierung | verfügbare Visualisierungsfläche | Mermaid, Markdown oder lokale statische Grafik |
| Deep Research | Research-Runtime und Quellenzugang | gewöhnliche belegte Recherche nach Hausregel |
| Plugin-Verwaltung | installierter Manager | Katalogbefund und manuelle Empfehlung |
| Sites-Bau/Hosting | Sites-Runtime bzw. Hosting-Tool | lokale Website-Dateien; Publish nur nach bestehender Freigabe |
| Dokument, PDF, Präsentation, Tabelle, Excel-Live, Template | jeweilige reale Runtime/Add-in | portable Fachabsicht plus vorhandene Haus-Skills für Dokument, Design oder Tabellen; keine native Steuerabfolge vortäuschen |

Render- oder Layoutsichtung gilt nur, wenn ein solches Artefakt erstellt oder
editiert wird. Sonst entscheidet `~/.claude/regeln/verifikation.md`; kein
zusätzlicher Vendor-Gate-Lauf aus Gewohnheit.

## Registrierte Claude-Commands und Rollen

| Vendor-Payload | Nur bei realer Fähigkeit | Portabler Vertrag |
|---|---|---|
| `code-review` | PR-Lesezugang, geeignete Review-Funktion und ausdrücklich erlaubtes Posten | gezielte Befundprüfung nach Risiko; kein Fünf-Agenten-Standard, keine Score-Schleife und kein `gh pr comment` ohne bestehende Außenwirkungsbefugnis |
| `code-simplifier` | tatsächliche Bearbeitungswerkzeuge und expliziter Änderungsauftrag | enger Refactor mit erhaltenem Verhalten; keine feste Opus-Bindung und kein proaktives Umschreiben außerhalb des Auftrags |

Die Quellfassung von `code-review` verlangt fünf parallele Sonnet-Reviewer,
zusätzliche Haiku-Scorer und einen erneuten Eligibility-Pass
(`.../code-review.md:11-28`). Das widerspricht der risikobasierten Hausregel;
bei einem echten PR-Review gilt der begründete Einzelumfang. `code-simplifier`
fordert eine feste Opus-Rolle und autonome Nachbearbeitung
(`.../code-simplifier.md:2-7,41-52`); der Adapter übernimmt nur die
Verhaltenswahrung innerhalb eines erteilten Auftrags.
