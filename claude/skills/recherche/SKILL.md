---
name: recherche
description: "Research external facts with retrieved sources and clear evidence. Use for lookup, comparison or source gathering; scale the process to the question and use agent-reach for platform-gated content."
---

# recherche

Determine the question and the evidence needed. Reuse relevant existing notes, but check time-sensitive facts against current primary sources. A short factual lookup needs a suitable search and its source; it does not need two search engines, a local model, a report directory or an independent reviewer.

Use the available search/browser/API capability. Open the sources you rely on, retain their URL and relevant passage, and cite each claim where it appears. Respect a requested domain, date and language. Distinguish retrieved facts, inference and unavailable evidence; never invent links or quotes. Quote only what is needed within applicable source limits, with no universal minimum word count.

For broad investigations, choose useful sources before reading, save lengthy material outside the chat and track unresolved questions. Use `wb-recherche` only when its installed driver fits the task; the driver and evidence-file formats are documented below. Its stored checks count as evidence: do not refetch every URL or rerun its verifier merely because a lead receives the report.

An additional source or check needs a concrete gap, conflicting fact or publication risk. `~/.claude/regeln/verifikation.md` governs frequency. Backend timings and limits in the references are dated observations, not current availability claims.

## Details nach Bedarf

Die folgenden Abschnitte bewahren konkrete Verfahren und Herkunft. Nur den zur Handlung passenden Abschnitt laden. Relative Befehls- und Ressourcenpfade darin beziehen sich auf den ursprünglichen Skillordner. Historische Modell-/Prüfvorgaben sind durch den Einstieg und aktuelle Hausregeln ersetzt.

- [Die zwei Regeln, die alles tragen](references/review-20260912/01.md)
- [Reihenfolge](references/review-20260912/02.md)
- [Die Werkzeuge, mit gemessenen Zeiten](references/review-20260912/03.md)
- [Der Treiber, seit dem 31.08.2026](references/review-20260912/04.md)
- [Das Ablageformat](references/review-20260912/05.md)
- [Belegpflicht](references/review-20260912/06.md)
- [Vier Wachen gegen den Zerfall in langen Schleifen](references/review-20260912/07.md)
- [Lokal oder Cloud](references/review-20260912/08.md)
- [Verdächtig schnelle Ergebnisse](references/review-20260912/09.md)

Bei Recherche auf Peer-Rechner: [lokale Such- und Treiberwege](references/peer-legacy-20260912.md) nur für die konkrete Backendbedienung laden. Es ist ein Stand vom 12.09.2026; aktuelle Verfügbarkeit prüfen, keine historischen Prüfpflichten übernehmen.
