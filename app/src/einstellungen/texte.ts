// DIE TEXTE DES EINSTELLUNGSFENSTERS -- alle, an einer Stelle.
//
// WARUM ES DIESE DATEI GIBT. Bis zum 11.08. stand jede Beschriftung als
// literale deutsche Zeichenkette mitten im Quelltext von
// `einstellungen.ts`; die Inventur hat das fuer jede einzelne Zeile belegt.
// Wer die Oberflaeche uebersetzen wollte, haette 2000 Zeilen Code durchsuchen
// muessen und dabei jede Aenderung an einer Beschriftung mit einer Aenderung am
// Verhalten vermischt. Jetzt gilt: KEINE Beschriftung, kein Hilfstext und keine
// Hover-Erklaerung steht mehr im Code. Alles kommt aus der Tabelle unten und
// wird ueber die eine Funktion `t()` abgefragt.
//
// DIE SPRACHSCHICHT (SPEC-V4 Abschnitt 4, seit dem 11.08.). Zwei Tabellen
// derselben Schluessel, DE und EN, umgeschaltet ueber `setzeSprache()` -- kein
// Durchgang durch den Code. Englisch ist die Auslieferungssprache; Deutsch
// bleibt vollstaendig gepflegt daneben.
//
// DIE REGEL FUER NEUE FELDER. Ein Feld ohne Eintrag hier zeigt sichtbar
// `[fehlender Text: <schluessel>]` statt leer zu bleiben. Ein leeres Etikett
// waere ein Fehler, den niemand bemerkt; eine sichtbare Luecke faellt beim
// ersten Blick auf und die Testsuite faengt sie ohnehin (jedes gezeichnete Feld
// braucht Name, Wirkungszeile und einen Infotext von mindestens 60 Zeichen).
//
// DIE SCHLUESSEL folgen einem festen Schema, damit man von einem Feld im
// Fenster zu seinem Text findet, ohne zu suchen:
//   seite.<seite>.titel|wofuer|unterzeile     die sieben Seiten
//   gruppe.<seite>.<name>                     die Ueberschrift einer Gruppe
//   feld.<kennung>.name|wirkung|info|etikett  die drei Ebenen einer Einstellung
//   guard.<kennung>.name|wirkung|info         die einzelnen Guards
//   wort.<name>                               einzelne Woerter der Bedienung
//   satz.<name>                               ganze Saetze, die keinem Feld gehoeren
//   frage.<name>                              der Text einer Rueckfrage
//
// PLATZHALTER stehen in geschweiften Klammern und werden beim Abruf ersetzt:
// `t('satz.x', { maschine: 'peer' })`. Sie bleiben stehen, wenn der Wert fehlt
// -- ein sichtbares `{maschine}` ist eine Meldung, ein stilles Loch ist keine.

/** Die Sprachen dieses Fensters. Beide tragen eine vollstaendige Tabelle. */
export type Sprache = 'de' | 'en';

/**
 * DEUTSCH, die Auslieferungssprache dieser Fassung.
 *
 * Sortiert wie die Oberflaeche: erst die Seiten, dann die Gruppen, dann die
 * Felder in der Reihenfolge, in der sie im Fenster stehen. Wer ein Feld sucht,
 * sucht seinen Einstellungs-Schluessel -- der ist zugleich die Kennung hier.
 */
