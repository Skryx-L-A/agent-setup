# Abnahme

Durchzugehen, bevor eine Linux-Oberfläche als fertig gemeldet wird. Die Liste fragt nicht, ob
die Anwendung hübsch ist, sondern woran jemand merken würde, dass sie nicht dazugehört.

Was nicht geprüft werden konnte, wird im Bericht als ungeprüft genannt. Ein Haken ohne
Durchgang ist eine Behauptung.

## Der Durchgang auf der Maschine

Eine Oberfläche, die niemand angesehen hat, ist nicht abgenommen. Läuft die Arbeit vom Mac
aus, wird sie auf peer gestartet und angesehen - in einem eigenen Fenster im Hintergrund,
nie in laufender des Nutzers Sitzung, und danach wieder beendet.

- [ ] Gestartet, angesehen, wieder beendet. Kein Prozess bleibt zurück.
- [ ] Mit einem **hellen** und einem **dunklen** Theme angesehen. Auf Omarchy zum Beispiel
      `omarchy theme set catppuccin-latte` und `omarchy theme set catppuccin`, danach das
      ursprüngliche Theme zurückgesetzt.
- [ ] Das Theme **im laufenden Betrieb** gewechselt. Die Anwendung färbt sich um, ohne dass
      sie neu gestartet werden muss.

## Farbe und Schrift

- [ ] Kein fester Farbwert im Quelltext der Oberfläche. Kein `#rrggbb`, kein `rgba()` mit
      festen Kanälen. Ausnahmen sind an Ort und Stelle begründet.
- [ ] Keine feste Schriftgröße, kein `font-size` im eigenen CSS. Stattdessen `.caption`,
      `.heading`, `.title-2` und die übrigen Stilklassen.
- [ ] Keine von Hand gesetzte Deckkraft für blasse Elemente. `.dimmed` statt
      `opacity: 0.55`.
- [ ] Die Akzentfarbe kommt aus dem System. Eine eigene Akzentfarbe überstimmt die Wahl des
      Menschen und braucht einen Grund.
- [ ] Warnung, Fehler und Erfolg benutzen `--warning-color`, `--error-color`,
      `--success-color` und keinen selbst gewählten Ton.

## Barrierefreiheit

Die fünf Prüfungen aus `guidelines/accessibility.html`, hier als Abhakliste.

- [ ] Jedes Bedienelement hat einen zugänglichen Namen, auch die Symbolschaltfläche ohne
      Beschriftung und die Fläche, die nur angeklickt wird.
- [ ] Die Oberfläche im Hochkontrast-Stil angesehen. Nichts verschwindet, nichts wird
      unlesbar.
- [ ] Die Oberfläche mit großer Schrift angesehen. Nichts wird abgeschnitten, keine
      Beschriftung fehlt.
- [ ] Jeder Teil ist mit der Tastatur erreichbar und bedienbar. Eine layer-shell-Fläche mit
      `keyboard_interactivity: none` hat einen dokumentierten zweiten Weg zu ihrer Funktion.
- [ ] Esc schließt, was modal ist. Strg+W schließt ein Fenster.
- [ ] Der Bildschirmleser liest jedes Element, und die Namen stimmen.

## Fenster und Fläche

- [ ] Bei 1024 × 600 px angesehen; nichts ist abgeschnitten. Soll die Anwendung auch auf ein
      Telefon passen, zusätzlich bei 360 × 294 px.
- [ ] Auf einem zweiten Monitor angesehen, wenn die Anwendung einen Ausgang wählt. Der
      Ausgang wird über seinen Namen gewählt, nicht über seinen Index.
- [ ] Bei einer layer-shell-Fläche: die Ebene ist begründet. `overlay` nur für Sperre,
      Notfall und Bedienung über Vollbild - sonst `top`, `bottom` oder `background`.
- [ ] Der beanspruchte Streifen stimmt: positiv nur für etwas, das dauerhaft Platz bekommt,
      sonst null. Minus eins nur für Vollflächiges.
- [ ] Jede layer-shell-Fläche hat einen sprechenden Namensraum.
- [ ] Unter X11 startet die Anwendung nicht mit halber Funktion, sondern lehnt ab und sagt,
      warum.

## Text in der Oberfläche

- [ ] Keine Emojis. Symbolische Icons oder eigene Zeichnungen.
- [ ] Deutsche Texte mit echten Umlauten und ß, kein `ae` und kein `ss`.
- [ ] Auslassungspunkte als U+2026, Multiplikationszeichen als U+00D7,
      Halbgeviertstrich als U+2013, deutsche Anführungszeichen im deutschen Satz.
- [ ] Ein Bedienelement trägt eine Beschriftung **oder** ein Icon, nicht beides. Ausnahmen:
      Seitenleiste und Ansichtswechsler.
- [ ] Die Formulierungen sind über `texte-schreiben` gegangen.

## Zum Schluss

- [ ] Jede Zahl im Quelltext, die aus einer Richtlinie kommt, ist in `gnome-hig.md` oder
      `libadwaita.md` belegt. Geschätzte Zahlen gibt es nicht.
- [ ] Was nicht geprüft werden konnte, steht im Bericht unter OPEN, mit dem Grund.
