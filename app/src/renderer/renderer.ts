// Die Oberflaeche: linke Symbolleiste mit den Sessions, in der Mitte ein
// echter tmux-Pane, rechts der Wechsel zwischen Orchestrator und Workern.
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { initFreigabenView, freigabenUiState } from './freigaben-view';
import { initAktivitaetView, aktivitaetUiState } from './aktivitaet-view';
import { initOrdnerView, ordnerUiState } from './ordner-view';
import { initProtokolleView, protokolleUiState } from './protokolle-view';
import { ErgebnisMeldung, Meldungen } from './meldungen';
import { initEditorView } from './editor-view';
import { Seiten, type PlanAnzeige } from './seiten-view';
import { initFussStatus, zeichneStatuszeile } from './fuss-status';
// SPEC-V4 Abschnitt 6: die Chat-Ansicht liegt UEBER dem Pane, nicht an seiner
// Stelle -- der Pane bleibt darunter, laeuft weiter und wird weiter ausgewertet.
// Deshalb haengt sie an dem Kasten, in dem auch das Terminal zeichnet, und
// deshalb sind es hier nur diese wenigen Zeilen (Anlegen, Aufraeumen).
import { ChatAnbindung } from '../chat/anbindung';
import { setzeSprache as setzeChatSprache, t as chatT } from '../chat/texte';
import '../chat/ansicht.css';
// Die CHAT-SITZUNG (13.08.) -- nicht zu verwechseln mit der Lese-Ansicht eines
// Panes darueber: das hier ist eine eigene Sitzung mit eigenem Prozess, die
// anstelle der Kacheln auf der Buehne liegt. Ihre Ansicht ist reines DOM
// (chatbuehne/ansicht.ts), diese Datei haengt sie nur ein.
import { Chatbuehne, type ChatBruecke } from './chatbuehne-view';
import '../chatbuehne/ansicht.css';

interface SessionPayload {
  session: string;
  cols: number;
  rows: number;
  sizePolicy: string;
  panes: { paneId: string; width: number; height: number; active: boolean }[];
  activePane: string;
  initialContent: string;
}

