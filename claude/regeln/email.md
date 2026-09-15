# E-Mail senden

Auslöser: bevor eine Mail rausgeht — Orchestrator wie Worker, auf beiden Maschinen.
Ausgelagert aus `CLAUDE.md` am 2026-08-27, weil die Regel nur bei dieser einen Tätigkeit greift.

## Die Freigaberegel (2026-07-25, unverändert)

Senden ist erlaubt, aber **nur nach Freigabe des Nutzers für den konkreten Versand im Chat** — nie
eigenmächtig, nie „weil es zur Aufgabe passt". Ohne Freigabe höchstens ein **Entwurf**.

Vor dem Senden werden **Empfänger UND vollständiger Text im Chat gezeigt**; erst nach dem „ja"
geht es raus. Für jeden Empfänger außer der Nutzer selbst gilt zusätzlich die Regel für
außenwirksame Handlungen: zeigen, fragen, senden.

Einzige Dauer-Freigabe: die geplante Auswertungs-Session (launchd
`agent-workbench.<ein eigenes Mailwerkzeug>`, 2026-08-08) darf genau EINE Mail an den Nutzer selbst mit dem
Auswertungsergebnis senden.

**AUSNAHME myproject.de (2026-08-31):** Für die Adressen auf der eigenen Myproject-Domain gilt
statt der Einzelfreigabe eine Befugnis JE ADRESSE; die Tabelle steht in
`~/AI/myproject/COMPLIANCE.md`, Abschnitt „Sendebefugnis je Adresse". Für Gmail und GMX bleibt
die Einzelfreigabe oben unverändert.

**Weitere Dauer-Freigaben für automatische Läufe** — der Myproject-Gesundheitswächter und die
Scout-Agenten auf Peer-Rechner mit ihrer Empfänger-Whitelist — stehen im Wortlaut in
`regeln/werkzeuge.md`, zusammen mit den Konten, dem Nachweis über
`~/.local/state/msmtp.log` und den Zugangsdaten-Orten. Dieser Absatz und jener beschreiben
dieselben Freigaben; wer eine ändert, ändert beide.

## Die Sendewege, und welcher auf welcher Maschine funktioniert

**`<ein eigenes Mailwerkzeug> <to> <subject> <bodyfile>`** (~/.local/bin) über Gmail-SMTP via msmtp, App-Passwort im
macOS-Keychain (Service `wb-gmail`). **Nur auf dem Mac** — auf peer ist `<ein eigenes Mailwerkzeug>` nicht
installiert. Das Passwort steht nie im Klartext in einer Datei und wird nie ausgegeben.

**GMX-SMTP** über `Polarschern/etoro_report/report.py:send_email` — der Weg des täglichen
Trading-Berichts, Zugangsdaten in der `.env` beider Maschinen (`GMX_SMTP_USER`, `GMX_SMTP_PASS`).

**Der Gmail-Connector** (`mcp__claude_ai_Gmail__send_message`) sendet aus Gmail-Konto des Nutzers. Er funktioniert, hängt aber an einer interaktiven Anmeldung und taugt deshalb nicht
für Cron-Läufe. Der Absender ist dann die Gmail- und nicht die GMX-Adresse — wer über diesen Weg
ausweicht, sagt es im Bericht dazu, weil sich damit die Absenderidentität ändert.

## Gemessen am 2026-08-27: ein Sendeweg kann still sterben

Das GMX-App-Passwort wurde zwischen dem 25.08. abends und dem 26.08. ungültig
(`535 Authentication credentials invalid`), auf **beiden** Maschinen mit identischen
Zugangsdaten — also keine IP- oder Maschinenfrage. Der tägliche Bericht meldete am 25.08. noch
`'sent': True`.

Die Lehre für jeden, der einen automatischen Versand baut: `send_email` fängt den Fehler ab und
gibt `False` zurück, der Lauf bricht **nicht** ab. Wer nur prüft, ob ein Job durchgelaufen ist,
merkt nicht, dass seit Tagen nichts ankommt. Ein Versandweg braucht eine Prüfung auf
`'sent': True`, nicht auf den Exit-Code des Laufs.
