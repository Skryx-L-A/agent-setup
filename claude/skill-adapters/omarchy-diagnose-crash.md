# Omarchy diagnose-crash adapter

Quelle ist der distributionsverwaltete Omarchy-Skill
`/usr/share/omarchy/default/agents/skills/diagnose-crash/`; die sichtbaren Einträge unter
`~/.agents/skills`, `~/.agent-skills` und `~/.claude/skills` sind auf Peer-Rechner Links dorthin.
Er ist kein Haus-Skill und wird nicht kopiert oder verändert.

Auslöser: Ein Prozess auf Peer-Rechner ist abgestürzt oder ein Systemd-Coredump soll untersucht werden.
Diese Fähigkeit gilt nur, wenn `coredumpctl` und die zugehörige lokale Journal-Sitzung tatsächlich
vorhanden sind. Auf anderen Systemen beginnt die Diagnose mit den dortigen Crash-Protokollen.

1. Lies zuerst die vorhandenen Coredump- und Ressourcenbefunde. Trenne beobachtete Fakten von
   Schlussfolgerungen und prüfe Wiederholung, OOM-Hinweise, Zeitachse und beteiligte Komponenten.
2. Ein extrahierter Core ist sensibel: frischen privaten temporären Pfad verwenden, nie Inhalt,
   Kommandozeilen-Geheimnisse oder private Daten ausgeben, danach die eigene Kopie entfernen.
3. Symbolisierung, Debug-Downloads und Upstream-Reporting sind bedarfsabhängig. Sie brauchen
   verfügbare Werkzeuge sowie den passenden Auftrag; Fehlerdiagnose ändert keine Konfiguration
   und veröffentlicht nichts selbst.
4. Prüfungen folgen `$HOME/.claude/regeln/verifikation.md`: kein pauschaler Zusatzlauf.
   Berichte Ursache, Evidenz, Unsicherheit, mögliche Datenfolgen und sichere nächste Schritte.