interface PaneBox { paneId: string; x: number; y: number; cols: number; rows: number }
interface LayoutPayload {
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

interface Subagent { paneId: string; name: string; type: string; agentId: string }
interface Worker {
  name: string; kind: string; model: string; paneId: string; alive: boolean;
  cpu: number; state: string; subagents: Subagent[];
  /** Worker, auf dessen ANTRAG dieser entstanden ist. Leer, wenn keiner. */
  requestedBy: string;
  /** Ein eigener Antrag wartet auf die Entscheidung. */
  pendingRequest: boolean;
  /** Warum er blockiert ist: offener Antrag oder ein Guard hat ihn angehalten. */
  blockedReason: '' | 'request' | 'guard';
  /** Kontextauslastung aus dem Transcript, -1 = unbekannt (V1). */
  contextPercent: number;
  contextTokens: number;
  contextWindow: number;
  transcriptPath: string;
  /** Sekunden ohne Bewegung im Transcript, -1 = unbekannt. */
  idleSeconds: number;
  /** Die Ergebnisdatei, sobald es eine gibt (V2). */
  resultPath: string;
  resultAt: number;
  /** Beschriftung eines Workers, der aus einem PANE stammt (sessions.ts, `fremdePanes`). */
  titel?: string;
}
interface Session {
  id: string; name: string; dir: string; machine: string; tmuxSession: string;
  alive: boolean; reachable: boolean; state: string; initials: string;
  owned: boolean; orchestratorPane: string; workers: Worker[];
  pendingApprovals: number; orphanSubagents: Subagent[];
  /** V14: die Unterhaltung dieser Session -- leer, wenn keine gemerkt ist. */
  claudeSessionId: string;
  /**
   * Sie lief noch, als dieses Programm zuletzt hinsah, und ist jetzt weg
   * (11.08.). Gilt nur zusammen mit `state === 'stopped'`; gezeigt wird sie
   * deshalb, obwohl beendete Sitzungen sonst ausgeblendet sind.
   */
  verloren?: boolean;
  /**
   * Fuer diesen Ordner laeuft gerade ein Start (21.08.): die Zustandsdatei ist
   * da, die tmux-Sitzung noch nicht. Bei einem lokalen Modell dauert das
   * Minuten. Gilt wie `verloren` nur zusammen mit `state === 'stopped'`.
   */
  startet?: boolean;
  /** Der letzte Start fuer diesen Ordner ist gescheitert (21.08.). */
  startFehler?: boolean;
  sessionKey: string;
  /** Harness und Modell, mit denen sie lief -- aus ihrer Zustandsdatei. */
  harness?: string;
  model?: string;
  /**
   * Nur bei einer toten Session: was der Knopf tun wird. Kommt fertig aus dem
   * Hauptprozess, damit hier kein zweites Urteil entsteht.
   */
  revive?: { conversation: 'resumed' | 'fresh'; reason: string };
}
interface AmpelBefund { quelle: string; vorhanden: boolean; rot: boolean; ueberfaellig: boolean; ueberholt: boolean; ageDays: number; text: string }
interface AmpelStand { machine: string; befunde: AmpelBefund[]; farbe: 'rot' | 'gelb' | 'gruen' | 'unbekannt' }
/**
 * Farben durchreichen (11.08.): dieselbe Form wie `ThemaPayload` in
 * main/thema.ts, hier noch einmal deklariert statt importiert -- Renderer und
 * Hauptprozess bleiben getrennte Prozesse, keine Datei dieses Fensters
 * importiert bisher aus main/, und ein Nur-Typ-Import waere die erste
 * Ausnahme davon.
 */
interface ThemaPayload {
  thema: string;
  wirksam: 'hell' | 'dunkel';
  zustandsfarben: Record<string, string>;
  zustandsfarbenLesbar: Record<string, string>;
  zustandsfarbenTinte: Record<string, string>;
}
interface BudgetStand { ok: boolean; heuteTokens: number; heuteStunden: number; hochrechnung24h: number; text: string }
interface Model {
  sessions: Session[];
  all: number;
  ui: { sidebarWidth: number; showStopped: boolean; sort: string; order: string[]; selected: string; workerTab: number; rightWidth: number };
  selected: string;
  machine: string;
  capacity: { perRow: number; perColumn: number; perTab: number; cappedBySetting: boolean; tabs: number; workerCount: number };
  /** Wieviele FREMDE Clients an der gezeichneten Session haengen (06.08.). */
  fremdeClients: number;
  /** Schriftgroesse der Terminals in Pixeln, aus den Einstellungen (06.08.). */
  schriftgroesse: number;
  /** Zeilen je Rad-Rasterung, aus den Einstellungen (06.08.). */
  scrollZeilen: number;
  streamPane: string;
  mayArrange: boolean;
  /**
   * Die Chat-Sitzungen (12.08.) -- eine EIGENE Liste neben `sessions`. Sie
   * haben keinen Pane, keinen Worker und keinen tmux-Zustand; sie in
   * `sessions` zu mischen haette jede Verzweigung dort um die Frage
   * erweitert, welche Sorte gerade vorliegt.
   */
  chats?: {
    id: string; name: string; ordner: string; zuletzt: string; laeuft: boolean;
    /** Die tmux-Session, in der die Worker DIESER Sitzung landen (Punkt 1). */
    tmuxSession?: string;
    /** Was gerade darin steht -- gemessen an tmux, bei jedem Takt. */
    worker?: { name: string; paneId: string; laeuft: boolean }[];
  }[];
  /**
   * DIE REIHENFOLGE DER LEISTE -- eine Liste fuer beide Sorten (Punkt 4). Der
   * Hauptprozess sortiert sie EINMAL mit derselben Funktion und derselben
   * Voreinstellung, die die Terminal-Sitzungen schon hatten; hier steht nur
   * noch, welche Zeile an welche Stelle gehoert und aus welcher der beiden
   * Listen ihr Inhalt kommt.
   */
  leiste?: { art: 'terminal' | 'chat'; id: string }[];
  /**
   * Liegt statt eines Gespraechs ein WORKER einer Chat-Sitzung auf der Buehne
   * (Punkt 1)? Dann bleibt ihre Zeile hervorgehoben -- der Mensch ist bei
   * dieser Sitzung, nur eben bei einem ihrer Worker.
   */
  chatWerkstattGezeigt?: string;
  /**
   * WELCHE Chat-Sitzung auf der Buehne liegt (13.08.). Leer heisst: die Kacheln
   * der gewaehlten Terminal-Sitzung. Der Hauptprozess entscheidet das, nicht
   * dieser Renderer -- hier steht nur, was daraus folgt (chatbuehne-view.ts).
   */
  chatGezeigt?: string;
  ampel: AmpelStand[];
  budget: BudgetStand | null;
}

declare global {
  interface Window {
    awbBridge: {
      ready(): void;
      onSession(fn: (p: SessionPayload) => void): void;
      onOutput(fn: (p: { paneId: string; data: string }) => void): void;
      onLayout(fn: (p: LayoutPayload) => void): void;
      onModel(fn: (p: Model) => void): void;
      onKanal(fn: (p: { pfad: string; fehler: string | null }) => void): void;
      // V20: die Freigabe-Ansicht -- ihre eigene Nutzlast, siehe freigaben-view.ts.
      onFreigaben(fn: (p: unknown) => void): void;
      onErgebnis(fn: (p: ErgebnisMeldung) => void): void;
      // 4c: Ordneransicht, Aktivitaetsliste, Inhaltssuche -- eigene Nutzlast je Datei.
      onOrdner(fn: (p: unknown) => void): void;
      onMaus(fn: (p: Record<string, { an: boolean; sgr: boolean }>) => void): void;
      onAktivitaet(fn: (p: unknown) => void): void;
      onSuche(fn: (p: unknown) => void): void;
      onSeite(fn: (p: { name: string }) => void): void;
      // Reste-Auftrag Punkt 3: die Datei hinter einer Seite hat sich von
      // aussen geaendert -- ob deshalb neu gezeichnet wird, entscheidet
      // 'seiten.aufDateiAendern', nicht dieser Kanal.
      onDateiGeaendert(fn: (p: { name: string }) => void): void;
      onPlan(fn: (p: PlanAnzeige) => void): void;
      onPlanErgebnis(fn: (p: { ok: boolean; ausgabe: string }) => void): void;
      input(paneId: string, base64: string): void;
      bedienung(aktion: string, wert: unknown): void;
      /**
       * Dieses Terminal hat keinen Rueckblick -- der Hauptprozess soll ihn
       * schicken. Der Renderer ist die einzige Stelle, die das WEISS: nur hier
       * liegt der Puffer (siehe rueckblickAnfordern).
       */
      rueckblickFehlt(paneId: string): void;
      /** Rechtsklick auf eine Sitzung -- die Echtheit des Ereignisses reist mit. */
      sitzungsMenue(id: string, echt: boolean): void;
      /** Der Hauptprozess fragt nach einem neuen Namen fuer diese Sitzung. */
      onUmbenennen(fn: (p: { id: string; name: string; dir: string }) => void): void;
      /** Was ein Griff ergeben hat -- Text fuer die Zeile ueber der Buehne. */
      onMeldung(fn: (p: { text: string }) => void): void;
      /** Dieser Pane zeigt ab jetzt das Gespraech (oder wieder das Terminal). */
      onChatAnsicht(fn: (p: { paneId: string; an: boolean }) => void): void;
      /** Der eingegebene Name -- geschrieben wird er ueber `wb-state`. */
      umbenennen(id: string, name: string): Promise<{ ok: boolean; meldung: string; aufruf: string }>;
      /** Farben durchreichen (11.08.): einmal alles, aus main/thema.ts. */
      thema(): Promise<ThemaPayload>;
      /** Dieselben Daten, erneut -- die Einstellungsdatei hat sich geaendert oder das System das Thema. */
      onThema(fn: (p: ThemaPayload) => void): void;
      /** Die System-Zwischenablage, fuer Strg+Umschalt+C/V im Terminal (siehe terminalZwischenablageHaken). */
      zwischenablageLesen(): Promise<string>;
      zwischenablageSchreiben(text: string): Promise<void>;
    };
    /**
     * Die Chat-Sitzung auf der Buehne (13.08.). Eigener Namensraum, kein Teil
     * von `awbBridge` -- siehe preload/preload.ts. Fehlt er (ein Fenster ohne
     * diese Bruecke), bleibt der Kasten leer statt dass etwas bricht.
     */
    awbChat?: ChatBruecke;
    __awb: { bufferText(): string; schirmText(): string; uiState(): unknown; seitenState(): Promise<unknown>; seiteRollen(a: string): Promise<boolean>; seiteKlick(a: string): Promise<boolean>; seiteFokus(a: string): Promise<boolean>; seiteUnfokus(): Promise<boolean>; seiteSchliessenKlick(): boolean; trefferBei(x: number, y: number): { tag: string; id: string; klassen: string }; rad(paneId: string, schritte: number, shift?: boolean): Promise<unknown>; radmass(p: { deltas: number[]; modus?: number; zeilen?: number; zellhoehe?: number }): unknown; radAufnahme(paneId: string, an: boolean): unknown; rendererArt(paneId: string): string; scrollLeistung(paneId: string, p: { bilder?: number; raster?: number }): Promise<{ deltas: number[]; renderer: string; laenge: number; zeilen: number; baseY: number }>; webglSperren(): boolean; zwischenablageAuswahl(paneId: string, an: boolean): boolean; zwischenablageTaste(paneId: string, opt: { taste: string; shift?: boolean }): { verhindert: boolean }; zwischenablageGesendet(): string; zwischenablageKontextmenuZiel(ziel: string): { x: number; y: number } | null; kontextZiel(x: number, y: number): { paneId: string; hatAuswahl: boolean; auswahlText: string } | null; kontextEinfuegen(paneId: string, text: string): boolean };
  }
}

/**
 * Die Schriftgroesse der Terminals. 13 ist nur die Vorgabe fuer den Augenblick
 * VOR der ersten Modell-Meldung -- die gueltige Zahl steht in der geteilten
 * Einstellungsdatei (`terminalFontSize`, 8 bis 32) und kommt mit jedem Modell
 * mit. Sie hier fest zu lassen hiesse, dem Menschen die Schriftgroesse seines
 * eigenen Fensters vorzuschreiben.
 */
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

const TERMOPT = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: schriftgroesse,
  theme: { background: '#101216', foreground: '#d8dee9' },
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
const linksEl = document.getElementById('links') as HTMLDivElement;
const rechtsEl = document.getElementById('rechts') as HTMLDivElement;
const sessionsEl = document.getElementById('sessions') as HTMLDivElement;
const rechtsListeEl = document.getElementById('rechtsliste') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const hinweisEl = document.getElementById('hinweis') as HTMLDivElement;
const griffEl = document.getElementById('griff') as HTMLDivElement;
const griffRechtsEl = document.getElementById('griff-rechts') as HTMLDivElement;
const notizEl = document.getElementById('notiz') as HTMLDivElement;
const kanalwarnungEl = document.getElementById('kanalwarnung') as HTMLDivElement;
/**
 * DIE CHAT-SITZUNG AUF DER BUEHNE (13.08.). Der Kasten liegt UEBER dem
 * Kachelgitter und ist zu, solange keine Chat-Sitzung gewaehlt ist -- das
 * Gitter darunter wird nicht angefasst, damit die Buehne fuer
 * Terminal-Sitzungen genau bleibt, was sie war.
 */
const chatbuehneEl = document.getElementById('chatbuehne') as HTMLDivElement;
const chatbuehne = new Chatbuehne(chatbuehneEl, window.awbChat);
(window as unknown as Record<string, unknown>).__awbChat = chatbuehne.haken();
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

let modell: Model | null = null;
/** Was die Kopfzeile hergab: bleibt abrufbar, braucht aber keinen Dauerplatz. */
let auskunft = { session: '-', pane: '-', groesse: '-', regel: '-', layout: '-', ansicht: '-' };

/** Leer heisst: es gibt einen Steuerkanal. Sonst der Grund, warum nicht. */
let kanalGrund = '';

let notizUhr: number | undefined;

/** Kurze Rueckmeldung ueber der Buehne. Verschwindet von selbst wieder. */
function notiz(text: string): void {
  if (notizUhr !== undefined) clearTimeout(notizUhr);
  notizEl.textContent = text;
  notizEl.classList.toggle('sichtbar', !!text);
  if (text) {
    notizUhr = setTimeout(() => {
      notizEl.classList.remove('sichtbar');
      notizEl.textContent = '';
    }, 4000) as unknown as number;
  }
}

/** Zwei Zeichen aus einem Namen, so wie die Sessions links ihre tragen. */
function kuerzel(name: string): string {
  const teile = name.split(/[-_. ]+/).filter(Boolean);
  if (teile.length >= 2) return (teile[0][0] + teile[1][0]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}

function farbklasse(zustand: string): string {
  if (zustand === 'running') return 'laeuft';
  if (zustand === 'attention') return 'will';
  if (zustand === 'unreachable') return 'fern';
  return 'aus';
}

/**
 * Die Farbe einer Sitzung, die gerade STARTET, ist nicht die einer beendeten.
 * Rot heisst hier im Haus „laeuft nicht mehr"; ein Start, der laeuft, ist das
 * Gegenteil davon und bekommt deshalb dieselbe Farbe wie „wartet". Ein
 * gescheiterter Start bleibt rot -- er ist wirklich nicht gelaufen.
 */
function startfarbe(s: Session): string {
  return s.startet ? 'will' : farbklasse(s.state);
}

/** Schmal, mittel oder breit -- was ein Eintrag zeigt, haengt an der Breite. */
function breitenmodus(w: number): 'schmal' | 'mittel' | 'breit' {
  if (w <= 64) return 'schmal';
  if (w <= 200) return 'mittel';
  return 'breit';
}

/**
 * DIE SESSIONLEISTE -- EINE Liste fuer beide Sorten (Punkt 4, alice am
 * 12.08.: „die session soll links nicht anders behandelt werden als die
 * terminal sessions, das sortieren sollte nicht ansichtsabhaengig sein").
 *
 * Bis heute standen die Chat-Sitzungen in einem eigenen Abschnitt darunter,
 * hinter einem Trenner, und wurden nach einer eigenen Regel sortiert. Jetzt
 * kommt die Reihenfolge fertig aus dem Hauptprozess (`m.leiste`), gebaut mit
 * genau der Funktion, die die Terminal-Sitzungen schon sortiert hat -- und was
 * die Zeilen unterscheidet, ist allein das Sprechblasen-Kennzeichen.
 *
 * Der Rueckfall ohne `m.leiste` (aeltere Fassung des Hauptprozesses) stellt die
 * alte Ordnung her, statt die Chat-Sitzungen unsichtbar zu machen.
 */
function zeichneSessions(m: Model): void {
  const modus = breitenmodus(m.ui.sidebarWidth);
  linksEl.classList.toggle('schmal', modus === 'schmal');
  linksEl.style.width = `${m.ui.sidebarWidth}px`;
  sessionsEl.replaceChildren();

  const chats = m.chats ?? [];
  const nachId = new Map(m.sessions.map((s) => [s.id, s]));
  const chatNachId = new Map(chats.map((c) => [c.id, c]));
  const reihenfolge = m.leiste ?? [
    ...m.sessions.map((s) => ({ art: 'terminal' as const, id: s.id })),
    ...chats.map((c) => ({ art: 'chat' as const, id: c.id })),
  ];

  for (const eintrag of reihenfolge) {
    if (eintrag.art === 'chat') {
      const c = chatNachId.get(eintrag.id);
      if (c) sessionsEl.appendChild(chatZeile(c, m, modus));
      continue;
    }
    const s = nachId.get(eintrag.id);
    if (s) sessionsEl.appendChild(terminalZeile(s, m, modus));
  }
}

/**
 * EINE ZEILE VON HAND UMHAENGEN -- fuer BEIDE Sorten dieselbe Fassung (Punkt 4).
 *
 * Bis heute waren nur die Terminal-Zeilen ziehbar, und die Reihenfolge, in die
 * gelegt wurde, kam aus `m.sessions`. Eine Chat-Sitzung liess sich damit nicht
 * umhaengen und rutschte hinter jede von Hand gelegte Terminal-Sitzung --
 * genau die Ungleichbehandlung, um die es geht. Gearbeitet wird jetzt auf der
 * gemeinsamen Reihenfolge `m.leiste`; sie enthaelt beide Sorten und ist dieselbe,
 * die der Hauptprozess zurueckbekommt.
 */
function ziehbar(zeile: HTMLDivElement, id: string, m: Model): void {
  zeile.draggable = true;
  zeile.addEventListener('dragstart', (e) => {
    zeile.classList.add('zieht');
    e.dataTransfer?.setData('text/plain', id);
  });
  zeile.addEventListener('dragend', () => zeile.classList.remove('zieht'));
  zeile.addEventListener('dragover', (e) => {
    e.preventDefault();
    zeile.classList.add('ziel');
  });
  zeile.addEventListener('dragleave', () => zeile.classList.remove('ziel'));
  zeile.addEventListener('drop', (e) => {
    e.preventDefault();
    zeile.classList.remove('ziel');
    const gezogen = e.dataTransfer?.getData('text/plain') ?? '';
    if (!gezogen || gezogen === id) return;
    const alle = (m.leiste ?? m.sessions.map((x) => ({ id: x.id }))).map((x) => x.id);
    const ids = alle.filter((x) => x !== gezogen);
    const stelle = ids.indexOf(id);
    if (stelle < 0) return;
    ids.splice(stelle, 0, gezogen);
    window.awbBridge.bedienung('order', ids);
  });
}

/** Eine Zeile fuer eine TERMINAL-Sitzung. */
function terminalZeile(
  s: Session,
  m: Model,
  modus: 'schmal' | 'mittel' | 'breit',
): HTMLDivElement {
  {
    const zeile = document.createElement('div');
    // `startet` und `startfehler` kommen als eigene Klassen dazu, nicht statt
    // `zustand-stopped`: der Zustand ist weiter 'stopped' (es gibt keinen
    // Pane), die Klasse sagt nur, warum er hier trotzdem steht.
    const startKlasse = s.startet ? ' startet' : (s.startFehler ? ' startfehler' : '');
    zeile.className = `eintrag zustand-${s.state}${startKlasse}`;
    zeile.dataset.id = s.id;
    // Eine verlorene Sitzung steht hier, obwohl beendete ausgeblendet sind --
    // dann gehoert auch der Grund dran, sonst sieht sie aus wie eine Leiche,
    // die der Filter vergessen hat. Dasselbe gilt fuer die beiden Start-Faelle.
    const verlorenSatz = s.verloren ? '\nlief noch, als dieses Fenster zuletzt hinsah' : '';
    const startSatz = s.startet
      ? '\nstartet gerade — bei einem lokalen Modell dauert das Minuten'
      : (s.startFehler ? '\nder Start ist gescheitert; der Grund stand in der Meldung' : '');
    zeile.title = `${s.name} — ${s.machine} — ${s.tmuxSession || 'keine tmux-Session'}${verlorenSatz}${startSatz}`;
    // Gewaehlt ist die Sitzung, die man SIEHT. Liegt eine Chat-Sitzung auf der
    // Buehne, ist das keine Terminal-Sitzung -- zwei hervorgehobene Zeilen
    // waeren die Frage, welche von beiden gilt.
    if (s.id === m.selected && !(m.chatGezeigt ?? '') && !(m.chatWerkstattGezeigt ?? '')) {
      zeile.classList.add('gewaehlt');
    }

    if (modus === 'schmal') {
      // Schmal gibt es nur die zwei Buchstaben, also faerben sie sich selbst.
      const kuerzel = document.createElement('div');
      kuerzel.className = `kuerzel ${startfarbe(s)}`;
      kuerzel.textContent = s.initials;
      zeile.appendChild(kuerzel);
    } else {
      // Aufgezogen wandert die Farbe auf einen Punkt, die Schrift wird neutral.
      const punkt = document.createElement('div');
      punkt.className = `punkt ${startfarbe(s)}-bg`;
      zeile.appendChild(punkt);

      const texte = document.createElement('div');
      texte.className = 'texte';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.name;
      texte.appendChild(name);
      if (modus === 'breit') {
        const zusatz = document.createElement('div');
        zusatz.className = 'zusatz';
        // Was NICHT fertig ist, nicht was gesehen wurde: bei einer nicht
        // einsehbaren Sitzung stand hier sonst "0 Worker" -- eine Zahl, die
        // niemand nachgesehen hat, und die schlimmste der drei moeglichen
        // (sie liest sich wie "da ist nichts mehr"). Solange die Panes
        // abzufragen sind, ist es dieselbe Zahl wie vorher.
        const anzahl = s.workers.filter((w) => w.state !== 'done').length;
        // Waehrend eines Starts ist die Zahl der Worker die uninteressanteste
        // Auskunft, die hier stehen kann -- und „0 Worker" liest sich wie
        // „da ist nichts". Solange etwas laeuft oder gescheitert ist, steht das.
        zusatz.textContent = s.startet
          ? `${s.machine} · startet…`
          : (s.startFehler ? `${s.machine} · Start gescheitert` : `${s.machine} · ${anzahl} Worker`);
        texte.appendChild(zusatz);
      }
      zeile.appendChild(texte);

      // V14: nur eine WIRKLICH tote Session bekommt den Knopf -- kein Pane
      // mehr, ihre Maschine antwortet aber (main.ts prueft das beim Klick
      // ein zweites Mal gegen den dann aktuellen Stand). Zeigt vorher, was
      // passieren wird: Ordner und welche Unterhaltung fortgesetzt wird.
      // NICHT waehrend eines laufenden Starts (21.08.): der Knopf wuerde einen
      // zweiten Start neben den ersten setzen, und der Zustand 'stopped' ist
      // hier nur die Vorstufe zur Sitzung, nicht ihr Ende. Nach einem
      // GESCHEITERTEN Start steht er wieder da -- da ist er genau richtig.
      if (s.state === 'stopped' && !s.startet) {
        const wiederherstellen = document.createElement('button');
        wiederherstellen.type = 'button';
        wiederherstellen.className = 'wiederherstellen';
        wiederherstellen.title = 'Session wiederherstellen';
        wiederherstellen.innerHTML =
          '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">' +
          '<path d="M16 6.5A6.5 6.5 0 1 0 17 11" stroke-linecap="round" /><path d="M17 3v4h-4" stroke-linecap="round" stroke-linejoin="round" /></svg>';
        wiederherstellen.addEventListener('click', (e) => {
          e.stopPropagation();
          // Der Satz kommt aus dem Hauptprozess, aus derselben Funktion, die
          // den Aufruf baut (main.ts, `revive`-Vorschau). Bis zum 06.08. stand
          // hier eine eigene Regel, und sie kannte nur einen Harness: sie las
          // `claudeSessionId` und behauptete danach eine Fortsetzung -- auch
          // fuer eine Session, die mit pi oder codex lief. Der Rueckfall gilt
          // fuer den Fall, dass die Vorschau fehlt (aeltere Fassung des
          // Hauptprozesses).
          const fortsetzung =
            s.revive?.reason ??
            (s.claudeSessionId
              ? `Setzt die zuletzt gemerkte Unterhaltung fort (${s.claudeSessionId.slice(0, 8)}…).`
              : 'Startet neu -- keine Unterhaltung war gemerkt.');
          const harnessZeile = s.harness ? `\nHarness: ${s.harness}${s.model ? ` · ${s.model}` : ''}` : '';
          const ok = window.confirm(`"${s.name}" auf ${s.machine} wiederherstellen?\n\nOrdner: ${s.dir}${harnessZeile}\n${fortsetzung}`);
          if (ok) window.awbBridge.bedienung('revive', s.id);
        });
        zeile.appendChild(wiederherstellen);
      }
    }

    zeile.addEventListener('click', () => window.awbBridge.bedienung('select', s.id));
    // Rechtsklick: das Kontextmenue zu GENAU DIESER Sitzung -- nicht zu der,
    // die gerade gewaehlt ist. Die Kennung reist deshalb mit, und die Auswahl
    // bleibt unberuehrt: ein Rechtsklick ist eine Frage, kein Wechsel.
    //
    // `isTrusted` geht mit, aus demselben Grund wie beim Zahnrad und beim Plus:
    // `Menu.popup` bringt eine Flaeche auf den Bildschirm, und das darf nur ein
    // Mensch ausloesen. Ein synthetisches Ereignis aus dem Steuerkanal traegt
    // false, und der Hauptprozess klappt dann nichts auf (main.ts,
    // 'awb:sitzung-menue').
    zeile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.awbBridge.sitzungsMenue(s.id, e.isTrusted);
    });
    ziehbar(zeile, s.id, m);

    return zeile;
  }
}

