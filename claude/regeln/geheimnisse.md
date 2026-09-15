# regeln/geheimnisse.md

Inhalt: Geheimnisse und Veröffentlichung. Ausgelagert aus CLAUDE.md am 2026-08-27, weil die
Datei 789 Bytes über der Obergrenze von 16.000 lag. Die Regeln gelten unverändert weiter.

Auslöser: bevor Du etwas veröffentlichst (Repo, Bewerbung, Mail, Präsentation), bevor Du eine
Sauberkeits- oder Leak-Prüfung baust oder ihr Ergebnis glaubst, und bevor Du beschreibst, wo
Zugangsdaten liegen.

Der Auslöser „bevor Du den Kontext-Guard mit einem Sentinel bedienst" gehörte bis zur
Auslagerung vom 2026-08-27 ebenfalls hierher; die Regel „Sentinel erst NACH dem Guard-Start
setzen (2026-07-29)" steht seither im Wortlaut in `regeln/kontext-guard.md`, Abschnitt
„Sentinel". Auf peer stand sie bis zum 2026-09-05 zusätzlich noch hier.

Unberührt bleiben in CLAUDE.md: kein `.env` und kein Geheimnis zu GitHub oder einem
Online-Anbieter, `90-secrets/` nur lokal (mit der Syncthing-Ausnahme von 2026-08-25, seit 2026-09-10 auch für eingetragene
Agent-Server), keine
vollständigen Geheimnisse in Logs oder Chat ohne Freigabe.

## Regeln

- **Ein Filter nimmt sich nie selbst von seiner Prüfung aus (2026-07-29):** braucht eine
  Sauberkeits-Prüfung eine Ausnahme (`--exclude`, Skip-Liste), ist die Konstruktion falsch, nicht
  die Prüfung — personenbezogene Muster gehören in eine externe, nicht mitgelieferte
  Konfiguration. Gilt auch für den Vorfallsbericht: er nennt die geleakten Werte nie.

- **Fremde Sauberkeitsmeldung ist kein Nachweis (2026-07-29):** vor jeder Veröffentlichung
  selbst gegen einen FRISCHEN Klon prüfen, auch wenn eine andere Session „geprüft" meldet.
  Und: `git push --force` löscht nichts — alte Commits bleiben per SHA abrufbar, weg sind sie
  erst nach Löschen und Neuanlegen des Repos.

- **Nie nach außen dokumentieren, wo und wie Geheimnisse liegen (2026-07-29):** in allem, was das
  Haus verlässt (Bewerbungen, READMEs, öffentliche Repos, Mails, Präsentationen), steht nie, in
  welcher Form oder an welchem Ort Keys, Tokens oder Passwörter gespeichert sind — auch nicht als
  Verbesserungsvorschlag oder Schwachstellen-Eingeständnis. Dass private Daten existieren, darf
  gesagt werden; das Wie und Wo nicht. Vor dem Versand danach greppen.

## Syncthing-Secrets-Kanal (Wortlaut, ausgelagert aus CLAUDE.md am 2026-09-10)

Der etablierte P2P-Syncthing-Kanal zwischen den Maschinen mac-m5 und Peer-Rechner darf `90-secrets/` und
`.secrets-sync/` synchronisieren – verschlüsselt, kein Online-Provider, ausdrückliche des Nutzers
Entscheidung vom 2026-08-25. Seit 2026-09-10 gilt derselbe Kanal auch für Server, die in den
Werkbank-Einstellungen als Maschine für Agents eingetragen sind (Hetzner, ltfserver), damit
Hauptagenten dort ohne den Laptop laufen können (Entscheidung des Nutzers in der grill-me-Runde zum
Agents-Plan, `docs/AGENTS-PLAN.md`, Abschnitt 10, Punkt 21). Der Agents-Plan engt das für Server
ein: je Server ein eigener Ordner `.secrets-sync/<server>/` mit einem Token aus `claude
setup-token` und einem Deploy-Schlüssel je Repo; `90-secrets/` bleibt auf Mac und peer, außer
der Nutzer will es ausdrücklich. Das „never synced / pro Maschine getrennt" gilt für alle anderen
Kanäle unverändert weiter.
