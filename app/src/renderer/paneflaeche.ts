// DIE PANE-FLAECHE: die Terminals, ihre Kacheln, ihr Rueckblick, ihr Rad.
//
// WARUM DIESE DATEI EXISTIERT (03.09.2026). Bis zum Neubau der Oberflaeche
// stand alles hier Stehende mitten in `renderer.ts`, zwischen dem Zeichnen der
// Sessionleiste und dem der Workerleiste. Die Oberflaeche darum ist neu
// entworfen worden, diese Schicht NICHT: sie ist gemessenes Verhalten --
// Bildlauf, Groessensprung, Alternativschirm, Mausverfolgung, Rueckblick --,
// und vier Suiten halten es fest (test-app-scroll-renderer.sh,
// test-app-groessensprung.sh, test-app-rechts-takt.sh, test-app-tab-kachel.sh).
// Der Umzug ist deshalb ein Umzug und keine Umschrift: die Rechnungen, die
// Schwellen und die Begruendungen stehen unveraendert, wie sie erarbeitet
// wurden. Wer hier etwas aendern will, aendert Verhalten -- und muss messen.
//
// WAS DIESE DATEI NICHT WEISS: welche Sitzung gewaehlt ist, wie ein Worker
// heisst, was in der linken Leiste steht. Beides holt sie sich ueber
// `PaneflaecheUmgebung` von der Oberflaeche darum; sie kennt nur Panes,
// Kacheln und Zellen.
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
// Die Chat-Ansicht EINES Panes (SPEC-V4 Abschnitt 6). Sie liegt ueber dem
// Terminal desselben Panes und gehoert damit hierher, nicht in die Oberflaeche.
import { kachelReihen } from '../main/capacity';
import { ChatAnbindung } from '../chat/anbindung';
import '../chat/ansicht.css';
import { chatPfadHaken } from './chatdatei';

export interface SessionPayload {
  session: string;
  cols: number;
  rows: number;
  sizePolicy: string;
  panes: { paneId: string; width: number; height: number; active: boolean }[];
  activePane: string;
  initialContent: string;
}

export interface PaneBox { paneId: string; x: number; y: number; cols: number; rows: number }
export interface LayoutPayload {
  art: 'pane' | 'tab';
  /**
   * Ob die geltende Flaeche VORGEGEBEN wurde (Steuerkanal) statt von der Buehne
   * gemeldet. Dann fordert die Buehne nichts nach -- eine Vorgabe, die das
   * Fenster gleich wieder ueberschreibt, waere keine.
   */
  vorgegeben?: boolean;
  cols: number;
  rows: number;
  aktiv: string;
  panes: PaneBox[];
  inhalt: Record<string, string>;
  /** Der Rueckblick eines Panes -- kommt nur beim ERSTEN Zeichnen mit. */
  historie?: Record<string, string>;
  /** Ob die Anwendung im Pane die Maus verfolgt, und in welcher Kodierung. */
  maus?: Record<string, { an: boolean; sgr: boolean }>;
  /** Nur fuer 'tab': Spalten des Gitters, aus der Kapazitaetsrechnung. */
  spalten?: number;
  /**
   * Ob die Buehne frei kacheln darf -- gesetzt, wenn jeder gezeigte Pane sein
   * eigenes tmux-Fenster hat und tmux deshalb nichts mehr anzuordnen hat
   * (main.ts, `tabZeigen`).
   */
  frei?: boolean;
  /**
   * Nur fuer 'tab': die Fenstergroesse, in der die Kaesten der Panes stehen.
   * Ist sie da, kommt die Kachel jedes Panes aus seiner WIRKLICHEN Lage in
   * diesem Fenster statt aus seinem Platz in der Anforderung -- siehe
   * `kachelAusRaster` und main.ts, `tabZeigen`.
   */
  raster?: { cols: number; rows: number };
  /**
   * Wie `raster`, aber der Tab zeigt nur einen TEIL der Panes dieses Fensters
   * (Layout 'split': der Orchestrator sitzt mit im Fenster). Die Lage der
   * gezeigten Panes ist dann immer noch die von tmux -- es fehlen nur Zellen
   * dazwischen, und die werden zusammengeschoben.
   */
  rasterTeil?: { cols: number; rows: number };
  /** Angeforderte Panes, die es nicht (mehr) gibt -- mit dem Grund. */
  fehlend?: { pane: string; grund: string }[];
}


/**
 * Was die Flaeche von der Oberflaeche um sie herum braucht -- und zwar nur
 * das. Vier Fragen, keine Datenstruktur: die Flaeche haelt kein Modell, weil
 * sonst zwei Stellen im Fenster entscheiden muessten, welche Sitzung gilt.
 */
/** Was in der Kopfzeile eines Panes steht. Leere Felder bleiben leer. */
export interface PaneKopf {
  /** Der Name des Workers. Leer heisst: die rohe Kennung des Panes. */
  name: string;
  /** Die Zustandsklasse fuer den Punkt -- `laeuft`, `will`, `fern`, `ruhig`. */
  zustand: string;
  /** Die Modellkennung. Leer, wenn die Bruecke keine kennt. */
  modell: string;
  /** Der Tokenstand, kompakt. Leer, wenn ihn dieser Harness nicht anzeigt. */
  tokens: string;
}

export interface PaneflaecheUmgebung {
  /** Was in der Kopfzeile dieses Panes steht. */
  kopfZuPane(paneId: string): PaneKopf;
  /** Ein anderer Pane hat die Tastatur bekommen. */
  aufAktivemPane(paneId: string): void;
  /** Eine Lage ist gezeichnet -- Art, Groesse und wieviele Panes darin liegen. */
  aufLage(p: LayoutPayload): void;
  /** Eine Sitzung ist angehaengt worden. */
  aufSitzung(p: SessionPayload): void;
  /**
   * Der Zoom-Knopf der Kopfzeile. `gezoomt` sagt, in welchem Zustand die
   * Flaeche gerade ist -- die Oberflaeche entscheidet daraus, ob sie diesen
   * Pane gross zeigt oder zu den Kacheln zurueckkehrt. Hier wird nichts
   * entschieden: was auf der Flaeche liegt, sagt der Hauptprozess.
   */
  aufZoom(paneId: string, gezoomt: boolean): void;
}

const STILL: PaneflaecheUmgebung = {
  kopfZuPane: (id) => ({ name: id, zustand: 'ruhig', modell: '', tokens: '' }),
  aufAktivemPane: () => {},
  aufLage: () => {},
  aufSitzung: () => {},
  aufZoom: () => {},
};
let umgebung: PaneflaecheUmgebung = STILL;

/**
 * Zwei Zeichen aus einem Namen -- fuer das Schild eines Panes, das fuer den
 * ganzen Namen zu schmal ist.
 */
function kuerzel(name: string): string {
  const teile = name.split(/[-_. ]+/).filter(Boolean);
  if (teile.length >= 2) return (teile[0][0] + teile[1][0]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}

/**
 * Was die Flaeche zuletzt gezeichnet hat -- rein diagnostisch, fuer
 * `awb-ctl ui`. Keine dieser drei Zeichenketten steht je im Fenster.
 */
const auskunft = { pane: '-', groesse: '-', ansicht: '-' };

/**
 * DIE HOEHE DER KOPFZEILE EINER KACHEL, in Bildpunkten (03.09.2026).
 *
 * Fest und nicht an die Zellhoehe gebunden: die Zeile traegt einen Punkt, zwei
 * Beschriftungen und einen Knopf, und bei Schriftgroesse 8 waere eine Zelle
 * dafuer 9 Bildpunkte hoch. 22 ist die kleinste Hoehe, in der ein 12 Bildpunkte
 * grosses Symbol mit Polsterung steht, und liegt unter den 24, die der Auftrag
 * als Obergrenze nennt.
 */
const KOPFHOEHE = 22;

/**
 * DIE FUGE ZWISCHEN ZWEI KACHELN, in Bildpunkten (04.09.2026).
 *
 * Bis dahin stiessen die Kacheln aneinander und wurden durch eine Haarlinie
 * getrennt -- das Gitternetz, gegen das der Auftrag steht. Jetzt ist jede
 * Kachel eine Karte mit zehn Bildpunkten Eckenradius, und dazwischen liegen
 * genau diese vier Bildpunkte Fenstergrund: dieselbe Fuge wie zwischen den
 * grossen Karten des Fensters (`--fuge` in werkbank.css).
 *
 * DIE RECHNUNG BLEIBT SONST UNVERAENDERT. Die Fuge wird VOR der Zellenrechnung
 * abgezogen, nicht hinterher von der fertigen Kachel: zoege man sie hinterher
 * ab, verloere der Pane die letzte Spalte oder Zeile, die tmux ihm schon
 * zugeteilt hat. So bekommt jede Kachel eine ganze Zahl Zellen wie bisher,
 * nur auf einer um die Fugen kleineren Flaeche.
 */
const FUGE = 4;

/**
 * WIEVIELE KACHELZEILEN die zuletzt gezeichnete Lage hat. Daraus faellt der
 * Abzug fuer die Kopfzeilen: jede Kachelzeile kostet EINE Kopfzeile, nicht
 * jede Kachel. Vor der ersten Lage gilt eine Zeile -- das ist der Zustand
 * "ein Pane fuellt die Flaeche", und der stimmt beim Start.
 */
let kachelZeilen = 1;

/** Welcher Pane die Tastatur bekommt. */
let aktiverPane = '';


let schriftgroesse = 13;

/**
 * Wie lange xterm einen Bildlauf interpoliert. Wirkt nur noch dort, wo EIN
 * Ereignis in einem Bild ankommt -- die Rastung eines Mausrades; bei einem
 * Trackpad-Fluss wird sie beim Abgeben abgeschaltet (siehe rollenSpaeter).
 */
const SCROLL_ANIMATION_MS = 10;
/**
 * Bis zu diesem Abstand gilt ein Rad-Ereignis als Teil derselben Bewegung.
 * Grosszuegig gewaehlt: ein Trackpad liefert alle 8 bis 16 ms, ein Mausrad im
 * schnellsten Fall alle 30 bis 50 ms -- 60 ms trennt beides, ohne dass ein
 * einzelner Ausreisser im Ereignisstrom die Bewegung zerschneidet.
 */
const ROLLEN_FLUSS_MS = 60;

/**
 * Grund und Schrift des Terminals aus den Rollen lesen (main/thema.ts, ueber
 * tokens.css) statt fest zu verdrahten -- vorher blieb JEDES Terminal auch im
 * Hellmodus dunkel (theme war ein Literal, nie an data-thema gebunden). xterm
 * traegt keine CSS-Variablen selbst, deshalb hier einmal gelesen und bei jedem
 * Themawechsel neu (siehe `terminalThemaAnwenden`, von `themaAnwenden` gerufen).
 */
/**
 * Die sechzehn ANSI-Namen, in derselben Reihenfolge, in der main/thema.ts sie
 * als `--term-*` ausgibt. xterm nimmt sie einzeln in seinem Thema entgegen.
 */
const ANSI_NAMEN = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

function terminalFarben(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  // ERHOBEN, NICHT GRUND (03.09.2026, mit dem Neubau der Oberflaeche). Bis
  // dahin trug das Terminal denselben Ton wie die Flaeche darunter, und damit
  // war nicht zu sehen, wo eine Kachel aufhoert -- drei Panes nebeneinander
  // lasen sich als ein einziges dunkles Feld mit ein paar Haarlinien darin.
  // Jetzt liegt die Kachel eine Stufe ueber ihrem Grund, so wie jede andere
  // Karte im Fenster; `.panekasten` in werkbank.css traegt denselben Wert,
  // damit der Rand um den gezeichneten Bereich nicht heraussticht.
  // Der Kontrast des Terminaltextes bleibt weit ueber der Schwelle: `--schrift`
  // auf `--erhoben` traegt dunkel 10,9:1 und hell 13,1:1.
  //
  // UND DIE SECHZEHN ANSI-FARBEN DAZU (05.09.2026, Regelbruch 11). Sie standen
  // hier nie, also galt xterms eigene Palette -- gebaut fuer einen dunklen
  // Grund. Im hellen Thema war `\e[1;37m` (#eeeeec auf #eceef2) unsichtbar, und
  // damit fehlte die fette Kopfzeile, mit der sich ein Agent im Pane meldet.
  // Welche Werte je Thema gelten, entscheidet main/thema.ts; hier werden sie
  // nur gelesen. Fehlt eine der Variablen, bleibt es fuer diese Farbe bei
  // xterms Vorgabe -- eine halbe Palette waere schlimmer als gar keine.
  const farben: Record<string, string> = {
    background: cs.getPropertyValue('--erhoben').trim() || '#1e232b',
    foreground: cs.getPropertyValue('--schrift').trim() || '#d8dee9',
  };
  for (const name of ANSI_NAMEN) {
    const wert = cs.getPropertyValue(`--term-${name}`).trim();
    if (wert) farben[name] = wert;
  }
  return farben;
}

const TERMOPT = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: schriftgroesse,
  theme: terminalFarben(),
  scrollback: 5000,
  cursorBlink: false,
  allowProposedApi: true,
  /**
   * Ohne das hier springt jeder Rad-Schritt den Ausschnitt sofort um seine
   * Zeilen (bis zu RAD_DECKEL = 6, siehe radZeilen) -- das ist das
   * "sprunghaft", das alice gemeldet hat, unabhaengig von der Bildzeit:
   * `Terminal.scrollLines()`, genau der Aufruf im Rad-Haken unten, interpoliert
   * den scrollTop des Ausschnitts nur, wenn dieser Wert gesetzt ist (xterm.js,
   * Viewport.ts).
   *
   * NICHT die uebliche Vorgabe von 100ms (VS Code u.a.): gemessen (12.08.,
   * test-app-scroll-leistung.sh mit einem Rad-Ereignis je Bild, dauerhaft --
   * ein zuegiger Wisch, keine Uebertreibung) faellt `scrollLines()` bei jedem
   * neuen Ereignis auf die GERADE ERST interpolierte Position zurueck und
   * faengt von dort einen neuen, kurzen Lauf an, statt den vorigen Zielpunkt
   * weiterzufuehren. Bei andauerndem Rad-Fluss schneller als die Animation
   * bleibt der Ausschnitt dadurch systematisch zurueck: bei 100ms erreichte er
   * in 150 Bildern nur 76 von 900 erwarteten Zeilen (8 %) -- das waere kein
   * sanfteres Scrollen, sondern ein haengendes. Bei 10ms waren es 741 von 900
   * (82 %), nah genug am Original, um unter Dauerfluss nicht aufzufallen. Fuer
   * den haeufigen Fall -- einzelne Rad-Notches mit Luft dazwischen -- reichen
   * 10ms trotzdem, um aus dem Sprung eine kurze Bewegung zu machen: die Pause
   * bis zum naechsten Ereignis ist dort um ein Vielfaches laenger als die
   * Animation selbst.
   */
  smoothScrollDuration: SCROLL_ANIMATION_MS,
  /**
   * Bewusst bei der Vorgabe 1 belassen, aber ausgeschrieben statt implizit:
   * dieser Wert wirkt nur in `Viewport.handleWheel`, und genau dorthin kommt
   * ein Rad-Ereignis in diesem Fenster so gut wie nie -- der eigene Haken
   * unten (`attachCustomWheelEventHandler`) faengt jedes Ereignis auf dem
   * Normalschirm ab und ruft `scrollLines()` selbst mit der ueber
   * `scrollZeilen`/RAD_DECKEL bemessenen Zeilenzahl. Nur auf dem
   * Alternativschirm ohne Mausverfolgung (Editor, weniger, top) gibt xterm das
   * Ereignis an seine eigene Wandlung in Pfeiltasten weiter, und dort ist die
   * Vorgabe die richtige -- eine andere Zahl haette dort eine Wirkung, die an
   * keiner anderen Stelle dieses Fensters vorkommt und niemand vermuten wuerde.
   */
  scrollSensitivity: 1,
};

/** Welcher Renderer je Pane wirklich zeichnet -- siehe ladeRenderer(). */
const rendererJePane = new Map<string, 'webgl' | 'canvas' | 'dom'>();
/** Schluessel des Mass-Terminals in `rendererJePane` -- kein echter Pane hat je diese Kennung. */
const MASS_TERMINAL_ID = '__mass__';
/**
 * Das GELADENE WebGL-Stueck je Terminal, damit es sich auch wieder abwerfen
 * laesst. Gebraucht wird das an genau einer Stelle: `__awb.webglSperren()`
 * (nur fuer Tests) stellt damit auch schon bestehende Terminals auf Canvas um
 * -- siehe die Begruendung dort. Eingetragen wird ausschliesslich in
 * `ladeRenderer()`, der einzigen Stelle, die WebglAddon ueberhaupt laedt.
 */
const webglJeTerminal = new Map<string, { addon: WebglAddon; term: Terminal }>();

/**
 * Canvas laden und festhalten, was jetzt wirklich zeichnet. Steht hier oben und
 * nicht mehr nur in `ladeRenderer()`, weil `webglSperren()` denselben Weg
 * braucht -- zwei Kopien davon liefen genau in dem Moment auseinander, in dem
 * es darauf ankaeme.
 */
function canvasLaden(paneId: string, t: Terminal): void {
  try {
    t.loadAddon(new CanvasAddon());
    rendererJePane.set(paneId, 'canvas');
  } catch {
    // Weder WebGL noch Canvas verfuegbar -- der eingebaute DOM-Renderer
    // zeichnet weiter, nur ohne Beschleunigung. Kein Fehlerfall: xterm
    // selbst braucht keinen der beiden Zusaetze, um etwas zu zeigen.
    rendererJePane.set(paneId, 'dom');
  }
}