export const DE: Record<string, string> = {
  'fenster.titel': 'Agent-Workbench — Einstellungen',
  // --- Die sieben Seiten ---------------------------------------------------
  'seite.sitzung.titel': 'Sitzung',
  'seite.sitzung.wofuer': 'Womit eine neue Sitzung anfängt',
  'seite.sitzung.unterzeile':
    'Womit eine neue Sitzung startet, wo sie anfängt zu arbeiten, und wie ihre Leiste sich verhält. '
    + 'Die Worker stellst du hier nicht ein: die richtet der Orchestrator für dich ein.',

  'seite.erlaubnisse.titel': 'Erlaubnisse',
  'seite.erlaubnisse.wofuer': 'Was die Agenten dürfen',
  'seite.erlaubnisse.unterzeile':
    'Was ein Agent ohne Rückfrage tun darf und wo er angehalten wird. Jede Zeile hier nimmt eine '
    + 'Sicherung weg oder setzt eine ein; neben jeder steht ein Zeichen, hinter dem der Grund steht.',

  'seite.harnesses.titel': 'Programme und Modelle',
  'seite.harnesses.wofuer': 'Anmelden, anbinden, deckeln',
  'seite.harnesses.unterzeile':
    'Welche Agenten-Programme auf dieser Maschine laufen, ob sie angemeldet sind, wie die lokalen '
    + 'Modelle erreicht werden, und wie tief der Orchestrator ungefragt gehen darf.',

  'seite.maschinen.titel': 'Maschinen',
  'seite.maschinen.wofuer': 'Rechner und Auslastung',
  'seite.maschinen.unterzeile':
    'Welche Rechner in dieser Liste stehen, wie das Programm sie erreicht, und wie viel Arbeit '
    + 'jeder gleichzeitig tragen darf.',

  'seite.aufsicht.titel': 'Aufsicht und Meldungen',
  'seite.aufsicht.wofuer': 'Wache, Stillstand, Hinweise',
  'seite.aufsicht.unterzeile':
    'Was das Programm von sich aus beobachtet, ab wann es eingreift, und worüber es dich außerhalb '
    + 'des Fensters benachrichtigt.',

  'seite.aussehen.titel': 'Aussehen',
  'seite.aussehen.wofuer': 'Farben, Schrift, Sprache',
  'seite.aussehen.unterzeile':
    'Wie das Programm aussieht und wie viel auf den Bildschirm passt. Nichts hiervon ändert, was '
    + 'die Agenten tun.',

  'seite.programm.titel': 'Programm',
  'seite.programm.wofuer': 'Dateien, Abweichungen, Sicherung',
  'seite.programm.unterzeile':
    'Wo die Dateien dieses Programms liegen, was bei dir von der Auslieferung abweicht, und wie du '
    + 'den ganzen Stand sicherst, zurücksetzt oder auf einen anderen Rechner überträgst.',

  // --- Gruppenüberschriften ------------------------------------------------
  'gruppe.sitzung.start': 'Womit eine neue Sitzung anfängt',
  'gruppe.sitzung.leiste': 'Die Sitzungsleiste',
  'gruppe.sitzung.schliessen': 'Beim Schließen des Fensters',
  'gruppe.erlaubnisse.vorsicht': 'Ohne Rückfragen arbeiten',
  'gruppe.erlaubnisse.guards': 'Sicherungen vor jedem Befehl',
  'gruppe.erlaubnisse.rueckfragen': 'Befehle, bei denen zurückgefragt wird',
  'gruppe.erlaubnisse.geheimnisse': 'Was nie gelesen wird',
  'gruppe.erlaubnisse.werkzeuge': 'Werkzeuge und MCP-Server',
  'gruppe.harnesses.programme': 'Die Programme auf dieser Maschine',
  'gruppe.harnesses.lokal': 'Lokale Modelle',
  'gruppe.harnesses.schluessel': 'Zugang zu den Anbietern',
  'gruppe.harnesses.deckel': 'Wie tief der Orchestrator ungefragt gehen darf',
  'gruppe.maschinen.liste': 'Rechner in dieser Liste',
  'gruppe.maschinen.last': 'Wie viel diese Maschine trägt',
  'gruppe.aufsicht.wache': 'Die Kontextwache',
  'gruppe.aufsicht.stillstand': 'Stillstand',
  'gruppe.aufsicht.meldungen': 'Benachrichtigungen',
  'gruppe.aussehen.thema': 'Hell und dunkel',
  'gruppe.aussehen.terminal': 'Schrift und Rollen',
  'gruppe.aussehen.panes': 'Wie die Worker im Fenster liegen',
  'gruppe.aussehen.sprache': 'Sprache und Ansicht',
  'gruppe.programm.dateien': 'Wo was liegt',
  'gruppe.programm.abweichungen': 'Was bei dir anders ist',
  'gruppe.programm.sicherung': 'Sichern, zurücksetzen, übertragen',
  'gruppe.programm.erststart': 'Der geführte erste Start',

  // --- Seite 1: Sitzung ----------------------------------------------------
  'feld.orchestratorHarness.name': 'Programm im Hauptfenster',
  'feld.orchestratorHarness.wirkung':
    'Welche Agenten-CLI der Orchestrator-Pane startet. Die Zahl daneben nennt die Modelle, die dazu passen.',
  'feld.orchestratorHarness.info':
    'Jeder registrierte Adapter steht zur Wahl, nicht nur Claude Code und pi. „fehlt hier" heißt: das '
    + 'Programm dieses Adapters gibt es auf {maschine} nicht, ein Start liefe ins Leere. Geprüft wird '
    + 'dasselbe, was auch wb-state vor einem Start prüft: das Binary im Pfad.',
  'feld.orchestratorHarness.etikett': 'gilt für die nächste Sitzung',

  'feld.orchestratorModel.name': 'Modell der Sitzung',
  'feld.orchestratorModel.wirkung':
    'Womit der Orchestrator denkt, solange beim Start nichts anderes gesagt wird.',
  'feld.orchestratorModel.info':
    '{anzahl} Modelle mit der Rolle „Orchestrator" für dieses Programm. Die Kennung rechts ist die, mit '
    + 'der auch die Werkzeuge starten. Ein Modell, dessen Programm hier fehlt, bleibt in der Liste stehen '
    + 'und ist rot markiert — damit man sieht, warum es nicht anläuft, statt es zu suchen.',
  'feld.orchestratorModel.etikett': 'gilt für die nächste Sitzung',
  'feld.orchestratorModel.leerName': 'Modell',
  'feld.orchestratorModel.leerWirkung':
    'Für dieses Programm ist kein Modell mit der Rolle „Orchestrator" eingetragen.',
  'feld.orchestratorModel.leerInfo':
    'Ein Modell mit dieser Rolle anlegen: wb-state models add-model … --roles orchestrator. Solange '
    + 'keins da ist, startet die Sitzung mit dem, was die CLI selbst vorgibt.',
  'satz.keinModellFuerProgramm': 'Kein Modell mit Programm „{harness}" und Rolle „Orchestrator".',

  'feld.orchestratorEffort.name': 'Wie tief die Sitzung denkt',
  'feld.orchestratorEffort.wirkung':
    'Die Stufe, mit der der Orchestrator startet. Deine Wahl — jede Stufe, die das Programm annimmt.',
  'feld.orchestratorEffort.info':
    'Das ist die Wahl eines Menschen, und einen Menschen bindet kein Deckel: alle Stufen sind wählbar, '
    + 'auch die über dem Deckel; sie tragen nur eine Markierung. Der Deckel ist etwas anderes — er ist die '
    + 'Selbstbindung des Orchestrators für Worker, die er ohne Rückfrage startet. Welche Stufen es '
    + 'überhaupt gibt, sagt das Programm selbst: gemessen an seiner Hilfe, nicht aus einer Liste '
    + 'abgeschrieben. Höhere Stufen kosten mehr Zeit und mehr Kontingent.',
  'feld.orchestratorEffort.etikett': 'gilt für die nächste Sitzung',

  'feld.orchestratorKontext.name': 'Kontextfenster',
  'feld.orchestratorKontext.wirkung':
    'Wie viel Text „{modell}" gleichzeitig im Kopf behält. Nur bei einem Modell, das hier auf der '
    + 'Maschine läuft — bei einem Modell aus der Cloud gehört diese Zahl dem Anbieter.',
  'feld.orchestratorKontext.info':
    'Ein größeres Fenster hält mehr Zusammenhang, belegt aber dauerhaft mehr Grafikspeicher: der Bedarf '
    + 'steigt mit jedem Token, und was nicht mehr hineinpasst, lässt den Start scheitern. Deshalb steht '
    + 'an jeder Stufe, was sie braucht und was gerade frei ist. Gesperrt ist nichts: Stufen, für die der '
    + 'Speicher heute nicht reicht, bleiben wählbar und tragen einen Hinweis — die Entscheidung liegt bei '
    + 'dir, nicht beim Programm. Gemessen wird sie von wb-kontext, zusammen mit dem freien Speicher '
    + 'dieses Augenblicks. Die Wahl gilt für den Orchestrator; über die Fenster der Worker entscheidet '
    + 'der Orchestrator selbst.',
  'feld.orchestratorKontext.etikett': 'gilt für die nächste Sitzung',
  'wort.kontextToken': '{tokens} Token',
  'wort.kontextEmpfohlen': 'empfohlen',
  'satz.kontextBedarf': 'Braucht {bedarf} GiB.',
  'satz.kontextSpeicher': 'Frei sind {frei} GiB, die Gewichte des Modells belegen davon {gewichte} GB.',
  'satz.kontextFremderWert':
    'Gespeichert sind {tokens} Token — diese Stufe bietet das gewählte Modell nicht an. '
    + 'Solange keine der Stufen gewählt ist, startet die Sitzung mit dem gespeicherten Wert.',
  'satz.kontextWirdErmittelt': 'Die Stufen werden ermittelt …',
  'satz.kontextNichtErmittelt':
    'Die Stufen ließen sich nicht ermitteln: {grund}. Solange das so ist, startet die Sitzung mit dem '
    + 'Fenster, das für dieses Modell eingetragen ist.',

  'feld.newSessionDefaultDir.name': 'Ordner, in dem eine neue Sitzung anfängt',
  'feld.newSessionDefaultDir.wirkung':
    'Diesen Ordner schlägt der Plus-Knopf vor, solange du keinen anderen wählst.',
  'feld.newSessionDefaultDir.info':
    'Der Vorschlag, mehr nicht: gewählt wird im Ordner-Dialog, und wer dort etwas anderes nimmt, bekommt '
    + 'das andere. „~" steht für dein Heimatverzeichnis. Diese Einstellung war bis zum 11.08. nur in der '
    + 'VS-Code-Erweiterung erreichbar, obwohl dieses Programm sie längst liest; deshalb steht sie jetzt hier.',
  'feld.newSessionDefaultDir.etikett': 'gilt für die nächste Sitzung',

  'feld.showStopped.name': 'Beendete Sitzungen mitzeigen',
  'feld.showStopped.wirkung':
    'An: die Leiste zeigt auch Sitzungen, deren Terminal nicht mehr läuft — rot markiert.',
  'feld.showStopped.info':
    'Aus (Vorgabe) hält die Leiste kurz: nur, was gerade lebt. An ist nützlich, wenn man eine Sitzung von '
    + 'gestern wiederaufnehmen will — sie steht dann mit ihrem Ordner da und lässt sich anklicken. Das ist '
    + 'eine Einstellung und keine tägliche Handlung, deshalb steht sie hier und nicht als Knopf in der Leiste.',
  'feld.showStopped.etikett': 'sofort',

  'feld.sort.name': 'Reihenfolge in der Leiste',
  'feld.sort.wirkung':
    'Wonach die Sitzungen stehen, solange keine eigene Reihenfolge gezogen wurde.',
  'feld.sort.info':
    'Von Hand gezogen schlägt diese Vorgabe immer — wer eine Sitzung an einen Platz zieht, will sie dort '
    + 'haben. Die Vorgabe greift für alles, was danach dazukommt. „zuletzt benutzt" ordnet nach der letzten '
    + 'Bewegung im Terminal, nicht nach dem Anlegen.',
  'feld.sort.etikett': 'sofort',
  'wort.sort.recent': 'zuletzt benutzt',
  'wort.sort.folder': 'nach Ordner',
  'wort.sort.name': 'nach Name',

  'feld.closeSessionOnWindowClose.name': 'Terminal mit dem Fenster beenden',
  'feld.closeSessionOnWindowClose.wirkung':
    'Aus (Vorgabe): das Fenster geht zu, die tmux-Sitzung dahinter läuft weiter — beendet wird sie über '
    + 'den Rechtsklick auf die Sitzung. An: schließt man das Fenster, endet auch die Sitzung.',
  'feld.closeSessionOnWindowClose.info':
    'Gemessen am 04.08.: drei geschlossene Fenster hielten ihre tmux-Sitzungen am Leben und zusammen 6,0 GB '
    + 'belegt. Ein Neuladen beendet nie etwas — die Sitzung gilt erst nach einer Karenzzeit als verwaist, und '
    + 'ein zurückkehrendes Fenster nimmt die Marke wieder weg. Läuft noch ein Worker, bleibt sie ohnehin '
    + 'offen. Seit dem 07.08. steht die Vorgabe trotzdem auf aus: belegter Speicher lässt sich jederzeit '
    + 'zurückholen, eine versehentlich beendete Sitzung samt laufender Arbeit nicht.',
  'feld.closeSessionOnWindowClose.etikett': 'sofort',

  // --- Seite 2: Erlaubnisse ------------------------------------------------
  'feld.workerSkipPermissions.name': 'Worker arbeiten ohne Rückfrage ihrer CLI',
  'feld.workerSkipPermissions.wirkung':
    'An: ein Worker hält bei einem Schreibzugriff nicht an, sondern arbeitet durch.',
  'feld.workerSkipPermissions.info':
    'Das ist die folgenreichste stille Festlegung des ganzen Aufbaus, und sie stand bis zum 06.08. nur in '
    + 'einer Zeile Shell-Code. Die Guards und die Rückfrage-Stufe greifen weiterhin — die '
    + 'Berechtigungsabfrage der CLI nicht. Aus heißt: jeder Worker hält bei jedem Schreibzugriff an und '
    + 'wartet auf einen Menschen; ein Nachtlauf steht dann bis zum Morgen.',
  'feld.workerSkipPermissions.etikett': 'gilt für den nächsten Worker',

  'feld.orchestratorPermissionMode.name': 'Wie viel der Orchestrator ohne Rückfrage tun darf',
  'feld.orchestratorPermissionMode.wirkung':
    'Legt die Rückfrage-Stufe fest, mit der die CLI der nächsten Orchestrator-Sitzung startet.',
  'feld.orchestratorPermissionMode.info':
    'Die sechs Stufen von claude --permission-mode, gemessen aus claude --help. Senken -- jeder Wechsel '
    + 'weg von bypassPermissions -- geht sofort und ohne Grund; das Anheben zurück auf bypassPermissions, '
    + 'die Vorgabe, verlangt einen echten Menschen an dieser Oberfläche und einen Grund, geprüft von '
    + 'wb-state selbst. shell/wb-code liest den Wert beim Start der nächsten Orchestrator-Sitzung, nicht '
    + 'in der laufenden. Worker bleiben unberührt -- die stellt der Orchestrator für sich selbst ein.',
  'feld.orchestratorPermissionMode.etikett': 'gilt für die nächste Sitzung',

  'feld.workerWorktrees.name': 'Jeder Worker bekommt einen eigenen Arbeitsbaum',
  'feld.workerWorktrees.wirkung':
    'An: jeder Worker arbeitet in einem git-Repo in seinem eigenen Ordner und Zweig statt im gemeinsamen.',
  'feld.workerWorktrees.info':
    'Der Baum liegt unter ~/.pi-workers/worktrees/<name>, der Zweig heißt wb/<name>. Aus heißt: alle Worker '
    + 'arbeiten im übergebenen Verzeichnis und begegnen sich dort — zwei, die dieselbe Datei anfassen, '
    + 'überschreiben einander. Außerhalb eines git-Repos ändert der Schalter nichts. Er wirkt global, weil '
    + 'weder claude-worker noch pi-worker heute einen Schalter je Aufruf kennen.',
  'feld.workerWorktrees.etikett': 'gilt für den nächsten Worker',

  'feld.guards.name': 'Welche Sicherungen mitlaufen',
  'feld.guards.wirkung':
    'Jede Sicherung ist einzeln abschaltbar. Eine abgeschaltete bleibt in der Liste stehen, mit Grund und Datum.',
  'feld.guards.info':
    'Sie laufen vor jedem Befehl, den ein Agent absetzt, in dieser Reihenfolge; die letzte ist die '
    + 'Rückfrage-Stufe darunter. Was eine von ihnen hart ablehnt, kommt in der Rückfrage-Stufe nie an. Zwei '
    + 'von ihnen (Laufende Konfiguration, Medien aus der Cloud) warnen nur und halten nichts an. Abschalten '
    + 'verlangt einen Grund und einen Menschen; er wird mit Datum daneben vermerkt, damit in einem halben '
    + 'Jahr noch jemand weiß, warum die Sicherung fehlt.',
  'feld.guards.etikett': 'sofort',

  'feld.askPatterns.name': 'Befehle, bei denen zurückgefragt wird',
  'feld.askPatterns.wirkung':
    'Diese Befehle werden angehalten, erscheinen in der Freigabe-Ansicht und laufen nach einer einmaligen '
    + 'Freigabe durch.',
  'feld.askPatterns.info':
    'Weder harmlos noch verboten — das ist die Stufe dazwischen. Ein Muster trifft eine STELLE in der '
    + 'zerlegten Befehlszeile, nicht eine Zeichenkette irgendwo im Text: sonst hielte schon ein Absatz, der '
    + '„git clean -fd" nur erwähnt, den Guard an (so geschehen am 05.08.). Abgeschaltet statt gelöscht '
    + 'bleibt sichtbar, dass es das Muster gibt. Eine Freigabe gilt fünfzehn Minuten, hart gedeckelt im Modul.',
  'feld.askPatterns.etikett': 'sofort',

  'feld.secretExcludeDirs.name': 'Ordner, die keine Ansicht betritt',
  'feld.secretExcludeDirs.wirkung':
    'Diese Ordner betritt keine Ansicht — sie werden übersprungen, nicht nur ausgeblendet.',
  'feld.secretExcludeDirs.info':
    'Dateibaum, Schnellöffner, Inhaltssuche und Editor fragen dieselbe Stelle; ein Filter, den eine Ansicht '
    + 'umgehen kann, ist keiner. Geprüft wird JEDER Namensteil eines Pfades, nicht nur der letzte — sonst '
    + 'käme projekt/.ssh/config durch. Die Liste steht hier und nicht im Quelltext, weil man sie sehen und '
    + 'prüfen können soll.',
  'feld.secretExcludeDirs.etikett': 'sofort',

  'feld.secretExcludePatterns.name': 'Dateinamen, die keine Ansicht zeigt',
  'feld.secretExcludePatterns.wirkung':
    'Dateien, deren Name auf eines dieser Muster passt, tauchen in keiner Ansicht auf.',
  'feld.secretExcludePatterns.info':
    'Ein Glob auf EINEN Namensteil, ohne Pfadtrenner: * steht für beliebig viele Zeichen, ? für eines. '
    + 'Bewusst klein gehalten — ein voller Glob-Dialekt mit ** und {a,b} lädt zu Mustern ein, deren Wirkung '
    + 'man nicht mehr sieht. Groß- und Kleinschreibung spielt keine Rolle.',
  'feld.secretExcludePatterns.etikett': 'sofort',

  'feld.werkzeuge.name': 'Werkzeuge und MCP-Server eines Agenten',
  'feld.werkzeuge.wirkung':
    'Was ein Agent an Werkzeugen mitbekommt, steht heute in seiner eigenen Konfiguration — dieses Programm '
    + 'liest es, setzt es aber noch nicht.',
  'feld.werkzeuge.info':
    'Die Hooks unten kommen aus ~/.claude/settings.json und gelten für jede Claude-Sitzung dieser Maschine; '
    + 'die MCP-Server hängen an den Diensten, die mcp-shared verwaltet. Beides wird hier gezeigt und nicht '
    + 'geschrieben: ein Schalter, der eine fremde Konfiguration halb überschreibt, ist schlimmer als kein '
    + 'Schalter. Der Weg dorthin ist beschrieben (die Werkbank schreibt Harness-Konfigurationen über '
    + 'wb-harness-run) und noch nicht gebaut.',
  'satz.werkzeugeOhneHooks':
    'In ~/.claude/settings.json steht kein Hook. Ein Agent bekommt damit die Werkzeuge, die seine CLI '
    + 'von sich aus mitbringt.',
  'satz.werkzeugeMcp':
    'MCP-Server werden von mcp-shared als Hintergrunddienste gehalten und nicht von diesem Programm. '
    + 'Solange das so ist, steht hier kein Schalter dafür, sondern dieser Satz.',

  // Die neun Guards -- Kennungen aus hooks/bash-guard.py, Text von hier.
  'guard.secrets.name': 'Geheimnisse',
  'guard.secrets.wirkung':
    'Hält jeden Befehl an, der einen Schlüssel, ein Zertifikat oder den Geheimnis-Ordner anfasst.',
  'guard.secrets.info':
    'Deckt ~/Knowledge/90-secrets, ~/.ssh und die üblichen Zugangsdaten-Dateien ab — dieselbe Liste, die '
    + 'auch die Ordneransicht auslässt. Aus heißt: ein Agent kann diese Dateien lesen, kopieren und in eine '
    + 'Ausgabe schreiben, ohne dass jemand gefragt wird.',
  'guard.kill-pattern.name': 'Fremde Prozesse beenden',
  'guard.kill-pattern.wirkung':
    'Hält Befehle an, die Prozesse abschießen, die dem Agenten nicht gehören.',
  'guard.kill-pattern.info':
    'Ein pkill über einen zu weiten Ausdruck hat schon laufende Worker aus dem Grid genommen. Der Guard '
    + 'unterscheidet, was der Agent selbst gestartet hat, von dem, was vorher lief.',
  'guard.live-config.name': 'Laufende Konfiguration',
  'guard.live-config.wirkung':
    'Warnt, wenn ein Befehl die Dateien anfasst, an denen das laufende Setup hängt.',
  'guard.live-config.info':
    'Nur eine Warnung, kein Stopp: die Kette läuft weiter. Der Grund ist ein Vorfall, bei dem ein Test die '
    + 'echte Einstellungsdatei umgeschrieben und vier laufende Worker unsichtbar gemacht hat.',
  'guard.push-gate.name': 'Push-Sperre für Worker',
  'guard.push-gate.wirkung':
    'Ein Worker darf nicht pushen, keine Pull-Requests öffnen, nichts veröffentlichen.',
  'guard.push-gate.info':
    'Der Orchestrator entscheidet über Pushes, weil nur er den ganzen Stand kennt. Der Guard erkennt die '
    + 'Rolle am Pane, nicht am Namen. Aus heißt: jeder Worker kann in ein öffentliches Repo drücken.',
  'guard.media-cloud.name': 'Medien aus der Cloud',
  'guard.media-cloud.wirkung':
    'Warnt, wenn ein Bild, ein Video oder eine Stimme von einem bezahlten Dienst statt lokal kommt.',
  'guard.media-cloud.info':
    'Nur eine Warnung. Die lokalen Werkzeuge (bild, video, tts, stt) kosten nichts und verlassen die '
    + 'Maschine nicht; ein Cloud-Aufruf tut beides und soll deshalb bewusst geschehen.',
  'guard.screencapture.name': 'Bildschirmaufnahmen',
  'guard.screencapture.wirkung':
    'Hält Befehle an, die den Bildschirm abfotografieren oder aufzeichnen.',
  'guard.screencapture.info':
    'Ein Bildschirmfoto nimmt alles mit, was gerade offen ist — auch das, was niemanden etwas angeht. Für '
    + 'Belegbilder gibt es den Weg über das Fenster selbst, der nur das eigene Fenster aufnimmt.',
  'guard.snapshot.name': 'Sicherung vor dem Löschen',
  'guard.snapshot.wirkung':
    'Hält Löschbefehle an, solange keine Kopie der Daten angelegt wurde.',
  'guard.snapshot.info':
    'Die Kopie landet unter ~/.local/trash-snapshots/<datum>-<name>/. Der Guard prüft, ob sie existiert, '
    + 'bevor der Löschbefehl durchgeht — er ersetzt sie nicht.',
  'guard.commit-trailer.name': 'Absender eines Commits',
  'guard.commit-trailer.wirkung':
    'Hält einen Commit an, der einen fremden Mitautor untergeschoben bekommt.',
  'guard.commit-trailer.info':
    'In diesen Repos steht ein Autor und sonst niemand. Der Guard ist der einzige, der mit einem Fehlerkode '
    + 'statt einer Antwort abbricht — er sitzt direkt vor dem Commit.',
  'guard.muster.name': 'Rückfrage-Stufe',
  'guard.muster.wirkung':
    'Die Musterliste weiter unten: Befehle, die weder harmlos noch verboten sind, werden angehalten.',
  'guard.muster.info':
    'Die letzte Stufe, und die einzige, die nicht ablehnt, sondern fragt. Sie sitzt hinter allen anderen: '
    + 'was ein Guard hart ablehnt, kommt hier nie an. Hier abgeschaltet heißt: kein Muster löst mehr eine '
    + 'Rückfrage aus — auch die, die weiter unten angehakt sind.',

  // --- Seite 3: Programme und Modelle --------------------------------------
  'feld.harnessTabelle.name': 'Programme, Anmeldung und Chat-Ansicht',
  'feld.harnessTabelle.wirkung':
    'Für jedes Agenten-Programm: ob es hier startet, ob es angemeldet ist, welche Denkstufen es annimmt und '
    + 'ob es eine Chat-Ansicht tragen kann.',
  'feld.harnessTabelle.info':
    'Die Stufen sind an der Hilfe des jeweiligen Programms gemessen, nicht abgeschrieben. Die Anmeldung ist '
    + 'kein Ratespiel: geprüft wird, ob der Beleg vorliegt, den die Registry für diesen Anbieter nennt — '
    + 'liegt keiner vor, steht „nicht prüfbar" da und nicht „nicht angemeldet". Die Chat-Ansicht hängt am '
    + 'Programm und nicht am Geschmack; was ein Programm nicht kann, bekommt hier kein graues Feld, sondern '
    + 'den Grund im Klartext.',
  'wort.startbar': 'startet hier',
  'wort.nichtStartbar': 'startet auf {maschine} nicht',
  'wort.angemeldet': 'angemeldet',
  'wort.nichtAngemeldet': 'nicht angemeldet',
  'wort.anmeldungUnbekannt': 'nicht prüfbar',
  'wort.stufenNichtErmittelt': 'nicht ermittelt',
  'wort.keineStufen': 'kennt keine Stufen',
  'spalte.programm': 'Programm',
  'spalte.stufen': 'Stufen',
  'spalte.modelle': 'Modelle',
  'spalte.hier': 'Auf {maschine}',
  'spalte.anmeldung': 'Anmeldung',
  'spalte.chat': 'Chat-Ansicht',
  'spalte.modell': 'Modell',
  'spalte.deckel': 'Deckel',
  'spalte.herkunft': 'Herkunft',
  'spalte.grund': 'Grund',
  'spalte.einstellung': 'Einstellung',
  'spalte.beiDir': 'Bei dir',
  'spalte.auslieferung': 'Auslieferung',
  'spalte.anbieter': 'Anbieter',
  'spalte.zugang': 'Zugang',
  'spalte.eingabe': 'Eingeben',
  'spalte.maschine': 'Maschine',
  'spalte.wert': 'Wert',

  'satz.chatKannNicht': 'Kein Weg zum Gesprächsverlauf eingetragen — deshalb steht hier kein Schalter.',
  'satz.chatOhneMessung': 'Eingetragen, aber ohne Messdatum — ohne die zählt der Eintrag nicht.',
  'satz.chatKannLive': 'liest mit, während die Sitzung läuft',
  'satz.chatKannNichtLive': 'liest erst, wenn die Sitzung steht',
  'satz.chatZeigtNicht': 'Zeigt nicht: {liste}.',

  'feld.chatAnsicht.name': 'Gespräch statt Terminal anzeigen',
  'feld.chatAnsicht.wirkung':
    'An: die Werkbank zeichnet für dieses Programm den Gesprächsverlauf statt des Terminalbilds.',
  'feld.chatAnsicht.info':
    'Der Schalter steht je Programm und nicht global, weil die Fähigkeit am Programm hängt und nicht am '
    + 'Geschmack. Der Terminal-Pane läuft in beiden Fällen weiter und wird weiter ausgewertet — nur so weiß '
    + 'die Werkbank, ob das Programm gerade fragt, antwortet oder wartet; sichtbar ist bloß die andere '
    + 'Darstellung. Was in keinem Protokoll steht (Freigabedialoge, Kontextauslastung, Fortschritt), steht '
    + 'in der Zeile daneben.',
  'feld.chatAnsicht.etikett': 'gilt für die nächste Sitzung',

  'feld.ollamaEndpoint.name': 'Adresse des lokalen Modell-Servers',
  'feld.ollamaEndpoint.wirkung':
    'Unter dieser Adresse werden die lokalen Modelle gesucht — Ollama, vLLM oder MLX, je nachdem, was dort '
    + 'antwortet.',
  'feld.ollamaEndpoint.info':
    'Bis zum 11.08. stand http://127.0.0.1:11434 an sieben Stellen fest im Quelltext und ließ sich nirgends '
    + 'einstellen; wer Ollama auf einem anderen Rechner betreibt, musste sieben Dateien von Hand ändern. '
    + 'Dieses Feld ist die eine Stelle dafür. Erwartet wird eine vollständige Adresse mit http:// oder '
    + 'https:// und ohne Pfad am Ende. Ein Server im Netz statt auf dieser Maschine heißt: die Anfragen '
    + 'verlassen den Rechner — das ist eine Entscheidung und keine Kleinigkeit.',
  'feld.ollamaEndpoint.etikett': 'gilt für den nächsten Abruf',
  'satz.ollamaNochNichtVerdrahtet':
    'Der Wert wird gespeichert und hier angezeigt. Die sieben Stellen im Quelltext, die die Adresse heute '
    + 'noch fest enthalten, lesen ihn noch nicht — sie werden in einem eigenen Schritt nachgezogen.',

  'feld.modelDiscoveryAuto.name': 'Modell-Kataloge von selbst abrufen',
  'feld.modelDiscoveryAuto.wirkung':
    'An: die Kataloge der Anbieter werden von selbst aus dem Netz geholt. Aus: nur noch auf Knopfdruck.',
  'feld.modelDiscoveryAuto.info':
    'Aus heißt NUR, dass nicht mehr von selbst ins Netz gegangen wird. Die lokalen Quellen — ollama, die '
    + 'Modell-Listen der CLIs, Dateien — laufen weiter automatisch, und der Abruf von Hand bleibt immer '
    + 'bedienbar. Diese Einstellung war bis zum 11.08. nur in der VS-Code-Erweiterung erreichbar, obwohl '
    + 'wb-state sie längst liest.',
  'feld.modelDiscoveryAuto.etikett': 'sofort',

  'feld.orchestratorVorhersage.name': 'Multi-Token-Vorhersage für den Orchestrator',
  'feld.orchestratorVorhersage.wirkung':
    'An: der Orchestrator lädt, falls für sein Modell hinterlegt, zusätzlich einen Entwerfer oder eine '
    + 'Fassung mit eingebautem Vorhersage-Kopf — schneller je Antwort, aber ohne gemeinsame Nebenläufigkeit '
    + 'am MLX-Server.',
  'feld.orchestratorVorhersage.info':
    'Welche Wege es gibt, steht in der Registry: wählbar ist nur, was dort hinterlegt und gemessen ist, '
    + 'kein freier Pfad. Führt die Registry für das Modell mehrere Wege, stehen sie unter dem Haken zur '
    + 'Wahl, mit ihrer Herkunft darunter — samt der Stellen, an denen etwas NICHT gemessen wurde. '
    + 'Spekulatives Decoding und die geteilte Nebenläufigkeit des MLX-Servers schließen sich gegenseitig '
    + 'aus (mlx_lm.server schaltet die Stapelverarbeitung ab, sobald ein Entwerfer gesetzt ist) — deshalb '
    + 'steht dieser Schalter standardmäßig aus.',
  'feld.workerVorhersage.name': 'Multi-Token-Vorhersage für Worker',
  'feld.workerVorhersage.wirkung':
    'An: ein Worker mit einem lokalen Modell lädt, falls dafür hinterlegt, denselben Entwerfer oder '
    + 'eingebauten Kopf — getrennt vom Schalter des Orchestrators.',
  'feld.workerVorhersage.info':
    'Welches Modell dabei benutzt wird, steht in der Registry und ist hier nicht wählbar — nur diese '
    + 'Anzeige zeigt es an. Gilt unabhängig vom Orchestrator-Schalter: der eine kann an sein, der andere '
    + 'aus.',
  'wort.vorhersageEntwerfer': 'externer Entwerfer',
  'wort.vorhersageEingebaut': 'eingebauter Kopf',
  'satz.vorhersageModell': 'Modell: {modell} ({bauart})',
  'satz.vorhersageKeine': 'Für das aktuell gewählte Modell ist keine Vorhersage hinterlegt.',
  'satz.vorhersageWegVorgabe': '{weg} (Vorgabe)',

  'feld.anbieter.name': 'Zugang zu den Anbietern',
  'feld.anbieter.wirkung':
    'Für jeden Anbieter: woher sein Zugang kommt und ob er auf dieser Maschine vorliegt.',
  'feld.anbieter.info':
    'Ein Schlüssel wird hier eingegeben, aber NICHT in die Einstellungsdatei geschrieben — die ist '
    + 'geteilter Klartext, den auch Worker beschreiben, und ein Schlüssel darin wäre ein Schlüssel im '
    + 'Klartext. Der Wert geht stattdessen einen eigenen Weg und wird danach nie wieder ausgelesen, um ihn '
    + 'anzuzeigen. Gezeigt wird deshalb weiterhin nur, ob der Zugang vorliegt — nie sein Wert und nie sein '
    + 'Ort. Ein Anbieter mit Abo statt Schlüssel meldet stattdessen, ob die Anmeldung stattgefunden hat.',
  'wort.zugangDa': 'liegt vor',
  'wort.zugangFehlt': 'fehlt',
  'wort.zugangUnbekannt': 'nicht prüfbar',
  'wort.zugangAbo': 'Abo, kein Schlüssel',
  'wort.zugangLokal': 'läuft lokal, kein Zugang nötig',

  'feld.effortCaps.name': 'Höchste Stufe ohne Rückfrage',
  'feld.effortCaps.wirkung':
    'Bis hierher darf der Orchestrator gehen, wenn er von sich aus einen Worker startet.',
  'feld.effortCaps.info':
    '„Auslieferung" heißt: der Wert kommt aus der Registry, so wie das Modell geliefert wurde. Sobald du '
    + 'einen Deckel setzt, steht dort „von dir" mit Datum und Grund — und der Grund ist Pflicht, weil eine '
    + 'Selbstbindung ohne Begründung nach einem halben Jahr wie eine technische Grenze aussieht. Senken darf '
    + 'jeder; anheben verlangt einen Menschen, gemessen an der Herkunft des Aufrufs. Zurück auf die '
    + 'Auslieferung geht über den ersten Eintrag der Auswahl.',
  'feld.effortCaps.etikett': 'gilt für den nächsten automatischen Start',
  'satz.deckelLeitsatzFett': 'Ein Deckel bindet den Orchestrator, nicht dich. ',
  'satz.deckelLeitsatz':
    'Wenn du selbst startest, stehen dir alle Stufen offen, die das Programm annimmt. Der Deckel hier gilt '
    + 'für Worker, die der Orchestrator ohne Rückfrage startet: er soll sich nicht von selbst die teuerste '
    + 'Stufe geben.',
  'satz.deckelDieses': 'Deckel dieses Modells: ',
  'satz.deckelGilt':
    '. Er gilt, wenn der Orchestrator von sich aus einen Worker startet — für deine Wahl hier gilt er nicht. ',
  'satz.deckelDarueber': 'Gestrichelt umrandet: die Stufen darüber ({stufen}).',
  'satz.deckelGrund': 'Grund des Deckels: {grund}',
  'satz.deckelKeiner':
    'Für dieses Modell ist kein Deckel eingetragen — der Orchestrator vergibt jede Stufe.',
  'satz.deckelUeber':
    'Über dem Deckel ({deckel}). Wählbar: der Deckel bindet den Orchestrator, nicht dich.',
  'wort.vonDir': 'von dir gesetzt',
  'wort.ausAuslieferung': 'Auslieferung',
  'wort.vonDirAm': 'von dir, {datum}',
  'satz.deckelAuslieferungWahl': 'Auslieferung ({deckel})',
  'wort.ohne': 'ohne',
  'satz.stufenKeineWahl': '„{harness}" kennt keine Stufen — hier ist nichts zu wählen.',
  'satz.stufenErstModell': 'Erst ein Modell wählen; die Stufen hängen an seinem Programm.',

  // --- Seite 4: Maschinen --------------------------------------------------
  'feld.remoteMachines.name': 'Rechner, die mitarbeiten',
  'feld.remoteMachines.wirkung':
    'Jede Maschine hier taucht in der Sitzungsleiste auf und steht als Ziel für einen Worker zur Wahl.',
  'feld.remoteMachines.info':
    'Der Name ist der SSH-Alias, so wie „ssh peer" ihn kennt — es gibt keine zweite Adressliste daneben. '
    + 'Ein Tailscale-Name oder eine IP funktioniert genauso, sofern ssh damit umgehen kann; wer ein Gate '
    + 'davor hat, trägt den Alias ein, der durch das Gate führt. Mehr als zwei sind ausdrücklich vorgesehen. '
    + 'Die Liste bleibt leer, bis jemand etwas einträgt: ein SSH-Ziel ist ein echter Netzzugriff und darf nie '
    + 'von selbst anspringen. Der Prüfknopf fragt genau einmal nach (ssh <name> true).',
  'feld.remoteMachines.etikett': 'sofort',
  'satz.eigeneMaschine':
    'Diese Maschine — sie steht immer in der Liste und lässt sich nicht entfernen.',
  'satz.fremdeMaschine': 'Erreicht über ssh {name} — der Name IST der SSH-Alias.',
  'satz.keineMaschine':
    'Keine weitere Maschine eingetragen. Ohne Eintrag geht das Programm nie von selbst ins Netz.',
  'satz.maschineSchonDa': '„{name}" steht schon in der Liste.',
  'satz.fremdeLast':
    'Wie viele Worker eine andere Maschine gleichzeitig trägt, steht in IHRER Einstellungsdatei und wird '
    + 'dort gesetzt: ssh {name} wb-state settings set maxWorkers <zahl>. Zwei Zahlen an zwei Orten für '
    + 'dieselbe Frage wären zwei Wahrheiten, von denen eine falsch ist.',

  'feld.maxWorkers.name': 'Worker gleichzeitig auf dieser Maschine',
  'feld.maxWorkers.wirkung':
    'Mehr als so viele Worker nimmt eine Sitzung nicht an — der nächste Start wird abgelehnt.',
  'feld.maxWorkers.info':
    'Abgelehnt, nicht gestapelt: ein Start, der das Fenster überfüllt, kostet mehr als ein Start, der sagt '
    + '„zu viele". Bestehende Panes werden weiter wiederverwendet, ein fertiger Worker macht also sofort '
    + 'wieder Platz. Gezählt werden Worker-Panes, keine Subagenten. Die Zahl gehört der MASCHINE und nicht '
    + 'der Sitzung: was ein 48-GB-Rechner trägt, trägt ein kleinerer nicht.',
  'feld.maxWorkers.etikett': 'sofort',

  'feld.defaultWorkerMachine.name': 'Wo ein Worker läuft, wenn nichts gesagt wird',
  'feld.defaultWorkerMachine.wirkung':
    'Auf welche Maschine ein Worker geht, wenn beim Start keine genannt wird.',
  'feld.defaultWorkerMachine.info':
    'Die Auswahl kommt aus der Liste darüber: jede dort eingetragene Maschine steht hier zur Wahl. „Diese '
    + 'Maschine" heißt: der Worker läuft im selben Terminal-Server wie die Sitzung. Ein Ziel, das nicht '
    + 'antwortet, lässt den Start scheitern statt ihn umzuleiten — deshalb der Prüfknopf daneben.',
  'feld.defaultWorkerMachine.etikett': 'gilt für den nächsten Worker',
  'wort.dieseMaschine': 'Diese Maschine ({name})',

  'feld.workerZustellung.name': 'Wie ein Auftrag beim Worker ankommt',
  'feld.workerZustellung.wirkung':
    'Über das Postfach der Sitzung, oder in die Eingabezeile des Panes getippt.',
  'feld.workerZustellung.info':
    'Getippt wird der Auftrag Zeichen für Zeichen in das Terminal des Workers – sichtbar, aber '
    + 'anfällig: in der Nacht auf den 20.08. sind fünf Panes dabei eingefroren und Aufträge stumm '
    + 'verschwunden. Claude Code bringt für denselben Zweck ein Postfach mit, das nicht durch die '
    + 'Eingabezeile geht und deshalb nichts überschreiben und nichts blockieren kann. '
    + '„Von selbst" nimmt das Postfach, wo es eines gibt, und tippt sonst; das ist die Vorgabe, '
    + 'weil ein Postfach heute nur Claude Code mitbringt – die übrigen Programme der Registry tippen '
    + 'so oder so, und eine Vorgabe, die für sie nicht gilt, dürfte für sie nichts kaputt machen. '
    + '„Nur Postfach" verlangt es und lässt die Zustellung hörbar scheitern, statt ersatzweise zu '
    + 'tippen: gedacht für Prüfläufe und für den Fall, dass in gar keine Eingabezeile mehr '
    + 'geschrieben werden soll. Für einen Worker auf einem anderen Programm heißt diese Wahl '
    + 'deshalb, dass er gar keinen Auftrag bekommt. „Nur tippen" ist der Rückweg, falls das '
    + 'Postfach an einer künftigen Fassung der CLI scheitert. Ob ein Auftrag angekommen ist, wird '
    + 'auf jedem der drei Wege gleich geprüft und im Klartext gemeldet.',
  'feld.workerZustellung.etikett': 'gilt für den nächsten Auftrag',
  'wort.workerZustellung.auto': 'von selbst',
  'wort.workerZustellung.socket': 'nur Postfach',
  'wort.workerZustellung.paste': 'nur tippen',

  // --- Seite 5: Aufsicht und Meldungen -------------------------------------
  'feld.contextGuardAutostart.name': 'Kontextwache läuft mit',
  'feld.contextGuardAutostart.wirkung':
    'An: das Programm startet die Wache selbst, sobald eine Sitzung steht — niemand muss daran denken.',
  'feld.contextGuardAutostart.info':
    'Bis zum 06.08. startete der Orchestrator seine Wache selbst. Entscheidung des Nutzers, sie dem Programm '
    + 'zu geben: „Wenn jemand ein schwächeres Modell als Orchestrator nimmt, das nicht so zuverlässig ist, '
    + 'soll die Kontextwache ja immer noch zuverlässig sein." Sie hängt damit nicht mehr an der Sorgfalt '
    + 'dessen, den sie überwacht. Aus heißt: es läuft keine Wache, außer jemand startet sie von Hand.',
  'feld.contextGuardAutostart.etikett': 'gilt für die nächste Sitzung',

  'feld.wacheOrchAn.name': 'Das Hauptfenster überwachen',
  'feld.wacheOrchAn.wirkung':
    'An: die Wache sieht auch dem Hauptfenster über die Schulter, nicht nur den Workern.',
  'feld.wacheOrchAn.info':
    'Getrennt schaltbar, weil beide Seiten verschieden teuer sind: ein Orchestrator, der mitten in einer '
    + 'Übergabe kompaktiert wird, verliert den Faden, ein Worker selten. Wer die Aufsicht über sich selbst '
    + 'nicht will, schaltet hier ab und lässt sie für die Worker weiterlaufen. Abschalten verlangt einen '
    + 'Grund und einen Menschen — aus einem Worker-Pane heraus geht es nicht.',
  'feld.wacheOrchAn.etikett': 'gilt für die nächste Wache',

  'feld.wacheWorkerAn.name': 'Die Worker überwachen',
  'feld.wacheWorkerAn.wirkung': 'An: jeder Worker-Pane wird mitgelesen und bei vollem Kontext gemahnt.',
  'feld.wacheWorkerAn.info':
    'Ein Worker, der ohne Übergabe kompaktiert wird, liefert seinen Auftrag halb ab — die Mahnung sorgt '
    + 'dafür, dass er vorher schreibt, was er weiß. Ein Pane, der schmaler ist als die Mindestbreite, lässt '
    + 'sich nicht lesen; die Wache meldet ihn dann ausdrücklich als blind, statt ihn stillschweigend '
    + 'auszulassen. Fertigmeldungen laufen auch dann weiter, wenn die Wache hier aus ist.',
  'feld.wacheWorkerAn.etikett': 'gilt für die nächste Wache',

  'feld.wacheWorkerMahnenAb.name': 'Worker mahnen ab',
  'feld.wacheWorkerMahnenAb.wirkung':
    'Ab diesem Füllstand fordert die Wache einen Worker auf, eine Übergabe zu schreiben und zu kompaktieren.',
  'feld.wacheWorkerMahnenAb.info':
    'Prozent des Kontextfensters seines Modells. Zu früh gemahnt kostet Arbeit, zu spät kostet das Ergebnis: '
    + 'was nach dem Kompaktieren nicht aufgeschrieben ist, ist weg. 80 lässt genug Platz für die Übergabe '
    + 'selbst. Eine HÖHERE Zahl heißt später mahnen, also weniger Sicherung — dafür verlangt das Werkzeug '
    + 'einen Grund.',
  'feld.wacheWorkerMahnenAb.etikett': 'gilt für die nächste Wache',

  'feld.wacheOrchMahnenAb.name': 'Hauptfenster mahnen ab',
  'feld.wacheOrchMahnenAb.wirkung':
    'Ab diesem Füllstand soll der Orchestrator Zustandsdatei und Wissensspeicher nachziehen.',
  'feld.wacheOrchMahnenAb.info':
    'Niedriger als bei den Workern, weil er mehr zu sichern hat: Sitzungsstand, offene Aufträge, das, was '
    + 'in den Vault gehört. Fünf Prozentpunkte Vorsprung sind rund eine Viertelstunde Arbeit.',
  'feld.wacheOrchMahnenAb.etikett': 'gilt für die nächste Wache',

  'feld.wacheOrchEingreifen.name': 'Die Wache greift selbst ein',
  'feld.wacheOrchEingreifen.wirkung':
    'Aus: sie mahnt weiter, tippt aber kein /compact mehr — sie behält die Stimme, nicht die Hand.',
  'feld.wacheOrchEingreifen.info':
    'Die Wache kompaktiert die Orchestrator-Sitzung notfalls selbst, indem sie /compact in ein fremdes '
    + 'Fenster tippt. Wer das nicht will, aber weiter gewarnt werden möchte, schaltet hier ab: die Mahnung '
    + 'bleibt, der Eingriff fällt weg. Das ist die mildere Stufe zwischen „alles" und „Wache aus".',
  'feld.wacheOrchEingreifen.etikett': 'gilt für die nächste Wache',

  'feld.wacheOrchNotbremseAb.name': 'Notbremse ab',
  'feld.wacheOrchNotbremseAb.wirkung':
    'Ab hier kompaktiert die Wache den Orchestrator selbst — auch ohne sein Zeichen.',
  'feld.wacheOrchNotbremseAb.info':
    'Sie tippt /compact in eine fremde Sitzung, nie mitten in einem Zug. Bis zum 06.08. stand diese Zahl '
    + 'fest im Quelltext und war nirgends zu sehen; wer das nicht wusste, hielt das plötzliche Kompaktieren '
    + 'für einen Fehler. Sie greift nur, solange „Die Wache greift selbst ein" an ist.',
  'feld.wacheOrchNotbremseAb.etikett': 'gilt für die nächste Wache',

  'feld.stallMinutes.name': 'Als „hängt" melden nach',
  'feld.stallMinutes.wirkung':
    'So lange darf ein Worker still sein, bevor die Leiste ihn als hängend markiert.',
  'feld.stallMinutes.info':
    'Gemessen an 11.070 Pausen aus 17 Sitzungen, die durchgearbeitet und abgeliefert haben: bei 5 Minuten '
    + 'hätten 8 dieser 17 fälschlich „hängt" getragen, bei 10 Minuten noch 4. Ein Kindprozess, der jünger '
    + 'ist als die Stille, unterdrückt die Meldung ohnehin — ein langer Testlauf zählt also nicht als '
    + 'Stillstand.',
  'feld.stallMinutes.etikett': 'sofort',

  'feld.guardMeldetWorkerStatus.name': 'Die Wache schreibt Worker-Meldungen ins Hauptfenster',
  'feld.guardMeldetWorkerStatus.wirkung':
    'An: die Wache tippt „Worker fertig" und „Worker hängt" selbst in den Orchestrator-Pane.',
  'feld.guardMeldetWorkerStatus.info':
    'Vorgabe aus, und das ist eigene des Nutzers Entscheidung: die Meldung sieht aus wie sein eigenes Wort, '
    + 'sie unterbricht ihn mitten im Satz, und dieselbe Information steht ohnehin in der rechten Leiste. '
    + 'Nicht betroffen ist alles, was nie verstummen darf: die Kontext-Warnung des Hauptfensters, das '
    + 'getippte /compact und alles, was an Worker-Panes geht. Dieser Schalter wird an neun Stellen gelesen '
    + 'und hatte bis zum 11.08. in keiner der beiden Oberflächen ein Feld.',
  'feld.guardMeldetWorkerStatus.etikett': 'gilt für die nächste Wache',

  'satz.guardsWohnenAnderswo':
    'Die Sicherungen, die vor jedem Befehl laufen, stehen auf der Seite „Erlaubnisse" — dort, wo alles '
    + 'steht, was ein Agent darf. Sie ein zweites Mal hier anzubieten hieße, zwei Orte für dieselbe '
    + 'Entscheidung zu haben.',

  'feld.meldungenAn.name': 'Sich außerhalb des Fensters melden',
  'feld.meldungenAn.wirkung':
    'An: das Programm sagt Bescheid, auch wenn du gerade etwas anderes tust. Aus: es schweigt.',
  'feld.meldungenAn.info':
    'Bis zum 11.08. meldete sich das Programm nie nach außen — kein Systemhinweis, kein Ton, nichts aufs '
    + 'Handy. Wer nebenbei etwas anderes tat, merkte erst beim nächsten Hinsehen, dass ein Worker fertig war '
    + 'oder eine Freigabe wartete. Dieser Schalter ist die eine Frage, an der alles hängt; was und wie '
    + 'gemeldet wird, steht darunter. Vorgabe ist aus, weil ein Programm, das ungefragt anfängt zu klingeln, '
    + 'schlechter wäre als eines, das schweigt.',
  'feld.meldungenAn.etikett': 'sofort',

  'feld.meldungenEreignisse.name': 'Worüber gemeldet wird',
  'feld.meldungenEreignisse.wirkung':
    'Nur diese vier Ereignisse können eine Meldung auslösen — jedes einzeln abwählbar.',
  'feld.meldungenEreignisse.info':
    'Vier Ereignisse, und jedes hat einen anderen Grund: ein fertiger Worker heißt, dass Arbeit auf dich '
    + 'wartet; eine wartende Freigabe heißt, dass eine Kette steht, bis du antwortest; eine gestorbene '
    + 'Sitzung heißt, dass etwas abgebrochen ist, das du für laufend hältst; ein fast volles Kontingent '
    + 'heißt, dass die nächste Stunde teuer wird. Wer alles abwählt, bekommt nichts — dann ist der Schalter '
    + 'darüber der ehrlichere Weg.',
  'feld.meldungenEreignisse.etikett': 'sofort',

  'feld.meldungenWege.name': 'Auf welchem Weg',
  'feld.meldungenWege.wirkung':
    'Systemhinweis, Ton, Handy — einzeln oder zusammen. Der Weg bestimmt, wie aufdringlich es ist.',
  'feld.meldungenWege.info':
    'Ein Systemhinweis ist leise und bleibt in der Mitteilungszentrale liegen; ein Ton holt dich sofort, '
    + 'auch wenn der Bildschirm aus ist; das Handy erreicht dich außer Haus. E-Mail steht bewusst nicht zur '
    + 'Wahl: eine Mail zu senden ist eine außenwirksame Handlung mit eigener Freigaberegel, und ein Haken im '
    + 'Menü wäre der stille Weg daran vorbei.',
  'feld.meldungenWege.etikett': 'sofort',

  'feld.meldungenHandyUrl.name': 'Adresse für das Handy',
  'feld.meldungenHandyUrl.wirkung':
    'Der Webhook, an den eine Meldung geschickt wird. Leer heißt: kein Weg aufs Handy.',
  'feld.meldungenHandyUrl.info':
    'Ein Webhook ist eine Adresse, die ein Dienst dir gibt und die eine Nachricht auf dein Telefon bringt. '
    + 'Welchen Dienst du nimmst, entscheidest du — das Programm kennt nur die Adresse und schickt einen Text '
    + 'dorthin. Diese Adresse verlässt den Rechner bei jeder Meldung, und was sie enthält, entscheidet der '
    + 'Dienst dahinter: trag hier nichts ein, dem du das nicht zutraust.',
  'feld.meldungenHandyUrl.etikett': 'sofort',

  'feld.meldungenTonDatei.name': 'Eigener Ton',
  'feld.meldungenTonDatei.wirkung':
    'Der Pfad zu einer Klangdatei. Leer heißt: der Ton des Betriebssystems.',
  'feld.meldungenTonDatei.info':
    'Ein eigener Ton ist mehr als Geschmack: wer mehrere Programme laufen hat, erkennt an einem eigenen '
    + 'Klang, dass die Meldung von hier kommt, ohne hinzusehen. Leer ist die sichere Wahl — der Systemton '
    + 'existiert immer, eine Datei kann verschwinden.',
  'feld.meldungenTonDatei.etikett': 'sofort',

  'feld.meldungenLimitSchwelle.name': 'Ab wann das Kontingent als fast voll gilt',
  'feld.meldungenLimitSchwelle.wirkung':
    'Ab diesem Anteil des Kontingents meldet sich das Programm — sofern das Ereignis oben angehakt ist.',
  'feld.meldungenLimitSchwelle.info':
    'Prozent des Kontingents im laufenden Zeitfenster. Zu früh gewarnt heißt: man gewöhnt sich daran und '
    + 'übersieht die Meldung, die zählt. Zu spät heißt: die Warnung kommt, wenn nichts mehr zu retten ist. '
    + '85 lässt genug Raum, eine laufende Arbeit noch geordnet zu Ende zu bringen.',
  'feld.meldungenLimitSchwelle.etikett': 'sofort',

  'feld.meldungTesten.name': 'Test senden',
  'feld.meldungTesten.wirkung':
    'Schickt eine Probemeldung über genau die Wege, die oben gewählt sind, und zeigt darunter, was je Weg '
    + 'passiert ist.',
  'feld.meldungTesten.info':
    'Der Knopf sendet EINE echte Probemeldung — Systemhinweis, Ton, Webhook, je nachdem, was oben angehakt '
    + 'ist — und meldet danach je Weg, ob es geklappt hat: beim Webhook den HTTP-Status, sonst den Grund, '
    + 'warum nicht. Steht der Hauptschalter aus, sagt der Knopf das und sendet nichts.',
  'knopf.meldungTesten': 'Test senden',
  'meldungTesten.hauptschalterAus': 'Der Hauptschalter oben ist aus — es wurde nichts gesendet.',
  'meldungTesten.keinWeg': 'Kein Weg ist ausgewählt — es wurde nichts gesendet.',
  'meldungTesten.laeuft': 'Probe wird gesendet …',
  'meldungTesten.system.ok': 'Systemhinweis: abgesetzt',
  'meldungTesten.system.fehler': 'Systemhinweis: fehlgeschlagen — {grund}',
  'meldungTesten.ton.ok': 'Ton: abgespielt',
  'meldungTesten.ton.fehler': 'Ton: fehlgeschlagen — {grund}',
  'meldungTesten.handy.ok': 'Handy: Webhook antwortete mit HTTP {status}',
  'meldungTesten.handy.fehler': 'Handy: fehlgeschlagen — {grund}',
  'meldung.workerFertig': 'Ein Worker ist fertig',
  'meldung.freigabeWartet': 'Eine Freigabe wartet auf dich',
  'meldung.sitzungTot': 'Eine Sitzung ist gestorben',
  'meldung.limitFastVoll': 'Das Kontingent ist fast voll',
  'weg.system': 'Systemhinweis',
  'weg.ton': 'Ton',
  'weg.handy': 'Handy',
  'platzhalter.handyUrl': 'https://…  (leer = kein Weg aufs Handy)',
  'platzhalter.tonDatei': '~/Musik/melden.aiff  (leer = Systemton)',

  // --- Seite 6: Aussehen ---------------------------------------------------
  'feld.thema.name': 'Hell oder dunkel',
  'feld.thema.wirkung':
    'Ob das Programm hell, dunkel oder so aussieht, wie das Betriebssystem gerade eingestellt ist.',
  'feld.thema.info':
    '„Wie das System" folgt der Umstellung des Betriebssystems, auch mitten in der Arbeit. Die '
    + 'Terminal-Panes selbst folgen nicht: ihre Farben kommen aus tmux und der jeweiligen CLI, und eine '
    + 'zweite Stelle dafür hätte zwei Wahrheiten. Heute richtet sich dieses Fenster danach; die übrigen '
    + 'Fenster ziehen nach, sobald ihre Farben aus derselben Quelle kommen.',
  'feld.thema.etikett': 'sofort',
  'wort.thema.system': 'wie das System',
  'wort.thema.hell': 'hell',
  'wort.thema.dunkel': 'dunkel',

  'feld.zustandsfarben.name': 'Die Farben der Sitzungszustände',
  'feld.zustandsfarben.wirkung':
    'Woran du in der Leiste erkennst, ob eine Sitzung arbeitet, wartet, fertig ist oder nicht mehr läuft.',
  'feld.zustandsfarben.info':
    'Vier Zustände, vier Farben, und sie müssen sich für dich unterscheiden — nicht für einen Katalog. Wer '
    + 'Rot und Grün schlecht auseinanderhält, stellt hier zwei Farben ein, die er sieht. Zurück auf die '
    + 'Auslieferung geht über das Zeichen neben der Überschrift.',
  'feld.zustandsfarben.etikett': 'sofort',
  'zustand.laeuft': 'arbeitet',
  'zustand.wartet': 'wartet auf dich',
  'zustand.fertig': 'fertig',
  'zustand.tot': 'läuft nicht mehr',

  'feld.terminalFontSize.name': 'Schriftgröße im Terminal',
  'feld.terminalFontSize.wirkung':
    'Wie groß die Schrift in allen Terminal-Panes steht. Die Änderung ist sofort zu sehen.',
  'feld.terminalFontSize.info':
    'Sie entscheidet mit, wie viele Spalten und Zeilen in ein Pane passen: größere Schrift heißt weniger '
    + 'Spalten auf derselben Fläche. Unter 80 Spalten kann die Kontextwache die Statuszeile eines Workers '
    + 'nicht mehr sicher lesen — wer die Schrift stark vergrößert, bekommt deshalb eher einen zweiten '
    + 'Worker-Tab als schmalere Panes. Erlaubt sind 8 bis 32; ein Wert außerhalb wird abgelehnt und der '
    + 'alte bleibt stehen.',
  'feld.terminalFontSize.etikett': 'sofort',

  'feld.terminalScrollLines.name': 'Zeilen je Rad-Rasterung',
  'feld.terminalScrollLines.wirkung':
    'Wie weit ein Rasterschritt des Mausrads rollt — im Rückblick des Fensters und in der Anwendung im '
    + 'Pane gleich.',
  'feld.terminalScrollLines.info':
    'Bis zum 06.08. fiel diese Zahl aus der Zellhöhe: der zurückgelegte Weg eines Rad-Ereignisses wurde '
    + 'durch die Höhe einer Zeile geteilt. Das hing am Gerät (ein Trackpad schickt viele kleine Ereignisse, '
    + 'eine Maus wenige große) und an der Schriftgröße und wurde deshalb als „viel zu schnell" gemeldet. '
    + 'Jetzt zählt nur diese Zahl: eine Rasterung bewegt so viele Zeilen. Ein Trackpad-Wisch sammelt seine '
    + 'Bruchteile auf, und ein einzelnes Ereignis bewegt nie mehr als sechs Zeilen. Erlaubt sind 1 bis 20.',
  'feld.terminalScrollLines.etikett': 'sofort',

  'feld.minWorkerPaneWidth.name': 'Schmalster Worker-Pane',
  'feld.minWorkerPaneWidth.wirkung':
    'So schmal darf ein Worker-Pane werden. Darunter legt das Fenster lieber einen zweiten Tab an.',
  'feld.minWorkerPaneWidth.info':
    'Gemessen am 04.08.: bei 60 Spalten fiel die Statuszeile einer echten Claude-CLI auf den bloßen Balken '
    + 'zurück oder schlechter; 80 ist die bestätigte Untergrenze, bei der sie mit einem realistischen Pfad '
    + 'noch genau zu lesen ist. Darunter meldet die Kontextwache den Pane als blind und überwacht ihn nicht '
    + '— ein schmalerer Wert bringt also keine dichtere Ansicht, sondern blinde Wachen. Erlaubt sind 20 bis '
    + '1000.',
  'feld.minWorkerPaneWidth.etikett': 'sofort',

  'feld.maxWorkerPanesPerTab.name': 'Worker je Tab',
  'feld.maxWorkerPanesPerTab.wirkung':
    'Ab dieser Zahl legt das Fenster einen weiteren Worker-Tab an, statt die Panes weiter zu verkleinern.',
  'feld.maxWorkerPanesPerTab.info':
    'Gemessen am 04.08.: auf dem Bezugsfenster (197 × 54) passen zwei Spalten à 80 Spalten neben drei '
    + 'Reihen lesbarer Höhe — also 6. Unter 80 Spalten kann die Kontextwache die Statuszeile nicht mehr '
    + 'sicher lesen und meldet den Pane als blind. 0 heißt: keine eigene Obergrenze; wie viele wirklich '
    + 'nebeneinander passen, rechnet das Fenster ohnehin aus seiner Größe und der Mindestbreite darüber.',
  'feld.maxWorkerPanesPerTab.etikett': 'beim nächsten Neuanordnen',

  'feld.workerLayout.name': 'Wo die Worker-Panes sitzen',
  'feld.workerLayout.wirkung':
    'Unter dem Hauptfenster geteilt, oder in einem eigenen Fenster daneben.',
  'feld.workerLayout.info':
    'Geteilt heißt: die Worker liegen als Panes unter dem Orchestrator, alles in einem Blick, jeder Pane '
    + 'schmaler. Eigenes Fenster heißt: die Worker bekommen ihr eigenes Fenster, das man auf einen zweiten '
    + 'Bildschirm schieben kann. Das ist eine Frage des Bildschirms und keine des Modells. Diese Einstellung '
    + 'war bis zum 11.08. nur in der VS-Code-Erweiterung erreichbar, obwohl vier Werkzeuge sie lesen.',
  'feld.workerLayout.etikett': 'beim nächsten Neuanordnen',
  'wort.workerLayout.split': 'geteilt unter dem Hauptfenster',
  'wort.workerLayout.window': 'eigenes Fenster',

  'feld.sprache.name': 'Sprache der Oberfläche',
  'feld.sprache.wirkung': 'In welcher Sprache die Beschriftungen dieses Programms stehen.',
  'feld.sprache.info':
    'Alle Beschriftungen dieses Fensters kommen seit dem 11.08. aus EINER Tabelle und nicht mehr aus dem '
    + 'Quelltext — das ist die Voraussetzung dafür, dass eine zweite Sprache eine zweite Tabelle ist und '
    + 'kein Durchgang durch zweitausend Zeilen. Englisch ist die Auslieferungssprache; Deutsch bleibt '
    + 'vollständig gepflegt daneben.',
  'feld.sprache.etikett': 'sofort',
  'wort.sprache.de': 'Deutsch',
  'wort.sprache.en': 'English',
  'satz.spracheNochNichtDa':
    'Für diese Sprache liegt noch keine Tabelle vor. Solange die zweite Tabelle fehlt, bleibt die '
    + 'Oberfläche englisch — halb übersetzt wäre schlechter als gar nicht.',

  'feld.chatAnsichtVorgabe.name': 'Neue Sitzungen zeigen das Gespräch',
  'feld.chatAnsichtVorgabe.wirkung':
    'An: neue Panes starten in der Chat-Ansicht, wo ihr Programm das kann — getrennt für den '
    + 'Orchestrator und für seine Worker.',
  'feld.chatAnsichtVorgabe.info':
    'Das ist die Vorgabe je Rolle und keine Aussage darüber, was ein Programm kann — das steht je '
    + 'Programm auf der Seite „Programme und Modelle". Ein Programm ohne Weg zum Gesprächsverlauf bleibt '
    + 'beim Terminalbild, ganz gleich, was hier steht. Für eine einzelne Sitzung schlägt der Rechtsklick '
    + 'auf sie diese Vorgabe: er stellt ihren Orchestrator sofort um, und zwar nur ihn. Die Worker folgen '
    + 'weiter dem, was hier steht.',
  'feld.chatAnsichtVorgabe.etikett': 'gilt für die nächste Sitzung',
  'wort.rolle.orchestrator': 'Orchestrator',
  'wort.rolle.worker': 'Worker',

  // --- Seite 7: Programm ---------------------------------------------------
  'feld.pfade.name': 'Dateien dieses Programms',
  'feld.pfade.wirkung':
    'Wo die beiden Konfigurationsdateien, die Registry und der Oberflächen-Zustand liegen.',
  'feld.pfade.info':
    'Zwei Dateien, getrennt nach Zuständigkeit: was Programm und Werkzeuge GEMEINSAM meinen, steht in den '
    + 'Einstellungen (~/.claude/workbench/settings.json) — dort sitzt die Sperre, und geschrieben wird nur '
    + 'über wb-state, das jede Änderung mit Urheber protokolliert. Was nur dieses Programm zum Hochfahren '
    + 'braucht (Pfade, Socket, Maschinenkennung), steht in der Programm-Konfiguration. Kein Schlüssel steht '
    + 'in beiden. Die Pfade sind aus der Konfiguration dieses Laufs gelesen, nicht fest verdrahtet. Welche '
    + 'Protokolle die Protokoll-Ansicht zeigt, ist bewusst nur über die Befehlszeile zu ändern: '
    + 'wb-state settings set logPaths \'[{"label":"…","path":"…"}]\'.',

  'feld.erststartZeigen.name': 'Geführter erster Start',
  'feld.erststartZeigen.wirkung':
    'Öffnet dasselbe Fenster, das beim allerersten Start dieser Werkbank von selbst erscheint.',
  'feld.erststartZeigen.info':
    'Derselbe Ablauf wie beim ersten Start, nur von Hand aufgerufen — zum Nachlesen, oder um ihn einem '
    + 'zweiten Menschen an diesem Rechner zu zeigen. Der Knopf setzt nichts zurück: dass der erste Start '
    + 'schon einmal gelaufen ist, bleibt vermerkt, und beim nächsten eigentlichen Programmstart erscheint '
    + 'das Fenster deshalb weiterhin nicht von selbst.',
  'feld.erststartZeigen.etikett': 'sofort',

  'feld.abweichungen.name': 'Abweichungen von der Auslieferung',
  'feld.abweichungen.wirkung':
    'Alles, was du verstellt hast, in einer Liste — mit dem Weg zurück.',
  'feld.abweichungen.info':
    'Für ein Programm, das weitergegeben werden soll, ist das die einzige ehrliche Antwort auf die Frage, '
    + 'warum es bei zwei Leuten verschieden läuft. Verglichen wird gegen die mitgelieferte Vorgabe, nicht '
    + 'gegen den Stand von gestern. Ein Wert, der nie angefasst wurde, steht hier nicht — auch dann nicht, '
    + 'wenn er zufällig gleich aussieht.',
  'feld.abweichungen.etikett': 'sofort',
  'satz.keineAbweichung': 'Nichts — alles steht so, wie es ausgeliefert wurde.',

  'feld.sicherung.name': 'Sichern, zurücksetzen, übertragen',
  'feld.sicherung.wirkung':
    'Der ganze Stand als Text: kopieren und wegheben, hier wieder einsetzen, oder alles auf die '
    + 'Auslieferung stellen.',
  'feld.sicherung.info':
    'Bis zum 11.08. ließ sich nur jeder Schlüssel einzeln zurückstellen; vor einem größeren Umbau gab es '
    + 'keinen Weg, den vorherigen Stand zu sichern. Der Text unten ist genau das, was von der Auslieferung '
    + 'abweicht — nicht die ganze Datei, denn Vorgaben zu sichern hieße, sie beim Einsetzen auf einem '
    + 'anderen Rechner festzuschreiben. Eingesetzt wird Schlüssel für Schlüssel über denselben Schreibweg '
    + 'wie jeder Haken; was das Werkzeug ablehnt, wird nicht gespeichert und steht danach in der Fußzeile.',
  'feld.sicherung.etikett': 'sofort',
  'wort.kopieren': 'in die Zwischenablage',
  'wort.einsetzen': 'einsetzen',
  'wort.allesZurueck': 'alles auf Auslieferung',
  'satz.sicherungKopiert': 'Der Stand liegt in der Zwischenablage ({zeichen} Zeichen).',
  'satz.sicherungKeinText': 'Es steht nichts im Feld — nichts einzusetzen.',
  'satz.sicherungKeinJson':
    'Das ist kein JSON-Objekt. Erwartet wird genau das, was der Knopf darüber liefert.',
  'satz.sicherungEingesetzt': '{anzahl} Einstellungen eingesetzt.',
  'satz.sicherungLeer': 'Nichts weicht ab — es gibt nichts zu sichern.',

  // --- Bedienung, quer über alle Seiten ------------------------------------
  'wort.hinzufuegen': 'Hinzufügen',
  'wort.entfernen': 'entfernen',
  'wort.pruefen': 'prüfen',
  'wort.zuruecksetzen': 'zurücksetzen',
  'wort.speichern': 'speichern',
  'wort.erneutZeigen': 'erneut zeigen',
  'wort.frage': 'frage …',
  'wort.erreichbar': 'erreichbar',
  'wort.nichtErreichbar': 'nicht erreichbar: {grund}',
  'wort.an': 'an',
  'wort.aus': 'aus',
  'wort.einEintrag': '1 Eintrag',
  'wort.mehrereEintraege': '{anzahl} Einträge',
  'wort.leereListe': 'leere Liste',
  'wort.nichtsGesetzt': 'nichts gesetzt',
  'wort.alleModelle': 'Alle {anzahl}',
  'wort.leerListe': 'leer — es wird nichts ausgelassen',
  'platzhalter.modellsuche': 'zusätzlich nach Name oder Kennung filtern …',
  'platzhalter.suche': 'nach Name oder Kennung filtern …',
  'platzhalter.maschine': 'SSH-Alias, z. B. peer',
  'platzhalter.musterBefehl': 'Befehl, z. B. rsync',
  'platzhalter.musterUnterbefehl': 'Unterbefehl (darf leer bleiben)',
  'platzhalter.musterGrund': 'Warum gefragt wird',
  'platzhalter.ordner': 'Ordnername',
  'platzhalter.dateimuster': 'Dateimuster',
  'platzhalter.startordner': '~/AI',
  'platzhalter.ollama': 'http://127.0.0.1:11434',
  'platzhalter.sicherung': 'Hier einen gesicherten Stand einsetzen …',
  'platzhalter.schluesselEingabe': 'Wert einfügen …',
  'satz.schluesselLeer': 'Kein Wert eingegeben — nichts gespeichert.',
  'satz.schluesselGespeichert': 'Für {anbieter} abgelegt.',
  'satz.schluesselFehler': 'Fehler beim Ablegen.',
  'satz.keinTreffer': 'Kein Modell passt auf Filter und Suche.',
  'satz.keinTrefferSuche': 'Kein Modell passt auf die Suche.',
  'satz.zuVieleTreffer':
    '{anzahl} Modelle passen — gezeigt werden die ersten 60. Such nach Name oder Kennung.',
  'satz.keineMuster': 'Keine Muster — es wird bei keinem Befehl zurückgefragt.',
  'satz.keineGuards':
    'Die Liste der Sicherungen ist nicht zu lesen — wb-state antwortet nicht. Solange gilt: alle laufen.',
  'satz.abgeschaltet': 'Abgeschaltet',
  'satz.abgeschaltetFuer': 'Abgeschaltet für {rolle}',
  'satz.seit': ' seit {datum}',
  'satz.stehtAufVorgabe': 'Steht auf der Vorgabe aus der Auslieferung.',
  'satz.zurueckAufVorgabe': 'Zurück auf die Vorgabe: {wert}',
  'satz.infoTitel': 'Was macht „{feld}"?',
  'satz.musterOhneBefehl':
    'Ein Muster ohne Befehlsnamen wäre eine Textsuche über die ganze Zeile — es wird nicht angelegt.',
  'satz.musterVonHand': 'Von Hand eingetragen.',
  'satz.schreibe': 'schreibe {schluessel} …',
  'satz.oberflaeche': 'Oberfläche: {schluessel} = {wert}',
  'satz.fehler': 'FEHLER: {aufruf} — {ausgabe}',
  'satz.ohneGrundNichts':
    'Ohne Grund wird nichts geändert — schreib in einem Satz, warum.',

  // --- Rückfragen ----------------------------------------------------------
  'frage.wacheAus.text':
    'Die Kontextwache wird nicht mehr von selbst gestartet. Danach läuft eine Sitzung ohne Aufsicht über '
    + 'ihren Kontext: niemand mahnt vor dem Volllaufen, niemand kompaktiert, und eine Übergabe entsteht nur, '
    + 'wenn jemand von Hand daran denkt.',
  'frage.wacheAus.tun': 'Wache abschalten',
  'frage.wacheOrchAus.text':
    'Die Kontextwache lässt den Orchestrator danach in Ruhe: keine Mahnung, keine Notbremse, kein /compact '
    + '— auch nicht kurz vor dem Überlauf. Für die Worker läuft sie weiter.',
  'frage.wacheOrchAus.tun': 'Für das Hauptfenster abschalten',
  'frage.wacheWorkerAus.text':
    'Kein Worker wird danach mehr gemahnt oder kompaktiert. Ein volllaufender Worker verliert dann still, '
    + 'was er nicht aufgeschrieben hat.',
  'frage.wacheWorkerAus.tun': 'Für Worker abschalten',
  'frage.mahnenHoch.worker':
    'Später mahnen heißt weniger Vorlauf: ab {wert} % bleibt einem Worker weniger Platz, seine Übergabe '
    + 'noch zu schreiben, bevor kompaktiert wird.',
  'frage.mahnenHoch.orch':
    'Ab {wert} % wird der Orchestrator erst später gemahnt — er hat dann weniger Platz, Zustand und Wissen '
    + 'zu sichern, bevor kompaktiert wird.',
  'frage.mahnenHoch.tun': 'Schwelle anheben',
  'frage.eingreifenAus.text':
    'Die Wache mahnt danach weiter, greift aber nicht mehr ein: sie tippt kein /compact, auch nicht an der '
    + 'Notbremse. Wer die Mahnung übersieht, läuft in den vollen Kontext.',
  'frage.eingreifenAus.tun': 'Eingreifen abschalten',
  'frage.notbremseHoch.text':
    'Die Notbremse greift erst ab {wert} %. Je höher sie steht, desto näher am Überlauf wird kompaktiert.',
  'frage.notbremseHoch.tun': 'Notbremse anheben',
  'frage.guardAus.text':
    '„{name}" greift danach nicht mehr. {wirkung} Was diese Sicherung bisher angehalten hat, läuft ab '
    + 'sofort ohne Frage durch — die übrigen bleiben davon unberührt.',
  'frage.guardAus.tun': 'Sicherung abschalten',
  'frage.musterAus.text':
    '„{name}" löst danach keine Rückfrage mehr aus. {grund} Der Befehl läuft ab sofort ohne Nachfrage '
    + 'durch, sofern kein Guard ihn ohnehin hart ablehnt.',
  'frage.musterAus.tun': 'Muster abschalten',
  'frage.musterWeg.text':
    'Das Muster „{name}" wird aus der Liste gelöscht. Danach sieht man nicht mehr, dass es es gab — wer es '
    + 'nur vorübergehend loswerden will, schaltet es stattdessen ab.',
  'frage.musterWeg.tun': 'Muster löschen',
  'frage.skipAn.text':
    'Jeder neue Worker startet danach mit unterdrückter Berechtigungsabfrage seiner CLI: er schreibt '
    + 'Dateien, ohne zu fragen. Die Sicherungen und die Rückfrage-Stufe bleiben davon unberührt, die '
    + 'Abfrage der CLI nicht.',
  'frage.skipAn.tun': 'Rückfragen unterdrücken',
  'frage.permissionModeAn.text':
    'Die CLI der nächsten Orchestrator-Sitzung hält danach bei nichts mehr an -- kein Bearbeiten, kein '
    + 'Ausführen, keine Rückfrage. Das ist die stärkste der sechs Stufen und braucht deshalb einen Grund.',
  'frage.permissionModeAn.tun': 'Auf bypassPermissions anheben',
  'frage.listeLeer.text':
    'Die Liste ist danach leer: {was} werden nirgends mehr ausgelassen. Dateibaum, Schnellöffner, '
    + 'Inhaltssuche und Editor zeigen dann auch das, was hier bisher fehlte.',
  'frage.listeLeer.tun': 'Liste leeren',
  'frage.deckel.text':
    'Der Deckel von „{modell}" steht danach auf {stufe}. Er gilt für Worker, die der Orchestrator ohne '
    + 'Rückfrage startet — deine eigene Wahl bleibt frei. Ein Deckel ohne Grund liest sich in einem halben '
    + 'Jahr wie eine technische Grenze, deshalb gehört einer dazu.',
  'frage.deckel.tun': 'Deckel setzen',
  'frage.allesZurueck.text':
    'Jede der {anzahl} Abweichungen wird auf die Auslieferung zurückgestellt — auch abgeschaltete '
    + 'Sicherungen, gelockerte Wachen und gesetzte Deckel. Sicher den Stand vorher, wenn du ihn '
    + 'wiederhaben willst.',
  'frage.allesZurueck.tun': 'Alles zurücksetzen',
  'frage.einsetzen.text':
    '{anzahl} Einstellungen werden aus dem Text übernommen und überschreiben, was jetzt gilt. Was das '
    + 'Werkzeug ablehnt, bleibt stehen.',
  'frage.einsetzen.tun': 'Einsetzen',

  // --- Die Namen in „was bei dir anders ist" --------------------------------
  // 30 der 37 Namen hier sind wortgleich mit dem `name` des zugehoerigen
  // Feldes (`feld.<schluessel>.name`) -- test-app-bezeichnung-paritaet.sh
  // haelt das zusammen, nicht bloss dieser Kommentar. Zwei weichen ABSICHTLICH
  // ab, weil die Abweichungsliste einen ZUSTAND meldet und die Seite ein
  // BEDIENELEMENT beschriftet:
  //   effortCaps  Feld „Höchste Stufe ohne Rückfrage", hier „Gesetzte Effort-Deckel"
  //   guards      Feld „Welche Sicherungen mitlaufen", hier „Abgeschaltete Sicherungen"
  // Fuenf haben KEIN Gegenstueck (kein `feld.<schluessel>.name`), weil der
  // Einstellungsschluessel nicht auf genau ein Feld abbildet: workerEffort und
  // workerModel stehen nicht im Menü (siehe deren eigene Zeile, „nicht im
  // Menü"), logPaths und meldungen zerfallen auf der Seite in mehrere
  // Einzelfelder statt eines, kontextwache zeigt sich nicht als Feld, sondern
  // ueber `wb-state guard|wache`.
  // Zwei Zaehlerstaende sind hier nachgetragen, nicht neu erfunden: der
  // Kommentar stand bis zum 20.08. auf 28 von 35 und hatte
  // orchestratorPermissionMode (16.08.) nie mitgezaehlt; die Suite fuehrte
  // laengst 29 von 36. Dazu kommt jetzt workerZustellung (20.08.) -- macht
  // 30 von 37. Die zwei angemeldeten Abweichungen und die fuenf Schluessel
  // ohne Gegenstueck sind unveraendert.
  'bezeichnung.closeSessionOnWindowClose': 'Terminal mit dem Fenster beenden',
  'bezeichnung.orchestratorHarness': 'Programm im Hauptfenster',
  'bezeichnung.orchestratorModel': 'Modell der Sitzung',
  'bezeichnung.orchestratorEffort': 'Wie tief die Sitzung denkt',
  'bezeichnung.workerEffort': 'Denkstufe eines Workers ohne eigene Angabe (nicht im Menü)',
  'bezeichnung.workerModel': 'Modell eines Workers ohne eigene Angabe (nicht im Menü)',
  'bezeichnung.workerLayout': 'Wo die Worker-Panes sitzen',
  'bezeichnung.newSessionDefaultDir': 'Ordner, in dem eine neue Sitzung anfängt',
  'bezeichnung.modelDiscoveryAuto': 'Modell-Kataloge von selbst abrufen',
  'bezeichnung.maxWorkers': 'Worker gleichzeitig auf dieser Maschine',
  'bezeichnung.workerWorktrees': 'Jeder Worker bekommt einen eigenen Arbeitsbaum',
  'bezeichnung.defaultWorkerMachine': 'Wo ein Worker läuft, wenn nichts gesagt wird',
  'bezeichnung.workerZustellung': 'Wie ein Auftrag beim Worker ankommt',
  'bezeichnung.maxWorkerPanesPerTab': 'Worker je Tab',
  'bezeichnung.minWorkerPaneWidth': 'Schmalster Worker-Pane',
  'bezeichnung.contextGuardAutostart': 'Kontextwache läuft mit',
  'bezeichnung.guardMeldetWorkerStatus': 'Die Wache schreibt Worker-Meldungen ins Hauptfenster',
  'bezeichnung.stallMinutes': 'Als „hängt" melden nach',
  'bezeichnung.workerSkipPermissions': 'Worker arbeiten ohne Rückfrage ihrer CLI',
  'bezeichnung.orchestratorPermissionMode': 'Wie viel der Orchestrator ohne Rückfrage tun darf',
  'bezeichnung.askPatterns': 'Befehle, bei denen zurückgefragt wird',
  'bezeichnung.secretExcludeDirs': 'Ordner, die keine Ansicht betritt',
  'bezeichnung.secretExcludePatterns': 'Dateinamen, die keine Ansicht zeigt',
  'bezeichnung.terminalFontSize': 'Schriftgröße im Terminal',
  'bezeichnung.terminalScrollLines': 'Zeilen je Rad-Rasterung',
  'bezeichnung.logPaths': 'Protokoll-Pfade (nur Anzeige)',
  'bezeichnung.effortCaps': 'Gesetzte Effort-Deckel',
  'bezeichnung.guards': 'Abgeschaltete Sicherungen',
  'bezeichnung.kontextwache': 'Verstellte Kontextwache',
  'bezeichnung.remoteMachines': 'Rechner, die mitarbeiten',
  'bezeichnung.ollamaEndpoint': 'Adresse des lokalen Modell-Servers',
  'bezeichnung.meldungen': 'Worüber du außerhalb des Fensters Bescheid bekommst',
  'bezeichnung.sprache': 'Sprache der Oberfläche',
  'bezeichnung.thema': 'Hell oder dunkel',
  'bezeichnung.zustandsfarben': 'Die Farben der Sitzungszustände',
  'bezeichnung.chatAnsicht': 'Gespräch statt Terminal anzeigen',
  'bezeichnung.chatAnsichtVorgabe': 'Neue Sitzungen zeigen das Gespräch',
};