/**
 * EINE ZEILE FUER EINE CHAT-SITZUNG -- in DERSELBEN Liste und an derselben
 * Stelle wie eine Terminal-Sitzung (Punkt 4). Sie sieht absichtlich gleich aus
 * -- es sind beides Sitzungen -- und traegt absichtlich ein Kennzeichen: was
 * hier klickt, legt ein Gespraech auf die Buehne statt Kacheln, und wer das
 * verwechselt, sucht sein Terminal.
 *
 * Bis zum 12.08. stand hier ein eigener Abschnitt hinter einem Trenner „Chat".
 * Er ist weg, und mit ihm die zweite Sortierregel.
 *
 * Der Punkt links nimmt dieselben Farbklassen wie eine Terminal-Sitzung, damit
 * „laeuft" ueberall dasselbe heisst.
 */
function chatZeile(
  c: NonNullable<Model['chats']>[number],
  m: Model,
  modus: 'schmal' | 'mittel' | 'breit',
): HTMLDivElement {
  // Hervorgehoben ist sie auch dann, wenn statt des Gespraechs einer IHRER
  // Worker auf der Buehne liegt: der Mensch ist bei dieser Sitzung.
  const gezeigt = m.chatGezeigt ?? '';
  const beiIhr = c.id === gezeigt || c.id === (m.chatWerkstattGezeigt ?? '');
  const zeile = document.createElement('div');
  zeile.className = `eintrag chat${c.laeuft ? ' laeuft' : ''}${beiIhr ? ' gewaehlt' : ''}`;
  zeile.dataset.chat = c.id;
  zeile.title = `${c.name} — ${c.ordner}\nChat-Sitzung (Gespräch auf der Bühne, kein Terminal)`;

  if (modus === 'schmal') {
    // Nicht `kuerzel` nennen: das verdeckt die gleichnamige Funktion, aus
    // der der Text kommt.
    const kuerzelEl = document.createElement('div');
    kuerzelEl.className = `kuerzel ${c.laeuft ? 'laeuft' : 'ruhig'}`;
    kuerzelEl.textContent = kuerzel(c.name);
    zeile.appendChild(kuerzelEl);
  } else {
    const punkt = document.createElement('div');
    punkt.className = `punkt ${c.laeuft ? 'laeuft' : 'ruhig'}-bg`;
    zeile.appendChild(punkt);

    const texte = document.createElement('div');
    texte.className = 'texte';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.name;
    texte.appendChild(name);
    if (modus === 'breit') {
      const zusatz = document.createElement('div');
      zusatz.className = 'zusatz';
      zusatz.textContent = c.ordner.split('/').pop() ?? c.ordner;
      texte.appendChild(zusatz);
    }
    zeile.appendChild(texte);

    // Das Kennzeichen. Ein gezeichnetes Sprechblasen-Zeichen, kein Emoji --
    // dieselbe Auflage wie im Rest des Hauses.
    const marke = document.createElement('span');
    marke.className = 'chatmarke';
    marke.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<path d="M17 12a2 2 0 0 1-2 2H8l-4 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" ' +
      'stroke-linecap="round" stroke-linejoin="round" /></svg>';
    zeile.appendChild(marke);
  }

  // Dieselbe Zweiteilung wie beim Plus: der ECHTE Klick legt das Gespraech
  // auf die Buehne, ein unechter (Test, Steuerkanal) startet es nur.
  zeile.addEventListener('click', (ereignis) => {
    window.awbBridge.bedienung(ereignis.isTrusted ? 'chat-zeigen' : 'chat-bauen', c.id);
  });
  // DAS KONTEXTMENUE, wie bei jeder anderen Zeile der Leiste (Punkt 4 und
  // Luecken 5a/5b). Es geht ueber DENSELBEN Kanal wie das der Terminal-Zeilen
  // und mit derselben Echtheitspruefung -- der Hauptprozess sieht an der
  // Kennung, welche Sorte gemeint ist (chat-* aus `neueId`).
  zeile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.awbBridge.sitzungsMenue(c.id, e.isTrusted);
  });
  // Und ziehbar wie jede andere Zeile -- dieselbe Fassung, dieselbe
  // gemeinsame Reihenfolge.
  ziehbar(zeile, c.id, m);
  return zeile;
}

/**
 * Die Farbe einer Tab-Marke fasst die Worker darin zusammen. Die Regel, damit
 * der Naechste sie nicht raet:
 *
 *   gelb   sobald EINER etwas will -- ein offener Antrag wartet auf eine
 *          Entscheidung. Gelb schlaegt gruen, weil eine Aufforderung nicht
 *          untergehen darf, nur weil daneben jemand arbeitet.
 *   gruen  sonst, solange einer laeuft.
 *   grau   wenn keiner mehr laeuft.
 *
 * Fertige Worker stehen in keinem Tab -- sie haben keinen Pane mehr. Dass in
 * einer Session etwas fertig geworden ist, sagt die Sessionleiste links (sie
 * wird gelb); in der rechten Leiste stehen sie aufgezogen unter "Fertig".
 */
function tabFarbe(workers: { state: string }[]): string {
  if (!workers.length) return 'ruhig';
  // Dieselbe Rangfolge wie bei einem einzelnen Worker: was steht, schlaegt
  // was laeuft -- sonst geht ein haengender Worker neben vier arbeitenden
  // unter, und genau das soll die Farbe verhindern.
  if (workers.some((w) => w.state === 'blocked' || w.state === 'stalled')) return 'will';
  // Ein Tab, ueber dessen Worker nichts bekannt ist, ist NICHT gruen (07.08.).
  // Gruen hiesse hier "alles laeuft", und das ist die eine Auskunft, die
  // niemand geben kann, solange die Panes nicht abzufragen waren. Er faerbt
  // sich auch nicht gelb: gelb ist eine Aufforderung, und es gibt nichts zu
  // tun. Er bekommt die Farbe der Sitzung, die ihn traegt.
  if (workers.some((w) => w.state === 'unknown')) return 'fern';
  return 'laeuft';
}

/**
 * Die Farbe eines Worker-Zustands (V1).
 *   gruen  laeuft
 *   gelb   blockiert oder haengt -- beide verlangen eine Handlung
 *   grau   fertig, also kein Pane mehr
 *   fern   nicht einsehbar -- niemand konnte nachsehen (07.08.)
 *
 * Die letzte Zeile ist DIESELBE Farbe, die die Sitzung links traegt, wenn ihre
 * Panes nicht abzufragen sind. Zwei Ebenen, eine Aussage, eine Farbe: ein
 * Worker ohne Auskunft darf weder wie ein fertiger aussehen (grau, dann sucht
 * niemand mehr nach ihm) noch wie ein Fehler (gelb, dann sucht jemand nach
 * einer Handlung, die es nicht gibt).
 */
function zustandFarbe(state: string): string {
  if (state === 'blocked' || state === 'stalled') return 'will';
  if (state === 'done') return 'ruhig';
  if (state === 'unknown') return 'fern';
  return 'laeuft';
}

/**
 * Die Unterzeile eines Workers. Sie sagt, WORAN man ist -- nicht die CPU-Zahl,
 * die dort bis heute stand: `ps` mittelt sie ueber die Lebenszeit, und ein
 * Client, der auf eine Antwort wartet, rechnet nicht (gemessen 1,3 Sekunden
 * CPU in 82 Minuten Arbeit). Die Kontextauslastung kommt dagegen aus dem
 * Transcript und ist die Zahl, wegen der man ueberhaupt hinsieht.
 */
function zustandText(w: Worker): string {
  const teile = [w.kind];
  // Ohne Fenster in der Modell-Registry gibt es keine Prozentzahl. Dann stehen
  // die belegten Tokens da statt einer erfundenen Quote -- und der fehlende
  // Registry-Eintrag faellt auf, statt sich zu verstecken.
  if (w.contextPercent >= 0) teile.push(`${w.contextPercent} % Kontext`);
  else if (w.contextTokens > 0) teile.push(`${Math.round(w.contextTokens / 1000)}k Kontext`);
  if (w.state === 'blocked') {
    teile.push(w.blockedReason === 'guard' ? 'angehalten vom Guard' : 'wartet auf Entscheidung');
  } else if (w.state === 'stalled') teile.push(`haengt seit ${dauer(w.idleSeconds)}`);
  else if (w.state === 'done') teile.push(w.resultPath ? 'fertig, Ergebnis da' : 'fertig, kein Ergebnis');
  // Warum das Fenster nicht nachsehen konnte, steht EINMAL -- an der Sitzung,
  // die den Grund kennt (Meldung aus dem tmux-Befund). Hier steht nur, dass
  // dieser Satz ueber diesen Worker nicht gilt.
  else if (w.state === 'unknown') teile.push('nicht einsehbar');
  return teile.filter(Boolean).join(' · ');
}

/** Eine Dauer in Sekunden, kurz geschrieben. */
function dauer(sekunden: number): string {
  if (sekunden < 0) return '?';
  if (sekunden < 90) return `${sekunden} s`;
  if (sekunden < 5400) return `${Math.round(sekunden / 60)} min`;
  return `${Math.round(sekunden / 360) / 10} h`;
}

