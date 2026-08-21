// Bauskript. esbuild statt tsc, weil der Renderer xterm.js mitbuendeln muss und
// tsc dafuer einen zweiten Buendler braeuchte. Typen prueft `npm run typecheck`.
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');

const common = { bundle: true, platform: 'node', target: 'node20', sourcemap: false, logLevel: 'info' };

// ATOMARER SCHREIBWEG (Auftrag 2026-08-19, Betriebsfehler: viele native
// JS-Fehlerfenster waehrend eines parallelen Testlaufs, ausgeloest durch
// einen Bau von Hand mitten im Lauf). esbuild schreibt sein `outfile`
// in-place -- gemessen: die Inode-Nummer von dist/main/main.js aendert sich
// ueber einen Bau NICHT, es ist truncate+write auf DIESELBE Datei, kein
// Tempfile-plus-Umbenennen. Ein Electron-Hauptprozess, der GENAU in diesem
// Fenster `require()`t (ein frisch gestarteter Testlauf, waehrend jemand von
// Hand baut), kann die Datei abgeschnitten lesen -- Node wirft dabei eine
// SyntaxError beim Laden, UNCAUGHT, weit bevor irgendein eigener
// Fehler-Handler dieses Programms ueberhaupt existiert (der Handler steht ja
// selbst in der Datei, die gerade nicht vollstaendig geladen werden konnte).
// Electron zeigt fuer genau diesen Fall standardmaessig eine native
// Fehlerbox -- das ist die Box, die alice gesehen hat.
//
// GEMESSEN, nicht vermutet: ein Leser, der waehrend eines echten Baus mit
// realistischer Gegenlast (mehrere gleichzeitige Bauten UND mehrere
// gleichzeitige Leser, wie bei bis zu acht parallelen Testinstanzen) einige
// zehntausend Mal pro Sekunde liest und parst, traf die abgeschnittene Datei
// mehrfach -- jedesmal mit exakt diesem Fehlerbild (SyntaxError). Ein
// einzelner Bau ohne Gegenlast traf das Fenster in derselben Messung kein
// einziges Mal unter rund 30000 Versuchen: schmal, aber nicht Null, und
// genau unter Gegenlast (der Alltag eines parallelen Laufs) am wahrscheinlichsten.
//
// Der Fix: esbuild schreibt NICHT mehr selbst (`write:false`), dieses Skript
// schreibt stattdessen in eine Tempdatei im SELBEN Ordner (also demselben
// Dateisystem) und benennt sie um. `rename()` innerhalb eines Dateisystems
// ist auf macOS wie Linux atomar -- ein gleichzeitiger Leser sieht IMMER
// entweder die alte oder die neue Datei vollstaendig, nie etwas dazwischen.
async function buildAtomic(opts) {
  const ergebnis = await build({ ...opts, write: false });
  for (const datei of ergebnis.outputFiles) {
    mkdirSync(dirname(datei.path), { recursive: true });
    const tmp = `${datei.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, datei.contents);
    renameSync(tmp, datei.path);
  }
  return ergebnis;
}

await buildAtomic({
  ...common,
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(out, 'main/main.js'),
  external: ['electron'],
});

await buildAtomic({
  ...common,
  entryPoints: [join(root, 'src/preload/preload.ts')],
  outfile: join(out, 'preload/preload.js'),
  external: ['electron'],
});

// A9: die Bruecke des Einstellungsfensters. Eigene Datei, weil dieses Fenster
// nichts von dem braucht, was das Hauptfenster bekommt.
await buildAtomic({
  ...common,
  entryPoints: [join(root, 'src/preload/einstellungen-preload.ts')],
  outfile: join(out, 'preload/einstellungen-preload.js'),
  external: ['electron'],
});

// A9: die Oberflaeche des Einstellungsfensters. Ohne minify -- sie zieht kein
// Monaco mit und soll im Fehlerfall lesbar sein.
await buildAtomic({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/einstellungen/einstellungen.ts')],
  outfile: join(out, 'einstellungen/einstellungen.js'),
});

// Das Sitzungsfenster hinter dem Plus: eigene Bruecke, eigene Oberflaeche --
// aus denselben zwei Gruenden wie beim Einstellungsfenster. Die Bruecke reicht
// nur die vier Wege durch, die dieses Fenster braucht; die Oberflaeche bleibt
// ohne minify, weil sie kein Monaco mitzieht und im Fehlerfall lesbar sein soll.
await buildAtomic({
  ...common,
  entryPoints: [join(root, 'src/preload/sitzung-preload.ts')],
  outfile: join(out, 'preload/sitzung-preload.js'),
  external: ['electron'],
});

await buildAtomic({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/sitzung/sitzung.ts')],
  outfile: join(out, 'sitzung/sitzung.js'),
});

// Farben durchreichen (11.08.): EIGENE, winzige Datei statt eines Zusatzes in
// sitzung.ts -- an sitzung.ts arbeitet parallel die Sprachschicht, und die CSP
// dieses Fensters ('script-src self', kein 'unsafe-inline') laesst ohnehin nur
// ein zweites <script src> zu, kein Inline-Skript in index.html.
await buildAtomic({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/sitzung/thema-anwenden.ts')],
  outfile: join(out, 'sitzung/thema-anwenden.js'),
});

// Die CHAT-SITZUNG (12.08.) hat hier bis zum 13.08. drei eigene Buendel gehabt:
// eine Bruecke (preload/chat-preload.ts), eine Oberflaeche und eine winzige
// Themen-Datei -- die Bauform eines eigenen Fensters. Sie liegt jetzt auf der
// Buehne des Hauptfensters (src/main/chatbuehne.ts, Klassendoc), und damit
// bleibt hier NICHTS zu bauen: die Bruecke steckt im Haupt-Preload, die Ansicht
// samt Farben kommt mit dem Buendel des Renderers, und ein Dokument mit eigener
// CSP, das ein zweites <script src> braeuchte, gibt es nicht mehr.

// Die Verbrauchsseite hinter der Token-Anzeige: eigene Bruecke, eigene Oberflaeche -- aus
// denselben zwei Gruenden wie beim Einstellungs- und beim Sitzungsfenster. Die Bruecke reicht
// nur zwei Wege durch (Daten holen, Bereitschaft melden), die Oberflaeche bleibt ohne minify:
// sie zieht kein Monaco mit und soll im Fehlerfall lesbar sein.
await buildAtomic({
  ...common,
  entryPoints: [join(root, 'src/preload/verbrauch-preload.ts')],
  outfile: join(out, 'preload/verbrauch-preload.js'),
  external: ['electron'],
});

await buildAtomic({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/verbrauch/verbrauch.ts')],
  outfile: join(out, 'verbrauch/verbrauch.js'),
});

// Der geführte erste Start (SPEC-V4 3.8): eigene Bruecke, eigene Oberflaeche -- aus denselben
// zwei Gruenden wie bei den drei Geschwistern. Die Bruecke reicht nur drei Wege durch (Daten
// holen, einen Schluessel schreiben, Bereitschaft melden); die Oberflaeche bleibt ohne minify.
await buildAtomic({
  ...common,
  entryPoints: [join(root, 'src/preload/erststart-preload.ts')],
  outfile: join(out, 'preload/erststart-preload.js'),
  external: ['electron'],
});

await buildAtomic({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/erststart/erststart.ts')],
  outfile: join(out, 'erststart/erststart.js'),
});

// MONACO BLEIBT DRAUSSEN (16.08.). Bis heute zog `editor-view.ts` Monaco
// statisch in dieses Buendel: 4,0 MB, und der Fensterstart bezahlte sie jedes
// Mal -- kopflos gemessen, je fuenf Laeufe, 177 ms statt 102 ms bis zur
// Bereitschaftsmeldung des Renderers und 277 MB statt 237 MB im
// Renderer-Prozess, auch wenn nie ein Editor-Tab aufging. Der Editor holt es
// jetzt per `import('./monaco-bootstrap')` beim ersten Tab nach, und dieses
// Plugin sorgt dafuer, dass esbuild diesen einen Import NICHT mitbuendelt,
// sondern als Laufzeit-Import auf die Nachbardatei stehen laesst.
//
// Warum ein Plugin und nicht `external: ['./monaco-bootstrap']`: der Quelltext
// schreibt den Import ohne Endung (so findet ihn `tsc` mit
// `moduleResolution: node`), im fertigen Dokument braucht der Browser aber den
// vollen Dateinamen. Das Plugin macht beides -- Pfad umschreiben UND aussen
// vor lassen.
const monacoDraussen = {
  name: 'monaco-nachladen',
  setup(b) {
    b.onResolve({ filter: /^\.\/monaco-bootstrap$/ }, () => ({ path: './monaco-bootstrap.js', external: true }));
  },
};

await buildAtomic({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/renderer/renderer.ts')],
  outfile: join(out, 'renderer/renderer.js'),
  // '.ttf': Monaco eigenstaendig (E2) bringt sein Symbol-Font (codicon.ttf) ueber
  // ein CSS-url() mit -- ohne diesen Loader bricht der Bau daran ab.
  loader: { '.css': 'css', '.ttf': 'file' },
  // Monaco mit allen Basissprachen wiegt unminifiziert 8,1 MB; minifiziert 3,7 MB
  // (gemessen). Nur dieser eine Bauschritt bekommt minify, main/preload bleiben
  // lesbar -- sie sind winzig und werden nie in einem Profiler gesucht.
  minify: true,
  plugins: [monacoDraussen],
});

// Das nachgeladene Stueck selbst: ESM, weil es per `import()` geholt wird, und
// mit eigenem Stilblatt -- Monacos CSS haengt an Monacos JS-Modulen und wandert
// mit ihnen hierher. `monacoLaden()` in editor-view.ts haengt dafuer ein
// <link rel="stylesheet" href="monaco-bootstrap.css"> ins Dokument; ein Name
// mehr oder weniger an einer der beiden Stellen laesst den Editor schmucklos
// erscheinen, ohne dass irgendetwas abbricht.
await buildAtomic({
  ...common,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/renderer/monaco-bootstrap.ts')],
  outfile: join(out, 'renderer/monaco-bootstrap.js'),
  loader: { '.css': 'css', '.ttf': 'file' },
  minify: true,
});

// Der tmux-Steuerclient noch einmal einzeln, als ESM ohne Electron. Damit
// laesst sich die Naht zwischen Momentaufnahme und Strom direkt messen, statt
// sie durch Fenster und Bildlaufpuffer hindurch zu erraten -- der Puffer im
// Renderer haelt 5000 Zeilen, eine flutende Sitzung schiebt die Naht in
// Sekundenbruchteilen darueber hinaus.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/tmux.ts')],
  outfile: join(out, 'test/tmux.mjs'),
});

// Der Steuerkanal ebenfalls einzeln, aus demselben Grund: den Wettlauf zweier
// gleichzeitig startender Programme um den Socket trifft man nur, wenn beide
// im selben Millisekundenfenster in listen() stehen. Zwei Electron-Starts
// streuen dafuer um Hunderte von Millisekunden; zwei node-Prozesse an einem
// gemeinsamen Startsignal treffen ihn zuverlaessig -- mit demselben Quelltext,
// nicht mit einer Nachstellung.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/control.ts')],
  outfile: join(out, 'test/control.mjs'),
});

// `fuehreAus()` einzeln, aus demselben Grund wie tmux.ts/control.ts: kein
// Electron noetig (nur node:child_process/fs/os/path), und genau hier wurde
// das Warten auf die neue tmux-Session bis zu 20s lang blockierend im
// Hauptfaden verbracht (`spawnSync('sleep', ...)`, behoben 20.08.). Ob die
// Ereignisschleife waehrenddessen wirklich weiterlaeuft, laesst sich nur an
// diesem eigenstaendigen Modul messen, nicht durch das ganze Fenster hindurch.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/befehle.ts')],
  outfile: join(out, 'test/befehle.mjs'),
});

// Das Sessionmodell einzeln, aus demselben Grund wie die beiden davor: Der
// Worker-Zustand (V1) und der Ergebnis-Waechter (V2) lesen ausschliesslich
// Dateien und Prozesse -- kein Electron, kein Fenster. Genau so muessen sie
// auch pruefbar sein: gegen ein eigenes HOME und einen eigenen tmux-Socket,
// ohne dass ein Fenster entsteht. Ueber dist/main/main.js ginge das nicht, das
// zieht Electron mit hinein.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/sessions.ts')],
  outfile: join(out, 'test/sessions.mjs'),
});

await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/results.ts')],
  outfile: join(out, 'test/results.mjs'),
});

// Die Auswertung des Startprotokolls einzeln (21.08.): sie entscheidet, ob eine
// Sitzung gestartet ist und was der Mensch als Grund zu sehen bekommt, wenn
// nicht. Reine Textarbeit ohne Fenster und ohne Electron -- und genau so
// pruefbar, gegen echte wb-code-Ausgaben.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/startprotokoll.ts')],
  outfile: join(out, 'test/startprotokoll.mjs'),
});

// Der Oberflaechen-Zustand einzeln (16.08.): `ui.set()` schreibt ui.json bei
// JEDEM Aufruf (writeFileSync + renameSync). Was ein einzelner Aufruf kostet,
// gehoert gemessen und nicht geschaetzt -- daran haengt, warum das Ziehen der
// Seitenleiste nicht mehr je Mausbewegung speichert.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/uistate.ts')],
  outfile: join(out, 'test/uistate.mjs'),
});

// Die Buendelung der Terminal-Ausgabe einzeln (16.08.): sie haelt zwei Zusagen
// -- die Reihenfolge je Pane und das Abgeben vor jeder Momentaufnahme --, und
// beide muessen an ECHTEN Stuecken messbar sein, ohne dass dafuer ein Fenster
// entsteht. Ueber dist/main/main.js ginge das nicht, das zieht Electron mit.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/ausgabe.ts')],
  outfile: join(out, 'test/ausgabe.mjs'),
});

// Der Editor einzeln, aus demselben Grund: Seine Ausschlussliste kommt seit
// Schritt 7 aus den Einstellungen, und genau das muss gegen ein eigenes HOME
// pruefbar sein -- ohne Fenster und ohne Electron.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/editor.ts')],
  outfile: join(out, 'test/editor.mjs'),
});

// Der Fernabruf (V10) ebenfalls einzeln: `parseFernAusgabe` ist eine reine
// Funktion (Text -> RemoteSnapshot) und `RemotePoller` treibt echte
// Kindprozesse -- beides soll pruefbar sein, ohne dass main.js mit Electron
// mitkommt.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/remote.ts')],
  outfile: join(out, 'test/remote.mjs'),
});

// V13, aus demselben Grund: `parseBudget` ist rein, `BudgetPoller` treibt
// einen echten Kindprozess.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/budget.ts')],
  outfile: join(out, 'test/budget.mjs'),
});

// V12: `ampel.ts` bewertet reine Textdateien, ohne jedes I/O -- trotzdem
// einzeln gebuendelt, damit eine Suite sie ohne main.js pruefen kann.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/ampel.ts')],
  outfile: join(out, 'test/ampel.mjs'),
});

// V14: `reviveCommand`/`darfWiederherstellen` sind reine Funktionen -- kein
// Kindprozess in dieser Datei selbst, der entsteht erst in main.ts.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/revive.ts')],
  outfile: join(out, 'test/revive.mjs'),
});

// Suche/Filter/Chips des Sitzungsfensters (11.08.): reine Funktionen, aus
// sitzung.ts herausgezogen, weil dessen Modul beim Laden sofort das DOM
// anfasst und sich darum nicht nackt in node laden laesst -- siehe den
// Kopfkommentar von src/sitzung/filter.ts.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/sitzung/filter.ts')],
  outfile: join(out, 'test/sitzung-filter.mjs'),
});

// Der geführte erste Start (SPEC-V4 3.8), aus demselben Grund: `ablauf.ts` kennt nur den
// Zustand -- welcher Schritt als nächstes kommt, was ein Überspringen bedeutet, dass
// `erststartErledigt` beim Abschluss GENAU EINMAL geschrieben wird -- kein DOM, kein Electron.
// Genau so muss sich das prüfen lassen.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/erststart/ablauf.ts')],
  outfile: join(out, 'test/erststart-ablauf.mjs'),
});

// Die Lebensspur einzeln (11.08.): `spurDurchgang` ist die REGEL -- welche
// Sitzung als verloren gilt und was als naechster Stand gemerkt wird --, und
// nur `LebensSpur` fasst dafuer eine Datei an. Die Regel muss ohne Electron
// und ohne Dateisystem messbar sein, sonst laesst sich der Absturzfall nur
// nachstellen, indem man einen Rechner abstuerzen laesst.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/lebensspur.ts')],
  outfile: join(out, 'test/lebensspur.mjs'),
});

// Die Freigaben einzeln (2026-08-07): `freigabeErteilen` schreibt die
// Freigabedatei nicht mehr selbst, sondern ruft `wb-freigabe` -- und nur bei
// einem echten Klick. Beides gehoert geprueft, ohne dass ein Fenster entsteht:
// dass ein Aufruf OHNE Klick gar nichts startet, und dass der Aufruf MIT Klick
// genau die Argumente und die Umgebung mitgibt, an denen die Herkunft gemessen
// wird. Ueber dist/main/main.js ginge das nicht, das zieht Electron mit herein.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/freigaben.ts')],
  outfile: join(out, 'test/freigaben.mjs'),
});

// Die Freigabe-ANSICHT einzeln (19.08.), als IIFE fuer ein kopfloses Fenster.
// Geprueft werden muss hier etwas, das nur ein echtes Dokument hat: dass der
// getippte Satz im Begruendungsfeld, der Fokus und die Schreibmarke ein
// Neuzeichnen ueberleben. Ueber dist/renderer/renderer.js ginge das nicht --
// das Buendel zieht xterm und die ganze Buehne mit und sucht beim Laden sofort
// eine Bruecke zum Hauptprozess. IIFE statt ESM, weil Chromium ein Modul von
// file:// nicht laedt (Herkunft 'null'); shell/tests/test-app-freigabe-eingabe.sh
// laedt das Buendel als gewoehnliches <script> und greift ueber den globalen
// Namen darauf zu.
await buildAtomic({
  ...common,
  format: 'iife',
  globalName: 'AwbFreigabenAnsicht',
  platform: 'browser',
  target: 'chrome120',
  entryPoints: [join(root, 'src/renderer/freigaben-view.ts')],
  outfile: join(out, 'test/freigaben-view.js'),
  loader: { '.css': 'css' },
});

// Die Konfiguration einzeln: Die Musterliste der Rueckfrage-Stufe steht als
// Vorgabe hier UND in hooks/lib/ask_muster.py -- damit Hook und Programm
// einzeln lauffaehig bleiben. Zwei Kopien laufen auseinander, wenn niemand
// hinsieht, also sieht shell/tests/test-app-muster.sh hin und vergleicht sie
// gegeneinander. Dafuer muss die Vorgabe ohne Electron lesbar sein.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/config.ts')],
  outfile: join(out, 'test/config.mjs'),
});

// Die PATH-Herrichtung einzeln (07.08.): sie entscheidet, ob dieses Programm
// `tmux` und die `wb-*`-Werkzeuge ueberhaupt findet, wenn es aus dem Finder
// gestartet wurde. Genau dieser Fall muss messbar sein -- in einer Umgebung
// wie der von launchd (`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`), und ohne
// dass dafuer ein Fenster oder Electron entsteht.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/pfad.ts')],
  outfile: join(out, 'test/pfad.mjs'),
});

// Die Einstellungen einzeln, aus genau demselben Grund wie die Konfiguration
// darueber: `VORGABEN` ist die AUSLIEFERUNG des Programms und steht ein zweites
// Mal als DEFAULTS in shell/wb-state. Im Kopf der Tabelle steht "Wer sie
// aendert, aendert BEIDE Stellen" -- ein Satz, der ohne Pruefung nur ein Wunsch
// ist. shell/tests/test-vorgaben-paritaet.sh vergleicht beide, und dafuer muss
// die Tabelle ohne Electron lesbar sein.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/einstellungen.ts')],
  outfile: join(out, 'test/einstellungen.mjs'),
});

// Thema und Zustandsfarben einzeln (Farben durchreichen, 11.08.): die
// Kontrastrechnung (WCAG, HSL-Aufhellung/-Abdunklung) ist reine Zahlenlogik
// ohne jedes Electron-I/O und soll es bleiben -- ein eigenes Buendel haelt sie
// mit blossem `node` pruefbar, dieselbe Bauform wie bei `einstellungen.ts`
// direkt darueber, von dem diese Datei ihrerseits liest.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/thema.ts')],
  outfile: join(out, 'test/thema.mjs'),
});

// Der Worker-Zustand einzeln, und diesmal aus einem eng umrissenen Grund:
// `STALL_SECONDS_DEFAULT` ist eine ANGEMELDETE Doppelung -- dieselbe Schwelle
// steht als `stallMinutes` in shell/wb-state, nur in einer anderen Einheit.
// Die Beziehung mal 60 pruefte bis zum 06.08. niemand: ein Schluessel-fuer-
// Schluessel-Vergleich sieht sie nicht, weil die beiden Namen verschieden sind
// und die Zahlen es auch sein muessen. shell/tests/test-vorgaben-paritaet.sh
// rechnet sie gegeneinander, und dafuer muss die Konstante ohne Electron
// lesbar sein.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/workerstate.ts')],
  outfile: join(out, 'test/workerstate.mjs'),
});

// Die Startseite einzeln (07.08.): `startseitenKarten()` uebersetzt das
// Sessionmodell in die Karten, die `extension/src/homeHtml.ts` zeichnet -- und
// genau an dieser Naht stand bis heute ein Wort, das die Anzeige nicht kannte.
// Das ETIKETT im fertigen HTML muss deshalb messbar sein, nicht nur der Typ:
// ein Typpruefer sieht nicht, was am Ende dasteht. Ohne Fenster und ohne
// Electron geht das nur ueber ein eigenes Buendel.
//
// Als EINZIGES dieser Testbuendel in CommonJS statt ESM, und das hat einen
// Grund: seiten.ts sucht den Symbolordner ueber `__dirname` (medienOrdner()).
// Den gibt es in einem ESM-Buendel nicht, der Aufruf wuerde mit einem
// ReferenceError abbrechen, bevor die erste Karte entsteht.
await buildAtomic({
  ...common,
  format: 'cjs',
  entryPoints: [join(root, 'src/main/seiten.ts')],
  outfile: join(out, 'test/seiten.cjs'),
});

// Die Rechenlogik der Verbrauchsseite einzeln, aus demselben Grund wie die Buendel darueber:
// Summen, Filter, der Vergleich zweier Zeitraeume und die Entscheidung, ob Cache-Lesen eine
// eigene Achse braucht, sind REINE Funktionen -- kein DOM, kein Electron, keine Datei. Genau so
// muessen sie pruefbar sein. Ueber dist/verbrauch/verbrauch.js ginge das nicht: das ist ein
// Browser-Buendel, das beim Laden sofort ein Fenster sucht.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/verbrauch/rechnen.ts')],
  outfile: join(out, 'test/verbrauch-rechnen.mjs'),
});

// Die Beschriftungstabelle ebenfalls einzeln: dass jeder Schluessel, den die Oberflaeche
// abfragt, auch einen Text hat, ist eine Zusage, die nur ein Test halten kann -- ein
// Typpruefer sieht eine Zeichenkette, keinen fehlenden Tabelleneintrag.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/verbrauch/texte.ts')],
  outfile: join(out, 'test/verbrauch-texte.mjs'),
});

// Die Benachrichtigungen einzeln (SPEC-V4 3.5): `melden()`, `NeuheitsFilter`
// und `SchwellenMelder` sind die Entscheidung, wer ueberhaupt meldet -- ohne
// Electron pruefbar, mit einer Attrappe statt osascript/notify-send/afplay/
// paplay/HTTP-POST fuer die Sendewege selbst.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/melden.ts')],
  outfile: join(out, 'test/melden.mjs'),
});

// Die Chat-Ansicht (SPEC-V4 Abschnitt 6), zweimal einzeln und aus demselben
// Grund wie alles darueber: `chat/rein.ts` buendelt die vier Adapter ohne DOM
// -- Registry-Urteil, Formatverteiler, Zuordnung, SSE- und ACP-Rahmen --, und
// `main/chatquelle.ts` besorgt ihnen ihren Text aus Dateien, Prozessen und
// einem lokalen Server. Beides muss ohne Electron pruefbar sein: der erste Teil
// ist reine Umformung, der zweite fasst nur Dateien und Kindprozesse an, und
// ueber dist/main/main.js ginge keins von beiden, das zieht Electron mit.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/chat/rein.ts')],
  outfile: join(out, 'test/chat-rein.mjs'),
});

await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatquelle.ts')],
  outfile: join(out, 'test/chatquelle.mjs'),
});

// Der enge Registry-Leser hinter dem Chat-Schalter im Einstellungsfenster
// (`chatQuellen`, SPEC-V4 6.3), aus einstellungsfenster.ts herausgeloest und
// einzeln gebuendelt: die Datei fasst nur die Registry an, kein Fenster.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatschalter.ts')],
  outfile: join(out, 'test/chatschalter.mjs'),
});

// Der Schluesselbund einzeln (11.08.): `schluesselSetzen`/`schluesselVorhanden`
// nehmen ihren Zugriff ueber `SchluesselZugriff` entgegen (dieselbe Naht wie
// `Sendewege` in melden.ts) -- ein Test ersetzt ihn durch eine Attrappe und ruehrt
// nie den echten Schluesselbund an. Ohne Electron pruefbar: die Datei fasst nur
// `security` ueber `child_process.spawnSync` an, sonst nichts.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/schluesselbund.ts')],
  outfile: join(out, 'test/schluesselbund.mjs'),
});

// Der Umbau des Ereignisstroms einer Chat-Sitzung (chat/sdkstrom.ts) und die
// Buchfuehrung dahinter (main/chatregistry.ts) einzeln gebuendelt: beide sind
// reine Umformung beziehungsweise reines Dateihandwerk, beide muessen ohne
// Electron gegen die echten Mitschnitte pruefbar sein. Dazu die Befehlszeile
// aus main/chatsitzung.ts -- das eine Stueck der Prozess-Steuerung, dessen
// Fehler still bliebe (ein vergessenes Flag macht die Anzeige nur aermer).
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/chat/sdkstrom.ts')],
  outfile: join(out, 'test/chat-sdkstrom.mjs'),
});

await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatregistry.ts')],
  outfile: join(out, 'test/chatregistry.mjs'),
});

await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatsitzung.ts')],
  outfile: join(out, 'test/chatsitzung.mjs'),
});

// Die BUEHNE selbst (16.08.), aus demselben Grund wie ihre drei Nachbarn
// darueber: Sie bekommt Buchfuehrung, Fenster, Werkstatt und den Startbefehl
// von aussen (Konstruktor) und fasst Electron nur als TYP an -- damit sind
// ihre zwei Zusagen ohne Fenster messbar: dass ein Stand aus vielen
// stdout-Stuecken GESAMMELT hinausgeht statt je Stueck einmal, und dass
// Schloss und Werkstatt erst fallen, wenn der Kindprozess wirklich weg ist.
// Ueber dist/main/main.js ginge beides nicht, das zieht Electron mit herein.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatbuehne.ts')],
  outfile: join(out, 'test/chatbuehne.mjs'),
});

// Die zwei Stuecke hinter der Vervollstaendigung im Eingabefeld (Punkt 3,
// 12.08.), beide ohne DOM pruefbar: `chatbuehne/vervollstaendigung.ts`
// entscheidet an Text und Schreibmarke, WAS vorzuschlagen ist (und filtert die
// Listen), `main/chatdateien.ts` besorgt die Dateiliste ueber `git ls-files`.
// Der Klassenteil der ersten Datei fasst DOM an, wird hier aber nur gebuendelt,
// nicht ausgefuehrt -- die Tests rufen ausschliesslich die reinen Funktionen.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/chatbuehne/vervollstaendigung.ts')],
  outfile: join(out, 'test/vervollstaendigung.mjs'),
});

await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatdateien.ts')],
  outfile: join(out, 'test/chatdateien.mjs'),
});

// Die Werkstatt einer Chat-Sitzung (Punkt 1, 12.08.): sie fasst NUR tmux an,
// ueber `spawnSync`, und laesst sich damit gegen einen eigenen Testsocket
// pruefen -- ohne Electron und ohne die laufende Sitzung eines Menschen.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatwerkstatt.ts')],
  outfile: join(out, 'test/chatwerkstatt.mjs'),
});

// Die Kontextwache der Chat-Sitzungen (15.08.), in zwei Stuecken und aus
// demselben Grund getrennt gebuendelt: `chat/wache.ts` ist die reine
// Entscheidung (keine Uhr, keine Datei, kein Prozess) und laesst sich damit
// gegen eine gestellte Uhr vollstaendig durchspielen; `main/chatwache.ts`
// fasst nur Dateien an und bekommt Sitzung, Uhr und Schwellen von aussen. Eine
// Wache, die man nicht ohne echte Sitzung pruefen kann, wird nie geprueft.
await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/chat/wache.ts')],
  outfile: join(out, 'test/chat-wache.mjs'),
});

await buildAtomic({
  ...common,
  format: 'esm',
  entryPoints: [join(root, 'src/main/chatwache.ts')],
  outfile: join(out, 'test/chatwache.mjs'),
});

mkdirSync(join(out, 'renderer'), { recursive: true });
cpSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
mkdirSync(join(out, 'einstellungen'), { recursive: true });
cpSync(join(root, 'src/einstellungen/index.html'), join(out, 'einstellungen/index.html'));
mkdirSync(join(out, 'sitzung'), { recursive: true });
cpSync(join(root, 'src/sitzung/index.html'), join(out, 'sitzung/index.html'));
mkdirSync(join(out, 'verbrauch'), { recursive: true });
cpSync(join(root, 'src/verbrauch/index.html'), join(out, 'verbrauch/index.html'));
mkdirSync(join(out, 'erststart'), { recursive: true });
cpSync(join(root, 'src/erststart/index.html'), join(out, 'erststart/index.html'));

// EIN BAU UNTER EINER LAUFENDEN APP WIRD GESAGT (16.08.).
//
// `Contents/Resources/app` des Programmbuendels ist ein VERWEIS auf diesen
// Baum (tools/buendel-bauen.sh) -- ein Bau hier aendert also den Stand, aus
// dem die laufende App liest. Ihr Hauptprozess hat seinen Code beim Start
// geladen und behaelt ihn; ihre FENSTER laden ihren erst beim Aufbau. Wer
// baut, waehrend sie laeuft, bekommt beim naechsten neuen Fenster (Chat,
// Einstellungen, Sitzung, `reload`) einen Renderer von JETZT gegen einen
// Hauptprozess von VORHIN -- zwei Staende in einem Programm, und der
// Unterschied faellt erst auf, wenn etwas Unerklaerliches passiert.
//
// Hier steht nur der Hinweis. Er kostet nichts und macht aus einer stillen
// Falle eine Zeile, die man gelesen hat. Wer den ganzen Weg will, findet den
// Vorschlag einer Baumarke im Ergebnis vom 16.08.: dieselbe Kennung in
// `dist/` und im laufenden Hauptprozess, verglichen vor jedem neuen Fenster.
// Gewarnt wird nur, wenn das Buendel wirklich auf DIESEN Baum zeigt: ein Bau in
// einem Arbeitsbaum nebenan geht die laufende App nichts an, und eine Warnung,
// die zu oft kommt, liest bald niemand mehr.
try {
  const { execFileSync } = await import('node:child_process');
  const { realpathSync } = await import('node:fs');
  const buendel = realpathSync('/Applications/Agent Workbench.app/Contents/Resources/app');
  if (buendel !== realpathSync(root)) throw new Error('anderer Baum');
  const laeuft = execFileSync('pgrep', ['-f', 'Agent Workbench.app/Contents/MacOS'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (laeuft.length) {
    process.stderr.write(
      `\nHINWEIS: Die Agent Workbench laeuft gerade (PID ${laeuft.join(', ')}) und liest live aus\n`
      + `diesem Baum. Ihr Hauptprozess bleibt auf dem alten Stand, jedes NEU aufgebaute Fenster\n`
      + `bekommt den neuen -- bitte die App neu starten, bevor Du weiterprobierst.\n\n`,
    );
  }
} catch {
  // Kein Buendel, ein anderer Baum, oder pgrep findet nichts (Rueckgabe 1):
  // dann gibt es auch nichts zu warnen. Ein Bau scheitert daran nie.
}