/**
 * ENGLISH, the shipped default since 11.08. (SPEC-V4 section 4: English as the
 * default, German kept alongside).
 *
 * Same order as DE, same keys -- test-app-einstellungen.sh and the parity
 * test both walk both tables and fail on a mismatch in either direction.
 * This is interface copy, not prose: short, in the phrasing English apps use,
 * not a literal carry-over from the German. Commands, paths, filenames,
 * setting keys and error strings stay verbatim -- 'wb-state settings set' is
 * never translated, and neither is a Workbench proper noun.
 */
export const EN: Record<string, string> = {
  'fenster.titel': 'Agent Workbench — Settings',
  // --- The seven pages ---------------------------------------------------
  'seite.sitzung.titel': 'Session',
  'seite.sitzung.wofuer': 'What a new session starts with',
  'seite.sitzung.unterzeile':
    'What a new session starts with, where it starts working, and how its bar behaves. '
    + 'Workers are not set here: the orchestrator sets those up for you.',

  'seite.erlaubnisse.titel': 'Permissions',
  'seite.erlaubnisse.wofuer': 'What agents are allowed to do',
  'seite.erlaubnisse.unterzeile':
    'What an agent may do without asking, and where it gets stopped. Every row here removes '
    + 'a safeguard or adds one; each carries a mark that explains why.',

  'seite.harnesses.titel': 'Programs and models',
  'seite.harnesses.wofuer': 'Sign in, connect, cap',
  'seite.harnesses.unterzeile':
    'Which agent programs run on this machine, whether they are signed in, how the local '
    + 'models are reached, and how far the orchestrator may go without asking.',

  'seite.maschinen.titel': 'Machines',
  'seite.maschinen.wofuer': 'Machines and load',
  'seite.maschinen.unterzeile':
    'Which machines are in this list, how the program reaches them, and how much work '
    + 'each of them may carry at once.',

  'seite.aufsicht.titel': 'Oversight and notifications',
  'seite.aufsicht.wofuer': 'Guard, stall, notices',
  'seite.aufsicht.unterzeile':
    'What the program watches on its own, when it steps in, and what it tells you '
    + 'outside the window.',

  'seite.aussehen.titel': 'Appearance',
  'seite.aussehen.wofuer': 'Colors, font, language',
  'seite.aussehen.unterzeile':
    'How the program looks and how much fits on the screen. None of this changes what '
    + 'the agents do.',

  'seite.programm.titel': 'Program',
  'seite.programm.wofuer': 'Files, deviations, backup',
  'seite.programm.unterzeile':
    'Where this program\'s files live, what differs from the shipped defaults on your '
    + 'machine, and how you back up, reset, or carry the whole state to another machine.',

  // --- Group headings ------------------------------------------------------
  'gruppe.sitzung.start': 'What a new session starts with',
  'gruppe.sitzung.leiste': 'The session bar',
  'gruppe.sitzung.schliessen': 'On closing the window',
  'gruppe.erlaubnisse.vorsicht': 'Working without asking',
  'gruppe.erlaubnisse.guards': 'Safeguards before every command',
  'gruppe.erlaubnisse.rueckfragen': 'Commands that ask first',
  'gruppe.erlaubnisse.geheimnisse': 'What is never read',
  'gruppe.erlaubnisse.werkzeuge': 'Tools and MCP servers',
  'gruppe.harnesses.programme': 'The programs on this machine',
  'gruppe.harnesses.lokal': 'Local models',
  'gruppe.harnesses.schluessel': 'Access to the providers',
  'gruppe.harnesses.deckel': 'How far the orchestrator may go without asking',
  'gruppe.maschinen.liste': 'Machines in this list',
  'gruppe.maschinen.last': 'How much this machine carries',
  'gruppe.aufsicht.wache': 'The context guard',
  'gruppe.aufsicht.stillstand': 'Stall',
  'gruppe.aufsicht.meldungen': 'Notifications',
  'gruppe.aussehen.thema': 'Light and dark',
  'gruppe.aussehen.terminal': 'Font and scrolling',
  'gruppe.aussehen.panes': 'How workers sit in the window',
  'gruppe.aussehen.sprache': 'Language and view',
  'gruppe.programm.dateien': 'What lives where',
  'gruppe.programm.abweichungen': 'What differs on your machine',
  'gruppe.programm.sicherung': 'Back up, reset, transfer',
  'gruppe.programm.erststart': 'The guided first start',

  // --- Page 1: Session -------------------------------------------------
  'feld.orchestratorHarness.name': 'Program in the main window',
  'feld.orchestratorHarness.wirkung':
    'Which agent CLI the orchestrator pane starts. The number next to it names the models that fit.',
  'feld.orchestratorHarness.info':
    'Every registered adapter is on offer, not just Claude Code and pi. "missing here" means: this '
    + 'adapter\'s program does not exist on {maschine}, and starting it would run into nothing. What is '
    + 'checked is exactly what wb-state checks before a start: the binary on the path.',
  'feld.orchestratorHarness.etikett': 'takes effect on the next session',

  'feld.orchestratorModel.name': 'Model of the session',
  'feld.orchestratorModel.wirkung':
    'What the orchestrator thinks with, as long as nothing else is said at start.',
  'feld.orchestratorModel.info':
    '{anzahl} models carrying the "orchestrator" role for this program. The id on the right is the same '
    + 'one the tools start with. A model whose program is missing here stays in the list, marked red -- so '
    + 'you can see why it will not start instead of having to look for it.',
  'feld.orchestratorModel.etikett': 'takes effect on the next session',
  'feld.orchestratorModel.leerName': 'Model',
  'feld.orchestratorModel.leerWirkung':
    'No model with the role "orchestrator" is registered for this program.',
  'feld.orchestratorModel.leerInfo':
    'Add a model with this role: wb-state models add-model … --roles orchestrator. Until one exists, '
    + 'the session starts with whatever the CLI defaults to on its own.',
  'satz.keinModellFuerProgramm': 'No model with program "{harness}" and role "orchestrator".',

  'feld.orchestratorEffort.name': 'How deep the session thinks',
  'feld.orchestratorEffort.wirkung':
    'The level the orchestrator starts at. Your choice -- every level the program accepts.',
  'feld.orchestratorEffort.info':
    'This is a human\'s choice, and no cap binds a human: every level is selectable, even the ones above '
    + 'the cap -- they just carry a mark. The cap is something else -- the orchestrator\'s own commitment '
    + 'for workers it starts without asking. Which levels even exist is something the program states '
    + 'itself, measured against its own help text, not copied from a list. Higher levels cost more time '
    + 'and more of the quota.',
  'feld.orchestratorEffort.etikett': 'takes effect on the next session',

  'feld.orchestratorKontext.name': 'Context window',
  'feld.orchestratorKontext.wirkung':
    'How much text "{modell}" keeps in mind at once. Only for a model that runs here on this machine -- '
    + 'for a model in the cloud that number belongs to the provider.',
  'feld.orchestratorKontext.info':
    'A larger window holds more context but permanently occupies more GPU memory: the demand grows with '
    + 'every token, and what no longer fits makes the start fail. That is why every level states what it '
    + 'needs and what is free right now. Nothing is locked: levels the memory does not cover today stay '
    + 'selectable and carry a note -- the decision is yours, not the program\'s. It is measured by '
    + 'wb-kontext, together with the free memory of this very moment. The choice applies to the '
    + 'orchestrator; the windows of its workers are the orchestrator\'s own call.',
  'feld.orchestratorKontext.etikett': 'takes effect on the next session',
  'wort.kontextToken': '{tokens} tokens',
  'wort.kontextEmpfohlen': 'recommended',
  'satz.kontextBedarf': 'Needs {bedarf} GiB.',
  'satz.kontextSpeicher': 'Free: {frei} GiB, of which the model weights take {gewichte} GB.',
  'satz.kontextFremderWert':
    'Stored: {tokens} tokens — the chosen model does not offer that level. '
    + 'As long as no level is selected, the session starts with the stored value.',
  'satz.kontextWirdErmittelt': 'Determining the levels …',
  'satz.kontextNichtErmittelt':
    'The levels could not be determined: {grund}. Until that changes, the session starts with the window '
    + 'registered for this model.',

  'feld.newSessionDefaultDir.name': 'Folder a new session starts in',
  'feld.newSessionDefaultDir.wirkung':
    'The plus button suggests this folder, as long as you do not pick another one.',
  'feld.newSessionDefaultDir.info':
    'A suggestion, nothing more: the choice happens in the folder dialog, and picking something else '
    + 'there gets you that instead. "~" stands for your home directory. Until 11.08. this setting was only '
    + 'reachable in the VS Code extension, even though this program has long read it -- so now it lives here.',
  'feld.newSessionDefaultDir.etikett': 'takes effect on the next session',

  'feld.showStopped.name': 'Show stopped sessions too',
  'feld.showStopped.wirkung':
    'On: the bar also shows sessions whose terminal is no longer running -- marked red.',
  'feld.showStopped.info':
    'Off (default) keeps the bar short: only what is alive right now. On is useful for picking up a '
    + 'session from yesterday -- it shows up with its folder and is clickable. This is a setting, not a '
    + 'daily action, which is why it lives here and not as a button in the bar.',
  'feld.showStopped.etikett': 'immediately',

  'feld.sort.name': 'Order in the bar',
  'feld.sort.wirkung':
    'What the sessions are ordered by, as long as no order has been dragged by hand.',
  'feld.sort.info':
    'A manual drag always wins over this default -- whoever drags a session to a spot wants it there. '
    + 'The default applies to everything added after that. "recently used" orders by the last activity in '
    + 'the terminal, not by when the session was created.',
  'feld.sort.etikett': 'immediately',
  'wort.sort.recent': 'recently used',
  'wort.sort.folder': 'by folder',
  'wort.sort.name': 'by name',

  'feld.closeSessionOnWindowClose.name': 'Close the terminal with the window',
  'feld.closeSessionOnWindowClose.wirkung':
    'Off (default): the window closes, the tmux session behind it keeps running -- it gets closed via '
    + 'the right-click on the session. On: closing the window also ends the session.',
  'feld.closeSessionOnWindowClose.info':
    'Measured on 04.08.: three closed windows kept their tmux sessions alive and held 6.0 GB together. A '
    + 'reload never ends anything -- a session only counts as orphaned after a grace period, and a '
    + 'returning window takes the mark back off. If a worker is still running, it stays open regardless. '
    + 'Since 07.08. the default is still off anyway: reclaimed memory can always be gotten back, a '
    + 'session ended by accident, along with the work running in it, cannot.',
  'feld.closeSessionOnWindowClose.etikett': 'immediately',

  // --- Page 2: Permissions ------------------------------------------------
  'feld.workerSkipPermissions.name': 'Workers work without their CLI asking first',
  'feld.workerSkipPermissions.wirkung':
    'On: a worker does not stop at a write access, it works through.',
  'feld.workerSkipPermissions.info':
    'This is the most consequential quiet decision in the whole setup, and until 06.08. it lived in a '
    + 'single line of shell code. The guards and the ask-first tier still apply -- the CLI\'s own '
    + 'permission prompt does not. Off means: every worker stops at every write access and waits for a '
    + 'human; an overnight run then sits until morning.',
  'feld.workerSkipPermissions.etikett': 'takes effect on the next worker',

  'feld.orchestratorPermissionMode.name': 'How much the orchestrator may do without asking',
  'feld.orchestratorPermissionMode.wirkung':
    'Sets the confirmation level the CLI of the next orchestrator session starts with.',
  'feld.orchestratorPermissionMode.info':
    'The six levels of claude --permission-mode, measured from claude --help. Lowering -- any change '
    + 'away from bypassPermissions -- goes through at once, no reason needed; raising it back to '
    + 'bypassPermissions, the default, needs a real human at this interface and a reason, checked by '
    + 'wb-state itself. shell/wb-code reads the value when the next orchestrator session starts, not the '
    + 'running one. Workers stay unaffected -- the orchestrator sets those for itself.',
  'feld.orchestratorPermissionMode.etikett': 'takes effect on the next session',

  'feld.workerWorktrees.name': 'Every worker gets its own worktree',
  'feld.workerWorktrees.wirkung':
    'On: every worker works in a git repo in its own folder and branch instead of the shared one.',
  'feld.workerWorktrees.info':
    'The tree lives under ~/.pi-workers/worktrees/<name>, the branch is called wb/<name>. Off means: '
    + 'every worker works in the given directory and runs into each other there -- two touching the same '
    + 'file overwrite one another. Outside a git repo the switch changes nothing. It acts globally, '
    + 'because neither claude-worker nor pi-worker has a per-call switch today.',
  'feld.workerWorktrees.etikett': 'takes effect on the next worker',

  'feld.guards.name': 'Which safeguards run',
  'feld.guards.wirkung':
    'Every safeguard can be switched off on its own. A switched-off one stays in the list, with a '
    + 'reason and a date.',
  'feld.guards.info':
    'They run before every command an agent issues, in this order; the last one is the ask-first tier '
    + 'below. Whatever one of them flatly refuses never reaches the ask-first tier. Two of them (live '
    + 'config, media from the cloud) only warn and stop nothing. Switching one off requires a reason and '
    + 'a human; it is noted with a date next to it, so someone six months from now still knows why the '
    + 'safeguard is missing.',
  'feld.guards.etikett': 'immediately',

  'feld.askPatterns.name': 'Commands that ask first',
  'feld.askPatterns.wirkung':
    'These commands are held, show up in the approval view, and go through after a one-time approval.',
  'feld.askPatterns.info':
    'Neither harmless nor forbidden -- this is the tier in between. A pattern matches a SPOT in the '
    + 'parsed command line, not a string anywhere in the text -- otherwise a paragraph merely mentioning '
    + '"git clean -fd" would already trip the guard (as happened on 05.08.). Switched off instead of '
    + 'deleted keeps it visible that the pattern exists. One approval lasts fifteen minutes, hard-capped '
    + 'in the module.',
  'feld.askPatterns.etikett': 'immediately',

  'feld.secretExcludeDirs.name': 'Folders no view enters',
  'feld.secretExcludeDirs.wirkung':
    'No view enters these folders -- they are skipped, not just hidden.',
  'feld.secretExcludeDirs.info':
    'File tree, quick-open, content search and editor all ask the same spot; a filter a view can bypass '
    + 'is no filter. EVERY path segment is checked, not just the last one -- otherwise project/.ssh/config '
    + 'would slip through. The list lives here and not in source, because it should be visible and checkable.',
  'feld.secretExcludeDirs.etikett': 'immediately',

  'feld.secretExcludePatterns.name': 'Filenames no view shows',
  'feld.secretExcludePatterns.wirkung':
    'Files whose name matches one of these patterns show up in no view.',
  'feld.secretExcludePatterns.info':
    'A glob on ONE path segment, no path separator: * stands for any number of characters, ? for one. '
    + 'Deliberately kept small -- a full glob dialect with ** and {a,b} invites patterns whose effect is '
    + 'no longer visible. Case does not matter.',
  'feld.secretExcludePatterns.etikett': 'immediately',

  'feld.werkzeuge.name': 'An agent\'s tools and MCP servers',
  'feld.werkzeuge.wirkung':
    'What tools an agent gets today lives in its own configuration -- this program reads it, but does '
    + 'not yet set it.',
  'feld.werkzeuge.info':
    'The hooks below come from ~/.claude/settings.json and apply to every Claude session on this '
    + 'machine; the MCP servers hang off the services mcp-shared manages. Both are shown here, not '
    + 'written: a switch that half-overwrites a foreign configuration is worse than no switch. The way '
    + 'there is described (the workbench writes harness configurations via wb-harness-run) and not yet built.',
  'satz.werkzeugeOhneHooks':
    'No hook is set in ~/.claude/settings.json. An agent gets whatever tools its CLI brings along on its own.',
  'satz.werkzeugeMcp':
    'MCP servers are kept as background services by mcp-shared, not by this program. As long as that '
    + 'holds, there is no switch for it here, just this sentence.',

  // The nine guards -- ids from hooks/bash-guard.py, text from here.
  'guard.secrets.name': 'Secrets',
  'guard.secrets.wirkung':
    'Holds any command that touches a key, a certificate, or the secrets folder.',
  'guard.secrets.info':
    'Covers ~/Knowledge/90-secrets, ~/.ssh, and the usual credential files -- the same list the folder '
    + 'view also skips. Off means: an agent can read, copy, and write these files into an output without '
    + 'anyone being asked.',
  'guard.kill-pattern.name': 'Killing other processes',
  'guard.kill-pattern.wirkung':
    'Holds commands that shoot down processes that do not belong to the agent.',
  'guard.kill-pattern.info':
    'A pkill with too broad an expression has already taken running workers out of the grid. The guard '
    + 'tells apart what the agent started itself from what was already running.',
  'guard.live-config.name': 'Live configuration',
  'guard.live-config.wirkung':
    'Warns when a command touches the files the running setup depends on.',
  'guard.live-config.info':
    'A warning only, no stop: the chain keeps running. The reason is an incident where a test overwrote '
    + 'the real settings file and made four running workers invisible.',
  'guard.push-gate.name': 'Push gate for workers',
  'guard.push-gate.wirkung':
    'A worker may not push, open pull requests, or publish anything.',
  'guard.push-gate.info':
    'The orchestrator decides on pushes, because only it knows the whole state. The guard recognizes '
    + 'the role by the pane, not by the name. Off means: any worker can push into a public repo.',
  'guard.media-cloud.name': 'Media from the cloud',
  'guard.media-cloud.wirkung':
    'Warns when an image, a video, or a voice comes from a paid service instead of locally.',
  'guard.media-cloud.info':
    'A warning only. The local tools (bild, video, tts, stt) cost nothing and never leave the machine; '
    + 'a cloud call does both, and should therefore happen on purpose.',
  'guard.screencapture.name': 'Screen captures',
  'guard.screencapture.wirkung':
    'Holds commands that photograph or record the screen.',
  'guard.screencapture.info':
    'A screenshot takes everything that is currently open along with it -- including things that are '
    + 'nobody\'s business. For evidence images there is the path through the window itself, which '
    + 'captures only its own window.',
  'guard.snapshot.name': 'Backup before deleting',
  'guard.snapshot.wirkung':
    'Holds delete commands as long as no copy of the data has been made.',
  'guard.snapshot.info':
    'The copy lands under ~/.local/trash-snapshots/<date>-<name>/. The guard checks whether it exists '
    + 'before the delete goes through -- it does not create it.',
  'guard.commit-trailer.name': 'A commit\'s author',
  'guard.commit-trailer.wirkung':
    'Holds a commit that has a foreign co-author slipped into it.',
  'guard.commit-trailer.info':
    'In these repos there is one author and nobody else. This guard is the only one that aborts with an '
    + 'error code instead of an answer -- it sits right in front of the commit.',
  'guard.muster.name': 'Ask-first tier',
  'guard.muster.wirkung':
    'The pattern list further below: commands that are neither harmless nor forbidden get held.',
  'guard.muster.info':
    'The last tier, and the only one that does not refuse but asks. It sits behind all the others: '
    + 'whatever a guard flatly refuses never reaches here. Switched off here means: no pattern triggers '
    + 'an ask-first prompt anymore -- including the ones still checked further below.',

  // --- Page 3: Programs and models --------------------------------
  'feld.harnessTabelle.name': 'Programs, sign-in and chat view',
  'feld.harnessTabelle.wirkung':
    'For every agent program: whether it starts here, whether it is signed in, which effort levels it '
    + 'accepts, and whether it can carry a chat view.',
  'feld.harnessTabelle.info':
    'The levels are measured against each program\'s own help text, not copied off a list. Sign-in is '
    + 'not a guessing game: it checks whether the evidence the registry names for this provider is '
    + 'present -- if none is named, it says "not checkable", not "not signed in". The chat view depends '
    + 'on the program, not on taste; what a program cannot do gets no gray field here, it gets the plain '
    + 'reason instead.',
  'wort.startbar': 'starts here',
  'wort.nichtStartbar': 'does not start on {maschine}',
  'wort.angemeldet': 'signed in',
  'wort.nichtAngemeldet': 'not signed in',
  'wort.anmeldungUnbekannt': 'not checkable',
  'wort.stufenNichtErmittelt': 'not determined',
  'wort.keineStufen': 'has no levels',
  'spalte.programm': 'Program',
  'spalte.stufen': 'Levels',
  'spalte.modelle': 'Models',
  'spalte.hier': 'On {maschine}',
  'spalte.anmeldung': 'Sign-in',
  'spalte.chat': 'Chat view',
  'spalte.modell': 'Model',
  'spalte.deckel': 'Cap',
  'spalte.herkunft': 'Source',
  'spalte.grund': 'Reason',
  'spalte.einstellung': 'Setting',
  'spalte.beiDir': 'On your machine',
  'spalte.auslieferung': 'Default',
  'spalte.anbieter': 'Provider',
  'spalte.zugang': 'Access',
  'spalte.eingabe': 'Enter',
  'spalte.maschine': 'Machine',
  'spalte.wert': 'Value',

  'satz.chatKannNicht': 'No path to the conversation history is registered -- so there is no switch here.',
  'satz.chatOhneMessung': 'Registered, but without a measurement date -- without one, the entry does not count.',
  'satz.chatKannLive': 'reads along while the session runs',
  'satz.chatKannNichtLive': 'only reads once the session has stopped',
  'satz.chatZeigtNicht': 'Does not show: {liste}.',

  'feld.chatAnsicht.name': 'Show conversation instead of terminal',
  'feld.chatAnsicht.wirkung':
    'On: the workbench draws the conversation history for this program instead of the terminal image.',
  'feld.chatAnsicht.info':
    'The switch is per program, not global, because the ability depends on the program, not on taste. '
    + 'The terminal pane keeps running and is still parsed either way -- that is the only way the '
    + 'workbench knows whether the program is currently asking, answering, or waiting; only the display '
    + 'differs. Whatever is in no transcript (approval dialogs, context usage, progress) shows up in the '
    + 'line next to it.',
  'feld.chatAnsicht.etikett': 'takes effect on the next session',

  'feld.ollamaEndpoint.name': 'Address of the local model server',
  'feld.ollamaEndpoint.wirkung':
    'Local models are looked for at this address -- Ollama, vLLM, or MLX, whichever answers there.',
  'feld.ollamaEndpoint.info':
    'Until 11.08. http://127.0.0.1:11434 was fixed in source in seven places and could not be set '
    + 'anywhere; running Ollama on another machine meant editing seven files by hand. This field is the '
    + 'one place for it. Expected is a full address with http:// or https:// and no path at the end. A '
    + 'server on the network instead of this machine means: the requests leave the machine -- that is a '
    + 'decision, not a detail.',
  'feld.ollamaEndpoint.etikett': 'takes effect on the next lookup',
  'satz.ollamaNochNichtVerdrahtet':
    'The value is stored and shown here. The seven spots in source that still hard-code the address '
    + 'today do not read it yet -- they will be caught up in a separate step.',

  'feld.modelDiscoveryAuto.name': 'Fetch model catalogs on their own',
  'feld.modelDiscoveryAuto.wirkung':
    'On: the providers\' catalogs are fetched from the network on their own. Off: only on demand.',
  'feld.modelDiscoveryAuto.info':
    'Off means ONLY that the network is no longer reached on its own. The local sources -- ollama, the '
    + 'CLIs\' own model lists, files -- keep discovering automatically regardless, and the manual fetch '
    + 'button always stays usable. Until 11.08. this setting was only reachable in the VS Code extension, '
    + 'even though wb-state has long read it.',
  'feld.modelDiscoveryAuto.etikett': 'immediately',

  'feld.orchestratorVorhersage.name': 'Multi-token prediction for the orchestrator',
  'feld.orchestratorVorhersage.wirkung':
    'On: if one is registered for its model, the orchestrator additionally loads a drafter or a build with '
    + 'a built-in prediction head -- faster per reply, but without shared concurrency on the MLX server.',
  'feld.orchestratorVorhersage.info':
    'Which paths exist is set in the registry: only what is registered and measured there can be picked, '
    + 'never a free-form path. If the registry lists more than one path for the model, they appear below '
    + 'the switch, each with its provenance -- including where something was NOT measured. Speculative '
    + 'decoding and the MLX server\'s shared concurrency are mutually exclusive (mlx_lm.server turns off '
    + 'batching the moment a drafter is set) -- that is why this switch defaults to off.',
  'feld.workerVorhersage.name': 'Multi-token prediction for workers',
  'feld.workerVorhersage.wirkung':
    'On: a worker on a local model loads, if one is registered for it, the same drafter or built-in head '
    + '-- separate from the orchestrator\'s switch.',
  'feld.workerVorhersage.info':
    'Which model gets used is set in the registry and is not selectable here -- this is a read-only '
    + 'display only. Independent of the orchestrator switch: one can be on while the other is off.',
  'wort.vorhersageEntwerfer': 'external drafter',
  'wort.vorhersageEingebaut': 'built-in head',
  'satz.vorhersageModell': 'Model: {modell} ({bauart})',
  'satz.vorhersageKeine': 'No prediction is registered for the currently selected model.',
  'satz.vorhersageWegVorgabe': '{weg} (default)',

  'feld.anbieter.name': 'Access to the providers',
  'feld.anbieter.wirkung':
    'For every provider: where its access comes from, and whether it is present on this machine.',
  'feld.anbieter.info':
    'A key is entered here, but NOT written into the settings file -- that file is shared plain text that '
    + 'workers write to as well, and a key inside it would be a key in plain text. The value takes its own '
    + 'path instead and is never read back afterward to display it. So all that is shown remains whether '
    + 'access is present -- never its value, never its location. A provider with a subscription instead of '
    + 'a key reports whether sign-in has happened instead.',
  'wort.zugangDa': 'present',
  'wort.zugangFehlt': 'missing',
  'wort.zugangUnbekannt': 'not checkable',
  'wort.zugangAbo': 'subscription, no key',
  'wort.zugangLokal': 'runs locally, no access needed',

  'feld.effortCaps.name': 'Highest level without asking',
  'feld.effortCaps.wirkung':
    'This is as far as the orchestrator may go when it starts a worker on its own.',
  'feld.effortCaps.info':
    '"Default" means: the value comes from the registry, as the model shipped. As soon as you set a '
    + 'cap, it shows "set by you" with a date and a reason -- and the reason is required, because a '
    + 'self-imposed commitment without one looks like a technical limit six months from now. Anyone can '
    + 'lower it; raising it requires a human, judged by where the call came from. Back to the shipped '
    + 'default goes through the first entry of the picker.',
  'feld.effortCaps.etikett': 'takes effect on the next automatic start',
  'satz.deckelLeitsatzFett': 'A cap binds the orchestrator, not you. ',
  'satz.deckelLeitsatz':
    'When you start something yourself, every level the program accepts is open to you. The cap here '
    + 'applies to workers the orchestrator starts without asking: it should not hand itself the most '
    + 'expensive level on its own.',
  'satz.deckelDieses': 'Cap of this model: ',
  'satz.deckelGilt':
    '. It applies when the orchestrator starts a worker on its own -- it does not apply to your own '
    + 'choice here. ',
  'satz.deckelDarueber': 'Dashed outline: the levels above it ({stufen}).',
  'satz.deckelGrund': 'Reason for the cap: {grund}',
  'satz.deckelKeiner':
    'No cap is set for this model -- the orchestrator hands out any level.',
  'satz.deckelUeber':
    'Above the cap ({deckel}). Selectable: the cap binds the orchestrator, not you.',
  'wort.vonDir': 'set by you',
  'wort.ausAuslieferung': 'default',
  'wort.vonDirAm': 'by you, {datum}',
  'satz.deckelAuslieferungWahl': 'Default ({deckel})',
  'wort.ohne': 'none',
  'satz.stufenKeineWahl': '"{harness}" has no levels -- there is nothing to choose here.',
  'satz.stufenErstModell': 'Pick a model first; the levels depend on its program.',

  // --- Page 4: Machines --------------------------------------------------
  'feld.remoteMachines.name': 'Machines that work along',
  'feld.remoteMachines.wirkung':
    'Every machine here shows up in the session bar and is selectable as a target for a worker.',
  'feld.remoteMachines.info':
    'The name is the SSH alias, exactly as "ssh peer" knows it -- there is no second address list next '
    + 'to it. A Tailscale name or an IP works the same way, as long as ssh can handle it; anyone with a '
    + 'gate in front enters the alias that gets through the gate. More than two are explicitly supported. '
    + 'The list stays empty until someone adds an entry: an SSH target is real network access and must '
    + 'never fire on its own. The check button asks exactly once (ssh <name> true).',
  'feld.remoteMachines.etikett': 'immediately',
  'satz.eigeneMaschine':
    'This machine -- it is always in the list and cannot be removed.',
  'satz.fremdeMaschine': 'Reached via ssh {name} -- the name IS the SSH alias.',
  'satz.keineMaschine':
    'No further machine is registered. Without an entry the program never reaches the network on its own.',
  'satz.maschineSchonDa': '"{name}" is already in the list.',
  'satz.fremdeLast':
    'How many workers another machine carries at once lives in ITS OWN settings file and is set there: '
    + 'ssh {name} wb-state settings set maxWorkers <number>. Two numbers in two places for the same '
    + 'question would be two truths, one of which is wrong.',

  'feld.maxWorkers.name': 'Workers at once on this machine',
  'feld.maxWorkers.wirkung':
    'A session accepts no more than this many workers -- the next start is refused.',
  'feld.maxWorkers.info':
    'Refused, not queued: a start that overflows the window costs more than a start that says "too '
    + 'many". Existing panes keep getting reused, so a finished worker immediately frees up room again. '
    + 'What is counted is worker panes, not subagents. This number belongs to the MACHINE, not the '
    + 'session: what a 48 GB machine carries, a smaller one does not.',
  'feld.maxWorkers.etikett': 'immediately',

  'feld.defaultWorkerMachine.name': 'Where a worker runs when nothing is said',
  'feld.defaultWorkerMachine.wirkung':
    'Which machine a worker goes to when none is named at start.',
  'feld.defaultWorkerMachine.info':
    'The choice comes from the list above: every machine registered there is selectable here. "This '
    + 'machine" means: the worker runs in the same terminal server as the session. A target that does not '
    + 'answer fails the start instead of redirecting it -- hence the check button next to it.',
  'feld.defaultWorkerMachine.etikett': 'takes effect on the next worker',
  'wort.dieseMaschine': 'This machine ({name})',

  'feld.workerZustellung.name': 'How a task reaches the worker',
  'feld.workerZustellung.wirkung':
    'Through the session inbox, or typed into the pane input line.',
  'feld.workerZustellung.info':
    'Typing puts the task into the worker terminal character by character -- visible, but fragile: on '
    + 'the night of 20.08. five panes froze that way and tasks vanished silently. Claude Code ships an '
    + 'inbox for the same purpose that does not go through the input line and therefore cannot overwrite '
    + 'or block anything. "Automatic" uses the inbox where there is one and types otherwise; it is the '
    + 'default because only Claude Code ships an inbox today -- the other programs in the registry type either '
    + 'way, and a default that does not apply to them must not break anything for them. "Inbox only" '
    + 'requires it and lets delivery fail audibly instead of typing as a substitute: meant for test runs '
    + 'and for the case that nothing should be written into an input line at all. For a worker on any '
    + 'other program that choice therefore means it gets no task. "Typing only" is the way back, should '
    + 'the inbox break on a future version of the CLI. Whether a task arrived is checked the same way on '
    + 'all three routes and reported in plain words.',
  'feld.workerZustellung.etikett': 'takes effect on the next task',
  'wort.workerZustellung.auto': 'automatic',
  'wort.workerZustellung.socket': 'inbox only',
  'wort.workerZustellung.paste': 'typing only',

  // --- Page 5: Oversight and notifications -------------------------
  'feld.contextGuardAutostart.name': 'Context guard starts along',
  'feld.contextGuardAutostart.wirkung':
    'On: the program starts the guard itself as soon as a session exists -- nobody has to remember it.',
  'feld.contextGuardAutostart.info':
    'Until 06.08. the orchestrator started its own guard. alice\'s decision to hand it to the '
    + 'program instead: "If someone picks a weaker model as orchestrator that is not as reliable, the '
    + 'context guard should still be reliable." That way it no longer depends on the diligence of the '
    + 'one it is watching. Off means: no guard runs unless someone starts it by hand.',
  'feld.contextGuardAutostart.etikett': 'takes effect on the next session',

  'feld.wacheOrchAn.name': 'Watch the main window',
  'feld.wacheOrchAn.wirkung':
    'On: the guard also looks over the main window\'s shoulder, not just the workers\'.',
  'feld.wacheOrchAn.info':
    'Switchable separately, because the two sides cost differently: an orchestrator compacted mid- '
    + 'handoff loses the thread, a worker rarely does. Anyone who does not want oversight over themselves '
    + 'switches it off here and leaves it running for the workers. Switching off requires a reason and a '
    + 'human -- it cannot be done from a worker pane.',
  'feld.wacheOrchAn.etikett': 'takes effect on the next guard run',

  'feld.wacheWorkerAn.name': 'Watch the workers',
  'feld.wacheWorkerAn.wirkung': 'On: every worker pane is read along and nudged when its context fills up.',
  'feld.wacheWorkerAn.info':
    'A worker compacted without a handoff delivers its task only half done -- the nudge makes sure it '
    + 'writes down what it knows first. A pane narrower than the minimum width cannot be read; the guard '
    + 'then explicitly reports it as blind instead of silently skipping it. Done notifications keep '
    + 'running even while the guard here is off.',
  'feld.wacheWorkerAn.etikett': 'takes effect on the next guard run',

  'feld.wacheWorkerMahnenAb.name': 'Nudge workers from',
  'feld.wacheWorkerMahnenAb.wirkung':
    'From this fill level on, the guard asks a worker to write a handoff and compact.',
  'feld.wacheWorkerMahnenAb.info':
    'Percent of its model\'s context window. Nudged too early costs work, too late costs the result: '
    + 'whatever is not written down before compacting is gone. 80 leaves enough room for the handoff '
    + 'itself. A HIGHER number means a later nudge, so less of a safety margin -- the tool requires a '
    + 'reason for that.',
  'feld.wacheWorkerMahnenAb.etikett': 'takes effect on the next guard run',

  'feld.wacheOrchMahnenAb.name': 'Nudge the main window from',
  'feld.wacheOrchMahnenAb.wirkung':
    'From this fill level on, the orchestrator should catch up its state file and knowledge store.',
  'feld.wacheOrchMahnenAb.info':
    'Lower than for workers, because it has more to secure: session state, open tasks, whatever belongs '
    + 'in the vault. Five percentage points of lead time is roughly a quarter hour of work.',
  'feld.wacheOrchMahnenAb.etikett': 'takes effect on the next guard run',

  'feld.wacheOrchEingreifen.name': 'The guard steps in itself',
  'feld.wacheOrchEingreifen.wirkung':
    'Off: it keeps nudging but no longer types /compact -- it keeps the voice, not the hand.',
  'feld.wacheOrchEingreifen.info':
    'The guard compacts the orchestrator session itself if needed, by typing /compact into a foreign '
    + 'window. Anyone who does not want that but still wants to be warned switches this off: the nudge '
    + 'stays, the intervention goes away. This is the milder tier between "everything" and "guard off".',
  'feld.wacheOrchEingreifen.etikett': 'takes effect on the next guard run',

  'feld.wacheOrchNotbremseAb.name': 'Emergency brake from',
  'feld.wacheOrchNotbremseAb.wirkung':
    'From here on, the guard compacts the orchestrator itself -- even without its signal.',
  'feld.wacheOrchNotbremseAb.info':
    'It types /compact into a foreign session, never mid-turn. Until 06.08. this number was fixed in '
    + 'source and nowhere visible; anyone who did not know took the sudden compacting for a bug. It only '
    + 'fires while "the guard steps in itself" is on.',
  'feld.wacheOrchNotbremseAb.etikett': 'takes effect on the next guard run',

  'feld.stallMinutes.name': 'Report as "stalled" after',
  'feld.stallMinutes.wirkung':
    'A worker may stay quiet this long before the bar marks it as stalled.',
  'feld.stallMinutes.info':
    'Measured against 11,070 pauses from 17 sessions that worked through and delivered: at 5 minutes, 8 '
    + 'of those 17 would have wrongly carried "stalled", at 10 minutes still 4. A child process younger '
    + 'than the silence suppresses the notice regardless -- so a long test run does not count as a stall.',
  'feld.stallMinutes.etikett': 'immediately',

  'feld.guardMeldetWorkerStatus.name': 'The guard types worker notices into the main window',
  'feld.guardMeldetWorkerStatus.wirkung':
    'On: the guard types "worker done" and "worker stalled" itself into the orchestrator pane.',
  'feld.guardMeldetWorkerStatus.info':
    'Off by default, and this is alice\'s own decision: the notice looks like his own words, it '
    + 'interrupts him mid-sentence, and the same information already sits in the right-hand sidebar '
    + 'anyway. Unaffected is everything that must never fall silent: the main window\'s context warning, '
    + 'the typed /compact, and anything sent to worker panes. This switch is read in nine places and, '
    + 'until 11.08., had no field in either interface.',
  'feld.guardMeldetWorkerStatus.etikett': 'takes effect on the next guard run',

  'satz.guardsWohnenAnderswo':
    'The safeguards that run before every command live on the "Permissions" page -- where everything '
    + 'an agent may do is listed. Offering them here a second time would mean two places for the same decision.',

  'feld.meldungenAn.name': 'Notify outside the window',
  'feld.meldungenAn.wirkung':
    'On: the program lets you know, even while you are doing something else. Off: it stays quiet.',
  'feld.meldungenAn.info':
    'Until 11.08. the program never reached outward -- no system notice, no sound, nothing to the '
    + 'phone. Anyone doing something else in the meantime only noticed a worker was done or an approval '
    + 'was waiting on the next glance. This switch is the one question everything else hangs on; what and '
    + 'how is notified sits below it. The default is off, because a program that starts ringing unasked '
    + 'would be worse than one that stays quiet.',
  'feld.meldungenAn.etikett': 'immediately',

  'feld.meldungenEreignisse.name': 'What triggers a notification',
  'feld.meldungenEreignisse.wirkung':
    'Only these four events can trigger a notification -- each one deselectable on its own.',
  'feld.meldungenEreignisse.info':
    'Four events, each for a different reason: a finished worker means work is waiting on you; a '
    + 'pending approval means a chain is stuck until you answer; a dead session means something stopped '
    + 'that you think is still running; a nearly exhausted quota means the next hour gets expensive. '
    + 'Deselecting all of them gets you nothing -- then the switch above is the more honest way to say so.',
  'feld.meldungenEreignisse.etikett': 'immediately',

  'feld.meldungenWege.name': 'Through which channel',
  'feld.meldungenWege.wirkung':
    'System notice, sound, phone -- alone or together. The channel decides how intrusive it is.',
  'feld.meldungenWege.info':
    'A system notice is quiet and sits in the notification center; a sound gets you right away, even '
    + 'with the screen off; the phone reaches you away from home. Email is deliberately not an option: '
    + 'sending an email is an outward-facing action with its own approval rule, and a checkbox in a menu '
    + 'would be a quiet way around it.',
  'feld.meldungenWege.etikett': 'immediately',

  'feld.meldungenHandyUrl.name': 'Address for the phone',
  'feld.meldungenHandyUrl.wirkung':
    'The webhook a notification is sent to. Empty means: no path to the phone.',
  'feld.meldungenHandyUrl.info':
    'A webhook is an address a service gives you that gets a message to your phone. Which service you '
    + 'use is up to you -- the program only knows the address and sends text there. This address leaves '
    + 'the machine with every notification, and what it contains is up to the service behind it: do not '
    + 'enter anything here you do not trust it with.',
  'feld.meldungenHandyUrl.etikett': 'immediately',

  'feld.meldungenTonDatei.name': 'Custom sound',
  'feld.meldungenTonDatei.wirkung':
    'Path to a sound file. Empty means: the operating system\'s sound.',
  'feld.meldungenTonDatei.info':
    'A custom sound is more than taste: with several programs running, a distinct sound tells you a '
    + 'notification came from here without looking. Empty is the safe choice -- the system sound always '
    + 'exists, a file can disappear.',
  'feld.meldungenTonDatei.etikett': 'immediately',

  'feld.meldungenLimitSchwelle.name': 'When the quota counts as nearly full',
  'feld.meldungenLimitSchwelle.wirkung':
    'From this share of the quota on, the program notifies you -- provided the event above is checked.',
  'feld.meldungenLimitSchwelle.info':
    'Percent of the quota in the running window. Warned too early means: you get used to it and miss '
    + 'the one that counts. Too late means: the warning arrives once there is nothing left to save. 85 '
    + 'leaves enough room to still bring running work to an orderly close.',
  'feld.meldungenLimitSchwelle.etikett': 'immediately',

  'feld.meldungTesten.name': 'Send a test',
  'feld.meldungTesten.wirkung':
    'Sends a test notification over exactly the channels selected above, and shows below what happened '
    + 'on each one.',
  'feld.meldungTesten.info':
    'This button sends ONE real test notification -- system notice, sound, webhook, whichever is checked '
    + 'above -- and then reports per channel whether it worked: the HTTP status for the webhook, otherwise '
    + 'the reason it did not. If the main switch is off, the button says so and sends nothing.',
  'knopf.meldungTesten': 'Send a test',
  'meldungTesten.hauptschalterAus': 'The main switch above is off -- nothing was sent.',
  'meldungTesten.keinWeg': 'No channel is selected -- nothing was sent.',
  'meldungTesten.laeuft': 'Sending test …',
  'meldungTesten.system.ok': 'System notice: delivered',
  'meldungTesten.system.fehler': 'System notice: failed -- {grund}',
  'meldungTesten.ton.ok': 'Sound: played',
  'meldungTesten.ton.fehler': 'Sound: failed -- {grund}',
  'meldungTesten.handy.ok': 'Phone: webhook answered with HTTP {status}',
  'meldungTesten.handy.fehler': 'Phone: failed -- {grund}',
  'meldung.workerFertig': 'A worker is done',
  'meldung.freigabeWartet': 'An approval is waiting on you',
  'meldung.sitzungTot': 'A session has died',
  'meldung.limitFastVoll': 'The quota is nearly full',
  'weg.system': 'System notice',
  'weg.ton': 'Sound',
  'weg.handy': 'Phone',
  'platzhalter.handyUrl': 'https://…  (empty = no path to the phone)',
  'platzhalter.tonDatei': '~/Music/notify.aiff  (empty = system sound)',

  // --- Page 6: Appearance ---------------------------------------------------
  'feld.thema.name': 'Light or dark',
  'feld.thema.wirkung':
    'Whether the program looks light, dark, or however the operating system is currently set.',
  'feld.thema.info':
    '"Follow system" tracks the operating system\'s switch, even mid-work. The terminal panes '
    + 'themselves do not follow: their colors come from tmux and the given CLI, and a second place for '
    + 'that would mean two truths. Today this window follows it; the other windows will catch up once '
    + 'their colors come from the same source.',
  'feld.thema.etikett': 'immediately',
  'wort.thema.system': 'follow system',
  'wort.thema.hell': 'light',
  'wort.thema.dunkel': 'dark',

  'feld.zustandsfarben.name': 'The session-state colors',
  'feld.zustandsfarben.wirkung':
    'How you tell in the bar whether a session is working, waiting, done, or no longer running.',
  'feld.zustandsfarben.info':
    'Four states, four colors, and they need to be distinguishable for YOU -- not for a catalog. Anyone '
    + 'who has trouble telling red from green sets two colors here they can actually see. Back to default '
    + 'goes through the mark next to the heading.',
  'feld.zustandsfarben.etikett': 'immediately',
  'zustand.laeuft': 'working',
  'zustand.wartet': 'waiting on you',
  'zustand.fertig': 'done',
  'zustand.tot': 'no longer running',

  'feld.terminalFontSize.name': 'Terminal font size',
  'feld.terminalFontSize.wirkung':
    'How large the font is in every terminal pane. The change shows immediately.',
  'feld.terminalFontSize.info':
    'It also decides how many columns and rows fit in a pane: a larger font means fewer columns on the '
    + 'same area. Below 80 columns the context guard can no longer reliably read a worker\'s status line '
    + '-- so a strongly enlarged font tends to earn a second worker tab rather than narrower panes. 8 to '
    + '32 is allowed; a value outside that is refused and the old one stays.',
  'feld.terminalFontSize.etikett': 'immediately',

  'feld.terminalScrollLines.name': 'Lines per scroll notch',
  'feld.terminalScrollLines.wirkung':
    'How far one notch of the mouse wheel scrolls -- the same in the window\'s scrollback and in the '
    + 'application inside the pane.',
  'feld.terminalScrollLines.info':
    'Until 06.08. this number fell out of the cell height: a wheel event\'s travelled distance was '
    + 'divided by the height of one line. That depended on the device (a trackpad sends many small '
    + 'events, a mouse a few large ones) and on the font size, and was reported as "way too fast" because '
    + 'of it. Now only this number counts: one notch moves this many lines. A trackpad swipe accumulates '
    + 'its fractions, and a single event never moves more than six lines. 1 to 20 is allowed.',
  'feld.terminalScrollLines.etikett': 'immediately',

  'feld.minWorkerPaneWidth.name': 'Narrowest worker pane',
  'feld.minWorkerPaneWidth.wirkung':
    'This is how narrow a worker pane may get. Below that, the window would rather open a second tab.',
  'feld.minWorkerPaneWidth.info':
    'Measured on 04.08.: at 60 columns a real Claude CLI status line fell back to a bare bar or worse; '
    + '80 is the confirmed floor at which it still reads exactly right with a realistic path. Below that '
    + 'the context guard reports the pane as blind and does not watch it -- so a narrower value does not '
    + 'buy a denser view, it buys blind guards. 20 to 1000 is allowed.',
  'feld.minWorkerPaneWidth.etikett': 'immediately',

  'feld.maxWorkerPanesPerTab.name': 'Workers per tab',
  'feld.maxWorkerPanesPerTab.wirkung':
    'From this count on, the window opens another worker tab instead of shrinking the panes further.',
  'feld.maxWorkerPanesPerTab.info':
    'Measured on 04.08.: on the reference window (197 × 54), two columns of 80 columns fit next to '
    + 'three rows of readable height -- so 6. Below 80 columns the context guard can no longer reliably '
    + 'read the status line and reports the pane as blind. 0 means: no cap of its own; how many really '
    + 'fit side by side is worked out by the window from its size and the minimum width above anyway.',
  'feld.maxWorkerPanesPerTab.etikett': 'takes effect on the next re-layout',

  'feld.workerLayout.name': 'Where the worker panes sit',
  'feld.workerLayout.wirkung':
    'Split under the main window, or in a window of their own next to it.',
  'feld.workerLayout.info':
    'Split means: the workers sit as panes under the orchestrator, everything in one view, each pane '
    + 'narrower. Own window means: the workers get their own window, which can be moved to a second '
    + 'screen. This is a question of screen space, not of the model. Until 11.08. this setting was only '
    + 'reachable in the VS Code extension, even though four tools read it.',
  'feld.workerLayout.etikett': 'takes effect on the next re-layout',
  'wort.workerLayout.split': 'split under the main window',
  'wort.workerLayout.window': 'own window',

  'feld.sprache.name': 'Interface language',
  'feld.sprache.wirkung': 'What language this program\'s labels are in.',
  'feld.sprache.info':
    'Every label in this window has come from ONE table since 11.08., no longer from source -- that is '
    + 'what makes a second language a second table instead of a pass through two thousand lines. English '
    + 'is the shipped default; German stays fully maintained alongside it.',
  'feld.sprache.etikett': 'immediately',
  'wort.sprache.de': 'Deutsch',
  'wort.sprache.en': 'English',
  'satz.spracheNochNichtDa':
    'This language has no table yet. Until the second table exists, the interface stays English -- '
    + 'half-translated would be worse than not at all.',

  'feld.chatAnsichtVorgabe.name': 'New sessions show the conversation',
  'feld.chatAnsichtVorgabe.wirkung':
    'On: new panes start in the chat view, wherever its program can do that -- set separately for the '
    + 'orchestrator and for its workers.',
  'feld.chatAnsichtVorgabe.info':
    'This is the default per role, not a statement of what a program can do -- that lives per '
    + 'program on the "Programs and models" page. A program with no path to the conversation history '
    + 'stays on the terminal image regardless of what is set here. For a single session, right-clicking '
    + 'it beats this default: it switches that session\'s orchestrator immediately, and only it. The '
    + 'workers keep following what is set here.',
  'feld.chatAnsichtVorgabe.etikett': 'takes effect on the next session',
  'wort.rolle.orchestrator': 'Orchestrator',
  'wort.rolle.worker': 'Worker',

  // --- Page 7: Program ---------------------------------------------------
  'feld.pfade.name': 'This program\'s files',
  'feld.pfade.wirkung':
    'Where the two configuration files, the registry, and the interface state live.',
  'feld.pfade.info':
    'Two files, split by responsibility: what the program and the tools mean TOGETHER lives in the '
    + 'settings (~/.claude/workbench/settings.json) -- the lock sits there, and writes only ever go '
    + 'through wb-state, which logs every change with its author. What only this program needs to boot '
    + '(paths, socket, machine id) lives in the program configuration. No key lives in both. The paths '
    + 'are read from this run\'s own configuration, not hard-wired. Which logs the log view shows is '
    + 'deliberately only changeable from the command line: '
    + 'wb-state settings set logPaths \'[{"label":"…","path":"…"}]\'.',

  'feld.erststartZeigen.name': 'Guided first start',
  'feld.erststartZeigen.wirkung':
    'Opens the same window that appears on its own the very first time this workbench starts.',
  'feld.erststartZeigen.info':
    'The same walkthrough as the first start, just called by hand -- to read it again, or to show it to a '
    + 'second person on this machine. The button resets nothing: the fact that the first start already ran '
    + 'stays on record, so the window still will not appear on its own the next time the program actually '
    + 'starts.',
  'feld.erststartZeigen.etikett': 'immediately',

  'feld.abweichungen.name': 'Deviations from the shipped defaults',
  'feld.abweichungen.wirkung':
    'Everything you have changed, in one list -- with the way back.',
  'feld.abweichungen.info':
    'For a program meant to be passed on, this is the one honest answer to why it behaves differently '
    + 'for two people. Compared against is the shipped default, not yesterday\'s state. A value that was '
    + 'never touched does not show up here -- not even when it happens to look the same.',
  'feld.abweichungen.etikett': 'immediately',
  'satz.keineAbweichung': 'Nothing -- everything stands as it shipped.',

  'feld.sicherung.name': 'Back up, reset, transfer',
  'feld.sicherung.wirkung':
    'The whole state as text: copy it and put it aside, paste it back in here, or reset everything to defaults.',
  'feld.sicherung.info':
    'Until 11.08. only single keys could be reset one at a time; before a bigger change there was no way '
    + 'to back up the prior state. The text below is exactly what differs from the shipped defaults -- not '
    + 'the whole file, because backing up defaults would mean locking them in when pasted on another '
    + 'machine. Pasting in goes key by key through the same write path as any checkbox; whatever the tool '
    + 'rejects is not stored, and shows up in the footer afterward.',
  'feld.sicherung.etikett': 'immediately',
  'wort.kopieren': 'to clipboard',
  'wort.einsetzen': 'paste in',
  'wort.allesZurueck': 'reset everything to default',
  'satz.sicherungKopiert': 'The state is on the clipboard ({zeichen} characters).',
  'satz.sicherungKeinText': 'The field is empty -- nothing to paste in.',
  'satz.sicherungKeinJson':
    'That is not a JSON object. What is expected is exactly what the button above produces.',
  'satz.sicherungEingesetzt': '{anzahl} settings pasted in.',
  'satz.sicherungLeer': 'Nothing deviates -- there is nothing to back up.',

  // --- Controls, shared across all pages ------------------------------
  'wort.hinzufuegen': 'Add',
  'wort.entfernen': 'remove',
  'wort.pruefen': 'check',
  'wort.zuruecksetzen': 'reset',
  'wort.speichern': 'save',
  'wort.erneutZeigen': 'show again',
  'wort.frage': 'ask …',
  'wort.erreichbar': 'reachable',
  'wort.nichtErreichbar': 'not reachable: {grund}',
  'wort.an': 'on',
  'wort.aus': 'off',
  'wort.einEintrag': '1 entry',
  'wort.mehrereEintraege': '{anzahl} entries',
  'wort.leereListe': 'empty list',
  'wort.nichtsGesetzt': 'nothing set',
  'wort.alleModelle': 'All {anzahl}',
  'wort.leerListe': 'empty -- nothing gets skipped',
  'platzhalter.modellsuche': 'further filter by name or id …',
  'platzhalter.suche': 'filter by name or id …',
  'platzhalter.maschine': 'SSH alias, e.g. peer',
  'platzhalter.musterBefehl': 'command, e.g. rsync',
  'platzhalter.musterUnterbefehl': 'subcommand (may stay empty)',
  'platzhalter.musterGrund': 'Why it asks first',
  'platzhalter.ordner': 'folder name',
  'platzhalter.dateimuster': 'file pattern',
  'platzhalter.startordner': '~/AI',
  'platzhalter.ollama': 'http://127.0.0.1:11434',
  'platzhalter.sicherung': 'Paste a saved state in here …',
  'platzhalter.schluesselEingabe': 'Paste value …',
  'satz.schluesselLeer': 'No value entered -- nothing saved.',
  'satz.schluesselGespeichert': 'Stored for {anbieter}.',
  'satz.schluesselFehler': 'Failed to store it.',
  'satz.keinTreffer': 'No model matches the filter and search.',
  'satz.keinTrefferSuche': 'No model matches the search.',
  'satz.zuVieleTreffer':
    '{anzahl} models match -- showing the first 60. Search by name or id.',
  'satz.keineMuster': 'No patterns -- no command asks first.',
  'satz.keineGuards':
    'The list of safeguards cannot be read -- wb-state is not answering. Until then, assume all of them run.',
  'satz.abgeschaltet': 'Switched off',
  'satz.abgeschaltetFuer': 'Switched off for {rolle}',
  'satz.seit': ' since {datum}',
  'satz.stehtAufVorgabe': 'Stands at the shipped default.',
  'satz.zurueckAufVorgabe': 'Back to default: {wert}',
  'satz.infoTitel': 'What does "{feld}" do?',
  'satz.musterOhneBefehl':
    'A pattern without a command name would be a text search over the whole line -- it is not created.',
  'satz.musterVonHand': 'Entered by hand.',
  'satz.schreibe': 'writing {schluessel} …',
  'satz.oberflaeche': 'Interface: {schluessel} = {wert}',
  'satz.fehler': 'ERROR: {aufruf} — {ausgabe}',
  'satz.ohneGrundNichts':
    'Nothing changes without a reason -- write in one sentence why.',

  // --- Confirmation prompts ----------------------------------------------------------
  'frage.wacheAus.text':
    'The context guard is no longer started on its own after this. A session then runs without any '
    + 'oversight of its context: nobody nudges before it fills up, nobody compacts, and a handoff only '
    + 'happens if someone remembers to write one by hand.',
  'frage.wacheAus.tun': 'Switch off the guard',
  'frage.wacheOrchAus.text':
    'The context guard leaves the orchestrator alone after this: no nudge, no emergency brake, no '
    + '/compact -- not even right before overflow. It keeps running for the workers.',
  'frage.wacheOrchAus.tun': 'Switch off for the main window',
  'frage.wacheWorkerAus.text':
    'No worker gets nudged or compacted after this. A worker that fills up quietly loses whatever it '
    + 'did not write down.',
  'frage.wacheWorkerAus.tun': 'Switch off for workers',
  'frage.mahnenHoch.worker':
    'Nudging later means less lead time: from {wert}% on, a worker has less room left to write its '
    + 'handoff before compacting happens.',
  'frage.mahnenHoch.orch':
    'From {wert}% on, the orchestrator only gets nudged later -- it then has less room to secure state '
    + 'and knowledge before compacting happens.',
  'frage.mahnenHoch.tun': 'Raise the threshold',
  'frage.eingreifenAus.text':
    'The guard keeps nudging after this, but no longer steps in: it types no /compact, not even at the '
    + 'emergency brake. Missing the nudge runs you straight into a full context.',
  'frage.eingreifenAus.tun': 'Switch off stepping in',
  'frage.notbremseHoch.text':
    'The emergency brake only fires from {wert}% on. The higher it sits, the closer to overflow '
    + 'compacting happens.',
  'frage.notbremseHoch.tun': 'Raise the emergency brake',
  'frage.guardAus.text':
    '"{name}" no longer fires after this. {wirkung} Whatever this safeguard held until now goes '
    + 'through unasked from this point on -- the others are unaffected.',
  'frage.guardAus.tun': 'Switch off the safeguard',
  'frage.musterAus.text':
    '"{name}" no longer triggers an ask-first prompt after this. {grund} The command goes through '
    + 'unasked from now on, unless some guard flatly refuses it regardless.',
  'frage.musterAus.tun': 'Switch off the pattern',
  'frage.musterWeg.text':
    'The pattern "{name}" is deleted from the list. After that there is no sign it ever existed -- '
    + 'anyone who only wants it gone for now should switch it off instead.',
  'frage.musterWeg.tun': 'Delete the pattern',
  'frage.skipAn.text':
    'Every new worker starts with its CLI\'s permission prompt suppressed after this: it writes files '
    + 'without asking. The safeguards and the ask-first tier are unaffected -- the CLI\'s own prompt is not.',
  'frage.skipAn.tun': 'Suppress the prompts',
  'frage.permissionModeAn.text':
    'The CLI of the next orchestrator session will stop asking for anything after this -- no edit, no '
    + 'run, no confirmation. That is the strongest of the six levels, and it needs a reason.',
  'frage.permissionModeAn.tun': 'Raise to bypassPermissions',
  'frage.listeLeer.text':
    'The list is empty after this: {was} are no longer skipped anywhere. File tree, quick-open, content '
    + 'search and editor then also show what used to be missing here.',
  'frage.listeLeer.tun': 'Clear the list',
  'frage.deckel.text':
    'The cap of "{modell}" is set to {stufe} after this. It applies to workers the orchestrator starts '
    + 'without asking -- your own choice stays free. A cap without a reason reads like a technical limit '
    + 'six months from now, which is why one belongs with it.',
  'frage.deckel.tun': 'Set the cap',
  'frage.allesZurueck.text':
    'Every one of the {anzahl} deviations is reset to the shipped default -- including switched-off '
    + 'safeguards, loosened guards, and set caps. Back up the current state first if you want it back.',
  'frage.allesZurueck.tun': 'Reset everything',
  'frage.einsetzen.text':
    '{anzahl} settings are taken from the text and overwrite whatever applies now. Whatever the tool '
    + 'rejects stays as it was.',
  'frage.einsetzen.tun': 'Paste in',

  // --- The names in "what differs on your machine" --------------------------
  // They live here and not a second time in source: the same table, the same
  // words as on the pages.
  'bezeichnung.closeSessionOnWindowClose': 'Close the terminal with the window',
  'bezeichnung.orchestratorHarness': 'Program in the main window',
  'bezeichnung.orchestratorModel': 'Model of the session',
  'bezeichnung.orchestratorEffort': 'How deep the session thinks',
  'bezeichnung.workerEffort': 'Effort level of a worker with none of its own (not in the menu)',
  'bezeichnung.workerModel': 'Model of a worker with none of its own (not in the menu)',
  'bezeichnung.workerLayout': 'Where the worker panes sit',
  'bezeichnung.newSessionDefaultDir': 'Folder a new session starts in',
  'bezeichnung.modelDiscoveryAuto': 'Fetch model catalogs on their own',
  'bezeichnung.maxWorkers': 'Workers at once on this machine',
  'bezeichnung.workerWorktrees': 'Every worker gets its own worktree',
  'bezeichnung.defaultWorkerMachine': 'Where a worker runs when nothing is said',
  'bezeichnung.workerZustellung': 'How a task reaches the worker',
  'bezeichnung.maxWorkerPanesPerTab': 'Workers per tab',
  'bezeichnung.minWorkerPaneWidth': 'Narrowest worker pane',
  'bezeichnung.contextGuardAutostart': 'Context guard starts along',
  'bezeichnung.guardMeldetWorkerStatus': 'The guard types worker notices into the main window',
  'bezeichnung.stallMinutes': 'Report as "stalled" after',
  'bezeichnung.workerSkipPermissions': 'Workers work without their CLI asking first',
  'bezeichnung.orchestratorPermissionMode': 'How much the orchestrator may do without asking',
  'bezeichnung.askPatterns': 'Commands that ask first',
  'bezeichnung.secretExcludeDirs': 'Folders no view enters',
  'bezeichnung.secretExcludePatterns': 'Filenames no view shows',
  'bezeichnung.terminalFontSize': 'Terminal font size',
  'bezeichnung.terminalScrollLines': 'Lines per scroll notch',
  'bezeichnung.logPaths': 'Log paths (display only)',
  'bezeichnung.effortCaps': 'Set effort caps',
  'bezeichnung.guards': 'Switched-off safeguards',
  'bezeichnung.kontextwache': 'Adjusted context guard',
  'bezeichnung.remoteMachines': 'Machines that work along',
  'bezeichnung.ollamaEndpoint': 'Address of the local model server',
  'bezeichnung.meldungen': 'What you get notified about outside the window',
  'bezeichnung.sprache': 'Interface language',
  'bezeichnung.thema': 'Light or dark',
  'bezeichnung.zustandsfarben': 'The session-state colors',
  'bezeichnung.chatAnsicht': 'Show conversation instead of terminal',
  'bezeichnung.chatAnsichtVorgabe': 'New sessions show the conversation',
};