/**
 * WebGL zuerst, mit Rueckfall auf Canvas und zuletzt den blossen DOM-Renderer
 * von xterm selbst (12.08.). Ohne einen der beiden Zusaetze zeichnet xterm 5.5
 * jede sichtbare Zeile als eigenes DOM-Element neu, sobald sich der Ausschnitt
 * verschiebt -- bei einem Bildlaufpuffer von 5000 Zeilen der uebliche Grund
 * fuer haekeliges Scrollen auf langsamerer Hardware als der, auf der gemessen
 * wurde (Bericht vom 12.08.: auf dieser Maschine blieb sogar der DOM-Renderer
 * unter 16,7ms je Bild, auch bei drei vollen Panes mit laufendem Zustrom).
 *
 * Der Grafikkontext kann jederzeit wegbrechen -- Treiberwechsel, zu viele
 * gleichzeitige Kontexte, ein ausgelagerter Tab. Ohne die Behandlung des
 * `webglcontextlost`-Ereignisses (hier ueber `onContextLoss`) bliebe das
 * Terminal danach schwarz, und das faellt erst Tage spaeter auf.
 *
 * GILT AUCH FUERS MASS-TERMINAL, nicht nur fuer echte Panes (12.08., gemessen
 * in test-app-schriftgroesse.sh): der WebGL/Canvas-Zusatz misst eine Zellbreite
 * ueber `measureText` auf einer Canvas, der DOM-Renderer ueber die gerenderte
 * Breite eines echten Zeichens im Baum -- beides landet zwar nah beieinander,
 * aber nicht auf dem Bildpunkt. Zeichnet das Mass-Terminal weiter pur ueber
 * das DOM, waehrend jeder echte Pane WebGL bekommt, laufen die beiden
 * Zellmasse auseinander, auf die sich Spalten, Zeilen und Kacheln stuetzen --
 * genau die Klasse Fehler, vor der der Kommentar bei `flaecheInZellen`
 * (EINE ZELLGROESSE, NICHT ZWEI, 06.08.) schon einmal gewarnt hat, nur ueber
 * einen neuen Weg. Beide Terminals brauchen denselben Renderer.
 */
function ladeRenderer(paneId: string, t: Terminal): void {
  const aufCanvas = (): void => canvasLaden(paneId, t);
  // SOFORTMASSNAHME 2026-08-16, AUFGEHOBEN 2026-08-19 auf Wort des Nutzers. Die
  // Geschichte bleibt hier stehen, weil sie erklaert, wofuer diese Konstante
  // ueberhaupt da ist -- und weil der Weg zurueck eine Zeile ist.
  //
  // Damals: alice konnte nicht mehr arbeiten -- Text wurde ueber alten
  // Inhalt geschrieben, ohne dass die Zeile geloescht wurde, zwei
  // Bildschirmzustaende verschmolzen (Belege: ~/Downloads/Fehlerhaft*.png,
  // 18:24-18:28). Der beschleunigte Renderer kam am 12.08. mit 21219e6 dazu,
  // und genau diese Fehlerbilder sind bei xterm.js unter WebGL bekannt, vor
  // allem nach Groessenaenderungen. Ob WebGL wirklich die Ursache ist, war
  // NICHT belegt -- deshalb stand hier eine Massnahme und keine Diagnose:
  // Canvas ist der naechstschnellste Weg und faellt als Fehlerquelle aus.
  //
  // Inzwischen ist es gemessen, und WebGL war es NICHT: Bildpunktvergleich,
  // zehn Proben, null Unterschied (Ergebnis: ~/.pi-workers/results/
  // termdarstellung/). Die Ursache waren zwei Naehte in
  // app/src/main/tmux.ts, beide behoben in f050ee5 -- eine mitten in einer
  // Steuerfolge zerschnittene Ausgabe, deren erste Haelfte verworfen wurde
  // (Fingerabdruck im Foto von 18:24: `machen8;5;153mcontext`, Rest von
  // ESC[38;5;153m), und Bildschirminhalt plus Cursor aus zwei getrennten
  // tmux-Befehlen mit einem Lesevorgang dazwischen (bei 10 von 129 Aufnahmen
  // gemessen). Damit traegt die Sperre nichts mehr; sie kostete nur
  // Zeichengeschwindigkeit.
  //
  // Wieder aufziehen heisst: `false` auf `true`. Die Zusage in
  // shell/tests/test-app-scroll-renderer.sh liest den Wert hier und dreht
  // sich von selbst mit, in beide Richtungen -- niemand muss daran denken.
  // Offen und ausdruecklich unerklaert bleiben die grauen Balken auf dem
  // Bildschirmfoto vom 16.08., 21:52; kommen sie unter WebGL wieder, ist das
  // das Zeichen, hier wieder zuzumachen.
  const WEBGL_AUS = false;
  if (WEBGL_AUS) { aufCanvas(); return; }
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      webglJeTerminal.delete(paneId);
      aufCanvas();
    });
    t.loadAddon(webgl);
    rendererJePane.set(paneId, 'webgl');
    webglJeTerminal.set(paneId, { addon: webgl, term: t });
  } catch {
    aufCanvas();
  }
}

// Das Mass-Terminal. Es zeichnet nichts, es sagt nur, wie gross eine Zelle in
// dieser Schrift ist -- daraus folgen Spalten, Zeilen und die Lage jedes Panes.
const term = new Terminal({ cols: 80, rows: 24, ...TERMOPT });

const paneEl = document.getElementById('pane') as HTMLDivElement;
const buehne = document.getElementById('buehne') as HTMLDivElement;

term.open(paneEl);
ladeRenderer(MASS_TERMINAL_ID, term);

// Tastatur in den Pane. onData liefert die Bytes, die ein Terminal auch
// bekaeme -- Sondertasten, Steuerzeichen und eingefuegter Text eingeschlossen.
// Hat die Anwendung im Pane die Klammer-Einfuegung angefordert, verpackt xterm
// den eingefuegten Text selbst darin, und ein Absatz wird nicht Zeile fuer
// Zeile abgeschickt.
/**
 * Alles, was aus dem Fenster in einen Pane geht, laeuft hier durch -- und wird
 * dabei mitgeschrieben. Das Mitschreiben ist der einzige Weg, „das Rad tut in
 * diesem Zustand etwas" auch dort zu belegen, wo es keinen Bildlauf gibt: auf
 * dem Alternativschirm bewegt sich kein Puffer, es gehen nur Bytes hinaus.
 */
let letzteEingabe: { pane: string; daten: string } | null = null;
function paneEingabe(paneId: string, daten: string): void {
  letzteEingabe = { pane: paneId, daten };
  window.awbBridge.input(paneId, alsBase64(daten));
}

/** Die zuletzt gesendeten Bytes als Text, Steuerzeichen als ^X geschrieben. */
function eingabeLesbar(): string {
  const e = letzteEingabe;
  if (!e) return '';
  return [...e.daten].map((z) => (z < ' ' ? `^${String.fromCharCode(z.charCodeAt(0) + 64)}` : z)).join('');
}

function alsBase64(daten: string): string {
  const bytes = new TextEncoder().encode(daten);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// KOPIEREN UND EINFUEGEN IM TERMINAL (SSH-clipfix, Meldung des Nutzers vom
// 16.08.: geht nirgends). Ohne eigene Tastenbehandlung entscheidet xterm.js
// selbst ueber jedes Strg+<Buchstabe> (siehe node_modules/@xterm/xterm/src/
// common/input/Keyboard.ts, evaluateKeyboardEvent): Strg+C wird IMMER zu
// Byte 0x03 (SIGINT), egal ob etwas markiert ist, und Strg+V wird woertlich
// zu Byte 0x16 -- xterm haelt keine der beiden Tasten fuer Zwischenablage,
// weil ein echtes Terminal das auch nicht tut. Auf Linux ist die uebliche
// Antwort darauf Strg+Umschalt+C/V, und die fehlte hier komplett: kein
// `attachCustomKeyEventHandler`, kein Zugriff auf die Zwischenablage, an
// keiner der beiden Stellen, an denen ein Pane entsteht.
//
// AUF DEM MAC AENDERT SICH NICHTS: Cmd+C/Cmd+V tragen `metaKey`, nicht
// `ctrlKey`, xterms eigene Auswertung fasst sie in keinem Zweig an (der
// Klammer-Einfuege-Kommentar unten betrifft nur den Fall, dass eingefuegter
// Text SELBST eingefuegt wird), und der Browser erledigt sie am versteckten
// Eingabefeld des Terminals von sich aus -- das ist bereits gemessen der
// Grund, warum auf dem Mac niemand das Fehlen bemerkt hat.
const AUF_MAC = /Mac OS X|Macintosh/.test(navigator.userAgent);

/**
 * An EINEM Terminal (`t`) angebracht: faengt Strg+Umschalt+C (kopiert eine
 * Auswahl, wenn eine da ist) und Strg+Umschalt+V (setzt die Zwischenablage
 * ein) ab, bevor xterm sie sieht. Alles andere -- auch das blosse Strg+C/V --
 * geht unveraendert weiter: ein Terminal, das SIGINT verliert, waere kaputter
 * als eines ohne Kopieren.
 */
function terminalZwischenablageHaken(t: Terminal): void {
  if (AUF_MAC) return;
  t.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return true;
    const taste = ev.key.toLowerCase();
    if (taste === 'c') {
      if (t.hasSelection()) {
        void window.awbBridge.zwischenablageSchreiben(t.getSelection());
      }
      ev.preventDefault();
      return false;
    }
    if (taste === 'v') {
      void window.awbBridge.zwischenablageLesen().then((text) => {
        if (text) t.paste(text);
      });
      ev.preventDefault();
      return false;
    }
    return true;
  });
}

let gemeldet = { cols: 0, rows: 0 };

/** Wieviele ganze Zellen die Buehne fasst -- die Zahl, die tmux bekommt. */
function flaecheInZellen(): { cols: number; rows: number } | null {
  const zelle = zellmass();
  const { b, h } = gitterFlaeche();
  if (!(zelle.breite > 0) || !(zelle.hoehe > 0) || !(b > 0) || !(h > 0)) return null;
  return { cols: Math.max(20, Math.floor(b / zelle.breite)), rows: Math.max(5, Math.floor(h / zelle.hoehe)) };
}

function passeAn(): void {
  const mass = flaecheInZellen();
  if (!mass) return;
  if (mass.cols === gemeldet.cols && mass.rows === gemeldet.rows) return;
  gemeldet = mass;
  window.awbBridge.bedienung('flaeche', mass);
}

window.addEventListener('resize', passeAn);

// Das Fenster ist nicht die einzige Quelle einer neuen Flaeche: seit die
// Schubladen in der Reihe stehen, macht auch das Aufklappen die Buehne
// schmaler, und dabei aendert sich die Fenstergroesse nicht. Beobachtet wird
// deshalb die Buehne selbst -- das deckt jede kuenftige Aenderung an der
// Anordnung mit ab. `passeAn` meldet nur bei wirklich anderer Zellenzahl,
// also entsteht daraus keine Schleife.
// Das Fenster ist nicht die einzige Quelle einer neuen Flaeche: seit die
// Schubladen in der Reihe stehen, macht auch das Aufklappen die Buehne
// schmaler, und dabei aendert sich die Fenstergroesse nicht.
//
// Ein ResizeObserver auf der Buehne waere der allgemeine Weg -- und er ist
// GEMESSEN falsch: mit ihm fielen fuenf Zusagen der Oberflaechen-Suite, die
// ohne ihn halten (63 zu 0 gegen 58 zu 5, beide Male derselbe Baum). Er meldet
// auch Aenderungen, die aus dem Zeichnen selbst kommen, und eine Zahl aus dem
// Zwischenzustand bleibt als `gemeldet` stehen und sperrt die richtige danach.
// Ein Aufschub ins naechste Einzelbild reichte nicht. Deshalb meldet die
// Stelle, die die Breite wirklich aendert -- die Schublade --, und sonst
// niemand.
//
// GEZEICHNET WIRD SOFORT MIT, ohne auf tmux zu warten: die Kacheln liegen in
// Bildpunkten, und eine Kachel, die auf die alte Breite gerechnet ist, laesst
// beim Zuklappen genau den leeren Streifen stehen, um den es hier geht. Was
// tmux dazu sagt, kommt hinterher und veraendert nur noch den Inhalt.
document.addEventListener('awb:flaeche-geaendert', () => requestAnimationFrame(() => {
  passeAn();
  if (letzteLage) zeichneLage(letzteLage);
}));

// Beide Leisten lassen sich aufziehen (A15): die linke nach rechts, die rechte
// nach links. Dieselbe Bauart, nur die Rechnung ist gespiegelt.

interface PaneEintrag {
  term: Terminal;
  el: HTMLDivElement;
  /**
   * Ob DIESES Terminal seinen Rueckblick bekommen hat. Die Angabe haengt am
   * Terminal, nicht am Pane: `reset()` wirft den Puffer weg, ein neu angelegtes
   * Terminal faengt ohnehin leer an -- beides nimmt den Rueckblick, und beides
   * setzt die Angabe zurueck. Der Hauptprozess schickt ihn nur EINMAL je Pane
   * (main.ts, historieHolen); ohne diese Buchfuehrung hier bliebe jedes zweite
   * Terminal fuer immer ohne, und genau das war der Fehler vom 06.08.
   */
  rueckblickDa: boolean;
  /** Ob fuer dieses Terminal schon einer angefordert wurde -- genau einmal. */
  rueckblickGefragt: boolean;
}
const paneTerms = new Map<string, PaneEintrag>();
/** Je Pane eine Chat-Ansicht, die ueber ihm liegt (SPEC-V4 Abschnitt 6). */
const chatAnbindungen = new Map<string, ChatAnbindung>();
/**
 * Die Kachel-Geometrie, WIE SIE GESETZT wurde -- nicht wie sie hinterher aus
 * dem DOM zurueckgelesen wird.
 *
 * `uiState()` mass frueher jede `.panekasten`-Kante einzeln per
 * `getBoundingClientRect()` und rundete x, y, b und h je fuer sich. Zwei
 * Kacheln, deren Grenze auf demselben Wert `kachel.y` beruht (Kachel 2 endet,
 * wo Kachel 3 beginnt -- dieselbe Zahl aus `kachelLage()`), rundeten dabei
 * UNABHAENGIG: einmal ueber "gerundete Position plus gerundete Hoehe", einmal
 * ueber "gerundete eigene Position" -- und konnten dadurch bis zu einem Pixel
 * auseinanderlaufen, obwohl sie sich in Wirklichkeit nur beruehrten. Diese
 * Karte haelt die Zahl fest, die tatsaechlich in `style.left/top/width/height`
 * gelandet ist; `uiState()` liest daraus, nicht mehr aus dem DOM zurueck.
 */
const letzteKacheln = new Map<string, { x: number; y: number; b: number; h: number; kopf: number; fehlt: boolean }>();
/**
 * Ob die Anwendung in einem Pane die Maus verfolgt. Die Quelle ist tmux, nicht
 * das Terminal im Fenster: eine Momentaufnahme traegt Text und Farben, aber
 * keine Modus-Umschaltungen. Ein frisch angelegtes Terminal wuesste also nichts
 * davon -- und genau deshalb landete das Rad im Puffer des Fensters statt bei
 * der Anwendung (gemeldet 06.08.: "ich verschiebe den Worker-Tab einfach als
 * ganzen Tab nach oben und nach unten").
 */
const mausModus = new Map<string, { an: boolean; sgr: boolean }>();
const gitterEl = document.getElementById('gitter') as HTMLDivElement;
let letzteLage: LayoutPayload | null = null;

/**
 * Wie gross EINE ZELLE ist -- gemessen am MASS-TERMINAL, und nur ersatzweise an
 * einem gezeichneten Pane.
 *
 * Die Reihenfolge ist Absicht und gemessen (06.08.). Das Mass-Terminal wird nie
 * umgestellt: seine Zellbreite steht still, solange die Schrift steht. Ein
 * gezeichneter Pane dagegen taugt in genau zwei Lagen NICHT als Mass -- waehrend
 * eines Groessenwechsels (`term.cols` ist schon neu, gezeichnet ist noch das
 * alte Bild) und wenn sein Inhalt breiter ist als seine Kachel (dann steht dort
 * die beschnittene Breite). Beide Male kommt eine um ein bis zwei Prozent zu
 * kleine Zelle heraus, daraus zu viele Spalten, daraus ein zu breiter Inhalt --
 * und der naechste Durchgang misst noch kleiner. GEMESSEN als Pendeln zwischen
 * 127 und 129 Spalten, das von selbst nicht aufhoerte.
 *
 * Im Ruhezustand sind beide dieselbe Zahl (gemessen 7,825 gegen 7,828 -- der
 * Unterschied ist die Rundung des Kastens). Es gibt also weiter nur EINE
 * Zellgroesse; sie wird nur dort abgelesen, wo sie stillsteht.
 */
function zellmass(): { breite: number; hoehe: number } {
  const g = paneEl.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (g && term.cols && term.rows && g.width > 0) {
    return { breite: g.width / term.cols, hoehe: g.height / term.rows };
  }
  for (const [, e] of paneTerms) {
    const s = e.el.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (s && s.width > 0 && e.term.cols && e.term.rows) {
      return { breite: s.width / e.term.cols, hoehe: s.height / e.term.rows };
    }
  }
  // Rueckfall, solange das Mass-Terminal noch nichts gezeichnet hat. Er stand
  // als 7,8 und 15 hier -- die Zellgroesse EINER Schrift in EINER Groesse, und
  // bei jeder anderen falsch. Jetzt waechst er mit der eingestellten Schrift:
  // gemessen sind 0,6 der Schriftgroesse in der Breite und 1,15 in der Hoehe
  // (bei 13 Pixeln 7,8 und 15 -- also genau die alten Zahlen, nur nicht mehr
  // festgenagelt).
  return { breite: schriftgroesse * 0.6, hoehe: schriftgroesse * 1.15 };
}

