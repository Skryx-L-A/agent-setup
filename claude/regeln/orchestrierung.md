# orchestrierung

Auslöser: von jeder Session ohne Rollen-Prompt, die Worker starten oder orchestrieren
will. Workbench-Sessions bekommen `~/.claude/roles/orchestrator.md` ohnehin injiziert –
dort steht die vollständige Mechanik, hier die Essentials im Wortlaut.

Stand der Gliederung: 2026-09-12. Vor der Handlung die passenden Abschnitte unten lesen,
keine Volllektüre aller Referenzen. Die bisherigen Inhalte sind wortgetreu ausgelagert;
neuere ausdrückliche Entscheidungen ersetzen ältere abweichende Absätze.
Für Prüfbedarf gilt immer `~/.claude/regeln/verifikation.md`: keine automatische Doppelprüfung.

Aktuelle Prioritäten: tatsächliche Rolle und Fähigkeiten prüfen; kurze zusammenhängende Arbeit
selbst erledigen, nur unabhängige Spuren delegieren. Modellwahl aus aktueller Registry und dem
Abschnitt „GPT-Orchestrator und GPT-Worker“. Historische Kontingente, Modellvergleiche und alte
Nur-Luna/Terra-Aussagen sind keine aktuelle Verfügbarkeit. Native Subagenten über ihre
Werkzeuge koordinieren; tmux-Verfahren nur für Werkbank-Panes. Keine Pflicht zu einem
Reviewer allein wegen Delegation oder Mehrstufigkeit. Rechte-/Geld-/Produktionsgates bleiben.

## Abschnitte

- [regeln/orchestrierung.md](references/orchestrierung/00.md)
- [Orchestrator mode – Essentials](references/orchestrierung/01.md)
- [Modellwahl](references/orchestrierung/02.md)
- [Recherche laeuft lokal, wo es geht (2026-08-28)](references/orchestrierung/03.md)
- [Denkstufe: nie aus (2026-08-19)](references/orchestrierung/04.md)
- [Sichtbares bekommt ein visuell starkes Modell (2026-09-03; erweitert 2026-09-12)](references/orchestrierung/05.md)
- [Claude-Kontingent schonen: andere Spuren zuerst (2026-09-10)](references/orchestrierung/06.md)
- [Codex neben Claude, beide Abos schonen (2026-09-11)](references/orchestrierung/07.md)
- [Die Reihenfolge bei jeder Vergabe](references/orchestrierung/08.md)
- [Spawn-Befehle](references/orchestrierung/09.md)
- [GPT-Orchestrator und GPT-Worker (2026-09-12; ersetzt „nur Luna und Terra")](references/orchestrierung/10.md)
- [Nie wegen des Limits eine schwächere Stufe (2026-09-10)](references/orchestrierung/11.md)
- [Ein gescheitertes Nachschlagen ist nie ein Grund, ein anderes Modell zu nehmen (2026-08-29)](references/orchestrierung/12.md)
- [Kurztabelle: welche Stufe für welche Arbeit](references/orchestrierung/13.md)
- [Effort: Stufe und Deckel](references/orchestrierung/14.md)
- [FABLE-SPERRE (2026-07-12)](references/orchestrierung/15.md)
- [Wochenlimit: der Maßstab ist das TAGESBUDGET, kein fester Prozentwert](references/orchestrierung/16.md)
- [Kostenlose Spuren und ihre Kontingente (2026-08-27)](references/orchestrierung/17.md)
- [Lokal zuerst: Qwen3.8-27B ist die Vorgabe (2026-08-27)](references/orchestrierung/18.md)
- [Die Standardwahl bei OpenRouter: drei statt vierhundert (2026-08-27)](references/orchestrierung/19.md)
- [Erst die Fähigkeit, dann Intelligenz und Preis (2026-08-27)](references/orchestrierung/20.md)
- [Werkbank-Aufgaben (Agents-Feature, seit 2026-09-10)](references/orchestrierung/21.md)

Erhaltungsnachweis: `references/orchestrierung/manifest.json` enthält Reihenfolge und SHA-256
aller Abschnitte; ihre Verkettung ergibt die vollständige vorherige Datei.