function zeichneRechts(m: Model): void {
  // EINE stufenlose Breite, wie links. Kein zweiter, diskreter Zustand
  // daneben: der hat sich mit der Breite gestritten -- die Untergrenze 120 des
  // einen gegen die 40 des anderen --, und deshalb tat der Griff nichts.
  // Was gezeigt wird, haengt allein an der Breite.
  const schmal = m.ui.rightWidth <= 64;
  rechtsEl.classList.toggle('schmal', schmal);
  rechtsEl.style.width = `${m.ui.rightWidth}px`;
  rechtsListeEl.replaceChildren();
  tabsEl.replaceChildren();
  hinweisEl.textContent = '';

  const s = m.sessions.find((x) => x.id === m.selected);
  if (!s) return;

  // GESEHENE Panes, nicht "nicht fertig": in die Tabs unten geht nur, was auch
  // einen Pane hat, den man zeigen kann. Ein Worker im Zustand 'unknown' hat
  // keinen -- nicht weil er weg waere, sondern weil niemand nachsehen konnte --
  // und bekommt weiter unten eine eigene Rubrik statt einer Kachel ins Leere.
  const lebende = s.workers.filter((w) => w.alive);
  const lebendeNamen = new Set(lebende.map((w) => w.name));
  /**
   * Ein Worker gilt hier als Kind, wenn er auf den ANTRAG eines Workers
   * entstanden ist, der selbst noch laeuft. Ist der Antragsteller weg, steht
   * das Kind wieder oben -- eine Einrueckung unter etwas, das nicht mehr da
   * ist, waere eine Behauptung ueber eine Zugehoerigkeit, die niemand sieht.
   */
  const kinderVon = (name: string): typeof lebende =>
    lebende.filter((w) => w.requestedBy === name && lebendeNamen.has(w.requestedBy));
  const obere = lebende.filter((w) => !w.requestedBy || !lebendeNamen.has(w.requestedBy));
  /**
   * Ein Worker spawnt in diesem Haus NIE selbst -- er beantragt, und der
   * Orchestrator entscheidet und spawnt. Die Zeile muss das sagen: nicht
   * "X hat Y gestartet", sondern dass Y auf Antrag von X entstanden ist.
   */
  const herkunft = (w: (typeof lebende)[number]): string =>
    w.requestedBy && lebendeNamen.has(w.requestedBy) ? `auf Antrag von ${w.requestedBy}` : '';

  const tabs = Math.max(1, m.capacity.tabs);
  const tab = Math.min(m.ui.workerTab, tabs - 1);
  if (tabs > 1) {
    for (let i = 0; i < tabs; i++) {
      const k = document.createElement('button');
      k.className = `tab${i === tab ? ' gewaehlt' : ''}`;
      k.textContent = String(i + 1);
      k.addEventListener('click', () => window.awbBridge.bedienung('worker-tab', i));
      tabsEl.appendChild(k);
    }
  }

  const zeile = (opt: {
    klasse: string; farbe: string; kopf: string; unten: string; pane: string;
    marke?: string; zusatz?: string; tabIndex?: number; tabPanes?: string[];
  }): void => {
    const el = document.createElement('div');
    el.className = `zeile ${opt.klasse}`;
    if (opt.pane && opt.pane === m.streamPane) el.classList.add('gewaehlt');
    // Statt eines Punktes ohne Auskunft ein kleines Feld mit ein bis zwei
    // Zeichen: eingeklappt sagt es nicht nur, WIE der Eintrag steht, sondern
    // auch, WER er ist -- und genau das braucht man beim Wechseln. Dieselbe
    // Bildsprache wie die Kuerzel der Sessions links.
    const punkt = document.createElement('div');
    punkt.className = `punkt ${opt.farbe}-bg ${opt.farbe}`;
    punkt.textContent = opt.marke ?? '';
    el.appendChild(punkt);
    const text = document.createElement('div');
    text.className = 'text';
    const oben = document.createElement('div');
    oben.className = 'name';
    const nam = document.createElement('span');
    nam.textContent = opt.kopf;
    oben.appendChild(nam);
    if (opt.zusatz) {
      const z = document.createElement('span');
      z.className = 'anhang';
      z.textContent = opt.zusatz;
      oben.appendChild(z);
    }
    text.appendChild(oben);
    if (opt.unten) {
      const unten = document.createElement('div');
      unten.className = 'last';
      unten.textContent = opt.unten;
      text.appendChild(unten);
    }
    el.appendChild(text);
    el.title = `${opt.kopf}${opt.zusatz ? ` (${opt.zusatz})` : ''} ${opt.unten}`.trim();
    if (opt.tabIndex !== undefined) {
      el.addEventListener('click', () => {
        window.awbBridge.bedienung('worker-tab', opt.tabIndex);
        // ALLE Panes des Tabs nebeneinander -- nicht einer davon.
        if (opt.tabPanes?.length) window.awbBridge.bedienung('show-tab', opt.tabPanes);
      });
    } else if (opt.pane) {
      el.addEventListener('click', () => window.awbBridge.bedienung('show-pane', opt.pane));
    }
    rechtsListeEl.appendChild(el);
  };

  /**
   * Ein Subagent. Seine Farbe traegt jetzt den ZUSTAND wie bei allen anderen --
   * er laeuft, also gruen. Frueher stand hier das Blau des vierten Zustands,
   * und damit hiess dieselbe Farbe im selben Fenster zweierlei: links
   * "Maschine nicht erreichbar", rechts "Subagent". Dass er ein Subagent ist,
   * sagen jetzt die Einrueckung, die kleinere Marke, die Linie zum Elternteil
   * und die Art in der Unterzeile.
   */
  const subagentZeile = (sub: Subagent, klasse: string): void => {
    zeile({
      klasse: `subagent ${klasse}`,
      farbe: 'laeuft',
      kopf: sub.name || sub.agentId,
      unten: sub.type,
      pane: sub.paneId,
      marke: kuerzel(sub.name || sub.agentId),
    });
  };

  /** Eine Ueberschrift mit Linie. Eingeklappt bleibt nur die Linie uebrig. */
  const rubrik = (text: string): void => {
    const el = document.createElement('div');
    el.className = 'rubrik';
    const t = document.createElement('span');
    t.textContent = text;
    el.appendChild(t);
    rechtsListeEl.appendChild(el);
  };

  zeile({
    klasse: 'orchestrator',
    farbe: farbklasse(s.state),
    kopf: 'Orchestrator',
    unten: s.tmuxSession,
    pane: s.orchestratorPane,
    marke: 'O',
  });

  /** Ein Worker mit allem, was unter ihm haengt: Kind-Worker und Subagenten. */
  const workerMitAnhang = (w: (typeof lebende)[number], nurAus?: typeof lebende): void => {
    // Gezeigt werden die Kinder, die in demselben Tab liegen; die uebrigen
    // stehen bei ihrem eigenen Tab. Die Zahl am Worker zaehlt trotzdem ALLE.
    const alleKinder = kinderVon(w.name);
    const kinder = nurAus ? alleKinder.filter((k) => nurAus.some((x) => x.name === k.name)) : alleKinder;
    const anhang = alleKinder.length + w.subagents.length;
    zeile({
      klasse: `worker zustand-${w.state}`,
      farbe: zustandFarbe(w.state),
      kopf: w.name,
      // Die Zahl steht beim Worker selbst, damit sie auch dann zu sehen ist,
      // wenn die Ebene darunter nicht ins Bild passt.
      zusatz: anhang ? `+${anhang}` : '',
      // Die Herkunft haengt am Worker, nicht an seiner Einrueckung: liegt er
      // in einem anderen Tab als sein Antragsteller, steht sie trotzdem da.
      //
      // EIN WORKER AUS EINEM PANE (19.08., `fremdePanes` in sessions.ts) hat
      // keine Zustandsdatei und damit weder Modell noch Kontextzahl. Was ihn
      // beschreibt, ist der Pane-Titel -- er steht hier statt einer Zustands-
      // zeile, die aus lauter Unbekannten bestuende.
      unten: herkunft(w) || (w.titel || zustandText(w)),
      pane: w.paneId,
      marke: kuerzel(w.name),
    });
    for (const k of kinder) {
      zeile({
        klasse: `worker kind zustand-${k.state}`,
        farbe: zustandFarbe(k.state),
        kopf: k.name,
        unten: herkunft(k) || zustandText(k),
        pane: k.paneId,
        marke: kuerzel(k.name),
      });
      for (const sub of k.subagents) subagentZeile(sub, 'kind tief');
    }
    // V19: eingerueckt unter ihrem Worker, ohne Platz in der Rechnung.
    for (const sub of w.subagents) subagentZeile(sub, 'kind');
  };

  /**
   * Die Reihenfolge, in der die Worker in den Panes liegen: jeder obere,
   * unmittelbar gefolgt von dem, was auf seinen Antrag entstanden ist. Ein
   * Kind-Worker hat einen EIGENEN Pane und belegt deshalb einen Platz im
   * Gitter -- die Tabs muessen ihn also mitzaehlen, sonst weicht die Zahl der
   * Marken von der Kapazitaetsrechnung ab.
   */
  const flach = obere.flatMap((w) => [w, ...kinderVon(w.name)]);
  const imTab = (i: number): typeof flach => flach.slice(i * m.capacity.perTab, (i + 1) * m.capacity.perTab);

  // Der Tab ist IMMER ein Eintrag, den man anklicken kann -- schmal steht er
  // allein, aufgezogen stehen die Worker dieses Tabs eingerueckt darunter. Ein
  // Klick auf den Tab zeigt ALLE seine Panes nebeneinander, ein Klick auf einen
  // Worker nur diesen.
  for (let i = 0; i < tabs; i++) {
    const drin = imTab(i);
    if (!drin.length && i > 0) continue;
    zeile({
      klasse: `tabmarke${i === tab ? ' gewaehlt' : ''}`,
      farbe: tabFarbe(drin),
      kopf: `Tab ${i + 1}`,
      unten: schmal ? drin.map((w) => w.name).join(', ') : `${drin.length} Worker`,
      pane: '',
      tabIndex: i,
      tabPanes: drin.map((w) => w.paneId).filter(Boolean),
      marke: String(i + 1),
    });
    if (schmal) continue;
    for (const w of drin) {
      if (w.requestedBy && lebendeNamen.has(w.requestedBy) && drin.some((x) => x.name === w.requestedBy)) continue;
      workerMitAnhang(w, drin);
    }
  }

  if (!schmal) {
    // NICHT EINSEHBAR IST NICHT FERTIG (07.08.). Hier stand `!x.alive`, und
    // damit ruecken bei ausgefallenem tmux ALLE Worker der Sitzung unter die
    // Ueberschrift "Fertig" -- die Ueberschrift selbst behauptet dann etwas,
    // das niemand nachgesehen hat. Sie fuehrt jetzt nur noch, was wirklich
    // keinen Pane mehr hat; die uebrigen stehen darunter unter ihrer eigenen.
    const fertige = s.workers.filter((x) => x.state === 'done');
    const unbekannte = s.workers.filter((x) => x.state === 'unknown');
    if (fertige.length) rubrik('Fertig');
    for (const w of fertige) {
      // Dieselbe Stelle formuliert den Zustand wie oben -- ein Worker soll
      // nicht an zwei Orten verschieden beschrieben werden. Ob ein Ergebnis
      // daliegt, steht dabei getrennt von "kein Pane mehr": ein Worker kann
      // geschlossen worden sein, ohne je eines geschrieben zu haben.
      zeile({
        klasse: 'worker fertig',
        farbe: 'ruhig',
        kopf: w.name,
        unten: zustandText(w),
        pane: '',
        marke: kuerzel(w.name),
      });
    }
    // Die eigene Rubrik: sie sagt in ihrer Ueberschrift, was mit diesen Zeilen
    // los ist, statt es jeder einzelnen zu ueberlassen. Anklickbar ist hier
    // nichts -- ohne Pane gibt es nichts zu zeigen --, und die Farbe ist die
    // der Sitzung, die den Grund traegt.
    if (unbekannte.length) rubrik('Nicht einsehbar');
    for (const w of unbekannte) {
      zeile({
        klasse: 'worker unbekannt',
        farbe: 'fern',
        kopf: w.name,
        unten: zustandText(w),
        pane: '',
        marke: kuerzel(w.name),
      });
    }
    for (const sub of s.orphanSubagents) {
      subagentZeile(sub, 'ohne-eltern');
    }
  }

  // Was die Kopfzeile hergab, hat hier seinen Platz: die Groessenregel und die
  // Zusage aus F14. Beides steht ausserdem in `awb-ctl state`, und der Titel
  // der Leiste nennt beim Ueberfahren auch Session, Pane und Groesse.
  const teile = [`${m.capacity.perTab} Panes je Tab (${m.capacity.perRow}x${m.capacity.perColumn})`];
  if (m.capacity.cappedBySetting) teile.push('Obergrenze aus den Einstellungen greift');
  // Drei Faelle, und sie sehen verschieden aus -- das gehoert gesagt, sonst
  // liest sich eine halb gefuellte Kachel wie ein Zeichenfehler.
  const eigene = auskunft.regel.startsWith('eigene');
  if (!m.mayArrange) {
    teile.push(
      `Fremde Session, ${m.fremdeClients} weitere${m.fremdeClients === 1 ? 'r' : ''} Client${m.fremdeClients === 1 ? '' : 's'} haengt daran: die Aufteilung der Panes wird gezeichnet und nicht umgeraeumt -- die GROESSE des Fensters folgt trotzdem der Buehne, solange hier gezeichnet wird, und wird beim Abloesen zurueckgestellt`,
    );
  } else if (eigene) {
    teile.push('Eigene Session: Groesse zugewiesen (window-size manual)');
  } else if (auskunft.regel !== '-') {
    teile.push('Uebernommene Session, kein anderer Client daran: wird gekachelt und beim Abloesen zurueckgestellt');
  }
  hinweisEl.textContent = teile.join('. ') + '.';
  rechtsEl.title = [
    `Session ${auskunft.session}`,
    `Pane ${auskunft.pane}`,
    `Groesse ${auskunft.groesse}`,
    `Groessenregel ${auskunft.regel}`,
    `Layout ${auskunft.layout}`,
  ].join('\n');
}

/**
 * Die Flaeche bestimmt die Zahlen, nicht umgekehrt.
 *
 * Frueher stand hier eine Skalierung: das Gitter bekam die Groesse der
 * tmux-Session und wurde mit transform: scale() in die Flaeche gequetscht.
 * Daraus kamen drei Fehler auf einmal -- ein leerer Rand oben und unten, weil
 * die Seitenverhaeltnisse selten zusammenpassen; ein falsch gezeichneter
 * Worker-Pane, weil die Zahl vom FENSTER kam und der Inhalt vom PANE; und ein
 * unscharfes Bild, weil ein skaliertes Gitter kein gezeichnetes Gitter ist.
 *
 * Jetzt wird gemessen, wieviele ganze Zellen in die Flaeche passen, und tmux
 * bekommt genau diese Zahlen. Damit sind Gitter und Pane per Konstruktion
 * gleich gross, und es bleibt nichts uebrig, das man verteilen muesste.
 *
 * EINE ZELLGROESSE, NICHT ZWEI (06.08.). Hier stand das Zubehoer von xterm.js
 * (`FitAddon.proposeDimensions`). Es rechnet gegen SEIN Terminal: gegen dessen
 * Innenabstand, dessen Bildlaufleiste und dessen Elternkasten -- und keines
 * davon ist die Buehne, auf der gezeichnet wird. Gemessen an der laufenden
 * Instanz: Buehne 1414 Bildpunkte, Zelle 7,825 -- es passen 180 Spalten,
 * angeboten wurden 144. Die fehlenden 287 Bildpunkte sind genau der Rand, den
 * alice gesehen hat. Deshalb kommen Spalten und Zeilen jetzt aus derselben
 * Rechnung wie die Kacheln: die Flaeche der Buehne, geteilt durch die EINE
 * gemessene Zellgroesse (zellmass).
 */
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
let zieht: '' | 'links' | 'rechts' = '';
griffEl.addEventListener('mousedown', (e) => {
  zieht = 'links';
  e.preventDefault();
});
griffRechtsEl.addEventListener('mousedown', (e) => {
  zieht = 'rechts';
  e.preventDefault();
});
/**
 * WAEHREND DES ZIEHENS BLEIBT ALLES IM FENSTER (16.08.).
 *
 * Bis heute schickte jede Mausbewegung ein `bedienung('sidebar-width')` an den
 * Hauptprozess, und der schrieb je Meldung `ui.json` (uistate.ts: writeFileSync
 * plus renameSync) und schickte das VOLLE Modell zurueck. Bei den ueblichen
 * 60-120 Ereignissen je Sekunde waren das ebenso viele Dateischreibvorgaenge
 * und Voll-Updates pro Sekunde -- fuer eine Breite, die niemand ausser diesem
 * Fenster braucht, solange die Maus noch unten ist.
 *
 * Jetzt folgt die Breite der Maus rein oertlich (CSS, hoechstens einmal je
 * Einzelbild), und GESPEICHERT wird beim Loslassen -- einmal.
 *
 * ZWEI AUSNAHMEN, die kein Schmuck sind:
 *   * Wechselt die BREITENSTUFE (schmal/mittel/breit bzw. schmal rechts), aendert
 *     sich nicht nur die Breite, sondern der Inhalt der Leiste -- und der wird
 *     aus dem Modell gezeichnet. Dann geht die Meldung sofort raus, damit das
 *     Bild waehrend des Ziehens nicht luegt. Das passiert ein- bis zweimal je
 *     Zug, nicht sechzigmal je Sekunde.
 *   * BEIM LOSLASSEN meldet die Buehne ihre neue Flaeche
 *     (`awb:flaeche-geaendert`) -- einmal, nicht je Einzelbild. Je Bild waere
 *     je Spaltenwechsel ein `resize-pane` an tmux, also ein Sturm fuer eine
 *     Bewegung; bis heute geschah dabei ueberhaupt nichts, und das Terminal
 *     blieb bis zur naechsten Fensteraenderung in der alten Spaltenzahl.
 *
 * Die Grenzen stehen hier UND in main.ts ('sidebar-width'/'right-width'). Die
 * hiesigen sind nur fuers Zeichnen da -- was gespeichert wird, klemmt der
 * Hauptprozess weiterhin selbst ab; er bleibt die Instanz, diese Zahl ist nur
 * das Bild davon.
 */
const ZIEH_GRENZEN = { links: { min: 48, max: 480 }, rechts: { min: 40, max: 560 } };
let ziehBreite = 0;
let ziehRahmen = 0;

function ziehBreiteZeichnen(welche: 'links' | 'rechts', breite: number): void {
  if (welche === 'links') {
    linksEl.classList.toggle('schmal', breitenmodus(breite) === 'schmal');
    linksEl.style.width = `${breite}px`;
  } else {
    rechtsEl.classList.toggle('schmal', breite <= 64);
    rechtsEl.style.width = `${breite}px`;
  }
}

function ziehMelden(welche: 'links' | 'rechts', breite: number): void {
  window.awbBridge.bedienung(welche === 'links' ? 'sidebar-width' : 'right-width', breite);
}

/** Die Stufe, in der die Leiste gerade GEZEICHNET ist -- aus dem Modell, nicht geraten. */
function ziehStufe(welche: 'links' | 'rechts', breite: number): string {
  return welche === 'links' ? breitenmodus(breite) : (breite <= 64 ? 'schmal' : 'breit');
}