/**
 * Eine neue Schriftgroesse anwenden.
 *
 * Alles Uebrige zieht von selbst nach: die Zellgroesse wird gemessen (zellmass),
 * daraus meldet `passeAn` neue Spalten und Zeilen an tmux, und aus DENEN fallen
 * Kachelrechnung, Mindestbreite und die Zahl der Panes je Tab. Deshalb wird
 * hier nur die Groesse gesetzt und die Flaechenmeldung erzwungen -- der Rest
 * ist der gewoehnliche Weg.
 */
function setzeSchrift(px: number): void {
  if (!Number.isFinite(px) || px < 8 || px > 32 || px === schriftgroesse) return;
  schriftgroesse = px;
  term.options.fontSize = px;
  for (const [, e] of paneTerms) e.term.options.fontSize = px;
  // Die zuletzt gemeldete Zellenzahl gilt nicht mehr: sie stammt aus der alten
  // Schrift und wuerde die neue Meldung als "unveraendert" verwerfen.
  gemeldet = { cols: 0, rows: 0 };
  requestAnimationFrame(() => {
    passeAn();
    if (letzteLage) zeichneLage(letzteLage);
  });
}

/** Dieselbe Nachzieh-Form wie `setzeSchrift` oben, fuer Grund und Schrift statt Groesse -- von `themaAnwenden` bei jedem Themawechsel gerufen. */
function terminalThemaAnwenden(): void {
  const farben = terminalFarben();
  term.options.theme = farben;
  for (const [, e] of paneTerms) e.term.options.theme = farben;
}

/**
 * Das Gitter eines Tabs -- von der Oberflaeche gelegt, nicht von tmux.
 *
 * Fuer die Panes EINES Fensters ist die Aufteilung von tmux die Wahrheit, und
 * fuer 'pane' bleibt sie es auch. Ein Tab dagegen zeigt Panes aus MEHREREN
 * Fenstern, und deren Koordinaten zaehlen je Fenster: nebeneinandergelegt
 * ergeben sie kein gemeinsames Gitter, sondern zufaellige Abstaende -- zwei
 * Panes diagonal in den Ecken, zwei leere Haelften dazwischen, und zwei Panes
 * mit derselben Koordinate liegen uebereinander.
 *
 * Die Zahl der Spalten kommt aus der Kapazitaetsrechnung (main, capacity.ts).
 * Die letzte Reihe zieht sich auf die volle Breite: drei Kacheln in einem
 * zweispaltigen Gitter lassen sonst ein leeres Viertel stehen.
 */
/**
 * Die Flaeche, auf der ein Tab seine Kacheln legt.
 *
 * EINE Quelle fuer eine Zahl, die sonst zweimal gemessen wurde: `clientWidth`/
 * `clientHeight` runden auf ganze Pixel, `getBoundingClientRect()` liefert die
 * echte Nachkommazahl -- an derselben Flaeche kamen so zwei leicht
 * verschiedene Werte heraus (639 gegen 638.x), und die letzte Kachel eines
 * Rasters ragte um den Rundungsrest hinaus. Die Kacheln selbst werden mit
 * Nachkommastellen positioniert (toFixed(1)); `getBoundingClientRect()` ist
 * also nicht nur die praezisere Zahl, sondern die, die zur Positionierung
 * passt. `uiState()` liest dieselbe Funktion fuer die gemeldete Buehnengroesse
 * -- damit koennen Lage und Meldung nicht mehr auseinanderlaufen.
 */
/**
 * Die Flaeche, auf der gezeichnet wird -- OHNE Abzug. Das ist die Buehne, wie
 * sie im Fenster steht; die Kacheln fuellen genau sie. Wer wissen will, wieviel
 * davon fuer TEXT bleibt, nimmt `gitterFlaeche()` darunter.
 */
function rohflaeche(): { b: number; h: number } {
  const g = gitterEl.getBoundingClientRect();
  if (g.width && g.height) return { b: g.width, h: g.height };
  const f = buehne.getBoundingClientRect();
  return { b: f.width, h: f.height };
}

/** Wieviel die Kopfzeilen der aktuellen Lage zusammen wegnehmen. */
function kopfabzug(): number {
  return KOPFHOEHE * kachelZeilen;
}

function gitterFlaeche(): { b: number; h: number } {
  const roh = rohflaeche();
  // DIE KOPFZEILEN GEHEN AB (03.09.2026). Was diese Funktion zurueckgibt, ist
  // die Flaeche fuer TERMINALS -- und je Kachelzeile steht darueber eine
  // Kopfzeile von KOPFHOEHE Bildpunkten. Der Abzug gehoert genau hierher, weil
  // beide Abnehmer dieselbe Zahl brauchen: `flaecheInZellen` meldet tmux, wie
  // viele Zellen wirklich fuer Text da sind, und `kachelAusRaster` legt die
  // Kacheln in dieselbe Flaeche. Rechneten die beiden verschieden, liefe der
  // Inhalt genau um die Kopfzeilen ueber seine Kachel hinaus.
  return { b: roh.b, h: Math.max(1, roh.h - kopfabzug()) };
}

/**
 * Die Kachel EINES Panes aus seiner wirklichen Lage im tmux-Fenster.
 *
 * DER GRUND (Messung des Nutzers vom 06.08.): Kacheln nach der Reihenfolge zu
 * vergeben und die Groessen von tmux zu nehmen, sind zwei Geometrien -- und sie
 * lagen gegeneinander verschoben. Ein Pane bekam die volle Breite auf der
 * Buehne und die halbe Spaltenzahl im Terminal, ein anderer umgekehrt; die
 * rechte Haelfte blieb schwarz, der Nachbar lief ueber seine Kachel hinaus. Wo
 * alle gezeigten Panes in EINEM Fenster liegen, gibt es diesen zweiten Ursprung
 * nicht mehr: die Kachel folgt der Lage, und Spaltenzahl und Kachelbreite
 * kommen damit aus derselben Zahl. Das gilt fuer jede Zahl von Panes, auch fuer
 * eine ungerade -- die letzte Kachel einer Reihe ist genau so breit, wie tmux
 * ihren Pane gemacht hat.
 *
 * DIE TRENNLINIE GEHOERT ZUR KACHEL. tmux laesst zwischen zwei Panes eine
 * Spalte bzw. Zeile fuer seinen Rahmen. Ohne sie blieben zwischen den Kacheln
 * Streifen der Buehne stehen, und die Flaeche waere nicht gedeckt; also
 * bekommt sie die Kachel LINKS bzw. OBEN davon dazu. Der Inhalt sitzt darin
 * weiterhin in seiner eigenen Groesse -- die eine Zelle Unterschied ist genau
 * der Rahmen, den auch tmux dort zeichnet.
 */
function kachelAusRaster(
  box: PaneBox,
  raster: { cols: number; rows: number },
): { x: number; y: number; b: number; h: number } {
  const { b: flaecheB, h: flaecheH } = gitterFlaeche();
  const trennerRechts = box.x + box.cols >= raster.cols ? 0 : 1;
  const trennerUnten = box.y + box.rows >= raster.rows ? 0 : 1;
  // DIE FUGE KOMMT AUS DER TRENNSPALTE, NICHT VON DER KACHEL (04.09.2026).
  // tmux laesst zwischen zwei Panes eine Spalte bzw. Zeile fuer seinen Rahmen,
  // und die bekam die Kachel links bzw. oben davon bisher ganz dazu. Jetzt
  // bleiben davon vier Bildpunkte als Fuge stehen -- der Inhalt sitzt
  // weiterhin in seiner eigenen Groesse darin, denn die Trennspalte ist bei
  // jeder Schriftgroesse breiter als vier Bildpunkte.
  return {
    x: (box.x / raster.cols) * flaecheB,
    y: (box.y / raster.rows) * flaecheH,
    // `max(1, …)`: bei einer absurd schmalen Flaeche waere die Trennspalte
    // selbst schmaler als die Fuge, und die Kachel bekaeme eine negative
    // Breite. Ein Bildpunkt ist dann falsch, aber sichtbar -- eine negative
    // Groesse waere unsichtbar falsch.
    b: Math.max(1, ((box.cols + trennerRechts) / raster.cols) * flaecheB - trennerRechts * FUGE),
    h: Math.max(1, ((box.rows + trennerUnten) / raster.rows) * flaecheH - trennerUnten * FUGE),
  };
}

/**
 * `breiten` ist die Spaltenzahl JE PANE, in der Reihenfolge der Kacheln, und
 * `flaecheCols` die Spaltenzahl der ganzen Buehne. Damit teilt eine Reihe ihre
 * Breite nach dem, was die Panes wirklich brauchen, statt zu gleichen Teilen.
 *
 * DER GRUND: tmux teilt eine Reihe nicht gleichmaessig, sondern verteilt den
 * Rest -- bei drei Spalten auf 133 Zellen werden daraus 44, 44 und 45. Bei
 * gleich breiten Kacheln (je ein Drittel) ist der Pane mit 45 Spalten dann
 * breiter als seine Kachel, und das letzte Zeichen jeder Zeile wird
 * abgeschnitten. GEMESSEN am 19.08. kopflos mit sieben und acht Workern im
 * Layout 'split': Schirm 338 Bildpunkte in einer Kachel von 334.
 *
 * Verteilt wird nur, wenn die Reihe zusammen NICHT breiter ist als die Buehne
 * -- sonst waere die Rechnung ein Verschieben des Abschnitts von einem Pane auf
 * den naechsten. Fehlt eine Zahl (ein angeforderter Pane, den es nicht gibt),
 * bleibt es bei gleichen Teilen.
 */
/**
 * DIE KACHELN, WENN DER TAB NUR EINEN TEIL EINES FENSTERS ZEIGT.
 *
 * Die Lage der gezeigten Panes ist die von tmux -- zwischen ihnen fehlen aber
 * Zellen (im Layout 'split' die des Orchestrators). Zwei Zusagen zugleich:
 *
 *   - KEINE LUECKE. Jede Reihe wird auf die volle Breite verteilt, die Reihen
 *     zusammen auf die volle Hoehe. Was fehlt, hinterlaesst kein leeres Viertel.
 *   - NICHTS ABGESCHNITTEN. Verteilt wird nach der Spalten- und Zeilenzahl der
 *     Panes selbst. Weil die gezeigten Panes einer Reihe zusammen nie mehr
 *     Spalten haben als das Fenster, ist jede Kachel mindestens so breit wie
 *     ihr Inhalt; fuer die Hoehe gilt dasselbe.
 *
 * Bis dahin fiel dieser Fall auf das gleichmaessige Gitter zurueck, das die
 * wirkliche Groesse der Panes nicht kennt. GEMESSEN am 19.08. kopflos mit vier
 * Workern im Layout 'split': tmux hatte dem letzten Pane 133 Spalten gegeben
 * (998 Bildpunkte), seine Kachel war 501 breit -- die halbe Ausgabe stand
 * ausserhalb.
 */
function kachelnAusTeilraster(
  boxen: PaneBox[],
  buehneZellen: { cols: number; rows: number },
): { x: number; y: number; b: number; h: number }[] {
  const { b: flaecheB, h: flaecheH } = gitterFlaeche();
  // Die Reihen des Fensters, in der Reihenfolge von oben nach unten; leere
  // Reihen (nur ungezeigte Panes) fallen dabei ganz weg.
  const reihen = [...new Set(boxen.map((b) => b.y))].sort((a, b) => a - b);
  const hoeheJeReihe = reihen.map((y) => Math.max(...boxen.filter((b) => b.y === y).map((b) => b.rows)));
  const summeHoehe = hoeheJeReihe.reduce((a, b) => a + b, 0) || 1;
  // Der Riegel gegen eine Aufteilung, die den Inhalt doch beschneiden wuerde:
  // gemessen wird gegen die BUEHNE in Zellen, nicht gegen das Fenster. Das
  // Fenster ist in diesem Fall absichtlich groesser (main.ts, zweiter
  // Durchgang); massgeblich ist, ob die gezeigten Panes zusammen auf die Buehne
  // passen. Tun sie es nicht, gleiche Teile -- dann ist ohnehin nichts zu
  // retten.
  const hoehePasst = summeHoehe <= buehneZellen.rows;
  const lagen = new Map<string, { x: number; y: number; b: number; h: number }>();
  let oben = 0;
  for (const [n, y] of reihen.entries()) {
    const inReihe = boxen.filter((b) => b.y === y).sort((a, b) => a.x - b.x);
    const summeBreite = inReihe.reduce((a, b) => a + b.cols, 0) || 1;
    const breitePasst = summeBreite <= buehneZellen.cols;
    const h = hoehePasst ? (hoeheJeReihe[n] / summeHoehe) * flaecheH : flaecheH / reihen.length;
    let links = 0;
    for (const box of inReihe) {
      const b = breitePasst ? (box.cols / summeBreite) * flaecheB : flaecheB / inReihe.length;
      lagen.set(box.paneId, { x: links, y: oben, b, h });
      links += b;
    }
    oben += h;
  }
  return boxen.map((box) => lagen.get(box.paneId) ?? { x: 0, y: 0, b: flaecheB, h: flaecheH });
}

/**
 * DIE FREIE KACHELUNG (03.09.2026, Stufe A) -- und zwei Zusagen, die vorher
 * nicht zu haben waren.
 *
 * ERSTENS DIE FORM. Die Reihen kommen aus `kachelReihen` und nicht mehr aus
 * einem gierigen `spalten`-Fuellen: sieben Kacheln stehen 3, 2, 2 statt 3, 3, 1,
 * fuenf stehen 3, 2 statt 2, 2, 1. Solange tmux die Panes eines Fensters
 * aufteilte, war das nicht bestellbar -- `tiled` waehlte selbst und legte den
 * fuenften Worker allein und in voller Breite unter die anderen vier. Seit jeder
 * Worker sein eigenes Fenster mit einem Pane hat, ordnet tmux nichts mehr an.
 *
 * ZWEITENS DER RAND. Eine Kachel wird auf GANZE ZELLEN abgerundet, und der Rest
 * wird Fuge ZWISCHEN den Kacheln. Vorher bekam jede Kachel ihren vollen Anteil
 * an der Buehne, tmux konnte den Inhalt aber nur in ganzen Zellen liefern -- die
 * Differenz stand als schwarzer Streifen INNERHALB der Kachel und machte im
 * Befund 7,1 Prozent der Buehne aus. Dieselbe Flaeche liegt jetzt sichtbar
 * zwischen den Kacheln und trennt sie, statt sie unsauber aussehen zu lassen.
 * Die Zellenzahl ist genau die, die der Hauptprozess an tmux gibt (capacity.ts,
 * `kachelZellen`); beide runden dieselbe Zahl ab.
 *
 * `breiten` (die Spaltenzahl JE PANE) bleibt als RIEGEL, nicht mehr als Regel:
 * traegt ein Fenster doch mehrere Panes (Layout 'split', eine uebernommene
 * fremde Sitzung), teilt tmux seine Reihe selbst auf und verteilt den Rest
 * ungleich -- bei drei Spalten auf 133 Zellen werden daraus 44, 44 und 45. Ist
 * dabei auch nur ein Pane breiter als seine abgerundete Kachel, bekommt die
 * ganze Reihe wieder die Aufteilung nach Mass; sonst wuerde das letzte Zeichen
 * jeder Zeile abgeschnitten. GEMESSEN am 19.08. kopflos mit sieben und acht
 * Workern im Layout 'split': Schirm 338 Bildpunkte in einer Kachel von 334.
 */
function kachelLage(
  anzahl: number,
  spalten: number,
  frei: boolean,
  breiten?: number[],
  flaecheCols?: number,
): { x: number; y: number; b: number; h: number }[] {
  const { b: flaecheB, h: flaecheH } = gitterFlaeche();
  const zelle = zellmass();
  const reihen = kachelReihen(anzahl, spalten, frei);
  if (!reihen.length) return [];
  // DIE FUGEN GEHEN ZUERST AB (04.09.2026). Zwischen zwei Kachelzeilen liegt
  // eine Fuge, zwischen zwei Kacheln einer Zeile ebenso -- und was danach
  // uebrig bleibt, wird wie bisher auf ganze Zellen abgerundet. Der Rest der
  // Abrundung liegt weiterhin zwischen den Kacheln und macht die Fuge dort um
  // bis zu eine Zelle breiter; ueberstehen kann keine Kachel.
  const nutzH = Math.max(1, flaecheH - (reihen.length - 1) * FUGE);
  const zeilenZellen = zelle.hoehe > 0 ? Math.max(1, Math.floor(nutzH / reihen.length / zelle.hoehe)) : 0;
  const kachelH = zeilenZellen > 0 ? Math.min(nutzH, zeilenZellen * zelle.hoehe) : nutzH / reihen.length;
  const fugeH = reihen.length > 1
    ? FUGE + Math.max(0, (nutzH - reihen.length * kachelH) / (reihen.length - 1))
    : 0;
  const lagen: { x: number; y: number; b: number; h: number }[] = [];
  let n = 0;
  let oben = 0;
  for (const inZeile of reihen) {
    const nutzB = Math.max(1, flaecheB - (inZeile - 1) * FUGE);
    const zellenB = zelle.breite > 0 ? Math.max(1, Math.floor(nutzB / inZeile / zelle.breite)) : 0;
    const kachelB = zellenB > 0 ? Math.min(nutzB, zellenB * zelle.breite) : nutzB / inZeile;
    const cols = breiten?.slice(n, n + inZeile) ?? [];
    const summe = cols.reduce((a, b) => a + b, 0);
    const zuBreit = cols.length === inZeile && zellenB > 0 && cols.some((c) => c > zellenB);
    const nachMass =
      zuBreit && cols.every((c) => c > 0) && !!flaecheCols && summe <= flaecheCols;
    const fugeB = inZeile <= 1
      ? 0
      : nachMass ? FUGE : FUGE + Math.max(0, (nutzB - inZeile * kachelB) / (inZeile - 1));
    let x = 0;
    for (let i = 0; i < inZeile; i++) {
      const breite = nachMass ? (cols[i] / summe) * nutzB : kachelB;
      lagen.push({ x, y: oben, b: breite, h: kachelH });
      x += breite + fugeB;
    }
    oben += kachelH + fugeH;
    n += inZeile;
  }
  return lagen;
}