/** Die Tabellen je Sprache. Eine fehlende Sprache faellt auf Deutsch zurueck. */
const TABELLEN: Partial<Record<Sprache, Record<string, string>>> = { de: DE, en: EN };

let aktuelleSprache: Sprache = 'en';

/**
 * Die Sprache umstellen. Sie greift beim naechsten `t()`, also beim naechsten
 * Zeichnen. Ein unbekannter oder fehlender Wert faellt auf die
 * Auslieferungssprache Englisch zurueck.
 */
export function setzeSprache(s: string | undefined): void {
  aktuelleSprache = s === 'de' ? 'de' : 'en';
}

/** Welche Sprache gerade gilt -- fuer die Anzeige, nicht fuer eine Entscheidung. */
export function sprache(): Sprache {
  return aktuelleSprache;
}

/** Traegt die aktuelle Sprache eine eigene Tabelle, oder faellt sie zurueck? */
export function spracheHatTabelle(): boolean {
  return TABELLEN[aktuelleSprache] !== undefined;
}

/**
 * DIE EINE ABFRAGE. Jeder Text der Oberflaeche geht hier durch.
 *
 * Ein fehlender Schluessel wird SICHTBAR gemeldet und nicht durch einen leeren
 * Text ersetzt: eine leere Beschriftung sieht aus wie ein Gestaltungsfehler und
 * bleibt jahrelang stehen, `[fehlender Text: …]` faellt beim ersten Blick auf.
 */