window.addEventListener('mousemove', (e) => {
  if (!zieht) return;
  const g = ZIEH_GRENZEN[zieht];
  const roh = zieht === 'links' ? e.clientX : window.innerWidth - e.clientX;
  const breite = Math.max(g.min, Math.min(g.max, Math.round(roh)));
  const vorher = zieht === 'links'
    ? (modell?.ui.sidebarWidth ?? 48)
    : (modell?.ui.rightWidth ?? 210);
  if (ziehStufe(zieht, vorher) !== ziehStufe(zieht, breite)) {
    // Stufenwechsel: der Inhalt der Leiste haengt daran, also einmal den
    // vollen Weg gehen. Danach steht die neue Stufe im Modell, und die naechste
    // Bewegung faellt wieder in den billigen Fall.
    ziehMelden(zieht, breite);
    ziehBreite = breite;
    return;
  }
  ziehBreite = breite;
  if (ziehRahmen) return;
  const welche = zieht;
  ziehRahmen = requestAnimationFrame(() => {
    ziehRahmen = 0;
    ziehBreiteZeichnen(welche, ziehBreite);
  });
});
window.addEventListener('mouseup', () => {
  if (!zieht) return;
  const welche = zieht;
  zieht = '';
  if (ziehRahmen) {
    cancelAnimationFrame(ziehRahmen);
    ziehRahmen = 0;
  }
  if (!ziehBreite) return;
  ziehBreiteZeichnen(welche, ziehBreite);
  // ERST JETZT wird gespeichert: ein Zug ist eine Entscheidung, nicht sechzig.
  ziehMelden(welche, ziehBreite);
  document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
  ziehBreite = 0;
});

// Das Zahnrad steht an seinem Platz, damit das Layout stimmt; seine Ansicht
// kommt in einer spaeteren Stufe. Wer darauf klickt, soll das hoeren -- ein
// Knopf, der schweigt, sieht kaputt aus. Die drei anderen (ordner, aktivitaet,
// freigaben) haben je ihre eigene Ansicht und bleiben deshalb aussen vor.
const spaeter: Record<string, string> = {};
for (const knopf of document.querySelectorAll<HTMLButtonElement>('.knopf[data-tot]:not([data-tot="freigaben"]):not([data-tot="ordner"]):not([data-tot="aktivitaet"]):not([data-tot="protokolle"]):not([data-tot="einstellungen"])')) {
  knopf.addEventListener('click', () => notiz(spaeter[knopf.dataset.tot ?? ''] ?? ''));
}
initFreigabenView();
initEditorView();
initAktivitaetView();
initOrdnerView();
initProtokolleView();
const statuszeileEl = initFussStatus();