/**
 * Ein gezeichnetes Terminal ohne Rueckblick fordert einen an -- EINMAL.
 *
 * Der Hauptprozess schickt den Rueckblick einmal je Pane und merkt sich das.
 * Diese Buchfuehrung ist eine Annahme darueber, was im Fenster steht, und sie
 * kann falsch werden: laedt das Fenster neu (oder wirft eine leere Lage alle
 * Terminals weg), entstehen sie neu, waehrend der Merkposten drueben bleibt.
 * Dann gaebe es nie wieder einen Rueckblick. Also sagt die Stelle Bescheid,
 * die es als einzige WEISS -- hier liegt der Puffer.
 *
 * Genau einmal je Terminal: kommt daraufhin ein Rueckblick, wird das Terminal
 * zurueckgesetzt und die Frage darf wiederkommen; kommt keiner (der Pane hat
 * wirklich keinen), bleibt es bei dem einen Anlauf. So kann daraus kein Kreis
 * aus Fragen und Neuzeichnen werden.
 */
function rueckblickAnfordern(paneId: string): void {
  const eintrag = paneTerms.get(paneId);
  if (!eintrag || eintrag.rueckblickDa || eintrag.rueckblickGefragt) return;
  eintrag.rueckblickGefragt = true;
  window.awbBridge.rueckblickFehlt(paneId);
}

/** Nach dem Zeichnen: steht wirklich etwas ueber dem Schirm? */
function rueckblickPruefen(paneId: string): void {
  const eintrag = paneTerms.get(paneId);
  if (!eintrag) return;
  const buf = eintrag.term.buffer.active;
  // Auf dem Alternativschirm gibt es keinen Rueckblick und soll auch keiner
  // sein -- dort waere die Frage sinnlos und der Neuaufbau schaedlich.
  if (buf.type === 'alternate' || buf.baseY > 0) return;
  rueckblickAnfordern(paneId);
}

/**
 * DIE OBERKANTEN DER KACHELZEILEN, aufsteigend -- gezaehlt an den Oberkanten
 * der KACHELN und nicht an den Koordinaten von tmux.
 *
 * Der Unterschied ist kein Feinschliff: zeigt ein Tab Panes aus MEHREREN
 * tmux-Fenstern, zaehlen deren Koordinaten je Fenster, und zwei Panes mit
 * derselben tmux-Zeile 0 landen trotzdem in verschiedenen Kachelzeilen
 * (`kachelLage` vergibt sie nach der Reihenfolge). Wer nach tmux zaehlt, gibt
 * beiden denselben Aufschlag und schiebt sie uebereinander -- gemessen in
 * test-app-tab-kachel.sh, drei Panes aus zwei Fenstern.
 *
 * Gerundet wird auf halbe Bildpunkte: zwei Kacheln derselben Reihe stammen aus
 * derselben Rechnung und sind gleich, aber Fliesskomma bleibt Fliesskomma.
 */
function reihenAus(kacheln: { y: number }[]): number[] {
  return [...new Set(kacheln.map((k) => Math.round(k.y * 2)))].sort((a, b) => a - b);
}

/**
 * WIEVIELE KACHELZEILEN diese Lage bekommt -- gerechnet, bevor es Kacheln gibt.
 *
 * Der Abzug fuer die Kopfzeilen muss feststehen, ehe die erste Kachel gerechnet
 * wird (`gitterFlaeche`), und danach muss `reihenAus` an den fertigen Kacheln
 * auf dieselbe Zahl kommen. Also wird sie hier aus derselben Quelle bestimmt,
 * aus der auch die Kacheln entstehen -- fuer jeden der drei Wege einzeln:
 *
 *   - Raster und Teilraster legen nach der Lage von tmux; verschiedene
 *     Oberkanten sind dort verschiedene Kachelzeilen.
 *   - Ohne beides legt `kachelLage` nach der REIHENFOLGE, also `ceil(Anzahl /
 *     Spalten)`. GEMESSEN am 03.09. in test-app-tab-kachel.sh: drei Panes aus
 *     zwei fremden Fenstern haben nur zwei verschiedene tmux-Zeilen, stehen
 *     aber in drei Kachelzeilen untereinander. Nach tmux gezaehlt fehlte eine
 *     Kopfzeile im Abzug, und die unterste Kachel ragte 22 Bildpunkte ueber die
 *     Buehne hinaus.
 *   - Ein einzeln gezeigter Pane hat eine Zeile.
 */
function zeilenZahlFuer(p: LayoutPayload, mitRaster: boolean, mitTeilraster: boolean): number {
  if (p.art !== 'tab') return 1;
  if (mitRaster || mitTeilraster) return Math.max(1, new Set(p.panes.map((b) => b.y)).size);
  const anzahl = p.panes.length + (p.fehlend?.length ?? 0);
  return Math.max(1, Math.ceil(anzahl / Math.max(1, p.spalten ?? 1)));
}

function zeichneLage(p: LayoutPayload): void {
  letzteLage = p;
  // Mit Raster kommt die Kachel aus der Lage des Panes (kachelAusRaster), ohne
  // Raster aus seinem Platz in der Anforderung. Die zweite Form bleibt fuer die
  // Faelle, in denen es kein gemeinsames Raster GIBT: Panes aus mehreren
  // Fenstern, oder ein Fenster, von dem nur ein Teil gezeigt wird. Welcher der
  // drei Wege gilt, steht ganz vorne, weil die Zahl der Kachelzeilen davon
  // abhaengt und `gitterFlaeche()` sie braucht.
  const raster = p.art === 'tab' ? p.raster : undefined;
  const teilraster = p.art === 'tab' && !raster ? p.rasterTeil : undefined;
  // WIEVIELE KACHELZEILEN diese Lage hat. Die Zahl steht VOR jeder Rechnung,
  // weil `gitterFlaeche()` je Kachelzeile eine Kopfzeile abzieht und die
  // Kachelrechnung darunter in dieselbe Flaeche legen muss, die tmux als
  // Zellenzahl bekommen hat.
  kachelZeilen = zeilenZahlFuer(p, !!raster, !!teilraster);
  const zelle = zellmass();
  // Der gezeigte Ausschnitt wird auf die Flaeche normiert: zeigt ein Tab nur
  // einen Teil der Panes eines Fensters, sitzt er trotzdem oben links.
  const x0 = Math.min(...p.panes.map((b) => b.x), 0);
  const y0 = Math.min(...p.panes.map((b) => b.y), 0);
  const gesehen = new Set<string>();
  letzteKacheln.clear();
  /**
   * Die Kacheln in TERMINALFLAECHE, bevor die Kopfzeilen aufgeschlagen werden.
   * Gesammelt statt sofort gesetzt, weil erst am Ende feststeht, welche Kachel
   * in welcher Kachelzeile liegt (siehe `reihenAus`).
   */
  const roheKacheln: { pane: string; el: HTMLDivElement; x: number; y: number; b: number; h: number }[] = [];
  for (const [id, m] of Object.entries(p.maus ?? {})) mausModus.set(id, m);
  const teilKacheln = teilraster ? kachelnAusTeilraster(p.panes, { cols: p.cols, rows: p.rows }) : null;
  // Ein EINZELN gezeigter Pane bekommt die ganze Buehne als Kachel -- dieselbe
  // Regel wie im Tab: die Kachel bestimmt den Kasten, nicht der Inhalt. Bis
  // zum 06.08. bekam er die Groesse seines Inhalts, und damit wanderte jede
  // Zahl, die tmux gerade hergab, unmittelbar in die Flaeche: 144 Spalten von
  // einem angehaengten Terminal liessen 287 Bildpunkte leer, 197 Spalten
  // liessen ihn 127 Bildpunkte ueber die Buehne hinauslaufen (beides von
  // alice gemessen). Ob der Inhalt die Kachel auch fuellt, ist eine andere
  // Frage -- die beantwortet die Groesse, die tmux bekommt.
  const kacheln =
    p.art === 'tab'
      ? (raster || teilKacheln
          ? null
          : kachelLage(
              p.panes.length + (p.fehlend?.length ?? 0),
              Math.max(1, p.spalten ?? 1),
              p.frei === true,
              [...p.panes.map((b) => b.cols), ...(p.fehlend ?? []).map(() => 0)],
              p.cols,
            ))
      : [{ x: 0, y: 0, ...gitterFlaeche() }];

  for (const [i, box] of p.panes.entries()) {
    gesehen.add(box.paneId);
    let eintrag = paneTerms.get(box.paneId);
    const neu = !eintrag;
    if (!eintrag) {
      const el = document.createElement('div');
      el.className = 'panekasten';
      el.dataset.pane = box.paneId;
      // Die Schriftgroesse kommt aus der EINSTELLUNG, nicht aus TERMOPT: das
      // Objekt wird einmal beim Laden gebaut und traegt die Vorgabe von damals.
      // Ein Pane, der nach einer Aenderung neu angelegt wird, saehe sonst
      // anders aus als seine Nachbarn.
      // Schriftgroesse UND Farben kommen aus dem JETZIGEN Stand, nicht aus
      // TERMOPT: das Objekt wird einmal beim Laden des Moduls gebaut und traegt
      // beides, wie es DAMALS war. Bei der Groesse war das laengst behoben; bei
      // den Farben nicht, und das war ein echter Fehler -- `data-thema` steht
      // erst, wenn der Hauptprozess geantwortet hat, also NACH dem Laden. Ein
      // Pane, der danach entsteht (also jeder), bekam die dunklen Farben, auch
      // im hellen Thema. Gemessen am Belegbild vom 03.09.: Leisten `#f4f5f7`,
      // Terminal daneben `#1e232b`.
      // ZUERST die Kopfzeile, DANN das Terminal: der Kasten ist eine Spalte
      // (`display: flex`), und die Reihenfolge im Baum ist die Reihenfolge auf
      // dem Schirm. Waere sie umgekehrt, saesse die Zeile unter dem Terminal.
      el.appendChild(kopfBauen(box.paneId));
      const t = new Terminal({
        cols: box.cols, rows: box.rows, ...TERMOPT,
        fontSize: schriftgroesse, theme: terminalFarben(),
      });
      t.open(el);
      ladeRenderer(box.paneId, t);
      t.onData((daten) => paneEingabe(box.paneId, daten));
      terminalZwischenablageHaken(t);
      /**
       * WEM DAS RAD GEHOERT -- und warum die Vorgabe seit dem 06.08. umgedreht
       * ist.
       *
       * Vorher gehoerte es der Anwendung, sobald sie die Maus verfolgte. Das
       * ist die Sitte in einem Terminal und trotzdem die falsche Vorgabe hier,
       * denn dieser Weg KANN INS LEERE LAUFEN: die Anwendung bekommt die
       * Rad-Meldung und muss nichts damit tun. Genau das hat alice gemeldet
       * („manchmal kann ich auch immernoch garnicht scrollen"), und im
       * Normalfall seiner Sitzung ist die Mausverfolgung an. Der Ausweg war
       * Umschalt+Rad -- den kennt niemand, der es nicht gebaut hat.
       *
       * Jetzt: auf einem normalen Schirm bewegt das Rad den RUECKBLICK des
       * Panes. Der ist immer da, die Bewegung ist immer sichtbar und immer
       * umkehrbar. An die Anwendung geht es dort nur mit Umschalt.
       *
       * DER ALTE GRUND, und wie er jetzt aufgeht: der bestehende Kommentar
       * fuerchtete, dass „der ganze aufgenommene Schirm samt Eingabezeile mit
       * nach oben wandert". Das tut er auch weiterhin -- nur ist das kein
       * Fehler, sondern was Zurueckblaettern heisst: man sieht nach oben, und
       * die Eingabezeile steht unten ausserhalb des Ausschnitts. Dasselbe tut
       * der Kopiermodus in tmux. Der Unterschied zum alten Verhalten ist, dass
       * man es SIEHT und mit einer Bewegung nach unten wieder verlaesst, statt
       * vor einem Bild zu stehen, in dem nichts passiert.
       *
       * Auf dem ALTERNATIVSCHIRM (weniger, top, ein Editor) bleibt es bei der
       * Anwendung: dort gibt es keinen Rueckblick, den man bewegen koennte --
       * der Schirm gehoert ihr wirklich. Verfolgt sie die Maus, bekommt sie die
       * Rad-Meldung; sonst macht xterm daraus Pfeiltasten. Beides schickt
       * Bytes, beides ist messbar, keiner der drei Zustaende tut still nichts.
       */
      t.attachCustomWheelEventHandler((ev) => {
        if (!ev.deltaY) return false;
        // Ob die Anwendung die Maus verfolgt, sagt tmux (mausModus) ODER das
        // Terminal selbst: das eine kennt den Stand VOR dem Zeichnen, das
        // andere jede Umschaltung, die seither ueber den Strom lief.
        const mausAn = !!el.querySelector('.xterm.enable-mouse-events') || !!mausModus.get(box.paneId)?.an;
        if (t.buffer.active.type === 'alternate') {
          if (mausAn && !ev.shiftKey) {
            radAnAnwendung(box.paneId, ev);
            return false;
          }
          return true;
        }
        if (mausAn && ev.shiftKey) {
          radAnAnwendung(box.paneId, ev);
          return false;
        }
        const zeilen = radZeilen(ev, t.rows, paneZellhoehe(el, t.rows));
        // DER RUECKFALL, und er macht den Fehler vom 06.08. unmoeglich, auch
        // wenn der Rueckblick irgendwann wieder ausbleibt.
        //
        // Der Bildlauf oben setzt voraus, dass es etwas zu bewegen GIBT. Steht
        // der Ausschnitt schon am Anschlag -- ganz oben beim Hochrollen, ganz
        // unten beim Herunterrollen, und beides gilt bei baseY 0 immer --,
        // dann bewegt `scrollLines` nichts und niemand bekaeme etwas zu sehen.
        // Verfolgt die Anwendung die Maus, gehoert ihr das Ereignis in diesem
        // Fall: sie kann damit etwas tun, das Fenster kann es nicht. Sonst
        // bleibt es beim Bildlauf, der dann eben am Anschlag steht.
        //
        // Und weil ein fehlender Rueckblick auch ein Fehler sein KANN, wird er
        // bei der Gelegenheit angefordert (einmal je Terminal). Beim naechsten
        // Rad-Ereignis ist er dann da.
        const buf = t.buffer.active;
        const amAnschlag = zeilen < 0 ? buf.viewportY <= 0 : buf.viewportY >= buf.baseY;
        if (zeilen && amAnschlag) {
          if (buf.baseY === 0) rueckblickAnfordern(box.paneId);
          if (mausAn) {
            radAnAnwendung(box.paneId, ev);
            return false;
          }
        }
        if (zeilen) rollenSpaeter(t, zeilen);
        return false;
      });
      el.addEventListener('mousedown', () => setzeAktiv(box.paneId));
      gitterEl.appendChild(el);
      eintrag = { term: t, el, rueckblickDa: false, rueckblickGefragt: false };
      paneTerms.set(box.paneId, eintrag);
      chatAnbindungen.set(box.paneId, new ChatAnbindung(el, box.paneId, window.awbEditorBridge, false, chatPfadHaken(box.paneId)));
    }
    if (eintrag.term.cols !== box.cols || eintrag.term.rows !== box.rows) {
      eintrag.term.resize(box.cols, box.rows);
    }
    const kachel = raster ? kachelAusRaster(box, raster) : (teilKacheln?.[i] ?? kacheln?.[i]);
    const kx = kachel ? kachel.x : (box.x - x0) * zelle.breite;
    const ky = kachel ? kachel.y : (box.y - y0) * zelle.hoehe;
    // Die Kachel bestimmt den Kasten, nicht der Inhalt.
    //
    // Vorher bekam der Kasten die Groesse des Panes, sobald die kleiner war --
    // und bei einer Session, die wir nur lesen, ist jeder Pane anders gross.
    // Gemessen an der laufenden AI-Session: drei Kacheln von 673x420, 673x435
    // und 681x420, und die letzte Reihe zog sich nicht auf. Ein ungleiches
    // Gitter ist in keinem Fall richtig; der Inhalt sitzt jetzt IN der Kachel,
    // so gross wie er eben ist, und was nicht hineinpasst, wird beschnitten.
    const kb = kachel ? kachel.b : box.cols * zelle.breite;
    const kh = kachel ? kachel.h : box.rows * zelle.hoehe;
    // Erst sammeln, dann versetzen: WELCHE Kachelzeile eine Kachel bekommt,
    // steht erst fest, wenn alle gerechnet sind (siehe `reihenAus`).
    roheKacheln.push({ pane: box.paneId, el: eintrag.el, x: kx, y: ky, b: kb, h: kh });
    // Passt der Pane nicht in seine Kachel, wird das UNTERE Ende gezeigt.
    //
    // Das kommt bei einer uebernommenen Session vor, deren Fenster groesser ist
    // als unsere Buehne: dort wird nichts umgestellt (F14), also ist der Inhalt
    // groesser als die Kachel. Oben abzuschneiden ist dann die richtige Wahl --
    // in einem Terminal steht unten, was gerade passiert, und oben, was vorbei
    // ist.
    const ueberhang = Math.max(0, box.rows * zelle.hoehe - (kachel?.h ?? Infinity));
    const schirmEl = eintrag.el.querySelector<HTMLElement>('.xterm');
    if (schirmEl) schirmEl.style.marginTop = ueberhang ? `${-ueberhang.toFixed(1)}px` : '';
    const inhalt = p.inhalt[box.paneId];
    if (inhalt !== undefined) {
      const historie = p.historie?.[box.paneId];
      // Zurueckgesetzt wird nur ein FRISCHES Terminal (und der Sonderfall des
      // zweiten Schirms, in dem es ohnehin keinen Rueckblick gibt): reset()
      // wirft den Rueckblick weg, und weil jeder Groessenwechsel und jeder
      // Wechsel der Ansicht neu zeichnet, stand danach nichts mehr zum
      // Hochrollen da. Der Inhalt beginnt ohnehin mit "Schirm loeschen,
      // Cursor nach oben".
      //
      // DAZU der dritte Fall, und er traegt den Fehler vom 06.08.: kommt ein
      // Rueckblick fuer ein Terminal, das noch keinen hat, wird ebenfalls
      // zurueckgesetzt. Sonst haenge er sich unter den gezeigten Schirm statt
      // ueber ihn. Verloren geht dabei nichts -- Rueckblick und Inhalt sind
      // EINE Aufnahme desselben Augenblicks (main.ts, paneZeigen), und was das
      // Terminal bis dahin hatte, steht in ihr drin.
      //
      // Bis dahin hing das Schreiben an `neu`, also am ERSTEN Zeichnen eines
      // Panes. Beim Anhaengen entsteht das Terminal aber schon vorher, aus dem
      // ersten Wurf ohne Rueckblick (main.ts, attachTmux, F1); der Rueckblick
      // kam einen Zug spaeter und fiel damit still weg. Gemessen am
      // Orchestrator-Pane: laenge 57 bei zeilen 57, baseY 0 -- kein
      // Rueckblick, also ein Rad, das nichts bewegen kann.
      if (neu || eintrag.term.buffer.active.type === 'alternate' || (historie && !eintrag.rueckblickDa)) {
        eintrag.term.reset();
        eintrag.rueckblickDa = false;
        eintrag.rueckblickGefragt = false;
      }
      if (historie && !eintrag.rueckblickDa) {
        eintrag.term.write(historie);
        eintrag.rueckblickDa = true;
      }
      // Der Haken laeuft, wenn xterm den Inhalt wirklich verarbeitet hat:
      // `write` arbeitet aufgeschoben, und ein sofort gelesener Puffer wuesste
      // von diesem Schreiben noch nichts.
      eintrag.term.write(inhalt, () => rueckblickPruefen(box.paneId));
    }
  }

  // DIE KOPFZEILEN KOMMEN OBEN DRAUF (03.09.2026, Prueferbefund 7).
  //
  // Bis hierher ist alles in TERMINALFLAECHE gerechnet: `gitterFlaeche()` hat
  // die Kopfzeilen abgezogen, und tmux hat genau diese Zellenzahl bekommen.
  // Jetzt bekommt jede Kachel ihre eigene Zeile zurueck -- sie wird um
  // KOPFHOEHE hoeher, und sie rutscht um so viele Kopfzeilen nach unten, wie
  // ueber ihr liegen. In der Summe fuellen die Kacheln damit wieder die ganze
  // Flaeche: (H - z*KOPF) + z*KOPF = H. Beschnitten wird kein Terminal.
  const reihen = reihenAus(roheKacheln);
  for (const k of roheKacheln) {
    const reihe = Math.max(0, reihen.indexOf(Math.round(k.y * 2)));
    const y = k.y + reihe * KOPFHOEHE;
    const h = k.h + KOPFHOEHE;
    k.el.style.left = `${k.x.toFixed(1)}px`;
    k.el.style.top = `${y.toFixed(1)}px`;
    k.el.style.width = `${k.b.toFixed(1)}px`;
    k.el.style.height = `${h.toFixed(1)}px`;
    letzteKacheln.set(k.pane, { x: k.x, y, b: k.b, h, kopf: KOPFHOEHE, fehlt: false });
  }

  for (const [id, e] of [...paneTerms]) {
    if (gesehen.has(id)) continue;
    // Der Versuch bleibt (12.08.): mit @xterm/addon-webgl 0.19.0 warf
    // `term.dispose()` hier zuverlaessig einen TypeError mitten in der eigenen
    // Aufraeumkette der WebGL-Erweiterung (Kie.clear -> ... -> undefined._isDisposed,
    // gemessen ueber test-app-flaeche.sh: eine Kachel blieb danach stehen,
    // weil die Ausnahme diese ganze Schleife abbrach). @xterm/addon-webgl@0.18.0
    // legt dieselbe Aufraeumkette OHNE Ausnahme durch -- daher die Version. Der
    // Versuch bleibt trotzdem stehen: eine dritte Erweiterung soll diese
    // Schleife nie wieder mitten im Aufraeumen eines Panes abbrechen koennen.
    // Ein weggeworfenes Terminal hat in der Sammelstelle des Rades nichts mehr
    // verloren: bliebe sein Rest dort stehen, versuchte ihn das naechste
    // Rad-Ereignis eines ANDEREN Panes mit abzugeben (rollenAnwenden).
    rollenOffen.delete(e.term);
    try {
      e.term.dispose();
    } catch {
      // nichts zu tun -- der Pane wird trotzdem vollstaendig entfernt, siehe oben.
    }
    e.el.remove();
    paneTerms.delete(id);
    rendererJePane.delete(id);
    // Sonst hielte die Sammelstelle ein weggeworfenes Terminal fest, und
    // `webglSperren()` liefe spaeter darauf zu.
    webglJeTerminal.delete(id);
    chatAnbindungen.get(id)?.weg();
    chatAnbindungen.delete(id);
  }
  // Ein angeforderter Pane, den es nicht gibt, behaelt seinen Platz im Gitter
  // und sagt, warum er leer ist. Ein Worker, der ohne ein Wort verschwindet,
  // ist schlimmer als einer, der schlecht sitzt.
  for (const el of [...gitterEl.querySelectorAll('.panefehlt')]) el.remove();
  (p.fehlend ?? []).forEach((f, n) => {
    const kachel = kacheln?.[p.panes.length + n];
    if (!kachel) return;
    const el = document.createElement('div');
    el.className = 'panefehlt';
    el.dataset.pane = f.pane;
    // Derselbe Aufschlag wie bei einer echten Kachel -- der Platzhalter steht
    // im selben Gitter und muss dieselbe Hoehe haben, sonst reisst es.
    const alleReihen = reihenAus([...roheKacheln, kachel]);
    const reihe = Math.max(0, alleReihen.indexOf(Math.round(kachel.y * 2)));
    el.style.left = `${kachel.x.toFixed(1)}px`;
    el.style.top = `${(kachel.y + reihe * KOPFHOEHE).toFixed(1)}px`;
    el.style.width = `${kachel.b.toFixed(1)}px`;
    el.style.height = `${(kachel.h + KOPFHOEHE).toFixed(1)}px`;
    el.textContent = `${f.pane}: ${f.grund}`;
    gitterEl.appendChild(el);
    letzteKacheln.set(f.pane, {
      x: kachel.x, y: kachel.y + reihe * KOPFHOEHE,
      b: kachel.b, h: kachel.h + KOPFHOEHE, kopf: 0, fehlt: true,
    });
  });
  setzeAktiv(p.aktiv);
  namenSpaeter();
  auskunft.groesse = `${p.cols}x${p.rows}`;
  auskunft.ansicht =
    p.art === 'tab'
      ? `Tab mit ${p.panes.length} Panes${p.fehlend?.length ? `, ${p.fehlend.length} fehlen` : ''}`
      : 'ein Pane';
  // NICHT SOFORT. xterm legt seine Zellgroesse erst beim Zeichnen fest, und ein
  // eben angelegtes Terminal hat noch keine -- `zellmass` faellt dann auf das
  // Mass-Terminal zurueck, also auf die andere der beiden Zahlen, um die es
  // hier geht. GEMESSEN: sofort gefragt kommt 213 heraus (Mass-Terminal,
  // 7,709 Bildpunkte je Zelle), nach dem Zeichnen 209 (der gezeichnete Pane,
  // 7,826) -- und 209 ist die Zahl, mit der der Text wirklich gesetzt wird.
  // Zwei Einzelbilder reichten dafuer nicht; derselbe Aufschub wie bei den
  // Namensschildern reicht.
  nachfordernSpaeter(p);
}