export function t(schluessel: string, werte?: Record<string, string | number>): string {
  const tabelle = TABELLEN[aktuelleSprache] ?? DE;
  const roh = tabelle[schluessel] ?? DE[schluessel];
  if (roh === undefined) return `[fehlender Text: ${schluessel}]`;
  if (!werte) return roh;
  return roh.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (ganz, name: string) => {
    const w = werte[name];
    return w === undefined ? ganz : String(w);
  });
}

/**
 * Wie `t()`, aber fuer Text, den es ABSICHTLICH nicht fuer jedes Feld gibt --
 * das Etikett zum Beispiel beantwortet "wann greift die Aenderung", und diese
 * Frage stellt sich nicht bei einer reinen Anzeigetabelle (anbieter,
 * harnessTabelle, pfade, werkzeuge). Ein fehlender Schluessel heisst hier
 * "kein Text", nicht "Text fehlt" -- anders als bei `t()`, dessen Marke genau
 * die drei PFLICHTebenen (Name, Wirkung, Info) vor einer stillen Luecke
 * bewahren soll. Ein leeres Etikett ist bei diesen vier Feldern keine Luecke,
 * sondern die richtige Antwort.
 */
export function tOpt(schluessel: string, werte?: Record<string, string | number>): string {
  const tabelle = TABELLEN[aktuelleSprache] ?? DE;
  const roh = tabelle[schluessel] ?? DE[schluessel];
  if (roh === undefined) return '';
  if (!werte) return roh;
  return roh.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (ganz, name: string) => {
    const w = werte[name];
    return w === undefined ? ganz : String(w);
  });
}

/** Gibt es zu diesem Schluessel einen Text? Fuer Faelle mit Rueckfall. */
export function hatText(schluessel: string): boolean {
  const tabelle = TABELLEN[aktuelleSprache] ?? DE;
  return tabelle[schluessel] !== undefined || DE[schluessel] !== undefined;
}

/** Alle Schluessel der Auslieferungssprache -- fuer Pruefungen und die Uebersetzung. */
export function alleSchluessel(): string[] {
  return Object.keys(DE).sort();
}