/**
 * Die Mitte zeichnet MEHRERE Panes, so wie tmux sie im Fenster liegen hat.
 *
 * Die Aufteilung kommt aus `#{window_layout}` und traegt fuer jeden Pane seine
 * Lage in ZELLEN. Multipliziert mit der Zellgroesse ergibt das den Kasten in
 * Pixeln -- die Trennlinien stecken schon in den Abstaenden, weil tmux fuer
 * jede eine Spalte beziehungsweise Zeile mitrechnet.
 *
 * Ein Terminal je Pane: xterm haelt Puffer, Cursor und Umbruch je Instanz, und
 * genau das braucht jeder Pane fuer sich.
 */
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
const letzteKacheln = new Map<string, { x: number; y: number; b: number; h: number; fehlt: boolean }>();
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
function gitterFlaeche(): { b: number; h: number } {
  const g = gitterEl.getBoundingClientRect();
  if (g.width && g.height) return { b: g.width, h: g.height };
  const f = buehne.getBoundingClientRect();
  return { b: f.width, h: f.height };
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
  return {
    x: (box.x / raster.cols) * flaecheB,
    y: (box.y / raster.rows) * flaecheH,
    b: ((box.cols + trennerRechts) / raster.cols) * flaecheB,
    h: ((box.rows + trennerUnten) / raster.rows) * flaecheH,
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

function kachelLage(
  anzahl: number,
  spalten: number,
  breiten?: number[],
  flaecheCols?: number,
): { x: number; y: number; b: number; h: number }[] {
  const { b: flaecheB, h: flaecheH } = gitterFlaeche();
  const zeilen = Math.max(1, Math.ceil(anzahl / spalten));
  const hoehe = flaecheH / zeilen;
  const lagen: { x: number; y: number; b: number; h: number }[] = [];
  for (let z = 0; z < zeilen; z++) {
    const inZeile = Math.min(spalten, anzahl - z * spalten);
    if (inZeile <= 0) break;
    const cols = breiten?.slice(z * spalten, z * spalten + inZeile) ?? [];
    const summe = cols.reduce((a, b) => a + b, 0);
    const nachMass =
      cols.length === inZeile && cols.every((c) => c > 0) && !!flaecheCols && summe <= flaecheCols;
    let x = 0;
    for (let i = 0; i < inZeile; i++) {
      const breite = nachMass ? (cols[i] / summe) * flaecheB : flaecheB / inZeile;
      lagen.push({ x, y: z * hoehe, b: breite, h: hoehe });
      x += breite;
    }
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

function zeichneLage(p: LayoutPayload): void {
  letzteLage = p;
  const zelle = zellmass();
  // Der gezeigte Ausschnitt wird auf die Flaeche normiert: zeigt ein Tab nur
  // einen Teil der Panes eines Fensters, sitzt er trotzdem oben links.
  const x0 = Math.min(...p.panes.map((b) => b.x), 0);
  const y0 = Math.min(...p.panes.map((b) => b.y), 0);
  const gesehen = new Set<string>();
  letzteKacheln.clear();
  for (const [id, m] of Object.entries(p.maus ?? {})) mausModus.set(id, m);
  // Mit Raster kommt die Kachel aus der Lage des Panes (kachelAusRaster), ohne
  // Raster aus seinem Platz in der Anforderung. Die zweite Form bleibt fuer die
  // Faelle, in denen es kein gemeinsames Raster GIBT: Panes aus mehreren
  // Fenstern, oder ein Fenster, von dem nur ein Teil gezeigt wird.
  const raster = p.art === 'tab' ? p.raster : undefined;
  const teilraster = p.art === 'tab' && !raster ? p.rasterTeil : undefined;
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
      const t = new Terminal({ cols: box.cols, rows: box.rows, ...TERMOPT, fontSize: schriftgroesse });
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
      chatAnbindungen.set(box.paneId, new ChatAnbindung(el, box.paneId, window.awbEditorBridge, false));
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
    eintrag.el.style.left = `${kx.toFixed(1)}px`;
    eintrag.el.style.top = `${ky.toFixed(1)}px`;
    eintrag.el.style.width = `${kb.toFixed(1)}px`;
    eintrag.el.style.height = `${kh.toFixed(1)}px`;
    letzteKacheln.set(box.paneId, { x: kx, y: ky, b: kb, h: kh, fehlt: false });
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
    el.style.left = `${kachel.x.toFixed(1)}px`;
    el.style.top = `${kachel.y.toFixed(1)}px`;
    el.style.width = `${kachel.b.toFixed(1)}px`;
    el.style.height = `${kachel.h.toFixed(1)}px`;
    el.textContent = `${f.pane}: ${f.grund}`;
    gitterEl.appendChild(el);
    letzteKacheln.set(f.pane, { x: kachel.x, y: kachel.y, b: kachel.b, h: kachel.h, fehlt: true });
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

/** Die Ecke, in der ein Schild liegt -- als Wort, fuer die Messung. */
function eckenName(schild: HTMLDivElement): string {
  const unten = schild.classList.contains('unten');
  const links = schild.classList.contains('li');
  return `${unten ? 'unten' : 'oben'} ${links ? 'links' : 'rechts'}`;
}

/**
 * Punkt 1: WEN sehe ich hier gerade? Die Kopfzeile ist weg und soll es
 * bleiben; die eine Auskunft, die gefehlt hat, steht deshalb als kleines Schild
 * in der Ecke des Panes -- ohne eine Zeile ueber die volle Breite zu kosten und
 * auch dann sichtbar, wenn beide Leisten eingeklappt sind.
 */
function zeigeNamen(): void {
  for (const [id, e] of paneTerms) {
    let schild = e.el.querySelector<HTMLDivElement>('.panename');
    if (!schild) {
      schild = document.createElement('div');
      schild.className = 'panename';
      e.el.appendChild(schild);
    }
    // Das Schild nimmt hoechstens die HALBE Breite und die HALBE Hoehe seines
    // Panes. In dieser Reihenfolge:
    //   1. passt die Hoehe nicht, wird das Schild flacher;
    //   2. passt sie dann immer noch nicht, faellt es ganz weg -- ein Pane von
    //      einer Zeile hat keinen Platz, den man ihm nehmen koennte;
    //   3. passt die Breite nicht, steht dort das zweibuchstabige Kuerzel.
    // Abgeschnitten wird nie: in einem Pane von siebzehn Spalten deckte
    // "Orchestrator" in der neuen Groesse sonst fast die ganze Zeile zu, und im
    // entarteten Gitter schnitt der Kasten das Schild unten durch.
    //
    // Die Schwelle haengt an der Schriftgroesse und wandert mit ihr. Gemessen
    // bei 15 Pixeln (Schild 23 Pixel hoch, flach 19): voll bis herunter zu
    // einem Pane von 60 Pixeln, flach ab 45, ganz weg ab 30. Bei 18 Pixeln war
    // das Schild 27 hoch und wurde entsprechend frueher flach. Wer die Groesse
    // wieder aendert, aendert diese drei Zahlen mit -- sie stehen deshalb nicht
    // als Konstante im Code, sondern fallen aus der Messung
    // (test-app-oberflaeche.sh, Abschnitt 4c).
    const voll = nameZuPane(id);
    schild.classList.remove('kurz', 'flach');
    schild.style.display = '';
    schild.textContent = voll;
    const breite = e.el.clientWidth / 2;
    const hoehe = e.el.clientHeight / 2;
    if (hoehe > 0 && schild.offsetHeight > hoehe) schild.classList.add('flach');
    if (hoehe > 0 && schild.offsetHeight > hoehe) schild.style.display = 'none';
    if (breite > 0 && schild.scrollWidth > breite) {
      schild.textContent = kuerzel(voll);
      schild.classList.add('kurz');
    }
    schild.classList.toggle('aktiv', id === aktiverPane);
  }
}

/**
 * Das Schild bleibt OBEN RECHTS. Immer.
 *
 * Zwischendurch suchte es sich die Ecke, unter der nichts geschrieben stand.
 * Das funktionierte -- gemessen wanderte "Orchestrator" nach unten rechts,
 * sobald oben Text stand -- und war trotzdem falsch: ein Name, den man als
 * Ankerpunkt liest, darf nicht mit dem Textstand die Ecke wechseln (alice,
 * 06.08.: "Als ich angefangen habe zu schreiben, ist der Name von unten rechts
 * nach oben rechts gerutscht. Das ist auch falsch.").
 *
 * Dass es dabei ein paar Zellen verdeckt, bleibt und ist der bewusste Tausch:
 * drei verdeckte Zellen an einer festen Stelle stoeren weniger als ein Schild,
 * das springt. Wieviele es sind, zaehlt `belegteZellen` und die Auskunft der
 * Oberflaeche nennt sie als `deckt` -- gemessen, nicht geschaetzt.
 */

function nameZuPane(paneId: string): string {
  const s = modell?.sessions.find((x) => x.id === modell?.selected);
  if (!s) return paneId;
  if (paneId === s.orchestratorPane) return 'Orchestrator';
  const w = s.workers.find((x) => x.paneId === paneId);
  if (w) return w.name;
  for (const x of s.workers) {
    const sub = x.subagents.find((y) => y.paneId === paneId);
    if (sub) return sub.name || sub.agentId;
  }
  const os = s.orphanSubagents.find((y) => y.paneId === paneId);
  return os ? os.name || os.agentId : paneId;
}

let aktiverPane = '';

window.awbBridge.onSession((p) => {
  auskunft.session = p.session || '-';
  auskunft.pane = p.activePane || '-';
  auskunft.regel = p.sizePolicy === 'owned' ? 'eigene Session (manual)' : p.sizePolicy ? 'fremde Session (uebernommen)' : '-';
  if (modell) zeichneRechts(modell);
  // Beim Anhaengen hat der Pane noch die Groesse, die er vorher hatte. Die
  // Meldung der Flaeche bringt beide auf dieselbe Zahl.
  gemeldet = { cols: 0, rows: 0 };
  requestAnimationFrame(passeAn);
});

window.awbBridge.onLayout((p) => {
  zeichneLage(p);
  if (modell) zeichneRechts(modell);
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

window.awbBridge.onModel((m) => {
  modell = m;
  setzeSchrift(m.schriftgroesse);
  setzeScroll(m.scrollZeilen);
  // Was auf der Buehne liegt, entscheidet der Hauptprozess -- hier wird es nur
  // ausgefuehrt. Zuerst, damit die Sessionleiste darunter schon den neuen Stand
  // zeichnet.
  // Die Worker der GEZEIGTEN Chat-Sitzung reisen mit: die Leiste in der Ansicht
  // wird aus dem Modell gefuellt, nicht aus dem Gespraechsstand (Punkt 1).
  chatbuehne.nachModell(
    m.chatGezeigt ?? '',
    (m.chats ?? []).find((c) => c.id === (m.chatGezeigt ?? ''))?.worker ?? [],
  );
  auskunft.layout = m.mayArrange ? 'eigene Session, darf geordnet werden' : 'fremde Session, nur gezeichnet';
  zeichneSessions(m);
  zeichneRechts(m);
  // DIE NAMENSSCHILDER HAENGEN AM MODELL, nicht nur an der Lage.
  //
  // `zeigeNamen()` lief bisher allein beim Zeichnen einer Lage und beim Wechsel
  // des aktiven Panes. Der NAME eines Panes kommt aber aus dem Modell, und das
  // trifft eigenen Takt: ein Pane, der beim letzten Zeichnen noch keinen Worker
  // hatte, behielt sein Schild -- und das ist dann die rohe Kennung. GEMESSEN am
  // 19.08. kopflos: bei zwei Workern stand auf dem zweiten Pane dauerhaft "%2"
  // statt "mlxsrv", waehrend das Modell im Hauptprozess den Namen laengst
  // fuehrte (`awb-ctl sessions`: paneId %2, name mlxsrv); acht Sekunden spaeter
  // stand dort immer noch "%2". Bei drei Workern stimmte es, weil dort zufaellig
  // nach dem Modell noch einmal gezeichnet wurde.
  zeigeNamen();
  if (statuszeileEl) zeichneStatuszeile(statuszeileEl, m.ampel, m.budget);
  // Jede stehende Ergebnismeldung gegen den laufenden Auftrag halten: `resultPath`
  // ist die Datei des Auftrags, an dem der Worker JETZT haengt (leer, solange er
  // nichts geschrieben hat). Weicht sie von der Meldung ab, ist die Meldung
  // ueberholt -- genau der Fall, in dem eine spaet eintreffende Fertigmeldung
  // sonst zu einer Handlung an einem arbeitenden Worker verleitet.
  const aktuell = new Map<string, string>();
  for (const s of m.sessions) for (const w of s.workers) aktuell.set(w.name, w.resultPath);
  meldungen.abgleich(aktuell);
  requestAnimationFrame(passeAn);
});

// V2: Die Ergebnisdatei meldet sich selbst. Keine Dauerflaeche (A14) -- eine
// Meldung, die von selbst geht, mit zwei Wegen zum Ergebnis.
const meldungen = new Meldungen({
  paneZeigen: (paneId) => window.awbBridge.bedienung('show-pane', paneId),
  dateiOeffnen: (pfad) => window.awbBridge.bedienung('ergebnis-oeffnen', pfad),
  paneVon: (name) => {
    const s = modell?.sessions.find((x) => x.id === modell?.selected);
    return s?.workers.find((w) => w.name === name && w.alive)?.paneId ?? '';
  },
});
window.awbBridge.onErgebnis((e) => meldungen.zeigen(e));
window.awbBridge.onMaus((m) => {
  mausModus.clear();
  for (const [id, wert] of Object.entries(m)) mausModus.set(id, wert);
});

// Schritt 7: die uebernommenen Seiten. Sie liegen ueber der Buehne und gehen
// wieder zu -- keine Dauerflaeche (A14), wie bei allem anderen hier.
const seiten = new Seiten({
  nachricht: (seite, daten) => {
    if (seite === '__oeffnen') window.awbBridge.bedienung('seite', daten);
    else if (seite === '__schliessen') window.awbBridge.bedienung('seite-schliessen', daten);
    else window.awbBridge.bedienung('seiten-nachricht', daten);
  },
  ausfuehren: () => window.awbBridge.bedienung('plan-ausfuehren', null),
  abbrechen: () => window.awbBridge.bedienung('plan-abbrechen', null),
});
// A9: Das Zahnrad oeffnet die Einstellungen in einem EIGENEN FENSTER ueber
// diesem -- nicht mehr als Flaeche darueber. Bis zum 05.08. zeigte es die
// uebernommene Seite der VS-Code-Erweiterung in einem Rahmen; das war eine
// Flaeche mit Reiterzeile, und genau die vier Punkte, die alice beanstandet
// hat, hingen daran.
//
// DIE AUFLAGE AUS DIESEM HAUS, hier durchgesetzt: Das Fenster geht auf, weil
// ein MENSCH geklickt hat -- nie, weil ein Test oder ein Agent es anfordert.
// Unterschieden wird an `isTrusted`, nicht an einem Namen oder einem Flag:
//
//   * Ein echter Klick mit Maus oder Trackpad traegt `isTrusted === true`.
//     Nur er schickt 'einstellungen-zeigen', und nur dort steht show().
//   * `element.click()` aus einem Skript -- der Weg JEDES Tests und jedes
//     Steuerbefehls, `awb-ctl klick einstellungen` eingeschlossen -- erzeugt
//     ein Ereignis mit `isTrusted === false`. Es schickt 'einstellungen-bauen':
//     das Fenster entsteht und ist lesbar und fotografierbar, aber es
//     erscheint auf keinem Bildschirm.
//
// Kein Umweg fuehrt daran vorbei: `isTrusted` ist nicht setzbar, und ein
// synthetisches MouseEvent traegt es immer false. Gemessen in
// shell/tests/test-app-einstellungen.sh -- nach `awb-ctl klick einstellungen`
// steht das Fenster mit seinen sieben Seiten da und meldet `sichtbar: false`.
const einstellungenKnopf = document.querySelector<HTMLButtonElement>('.knopf[data-tot="einstellungen"]');
einstellungenKnopf?.addEventListener('click', (ereignis) => {
  window.awbBridge.bedienung(ereignis.isTrusted ? 'einstellungen-zeigen' : 'einstellungen-bauen', null);
});

window.awbBridge.onSeite((p) => seiten.zeige(p.name));
// Reste-Auftrag Punkt 3: eine Datei hat sich von aussen geaendert. Ob
// tatsaechlich neu gezeichnet wird (offen? kein Feld im Fokus?), prueft
// 'aufDateiAendern' selbst -- dieser Kanal meldet nur, WELCHE Seite betroffen
// ist (siehe app/src/main/dateiwaechter.ts).
window.awbBridge.onDateiGeaendert((p) => seiten.aufDateiAendern(p.name));
// Die Seite liegt in einem Rahmen mit EIGENER Herkunft und redet deshalb ueber
// postMessage mit uns -- so, wie ein Webview mit seinem Wirt redet.
window.addEventListener('message', (e) => {
  const d = e.data as { __awbSeite?: boolean; daten?: unknown } | null;
  if (!d || d.__awbSeite !== true) return;
  window.awbBridge.bedienung('seiten-nachricht', d.daten);
});
// Vor jeder Handlung mit Nebenwirkung: zeigen, was geschehen wird.
window.awbBridge.onPlan((p) => seiten.frage(p));
window.awbBridge.onPlanErgebnis((p) => seiten.ergebnis(p.ausgabe, p.ok));

// Ohne Steuerkanal laeuft das Fenster weiter -- aber es sagt es. Die Meldung
// bleibt stehen, solange der Zustand gilt; sie verschwindet nicht von selbst
// wie eine Notiz.
window.awbBridge.onKanal((k) => {
  kanalGrund = k.fehler ?? '';
  kanalwarnungEl.textContent = kanalGrund
    ? `Kein Steuerkanal: ${kanalGrund} — das Fenster laeuft weiter, Befehle von aussen kommen nicht an.`
    : '';
  kanalwarnungEl.classList.toggle('sichtbar', !!kanalGrund);
});

// Rueckkanal fuer den Steuerkanal: was im Puffer steht und was die Oberflaeche
// gerade zeigt. Damit laesst sich ein Foto gegen den Text pruefen.
window.__awb = {
  /**
   * Wer an dieser Stelle den Zeiger faengt. Ein Foto zeigt, WAS uebereinander
   * liegt, aber nicht, wer den Klick bekommt -- und genau daran hing der
   * Ziehgriff, den eine zugeklappte Schublade verdeckte (05.08.). Gibt Kennung
   * und Klassen des obersten Elements zurueck, damit ein Test die Schicht
   * benennen kann statt sie zu vermuten.
   */
  trefferBei(x: number, y: number): { tag: string; id: string; klassen: string } {
    const el = document.elementFromPoint(x, y);
    if (!el) return { tag: '', id: '', klassen: '' };
    return { tag: el.tagName.toLowerCase(), id: el.id || '', klassen: el.className?.toString?.() || '' };
  },

  /**
   * Ein echtes Rad-Ereignis auf einem Pane -- und was danach im Puffer steht.
   *
   * Ohne diesen Haken laesst sich "das Rad bewegt den Rueckblick nicht" nur
   * behaupten: ein Foto zeigt keinen Bildlauf, und `bufferText` sagt nicht,
   * WELCHER Ausschnitt zu sehen ist. `viewportY` ist genau das, `laenge` die
   * Zahl der Zeilen im Puffer und `zeilen` die des Schirms -- sind beide
   * gleich, gibt es keinen Rueckblick, den man bewegen koennte.
   *
   * `mausmodus` sagt, ob die Anwendung im Pane die Maus verfolgt. Dann gehen
   * Rad-Ereignisse an SIE und nicht in den Bildlauf; das ist das Verhalten
   * eines Terminals und kein Fehler, aber es muss messbar sein.
   */
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
   * `an: true` leert sie und faengt an mitzuschreiben; `an: false` gibt zurueck,
   * was seither an echten Rad-Ereignissen durch die Rechnung lief. Dazu die
   * Stelle des Panes im Fenster und sein Zellmass, denn der Weg nach draussen
   * (`sendInputEvent`, siehe main.ts 'rad-strom') braucht einen Punkt, an dem
   * das Ereignis landen soll, und die Auswertung die Zeilenhoehe, gegen die
   * sich die Zeilenzahl rechnen laesst.
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
    // Auf WELCHEM Pane das Ereignis wirklich landet -- der Haken faellt auf den
    // aktiven zurueck, und die Auskunft muss denselben meinen.
    const gemeint = [...paneTerms].find(([, e]) => e === eintrag)?.[0] ?? paneId;
    const el = eintrag.el.querySelector<HTMLElement>('.xterm') ?? eintrag.el;
    // Vorher leeren: was danach hier steht, hat GENAU dieses Rad-Ereignis
    // hinausgeschickt.
    letzteEingabe = null;
    // Der Testweg schickt weiter ein Vielfaches der ZELLHOEHE -- er heisst
    // „schritte" und ist als Weg gemeint, nicht als Zeilenzahl. Wieviele Zeilen
    // daraus werden, entscheidet radZeilen, und genau das soll gemessen werden.
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: schritte * Math.max(1, zellmass().hoehe),
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        shiftKey: !!shift,
      }),
    );
    // `smoothScrollDuration` (TERMOPT, 12.08.) macht `scrollLines()` asynchron:
    // der Puffer bewegt sich erst ueber ein paar Einzelbilder, nicht mehr in
    // demselben Durchlauf wie das Rad-Ereignis. Ohne diese Wartezeit laese
    // dieser Haken den Stand VOR der Bewegung -- gemessen in
    // test-app-flaeche.sh: "das Rad bewegt nichts", obwohl es das sehr wohl
    // tat, nur noch nicht in derselben Millisekunde. Hier stand dafuer ein
    // festes `setTimeout(50)`; warum daraus ein Warten auf den Zustand wurde,
    // steht bei rollenBeruhigt().
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
      // vor seinem Aufbau kam -- die kennt nur tmux (mausModus). Wer den
      // Rueckfall messen will, braucht die Zahl, nach der entschieden wird.
      mausAn: !!eintrag.el.querySelector('.xterm.enable-mouse-events') || !!mausModus.get(gemeint)?.an,
      // Ob dieses Terminal seinen Rueckblick hat -- die Buchfuehrung, an der
      // haengt, ob nachgefordert wird.
      rueckblick: eintrag.rueckblickDa,
      // Was dieses Ereignis an den Pane geschickt hat -- lesbar gemacht, damit
      // sich auch auf dem Alternativschirm belegen laesst, DASS es etwas tat.
      gesendet: eingabeLesbar(),
    };
  },

  /**
   * NUR FUER TESTS: WebGL fuer dieses Fenster unbrauchbar machen -- damit sich
   * der Rueckfall auf Canvas ueberhaupt ausloesen laesst, ohne auf einen
   * Chromium-Schalter angewiesen zu sein, der je nach Treiber und
   * Software-Rasterisierer (SwiftShader) trotzdem noch einen Kontext liefert.
   * Wirkt nur auf DIESEN Fensterprozess, nur bis zum naechsten Neuladen.
   *
   * ZWEI HAELFTEN, und die zweite kam am 19.08. dazu:
   *
   *   1. `getContext('webgl2')` gibt nichts mehr her. Das gilt fuer jedes
   *      Terminal, das DANACH entsteht -- der Rueckfall in `ladeRenderer()`
   *      greift dort von selbst.
   *   2. Jedes Terminal, das SEIN WebGL SCHON GELADEN hat, wird hier
   *      umgestellt: Zusatz abwerfen, Canvas laden, Buchfuehrung nachziehen.
   *
   * Warum die zweite Haelfte fehlte und warum das niemandem auffiel: Bis zum
   * 19.08. stand `WEBGL_AUS = true` in `ladeRenderer()`, und die Konstante
   * sorgte fuer Canvas, ganz gleich ob diese Sperre etwas taugte. Der Riegel
   * hier war also nie gemessen, sondern vom anderen verdeckt. Mit dem Fall der
   * Konstante kam es heraus: `test-app-zweitblick-verschmelzung.sh` sperrt
   * WebGL, NACHDEM das Terminal seines Messpanes laengst steht, und bekam
   * weiterhin 'webgl' zurueck -- die Zusage, an der die ganze Suite haengt,
   * war damit wertlos.
   *
   * Der Name ist die Begruendung: was `webglSperren` heisst, muss WebGL
   * sperren, nicht nur den naechsten Kontextwunsch. Eine Sperre, die einen
   * schon laufenden Fall auslaesst, ist eine Zusage mit einer Ausnahme, die
   * nirgends steht.
   *
   * Was das fuer `test-app-scroll-renderer.sh` bedeutet, die denselben Helfer
   * benutzt: nichts. Dort wird 'im Normallauf ist WebGL aktiv' an P1 gemessen,
   * BEVOR diese Sperre faellt; danach misst die Suite nur noch P2, und der
   * kommt so oder so auf Canvas.
   */
  webglSperren(): boolean {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, art: string, ...rest: unknown[]) {
      if (art === 'webgl2' || art === 'webgl') return null;
      return (original as (...a: unknown[]) => unknown).apply(this, [art, ...rest]);
    } as typeof HTMLCanvasElement.prototype.getContext;
    // Ueber eine Kopie laufen: `canvasLaden()` schreibt in `rendererJePane`,
    // und `delete` waehrend des Durchlaufs waere ein Griff in die Sammelstelle,
    // aus der gerade gelesen wird.
    for (const [id, { addon, term }] of [...webglJeTerminal]) {
      webglJeTerminal.delete(id);
      try {
        addon.dispose();
      } catch {
        // Schon abgeworfen oder nie richtig oben -- der naechste Schritt
        // (Canvas laden) ist trotzdem der richtige, und er ist der einzige,
        // an dem die Messung danach haengt.
      }
      canvasLaden(id, term);
    }
    return true;
  },

  /**
   * NUR FUER TESTS (clipfixtest): eine Auswahl im Terminal setzen oder
   * loeschen, ohne einen echten Ziehvorgang der Maus. `hasSelection()` ist
   * genau das, wonach `terminalZwischenablageHaken` selbst fragt -- damit
   * misst der Test dieselbe Bedingung, die auch die Produktionslogik prueft.
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
   * Textfeld des Terminals ausloesen -- xterm.js haengt seinen `keydown`-
   * Zuhoerer GENAU DORT an (node_modules/@xterm/xterm, `addDisposableDomListener
   * (this.textarea, "keydown", ...)`), nicht an `document`. Ein `dispatchEvent`
   * dort durchlaeuft denselben Weg wie ein echter Tastendruck: erst
   * `attachCustomKeyEventHandler` (unser Haken aus `terminalZwischenablageHaken`),
   * erst wenn DER nichts abfaengt xterms eigene Auswertung. `verhindert` ist
   * `true`, wenn irgendetwas in dieser Kette `preventDefault()` gerufen hat --
   * bei Strg+Umschalt+C/V unser Haken, bei einem blossen Strg+C xterm selbst
   * (SIGINT zu senden verhindert das Neuschreiben des Feldes durch den Browser).
   * `letzteEingabe` wird vorher geleert: was danach dort steht, kam GENAU aus
   * diesem einen Tastendruck.
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

  /** NUR FUER TESTS (clipfixtest): was der letzte {@link zwischenablageTaste}-Aufruf an den Pane geschickt hat. */
  zwischenablageGesendet(): string {
    return eingabeLesbar();
  },

  /**
   * NUR FUER TESTS (clipfixtest): die Bildschirmmitte eines Zielfeldes fuer
   * einen ECHTEN Rechtsklick (`sendInputEvent` in main.ts, wie bei
   * `rad-strom`) -- ein `dispatchEvent(new MouseEvent('contextmenu'))` erreicht
   * Electrons browser-seitiges 'context-menu'-Ereignis nachweislich NICHT
   * (gemessen; siehe der Kommentar bei 'kontextmenu-fake' in main.ts).
   * `'editierbar'` trifft das Umbenennen-Feld -- es steckt hinter `.sichtbar`
   * und wird hier eigens dafuer eingeblendet, sonst liefert `getBoundingClientRect`
   * eine Nullflaeche und der Klick traefe, was zufaellig an Pixel (0,0) liegt.
   * Jede andere Kennung zielt auf `.xterm-screen`, die sichtbare Zeichenflaeche
   * des Terminals -- NICHT auf sein `xterm-helper-textarea`. Erster Anlauf
   * dieser Suite zielte auf die Textarea und mass dort `isEditable: true`:
   * folgerichtig, ein `<textarea>` ist per Definition editierbar, aber am
   * Terminal klickt niemand dort -- ein echter Rechtsklick trifft die
   * Zeichenflaeche, die im DOM darueber liegt und die Textarea unsichtbar
   * verdeckt.
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
   * FOKUS (xterms verstecke Hilfs-Textarea), nicht der Klickposition, deshalb
   * fragt der Hauptprozess hier eigens nach, welcher Pane unter (x, y) liegt.
   * `.closest('.panekasten')` findet den Kasten unabhaengig davon, ob der
   * Treffer die Zeichenflaeche selbst oder ein Kind darin ist -- derselbe
   * Kasten, den zeichneLage() mit `dataset.pane` anlegt. `auswahlText` wird
   * SOFORT mitgegeben statt erst beim Klick auf "Kopieren" neu abgefragt: das
   * Menue soll genau die Auswahl kopieren, die beim Oeffnen bestand, nicht was
   * zufaellig noch markiert ist, wenn der Klick Millisekunden spaeter kommt.
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
   * Terminal-Kontextmenue. Derselbe Griff wie Strg+Umschalt+V in
   * `terminalZwischenablageHaken` -- `t.paste(text)` --, nur dass der Text
   * schon da ist: der Hauptprozess hat die Zwischenablage selbst gelesen
   * (`clipboard.readText()`, kein zweiter Weg dorthin) und schickt ihn mit.
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
   * fortlaufend Rad-Ereignisse denselben Pane hochrollen -- die Zahl, ohne die
   * "haekelig" eine Meinung bleibt (12.08.).
   *
   * Jedes Bild: ein Rad-Ereignis wie in `rad()` (deckelt sich selbst ueber
   * RAD_DECKEL), dann ein `requestAnimationFrame`. Xterm plant sein eigenes
   * Neuzeichnen ebenfalls ueber ein rAF, registriert waehrend des synchronen
   * `dispatchEvent` -- es laeuft also VOR unserem Aufruf im selben Bild, und
   * der Abstand zwischen zwei aufeinanderfolgenden rAF-Zeitstempeln traegt
   * damit die Zeichenarbeit dieses Bildes mit. `backgroundThrottling: false`
   * und `paintWhenInitiallyHidden: true` (main.ts, `fensterBauen`) sorgen
   * dafuer, dass das trotz `show:false` echte Bildabstaende sind und keine
   * gedrosselten.
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
          // Negativ: rad hoch, in den Rueckblick hinein -- das ist der
          // Fall, den alice gemeldet hat, und er braucht Puffer darueber.
          deltaY: -RASTER_PIXEL * raster,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
      const t = await new Promise<number>((res) => requestAnimationFrame(res));
      if (voriger !== null) deltas.push(t - voriger);
      voriger = t;
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
   * des GEWAEHLTEN zuerst und die uebrigen darunter -- so bleibt eine Pruefung
   * auf "steht das im Fenster?" in beiden Ansichten richtig.
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
  /** Was in der uebernommenen Seite steht -- pruefbar ohne Foto. */
  // Alle drei fragen die Seite und geben deshalb ein Versprechen zurueck --
  // executeJavaScript loest es auf, der Aufrufer merkt nichts davon.
  seitenState(): Promise<unknown> {
    return seiten.zustand();
  },
  seiteRollen(auswahl: string): Promise<boolean> {
    return seiten.rolleZu(auswahl);
  },
  seiteKlick(auswahl: string): Promise<boolean> {
    return seiten.klick(auswahl);
  },
  /** Nur fuer die Pruefung der Auffrischung: ein Feld gezielt fokussieren. */
  seiteFokus(auswahl: string): Promise<boolean> {
    return seiten.fokussiere(auswahl);
  },
  /** Nur fuer die Pruefung der Auffrischung: ein fokussiertes Feld gezielt verlassen. */
  seiteUnfokus(): Promise<boolean> {
    return seiten.entfokussiere();
  },
  /** Nur fuer die Pruefung: die echte Schliessen-Schaltflaeche im Rahmen anklicken. */
  seiteSchliessenKlick(): boolean {
    return seiten.schliessenKlick();
  },
  /**
   * Nur der SICHTBARE Schirm je Pane -- das Gegenstueck zu `capture-pane -p`.
   *
   * bufferText() gibt den ganzen Puffer aus, Bildlauf eingeschlossen, und das
   * ist fuer die Frage "steht das im Fenster?" richtig. Fuer die Frage "zeigt
   * das Fenster denselben Schirm wie tmux?" ist es falsch: xterm bricht beim
   * Verkleinern die alten Zeilen neu um und schiebt sie in den Bildlauf, tmux
   * kennt dort nichts davon. Ein Vergleich, der die letzten n Zeilen des
   * ganzen Puffers nimmt, greift dann in den Bildlauf und meldet einen
   * Unterschied, wo nur eine Vorgeschichte steht. Gemessen: mit einer
   * Oberflaeche, die sich bei jedem Groessenwechsel vollstaendig neu zeichnet,
   * traf das etwa jeden dritten Lauf.
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
  uiState(): unknown {
    const eintraege = [...sessionsEl.querySelectorAll<HTMLDivElement>('.eintrag')].map((e) => {
      const k = e.querySelector('.kuerzel');
      const r = k?.getBoundingClientRect();
      return {
        id: e.dataset.id ?? '',
        text: (e.textContent ?? '').trim(),
        zustand: [...e.classList].find((c) => c.startsWith('zustand-'))?.slice(8) ?? '',
        gewaehlt: e.classList.contains('gewaehlt'),
        kuerzelFarbe: k?.className.split(' ')[1] ?? '',
        punktFarbe: e.querySelector('.punkt')?.className.split(' ')[1] ?? '',
        // Wo das Kuerzel auf dem Bild liegt -- damit ein Foto an genau der
        // Stelle nachgemessen werden kann statt nach Augenmass.
        kuerzelRect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
      };
    });
    const rechts = [...rechtsListeEl.querySelectorAll<HTMLDivElement>('.zeile, .rubrik')].map((e) => ({
      klasse: e.className,
      text: (e.textContent ?? '').trim(),
      subagent: e.classList.contains('subagent'),
      rubrik: e.classList.contains('rubrik'),
      hoehe: Math.round(e.getBoundingClientRect().height),
      marke: (e.querySelector('.punkt')?.textContent ?? '').trim(),
      // Welche Zustandsfarbe die Marke traegt -- damit eine Pruefung sagen
      // kann, dass Lila hier NICHT mehr vorkommt.
      farbe: (e.querySelector('.punkt')?.className ?? '').match(/\b(laeuft|will|aus|fern|ruhig)\b/)?.[1] ?? '',
      // Wie weit die Marke vom linken Rand der Leiste einrueckt. Daran haengt
      // die Aussage, dass man die Gliederung Tab > Worker > Anhang SIEHT und
      // nicht an der Aufschrift ablesen muss.
      markeLinks: Math.round(
        ((e.querySelector('.punkt') ?? e).getBoundingClientRect().left) - rechtsListeEl.getBoundingClientRect().left,
      ),
      // Der Name weicht zuletzt: wird es eng, schrumpft der Zustand daneben.
      nameBreite: Math.round(e.querySelector('.name')?.getBoundingClientRect().width ?? 0),
      zustandBreite: Math.round(e.querySelector('.last')?.getBoundingClientRect().width ?? 0),
    }));
    // Die Ergebnismeldungen als Daten -- damit eine Pruefung sie ohne Foto
    // nachweisen kann, so wie die Leisten oben.
    const meldungenJetzt = [...document.querySelectorAll<HTMLDivElement>('#meldungen .meldung')].map((e) => ({
      worker: e.dataset.worker ?? '',
      pfad: e.dataset.pfad ?? '',
      veraltet: e.dataset.veraltet === '1',
      text: (e.textContent ?? '').trim(),
    }));
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
    // Dieselbe Flaeche, die auch die Kacheln legt (gitterFlaeche()) -- nicht
    // noch einmal eigens ueber buehneRect gemessen. Sonst melden Lage und
    // Zustand zwei leicht verschiedene Zahlen fuer dieselbe Flaeche.
    const flaeche = gitterFlaeche();
    return {
      // Wieviel vom Terminal zu sehen ist und wie der Rand verteilt liegt.
      buehne: {
        breite: Math.round(flaeche.b),
        hoehe: Math.round(flaeche.h),
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
        // DIE GEMESSENE ZELLE EINES GEZEICHNETEN PANES -- nicht mehr die Flaeche
        // geteilt durch das Mass-Terminal.
        //
        // Das Mass-Terminal (`term`) steht in der Tab-Ansicht unberuehrt auf
        // seinen Anfangswerten 80x24. Die Flaeche dadurch zu teilen ergab eine
        // Zahl, die mit dem Gezeichneten nichts zu tun hat: bei einer Buehne von
        // 1384x876 meldete sie 17,3 x 36,5, waehrend die Zellen in Wirklichkeit
        // 7,5 x 15,4 gross waren (184 Spalten, 57 Zeilen). Aus dem Verhaeltnis
        // der beiden Zahlen (2,3) liess sich ein Fehler bei der Umrechnung
        // zwischen Geraetepixeln und CSS-Punkten lesen, den es nicht gibt --
        // 184 x 7,5 = 1380 und 57 x 15,4 = 878 gehen sauber auf. `zellmass()`
        // misst am gezeichneten Pane und ist dieselbe Zahl, mit der auch
        // gerechnet wird.
        zelle: {
          breite: Number(zellmass().breite.toFixed(2)),
          hoehe: Number(zellmass().hoehe.toFixed(2)),
        },
        // Lage im FENSTER, nicht in der Buehne: damit laesst sich auf einem
        // Selbstfoto genau der Bereich nachmessen, in dem der Pane steht.
        paneRect: [Math.round(pane.left), Math.round(pane.top), Math.round(pane.width), Math.round(pane.height)],
        randLinks: Math.round((gitter?.left ?? pane.left) - buehneRect.left),
        randRechts: Math.round(buehneRect.right - (gitter?.right ?? pane.right)),
        randOben: Math.round((gitter?.top ?? pane.top) - buehneRect.top),
        randUnten: Math.round(buehneRect.bottom - (gitter?.bottom ?? pane.bottom)),
      },
      notiz: notizEl.classList.contains('sichtbar') ? (notizEl.textContent ?? '') : '',
      // Der Plus-Knopf: dass es ihn gibt und wo er steht. WAS er aufmacht,
      // steht seit dem 06.08. nicht mehr hier -- es ist ein eigenes Fenster,
      // und das liest der Steuerkanal mit `awb-ctl sitzung`.
      neu: {
        knopf: !!document.getElementById('neue-session'),
        knopfOben: Math.round(document.getElementById('neue-session')?.getBoundingClientRect().top ?? -1),
        sessionsOben: Math.round(sessionsEl.getBoundingClientRect().top),
      },
      // Das Feld fuer den neuen Namen: ob es offen steht, zu welcher Sitzung
      // und was darin steht. Ohne diese Auskunft liesse sich der Weg
      // „Rechtsklick, Namen ändern, tippen, bestaetigen" nur am Bild pruefen.
      umbenennen: {
        offen: umbenennenEl.classList.contains('sichtbar'),
        id: umbenennenId,
        wert: umbenennenFeld.value,
        alt: umbenennenAltEl.textContent ?? '',
      },
      // V2: welche Ergebnismeldungen gerade stehen. Leer ist der Normalfall --
      // sie sind fluechtig und bekommen nach A14 keine Dauerflaeche.
      meldungen: meldungenJetzt,
      // Leer, solange ein Steuerkanal da ist. Steht hier etwas, zeigt das
      // Fenster die Warnung -- und dann ist diese Auskunft ohnehin nur ueber
      // ein Selbstfoto oder --startfoto zu bekommen.
      kanal: kanalGrund,
      kanalwarnung: kanalwarnungEl.classList.contains('sichtbar') ? (kanalwarnungEl.textContent ?? '') : '',
      // Die Namensschilder auf den Panes: Text, Lage im Fenster und ob das
      // Schild auf das Kuerzel ausgewichen ist. Damit laesst sich Groesse und
      // Kontrast am Bildpunkt nachmessen statt nach Augenmass.
      schilder: [...gitterEl.querySelectorAll<HTMLDivElement>('.panekasten')].map((k) => {
        const s = k.querySelector<HTMLDivElement>('.panename');
        const r = s?.getBoundingClientRect();
        const id = k.dataset.pane ?? '';
        return {
          pane: id,
          text: s?.textContent ?? '',
          kurz: !!s?.classList.contains('kurz'),
          flach: !!s?.classList.contains('flach'),
          verborgen: !!s && s.style.display === 'none',
          aktiv: !!s?.classList.contains('aktiv'),
          // In welcher Ecke das Schild liegt und wieviele beschriebene Zellen
          // es zudeckt. Die zweite Zahl ist die Zusage: ein Name, der auf dem
          // Text liegt, ist keine Auskunft, sondern ein Fleck -- und ob er
          // daraufliegt, wird gezaehlt und nicht geschaetzt.
          ecke: s ? eckenName(s) : '',
          deckt: s && s.style.display !== 'none' && r ? belegteZellen(id, r) : 0,
          schriftgroesse: s ? Math.round(parseFloat(getComputedStyle(s).fontSize)) : 0,
          paneBreite: Math.round(k.getBoundingClientRect().width),
          paneHoehe: Math.round(k.getBoundingClientRect().height),
          rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
        };
      }),
      // Wo die Kacheln auf der Buehne liegen -- Lage UND Groesse, bezogen auf
      // die Buehne. Ohne diese Zahlen laesst sich "die Flaeche wird ausgenutzt"
      // nur behaupten: `terminals` nennt die Groesse eines Kastens, aber nicht
      // seinen Platz, und genau der war beim diagonalen Tab-Bild falsch.
      //
      // Die Zahlen kommen aus `letzteKacheln` -- der Geometrie, WIE SIE
      // GESETZT wurde -- und nicht mehr aus einer eigenen
      // `getBoundingClientRect()` je Kasten. Zwei Kacheln, deren Grenze auf
      // demselben `kachelLage()`-Wert beruht, rundeten sonst UNABHAENGIG
      // (einmal ueber die eigene Position, einmal ueber Position der
      // Nachbarkachel plus deren Hoehe) und liefen dabei bis zu einem Pixel
      // auseinander, obwohl sie sich nur beruehrten. UNGERUNDET, aus demselben
      // Grund: `Math.round(y) + Math.round(h)` ist nicht dasselbe wie
      // `Math.round(y + h)`, und genau diese Differenz war die Ueberdeckung,
      // die es in Wirklichkeit nie gab -- zwei Kacheln, deren gemeinsame Kante
      // auf derselben Fliesskommazahl beruht, beruehren sich exakt, nur ihre
      // UNABHAENGIG gerundeten Melder stimmten nicht mehr ueberein. Ein Kasten
      // ohne Cache-Eintrag (sollte nicht vorkommen, ist aber kein Grund, ihn
      // zu verschweigen) faellt auf die gerundete Messung zurueck.
      lagen: [...gitterEl.querySelectorAll<HTMLDivElement>('.panekasten, .panefehlt')].map((k) => {
        const pane = k.dataset.pane ?? '';
        const kachel = letzteKacheln.get(pane);
        if (kachel) {
          return { pane, x: kachel.x, y: kachel.y, b: kachel.b, h: kachel.h, fehlt: kachel.fehlt };
        }
        const r = k.getBoundingClientRect();
        return {
          pane,
          x: Math.round(r.left - buehneRect.left),
          y: Math.round(r.top - buehneRect.top),
          b: Math.round(r.width),
          h: Math.round(r.height),
          fehlt: k.classList.contains('panefehlt'),
        };
      }),
      // Angefordert, aber nicht zu zeichnen -- mit dem Grund. Ein Worker, der
      // ohne ein Wort verschwindet, ist schlimmer als einer, der schlecht sitzt.
      fehlend: letzteLage?.fehlend ?? [],
      // Was die xterm-Instanzen WIRKLICH halten -- nicht, was die letzte
      // Layout-Meldung sagte. Bei einem Groessensprung koennen beide
      // auseinanderlaufen, und nur der Vergleich zeigt, welche der drei
      // Zahlenreihen (Renderer, tmux, capture-pane) danebenliegt.
      // Ob die Anwendung im Pane die Maus verfolgt -- die Zahl, an der sich
      // entscheidet, wem das Rad gehoert.
      maus: [...mausModus].map(([pane, m]) => ({ pane, an: m.an, sgr: m.sgr })),
      terminals: [...paneTerms].map(([pane, e]) => {
        // Der Kasten, den wir dem Pane geben, und die Flaeche, die xterm
        // WIRKLICH zeichnet. Laufen sie auseinander, wird die unterste Zeile
        // angeschnitten -- und genau dort steht die Eingabezeile.
        const kasten = e.el.getBoundingClientRect();
        const schirm = e.el.querySelector('.xterm-screen')?.getBoundingClientRect();
        return {
          pane,
          cols: e.term.cols,
          rows: e.term.rows,
          kasten: [Math.round(kasten.width * 100) / 100, Math.round(kasten.height * 100) / 100],
          schirm: schirm ? [Math.round(schirm.width * 100) / 100, Math.round(schirm.height * 100) / 100] : null,
        };
      }),
      // Bildpunkte je CSS-Pixel. Bei 1 entsteht jedes Selbstfoto in halber
      // Aufloesung, und feine Verschiebungen fallen unter die Messschwelle.
      bildpunkte: window.devicePixelRatio,
      // Die eingestellte Schriftgroesse und die Zellgroesse, die daraus faellt.
      // Beide Zellmasse nebeneinander: das des gezeichneten Panes (das gilt)
      // und das des Mass-Terminals. Sie gingen am 06.08. um anderthalb Prozent
      // auseinander und haben damit die Spaltenzahl verdorben -- wer das
      // wieder sucht, soll die zwei Zahlen sehen und nicht raten.
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
      // Mittelachse jedes Eintrags der linken Leiste -- Symbolknoepfe oben,
      // Kuerzel in der Mitte, Fussknopf unten. Sie muessen alle dieselbe sein.
      achsen: [...linksEl.querySelectorAll<HTMLElement>('.knopf svg, .eintrag .kuerzel, .eintrag .punkt')].map((e) => {
        const r = e.getBoundingClientRect();
        const knopf = e.closest('.knopf') as HTMLElement | null;
        const eintrag = e.closest('.eintrag') as HTMLElement | null;
        return { was: knopf?.dataset.tot ?? eintrag?.dataset.id ?? '', mitte: Math.round((r.left + r.right) / 2) };
      }),
      modus: breitenmodus(modell?.ui.sidebarWidth ?? 48),
      sidebarWidth: modell?.ui.sidebarWidth ?? 0,
      rightWidth: modell?.ui.rightWidth ?? 0,
      linksBreite: linksEl.getBoundingClientRect().width,
      rechtsBreite: rechtsEl.getBoundingClientRect().width,
      eintraege,
      rechts,
      tabs: [...tabsEl.querySelectorAll('.tab')].map((t) => (t.textContent ?? '').trim()),
      hinweis: hinweisEl.textContent ?? '',
      // Die Kopfzeile ist weg; ihre Auskuenfte sind es nicht.
      auskunft,
      rechtsTitel: rechtsEl.title,
      rechtsKlasse: rechtsEl.className,
      // Oberkante des ersten Eintrags je Leiste: beide sollen buendig sein.
      obenLinks: Math.round(linksEl.firstElementChild?.getBoundingClientRect().top ?? -1),
      obenRechts: Math.round((rechtsEl.querySelector('.zeile, .tab') as HTMLElement)?.getBoundingClientRect().top ?? -1),
      freigaben: freigabenUiState(),
      aktivitaet: aktivitaetUiState(),
      ordner: ordnerUiState(),
      protokolle: protokolleUiState(),
      // Farben durchreichen (11.08.): der aufgeloeste Zustand, gelesen aus dem
      // DOM statt aus einer eigenen Buchfuehrung -- was hier steht, ist auch
      // das, was das Fenster wirklich zeichnet.
      thema: {
        dataThema: document.documentElement.dataset.thema ?? '',
        zustandLaeuft: getComputedStyle(document.documentElement).getPropertyValue('--zustand-laeuft').trim(),
        zustandWartet: getComputedStyle(document.documentElement).getPropertyValue('--zustand-wartet').trim(),
        zustandFertig: getComputedStyle(document.documentElement).getPropertyValue('--zustand-fertig').trim(),
        zustandTot: getComputedStyle(document.documentElement).getPropertyValue('--zustand-tot').trim(),
        grund: getComputedStyle(document.documentElement).getPropertyValue('--grund').trim(),
      },
    };
  },
};

/**
 * Der Plus-Knopf ueber den Sessions: das Sitzungsfenster.
 *
 * Bis zum 06.08. klappte hier eine Flaeche ueber der Buehne auf, die genau
 * einen der beiden Wege konnte -- Ordner waehlen und starten. Der zweite, eine
 * alte Sitzung fortsetzen, lag am Knopf ihrer Zeile in der Leiste und war
 * unsichtbar, solange der Haken fuer beendete Sitzungen nicht stand. Beide Wege
 * stehen jetzt in einem eigenen Fenster nebeneinander (main/sitzungsfenster.ts).
 *
 * DIE AUFLAGE AUS DIESEM HAUS, hier genauso durchgesetzt wie beim Zahnrad
 * darueber: Das Fenster geht auf, weil ein MENSCH geklickt hat. Unterschieden
 * wird an `isTrusted`, nicht an einem Namen -- ein echter Klick schickt
 * 'sitzung-zeigen' (dort steht show()), ein `element.click()` aus einem Skript
 * oder aus `awb-ctl klick neue-session` schickt 'sitzung-bauen': das Fenster
 * entsteht und ist lesbar und fotografierbar, erscheint aber auf keinem
 * Bildschirm.
 */
document.getElementById('neue-session')?.addEventListener('click', (ereignis) => {
  window.awbBridge.bedienung(ereignis.isTrusted ? 'sitzung-zeigen' : 'sitzung-bauen', null);
});

/**
 * „Namen ändern" aus dem Kontextmenue der Sessionleiste.
 *
 * Gefragt wird IM PROGRAMM, nicht in einem Terminal -- ein Zeilenfeld ueber der
 * Buehne, das mit der Antwort wieder zugeht. Geschrieben wird der Name hier
 * NICHT: die Antwort geht zurueck an den Hauptprozess, und dort schreibt
 * `wb-state` sie (main.ts, 'awb:sitzung-umbenennen'). Das Fenster kennt den
 * Weg in die Zustandsdatei gar nicht.
 */
const umbenennenEl = document.getElementById('umbenennen') as HTMLDivElement;
const umbenennenAltEl = document.getElementById('umbenennen-alt') as HTMLDivElement;
const umbenennenFeld = document.getElementById('umbenennen-feld') as HTMLInputElement;
let umbenennenId = '';

function umbenennenZu(): void {
  umbenennenEl.classList.remove('sichtbar');
  umbenennenId = '';
}

window.awbBridge.onMeldung((p) => notiz(p.text ?? ''));

// SOFORT WIRKSAM (12.08.): der Rechtsklick auf eine Sitzung hat ihre Ansicht
// umgestellt, und der Pane wechselt hier -- ohne Neuaufbau des Fensters, ohne
// dass die Sitzung angefasst wird. Kennt der Renderer den Pane (noch) nicht,
// passiert nichts: die Entscheidung steht in ui.json, und der naechste Aufbau
// dieses Panes fragt sie beim Hauptprozess ohnehin ab (chat/anbindung.ts).
window.awbBridge.onChatAnsicht((p) => {
  chatAnbindungen.get(p?.paneId ?? '')?.zeigen(p?.an === true);
});

window.awbBridge.onUmbenennen((p) => {
  umbenennenId = p.id;
  umbenennenAltEl.textContent = `Bisher: ${p.name}${p.dir ? ` — ${p.dir}` : ''}`;
  umbenennenFeld.value = p.name;
  umbenennenEl.classList.add('sichtbar');
  umbenennenFeld.focus();
  umbenennenFeld.select();
});

function umbenennenSenden(): void {
  const id = umbenennenId;
  const neuerName = umbenennenFeld.value;
  if (!id) return;
  // Zuerst zu, dann melden: die Antwort kommt aus dem Hauptprozess, und ein
  // Feld, das waehrenddessen offen bleibt, laedt zum zweiten Druecken ein.
  umbenennenZu();
  void window.awbBridge.umbenennen(id, neuerName).then((r) => notiz(r.meldung));
}

document.getElementById('umbenennen-ok')?.addEventListener('click', umbenennenSenden);
document.getElementById('umbenennen-ab')?.addEventListener('click', umbenennenZu);
umbenennenFeld.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') umbenennenSenden();
  else if (e.key === 'Escape') umbenennenZu();
});