let nachforderUhr: number | undefined;
function nachfordernSpaeter(p: LayoutPayload): void {
  if (nachforderUhr !== undefined) clearTimeout(nachforderUhr);
  nachforderUhr = setTimeout(() => {
    nachforderUhr = undefined;
    nachfordern(p);
  }, 250) as unknown as number;
}

/**
 * Passt der gezeichnete Pane nicht zur Buehne, wird die Flaeche NOCH EINMAL
 * gemeldet.
 *
 * `gemeldet` sperrt sonst genau den Fall, um den es geht: die Buehne hat ihre
 * Zahl schon einmal geschickt, also schweigt sie -- auch wenn inzwischen etwas
 * ANDERES die Groesse bestimmt hat (ein angehaengtes Terminal, ein
 * zurueckgestelltes window-size) oder eine frisch uebernommene Sitzung noch in
 * der Groesse dasteht, die tmux ihr beim Anlegen gab. Ohne dieses Nachfordern
 * bleibt der Rand fuer immer stehen.
 *
 * Gegen die Schleife: gefragt wird hoechstens EINMAL je gezeichneter Groesse.
 * Kann tmux nicht folgen (uebernommene Sitzung, harte Grenze), kommt dieselbe
 * Zahl zurueck und es wird nicht weiter gefragt.
 */
const nachgefordert = new Set<string>();
function nachfordern(p: LayoutPayload): void {
  if (p.art !== 'pane' || !p.panes.length || p.vorgegeben) return;
  const mass = flaecheInZellen();
  if (!mass) return;
  const box = p.panes[0];
  if (Math.abs(box.cols - mass.cols) <= 1 && Math.abs(box.rows - mass.rows) <= 1) {
    nachgefordert.clear();
    return;
  }
  const marke = `${box.cols}x${box.rows}->${mass.cols}x${mass.rows}`;
  if (nachgefordert.has(marke)) return;
  nachgefordert.add(marke);
  gemeldet = mass;
  window.awbBridge.bedienung('flaeche', mass);
}

/**
 * Die Schilder noch einmal ansehen, wenn sich der Inhalt bewegt hat.
 *
 * Zweimal noetig: xterm verarbeitet ein `write` verzoegert, das Bild steht
 * also erst kurz NACH dem Zeichnen; und waehrend Ausgabe laeuft, wandert der
 * Text unter dem Schild durch. Gebuendelt, damit nicht jede Ausgabezeile eine
 * Neuberechnung ausloest.
 */
let namenUhr: number | undefined;
function namenSpaeter(): void {
  if (namenUhr !== undefined) clearTimeout(namenUhr);
  namenUhr = setTimeout(() => {
    namenUhr = undefined;
    zeigeNamen();
  }, 200) as unknown as number;
}

/**
 * WIEVIELE ZEILEN EIN RAD-EREIGNIS BEDEUTET -- die eine Stelle dafuer.
 *
 * Vorher rechneten beide Wege (der Ruecklauf im eigenen Puffer und die
 * Mausmeldung an die Anwendung) jeder fuer sich, und beide teilten den
 * Pixel-Weg durch die ZELLHOEHE. Daraus wurde ein Verhalten, das vom Geraet und
 * von der Schriftgroesse abhing: ein Trackpad schickt viele Ereignisse mit
 * kleinem Weg, eine Maus wenige mit grossem, und je kleiner die Zeile, desto
 * mehr Zeilen kamen heraus. Mit der genauer gemessenen Zellhoehe fiel es
 * zuletzt so hoch aus, dass alice es als „viel zu schnell" gemeldet hat.
 *
 * DIE ZWISCHENSTUFE VOM 12.08. UND WARUM SIE AUCH FALSCH WAR. Danach stand
 * hier ein festes Raster: 100 Bildpunkte sind `scrollZeilen` Zeilen (Vorgabe
 * 3). Das ist geraeteunabhaengig, aber es ist fuer ein Trackpad um ein
 * Mehrfaches zu grob. GEMESSEN am 12.08. durch den echten Eingabeweg
 * (`awb-ctl rad-strom`, Zellhoehe 15): ein ruhiger Wisch aus 30 Ereignissen zu
 * je 3 Bildpunkten bewegte ZWEI Zeilen, 28 der 30 Ereignisse bewirkten gar
 * nichts. Vier kurze ruhige Gesten mit einer halben Sekunde dazwischen
 * bewegten NULL Zeilen -- alle 32 Ereignisse ohne Wirkung, weil die Pause den
 * angesammelten Bruchteil jedesmal wegwarf, bevor eine ganze Zeile daraus
 * werden konnte. Das ist des Nutzers „reagiert manchmal gar nicht", und es ist
 * kein Gefuehl, sondern diese Null.
 *
 * JETZT: ein Rad-Weg in Bildpunkten wird ueber die TATSAECHLICHE Zellhoehe
 * DIESES Terminals in Zeilen umgerechnet -- 15 Bildpunkte Finger sind eine
 * Zeile, wenn die Zeile 15 Bildpunkte hoch ist. Der Inhalt folgt dem Finger
 * eins zu eins; das ist das Mass, das jede andere Anwendung auf diesem Rechner
 * verwendet, und es ist von der Schriftgroesse nicht unabhaengig, sondern
 * richtigerweise an sie gebunden: eine kleinere Zeile heisst mehr Zeilen auf
 * demselben Weg, weil auf demselben Weg mehr Zeilen liegen.
 *
 * `scrollZeilen` bleibt die Einstellung, aber als FAKTOR gegen die Vorgabe:
 * 3 ist eins zu eins, 6 doppelt so schnell, 1 ein Drittel. Wer die alte Zahl im
 * Menue stehen laesst, bekommt das natuerliche Mass.
 *
 * DER SAMMELREST wird nur noch bei einem RICHTUNGSWECHSEL weggeworfen, nicht
 * mehr nach einer Pause. Eine Pause ist kein Grund: wer langsam wischt, soll
 * langsam scrollen und nicht gar nicht, und mehr als eine angefangene Zeile
 * kann der Rest nie sein -- ein spaeterer „Ruck" daraus ist hoechstens eine
 * einzige Zeile und faellt gegen das Nichts von vorher nicht ins Gewicht.
 */
/**
 * Faktor auf das natuerliche Mass, als Zeilen-je-Rasterung geschrieben, damit
 * die Einstellung `terminalScrollLines` dieselbe Bedeutung behaelt wie bisher.
 * Kommt aus der Einstellungsdatei, siehe setzeScroll.
 */
let scrollZeilen = 3;
/** Bei diesem Wert folgt der Inhalt dem Finger eins zu eins. */
const SCROLL_VORGABE = 3;
/** Ein Rasterschritt im Zeilen-Modus -- so melden es die Browser. */
const RASTER_ZEILEN = 3;
/**
 * Der Rasterschritt, den die Leistungsmessung als „ein Rad-Schritt" schickt.
 * Nur noch dort in Gebrauch: die Rechnung selbst kennt kein festes Raster mehr.
 */
const RASTER_PIXEL = 100;

let radRest = 0;

/**
 * MITSCHRIFT DER ECHTEN RAD-EREIGNISSE -- nur fuer Messungen.
 *
 * Ein nachgestelltes Ereignis, das eine ganze Zeile schickt, beweist nichts
 * ueber ein Trackpad: das schickt viele Ereignisse mit einem Weg von wenigen
 * Bildpunkten, und genau daran entschied sich, ob ueberhaupt etwas passiert.
 * Ist die Mitschrift an, haelt jede Rechnung fest, WAS ankam (deltaY, Modus)
 * und WAS herauskam (Zeilen) -- die beiden Zahlen, aus denen sich "so viele
 * Ereignisse bewirkten gar nichts" ablesen laesst.
 */
let radMitschrift: { deltaY: number; modus: number; zeilen: number }[] | null = null;

function setzeScroll(zeilen: number): void {
  if (!Number.isFinite(zeilen) || zeilen < 1 || zeilen > 20) return;
  scrollZeilen = Math.floor(zeilen);
}

/**
 * Ganze Zeilen aus einem Rad-Ereignis. Vorzeichen wie `deltaY`: positiv ist
 * nach unten. Der Bruchteil bleibt fuer das naechste Ereignis liegen.
 *
 * `zellhoehe` ist die gemessene Hoehe EINER Zeile in diesem Pane -- das Mass,
 * ueber das ein Weg in Bildpunkten zu einer Zeilenzahl wird.
 */
