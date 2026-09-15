# Project-Kit-Adapter

Gilt für `email-manager`, `new-project`, `social-media-manager` und alle 24
Routen aus dem Katalog. Er übernimmt die Fachabsicht, nicht die vorgegebene
Claude-Ordnerstruktur, Agentenrolle, Integration, Hosting- oder Deploy-Wahl.

- `.claude/agents` ist nie automatische Pflicht. Rollen ergeben sich aus
  Aufgabe und tatsächlich laufendem Harness.
- Keine automatischen Teams, Subagenten, Reviewer oder Evals. Akzeptanzkriterien
  bleiben nützlich; `~/.claude/regeln/verifikation.md` entscheidet über Prüfung.
- Bestehende Versand-, Publish-, Rechte- und Freigaberegeln genügen. Project-Kit
  schafft keine zusätzliche oder abweichende Befugnis.
- E-Mail- und Social-Media-Fähigkeit: klassifizieren und entwerfen, wenn die
  vorhandene Integration das trägt; Senden/Veröffentlichen nur nach Hausregel.
- Routen liefern Domänenchecklisten. Fehlende Anbieter, MCPs, Zahlungs-,
  Browser-, Medien- oder Hosting-Funktionen werden als offen berichtet, nicht
  durch einen erfundenen Ersatzweg verdeckt.
- Neue Projekte können Struktur, Risiko und Akzeptanzkriterien benennen. Der
  Adapter erzeugt weder eine feste Repository-Topologie noch einen dauerhaften
  Automationsprozess.
