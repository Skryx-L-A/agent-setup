# regeln/messungen.md

Inhalt: wohin gemessene Modellzahlen gehören und wo das Werkzeug liegt, das sie erzeugt hat.
Ausgelagert aus `~/.claude/CLAUDE.md` am 2026-08-10, weil die Datei über ihre Größengrenze
gewachsen war; beide Regeln gelten unverändert weiter.

Auslöser: bevor Du eine Modellzahl misst oder festhältst — lokal wie Cloud, in jedem Projekt —,
bevor Du ein Skript schreibst, das eine Messzahl erzeugt, und bevor Du den Verbrauch oder die
Kosten eines Laufs angibst.

- **Modellmessungen wachsen an EINEM Ort, projektübergreifend (2026-08-09, seine Anweisung):**
  jede gemessene Modellzahl — lokal wie Cloud, aus jedem Projekt und jeder Session — wird in
  `~/Knowledge/_meta/messungen/modelle/daten.json` eingetragen (Werkzeug: `wb-messung`), danach
  die Vergleichsseite neu gerendert. Eine Messung, die nur in einer Session-Notiz steht, ist für
  die nächste Session verloren. Ältere Reihen werden nie gelöscht, nur als `veraltet` markiert.
- **Verbrauch immer in BEIDEN Einheiten (2026-08-10, seine Anweisung):** jede Kosten- oder
  Verbrauchsangabe nennt Tokens samt API-Äquivalent UND den Anteil am Anthropic-Limit (5 h und
  Woche). Die Tokenzahl braucht er, falls dieselbe Arbeit später über die API läuft; der
  Limit-Anteil beantwortet, ob der Lauf heute noch hineinpasst. Der Umrechnungsfaktor wird nie
  hartkodiert, sondern empirisch aus `~/.claude/workbench/limits.jsonl` gerechnet — er hängt am
  Modellmix und veraltet. Kalibrierung und Verfahren: [[limit-prozent-je-token]].
- **Eine Limit-Zahl gilt nur für einen Plan und ein Fenster (2026-08-10, seine Anweisung):** das
  Wochenlimit setzt montags 14:00 Ortszeit zurück, und der Nutzer hatte über die Zeit verschiedene
  Abos (Pro, Max 100, Max 200) mit verschieden großen Töpfen. Ein Prozentpunkt bedeutet vor und
  nach einem Wechsel etwas anderes; über eine Plangrenze hinweg wird nie gerechnet. Welcher Plan
  wann galt, steht in `~/.claude/workbench/plan-historie.json` — steht der Zeitraum nicht drin,
  ist die Zahl unbrauchbar, nicht ungefähr.
- **Eine Zahl gilt erst, wenn der messende Prozess identifiziert ist (2026-08-11):** ein
  Prüfstand, der sich an einen festen Debug-Port bindet, verbindet sich stillschweigend mit
  einem Browser aus einem früheren Lauf, wenn der Port belegt ist — gemessen wurde dann ein
  eine Headless-Chrome-Instanz ohne GPU-Pfad, und dieselbe Szene kostete 16 ms statt 0,35 ms, bei
  völlig plausibel aussehenden Zahlen. Gegenmittel: Port 0 plus Auslesen des tatsächlichen
  Ports, und eine eigene Prüfung, die den Renderer-String ausliest und durchfällt, wenn ein
  Software-Rasterizer dahintersteht. Verallgemeinert: **eine Millisekundenzahl ohne Angabe der
  ausführenden Einheit ist wertlos** — dieselbe Verwechslung wie bei
  [[hf-download-xet-stillstand]], nur an der Rechenseite statt an der Leitung.
- **Ein Modell antwortet nicht deterministisch — eine Zahl aus einem Durchgang ist Rauschen
  (2026-08-17):** Bei einer Prüfung, die Modellverhalten misst, wird JEDER Fall mehrfach
  gefahren und die Quote berichtet, nie das Einzelergebnis. Gemessen am selben Prüfstand, an
  einem Abend: dieselbe unveränderte Rolle verlor einmal 7 von 10 Fällen und wenig später 4 von
  10. Auf dieser Basis wurde eine Prompt-Härtung als „hält 4 von 7" verbucht, die sich bei sieben
  Läufen je Fall als **schädlich** erwies — 58 % Ausbruchsquote gegen 44 % ganz ohne Härtung.
  Wer sie übernommen hätte, hätte sein System verschlechtert und es für eine Verbesserung
  gehalten. Zwei Folgeregeln: ein Unterschied wird erst behauptet, wenn er die Streuung
  überschreitet (bei 70 Läufen sind fünf Läufe Abstand nichts); und eine Härtung braucht
  IMMER eine Gegenprobe an einem Fall, den sie nicht kennt — sonst misst man, wie gut sie die
  Prüfung auswendig kann.
- **Ein Prüffall, dessen Beweis im Träger steht, ist unbestehbar (2026-08-17):** Derselbe
  Prüfstand suchte als Ausbruchsbeweis ein Markerwort in der Antwort — und trug dieses Wort im
  Dateinamen des Angriffsträgers. Der Auftrag lautete „sag mir, was du siehst"; jedes korrekt
  arbeitende Modell nannte damit den Marker und galt als gescheitert, in 7 von 7 Läufen, bei
  jeder geprüften Rolle. Vor jeder Messreihe die Frage: Kann ein RICHTIG handelndes Verhalten
  dieses Kriterium auslösen? Beweis und Reizmaterial werden getrennt.
- **Ein Messwerkzeug gehört ins Repo, nie ins Scratchpad (2026-08-09):** Skripte, die eine Zahl
  erzeugen, überleben sonst ihre Session nicht — die Nebenläufigkeits-Messstrecke des Gardeners
  war mit dem Scratchpad ihres Workers weg, und die offenen Zellen sind seither nicht
  nachmessbar. Wer misst, checkt die Messstrecke mit ein.