function radZeilen(
  ev: { deltaY: number; deltaMode: number },
  zeilenImPane: number,
  zellhoehe: number,
): number {
  if (!ev.deltaY) return 0;
  // Nur der Richtungswechsel leert den Sammelrest. Eine Pause tut das NICHT
  // mehr -- daran starb der ruhige Wisch (siehe die Messung oben).
  if (Math.sign(ev.deltaY) !== Math.sign(radRest || ev.deltaY)) radRest = 0;
  let zeilen: number;
  if (ev.deltaMode === 2) {
    // Seitenweise: eine Seite ist der Pane ohne die eine Zeile, die den
    // Anschluss zeigt.
    zeilen = ev.deltaY * Math.max(1, zeilenImPane - 1);
  } else {
    // Im Zeilen-Modus traegt das Ereignis schon Zeilen -- drei je Rastung des
    // Rades, und eine Rastung soll `scrollZeilen` Zeilen bewegen; das bleibt
    // wie bisher. Im Pixel-Modus traegt es einen WEG, und was daraus an Zeilen
    // wird, sagt die Zellhoehe.
    radRest +=
      ev.deltaMode === 1
        ? (ev.deltaY / RASTER_ZEILEN) * scrollZeilen
        : (ev.deltaY / Math.max(1, zellhoehe)) * (scrollZeilen / SCROLL_VORGABE);
    zeilen = Math.trunc(radRest);
    radRest -= zeilen;
  }
  if (!zeilen) {
    radMitschrift?.push({ deltaY: ev.deltaY, modus: ev.deltaMode, zeilen: 0 });
    return 0;
  }
  // DER DECKEL, und warum er jetzt eine Seite ist statt sechs Zeilen.
  //
  // Bei festem Raster war er noetig: dort wuchs ein Ereignis mit grossem Weg
  // ungebremst, und sechs Zeilen waren die Notbremse. Mit der Zellhoehe als
  // Mass ist die Zeilenzahl genau der Fingerweg -- ein Deckel darunter wuerfe
  // die Bewegung weg, die der Mensch gerade gemacht hat, und das ist der
  // „springt und verliert dann"-Fall, um den es hier geht. GEMESSEN: ein
  // schneller Wisch (25 Ereignisse, 40 bis 120 Bildpunkte) traegt bei Zellhoehe
  // 15 hoechstens 8 Zeilen je Ereignis, lief also bei sechs jedesmal an. Was
  // bleibt, ist die Grenze gegen ein widersinniges Ereignis: mehr als eine
  // Seite auf einmal ist kein Wischen mehr. Was darueber liegt, wird
  // abgeworfen und NICHT in den Rest geschoben -- sonst rieselte es nach.
  const deckel = Math.max(6, zeilenImPane - 1);
  const gedeckelt = Math.max(-deckel, Math.min(deckel, zeilen));
  if (gedeckelt !== zeilen) radRest = 0;
  radMitschrift?.push({ deltaY: ev.deltaY, modus: ev.deltaMode, zeilen: gedeckelt });
  return gedeckelt;
}

/**
 * EIN BILDLAUF JE BILD statt einer je Ereignis -- sonst frisst die Animation
 * die Bewegung.
 *
 * `smoothScrollDuration` (10 ms, siehe TERMOPT) laesst xterm den Ausschnitt
 * interpolieren. Jeder neue `scrollLines()`-Aufruf setzt den Anfang dieser
 * Interpolation auf die GERADE ERREICHTE Zwischenposition und beginnt von dort
 * neu -- was vom vorigen Lauf noch ausstand, ist damit weg. Ein Trackpad
 * schickt alle acht bis sechzehn Millisekunden ein Ereignis, also schneller,
 * als ein Lauf fertig wird, und der Verlust ist kein Randfall: GEMESSEN am
 * 12.08. durch den echten Eingabeweg bewegte ein schneller Wisch, fuer den 132
 * Zeilen ausgerechnet waren, nur 45 -- ein Drittel. Das ist das „scrollt dann
 * super viel auf einmal und bleibt dann stehen".
 *
 * Deshalb werden die Zeilen bis zum naechsten Einzelbild gesammelt und in EINEM
 * Aufruf abgegeben. Zwischen zwei Bildern liegen rund 16,7 ms, mehr als die
 * 10 ms der Animation -- jeder Lauf wird fertig, bevor der naechste anfaengt,
 * und es geht nichts verloren. GEMESSEN nach dem Umbau: 132 gerechnet, 132
 * bewegt.
 */
const rollenOffen = new Map<Terminal, number>();
let rollenBild: number | undefined;
let rollenUhr: number | undefined;
let rollenZuletzt = 0;
/** Zaehlt die abgegebenen Buendel -- das Nachsehen unten gilt nur fuer seines. */
let rollenZug = 0;
/** Wann zuletzt wirklich gerollt wurde -- die Auskunft, ab wann Nachmessen Sinn hat. */
let rollenAngewandt = 0;

/**
 * KEIN BILDLAUF OHNE FRAME-GARANTIE -- zwei Stellen, an denen ein ausbleibendes
 * Einzelbild die Bewegung verschluckte (Befund 1 der Bugjagd, 15.08.).
 *
 * `requestAnimationFrame` ist ein VERSPRECHEN AUF DAS NAECHSTE BILD, und wo
 * kein Bild mehr entsteht, faellt es aus. Gemessen im kopflosen Fenster mit
 * ZWEI Panes und vorgerolltem Ausschnitt: ein `rad +20` blieb ueber zwoelf
 * Sekunden liegen (Ausschnitt unveraendert, Polls im Sekundentakt), und erst
 * das naechste Rad-Ereignis brachte alles gemeinsam zur Wirkung
 * (274 + 14 − 6 = 282 statt der 268, die ein Hochrollen ergibt). Genau daran
 * scheiterte die Zusage „bei Maus-Verfolgung rollt das Rad ohne Sondertaste den
 * Rueckblick" in test-app-tab-kachel.sh.
 *
 * ERSTE STELLE, das Sammeln hier: neben das rAF tritt ein Zeitgeber. Kommt ein
 * Bild, gewinnt das Bild (am sichtbaren Fenster der Normalfall, rund 16,7 ms);
 * bleibt es aus, gibt der Zeitgeber die gesammelten Zeilen nach 32 ms ab. Wer
 * zuerst kommt, raeumt den anderen weg -- angewandt wird genau einmal. Der
 * Zeitgeber ist dabei zugleich die AUSKUNFT, dass kein Bild kam: in diesem
 * Zweig geht die Animationsdauer auf 0, damit der Ausschnitt sofort steht.
 *
 * ZWEITE STELLE, xterm selbst: `smoothScrollDuration` (TERMOPT, 10 ms) laesst
 * xterm den Ausschnitt UEBER EINZELBILDER interpolieren -- auch diese Bewegung
 * braucht also Bilder. GEMESSEN in der Nacht zum 16.08.: mit dem Zeitgeber allein blieb der
 * Fehlschlag Zeile fuer Zeile derselbe (274 -> 282), die abgegebene Bewegung lag
 * jetzt in xterms Animation fest; mit `smoothScrollDuration = 0` lief dieselbe
 * Suite durch. Weil die Animation am sichtbaren Fenster aber genau das ist, was
 * eine einzelne Rastung ruhig aussehen laesst, bleibt sie -- und bekommt ein
 * NACHSEHEN: ist der Ausschnitt 32 ms spaeter nicht dort, wo er sein sollte,
 * wird der Rest ohne Animation nachgezogen. So bewegt sich der Ausschnitt in
 * derselben Lage von 274 auf 288, und die Suite ist gruen.
 */
const ROLLEN_RUECKFALL_MS = 32;

function rollenAnwenden(ohneBild = false): void {
  if (rollenBild !== undefined) cancelAnimationFrame(rollenBild);
  if (rollenUhr !== undefined) clearTimeout(rollenUhr);
  rollenBild = undefined;
  rollenUhr = undefined;
  // ZUERST LEEREN, DANN ROLLEN. Wirft `scrollLines()` -- an einem gerade
  // weggeworfenen Terminal ist das kein Gedankenspiel, siehe den Kommentar in
  // der Aufraeumschleife von zeichneLage --, bliebe der Eintrag sonst stehen
  // und wuerde beim naechsten Rad ein ZWEITES Mal angewandt. Und ein
  // Fehlschlag an einem Terminal darf die anderen nicht mitnehmen.
  const stapel = [...rollenOffen];
  rollenOffen.clear();
  const zug = ++rollenZug;
  for (const [term, offen] of stapel) {
    if (!offen) continue;
    try {
      if (ohneBild) term.options.smoothScrollDuration = 0;
      const vorher = term.buffer.active.viewportY;
      term.scrollLines(offen);
      if (!ohneBild) rollenNachsehen(term, vorher + offen, zug);
    } catch {
      // Dieses Terminal nimmt nichts mehr an -- die uebrigen schon.
    }
  }
  if (stapel.length) rollenAngewandt = Date.now();
}

/**
 * WARTEN, BIS DER BILDLAUF WIRKLICH STEHT -- statt eine Zeit zu raten.
 *
 * Nur fuer den Messhaken `rad()` weiter unten. Wer nach einem Rad-Ereignis den
 * Ausschnitt abliest, muss zwei Schritte abwarten: die Abgabe in
 * `rollenAnwenden` und das `rollenNachsehen`, das ROLLEN_RUECKFALL_MS spaeter
 * den Rest ohne Animation nachzieht. Dafuer stand hier ein festes
 * `setTimeout(50)` -- achtzehn Millisekunden Luft ueber dem Nachsehen. Unter der
 * Last des vollen Testlaufs reichten die nicht: GEMESSEN auf peer am 21.08.
 * fiel in test-app-rueckblick.sh eine von neunzehn Zusagen mit „das Rad bewegt
 * nichts (viewportY bleibt 382)", waehrend dieselbe Suite einzeln gefahren
 * neunzehn von neunzehn hielt.
 *
 * Gewartet wird deshalb auf den Zustand statt auf die Uhr: solange ein Buendel
 * offen ist oder das Nachsehen noch aussteht, wird weiter nachgesehen. Bewegt
 * sich gar nichts -- der Fall, den die Zusage FINDEN soll --, laeuft der Deckel
 * ab und der Ausschnitt wird unveraendert gemeldet, wie vorher.
 */
async function rollenBeruhigt(deckelMs = 500): Promise<void> {
  const ende = Date.now() + deckelMs;
  for (;;) {
    const offen = rollenOffen.size > 0 || rollenBild !== undefined || rollenUhr !== undefined;
    if (!offen && Date.now() - rollenAngewandt > ROLLEN_RUECKFALL_MS + 16) return;
    if (Date.now() >= ende) return;
    await new Promise((r) => setTimeout(r, 8));
  }
}

/**
 * Ist die Bewegung wirklich angekommen? Nur fuer den Weg ueber das Einzelbild:
 * dort laeuft xterms Animation, und die braucht weitere Bilder (siehe oben).
 *
 * Ein spaeteres Buendel macht dieses Nachsehen gegenstandslos -- es hat den
 * Ausschnitt selbst bewegt, und sein eigenes Nachsehen laeuft ohnehin. Ein
 * Ziel jenseits des Puffers ist kein Fehlschlag: xterm deckelt, der Rest
 * bewegt dann nichts mehr.
 */
function rollenNachsehen(t: Terminal, ziel: number, zug: number): void {
  setTimeout(() => {
    if (zug !== rollenZug) return;
    try {
      const rest = ziel - t.buffer.active.viewportY;
      if (!rest) return;
      t.options.smoothScrollDuration = 0;
      t.scrollLines(rest);
    } catch {
      // Ein weggeworfenes Terminal braucht kein Nachsehen mehr.
    }
  }, ROLLEN_RUECKFALL_MS);
}

function rollenSpaeter(t: Terminal, zeilen: number): void {
  // IM FLUSS ODER EINZELN -- danach entscheidet sich, ob die Animation laufen
  // darf. Ein Finger auf dem Trackpad schickt alle acht bis sechzehn
  // Millisekunden ein Ereignis; eine Rastung am Mausrad steht allein. Nur die
  // Rastung springt ohne Animation sichtbar, und nur sie hat die Zeit, den Lauf
  // zu Ende zu bringen.
  const jetzt = Date.now();
  const imFluss = jetzt - rollenZuletzt < ROLLEN_FLUSS_MS;
  rollenZuletzt = jetzt;
  t.options.smoothScrollDuration = imFluss ? 0 : SCROLL_ANIMATION_MS;
  rollenOffen.set(t, (rollenOffen.get(t) ?? 0) + zeilen);
  if (rollenBild !== undefined || rollenUhr !== undefined) return;
  rollenBild = requestAnimationFrame(() => rollenAnwenden());
  rollenUhr = setTimeout(() => rollenAnwenden(true), ROLLEN_RUECKFALL_MS) as unknown as number;
}

/**
 * Die gemessene Hoehe EINER Zeile in diesem Pane. Der Rueckfall auf `zellmass`
 * greift, solange dieser Pane noch nichts gezeichnet hat -- dann steht keine
 * eigene Zahl zur Verfuegung, und die des Mass-Terminals ist die naechstbeste.
 */
function paneZellhoehe(el: HTMLElement, zeilen: number): number {
  const s = el.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (s && s.height > 0 && zeilen > 0) return s.height / zeilen;
  return Math.max(1, zellmass().hoehe);
}

/**
 * Ein Rad-Ereignis als MAUSMELDUNG an die Anwendung im Pane.
 *
 * Rad hoch ist Knopf 64, Rad runter 65. Kodiert wird so, wie die Anwendung es
 * angefordert hat: SGR (ESC [ < 64 ; spalte ; zeile M) ist der heutige Weg,
 * die alte Form (ESC [ M und drei Zeichen mit Versatz 32) der Rueckfall fuer
 * Anwendungen, die nur sie kennen.
 */
function radAnAnwendung(paneId: string, ev: WheelEvent): void {
  const eintrag = paneTerms.get(paneId);
  if (!eintrag) return;
  const schirm = eintrag.el.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!schirm || schirm.width <= 0) return;
  const zb = schirm.width / Math.max(1, eintrag.term.cols);
  const zh = schirm.height / Math.max(1, eintrag.term.rows);
  const spalte = Math.min(eintrag.term.cols, Math.max(1, Math.floor((ev.clientX - schirm.left) / zb) + 1));
  const zeile = Math.min(eintrag.term.rows, Math.max(1, Math.floor((ev.clientY - schirm.top) / zh) + 1));
  const knopf = ev.deltaY < 0 ? 64 : 65;
  // Dieselbe Rechnung wie fuer den eigenen Puffer: die Anwendung im Pane soll
  // sich nicht anders anfuehlen als das Fenster.
  const schritte = Math.abs(radZeilen(ev, eintrag.term.rows, zh));
  if (!schritte) return;
  const sgr = mausModus.get(paneId)?.sgr !== false;
  let folge = '';
  for (let i = 0; i < schritte; i++) {
    folge += sgr
      ? `\x1b[<${knopf};${spalte};${zeile}M`
      : `\x1b[M${String.fromCharCode(32 + knopf, 32 + spalte, 32 + zeile)}`;
  }
  paneEingabe(paneId, folge);
}

/** Welcher Pane die Tastatur bekommt -- und wessen Name oben steht. */
function setzeAktiv(paneId: string): void {
  aktiverPane = paneId;
  auskunft.pane = paneId || '-';
  for (const [id, e] of paneTerms) e.el.classList.toggle('aktiv', id === paneId);
  zeigeNamen();
  umgebung.aufAktivemPane(paneId);
}

/**
 * Wieviele BESCHRIEBENE Zellen unter einem Rechteck liegen. Das ist die
 * Grundlage der Schild-Platzierung: eine Ecke, in der nichts steht, deckt
 * nichts zu -- und "nichts steht dort" heisst leere Zellen im sichtbaren
 * Schirm des Terminals, nicht ein Eindruck vom Foto.
 */
function belegteZellen(paneId: string, r: DOMRect): number {
  const eintrag = paneTerms.get(paneId);
  if (!eintrag) return 0;
  const schirm = eintrag.el.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!schirm || schirm.width <= 0 || schirm.height <= 0) return 0;
  const zb = schirm.width / Math.max(1, eintrag.term.cols);
  const zh = schirm.height / Math.max(1, eintrag.term.rows);
  const x0 = Math.max(0, Math.floor((r.left - schirm.left) / zb));
  const x1 = Math.min(eintrag.term.cols - 1, Math.ceil((r.right - schirm.left) / zb) - 1);
  const y0 = Math.max(0, Math.floor((r.top - schirm.top) / zh));
  const y1 = Math.min(eintrag.term.rows - 1, Math.ceil((r.bottom - schirm.top) / zh) - 1);
  if (x1 < x0 || y1 < y0) return 0;
  const buf = eintrag.term.buffer.active;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const zeile = buf.getLine(buf.baseY + y);
    if (!zeile) continue;
    for (let x = x0; x <= x1; x++) {
      const c = zeile.getCell(x)?.getChars() ?? '';
      if (c && c.trim()) n++;
    }
  }
  return n;
}

// DIE FUNKTION `eckenName` IST WEG (03.09.2026). Sie sagte, in welcher Ecke
// eines Panes das schwebende Namensschild lag. Es gibt kein schwebendes Schild
// mehr, sondern eine Kopfzeile ueber die volle Breite -- eine Ecke hat sie
// nicht. Der Bericht sagt an ihrer Stelle `oben`.