// Die Buehne meldet ihre Flaeche EINMAL von sich aus, sobald sie steht. Ohne
// das kennt der Hauptprozess sie erst, wenn das Fenster zum ersten Mal seine
// Groesse aendert oder eine Schublade auf- und zugeht -- und alles, was vorher
// gezeichnet wird, bleibt in der Groesse stehen, die tmux gerade hergibt.
requestAnimationFrame(() => requestAnimationFrame(passeAn));

// Die Sprache EINMAL beim Start holen (derselbe geteilte Kanal wie bei der Verbrauchsseite) --
// das Hauptfenster traegt weit mehr als die Chat-Ansicht und bleibt sonst grossteils
// unuebersetzt, aber `<html lang>`, der Dokumenttitel und die Chat-Ansicht selbst sollen nicht
// falsch behaupten, sie seien noch auf der Auslieferungssprache von vor dem Abruf.
void window.awbEditorBridge.sprache().then((sp) => {
  setzeChatSprache(sp);
  document.documentElement.lang = sp === 'de' ? 'de' : 'en';
  document.title = chatT('fenster.titel');
});

/**
 * Farben durchreichen (11.08.): dieselbe Mechanik wie im Einstellungsfenster
 * (einstellungen.ts, `themaAnwenden`) -- `data-thema` traegt hier immer den
 * AUFGELOESTEN Wert ('hell'/'dunkel'), nie 'system': `wirksam` kommt schon so
 * aus main/thema.ts, damit dieses Fenster nie selbst raten muss. Die vier
 * Zustandsfarben kommen bereits kontrastangepasst (`zustandsfarbenLesbar`),
 * ihre Tinte (fuer die gefuellte Flaeche der Kuerzel) separat dazu.
 */
function themaAnwenden(d: ThemaPayload): void {
  document.documentElement.dataset.thema = d.wirksam;
  for (const [zustand, farbe] of Object.entries(d.zustandsfarbenLesbar)) {
    document.documentElement.style.setProperty(`--zustand-${zustand}`, farbe);
    document.documentElement.style.setProperty(`--zustand-${zustand}-tinte`, d.zustandsfarbenTinte[zustand] ?? '#05070a');
  }
}
window.awbBridge.onThema(themaAnwenden);
void window.awbBridge.thema().then(themaAnwenden);

window.awbBridge.ready();
