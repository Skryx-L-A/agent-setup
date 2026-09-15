# Verifikation nach Anlass

Stand: 2026-09-12. Entscheidung des Nutzers: Die bisher üblichen doppelten und dreifachen
Prüfungen verbrauchen unnötig Tokens. Diese Regel ersetzt pauschale Prüfpflichten nach jeder
Arbeit, jedem Worker-Ergebnis oder jedem mehrstufigen Auftrag, auch in Rollen und Skills.

- **Vor Push oder Veröffentlichung:** passende Freigabeprüfung des auszuliefernden Stands.
  Vor Push nach main bleibt die vollständige Testsuite erforderlich; ein bereits bestandener
  vollständiger Lauf für denselben relevanten Stand zählt. Nicht allein wegen Übergabe wiederholen.
- **Bei kritischen Änderungen:** gezielt prüfen, bevor die Änderung wirksam wird. Kritisch sind
  beispielsweise Rechte, Geheimnisse, Geld/Versand, Datenverlust, Migrationen, Prozesssteuerung,
  gemeinsam benutzte Laufzeit oder eine Änderung mit großer Auswirkung auf andere Projekte.
- **Weitere Prüfungen:** bei konkretem Fehlerverdacht, fehlendem Beleg, fehlgeschlagenem Test oder
  ausdrücklichem Auftrag. Prüfen, wenn der zusätzliche Lauf eine noch offene Frage beantwortet;
  den Anlass kurz nennen. Keine allgemeine Kontrollrunde aus Gewohnheit.
- **Routineänderungen:** keine obligatorische Testsuite, Gegenprobe oder Reviewer-Runde.
  Sichtung der eigenen Änderung und vorhandene Belege genügen, sofern kein Risiko offenbleibt.
- **Ein Beleg, ein verantwortlicher Prüfer:** ein dokumentierter Worker-Test darf vom Hauptagenten
  übernommen werden. Befehl, geprüften Stand, Ergebnis und Grenzen lesen; nicht denselben Lauf
  zusätzlich selbst ausführen. Unabhängiger Review nur bei kritischem/unklarem Inhalt oder Auftrag.
- **Gültigkeit:** Änderungen am geprüften Code, Abhängigkeiten oder relevanten Ausführungsbedingungen
  können einen Beleg entwerten. Reine Übergabe, neuer Agent, Zeitablauf oder unverwandte Textänderung
  sind dafür kein Grund. Nach einem Fix den betroffenen Fehlerweg prüfen, nicht automatisch alles.
- **Ehrlichkeit bleibt:** keine ungetestete Zusage als getestet melden. „Nicht ausgeführt“ und
  verbleibende Unsicherheit nennen, wenn sie für die Abnahme wichtig sind. Ein ausdrücklicher
  Validierungsauftrag wird vollständig erfüllt.

Testisolation, Snapshots, Versandfreigaben, Rechte und Prozesshygiene bleiben unverändert.
Diese Regel entscheidet, **wann** geprüft wird; `tests-und-eingriffe.md` entscheidet, **wie**
ein erforderlicher Test die Live-Umgebung schützt. Historische Prüfpflichten in Referenzen
begründen keine zusätzliche Runde.