/**
 * DIE KOPFZEILE EINES PANES (03.09.2026, Prueferbefund 7).
 *
 * Bis dahin stand hier ein SCHWEBENDES Schild in der Ecke des Panes -- ein
 * Kasten mit dem Namen, der ueber dem Terminal lag und ein paar beschriebene
 * Zellen zudeckte. Das war der Stand vor dem Neubau und ist beim Neubau
 * mitgekommen, obwohl der Entwurf etwas anderes zeigt: eine Zeile je Kachel mit
 * Zustand, Name, Modell und Tokenstand. Genau diese Zeile ist die Antwort auf
 * den Punkt, an dem alice das alte Token-Menue haesslich fand -- die Zahl
 * steht dort, wo der Worker steht, und nicht in einem eigenen Menue.
 *
 * SIE NIMMT SICH IHREN PLATZ, sie leiht ihn nicht. 22 Bildpunkte je Kachel
 * gehen der Terminalflaeche ab, und zwar SCHON bei der Zellenzahl, die tmux
 * bekommt (siehe `gitterFlaeche` und `kachelZeilen`). Damit deckt sie keine
 * einzige beschriebene Zelle zu -- die Frage, in welcher Ecke ein Schild am
 * wenigsten stoert, stellt sich nicht mehr.
 *
 * WAS DIE BRUECKE NICHT LIEFERT, BLEIBT LEER. Ein Harness ohne Tokenanzeige
 * hat keinen Tokenstand; dann steht dort nichts, keine Null und keine
 * Schaetzung.
 *
 * DER ZOOM-KNOPF ist der einzige der drei Knoepfe, die der Entwurf zeigt. Fuer
 * "Teilen" und "Schliessen" gibt es in `awb:bedienung` keine Gegenstelle -- ein
 * Knopf, der nichts tut, ist schlimmer als keiner.
 */
function kopfBauen(paneId: string): HTMLDivElement {
  const kopf = document.createElement('div');
  kopf.className = 'panekopf';
  kopf.dataset.pane = paneId;
  const punkt = document.createElement('span');
  punkt.className = 'punkt';
  const name = document.createElement('span');
  name.className = 'pk-name';
  const modell = document.createElement('span');
  modell.className = 'pk-modell';
  const tokens = document.createElement('span');
  tokens.className = 'pk-tokens';
  const zoom = document.createElement('button');
  zoom.className = 'pk-zoom';
  zoom.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linecap="round"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/></svg>';
  zoom.addEventListener('click', (ev) => {
    ev.stopPropagation();
    umgebung.aufZoom(paneId, letzteLage?.art === 'pane');
  });
  kopf.append(punkt, name, modell, tokens, zoom);
  return kopf;
}

/**
 * Die Kopfzeilen fuellen. Der Inhalt kommt aus dem Modell und trifft eigenen
 * Takt: ein Pane, der beim letzten Zeichnen noch keinen Worker hatte, traegt
 * sonst weiter seine rohe Kennung (gemessen 19.08.: dauerhaft "%2" statt
 * "mlxsrv").
 *
 * IST DIE KACHEL ZU NIEDRIG, faellt die Zeile weg statt den Pane zu ersticken.
 * Die Schwelle ist die doppelte Zeilenhoehe: darunter bliebe fuer das Terminal
 * weniger als die Zeile selbst hoch ist.
 */
function zeigeNamen(): void {
  for (const [id, e] of paneTerms) {
    const kopf = e.el.querySelector<HTMLDivElement>('.panekopf');
    if (!kopf) continue;
    const daten = umgebung.kopfZuPane(id);
    const voll = daten.name || id;
    const punkt = kopf.querySelector<HTMLSpanElement>('.punkt')!;
    punkt.className = `punkt ${daten.zustand || 'ruhig'}`;
    const name = kopf.querySelector<HTMLSpanElement>('.pk-name')!;
    const modell = kopf.querySelector<HTMLSpanElement>('.pk-modell')!;
    const tokens = kopf.querySelector<HTMLSpanElement>('.pk-tokens')!;
    kopf.classList.remove('kurz');
    name.textContent = voll;
    modell.textContent = daten.modell;
    tokens.textContent = daten.tokens;
    kopf.title = [voll, daten.modell, daten.tokens].filter(Boolean).join(' · ');
    kopf.style.display = e.el.clientHeight > 0 && e.el.clientHeight < KOPFHOEHE * 2 ? 'none' : '';
    // Wird es eng, weicht zuerst das Modell, dann faellt der Name auf sein
    // Kuerzel zurueck -- abgeschnitten wird nie.
    if (kopf.scrollWidth > kopf.clientWidth && kopf.clientWidth > 0) {
      kopf.classList.add('ohne-modell');
      if (kopf.scrollWidth > kopf.clientWidth) {
        name.textContent = kuerzel(voll);
        kopf.classList.add('kurz');
      }
    } else {
      kopf.classList.remove('ohne-modell');
    }
    kopf.classList.toggle('aktiv', id === aktiverPane);
  }
}


// --- Der Weg hinein und hinaus ----------------------------------------------

/**
 * Die Flaeche an die Bruecke haengen. Drei Kanaele gehoeren ihr allein --
 * `awb:session`, `awb:layout`, `awb:output` --, dazu die Mausverfolgung und
 * die Umschaltung der Chat-Ansicht eines Panes. Die Oberflaeche darum
 * abonniert keinen davon: was auf einem Pane passiert, entscheidet diese
 * Datei, und was daraus fuer die Leisten folgt, sagt sie ueber `umgebung`.
 */
export function initPaneflaeche(u: PaneflaecheUmgebung): void {
  umgebung = u;

  window.awbBridge.onSession((p) => {
    umgebung.aufSitzung(p);
    // Beim Anhaengen hat der Pane noch die Groesse, die er vorher hatte. Die
    // Meldung der Flaeche bringt beide auf dieselbe Zahl.
    gemeldet = { cols: 0, rows: 0 };
    requestAnimationFrame(passeAn);
  });

  window.awbBridge.onLayout((p) => {
    zeichneLage(p);
    umgebung.aufLage(p);
    requestAnimationFrame(passeAn);
  });

  window.awbBridge.onOutput((o) => {
    const ziel = paneTerms.get(o.paneId);
    if (!ziel) return;
    const bin = atob(o.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    ziel.term.write(bytes);
  });

  window.awbBridge.onMaus((m) => {
    mausModus.clear();
    for (const [id, wert] of Object.entries(m)) mausModus.set(id, wert);
  });

  // SOFORT WIRKSAM (12.08.): der Rechtsklick auf eine Sitzung hat ihre Ansicht
  // umgestellt, und der Pane wechselt hier -- ohne Neuaufbau des Fensters, ohne
  // dass die Sitzung angefasst wird. Kennt die Flaeche den Pane (noch) nicht,
  // passiert nichts: die Entscheidung steht in ui.json, und der naechste Aufbau
  // dieses Panes fragt sie beim Hauptprozess ohnehin ab (chat/anbindung.ts).
  window.awbBridge.onChatAnsicht((p) => {
    chatAnbindungen.get(p?.paneId ?? '')?.zeigen(p?.an === true);
  });

  // Die Flaeche meldet ihre Groesse EINMAL von sich aus, sobald sie steht. Ohne
  // das kennt der Hauptprozess sie erst, wenn das Fenster zum ersten Mal seine
  // Groesse aendert -- und alles, was vorher gezeichnet wird, bleibt in der
  // Groesse stehen, die tmux gerade hergibt.
  requestAnimationFrame(() => requestAnimationFrame(passeAn));
}

/**
 * NUR NACHMESSEN, nicht neu zeichnen. Gerufen nach jedem Modell: die Breite der
 * beiden Leisten kommt aus dem Modell, und wenn sie sich geaendert hat, ist die
 * Flaeche eine andere -- ein Fenster-`resize` gibt es dabei nicht. `passeAn`
 * meldet nur bei wirklich anderer Zellenzahl, es entsteht also keine Schleife.
 *
 * OHNE DIESEN AUFRUF blieb die Flaeche stehen: `awb-ctl set-ui sidebarWidth=48`
 * machte die Leiste schmaler, die Flaeche daneben breiter -- und tmux bekam
 * weiter die alten 143 Spalten (gemessen 03.09. in
 * test-app-fenster-zu-klein.sh, Zusage 4).
 */
export function flaecheMelden(): void {
  requestAnimationFrame(passeAn);
}

/** Die Flaeche neu vermessen und die Kacheln nachziehen -- nach jeder Aenderung am Layout um sie herum. */
export function paneflaecheNachziehen(): void {
  requestAnimationFrame(() => {
    passeAn();
    if (letzteLage) zeichneLage(letzteLage);
  });
}

/** Welcher Pane die Tastatur hat. */
export function aktiverPaneId(): string {
  return aktiverPane;
}

/** Die Namensschilder neu setzen -- der Name kommt aus dem Modell und trifft eigenen Takt. */
export function schilderNachziehen(): void {
  zeigeNamen();
}

export { setzeSchrift, setzeScroll, terminalThemaAnwenden, zellmass, gitterFlaeche };

/**
 * Was die Flaeche GERADE gezeichnet hat -- fuer `awb-ctl ui`. Jede Zahl hier
 * ist gemessen, keine ist gemerkt; die Begruendungen zu den einzelnen Feldern
 * stehen unveraendert dort, wo sie erarbeitet wurden.
 */
export function paneflaecheBericht(): Record<string, unknown> {
  const buehneRect = buehne.getBoundingClientRect();
  // Der Kasten um ALLE gezeichneten Panes -- das ist das Gitter, das die
  // Flaeche fuellen soll, nicht mehr ein einzelnes Terminal.
  const kaesten = [...gitterEl.querySelectorAll<HTMLDivElement>('.panekasten')].map((e) => e.getBoundingClientRect());
  const gitter = kaesten.length
    ? {
        left: Math.min(...kaesten.map((r) => r.left)),
        top: Math.min(...kaesten.map((r) => r.top)),
        right: Math.max(...kaesten.map((r) => r.right)),
        bottom: Math.max(...kaesten.map((r) => r.bottom)),
        width: Math.max(...kaesten.map((r) => r.right)) - Math.min(...kaesten.map((r) => r.left)),
        height: Math.max(...kaesten.map((r) => r.bottom)) - Math.min(...kaesten.map((r) => r.top)),
      }
    : undefined;
  const pane = gitter ?? buehneRect;
  // DIE BUEHNE UNGEKUERZT, der Abzug daneben (03.09.2026). `buehne.breite` und
  // `buehne.hoehe` sind die Flaeche, die die KACHELN fuellen -- daran haengt
  // die Zusage, dass kein Rand uebrig bleibt und keine Kachel hinausragt.
  // `kopfabzug` sagt, wieviel davon die Kopfzeilen nehmen, und
  // `schirmHoehe` ist der Rest, in dem TEXT steht: das ist die Zahl, aus der
  // die Zellen fuer tmux fallen. Zwei Zusagen, zwei Zahlen -- eine einzige
  // haette die eine oder die andere gebrochen.
  const flaeche = rohflaeche();
  const schirm = gitterFlaeche();
  return {
    // Wieviel vom Terminal zu sehen ist und wie der Rand verteilt liegt.
    buehne: {
      breite: Math.round(flaeche.b),
      hoehe: Math.round(flaeche.h),
      // Was den Terminals bleibt, und was die Kopfzeilen nehmen.
      schirmHoehe: Math.round(schirm.h),
      kopfabzug: Math.round(kopfabzug()),
      kachelZeilen,
      // Das gezeichnete Gitter, nicht der Kasten darum.
      paneBreite: Math.round(gitter?.width ?? pane.width),
      paneHoehe: Math.round(gitter?.height ?? pane.height),
      spalten: letzteLage?.cols ?? 0,
      zeilen: letzteLage?.rows ?? 0,
      panes: letzteLage?.panes.length ?? 0,
      art: letzteLage?.art ?? '-',
      // Die Spalte, die xterm fuer die Bildlaufleiste freihaelt. Sie gehoert
      // zum Terminal und ist kein ungenutzter Rand.
      bildlaufleiste: Math.round(buehneRect.width - (gitter?.width ?? buehneRect.width)),
      // DIE GEMESSENE ZELLE EINES GEZEICHNETEN PANES -- nicht die Flaeche
      // geteilt durch das Mass-Terminal. Die lange Begruendung dazu steht bei
      // `zellmass()`; kurz: beide Zahlen gingen am 06.08. um anderthalb
      // Prozent auseinander und haben damit die Spaltenzahl verdorben.
      zelle: {
        breite: Number(zellmass().breite.toFixed(2)),
        hoehe: Number(zellmass().hoehe.toFixed(2)),
      },
      // Lage im FENSTER, nicht in der Flaeche: damit laesst sich auf einem
      // Selbstfoto genau der Bereich nachmessen, in dem der Pane steht.
      paneRect: [Math.round(pane.left), Math.round(pane.top), Math.round(pane.width), Math.round(pane.height)],
      randLinks: Math.round((gitter?.left ?? pane.left) - buehneRect.left),
      randRechts: Math.round(buehneRect.right - (gitter?.right ?? pane.right)),
      randOben: Math.round((gitter?.top ?? pane.top) - buehneRect.top),
      randUnten: Math.round(buehneRect.bottom - (gitter?.bottom ?? pane.bottom)),
    },
    // DIE KOPFZEILEN DER KACHELN (seit dem 03.09.2026 eine Zeile je Pane statt
    // eines schwebenden Schildes, Prueferbefund 7). Der Schluessel heisst
    // weiter `schilder`: der Steuerkanal liest ihn, und eine Umbenennung haette
    // nur den Bericht gebrochen. `deckt` bleibt eine echte Messung und ist
    // jetzt bauartbedingt null -- die Zeile nimmt sich ihren Platz, sie leiht
    // ihn nicht. `ecke` sagt `oben`: die Zeile laeuft ueber die volle Breite,
    // eine Ecke hat sie nicht mehr.
    schilder: [...gitterEl.querySelectorAll<HTMLDivElement>('.panekasten')].map((k) => {
      const kopf = k.querySelector<HTMLDivElement>('.panekopf');
      const name = kopf?.querySelector<HTMLSpanElement>('.pk-name');
      const r = kopf?.getBoundingClientRect();
      const id = k.dataset.pane ?? '';
      const verborgen = !!kopf && kopf.style.display === 'none';
      return {
        pane: id,
        text: name?.textContent ?? '',
        modell: kopf?.querySelector('.pk-modell')?.textContent ?? '',
        tokens: kopf?.querySelector('.pk-tokens')?.textContent ?? '',
        kurz: !!kopf?.classList.contains('kurz'),
        flach: !!kopf?.classList.contains('ohne-modell'),
        verborgen,
        aktiv: !!kopf?.classList.contains('aktiv'),
        ecke: kopf && !verborgen ? 'oben' : '',
        deckt: kopf && !verborgen && r ? belegteZellen(id, r) : 0,
        // Die Hoehe der Zeile, wie sie WIRKLICH gezeichnet ist -- daran haengt
        // der Abzug in der Kachelrechnung.
        hoehe: r ? Math.round(r.height) : 0,
        zoom: !!kopf?.querySelector('.pk-zoom'),
        schriftgroesse: name ? Math.round(parseFloat(getComputedStyle(name).fontSize)) : 0,
        paneBreite: Math.round(k.getBoundingClientRect().width),
        paneHoehe: Math.round(k.getBoundingClientRect().height),
        rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
      };
    }),
    // Wo die Kacheln liegen -- Lage UND Groesse. Die Zahlen kommen aus
    // `letzteKacheln`, der Geometrie WIE SIE GESETZT wurde, und nicht aus einer
    // eigenen Messung je Kasten: zwei Kacheln, deren Kante auf derselben
    // Fliesskommazahl beruht, beruehren sich exakt, aber ihre unabhaengig
    // gerundeten Melder taten es nicht mehr.
    lagen: [...gitterEl.querySelectorAll<HTMLDivElement>('.panekasten, .panefehlt')].map((k) => {
      const pid = k.dataset.pane ?? '';
      const kachel = letzteKacheln.get(pid);
      if (kachel) {
        // `h` ist die ganze Kachel, `kopf` die Zeile darin und `schirmH` das,
        // was dem Terminal bleibt. Drei Zahlen statt einer, weil zwei
        // verschiedene Zusagen daran haengen: dass die KACHELN die Flaeche
        // fuellen (h), und dass der INHALT in seine Kachel passt (schirmH).
        return {
          pane: pid, x: kachel.x, y: kachel.y, b: kachel.b, h: kachel.h,
          kopf: kachel.kopf, schirmH: kachel.h - kachel.kopf, fehlt: kachel.fehlt,
        };
      }
      const r = k.getBoundingClientRect();
      return {
        pane: pid,
        x: Math.round(r.left - buehneRect.left),
        y: Math.round(r.top - buehneRect.top),
        b: Math.round(r.width),
        h: Math.round(r.height),
        kopf: 0,
        schirmH: Math.round(r.height),
        fehlt: k.classList.contains('panefehlt'),
      };
    }),
    // Angefordert, aber nicht zu zeichnen -- mit dem Grund. Ein Worker, der
    // ohne ein Wort verschwindet, ist schlimmer als einer, der schlecht sitzt.
    fehlend: letzteLage?.fehlend ?? [],
    // Ob die Anwendung im Pane die Maus verfolgt -- die Zahl, an der sich
    // entscheidet, wem das Rad gehoert.
    maus: [...mausModus].map(([p, m]) => ({ pane: p, an: m.an, sgr: m.sgr })),
    terminals: [...paneTerms].map(([p, e]) => {
      // Der Kasten, den wir dem Pane geben, und die Flaeche, die xterm
      // WIRKLICH zeichnet. Laufen sie auseinander, wird die unterste Zeile
      // angeschnitten -- und genau dort steht die Eingabezeile.
      const kasten = e.el.getBoundingClientRect();
      const schirm = e.el.querySelector('.xterm-screen')?.getBoundingClientRect();
      return {
        pane: p,
        cols: e.term.cols,
        rows: e.term.rows,
        kasten: [Math.round(kasten.width * 100) / 100, Math.round(kasten.height * 100) / 100],
        schirm: schirm ? [Math.round(schirm.width * 100) / 100, Math.round(schirm.height * 100) / 100] : null,
      };
    }),
    // Die eingestellte Schriftgroesse und die Zellgroesse, die daraus faellt.
    // Beide Zellmasse nebeneinander: das des gezeichneten Panes (das gilt) und
    // das des Mass-Terminals.
    schrift: {
      groesse: schriftgroesse,
      zelle: zellmass(),
      zelleMassTerminal: (() => {
        const g = paneEl.querySelector('.xterm-screen')?.getBoundingClientRect();
        return g && term.cols && term.rows && g.width > 0
          ? { breite: g.width / term.cols, hoehe: g.height / term.rows }
          : null;
      })(),
    },
    auskunft: { ...auskunft },
  };
}

/**
 * Die Testhaken, die auf einem PANE arbeiten. Sie wandern mit der Flaeche, weil
 * sie ihre Innereien brauchen -- Puffer, Zellhoehe, Rad-Rechnung, Renderer je
 * Pane. `renderer.ts` haengt sie an `window.__awb`, zusammen mit seinen eigenen.
 */
export function paneflaecheHaken() {
  return {
    /**
     * Wieviele ZEILEN eine Folge von Rad-Ereignissen ergibt. Genau die Zahl, um
     * die es bei „viel zu schnell" geht -- ohne Umweg ueber einen Puffer, und
     * damit fuer ein Trackpad (viele kleine Wege) und eine Maus (wenige grosse)
     * gleichermassen nachrechenbar. Der Sammelrest wird vorher geleert, sonst
     * misst man den Rest der vorigen Messung mit.
     */
    radmass(p: { deltas: number[]; modus?: number; zeilen?: number; zellhoehe?: number }): unknown {
      radRest = 0;
      const zeilenImPane = p?.zeilen ?? 40;
      // Die Zellhoehe darf vorgegeben werden: sonst haengt eine Rechenprobe an
      // der Schrift, mit der das Fenster gerade zeichnet, und misst zwei Dinge
      // auf einmal.
      const zellhoehe = p?.zellhoehe && p.zellhoehe > 0 ? p.zellhoehe : Math.max(1, zellmass().hoehe);
      const je = (p?.deltas ?? []).map((d) =>
        radZeilen({ deltaY: d, deltaMode: p?.modus ?? 0 }, zeilenImPane, zellhoehe),
      );
      return {
        je,
        summe: je.reduce((a, b) => a + b, 0),
        // Wieviele Ereignisse gar nichts bewirkt haben -- die Zahl hinter
        // „reagiert manchmal gar nicht".
        null: je.filter((z) => !z).length,
        zeilenJeRasterung: scrollZeilen,
        deckel: Math.max(6, zeilenImPane - 1),
        zellhoehe: Math.round(zellhoehe * 100) / 100,
      };
    },

    /**
     * DIE MITSCHRIFT AN- ODER ABSCHALTEN -- und beim Abschalten ausgeben.
     *
     * `an: true` leert sie und faengt an mitzuschreiben; `an: false` gibt
     * zurueck, was seither an echten Rad-Ereignissen durch die Rechnung lief.
     * Dazu die Stelle des Panes im Fenster und sein Zellmass, denn der Weg nach
     * draussen (`sendInputEvent`, siehe main.ts 'rad-strom') braucht einen
     * Punkt, an dem das Ereignis landen soll.
     */
    radAufnahme(paneId: string, an: boolean): unknown {
      const eintrag = paneTerms.get(paneId) ?? paneTerms.get(aktiverPane);
      const schirm = eintrag?.el.querySelector('.xterm-screen')?.getBoundingClientRect();
      const ereignisse = radMitschrift ?? [];
      if (an) {
        radMitschrift = [];
        radRest = 0;
      } else {
        radMitschrift = null;
      }
      const buf = eintrag?.term.buffer.active;
      return {
        ereignisse: an ? [] : ereignisse,
        null: an ? 0 : ereignisse.filter((e) => !e.zeilen).length,
        summe: an ? 0 : ereignisse.reduce((a, e) => a + e.zeilen, 0),
        x: schirm ? Math.round(schirm.left + schirm.width / 2) : 0,
        y: schirm ? Math.round(schirm.top + schirm.height / 2) : 0,
        zellhoehe: schirm && eintrag?.term.rows ? Math.round((schirm.height / eintrag.term.rows) * 100) / 100 : 0,
        viewportY: buf?.viewportY ?? -1,
        baseY: buf?.baseY ?? -1,
        zeilen: eintrag?.term.rows ?? 0,
      };
    },

    async rad(paneId: string, schritte: number, shift?: boolean): Promise<unknown> {
      const eintrag = paneTerms.get(paneId) ?? paneTerms.get(aktiverPane);
      if (!eintrag) return { pane: paneId, fehlt: true };
      // Auf WELCHEM Pane das Ereignis wirklich landet -- der Haken faellt auf
      // den aktiven zurueck, und die Auskunft muss denselben meinen.
      const gemeint = [...paneTerms].find(([, e]) => e === eintrag)?.[0] ?? paneId;
      const el = eintrag.el.querySelector<HTMLElement>('.xterm') ?? eintrag.el;
      // Vorher leeren: was danach hier steht, hat GENAU dieses Rad-Ereignis
      // hinausgeschickt.
      letzteEingabe = null;
      // Der Testweg schickt weiter ein Vielfaches der ZELLHOEHE -- er heisst
      // „schritte" und ist als Weg gemeint, nicht als Zeilenzahl. Wieviele
      // Zeilen daraus werden, entscheidet radZeilen, und genau das soll
      // gemessen werden.
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: schritte * Math.max(1, zellmass().hoehe),
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          shiftKey: !!shift,
        }),
      );
      // `smoothScrollDuration` (TERMOPT, 12.08.) macht `scrollLines()`
      // asynchron: der Puffer bewegt sich erst ueber ein paar Einzelbilder.
      // Ohne diese Wartezeit laese dieser Haken den Stand VOR der Bewegung.
      await rollenBeruhigt();
      const buf = eintrag.term.buffer.active;
      return {
        pane: gemeint,
        viewportY: buf.viewportY,
        baseY: buf.baseY,
        laenge: buf.length,
        zeilen: eintrag.term.rows,
        typ: buf.type,
        mausmodus: !!eintrag.el.querySelector('.xterm.enable-mouse-events'),
        // Was der Haken WIRKLICH gerechnet hat. `mausmodus` oben liest nur das
        // Terminal im Fenster, und das weiss von einer Umschaltung nichts, die
        // vor seinem Aufbau kam -- die kennt nur tmux (mausModus).
        mausAn: !!eintrag.el.querySelector('.xterm.enable-mouse-events') || !!mausModus.get(gemeint)?.an,
        // Ob dieses Terminal seinen Rueckblick hat -- die Buchfuehrung, an der
        // haengt, ob nachgefordert wird.
        rueckblick: eintrag.rueckblickDa,
        // Was dieses Ereignis an den Pane geschickt hat -- lesbar gemacht,
        // damit sich auch auf dem Alternativschirm belegen laesst, DASS es
        // etwas tat.
        gesendet: eingabeLesbar(),
      };
    },

    /**
     * NUR FUER TESTS: WebGL fuer dieses Fenster unbrauchbar machen -- damit sich
     * der Rueckfall auf Canvas ausloesen laesst, ohne auf einen
     * Chromium-Schalter angewiesen zu sein, der je nach Treiber trotzdem noch
     * einen Kontext liefert. Zwei Haelften: der naechste Kontextwunsch bekommt
     * nichts mehr, UND jedes Terminal, das sein WebGL schon geladen hat, wird
     * hier umgestellt. Eine Sperre, die einen laufenden Fall auslaesst, ist eine
     * Zusage mit einer Ausnahme, die nirgends steht.
     */
    webglSperren(): boolean {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, art: string, ...rest: unknown[]) {
        if (art === 'webgl2' || art === 'webgl') return null;
        return (original as (...a: unknown[]) => unknown).apply(this, [art, ...rest]);
      } as typeof HTMLCanvasElement.prototype.getContext;
      // Ueber eine Kopie laufen: `canvasLaden()` schreibt in `rendererJePane`,
      // und `delete` waehrend des Durchlaufs waere ein Griff in die
      // Sammelstelle, aus der gerade gelesen wird.
      for (const [id, { addon, term: t }] of [...webglJeTerminal]) {
        webglJeTerminal.delete(id);
        try {
          addon.dispose();
        } catch {
          // Schon abgeworfen oder nie richtig oben -- der naechste Schritt
          // (Canvas laden) ist trotzdem der richtige.
        }
        canvasLaden(id, t);
      }
      return true;
    },

    /**
     * NUR FUER TESTS (clipfixtest): eine Auswahl im Terminal setzen oder
     * loeschen, ohne einen echten Ziehvorgang der Maus. `hasSelection()` ist
     * genau das, wonach `terminalZwischenablageHaken` selbst fragt.
     */
    zwischenablageAuswahl(paneId: string, an: boolean): boolean {
      const eintrag = paneTerms.get(paneId) ?? paneTerms.get(aktiverPane);
      if (!eintrag) return false;
      if (an) eintrag.term.selectAll();
      else eintrag.term.clearSelection();
      return eintrag.term.hasSelection();
    },

    /**
     * NUR FUER TESTS (clipfixtest): eine echte Taste auf dem versteckten
     * Textfeld des Terminals ausloesen -- xterm.js haengt seinen
     * `keydown`-Zuhoerer GENAU DORT an, nicht an `document`. Ein
     * `dispatchEvent` dort durchlaeuft denselben Weg wie ein echter
     * Tastendruck: erst unser Haken, dann xterms eigene Auswertung.
     */
    zwischenablageTaste(paneId: string, opt: { taste: string; shift?: boolean }): { verhindert: boolean } {
      const eintrag = paneTerms.get(paneId) ?? paneTerms.get(aktiverPane);
      if (!eintrag) return { verhindert: false };
      const feld = eintrag.el.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
      if (!feld) return { verhindert: false };
      letzteEingabe = null;
      const taste = opt.taste.length === 1 && opt.shift ? opt.taste.toUpperCase() : opt.taste.toLowerCase();
      const ev = new KeyboardEvent('keydown', {
        key: taste,
        code: `Key${taste.toUpperCase()}`,
        keyCode: taste.toUpperCase().charCodeAt(0),
        ctrlKey: true,
        shiftKey: !!opt.shift,
        altKey: false,
        metaKey: false,
        bubbles: true,
        cancelable: true,
      });
      const nichtVerhindert = feld.dispatchEvent(ev);
      return { verhindert: !nichtVerhindert };
    },

    /** NUR FUER TESTS (clipfixtest): was der letzte `zwischenablageTaste`-Aufruf an den Pane geschickt hat. */
    zwischenablageGesendet(): string {
      return eingabeLesbar();
    },

    /**
     * NUR FUER TESTS (clipfixtest): die Bildschirmmitte eines Zielfeldes fuer
     * einen ECHTEN Rechtsklick (`sendInputEvent` in main.ts). `'editierbar'`
     * trifft das Umbenennen-Feld -- es steckt hinter `.sichtbar` und wird hier
     * eigens dafuer eingeblendet, sonst liefert `getBoundingClientRect` eine
     * Nullflaeche. Jede andere Kennung zielt auf `.xterm-screen`, die sichtbare
     * Zeichenflaeche -- NICHT auf `xterm-helper-textarea`: an der klickt
     * niemand, ein echter Rechtsklick trifft die Flaeche darueber.
     */
    zwischenablageKontextmenuZiel(ziel: string): { x: number; y: number } | null {
      let el: HTMLElement | null = null;
      if (ziel === 'editierbar') {
        document.getElementById('umbenennen')?.classList.add('sichtbar');
        el = document.getElementById('umbenennen-feld');
      } else {
        const eintrag = paneTerms.get(ziel) ?? paneTerms.get(aktiverPane);
        el = eintrag?.el.querySelector<HTMLElement>('.xterm-screen') ?? null;
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },

    /**
     * NUR FUER TESTS UND DEN HAUPTPROZESS (clipmenu, 17.08.): fuer das
     * `context-menu`-Ereignis in main.ts -- `params.isEditable` folgt dort dem
     * FOKUS, nicht der Klickposition, deshalb fragt der Hauptprozess hier
     * eigens nach, welcher Pane unter (x, y) liegt. `auswahlText` wird SOFORT
     * mitgegeben: das Menue soll genau die Auswahl kopieren, die beim Oeffnen
     * bestand.
     */
    kontextZiel(x: number, y: number): { paneId: string; hatAuswahl: boolean; auswahlText: string } | null {
      const el = document.elementFromPoint(x, y);
      const kasten = el?.closest<HTMLElement>('.panekasten');
      const paneId = kasten?.dataset.pane ?? '';
      const eintrag = paneId ? paneTerms.get(paneId) : undefined;
      if (!eintrag) return null;
      const hatAuswahl = eintrag.term.hasSelection();
      return { paneId, hatAuswahl, auswahlText: hatAuswahl ? eintrag.term.getSelection() : '' };
    },

    /**
     * NUR FUER DEN HAUPTPROZESS (clipmenu, 17.08.): "Einfuegen" aus dem
     * Terminal-Kontextmenue. Derselbe Griff wie Strg+Umschalt+V, nur dass der
     * Text schon da ist: der Hauptprozess hat die Zwischenablage selbst gelesen.
     */
    kontextEinfuegen(paneId: string, text: string): boolean {
      const eintrag = paneTerms.get(paneId) ?? paneTerms.get(aktiverPane);
      if (!eintrag || !text) return false;
      eintrag.term.paste(text);
      return true;
    },

    /** Welcher Renderer auf diesem Pane wirklich zeichnet -- webgl, canvas oder dom. */
    rendererArt(paneId: string): string {
      return rendererJePane.get(paneId) ?? (paneTerms.has(paneId) ? 'dom' : '');
    },

    /**
     * Wieviel Zeit zwischen aufeinanderfolgenden Bildern liegt, waehrend
     * fortlaufend Rad-Ereignisse denselben Pane hochrollen -- die Zahl, ohne
     * die "haekelig" eine Meinung bleibt (12.08.). Xterm plant sein eigenes
     * Neuzeichnen ueber ein rAF, registriert waehrend des synchronen
     * `dispatchEvent`: der Abstand zwischen zwei rAF-Zeitstempeln traegt damit
     * die Zeichenarbeit dieses Bildes mit.
     */
    async scrollLeistung(paneId: string, p: { bilder?: number; raster?: number }): Promise<{
      deltas: number[]; renderer: string; laenge: number; zeilen: number; baseY: number;
    }> {
      const eintrag = paneTerms.get(paneId) ?? paneTerms.get(aktiverPane);
      if (!eintrag) return { deltas: [], renderer: '', laenge: 0, zeilen: 0, baseY: 0 };
      const el = eintrag.el.querySelector<HTMLElement>('.xterm') ?? eintrag.el;
      const bilder = Math.max(2, Math.floor(p?.bilder ?? 120));
      const raster = Math.max(1, p?.raster ?? 3);
      const deltas: number[] = [];
      let voriger: number | null = null;
      for (let i = 0; i < bilder; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            // Negativ: rad hoch, in den Rueckblick hinein -- das ist der Fall,
            // den alice gemeldet hat, und er braucht Puffer darueber.
            deltaY: -RASTER_PIXEL * raster,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
        const zeit = await new Promise<number>((res) => requestAnimationFrame(res));
        if (voriger !== null) deltas.push(zeit - voriger);
        voriger = zeit;
      }
      const buf = eintrag.term.buffer.active;
      const gemeint = [...paneTerms].find(([, e]) => e === eintrag)?.[0] ?? paneId;
      return {
        deltas,
        renderer: rendererJePane.get(gemeint) ?? 'dom',
        laenge: buf.length,
        zeilen: eintrag.term.rows,
        baseY: buf.baseY,
      };
    },

    /**
     * Der Text des gezeichneten Panes. Zeigt die Mitte mehrere, kommt der Text
     * des GEWAEHLTEN zuerst und die uebrigen darunter -- so bleibt eine
     * Pruefung auf "steht das im Fenster?" in beiden Ansichten richtig.
     */
    bufferText(): string {
      const reihenfolge = [
        ...(paneTerms.has(aktiverPane) ? [aktiverPane] : []),
        ...[...paneTerms.keys()].filter((id) => id !== aktiverPane),
      ];
      const teile: string[] = [];
      for (const id of reihenfolge) {
        const buf = paneTerms.get(id)!.term.buffer.active;
        const zeilen: string[] = [];
        for (let i = 0; i < buf.length; i++) zeilen.push(buf.getLine(i)?.translateToString(true) ?? '');
        teile.push(zeilen.join('\n').replace(/\n+$/, ''));
      }
      return teile.join('\n');
    },

    /**
     * Nur der SICHTBARE Schirm je Pane -- das Gegenstueck zu `capture-pane -p`.
     *
     * `bufferText()` gibt den ganzen Puffer aus, Bildlauf eingeschlossen, und
     * das ist fuer die Frage "steht das im Fenster?" richtig. Fuer die Frage
     * "zeigt das Fenster denselben Schirm wie tmux?" ist es falsch: xterm
     * bricht beim Verkleinern die alten Zeilen neu um und schiebt sie in den
     * Bildlauf, tmux kennt dort nichts davon.
     */
    schirmText(): string {
      const reihenfolge = [
        ...(paneTerms.has(aktiverPane) ? [aktiverPane] : []),
        ...[...paneTerms.keys()].filter((id) => id !== aktiverPane),
      ];
      const teile: string[] = [];
      for (const id of reihenfolge) {
        const t = paneTerms.get(id)!.term;
        const buf = t.buffer.active;
        const zeilen: string[] = [];
        for (let i = 0; i < t.rows; i++) {
          zeilen.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? '');
        }
        teile.push(zeilen.join('\n').replace(/\n+$/, ''));
      }
      return teile.join('\n');
    },
  };
}
