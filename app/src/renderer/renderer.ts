// DIE OBERFLAECHE DES HAUPTFENSTERS -- neu gebaut am 03.09.2026.
//
// WARUM NEU UND NICHT UMGEBAUT. Urteil des Nutzers ueber den Stand davor:
// „Mach einfach eine ganz neue Version, orientiere dich nicht an der alten
// Werkbank, bau einfach eine neue Benutzeroberfläche." Der Aufbau hier folgt
// deshalb dem Entwurf und nicht der alten Fassung: Titelleiste mit Kontext und
// dem Ort der Arbeitsmodi, Freigabeleiste quer darunter, links ein Baum aus
// Projekten und ihren Orchestratoren, in der Mitte die Tab-Leiste ueber der
// Pane-Flaeche mit dem Dreifachschalter, rechts der Inspektor, unten die
// Statusleiste.
//
// WAS DIESE DATEI NICHT MEHR TUT: Terminals zeichnen. Das steht seit dem
// Neubau in `paneflaeche.ts` -- unveraendert, weil es gemessenes Verhalten ist
// (Bildlauf, Groessensprung, Alternativschirm, Mausverfolgung, Rueckblick).
// Hier stehen nur noch die Leisten darum und die Frage, WAS auf der Flaeche
// liegen soll.
//
// DIE DREI FRAGEN, die die Oberflaeche in einer Sekunde beantworten muss:
//   Wartet etwas auf mich?  Die Freigabeleiste oben, quer, ueber alle Projekte
//                           hinweg -- plus das Abzeichen in der Titelleiste.
//   Was laeuft gerade?      Zustandspunkte auf drei Ebenen: Projekt,
//                           Orchestrator, Tab. Farbe UND Form.
//   Wo greife ich ein?      Pane anklicken, zoomen, tippen.
//
// Der Renderer hat NULL Direktzugriffe auf den Hauptprozess; alles laeuft ueber
// `window.awbBridge` (preload/preload.ts). Das bleibt so.
import './werkbank.css';
import {
  flaecheMelden,
  initPaneflaeche,
  paneflaecheBericht,
  paneflaecheHaken,
  paneflaecheNachziehen,
  schilderNachziehen,
  setzeSchrift,
  setzeScroll,
  terminalThemaAnwenden,
  type LayoutPayload,
  type SessionPayload,
} from './paneflaeche';
import { initFreigabenView, freigabenUiState } from './freigaben-view';
import { figurenFarbenNeu } from './agentenfigur';
import { initWeltenView, weltenAnzeigen, weltenAufgaben, weltenSichtbar, weltenUiState, weltenSpracheGesetzt } from './welten-view';
import { initAktivitaetView, aktivitaetUiState } from './aktivitaet-view';
import { initOrdnerView, ordnerUiState } from './ordner-view';
import { initProtokolleView, protokolleUiState } from './protokolle-view';
import { kurzerPfad } from './kurzpfad';
import { ErgebnisMeldung, Meldungen } from './meldungen';
import { initEditorView } from './editor-view';
import { Seiten, type PlanAnzeige } from './seiten-view';
import { initFussStatus, zeichneStatuszeile, type MaschinenStand } from './fuss-status';
import { setzeSprache as setzeChatSprache } from '../chat/texte';
import { setzeSprache, t } from './texte';
import { Chatbuehne, type ChatBruecke } from './chatbuehne-view';
import '../chatbuehne/ansicht.css';

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
  claudeSessionId: string;
  /** Sie lief noch, als dieses Programm zuletzt hinsah, und ist jetzt weg (11.08.). */
  verloren?: boolean;
  /** Fuer diesen Ordner laeuft gerade ein Start (21.08.). */
  startet?: boolean;
  /** Der letzte Start fuer diesen Ordner ist gescheitert (21.08.). */
  startFehler?: boolean;
  sessionKey: string;
  harness?: string;
  model?: string;
  revive?: { conversation: 'resumed' | 'fresh'; reason: string };
}
interface AmpelBefund { quelle: string; vorhanden: boolean; rot: boolean; ueberfaellig: boolean; ueberholt: boolean; ageDays: number; text: string }
interface AmpelStand { machine: string; befunde: AmpelBefund[]; farbe: 'rot' | 'gelb' | 'gruen' | 'unbekannt' }
/**
 * Farben durchreichen (11.08.): dieselbe Form wie `ThemaPayload` in
 * main/thema.ts, hier noch einmal deklariert statt importiert -- Renderer und
 * Hauptprozess bleiben getrennte Prozesse, keine Datei dieses Fensters
 * importiert bisher aus main/, und ein Nur-Typ-Import waere die erste Ausnahme.
 */
interface ThemaPayload {
  thema: string;
  wirksam: 'hell' | 'dunkel';
  zustandsfarben: Record<string, string>;
  zustandsfarbenLesbar: Record<string, string>;
  zustandsfarbenTinte: Record<string, string>;
  akzent: string;
  akzentTinte: string;
  akzentText: string;
  systemAkzentfarbe: string;
}
interface BudgetStand { ok: boolean; heuteTokens: number; heuteStunden: number; hochrechnung24h: number; text: string }
interface Model {
  sessions: Session[];
  all: number;
  ui: {
    sidebarWidth: number; showStopped: boolean; sort: string; order: string[];
    selected: string; workerTab: number;
    /** Je Sitzung: zeigt die Flaeche den Orchestrator oder die Worker (04.09.). */
    flaecheSitzung?: Record<string, string>;
    /** Breite eines GEOEFFNETEN Blattes, getrennt vom Reiterstreifen (04.09.). */
    blattBreite?: number;
    /** Ob der Editor eingeklappt steht (05.09.); editor-view.ts liest es. */
    editorEingeklappt?: boolean;
  };
  selected: string;
  machine: string;
  capacity: {
    perRow: number; perColumn: number; perTab: number; cappedBySetting: boolean; tabs: number; workerCount: number;
    spalten: number; zeilen: number;
  };
  /**
   * DIE MASCHINEN, die dieses Programm kennt (03.09.). Neu im Modell -- der
   * Baum und die Statusleiste brauchen die Erreichbarkeit je Maschine, und die
   * liess sich bisher nur aus den Sitzungen ableiten, die zufaellig auf ihr
   * liefen. Eine Maschine ohne Sitzung gab damit gar keine Auskunft.
   */
  maschinen?: MaschinenStand[];
  /** Wieviele FREMDE Clients an der gezeichneten Session haengen (06.08.). */
  fremdeClients: number;
  /** Schriftgroesse der Terminals in Pixeln, aus den Einstellungen (06.08.). */
  schriftgroesse: number;
  /** Zeilen je Rad-Rasterung, aus den Einstellungen (06.08.). */
  scrollZeilen: number;
  streamPane: string;
  mayArrange: boolean;
  chats?: {
    id: string; name: string; ordner: string; zuletzt: string; laeuft: boolean;
    tmuxSession?: string;
    worker?: { name: string; paneId: string; laeuft: boolean }[];
  }[];
  leiste?: { art: 'terminal' | 'chat'; id: string }[];
  chatWerkstattGezeigt?: string;
  chatGezeigt?: string;
  ampel: AmpelStand[];
  budget: BudgetStand | null;
}

/** Die Nutzlast der Freigabe-Ansicht (V20) -- hier nur, was die Leiste oben braucht. */
interface GuardBlockEintrag {
  path: string; pane: string; guard: string; reason: string; command: string;
  cwd: string; ts: string; sessionId: string; sessionName: string; machine: string;
  workerName: string; unbekannterPane: boolean;
  wartet: boolean; muster: string; musterGrund: string; schluessel: string;
}
interface AntragEintrag {
  path: string; ts: string; parent: string; parentModel: string;
  childName: string; childModel: string; childEffort: string; dir: string;
  files: string[]; task: string; doneCriterion: string; whySeparable: string; est: string;
}
interface FreigabenNutzlast { requests: AntragEintrag[]; guardBlocks: GuardBlockEintrag[] }

declare global {
  interface Window {
    awbBridge: {
      /** `process.platform` des Hauptprozesses -- siehe preload.ts. */
      plattform: string;
      heim?: string;
      /** AWB_TESTHAKEN=1 -- siehe preload.ts. */
      testhaken?: boolean;
      ready(): void;
      onSession(fn: (p: SessionPayload) => void): void;
      onOutput(fn: (p: { paneId: string; data: string }) => void): void;
      onLayout(fn: (p: LayoutPayload) => void): void;
      onModel(fn: (p: Model) => void): void;
      /** Welten und Fusszeile des Tabs Agents -- siehe preload.ts. */
      onAufgaben(fn: (p: unknown) => void): void;
      aufgabenDaten(): Promise<unknown>;
      aufgabe(befehl: string, opt?: { echt?: boolean; bestaetigt?: boolean }): Promise<unknown>;
      aufgabenSichtbar(an: boolean): void;
      weltOrdnerWaehlen(echt: boolean): Promise<{ pfad: string; grund: string }>;
      onKanal(fn: (p: { pfad: string; fehler: string | null }) => void): void;
      onFreigaben(fn: (p: unknown) => void): void;
      onErgebnis(fn: (p: ErgebnisMeldung) => void): void;
      onOrdner(fn: (p: unknown) => void): void;
      onMaus(fn: (p: Record<string, { an: boolean; sgr: boolean }>) => void): void;
      onAktivitaet(fn: (p: unknown) => void): void;
      onSuche(fn: (p: unknown) => void): void;
      onSeite(fn: (p: { name: string }) => void): void;
      onDateiGeaendert(fn: (p: { name: string }) => void): void;
      onPlan(fn: (p: PlanAnzeige) => void): void;
      onPlanErgebnis(fn: (p: { ok: boolean; ausgabe: string }) => void): void;
      input(paneId: string, base64: string): void;
      bedienung(aktion: string, wert: unknown): void;
      rueckblickFehlt(paneId: string): void;
      /** Rechtsklick auf eine Sitzung -- die Echtheit des Ereignisses reist mit. */
      sitzungsMenue(id: string, echt: boolean): void;
      onUmbenennen(fn: (p: { id: string; name: string; dir: string }) => void): void;
      onMeldung(fn: (p: { text: string; dauerMs?: number }) => void): void;
      onChatAnsicht(fn: (p: { paneId: string; an: boolean }) => void): void;
      umbenennen(id: string, name: string): Promise<{ ok: boolean; meldung: string; aufruf: string }>;
      thema(): Promise<ThemaPayload>;
      onThema(fn: (p: ThemaPayload) => void): void;
      zwischenablageLesen(): Promise<string>;
      zwischenablageSchreiben(text: string): Promise<void>;
    };
    awbChat?: ChatBruecke;
    __awb: Record<string, unknown>;
  }
}

// --- Die Teile des Fensters -------------------------------------------------
const rahmenEl = document.getElementById('rahmen') as HTMLDivElement;
const linksEl = document.getElementById('links') as HTMLElement;
const rechtsEl = document.getElementById('rechts') as HTMLElement;
const sessionsEl = document.getElementById('sessions') as HTMLDivElement;
const rechtsListeEl = document.getElementById('rechtsliste') as HTMLDivElement;
const inspBereichEl = document.getElementById('insp-bereich') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const lageEl = document.getElementById('lage') as HTMLDivElement;
const ordnenEl = document.getElementById('ordnen') as HTMLButtonElement;
const uebersichtEl = document.getElementById('uebersicht') as HTMLDivElement;
const leerEl = document.getElementById('leer') as HTMLDivElement;
const kTeilerEl = document.getElementById('k-teiler') as HTMLSpanElement;
const hinweisEl = document.getElementById('hinweis') as HTMLDivElement;
const griffEl = document.getElementById('griff') as HTMLDivElement;
const griffRechtsEl = document.getElementById('griff-rechts') as HTMLDivElement;
const notizEl = document.getElementById('notiz') as HTMLDivElement;
const kanalwarnungEl = document.getElementById('kanalwarnung') as HTMLDivElement;
const freigabeleisteEl = document.getElementById('freigabeleiste') as HTMLDivElement;
const abzeichenEl = document.getElementById('freigabe-abzeichen') as HTMLButtonElement;
const inspKnopfEl = document.getElementById('insp-knopf') as HTMLButtonElement;
const kPunktEl = document.getElementById('k-punkt') as HTMLSpanElement;
const kProjektEl = document.getElementById('k-projekt') as HTMLSpanElement;
const kOrchEl = document.getElementById('k-orch') as HTMLSpanElement;
const kNebenEl = document.getElementById('k-neben') as HTMLSpanElement;
const stWorkerEl = document.getElementById('st-worker') as HTMLDivElement;
// Der Inhaltskopf (04.09.) -- Name, Herkunft, Statuspille, Umschalter, Zahnrad.
const inhaltskopfEl = document.getElementById('inhaltskopf') as HTMLDivElement;
const ikNameEl = document.getElementById('ik-name') as HTMLDivElement;
const ikHerkunftEl = document.getElementById('ik-herkunft') as HTMLDivElement;
const ikWorkerEl = document.getElementById('ik-worker') as HTMLButtonElement;
const workerlisteEl = document.getElementById('workerliste') as HTMLDivElement;
const ikModusEl = document.getElementById('ik-modus') as HTMLDivElement;
const modiEl = document.getElementById('modi') as HTMLDivElement;
const ikZahnradEl = document.getElementById('ik-zahnrad') as HTMLButtonElement;
const tabstreifenEl = document.getElementById('tabstreifen') as HTMLDivElement;
// Die Sitzungskarte hinter dem Zahnrad.
const skEl = document.getElementById('sitzungskarte') as HTMLDivElement;
const skNameEl = document.getElementById('sk-name') as HTMLInputElement;
const skListeEl = document.getElementById('sk-liste') as HTMLDListElement;
const skKnoepfeEl = document.getElementById('sk-knoepfe') as HTMLDivElement;
/**
 * DIE CHAT-SITZUNG AUF DER BUEHNE (13.08.). Der Kasten liegt UEBER dem
 * Kachelgitter und ist zu, solange keine Chat-Sitzung gewaehlt ist -- das
 * Gitter darunter wird nicht angefasst, damit die Flaeche fuer
 * Terminal-Sitzungen genau bleibt, was sie war.
 */
const chatbuehne = new Chatbuehne(document.getElementById('chatbuehne') as HTMLDivElement, window.awbChat);
(window as unknown as Record<string, unknown>).__awbChat = chatbuehne.haken();

// --- Zustand dieses Fensters ------------------------------------------------
let modell: Model | null = null;
/** Was die Kopfzeile hergab: bleibt abrufbar, braucht aber keinen Dauerplatz. */
const auskunft = { session: '-', pane: '-', groesse: '-', regel: '-', layout: '-', ansicht: '-' };
/** Leer heisst: es gibt einen Steuerkanal. Sonst der Grund, warum nicht. */
let kanalGrund = '';
/** Welche Projekte im Baum aufgeklappt sind. Neue sind es von Anfang an. */
const offeneProjekte = new Set<string>();
/** Ob je ein Projekt zugeklappt wurde -- vorher gilt „alle offen". */
let baumBeruehrt = false;
/** Liegt die Uebersicht ueber der Flaeche? Die beiden anderen Ansichten kommen aus der Lage selbst. */
let uebersichtAn = false;

/**
 * WELCHE BUEHNE STEHT -- Code oder Agents (08.09.2026, Auftrag macagents; seit
 * dem 14.09.2026 zeigt Agents die Welten, Auftrag agentsui Nr. 6).
 *
 * Eine EIGENE Achse neben `flaechenmodus` (Orchestrator | Worker): der hier
 * sagt, WAS vorn liegt, jener ordnet die Code-Buehne. Im Zustand Agents legt
 * welten-view.ts seine Flaeche mit Leiste der Welt, Mitte, Inspektor und
 * Fusszeile ueber das Fenster; die Pane-Flaeche darunter behaelt ihre Masse.
 *
 * Die Wahl gehoert dem Fenster und nicht dem Kern: `ui.json` hat keinen
 * Schluessel dafuer. Sie ueberlebt den Neustart deshalb nicht -- dieselbe
 * Entscheidung wie in der Mac-Fassung (Fenster.swift, `Buehnenmodus`).
 */
let buehnenmodus: 'code' | 'agents' = 'code';

function modusSetzen(neu: 'code' | 'agents'): void {
  if (buehnenmodus === neu) return;
  buehnenmodus = neu;
  weltenAnzeigen(neu === 'agents');
  for (const b of modiEl.querySelectorAll<HTMLButtonElement>('[data-modus]')) {
    const an = b.dataset.modus === neu;
    b.classList.toggle('gewaehlt', an);
    b.setAttribute('aria-selected', String(an));
  }
  if (modell) { zeichneInhaltskopf(modell); zeichneStreifen(modell); }
}

/**
 * WAS DIE FLAECHE ZEIGT -- Orchestrator oder Worker (04.09.2026, des Nutzers
 * Entscheidung). Beides sind Panes derselben Sitzung, aber sie beantworten
 * verschiedene Fragen: der Orchestrator ist EIN Pane und fuellt die Flaeche,
 * ohne dass es etwas zu kacheln gaebe; die Worker sind viele und brauchen
 * Tabs und den Dreifachschalter. Deshalb bestimmt der Umschalter im
 * Inhaltskopf, ob der Streifen darunter ueberhaupt dasteht.
 *
 * Die Wahl gehoert der SITZUNG und wird in ui.json gemerkt (uistate.ts,
 * `flaecheSitzung`): wer an einem Projekt am Orchestrator arbeitet und an
 * einem anderen an den Workern, findet beim Zurueckwechseln das wieder, was er
 * verlassen hat.
 */
type Flaechenmodus = 'orchestrator' | 'worker';

/**
 * WAS AUF DER FLAECHE LIEGT, SCHLAEGT DIE GEMERKTE WAHL (04.09.2026, im selben
 * Geist wie Befund 6 der Inventur: der Schalter zeigt keinen Zustand an, den
 * man gerade nicht sieht).
 *
 * Der gemerkte Wert sagt, womit eine Sitzung AUFGEHEN soll; angezeigt wird
 * aber, was WIRKLICH gezeichnet ist. Ohne diese Ableitung stand der Umschalter
 * auf „Orchestrator", waehrend drei Worker-Kacheln danebenlagen -- gemessen am
 * Belegbild vom 04.09., nachdem ein `show-tab` ueber den Steuerkanal kam.
 */
let gezeichnetePanes: string[] = [];

function flaechenmodus(m: Model): Flaechenmodus {
  const s = m.sessions.find((x) => x.id === m.selected);
  if (s && gezeichnetePanes.length) {
    const nurOrchestrator = gezeichnetePanes.length === 1
      && !!s.orchestratorPane && gezeichnetePanes[0] === s.orchestratorPane;
    return nurOrchestrator ? 'orchestrator' : 'worker';
  }
  return gemerkterModus(m, m.selected);
}

/** Die gemerkte Wahl dieser Sitzung -- womit sie aufgehen soll. */
function gemerkterModus(m: Model, id: string): Flaechenmodus {
  return m.ui.flaecheSitzung?.[id] === 'orchestrator' ? 'orchestrator' : 'worker';
}

/**
 * LIEGT WENIGSTENS EIN WORKER-PANE AUF DER BUEHNE? (05.09.2026, des Nutzers
 * Beanstandung am Belegbild `ObenLeiste.png`.)
 *
 * Der Tab-Streifen traegt ausschliesslich Dinge, die es nur zu WORKERN gibt:
 * die Tabs, die Kachelform, den Dreifachschalter und „Ordnen". Liegt der
 * Orchestrator auf der Buehne, oder hat die Sitzung gar keine Worker, hat er
 * nichts zu schalten -- und ein Streifen ohne Wirkung nimmt der Buehne 34
 * Bildpunkte weg, in einer Sitzung mehr als in der anderen. Genau das war zu
 * sehen: `Studium` mit dem Orchestrator auf der Flaeche hatte einen zweizeiligen
 * Kopf, `Workbench` im selben Zustand einen einzeiligen.
 *
 * GEMESSEN WIRD DIE BUEHNE, nicht die gemerkte Wahl. Die beiden liefen bis
 * heute auseinander: `Studium` hatte „Worker" gemerkt, gezeichnet war der
 * Orchestrator. Was man SIEHT, entscheidet -- dieselbe Regel, nach der sich
 * schon der Umschalter richtet (`flaechenmodus`). Die gemerkte Wahl bleibt
 * unberuehrt; sie ist das, was der naechste Klick auf „Worker" wiederherstellt.
 *
 * GEFRAGT WIRD NACH DEN WORKER-PANES, nicht nach „alles ausser dem
 * Orchestrator". Beides faellt fast immer zusammen, aber nicht immer: kennt
 * eine Sitzung ihren Orchestrator-Pane nicht (kein `@wb_role orchestrator` am
 * Pane), waere jeder gezeichnete Pane ein Worker, und der Streifen stuende
 * wieder ohne Tabs da. Die Panes der Worker samt ihren Subagenten sind genau
 * das, was der Streifen in Tabs fasst (`flacheWorker`).
 */
function workerAufDerBuehne(m: Model): boolean {
  const s = m.sessions.find((x) => x.id === m.selected);
  if (!s) return false;
  const workerPanes = new Set<string>();
  for (const w of flacheWorker(s)) {
    if (w.paneId) workerPanes.add(w.paneId);
    for (const sub of w.subagents) if (sub.paneId) workerPanes.add(sub.paneId);
  }
  for (const sub of s.orphanSubagents) if (sub.paneId) workerPanes.add(sub.paneId);
  return gezeichnetePanes.some((p) => workerPanes.has(p));
}

/**
 * DIE GEMERKTE WAHL EINMAL ANWENDEN, wenn die Sitzung gewechselt hat. Sie ist
 * eine Vorliebe („in diesem Projekt arbeite ich am Orchestrator"), und eine
 * Vorliebe wirkt beim Aufgehen, nicht dauernd -- wer danach von Hand einen
 * Worker zeigt, soll ihn sehen und nicht zurueckgeschoben werden.
 */
let modusAngewandtFuer = '';

/** Ist die Sitzungskarte hinter dem Zahnrad gerade offen? */
let sitzungskarteAuf = false;
/**
 * Fuer WELCHE tote Sitzung die Rueckfrage vor dem Wiederbeleben offen steht --
 * leer heisst: fuer keine. Sie haengt an der Kennung und nicht an einem
 * Merkmal der Zeile, damit sie das Neuzeichnen im Takt uebersteht.
 */
let wiederFrage = '';
/** Welche Freigabe die Leiste gerade zeigt, und ob ihre Begruendung aufgeklappt ist. */
let freigabeNr = 0;
let begruendungAuf = false;
let freigabenStand: FreigabenNutzlast = { requests: [], guardBlocks: [] };
/**
 * Wieviele Neuzeichnungen der Leisten ueber jede der drei Quellen kamen. Ein
 * Test liest den Stand zweimal im Abstand einer festen Zeitspanne und bildet
 * die Differenz -- so wird "wie oft in zehn Sekunden" zur Messung statt zur
 * Vermutung (test-app-rechts-takt.sh).
 */
const rechtsZaehler = { model: 0, layout: 0, session: 0 };

let notizUhr: number | undefined;
/**
 * Kurze Rueckmeldung ueber der Flaeche. Verschwindet von selbst wieder --
 * nach vier Sekunden, oder nach `dauerMs`, wenn der Absender es so will
 * (der Absturz-Hinweis, main/absturz.ts: 30 s). Eine Meldung, die laenger
 * steht, geht auch mit dem naechsten Klick irgendwo im Fenster.
 */
function notiz(text: string, dauerMs = 4000): void {
  if (notizUhr !== undefined) clearTimeout(notizUhr);
  document.removeEventListener('click', notizWeg, true);
  notizEl.textContent = text;
  notizEl.classList.toggle('sichtbar', !!text);
  if (text) {
    notizUhr = setTimeout(notizWeg, dauerMs) as unknown as number;
    if (dauerMs > 4000) document.addEventListener('click', notizWeg, true);
  }
}
function notizWeg(): void {
  if (notizUhr !== undefined) clearTimeout(notizUhr);
  notizUhr = undefined;
  document.removeEventListener('click', notizWeg, true);
  notizEl.classList.remove('sichtbar');
  notizEl.textContent = '';
}

/**
 * Die Zustandsklasse einer SITZUNG. Die Namen sind die des Farbsystems
 * (main/thema.ts): `laeuft`, `will`, `fern`, `aus` -- vier Rollen, vier
 * Farben, und dieselbe Bedeutung in allen fuenf Fenstern.
 */
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

/** Die Zustandsklasse eines WORKERS. */
function zustandFarbe(state: string): string {
  if (state === 'running') return 'laeuft';
  if (state === 'blocked') return 'will';
  if (state === 'stalled') return 'will';
  if (state === 'unknown') return 'fern';
  return 'ruhig';
}

/** Schmal oder aufgezogen -- was eine Leiste zeigt, haengt an ihrer Breite. */
function schmalLinks(w: number): boolean { return w <= 64; }

/** Welches Blatt beim letzten Zeichnen offen stand -- fuer das Nachziehen der Buehne. */
let zuletztOffenesBlatt = '';
/**
 * Welches Blatt zuletzt gelesen wurde. Der Schalter oben rechts oeffnet es
 * wieder -- wer die Aktivitaet zugeklappt hat, bekommt beim naechsten Griff
 * die Aktivitaet und nicht wieder den Ordner (Electron-Befund 1).
 */
let letztesBlatt = 'ordner';

/**
 * KEIN WORT WIRD HALB ABGESCHNITTEN (04.09.2026, Befund des Nutzers am
 * Belegbild: „Aktivi…", „Proto…").
 *
 * Vorher stand hier eine feste Zahl -- unter 230 Bildpunkten Symbol allein,
 * darueber Wort. Eine feste Zahl ist bei uebersetzten Aufschriften immer
 * falsch: „Protokolle" und „Logs" brauchen nicht dieselbe Breite, und wer die
 * Zahl fuer die eine Sprache richtig waehlt, hat sie fuer die andere geraten.
 *
 * Gemessen wird deshalb am gezeichneten Element. Passt auch nur EINE der drei
 * Aufschriften nicht ganz, faellt die ganze Reihe auf ihre Symbole zurueck --
 * drei Symbole nebeneinander sind eine Reihe, zwei Woerter und ein Stummel
 * sind keine. Das Wort steht dann im Hilfeschildchen.
 *
 * Gemessen wird nur, wenn sich die Breite geaendert hat: die Messung erzwingt
 * einen Umbruch, und `zeichneInspektor` laeuft in jedem Modelltakt.
 */
let reiterGemessenBei = -1;

function reiterAufschriftPruefen(breite: number): void {
  if (breite === reiterGemessenBei) return;
  reiterGemessenBei = breite;
  rechtsEl.classList.remove('nur-symbole');
  const aufschriften = [...rechtsEl.querySelectorAll<HTMLElement>('.insp-reiter .beschriftung')];
  // Ein verborgener Inspektor misst 0 gegen 0 und gilt damit als passend --
  // richtig so: gemessen wird erst wieder, wenn er wirklich dasteht.
  const passt = aufschriften.every((el) => el.scrollWidth <= el.clientWidth + 1);
  rechtsEl.classList.toggle('nur-symbole', !passt);
}

function dauer(sekunden: number): string {
  if (!Number.isFinite(sekunden) || sekunden < 0) return '';
  const min = Math.floor(sekunden / 60);
  if (min < 1) return t('zeit.geradeEben');
  if (min < 60) return t('zeit.minuten', { n: min });
  return t('zeit.stundenMinuten', { std: Math.floor(min / 60), min: min % 60 });
}

/** Was ein Worker gerade tut, in einem halben Satz. */
function zustandText(w: Worker): string {
  if (w.state === 'blocked') {
    return w.blockedReason === 'guard' ? t('worker.guard') : t('worker.entscheidung');
  }
  if (w.state === 'stalled') return t('worker.haengt', { dauer: dauer(w.idleSeconds) });
  if (w.state === 'unknown') return t('worker.nichtEinsehbar');
  if (w.state === 'done') return w.resultPath ? t('worker.fertigMitErgebnis') : t('worker.fertigOhneErgebnis');
  if (w.contextPercent >= 0) return t('worker.kontext', { prozent: w.contextPercent });
  return t('worker.laeuftSchlicht');
}

/** Tokenstand eines Workers, kompakt -- leer, solange keiner bekannt ist. */
function tokenKurz(w: Worker): string {
  if (!w.contextTokens) return '';
  if (w.contextTokens >= 1_000_000) return `${(w.contextTokens / 1_000_000).toFixed(1)}M`;
  if (w.contextTokens >= 1000) return `${Math.round(w.contextTokens / 1000)}k`;
  return String(w.contextTokens);
}

function svg(inhalt: string, groesse = 12, strich = 1.4): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('width', String(groesse));
  el.setAttribute('height', String(groesse));
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', String(strich));
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.innerHTML = inhalt;
  return el;
}

/**
 * DAS SYMBOL EINER ZEILE (04.09.2026, Regel 7 des Auftrags). Jede Zeile mit
 * Bedeutung traegt einen gezeichneten Umriss von 16 Bildpunkten in der
 * gedaempften Schrift -- Ordner fuer ein Projekt, Terminal fuer eine
 * Orchestrator-Sitzung, Sprechblase fuer eine Chat-Sitzung. Inline gezeichnet,
 * kein Emoji, keine Symbolschrift; in der aktiven Zeile faerbt es die Regel in
 * werkbank.css auf den Akzent um.
 *
 * Der ZUSTANDSPUNKT daneben bleibt: er sagt, wie es der Zeile geht, das Symbol
 * sagt, was sie ist. Zwei Fragen, zwei Zeichen.
 */
/**
 * DAS KUERZEL EINER ZEILE (Befund 7 der Inventur). Eingeklappt blieb von jeder
 * Zeile nur ihr Punkt -- bei drei laufenden Sitzungen dreimal derselbe, und
 * damit keine Auskunft mehr darueber, WELCHE Sitzung welche ist. Der alte
 * Stand trug dort zwei Buchstaben in der Zustandsfarbe; sie kommen zurueck.
 *
 * Sichtbar sind sie NUR in der eingeklappten Leiste (werkbank.css); aufgezogen
 * steht der Name da, und dann waeren sie dieselbe Auskunft zweimal.
 */
function kuerzelMarke(quelle: string, farbe: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `kuerzel ${farbe}`;
  el.textContent = kuerzelAus(quelle);
  return el;
}

/**
 * Zwei Buchstaben aus einem Namen. `initials` aus dem Modell wird bevorzugt --
 * es kommt aus derselben Ableitung, die auch die alte Oberflaeche benutzte --,
 * und fehlt es, entstehen sie hier aus den ersten Zeichen der Wortanfaenge.
 */
function kuerzelAus(quelle: string): string {
  const roh = (quelle ?? '').trim();
  if (roh.length <= 2) return roh.toUpperCase();
  const woerter = roh.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (woerter.length >= 2) return (woerter[0][0] + woerter[1][0]).toUpperCase();
  return roh.slice(0, 2).toUpperCase();
}

/**
 * DIE ZUSATZZEILE UNTER DEM NAMEN (Befund 8). Sie sagt, auf welcher Maschine
 * die Sitzung laeuft und wie viele Worker sie hat -- und waehrend eines Starts
 * stattdessen, dass gestartet wird oder dass der Start gescheitert ist.
 *
 * Erst ab 200 Bildpunkten Leistenbreite: darunter verdraengte sie den Namen,
 * um dessentwillen die Leiste ueberhaupt aufgezogen wird. Dieselbe Schwelle
 * wie im alten Stand.
 */
const ZUSATZ_AB = 200;

/**
 * DIE WICHTIGE HAELFTE STEHT VORN. Die Zeile kuerzt von rechts mit
 * Auslassungspunkten, und ein Rechnername ist lang: stand er vorn, blieb bei
 * 232 Bildpunkten „MacBook-Pro-von-alice…" stehen und die Worker-Zahl fiel
 * weg -- gemessen am Belegbild vom 04.09. Also erst die Zahl, dann die
 * Maschine; beides steht da, und was zuerst weicht, ist das, was man am
 * ehesten schon weiss.
 */

/**
 * DIE UNTERZEILE SAGT, WAS DIESE ZEILE VON DEN ANDEREN UNTERSCHEIDET
 * (05.09.2026, Electron-Befund 3 und Regelbruch 10).
 *
 * Sie trug bis heute an JEDER Zeile „n Worker · MacBook-Pro-von-alice". Der
 * Maschinenname war damit in jeder Zeile derselbe, kostete bei 232 Bildpunkten
 * Leistenbreite die ganze verfuegbare Breite und wurde trotzdem abgeschnitten.
 * Er steht deshalb nur noch da, wo er wirklich etwas unterscheidet: auf einer
 * FREMDEN Maschine. Auf der eigenen traegt die Zeile nur ihre Worker-Zahl.
 *
 * Und eine VERLORENE Sitzung sagt jetzt, dass sie verloren ist. Vorher trug sie
 * dieselbe Unterzeile wie eine gestoppte („0 Worker · …"), und die gelbe
 * Schrift war der einzige Unterschied -- eine Auskunft, die ohne Farbe nicht
 * mehr da ist. Ihre Worker-Zahl ist ohnehin null, also nimmt der Satz nichts weg.
 */
function zusatzzeile(s: Session, m: Model): string {
  if (m.ui.sidebarWidth < ZUSATZ_AB) return '';
  const fremd = Boolean(s.machine) && s.machine !== m.machine;
  if (s.verloren) return t('sitzung.verlorenKurz');
  if (s.startFehler) {
    return fremd ? t('sitzung.startFehlerKurzFremd', { maschine: s.machine }) : t('sitzung.startFehlerKurz');
  }
  if (s.startet) {
    return fremd ? t('sitzung.startetKurzFremd', { maschine: s.machine }) : t('sitzung.startetKurz');
  }
  const n = s.workers.filter((w) => w.alive).length;
  return fremd ? t('sitzung.workerZahlFremd', { maschine: s.machine, n }) : t('sitzung.workerZahl', { n });
}

function zeilensymbol(art: 'projekt' | 'sitzung' | 'chat'): HTMLSpanElement {
  const pfad = art === 'projekt'
    ? '<path d="M1.9 12.4V3.6h4l1.4 1.7h6.8v7.1z"/>'
    : art === 'chat'
      ? '<path d="M2.6 4.2a1.6 1.6 0 011.6-1.6h7.6a1.6 1.6 0 011.6 1.6v4.6a1.6 1.6 0 01-1.6 1.6H6.4L3.4 13V10.4h-.8z"/>'
      : '<rect x="1.8" y="2.9" width="12.4" height="10.2" rx="2"/><path d="M4.6 6.6l2 1.7-2 1.7M8.4 10.4h3"/>';
  const el = document.createElement('span');
  el.className = 'zeilensymbol';
  el.appendChild(svg(pfad, 16, 1.3));
  return el;
}

function punkt(klasse: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `punkt ${klasse}`;
  return el;
}

// --- Projekt, Orchestrator, Maschine ----------------------------------------
/**
 * WOHER DER BAUM SEINE DREI EBENEN NIMMT (gemessen 03.09., vor dem Bau).
 *
 * Nachgesehen wurde in `awb:model` (main.ts), in der Zustandsdatei einer
 * Sitzung (main/sessions.ts, `SessionInfo`) und in `wb-rolle`. Ergebnis: alles
 * Noetige ist schon da, es war nur nie so gelesen worden.
 *
 *   Projekt        `session.dir` -- das Verzeichnis, in dem die Sitzung laeuft.
 *                  Sein letzter Teil ist der Name. Mehrere Orchestrator im
 *                  selben Verzeichnis sind der Normalfall, auch auf
 *                  verschiedenen Maschinen; sie landen deshalb unter DEMSELBEN
 *                  Knoten, und der Knoten heisst nach dem Verzeichnis.
 *   Orchestrator   die Sitzung selbst. Jede hiesige Sitzung HAT einen
 *                  Orchestrator-Pane (`orchestratorPane`, gesetzt ueber
 *                  `wb-rolle setzen <pane> orchestrator`); ihre Worker haengen
 *                  darunter und erscheinen im Baum nicht.
 *   Maschine       `session.machine`.
 *
 * Ergaenzt werden musste im Hauptprozess deshalb NUR die Maschinenliste selbst
 * (`maschinen` in `awb:model`) -- fuer die Statusleiste, die eine Maschine auch
 * dann nennen soll, wenn gerade keine Sitzung auf ihr laeuft.
 */
type Chat = NonNullable<Model['chats']>[number];

/**
 * EINE ZEILE DES BAUMS -- Terminal-Sitzung ODER Chat-Sitzung (04.09.2026,
 * Befund 5 der Inventur). Vorgabe des Nutzers vom 12.08. lautet: „die session
 * soll links nicht anders behandelt werden als die terminal sessions". Der
 * Kommentar im Baum versprach das schon, der Code sammelte die Chats in einen
 * eigenen Kasten hinter alle Projekte -- eine Chat-Sitzung im Ordner `beta`
 * stand also nicht unter `beta`, sondern als letzte Zeile ganz unten.
 *
 * Jetzt tragen beide Sorten dieselbe Form: eine Kennung, einen Ordner und ihre
 * Nutzlast. Wo sie stehen, entscheidet allein der Ordner, in welcher
 * Reihenfolge allein `m.leiste` -- dieselbe, die der Hauptprozess EINMAL fuer
 * beide Sorten sortiert.
 */
type Baumzeile =
  | { art: 'terminal'; id: string; ordner: string; sitzung: Session }
  | { art: 'chat'; id: string; ordner: string; chat: Chat };

interface Projektknoten { id: string; name: string; pfad: string; zeilen: Baumzeile[] }

function projektName(pfad: string): string {
  const teile = pfad.split('/').filter(Boolean);
  return teile[teile.length - 1] || pfad || '?';
}

function projekte(m: Model): Projektknoten[] {
  const nachPfad = new Map<string, Projektknoten>();
  const sitzungen = new Map(m.sessions.map((x) => [x.id, x]));
  const chats = new Map((m.chats ?? []).map((c) => [c.id, c]));
  // Die Reihenfolge kommt aus `m.leiste`: der Hauptprozess sortiert EINMAL,
  // mit derselben Funktion und derselben Voreinstellung fuer beide Sorten.
  // Ein Projekt steht dort, wo seine erste Zeile steht.
  const reihenfolge: { art: 'terminal' | 'chat'; id: string }[] = m.leiste
    ?? m.sessions.map((x) => ({ art: 'terminal' as const, id: x.id }));
  for (const e of reihenfolge) {
    let zeile: Baumzeile | null = null;
    if (e.art === 'chat') {
      const c = chats.get(e.id);
      if (c) zeile = { art: 'chat', id: c.id, ordner: c.ordner || '?', chat: c };
    } else {
      const x = sitzungen.get(e.id);
      if (x) zeile = { art: 'terminal', id: x.id, ordner: x.dir || '?', sitzung: x };
    }
    if (!zeile) continue;
    let knoten = nachPfad.get(zeile.ordner);
    if (!knoten) {
      knoten = { id: zeile.ordner, name: projektName(zeile.ordner), pfad: zeile.ordner, zeilen: [] };
      nachPfad.set(zeile.ordner, knoten);
    }
    knoten.zeilen.push(zeile);
  }
  return [...nachPfad.values()];
}

/**
 * WAS LIEGT AUF DER BUEHNE? (04.09.2026, Befund 6 der Inventur.)
 *
 * Gewaehlt heisst: das siehst Du gerade. Bis heute prueften beide Zeilenarten
 * nur ihre eigene Haelfte -- eine Terminal-Zeile `s.id === m.selected`, eine
 * Chat-Zeile `c.id === m.chatGezeigt` --, und mit einem Gespraech auf der
 * Buehne waren deshalb ZWEI Zeilen hervorgehoben. Die Titelleiste beschrieb
 * dabei die Terminal-Sitzung und der Dreifachschalter stand auf „Gezoomt";
 * beides sagte etwas ueber eine Flaeche, die gerade niemand sah.
 *
 * Es gibt genau drei Faelle, und `buehne()` gibt zurueck, welcher gilt:
 *   'chat'      ein Gespraech liegt auf der Buehne (`chatGezeigt`)
 *   'werkstatt' ein WORKER einer Chat-Sitzung liegt darauf (`chatWerkstattGezeigt`)
 *   'terminal'  die Kacheln der gewaehlten Terminal-Sitzung
 */
function buehneZeigt(m: Model): { art: 'chat' | 'werkstatt' | 'terminal'; chatId: string } {
  const chat = m.chatGezeigt ?? '';
  if (chat) return { art: 'chat', chatId: chat };
  const werkstatt = m.chatWerkstattGezeigt ?? '';
  if (werkstatt) return { art: 'werkstatt', chatId: werkstatt };
  return { art: 'terminal', chatId: '' };
}

/** Wartet in dieser Sitzung etwas auf einen Menschen? */
function sitzungWartet(s: Session): boolean {
  return s.state === 'attention' || s.pendingApprovals > 0 || s.workers.some((w) => w.state === 'blocked');
}

// --- Titelleiste ------------------------------------------------------------
function zeichneKopf(m: Model): void {
  // DIE TITELLEISTE BESCHREIBT, WAS AUF DER BUEHNE LIEGT (04.09., Befund 6).
  // Liegt dort ein Gespraech, stand hier bis heute weiter die zuletzt
  // gewaehlte Terminal-Sitzung -- ein Satz ueber etwas, das gerade niemand
  // sieht.
  const b = buehneZeigt(m);
  if (b.art !== 'terminal') {
    const c = (m.chats ?? []).find((x) => x.id === b.chatId);
    if (c) {
      kPunktEl.className = `punkt ${c.laeuft ? 'laeuft' : 'ruhig'}`;
      kProjektEl.textContent = projektName(c.ordner);
      kProjektEl.title = c.ordner;
      kopfNameSetzen(projektName(c.ordner), c.name);
      // Ein Gespraech laeuft immer hier: keine fremde Maschine, also nichts
      // daneben (05.09.2026, Regelbruch 4).
      kNebenEl.textContent = '';
      return;
    }
  }
  const s = m.sessions.find((x) => x.id === m.selected);
  // Der Schraegstrich trennt Projekt und Orchestrator -- ohne Sitzung gibt es
  // nichts zu trennen, und er stand als einzelnes Zeichen hinter dem Satz
  // „Keine Sitzung gewaehlt" (gemessen am ersten Blick, 03.09.).
  if (!s) {
    kTeilerEl.hidden = true;
    kPunktEl.className = 'punkt ruhig';
    kProjektEl.textContent = t('kopf.keineSitzung');
    kOrchEl.textContent = '';
    kNebenEl.textContent = '';
    return;
  }
  kPunktEl.className = `punkt ${startfarbe(s)}`;
  kProjektEl.textContent = projektName(s.dir);
  kopfNameSetzen(projektName(s.dir), s.name);
  // NUR DIE FREMDE MASCHINE, UND KEIN ZUSTANDSWORT (05.09.2026, Regelbruch 4).
  //
  // Hier standen Maschinenname und Zustand als Wort. Beides steht schon
  // anderswo -- der Zustand als Farbe im Punkt links daneben, in der Pille des
  // Inhaltskopfes und in der Statusleiste, die Maschine im Inhaltskopf und in
  // der Sitzungskarte. Bei schmalem Fenster kostete es genau den Platz, den der
  // Titel brauchte: der Text endete bei x = 434, das Segment begann bei x = 436,
  // und „MacBook-Pro-…" stand abgeschnitten da.
  //
  // Was BLEIBT, ist die Maschine, wenn sie nicht die eigene ist. Sie
  // unterscheidet dann etwas, und genau dafuer ist der Platz da.
  kNebenEl.textContent = s.machine && s.machine !== m.machine ? s.machine : '';
  kProjektEl.title = s.dir;
}

/**
 * PROJEKT UND SITZUNG, ABER KEINE ZWEIMAL (05.09.2026, Kleinigkeit 1).
 *
 * Der Normalfall im Haus ist eine Sitzung, die nach ihrem Projekt heisst --
 * dann stand oben „claude-workbench / claude-workbench", und der Schraegstrich
 * trennte einen Namen von sich selbst. Steht dort zweimal dasselbe, bleibt es
 * bei einem; sonst bleibt beides samt Trenner.
 */
function kopfNameSetzen(projekt: string, sitzung: string): void {
  const doppelt = projekt === sitzung;
  kTeilerEl.hidden = doppelt;
  kOrchEl.textContent = doppelt ? '' : sitzung;
}

// --- Freigabeleiste ---------------------------------------------------------
/**
 * WARUM DIE FREIGABEN OBEN STEHEN UND NICHT IM INSPEKTOR (alice am 03.09.:
 * „Ich will immer sehen, wenn eine Freigabe angefordert wird."). Etwas, das
 * immer sichtbar sein soll, kann nicht in einer Leiste liegen, die man
 * zuklappen kann und die ohnehin nur eines von drei Blaettern zeigt. Die
 * Leiste hier liegt quer ueber der ganzen Breite und zeigt JEDE offene
 * Freigabe des Programms, nicht nur die des gewaehlten Projekts.
 *
 * OHNE BEGRUENDUNG (sein zweiter Satz: „ich keinen Grund angeben muss").
 * Zwei Knoepfe, mehr nicht. Wer eine hinterlassen will, klappt sie auf; der
 * Satz darunter sagt, dass sie freiwillig ist und dass die Entscheidung sofort
 * an den Worker zurueckgeht -- den Rueckkanal gibt es seit dd756d2
 * (shell/wb-freigabe).
 */
interface OffeneFreigabe {
  art: 'guard' | 'antrag';
  wer: string;
  wo: string;
  worum: string;
  sessionId: string;
  pane: string;
  schluessel: string;
  pfad: string;
}

function offeneFreigaben(): OffeneFreigabe[] {
  const raus: OffeneFreigabe[] = [];
  for (const b of freigabenStand.guardBlocks) {
    // Nur die mittlere Stufe wartet auf eine Entscheidung; eine harte
    // Ablehnung ist keine Frage, sondern ein Befund.
    if (!b.wartet) continue;
    raus.push({
      art: 'guard',
      wer: b.workerName || b.pane,
      wo: `${b.sessionName || b.sessionId} · ${b.machine}`,
      worum: b.command,
      sessionId: b.sessionId,
      pane: b.pane,
      schluessel: b.schluessel,
      pfad: b.path,
    });
  }
  for (const r of freigabenStand.requests) {
    raus.push({
      art: 'antrag',
      wer: r.parent,
      // DER PROJEKTNAME, NICHT DER VOLLPFAD (05.09.2026, Electron-Befund 2).
      // Derselbe Pfad stand bis zu fuenfmal im Fenster; voll steht er noch in
      // der Sitzungskarte, hier reicht der Name des Ordners.
      wo: projektName(r.dir),
      worum: t('freigabe.antragUeber', { name: r.childName, modell: r.childModel }),
      sessionId: '',
      pane: '',
      schluessel: '',
      pfad: r.path,
    });
  }
  return raus;
}

function entscheiden(f: OffeneFreigabe, aktion: 'approve' | 'reject', grund: string, echt: boolean): void {
  if (f.art === 'guard') {
    window.awbBridge.bedienung('muster-entscheiden', {
      schluessel: f.schluessel, action: aktion, reason: grund, echt,
    });
  } else {
    window.awbBridge.bedienung('freigaben-entscheiden', { path: f.pfad, action: aktion, reason: grund });
  }
  notiz(aktion === 'approve' ? t('freigabe.erteilt', { name: f.wer }) : t('freigabe.abgelehnt', { name: f.wer }));
}

function zeichneFreigaben(): void {
  const liste = offeneFreigaben();
  freigabeleisteEl.replaceChildren();
  // DAS ABZEICHEN VERSCHWINDET NIE (04.09.2026, Befund 2 der Inventur).
  //
  // Es war der EINZIGE Weg zum Freigabenblatt, und `hidden = liste.length === 0`
  // nahm ihn weg, sobald nichts mehr wartete. Damit war der ganze Posteingang
  // unerreichbar -- offene Antraege, angehaltene Worker UND der Verlauf der
  // Entscheidungen. Wer nachsehen wollte, was er gestern freigegeben hat,
  // hatte keine Flaeche dafuer.
  //
  // Jetzt steht es immer da und zeigt immer die Zahl: bei null gedaempft und
  // ohne Farbe, ab eins in der Wartefarbe. Das ist dasselbe, was alice am
  // Vorbild unterstrichen hat -- „0 working" steht dort auch dann, wenn nichts
  // laeuft. Ein Element, das nur erscheint, wenn etwas los ist, kann man nicht
  // suchen lernen.
  abzeichenEl.hidden = false;
  abzeichenEl.classList.toggle('leer', liste.length === 0);
  abzeichenEl.querySelector('.zahl')!.textContent = String(liste.length);
  if (!liste.length) return;
  if (freigabeNr >= liste.length) freigabeNr = 0;
  const f = liste[freigabeNr];

  const zeile = document.createElement('div');
  zeile.className = 'fr-zeile';

  const marke = document.createElement('span');
  marke.className = 'fr-marke';
  marke.appendChild(svg('<path d="M8 2.2l5.9 10.3H2.1z"/><path d="M8 6.4v2.8M8 10.9v.1"/>', 15, 1.5));
  zeile.appendChild(marke);

  // EINE ZEILE, OHNE PFAD (05.09.2026, Regelbruch 8). Die Leiste trug den
  // vollen Ordnerpfad des Antrags, umgebrochen auf zwei bis drei Zeilen, und
  // schob beim Eintreffen eines Antrags das ganze Fenster um 50 (breit) bis
  // 67 (schmal) Bildpunkte nach unten. Jetzt steht dort, was der Mensch
  // wirklich entscheiden muss -- wer wartet, worauf --, in einer Zeile mit
  // Auslassungszeichen. Wo genau, sagt das Blatt dahinter.
  const text = document.createElement('div');
  text.className = 'fr-text';
  const wer = document.createElement('b');
  wer.className = 'fr-wer';
  wer.textContent = f.wer;
  const leise = document.createElement('span');
  leise.className = 'leise';
  leise.textContent = ` ${t('freigabe.wartetAufDich')} · ${f.worum}`;
  text.append(wer, leise);
  text.title = `${f.wer} · ${f.wo}\n${f.worum}`;
  zeile.appendChild(text);

  const mehr = document.createElement('button');
  mehr.className = 'fr-mehr';
  // Eine Kennung, damit der Steuerkanal ihn anklicken kann (`awb-ctl klick
  // freigabe-mehr`) -- die Belegbilder zeigen sonst nie, dass die Begruendung
  // aufklappt und freiwillig ist.
  mehr.id = 'freigabe-mehr';
  mehr.setAttribute('aria-expanded', String(begruendungAuf));
  const pfeil = svg('<path d="M5.5 3.5L10.5 8l-5 4.5"/>', 11, 1.6);
  pfeil.classList.add('pfeil');
  mehr.append(pfeil, document.createTextNode(t('freigabe.begruendung')));
  mehr.addEventListener('click', () => { begruendungAuf = !begruendungAuf; zeichneFreigaben(); });
  zeile.appendChild(mehr);

  const knoepfe = document.createElement('div');
  knoepfe.className = 'fr-knoepfe';
  const feld = document.createElement('input');
  feld.type = 'text';
  feld.className = 'fr-grund';
  const ja = document.createElement('button');
  ja.className = 'knopf-voll';
  ja.textContent = t('freigabe.freigeben');
  ja.addEventListener('click', (e) => entscheiden(f, 'approve', feld.value.trim(), e.isTrusted));
  const nein = document.createElement('button');
  nein.className = 'knopf-rand';
  nein.textContent = t('freigabe.ablehnen');
  nein.addEventListener('click', (e) => entscheiden(f, 'reject', feld.value.trim(), e.isTrusted));
  knoepfe.append(ja, nein);
  zeile.appendChild(knoepfe);

  if (liste.length > 1) {
    const blaettern = document.createElement('div');
    blaettern.className = 'fr-blaettern';
    const zurueck = document.createElement('button');
    zurueck.appendChild(svg('<path d="M10 3.5L5.5 8l4.5 4.5"/>', 11, 1.7));
    zurueck.title = t('freigabe.vorige');
    zurueck.addEventListener('click', () => { freigabeNr = (freigabeNr - 1 + liste.length) % liste.length; zeichneFreigaben(); });
    const zaehlung = document.createElement('span');
    zaehlung.className = 'fr-zaehlung';
    zaehlung.textContent = t('freigabe.vonN', { i: freigabeNr + 1, n: liste.length });
    const vor = document.createElement('button');
    vor.appendChild(svg('<path d="M6 3.5L10.5 8 6 12.5"/>', 11, 1.7));
    vor.title = t('freigabe.naechste');
    vor.addEventListener('click', () => { freigabeNr = (freigabeNr + 1) % liste.length; zeichneFreigaben(); });
    blaettern.append(zurueck, zaehlung, vor);
    zeile.appendChild(blaettern);
  }

  if (f.pane) {
    const hin = document.createElement('button');
    hin.className = 'knopf-schlicht';
    hin.title = t('freigabe.hinspringen');
    hin.appendChild(svg('<path d="M6.5 3h6.2v6.2M12.7 3L7 8.7"/><path d="M12.2 10.8v1.7a.9.9 0 01-.9.9H3.8a.9.9 0 01-.9-.9V4.9a.9.9 0 01.9-.9h1.7"/>', 14, 1.4));
    hin.addEventListener('click', () => {
      if (f.sessionId) window.awbBridge.bedienung('select', f.sessionId);
      window.awbBridge.bedienung('show-pane', f.pane);
      uebersichtAn = false;
    });
    zeile.appendChild(hin);
  }

  freigabeleisteEl.appendChild(zeile);

  if (begruendungAuf) {
    const kasten = document.createElement('div');
    kasten.className = 'fr-begruendung';
    feld.placeholder = t('freigabe.begruendungPlatzhalter');
    const hinweis = document.createElement('div');
    hinweis.className = 'fr-hinweis';
    hinweis.textContent = t('freigabe.begruendungHinweis');
    kasten.append(feld, hinweis);
    freigabeleisteEl.appendChild(kasten);
    feld.focus();
  }
}

abzeichenEl.addEventListener('click', () => {
  // DAS BLATT GEHT IMMER AUF -- das besorgt freigaben-view.ts an demselben
  // Knopf (`data-tot="freigaben"`). Hier kommt nur dazu, was es zu springen
  // gibt: wartet wirklich etwas, landet der Klick beim Worker, der wartet.
  // Wartet nichts, bleibt es beim Blatt, und dort steht der Verlauf.
  const liste = offeneFreigaben();
  if (!liste.length) return;
  const f = liste[freigabeNr] ?? liste[0];
  if (f.sessionId) window.awbBridge.bedienung('select', f.sessionId);
  if (f.pane) window.awbBridge.bedienung('show-pane', f.pane);
  uebersichtAn = false;
});

// --- Linke Leiste: Projekte, darunter die Orchestrator ----------------------
function projektOffen(id: string): boolean {
  return baumBeruehrt ? offeneProjekte.has(id) : true;
}

function zeichneBaum(m: Model): void {
  const schmal = schmalLinks(m.ui.sidebarWidth);
  linksEl.classList.toggle('schmal', schmal);
  linksEl.style.width = `${m.ui.sidebarWidth}px`;
  sessionsEl.replaceChildren();

  for (const p of projekte(m)) {
    const wartet = p.zeilen.some((z) => z.art === 'terminal' && sitzungWartet(z.sitzung));
    const kasten = document.createElement('div');
    kasten.className = `projekt${projektOffen(p.id) ? '' : ' zu'}`;

    const kopf = document.createElement('button');
    kopf.className = 'projekt-zeile';
    kopf.title = p.pfad;
    // Die Kennung des Projekts steht am Element: der Steuerkanal liest sie
    // (`uiState`), und das Ziehen eines ganzen Blocks braucht sie waehrend des
    // Zuges, wo `dataTransfer` noch nicht gelesen werden darf.
    kopf.dataset.projekt = p.id;
    const pfeil = svg('<path d="M5.5 3.5L10.5 8l-5 4.5"/>', 11, 1.6);
    pfeil.classList.add('pfeil');
    kopf.appendChild(pfeil);
    kopf.appendChild(zeilensymbol('projekt'));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    kopf.appendChild(name);
    if (wartet) {
      const merker = document.createElement('span');
      merker.className = 'merker';
      merker.title = t('baum.merkerWartet');
      kopf.appendChild(merker);
    }
    const anzahl = document.createElement('span');
    anzahl.className = 'anzahl';
    anzahl.textContent = String(p.zeilen.length);
    kopf.appendChild(anzahl);
    kopf.addEventListener('click', () => {
      if (!baumBeruehrt) {
        // Beim ersten Griff steht fest, was offen war: alles. Von da an fuehrt
        // die Menge Buch, und nur noch sie.
        baumBeruehrt = true;
        for (const q of projekte(m)) offeneProjekte.add(q.id);
      }
      if (offeneProjekte.has(p.id)) offeneProjekte.delete(p.id);
      else offeneProjekte.add(p.id);
      zeichneBaum(m);
    });
    ziehbarProjekt(kopf, p.id, m);
    kasten.appendChild(kopf);

    const kinder = document.createElement('div');
    kinder.className = 'orchestratoren';
    // BEIDE SORTEN IN DERSELBEN LISTE, unter dem Projekt ihres Ordners und in
    // der gemeinsamen Reihenfolge (Befund 5). Wie eine Zeile AUSSIEHT,
    // entscheidet ihre Sorte -- wo sie steht, nicht.
    for (const z of p.zeilen) {
      kinder.appendChild(z.art === 'chat' ? chatZeile(z.chat, m) : orchZeile(z.sitzung, m));
    }
    kasten.appendChild(kinder);
    sessionsEl.appendChild(kasten);
  }

  // KEIN PROJEKT, KEINE SITZUNG, KEIN CHAT -- dann steht hier dieselbe Art
  // Zeile wie auf der Buehne statt einer leeren Spalte. Der Baum kennt nur
  // Projekte, in denen eine Sitzung liegt: die Einstellungen fuehren keine
  // Liste von Projekten, aus der sich ein leeres Projekt zeigen liesse.
  if (!sessionsEl.firstElementChild) {
    const zeile = document.createElement('div');
    zeile.className = 'baum-leer';
    zeile.textContent = t('leer.baum');
    sessionsEl.appendChild(zeile);
  }
}

function orchZeile(s: Session, m: Model): HTMLElement {
  const el = document.createElement('div');
  // GEWAEHLT NUR, WENN AUCH WIRKLICH IHRE KACHELN AUF DER BUEHNE LIEGEN
  // (Befund 6): liegt dort ein Gespraech oder der Worker einer Chat-Sitzung,
  // ist diese Zeile es nicht, auch wenn sie die zuletzt gewaehlte war.
  const gewaehlt = s.id === m.selected && buehneZeigt(m).art === 'terminal';
  // VERLOREN UND GESCHEITERT SIND EIGENE ZUSTAENDE (Befund 9). Ein Start, der
  // scheitert, ist eine Aufforderung; er darf nicht aussehen wie ein sauberes
  // Ende. Beide Klassen stehen wieder an der Zeile, und der Satz dazu steht im
  // Hilfeschildchen -- die Felder lagen im Modell und wurden von keiner Zeile
  // gelesen.
  const merkmale = [
    s.startFehler ? 'startfehler' : '',
    s.verloren ? 'verloren' : '',
    gewaehlt ? 'gewaehlt' : '',
  ].filter(Boolean).join(' ');
  el.className = `eintrag orch-zeile zustand-${s.state}${merkmale ? ` ${merkmale}` : ''}`;
  el.dataset.id = s.id;
  // WELCHEM PROJEKT DIE ZEILE GEHOERT. Der Ordner bestimmt das Projekt, nicht
  // die Reihenfolge (siehe `ziehbarSitzung`): waehrend eines Zuges muss die
  // Zeile unter dem Zeiger sagen koennen, ob sie ueberhaupt ein Ziel ist, und
  // `dataTransfer` gibt das dort nicht her.
  el.dataset.projekt = s.dir || '?';
  el.appendChild(punkt(startfarbe(s)));
  el.appendChild(kuerzelMarke(s.initials || s.name, startfarbe(s)));
  el.appendChild(zeilensymbol('sitzung'));
  // NAME UND ZUSATZZEILE UNTEREINANDER (Befund 8). Ab 200 Bildpunkten
  // Leistenbreite steht unter dem Namen, auf welcher Maschine die Sitzung
  // laeuft und wie viele Worker sie hat -- beim Start stattdessen der Satz
  // dazu. Die Schluessel dafuer standen unveraendert in texte.ts und wurden von
  // keiner Zeile mehr abgerufen.
  const leib = document.createElement('span');
  leib.className = 'zeilenleib';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  leib.appendChild(name);
  const zusatz = zusatzzeile(s, m);
  if (zusatz) {
    const unten = document.createElement('span');
    unten.className = 'zusatz';
    unten.textContent = zusatz;
    leib.appendChild(unten);
    el.classList.add('zweizeilig');
  }
  el.appendChild(leib);
  // DIE MASCHINE STEHT NUR DA, WENN SIE NICHT DIE EIGENE IST -- und nur dann,
  // wenn die Zusatzzeile sie nicht ohnehin schon nennt. Der Normalfall ist die
  // hiesige, und ein Hostname, der an jeder Zeile klebt, verdraengt in einer
  // schmalen Leiste genau das, wofuer sie da ist.
  if (s.machine && s.machine !== m.machine && !zusatz) {
    const maschine = document.createElement('span');
    maschine.className = 'maschine';
    maschine.textContent = s.machine;
    el.appendChild(maschine);
  }
  el.title = [
    `${s.name} · ${s.machine} · ${s.dir}`,
    s.startFehler ? t('sitzung.startFehler') : '',
    s.verloren ? t('sitzung.verloren') : '',
  ].filter(Boolean).join('\n');
  el.addEventListener('click', () => window.awbBridge.bedienung('select', s.id));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.awbBridge.sitzungsMenue(s.id, e.isTrusted);
  });
  // V14: der Knopf einer wirklich toten Sitzung -- klein und gedaempft. Eine
  // Sitzung, die gerade startet, bekommt ihn nicht: da laeuft schon etwas.
  if (s.state === 'stopped' && !s.startet) {
    const wieder = document.createElement('button');
    wieder.className = 'wieder';
    // Eine Kennung, damit `awb-ctl klick` die Frage auch AUFmachen kann und
    // nicht nur beantworten (`wieder-ja`, `wieder-nein`). Ohne sie liesse sich
    // die Rueckfrage kopflos nicht ansehen.
    wieder.id = `wieder-${s.id}`;
    wieder.title = s.revive?.reason ?? t('sitzung.wiederherstellen');
    wieder.appendChild(svg('<path d="M13 8a5 5 0 11-1.6-3.7"/><path d="M13.2 2.6v2.9h-2.9"/>', 12, 1.4));
    wieder.addEventListener('click', (e) => {
      e.stopPropagation();
      wiederFrage = wiederFrage === s.id ? '' : s.id;
      zeichneBaum(m);
    });
    el.appendChild(wieder);
  }
  ziehbarZeile(el, s.id, m);
  // Die Zeile und ihre Rueckfrage stehen zusammen in einem Kasten: die Frage
  // gehoert unter GENAU diese Sitzung und nicht irgendwo ins Fenster.
  if (s.state === 'stopped' && !s.startet && wiederFrage === s.id) {
    const kasten = document.createElement('div');
    kasten.className = 'orch-eintrag';
    kasten.append(el, wiederFrageKasten(s));
    return kasten;
  }
  return el;
}

/**
 * DIE RUECKFRAGE VOR DEM WIEDERBELEBEN (03.09.2026, Prueferbefund 3).
 *
 * Sie war eine Sicherung, die beim Neubau still weggefallen ist: die alte
 * Oberflaeche zeigte vor `revive` ein `window.confirm` mit Ordner, Harness,
 * Modell und der Auskunft, ob das Gespraech fortgesetzt oder neu begonnen wird.
 * Der neue Knopf rief unmittelbar auf, und die Auskunft stand nur noch im
 * Hilfeschildchen.
 *
 * KEIN `window.confirm`: das ist ein Systemdialog, der das ganze Fenster
 * anhaelt und in einer Oberflaeche, die sonst nichts davon benutzt, fremd
 * aussieht. Die Frage steht stattdessen unter der Zeile, zu der sie gehoert,
 * und geht mit ihrer Antwort wieder zu.
 *
 * DER SATZ ZUR FORTSETZUNG kommt aus dem Hauptprozess, aus derselben Funktion,
 * die den Aufruf baut (main.ts, `revive`-Vorschau). Der Rueckfall gilt fuer den
 * Fall, dass die Vorschau fehlt; er kannte bis zum 06.08. nur einen Harness und
 * behauptete eine Fortsetzung auch fuer eine Sitzung, die mit pi oder codex
 * lief -- deshalb steht die Vorschau vorn.
 */
function wiederFrageKasten(s: Session): HTMLElement {
  const kasten = document.createElement('div');
  kasten.className = 'wieder-frage';
  const frage = document.createElement('div');
  frage.className = 'wieder-titel';
  frage.textContent = t('sitzung.wiederherstellen.frage', { name: s.name, maschine: s.machine });
  kasten.appendChild(frage);

  const zeile = (was: string, wert: string, fest = false): void => {
    if (!wert) return;
    const z = document.createElement('div');
    z.className = 'wieder-zeile';
    const k = document.createElement('span');
    k.className = 'wieder-was';
    k.textContent = was;
    const v = document.createElement('span');
    v.className = fest ? 'wieder-wert fest' : 'wieder-wert';
    v.textContent = wert;
    z.append(k, v);
    kasten.appendChild(z);
  };
  zeile(t('sitzung.wiederherstellen.ordner'), s.dir, true);
  zeile(t('sitzung.wiederherstellen.harness'), [s.harness, s.model].filter(Boolean).join(' · '), true);

  const fortsetzung = document.createElement('div');
  fortsetzung.className = 'wieder-satz';
  fortsetzung.textContent = s.revive?.reason
    ?? (s.claudeSessionId
      ? t('sitzung.fortsetzen', { id: `${s.claudeSessionId.slice(0, 8)}…` })
      : t('sitzung.neuStart'));
  kasten.appendChild(fortsetzung);

  const knoepfe = document.createElement('div');
  knoepfe.className = 'wieder-knoepfe';
  const ja = document.createElement('button');
  ja.className = 'knopf-voll';
  ja.id = 'wieder-ja';
  ja.textContent = t('sitzung.wiederherstellen.jetzt');
  ja.addEventListener('click', (e) => {
    e.stopPropagation();
    wiederFrage = '';
    window.awbBridge.bedienung('revive', s.id);
    if (modell) zeichneBaum(modell);
  });
  const nein = document.createElement('button');
  nein.className = 'knopf-rand';
  nein.id = 'wieder-nein';
  nein.textContent = t('wort.abbrechen');
  nein.addEventListener('click', (e) => {
    e.stopPropagation();
    wiederFrage = '';
    if (modell) zeichneBaum(modell);
  });
  knoepfe.append(ja, nein);
  kasten.appendChild(knoepfe);
  return kasten;
}

function chatZeile(c: Chat, m: Model): HTMLElement {
  const el = document.createElement('div');
  // GEWAEHLT, wenn ihr Gespraech ODER einer ihrer Worker auf der Buehne liegt
  // (Befund 6): beides ist diese Sitzung, und in beiden Faellen beschreibt
  // keine Terminal-Zeile, was zu sehen ist.
  const b = buehneZeigt(m);
  const gewaehlt = b.chatId === c.id;
  el.className = `eintrag orch-zeile chat${c.laeuft ? ' laeuft' : ''}${gewaehlt ? ' gewaehlt' : ''}`;
  el.dataset.id = c.id;
  // Auch eine Chat-Sitzung gehoert ihrem Ordner und wird darin gezogen.
  el.dataset.projekt = c.ordner || '?';
  const farbe = c.laeuft ? 'laeuft' : 'ruhig';
  el.appendChild(punkt(farbe));
  el.appendChild(kuerzelMarke(c.name, farbe));
  el.appendChild(zeilensymbol('chat'));
  const leib = document.createElement('span');
  leib.className = 'zeilenleib';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = c.name;
  leib.appendChild(name);
  // Dieselbe Zusatzzeile wie an einer Terminal-Sitzung, mit dem, was eine
  // Chat-Sitzung davon hat: ihre Worker.
  if (m.ui.sidebarWidth >= ZUSATZ_AB) {
    const unten = document.createElement('span');
    unten.className = 'zusatz';
    // Ohne Maschine: ein Gespraech laeuft immer hier (05.09.2026,
    // Electron-Befund 3).
    unten.textContent = t('sitzung.workerZahl', {
      n: (c.worker ?? []).filter((w) => w.laeuft).length,
    });
    leib.appendChild(unten);
    el.classList.add('zweizeilig');
  }
  el.appendChild(leib);
  el.title = `${c.name} · ${c.ordner}`;
  el.addEventListener('click', () => window.awbBridge.bedienung('chat-zeigen', c.id));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.awbBridge.sitzungsMenue(c.id, e.isTrusted);
  });
  ziehbarZeile(el, c.id, m);
  return el;
}

/**
 * ZIEHEN IN ZWEI EBENEN (04.09.2026, alice: „ich will sitzungen in projekten
 * ziehen können und projekte unter sich").
 *
 * WAS VORHER KAPUTT WAR, UND ZWAR UNSICHTBAR. `ziehbar()` setzte die FLACHE
 * Reihenfolge ueber `bedienung('order', …)`, und `projekte()` gruppierte
 * unmittelbar danach wieder nach Ordner. Wer eine Sitzung auf ein fremdes
 * Projekt zog, sah sie an ihren alten Platz zurueckspringen: die flache Liste
 * hatte sich geaendert, die Gruppierung hatte die Aenderung eingeebnet. Es gab
 * keine Fehlermeldung, weil nichts fehlgeschlagen war -- es waren zwei
 * Ordnungen, die einander widersprachen.
 *
 * DIE FLACHE LISTE BLEIBT DAS DATENMODELL (so steht es schon im Kommentar von
 * `projekte()`: ein Projekt steht dort, wo seine erste Sitzung steht). Neu ist,
 * dass beide Zuege sie so umbauen, dass die Gruppierung sie nicht mehr
 * zunichtemachen KANN: geschrieben wird immer die Verkettung ganzer
 * Projektbloecke, nie eine Liste, in der zwei Sitzungen eines Projekts durch
 * eine fremde getrennt waeren. Was danach gruppiert wird, kommt genauso wieder
 * heraus.
 *
 * WAS WAEHREND DES ZUGES BEKANNT SEIN MUSS: ob die Zeile unter dem Zeiger
 * ueberhaupt ein Ziel ist. `dataTransfer` gibt seinen Inhalt in `dragover`
 * nicht her (das ist die Schutzregel des Browsers), deshalb merkt sich diese
 * eine Variable, was gerade gezogen wird. Sie lebt genau so lange wie der Zug.
 */
type Zug =
  | { art: 'zeile'; id: string; projekt: string }
  | { art: 'projekt'; id: string };

let zug: Zug | null = null;

/**
 * Aus Projektbloecken wieder eine flache Liste. Die Bloecke stehen darin
 * VOLLSTAENDIG hintereinander -- das ist die Zusage, an der das Zurueckspringen
 * scheitert. Chat- und Terminal-Sitzungen stehen darin gemischt, so wie im
 * Baum: sie gehoeren beide ihrem Ordner (Befund 5).
 */
function flacheReihenfolge(bloecke: Projektknoten[]): string[] {
  return bloecke.flatMap((b) => b.zeilen.map((z) => z.id));
}

/**
 * Eine Zeile an eine andere Stelle IHRES Projekts -- gleich welcher Sorte. Ein
 * Zug auf ein fremdes Projekt wird gar nicht erst angenommen: der Ordner
 * bestimmt das Projekt, nicht die Reihenfolge.
 */
function zeileVerschieben(m: Model, gezogen: string, ziel: string): void {
  const bloecke = projekte(m);
  const block = bloecke.find((b) => b.zeilen.some((z) => z.id === gezogen));
  if (!block || !block.zeilen.some((z) => z.id === ziel)) return;
  const gezogeneZeile = block.zeilen.find((z) => z.id === gezogen);
  const ohne = block.zeilen.filter((z) => z.id !== gezogen);
  const stelle = ohne.findIndex((z) => z.id === ziel);
  if (stelle < 0 || !gezogeneZeile) return;
  ohne.splice(stelle, 0, gezogeneZeile);
  block.zeilen = ohne;
  window.awbBridge.bedienung('order', flacheReihenfolge(bloecke));
}

/**
 * Ein ganzer Projektblock ueber oder unter ein anderes Projekt.
 *
 * ZWEI LISTEN, WEIL ES ZWEI FRAGEN SIND (08.09.2026). Bis heute schrieb dieser
 * Zug nur die flache `order`, und das Projekt stand danach dort, wo seine
 * erste Zeile stand. Seit die Mac-Fassung Projekte ebenfalls ziehen kann, hat
 * der Kern dafuer einen eigenen Schluessel (`projektReihenfolge`, uistate.ts),
 * und er stellt die Bloecke damit selbst -- er wuerde einen Zug, der nur
 * `order` schreibt, beim naechsten Zeichnen wieder ueberstimmen. Also sagt
 * dieser Zug beides: die Zeilen in ihrer Folge und die Ordner in ihrer.
 */
function projektVerschieben(m: Model, gezogen: string, ziel: string): void {
  const bloecke = projekte(m);
  const von = bloecke.findIndex((b) => b.id === gezogen);
  if (von < 0 || !bloecke.some((b) => b.id === ziel)) return;
  const [block] = bloecke.splice(von, 1);
  const nach = bloecke.findIndex((b) => b.id === ziel);
  if (nach < 0) return;
  bloecke.splice(nach, 0, block);
  window.awbBridge.bedienung('projekt-order', bloecke.map((b) => b.id));
  window.awbBridge.bedienung('order', flacheReihenfolge(bloecke));
}

/**
 * Der gemeinsame Teil aller drei Zuege: anfassen, die Zielmarke zeigen ODER
 * eben nicht, loslassen. `nimmtAn` entscheidet, ob diese Zeile fuer den
 * laufenden Zug ueberhaupt ein Ziel ist -- sagt sie nein, wird das Ereignis
 * nicht angenommen, und damit erscheint auch keine Zielmarke. Genau daran
 * sieht ein Mensch, dass der Zug hier nichts zu suchen hat.
 */
function ziehbarGrundform(
  zeile: HTMLElement,
  beginn: () => Zug,
  nimmtAn: (laufend: Zug) => boolean,
  ablegen: (laufend: Zug) => void,
): void {
  zeile.draggable = true;
  zeile.addEventListener('dragstart', (e) => {
    zug = beginn();
    zeile.classList.add('zieht');
    e.dataTransfer?.setData('text/plain', zug.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  zeile.addEventListener('dragend', () => {
    zug = null;
    zeile.classList.remove('zieht');
  });
  zeile.addEventListener('dragover', (e) => {
    if (!zug || !nimmtAn(zug)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    zeile.classList.add('ziel');
  });
  zeile.addEventListener('dragleave', () => zeile.classList.remove('ziel'));
  zeile.addEventListener('drop', (e) => {
    zeile.classList.remove('ziel');
    if (!zug || !nimmtAn(zug)) return;
    e.preventDefault();
    ablegen(zug);
    zug = null;
  });
}

function ziehbarZeile(zeile: HTMLElement, id: string, m: Model): void {
  const projekt = zeile.dataset.projekt ?? '';
  ziehbarGrundform(
    zeile,
    () => ({ art: 'zeile', id, projekt }),
    (l) => l.art === 'zeile' && l.id !== id && l.projekt === projekt,
    (l) => zeileVerschieben(m, l.id, id),
  );
}

function ziehbarProjekt(zeile: HTMLElement, id: string, m: Model): void {
  ziehbarGrundform(
    zeile,
    () => ({ art: 'projekt', id }),
    (l) => l.art === 'projekt' && l.id !== id,
    (l) => projektVerschieben(m, l.id, id),
  );
}



// --- Tab-Leiste und die drei Ansichten --------------------------------------
/**
 * Die Reihenfolge, in der die Worker in den Panes liegen: jeder obere,
 * unmittelbar gefolgt von dem, was auf seinen Antrag entstanden ist. Ein
 * Kind-Worker hat einen EIGENEN Pane und belegt deshalb einen Platz im Gitter
 * -- die Tabs muessen ihn also mitzaehlen, sonst weicht die Zahl der Marken von
 * der Kapazitaetsrechnung ab.
 */
function flacheWorker(s: Session): Worker[] {
  const lebende = s.workers.filter((w) => w.alive);
  const namen = new Set(lebende.map((w) => w.name));
  const kinderVon = (name: string): Worker[] => lebende.filter((w) => w.requestedBy === name && namen.has(w.requestedBy));
  const obere = lebende.filter((w) => !w.requestedBy || !namen.has(w.requestedBy));
  return obere.flatMap((w) => [w, ...kinderVon(w.name)]);
}

function workerImTab(s: Session, m: Model, i: number): Worker[] {
  const flach = flacheWorker(s);
  return flach.slice(i * m.capacity.perTab, (i + 1) * m.capacity.perTab);
}

/** Die Farbe eines Tabs: die dringendste seiner Panes. */
function tabFarbe(ws: Worker[]): string {
  if (ws.some((w) => w.state === 'blocked' || w.state === 'stalled')) return 'will';
  if (ws.some((w) => w.state === 'running')) return 'laeuft';
  if (ws.some((w) => w.state === 'unknown')) return 'fern';
  return 'ruhig';
}

/** Welche der drei Ansichten gerade gilt. */
function lageJetzt(): 'uebersicht' | 'gekachelt' | 'gezoomt' {
  if (uebersichtAn) return 'uebersicht';
  return auskunft.ansicht.startsWith('Tab') ? 'gekachelt' : 'gezoomt';
}

function tabZeigen(m: Model, s: Session, i: number): void {
  window.awbBridge.bedienung('worker-tab', i);
  const panes = workerImTab(s, m, i).map((w) => w.paneId).filter(Boolean);
  if (panes.length) window.awbBridge.bedienung('show-tab', panes);
}

// --- Der Inhaltskopf --------------------------------------------------------
/**
 * DAS FEHLENDE STUECK (04.09.2026). Oben in der Inhaltskarte steht seither,
 * WORAN gearbeitet wird und WAS die Flaeche zeigt -- die Hierarchie, die im
 * Vorbild „Cold outreach operator / Powered by Claude Code" traegt: der Name
 * gross, die Herkunft klein darunter.
 *
 * Links der Sitzungsname in 17 Punkt halbfett, darunter in 11,5 Punkt
 * gedaempft Harness, Modell und Ordner. Was die Bruecke nicht kennt, steht
 * nicht da; erfunden wird nichts.
 *
 * Rechts, in dieser Reihenfolge: die Statuspille mit der Zahl laufender Worker
 * DIESER Sitzung (bei null gedaempft, ab eins mit gefaerbtem Punkt), der
 * Umschalter zwischen Orchestrator und Worker, das Zahnrad der Sitzung.
 */
function laufendeWorker(s: Session): number {
  return s.workers.filter((w) => w.alive && (w.state === 'running' || w.state === 'blocked' || w.state === 'stalled')).length;
}

function zeichneInhaltskopf(m: Model): void {
  // AUCH DER INHALTSKOPF BESCHREIBT DIE BUEHNE (Befund 6). Eine Chat-Sitzung
  // hat weder Orchestrator-Pane noch Worker-Tabs -- der Umschalter und das
  // Zahnrad haetten dort nichts zu schalten und stehen deshalb nicht da.
  const b = buehneZeigt(m);
  if (b.art !== 'terminal') {
    const c = (m.chats ?? []).find((x) => x.id === b.chatId);
    if (c) {
      inhaltskopfEl.classList.remove('leer');
      inhaltskopfEl.classList.add('gespraech');
      ikNameEl.textContent = c.name;
      ikNameEl.title = c.name;
      ikHerkunftEl.textContent = kurzerPfad(c.ordner);
      ikHerkunftEl.title = c.ordner;
      const laufend = (c.worker ?? []).filter((w) => w.laeuft).length;
      ikWorkerEl.classList.toggle('aktiv', laufend > 0);
      const p = ikWorkerEl.querySelector('.punkt');
      if (p) p.className = `punkt ${laufend > 0 ? 'laeuft' : 'ruhig'}`;
      const z = ikWorkerEl.querySelector('.zahl');
      if (z) z.textContent = t('flaeche.workerLaufen', { n: laufend });
      sitzungskarteZu();
      return;
    }
  }
  inhaltskopfEl.classList.remove('gespraech');
  const s = m.sessions.find((x) => x.id === m.selected);
  // OHNE SITZUNG GIBT ES KEINEN KOPF. Ein Kopf, der nichts benennt, waere ein
  // leerer Streifen -- genau der Fehler, gegen den der Neubau steht. Die
  // Buehne sagt in dem Fall selbst, was zu tun ist (`#leer`).
  inhaltskopfEl.classList.toggle('leer', !s);
  if (!s) {
    ikNameEl.textContent = '';
    ikHerkunftEl.textContent = '';
    sitzungskarteZu();
    return;
  }
  ikNameEl.textContent = s.name;
  ikNameEl.title = s.name;
  // Harness, Modellkennung, Ordner -- getrennt durch denselben Mittelpunkt,
  // den auch die Titelleiste benutzt. Leere Angaben fallen weg statt als
  // Luecke stehenzubleiben.
  const herkunft = [s.harness ?? '', s.model ?? '', kurzerPfad(s.dir)].filter(Boolean);
  ikHerkunftEl.textContent = herkunft.join(' · ');
  ikHerkunftEl.title = s.dir;

  const laufend = laufendeWorker(s);
  ikWorkerEl.classList.toggle('aktiv', laufend > 0);
  const pkt = ikWorkerEl.querySelector('.punkt');
  if (pkt) pkt.className = `punkt ${laufend > 0 ? 'laeuft' : 'ruhig'}`;
  const zahl = ikWorkerEl.querySelector('.zahl');
  if (zahl) zahl.textContent = t('flaeche.workerLaufen', { n: laufend });
  ikWorkerEl.title = t('flaeche.workerLaufen.tipp');

  const modus = flaechenmodus(m);
  // ORCHESTRATOR | WORKER WIRD GRAU, NICHT UNSICHTBAR, solange der Tab Agents
  // steht (08.09.2026): er ordnet die Code-Buehne, und die liegt dann nicht
  // vorn. Ausblenden haette den Kopf bei jedem Umschalten umgebaut und Pille
  // und Zahnrad springen lassen -- dieselbe Entscheidung wie in der Mac-Fassung.
  const agents = buehnenmodus !== 'code';
  for (const b of ikModusEl.querySelectorAll<HTMLButtonElement>('[data-flaeche]')) {
    const an = !agents && b.dataset.flaeche === modus;
    b.classList.toggle('gewaehlt', an);
    b.setAttribute('aria-selected', String(an));
    b.disabled = agents;
  }
  ikModusEl.classList.toggle('aus', agents);
}

// DER UMSCHALTER CODE | AGENTS IN DER TITELLEISTE (08.09.2026). Im Modulraum,
// wie die Verdrahtung des Umschalters darunter: einmal beim Laden, nicht bei
// jedem Zeichnen -- sonst haengt an jedem Knopf nach einer Minute ein Dutzend
// Behandler, und der Zustand wird bei jedem Takt ueberschrieben.
for (const b of modiEl.querySelectorAll<HTMLButtonElement>('[data-modus]')) {
  const an = b.dataset.modus === 'code';
  b.classList.toggle('gewaehlt', an);
  b.setAttribute('aria-selected', String(an));
  b.addEventListener('click', () => modusSetzen(b.dataset.modus === 'agents' ? 'agents' : 'code'));
}

/** Den Umschalter bedienen: die Wahl merken und die Flaeche danach richten. */
function flaechenmodusSetzen(m: Model, modus: Flaechenmodus): void {
  const s = m.sessions.find((x) => x.id === m.selected);
  if (!s) return;
  window.awbBridge.bedienung('flaeche-modus', { id: s.id, modus });
  if (modus === 'orchestrator') {
    // Der Orchestrator FUELLT die Flaeche -- es gibt nichts zu kacheln.
    uebersichtAn = false;
    if (s.orchestratorPane) window.awbBridge.bedienung('show-pane', s.orchestratorPane);
  } else {
    tabZeigen(m, s, Math.min(m.ui.workerTab, Math.max(0, m.capacity.tabs - 1)));
  }
}

for (const b of ikModusEl.querySelectorAll<HTMLButtonElement>('[data-flaeche]')) {
  b.addEventListener('click', () => {
    if (modell) flaechenmodusSetzen(modell, b.dataset.flaeche === 'orchestrator' ? 'orchestrator' : 'worker');
  });
}

// --- Die Sitzungskarte hinter dem Zahnrad -----------------------------------
/**
 * WAS SIE IST (04.09.2026). Alles, was eine Sitzung ausmacht, an EINER Stelle
 * und an Ort und Stelle: als Blatt unter dem Zahnrad, aus dem sie kommt. Bis
 * heute steckte das im Rechtsklickmenue der Zeile links -- ein Ort, an dem
 * niemand danach sucht.
 *
 * KEIN NEUER KANAL. Der Name geht ueber `awbBridge.umbenennen` hinaus, denselben
 * Weg, den die Namensabfrage seit jeher nimmt; „Ordner oeffnen" und
 * „Fortsetzen" ueber dieselben Bedienungen wie an der Zeile. Die Bruecke
 * (preload.ts) bleibt unveraendert.
 *
 * WAS HIER NICHT STEHT UND WARUM: Denkstufe und Kontextstufe. Beide gibt es im
 * Sessionmodell nicht -- die Zustandsdatei einer Sitzung fuehrt `harness` und
 * `model`, mehr nicht (main/sessions.ts). Eine Zeile dafuer waere eine
 * erfundene Angabe, und die ist schlimmer als eine fehlende.
 */
function sitzungskarteZu(): void {
  sitzungskarteAuf = false;
  skEl.classList.remove('sichtbar');
  ikZahnradEl.setAttribute('aria-expanded', 'false');
}

function sitzungskarteZeichnen(m: Model): void {
  const s = m.sessions.find((x) => x.id === m.selected);
  if (!s) { sitzungskarteZu(); return; }
  skNameEl.value = s.name;
  skListeEl.replaceChildren();
  const zeile = (was: string, wert: string, fest = false): void => {
    if (!wert) return;
    const dt = document.createElement('dt');
    dt.textContent = was;
    const dd = document.createElement('dd');
    dd.className = fest ? 'fest' : '';
    dd.textContent = wert;
    skListeEl.append(dt, dd);
  };
  zeile(t('sitzungskarte.harness'), s.harness ?? '', true);
  zeile(t('sitzungskarte.modell'), s.model ?? '', true);
  zeile(t('sitzungskarte.maschine'), s.machine);
  zeile(t('sitzungskarte.ordner'), s.dir, true);

  skKnoepfeEl.replaceChildren();
  const knopf = (text: string, klasse: string, tun: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = klasse;
    b.textContent = text;
    b.addEventListener('click', tun);
    skKnoepfeEl.appendChild(b);
  };
  // Fortsetzen gibt es nur an einer wirklich beendeten Sitzung -- an einer
  // laufenden gibt es nichts fortzusetzen.
  if (s.state === 'stopped' && !s.startet) {
    knopf(t('sitzung.wiederherstellen.jetzt'), 'knopf-voll', () => {
      window.awbBridge.bedienung('revive', s.id);
      sitzungskarteZu();
    });
  }
  knopf(t('sitzungskarte.ordnerOeffnen'), 'knopf-rand', () => {
    window.awbBridge.bedienung('ordner-oeffnen', s.dir);
  });
}

// --- Die Worker-Liste hinter der Pille --------------------------------------
/**
 * BEFUND 11 DER INVENTUR, und die Antwort darauf steht dort, wo die Frage
 * entsteht.
 *
 * Die Worker-Liste kostet seit dem Neubau die Buehne: sie steht in der
 * Uebersicht, und die Uebersicht ERSETZT das Terminalbild, statt daneben zu
 * stehen. Das war eine bewusste Entscheidung und bleibt -- aber „wo sehe ich
 * meine Worker, ohne die Panes aufzugeben" braucht trotzdem eine Antwort.
 *
 * Sie liegt hinter der Zahl, die ohnehin schon dasteht: ein Klick auf die
 * Pille „N laufen" klappt die Liste als Blatt ueber der Flaeche auf -- je
 * Worker Zustand, Name, Modell, Tokenstand und Herkunft, ein Klick springt in
 * seinen Pane. Sie nimmt der Buehne nichts weg und geht mit dem naechsten
 * Klick wieder zu.
 */
let workerlisteAuf = false;

function workerlisteZu(): void {
  workerlisteAuf = false;
  workerlisteEl.classList.remove('sichtbar');
  ikWorkerEl.setAttribute('aria-expanded', 'false');
}

function workerlisteZeichnen(m: Model): void {
  const s = m.sessions.find((x) => x.id === m.selected);
  if (!s) { workerlisteZu(); return; }
  workerlisteEl.replaceChildren();
  const lebende = flacheWorker(s);
  const namen = new Set(lebende.map((w) => w.name));
  const kinderZahl = new Map<string, number>();
  for (const w of lebende) {
    if (w.requestedBy && namen.has(w.requestedBy)) {
      kinderZahl.set(w.requestedBy, (kinderZahl.get(w.requestedBy) ?? 0) + 1);
    }
  }
  if (!lebende.length) {
    const leer = document.createElement('div');
    leer.className = 'wl-leer';
    leer.textContent = t('uebersicht.leer');
    workerlisteEl.appendChild(leer);
    return;
  }
  // In welchem Tab ein Worker liegt, entscheidet die Kapazitaet -- ein Klick
  // soll auf demselben Tab landen, auf dem der Pane wirklich liegt.
  const proTab = Math.max(1, m.capacity.perTab);
  // WOHER DER WORKER KOMMT (05.09.2026, Gestalt-Auftrag vom 04.09.): die
  // Maschine, wenn es nicht diese hier ist -- die Liste hat keinen Kopf, der
  // sie sonst nennen wuerde --, und der Antragsteller, wenn er auf Antrag
  // laeuft. Beides als Wort in der Unterzeile, in derselben Farbe wie sie.
  const fremd = Boolean(s.machine) && s.machine !== m.machine ? s.machine : '';
  lebende.forEach((w, n) => {
    const kind = !!w.requestedBy && namen.has(w.requestedBy);
    const eigene = kinderZahl.get(w.name) ?? 0;
    workerlisteEl.appendChild(workerZeile({
      klasse: `worker zustand-${w.state}${kind ? ' kind' : ''}`,
      farbe: zustandFarbe(w.state),
      name: w.name,
      marke: eigene ? `+${eigene}` : '',
      neben: w.model,
      herkunft: [fremd, kind ? t('worker.aufAntrag', { name: w.requestedBy }) : ''].filter(Boolean).join(' · '),
      unten: w.titel || zustandText(w),
      tokens: tokenKurz(w),
      pane: w.paneId,
      tab: Math.floor(n / proTab),
    }));
  });
}

ikWorkerEl.addEventListener('click', () => {
  if (workerlisteAuf) { workerlisteZu(); return; }
  if (!modell?.sessions.some((x) => x.id === modell?.selected)) return;
  sitzungskarteZu();
  workerlisteAuf = true;
  workerlisteEl.classList.add('sichtbar');
  ikWorkerEl.setAttribute('aria-expanded', 'true');
  workerlisteZeichnen(modell);
});

ikZahnradEl.addEventListener('click', () => {
  if (sitzungskarteAuf) { sitzungskarteZu(); return; }
  if (!modell?.sessions.some((x) => x.id === modell?.selected)) return;
  workerlisteZu();
  sitzungskarteAuf = true;
  skEl.classList.add('sichtbar');
  ikZahnradEl.setAttribute('aria-expanded', 'true');
  sitzungskarteZeichnen(modell);
  skNameEl.focus();
  skNameEl.select();
});

(document.getElementById('sk-zu') as HTMLButtonElement).addEventListener('click', () => sitzungskarteZu());

function sitzungsnameUebernehmen(): void {
  const s = modell?.sessions.find((x) => x.id === modell?.selected);
  const name = skNameEl.value.trim();
  if (!s || !name || name === s.name) { sitzungskarteZu(); return; }
  void window.awbBridge.umbenennen(s.id, name);
  sitzungskarteZu();
}

(document.getElementById('sk-name-ok') as HTMLButtonElement).addEventListener('click', sitzungsnameUebernehmen);
skNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sitzungsnameUebernehmen();
  if (e.key === 'Escape') sitzungskarteZu();
});

function zeichneStreifen(m: Model): void {
  tabsEl.replaceChildren();
  const s = m.sessions.find((x) => x.id === m.selected);
  const lage = lageJetzt();
  // DER STREIFEN STEHT NUR DA, WENN ER ETWAS ZU SCHALTEN HAT (05.09.2026,
  // Beanstandung des Nutzers am Belegbild `ObenLeiste.png`): wenigstens ein
  // Worker-Pane muss auf der Buehne liegen. Der Orchestrator fuellt die Flaeche
  // allein, und eine Sitzung ohne Worker hat nichts zu kacheln -- in beiden
  // Faellen ist der Kopf genau eine Zeile hoch, in JEDER Sitzung dieselbe.
  //
  // GEMESSEN WIRD DIE BUEHNE, nicht die gemerkte Wahl. Bis heute hing der
  // Streifen an `gemerkterModus`, und der Grund dafuer war die Stabilitaet des
  // Aufbaus: der Streifen ist 34 Bildpunkte hoch, und wenn er auf jede
  // Lage-Meldung hin kommen und gehen kann, springt die Buehne darunter um
  // diese 34 Punkte -- am 04.09. wichen Belegbild und Lagemeldung um genau eine
  // Streifenhoehe voneinander ab. Der Sprung kam aber nicht daher, dass der
  // Streifen der Buehne folgt, sondern daher, dass die Kacheln danach in der
  // alten Hoehe stehenblieben. Das ist unten behoben: aendert sich die
  // Anwesenheit des Streifens, wird die Flaeche sofort neu vermessen und
  // gezeichnet (`paneflaecheNachziehen`) -- derselbe Handgriff, den auch ein
  // auf- oder zugehendes Blatt ausloest.
  //
  // Was der Umschalter HERVORHEBT, folgt derselben Quelle (`flaechenmodus`):
  // beide zeigen, was zu sehen ist.
  const streifenVerborgen = !workerAufDerBuehne(m) || buehneZeigt(m).art !== 'terminal';
  if (streifenVerborgen !== tabstreifenEl.hidden) {
    tabstreifenEl.hidden = streifenVerborgen;
    // ERST DEN STAND SETZEN, DANN NACHZIEHEN: `paneflaecheNachziehen` zeichnet
    // die letzte Lage neu, ohne die Lage-Meldung noch einmal auszuloesen -- es
    // entsteht also keine Schleife, und beim naechsten Zeichnen steht der
    // Streifen schon richtig.
    paneflaecheNachziehen();
  }
  // OHNE SITZUNG STEHT DER SCHALTER AUF NICHTS (03.09.2026, dritter Durchgang).
  // Vorher zeigte er „Gezoomt" als gewaehlt, weil `lageJetzt()` auf die
  // Auskunft der Flaeche sieht und die ohne Pane „ein Pane" meldet. Gewaehlt
  // heisst aber: das siehst Du gerade. Zu sehen ist nichts, also ist keiner der
  // drei gewaehlt und keiner bedienbar -- ein Schalter, der nichts schalten
  // kann, gehoert abgeschaltet und nicht falsch beschriftet.
  // DER SCHALTER ZEIGT KEINEN ZUSTAND, DEN MAN GERADE NICHT SIEHT (Befund 6).
  // Liegt ein Gespraech auf der Buehne, gilt keine der drei Ansichten -- er
  // stand bis heute auf „Gezoomt" und beschrieb damit die Kacheln einer
  // Sitzung, die verdeckt war.
  const kacheln = !!s && buehnenmodus === 'code' && buehneZeigt(m).art === 'terminal';
  for (const b of lageEl.querySelectorAll<HTMLButtonElement>('[data-lage]')) {
    const an = kacheln && b.dataset.lage === lage;
    b.classList.toggle('gewaehlt', an);
    b.setAttribute('aria-selected', String(an));
    b.disabled = !kacheln;
  }
  lageEl.classList.toggle('aus', !kacheln);
  // Die Buehne sagt selbst, dass sie leer ist -- eine schwarze Flaeche ohne ein
  // Wort war der erste Blick auf ein frisches Programm.
  leerEl.classList.toggle('an', !s);
  // Der Ordnen-Knopf ordnet KACHELN -- in den beiden anderen Ansichten gibt es
  // nichts zu ordnen, also ist er dort nicht da.
  ordnenEl.hidden = lage !== 'gekachelt' || !m.mayArrange || !s;
  if (!s) return;

  const tabs = Math.max(1, m.capacity.tabs);
  const gewaehlt = Math.min(m.ui.workerTab, tabs - 1);
  // ERST AB ZWEI TABS (05.09.2026, Electron-Befund 6). Bei einem einzigen Tab
  // stand dort „● Tab 1 4" -- ein Etikett fuer eine Auswahl, die es nicht gibt.
  // Was der Streifen sonst noch traegt (der Dreifachschalter, „Ordnen"), bleibt
  // stehen: der wechselt die Ansicht und hat auch mit einem Tab zu tun.
  // Die Zahl der Tabs selbst aendert sich dadurch NICHT -- sie steht im
  // Kapazitaetsblock (`capacity.tabs`), und die Buehne rechnet unveraendert
  // damit.
  if (tabs < 2) { tabsEl.classList.add('ganz'); return; }
  for (let i = 0; i < tabs; i++) {
    const drin = workerImTab(s, m, i);
    if (!drin.length && i > 0) continue;
    const k = document.createElement('button');
    k.className = `tab${i === gewaehlt ? ' gewaehlt' : ''}`;
    k.setAttribute('role', 'tab');
    k.setAttribute('aria-selected', String(i === gewaehlt));
    k.appendChild(punkt(tabFarbe(drin)));
    k.appendChild(document.createTextNode(t('tab.marke', { n: i + 1 })));
    const anzahl = document.createElement('span');
    anzahl.className = 'anzahl';
    anzahl.textContent = String(drin.length);
    k.appendChild(anzahl);
    k.title = drin.map((w) => w.name).join(', ');
    k.addEventListener('click', () => {
      uebersichtAn = false;
      tabZeigen(m, s, i);
    });
    tabsEl.appendChild(k);
  }
  // Rollt der Streifen wirklich? Nur dann traegt er den Randverlauf -- sonst
  // saehe der letzte Tab blass aus, ohne dass es etwas zu sehen gaebe.
  tabsEl.classList.toggle('ganz', tabsEl.scrollWidth <= tabsEl.clientWidth + 1);
}

// --- Die Uebersicht ---------------------------------------------------------
/**
 * „Man will ja auch mal nur die Worker-Tabs sehen" (alice am 03.09.). Je Tab
 * eine Karte mit den Workern darin -- Zustand, Name, Modell, Tokenstand und
 * eine Zeile, die sagt, woran der Worker gerade ist. Kein Terminalbild: bei
 * neun Panes sieht man dort neunmal denselben Begruessungstext und muss
 * trotzdem lesen, um zu wissen, welcher Worker woran haengt.
 *
 * Ein Klick auf den Tabkopf landet in „Gekachelt" auf diesem Tab, ein Klick auf
 * eine Worker-Zeile in „Gezoomt" auf diesem Worker.
 */
function zeichneUebersicht(m: Model): void {
  uebersichtEl.classList.toggle('an', uebersichtAn);
  if (!uebersichtAn) return;
  uebersichtEl.replaceChildren();
  const s = m.sessions.find((x) => x.id === m.selected);
  if (!s) return;
  // Wer ist Kind, und wer hat wie viele? Beides EINMAL fuer die ganze Karte
  // gerechnet statt je Zeile (Befund 10).
  const lebendeNamen = new Set(s.workers.filter((w) => w.alive).map((w) => w.name));
  const kinderZahl = new Map<string, number>();
  for (const w of s.workers) {
    if (!w.alive || !w.requestedBy || !lebendeNamen.has(w.requestedBy)) continue;
    kinderZahl.set(w.requestedBy, (kinderZahl.get(w.requestedBy) ?? 0) + 1);
  }
  const tabs = Math.max(1, m.capacity.tabs);
  const gewaehlt = Math.min(m.ui.workerTab, tabs - 1);
  let leer = true;
  for (let i = 0; i < tabs; i++) {
    const drin = workerImTab(s, m, i);
    if (!drin.length && i > 0) continue;
    leer = false;
    const karte = document.createElement('div');
    karte.className = `tabkarte${i === gewaehlt ? ' gewaehlt' : ''}`;
    const kopf = document.createElement('button');
    kopf.className = 'tabkarte-kopf';
    kopf.appendChild(punkt(tabFarbe(drin)));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t('tab.marke', { n: i + 1 });
    kopf.appendChild(name);
    const anzahl = document.createElement('span');
    anzahl.className = 'anzahl';
    anzahl.textContent = t('worker.anzahl', { n: drin.length });
    kopf.appendChild(anzahl);
    kopf.addEventListener('click', () => {
      uebersichtAn = false;
      tabZeigen(m, s, i);
    });
    karte.appendChild(kopf);

    for (const w of drin) {
      // DIE HERKUNFT STEHT WIEDER DA (04.09.2026, Befund 10 der Inventur).
      // Ein Worker, der auf Antrag eines anderen entstanden ist, sagt es in
      // seiner Unterzeile und rueckt unter ihn ein; der Antragsteller traegt
      // die Zahl seiner Kinder als `+n` neben dem Namen. Die Zugehoerigkeit
      // steht damit in der GEOMETRIE und im Wort, nicht in einer Farbe -- die
      // ist fuer den Zustand reserviert.
      const kind = !!w.requestedBy && lebendeNamen.has(w.requestedBy);
      const eigene = kinderZahl.get(w.name) ?? 0;
      karte.appendChild(workerZeile({
        klasse: `worker zustand-${w.state}${kind ? ' kind' : ''}`,
        farbe: zustandFarbe(w.state),
        name: w.name,
        marke: eigene ? `+${eigene}` : '',
        neben: w.model,
        unten: [kind ? t('worker.aufAntrag', { name: w.requestedBy }) : '', w.titel || zustandText(w)]
          .filter(Boolean).join(' · '),
        tokens: tokenKurz(w),
        pane: w.paneId,
        tab: i,
      }));
      // V19: Subagenten stehen EINGERUECKT unter ihrem Worker. Sie haben einen
      // eigenen Pane, zaehlen aber in der Kapazitaetsrechnung nicht mit -- die
      // Zugehoerigkeit steckt deshalb in der Einrueckung und nicht in einer
      // zweiten Farbe.
      for (const sub of w.subagents) {
        karte.appendChild(workerZeile({
          klasse: 'subagent kind',
          farbe: 'laeuft',
          name: sub.name || sub.agentId,
          neben: sub.type,
          unten: '',
          tokens: '',
          pane: sub.paneId,
          tab: i,
        }));
      }
    }
    uebersichtEl.appendChild(karte);
  }

  /**
   * WAS KEINEN PANE MEHR HAT, VERSCHWINDET TROTZDEM NICHT. Vor dem Neubau
   * standen fertige Worker, nicht einsehbare und elternlose Subagenten unter
   * eigenen Ueberschriften in der rechten Leiste. Die Leiste gibt es nicht
   * mehr; die Auskunft schon -- sie steht jetzt hier, in eigenen Karten unter
   * den Tabs. „Nicht einsehbar" ist ausdruecklich NICHT „fertig": niemand
   * konnte nachsehen, und das ist etwas anderes als ein Ende.
   */
  const karteFuer = (titel: string, zeilen: HTMLElement[]): void => {
    if (!zeilen.length) return;
    leer = false;
    const karte = document.createElement('div');
    karte.className = 'tabkarte';
    const kopf = document.createElement('div');
    kopf.className = 'tabkarte-kopf rubrik';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = titel;
    const anzahl = document.createElement('span');
    anzahl.className = 'anzahl';
    anzahl.textContent = t('worker.anzahl', { n: zeilen.length });
    kopf.append(name, anzahl);
    karte.appendChild(kopf);
    for (const z of zeilen) karte.appendChild(z);
    uebersichtEl.appendChild(karte);
  };
  karteFuer(t('worker.rubrikFertig'), s.workers.filter((w) => w.state === 'done').map((w) => workerZeile({
    klasse: 'worker fertig', farbe: 'ruhig', name: w.name, neben: w.model,
    unten: zustandText(w), tokens: tokenKurz(w), pane: '', tab: -1,
  })));
  karteFuer(t('worker.rubrikNichtEinsehbar'), s.workers.filter((w) => w.state === 'unknown').map((w) => workerZeile({
    klasse: 'worker unbekannt', farbe: 'fern', name: w.name, neben: w.model,
    unten: zustandText(w), tokens: '', pane: '', tab: -1,
  })));
  karteFuer(t('worker.rubrikUnbekannt'), s.orphanSubagents.map((sub) => workerZeile({
    klasse: 'subagent ohne-eltern', farbe: 'laeuft', name: sub.name || sub.agentId,
    neben: sub.type, unten: '', tokens: '', pane: sub.paneId, tab: -1,
  })));

  if (leer) {
    const hinweis = document.createElement('div');
    hinweis.className = 'uebersicht-leer';
    hinweis.textContent = t('uebersicht.leer');
    uebersichtEl.appendChild(hinweis);
  }
}

/** Eine Zeile der Uebersicht. Ohne Pane ist sie nur Auskunft, kein Weg. */
function workerZeile(opt: {
  klasse: string; farbe: string; name: string; neben: string; unten: string;
  tokens: string; pane: string; tab: number;
  /** `+n` neben dem Namen: so viele Worker sind auf seinen Antrag entstanden. */
  marke?: string;
  /**
   * Woher der Worker kommt -- Maschine und/oder Antragsteller. Steht VOR dem
   * Text der Unterzeile, in derselben Zeile und derselben Farbe; ein eigener
   * Span nur, damit der Lesehaken (`awb-ctl ui`) es getrennt zusagen kann.
   */
  herkunft?: string;
}): HTMLElement {
  const zeile = document.createElement('button');
  zeile.className = `worker-zeile ${opt.klasse}`;
  zeile.appendChild(punkt(opt.farbe));
  const leib = document.createElement('span');
  leib.className = 'leib';
  const oben = document.createElement('span');
  oben.className = 'oben';
  const wname = document.createElement('span');
  wname.className = 'wname';
  wname.textContent = opt.name;
  oben.appendChild(wname);
  if (opt.marke) {
    const marke = document.createElement('span');
    marke.className = 'wkinder';
    marke.textContent = opt.marke;
    oben.appendChild(marke);
  }
  if (opt.neben) {
    const wmodell = document.createElement('span');
    wmodell.className = 'wmodell';
    wmodell.textContent = opt.neben;
    oben.appendChild(wmodell);
  }
  leib.appendChild(oben);
  if (opt.unten || opt.herkunft) {
    const letzte = document.createElement('span');
    letzte.className = 'letzte';
    if (opt.herkunft) {
      const herkunft = document.createElement('span');
      herkunft.className = 'wherkunft';
      herkunft.textContent = opt.herkunft;
      letzte.appendChild(herkunft);
      if (opt.unten) letzte.appendChild(document.createTextNode(' · '));
    }
    if (opt.unten) letzte.appendChild(document.createTextNode(opt.unten));
    leib.appendChild(letzte);
  }
  zeile.appendChild(leib);
  if (opt.tokens) {
    const wtokens = document.createElement('span');
    wtokens.className = 'wtokens';
    wtokens.textContent = opt.tokens;
    zeile.appendChild(wtokens);
  }
  const untenText = [opt.herkunft, opt.unten].filter(Boolean).join(' · ');
  zeile.title = `${opt.name}${opt.neben ? ` · ${opt.neben}` : ''}${untenText ? ` — ${untenText}` : ''}`;
  if (opt.pane) {
    zeile.addEventListener('click', () => {
      uebersichtAn = false;
      // Die Liste geht zu: sonst deckt sie genau den Pane, zu dem sie fuehrt.
      workerlisteZu();
      if (opt.tab >= 0) window.awbBridge.bedienung('worker-tab', opt.tab);
      window.awbBridge.bedienung('show-pane', opt.pane);
    });
  } else {
    zeile.disabled = true;
  }
  return zeile;
}

for (const b of lageEl.querySelectorAll<HTMLButtonElement>('[data-lage]')) {
  b.addEventListener('click', () => {
    const m = modell;
    const s = m?.sessions.find((x) => x.id === m.selected);
    const welche = b.dataset.lage;
    if (welche === 'uebersicht') {
      uebersichtAn = true;
    } else if (welche === 'gekachelt') {
      uebersichtAn = false;
      if (m && s) tabZeigen(m, s, Math.min(m.ui.workerTab, Math.max(0, m.capacity.tabs - 1)));
    } else {
      uebersichtAn = false;
      // Gezoomt heisst: der Pane, der die Tastatur hat -- und wenn keiner sie
      // hat, der erste des Tabs. Ein Zoom auf nichts waere kein Zoom.
      const ziel = m?.streamPane
        || (m && s ? workerImTab(s, m, Math.min(m.ui.workerTab, Math.max(0, m.capacity.tabs - 1)))[0]?.paneId : '');
      if (ziel) window.awbBridge.bedienung('show-pane', ziel);
    }
    if (m) alles(m);
  });
}
// ORDNEN heisst: den aktuellen Tab noch einmal anfordern. `show-tab` laesst den
// Hauptprozess `fitWindow` mit `umraeumen` laufen, und genau das ist Ordnen.
// Bis zum 03.09. stand hier `bedienung('arrange')` -- diese Aktion gibt es im
// `switch` des Hauptprozesses nicht, der Knopf tat also nichts.
ordnenEl.addEventListener('click', () => {
  const m = modell;
  const s = m?.sessions.find((x) => x.id === m.selected);
  if (m && s) tabZeigen(m, s, Math.min(m.ui.workerTab, Math.max(0, m.capacity.tabs - 1)));
});

// --- Inspektor --------------------------------------------------------------
/**
 * Ordner, Aktivitaet und Protokolle. Ueber dem Inhalt sagt eine schmale Zeile,
 * WOZU das Blatt gehoert: der Ordner haengt am PROJEKT und bleibt stehen, wenn
 * der Orchestrator wechselt; Aktivitaet und Protokolle wechseln mit ihm. Ohne
 * diese Zeile sieht man einer Liste nicht an, worauf sie sich bezieht -- und
 * bei mehreren Orchestratoren im selben Projekt ist das die halbe Auskunft.
 */
/**
 * WIE BREIT EIN GEOEFFNETES BLATT STEHT (04.09.2026, Befund 1).
 *
 * Der Reiterstreifen und das Blatt sind zwei verschiedene Masse. Der Streifen
 * darf vierzig Bildpunkte schmal sein -- er traegt nur drei Reiter. Ein Blatt
 * bei vierzig Bildpunkten ist unlesbar, und genau das war der Zustand: das
 * Blatt fuellte seine Spalte, und die Spalte war der Streifen.
 *
 * Untergrenze 280 (darunter bleibt vom Dateibaum kein lesbarer Name),
 * Obergrenze 45 % der Fensterbreite (darueber nimmt das Blatt der Buehne mehr,
 * als es selbst braucht), dazwischen der Wert, den der Mensch gezogen hat.
 */
function blattBreiteJetzt(m: Model): number {
  const gewuenscht = m.ui.blattBreite ?? 360;
  const obergrenze = Math.max(280, Math.round(window.innerWidth * 0.45));
  return Math.max(280, Math.min(obergrenze, gewuenscht));
}

/** Steht gerade eines der drei Blaetter offen? Wenn ja, welches. */
function offenesBlatt(): string {
  // DIE KENNUNG DES PROTOKOLLBLATTES IST `pl-panel` (05.09.2026, Regelbruch 1).
  // Hier stand `pr-panel`, und diesen Kasten gibt es nicht: der Fund war immer
  // leer, das Blatt galt als zu, und die Spalte blieb auf der Reiterbreite von
  // vierzig Bildpunkten stehen -- der Text lief darin senkrecht Buchstabe fuer
  // Buchstabe. Ordner und Aktivitaet trafen ihre Kaesten und klappten auf.
  const kasten: Record<string, string> = { ordner: 'or', aktivitaet: 'ak', protokolle: 'pl' };
  return Object.keys(kasten).find(
    (n) => document.getElementById(`${kasten[n]}-panel`)?.classList.contains('offen'),
  ) ?? '';
}

/**
 * ZU HEISST NULL BILDPUNKTE (05.09.2026, Electron-Befund 1).
 *
 * Rechts stand ein vierzig Bildpunkte breiter Streifen, solange kein Blatt
 * offen war. Er war leer: die drei Reiter darin fielen in einer Spaltenreihe
 * auf null Hoehe zusammen (`flex: 1 1 0` auf der Hauptachse schlaegt ihre
 * 22 Bildpunkte), und was blieb, war eine Karte ohne Inhalt neben der Buehne.
 *
 * Der Inspektor ist jetzt eine Spalte, die es nur GIBT, solange ein Blatt
 * offen steht. Der Schalter oben rechts ist der Weg hinein und hinaus: er
 * oeffnet das zuletzt gelesene Blatt und schliesst das offene. Die drei Reiter
 * stehen weiter oben in der Spalte, also bleibt der Wechsel zwischen den
 * Blaettern da, wo er war.
 *
 * DAMIT FAELLT DIE ZWEITE BREITE WEG: `rightWidth` war das Mass des
 * Reiterstreifens, und den gibt es nicht mehr. Die eine Breite, die noch
 * gezogen wird, ist die des Blattes (`blattBreite`).
 */
function zeichneInspektor(m: Model): void {
  const offen = offenesBlatt();
  rechtsEl.hidden = !offen;
  griffRechtsEl.hidden = !offen;
  inspKnopfEl.setAttribute('aria-pressed', String(Boolean(offen)));
  if (offen) letztesBlatt = offen;
  const breite = blattBreiteJetzt(m);
  rechtsEl.style.width = `${breite}px`;
  rechtsListeEl.replaceChildren();

  const s = m.sessions.find((x) => x.id === m.selected);
  for (const k of rechtsEl.querySelectorAll<HTMLButtonElement>('.knopf[data-tot]')) {
    k.classList.toggle('gewaehlt', k.dataset.tot === offen);
  }
  reiterAufschriftPruefen(rechtsEl.hidden ? -1 : Math.round(rechtsEl.getBoundingClientRect().width));
  // Ein Blatt, das gerade aufgegangen ist, macht die Spalte breiter -- und
  // damit die Buehne schmaler. Ohne dieses Nachziehen bekaeme tmux die alte
  // Zellenzahl, und der Inhalt liefe ueber seine Kachel hinaus.
  if (offen !== zuletztOffenesBlatt) {
    const vorherOffen = Boolean(zuletztOffenesBlatt);
    zuletztOffenesBlatt = offen;
    // DER HAUPTPROZESS MUSS ES WISSEN (Electron-Befund 7): er rechnet die
    // Kapazitaet, und ein offenes Blatt senkt die Mindestbreite je Pane auf
    // den gemessenen Boden, statt die Buehne auf eine Spalte fallen zu lassen.
    // Gemeldet wird nur der WECHSEL -- eine Meldung je Klick, nicht je Zeichnen.
    if (vorherOffen !== Boolean(offen)) window.awbBridge.bedienung('blatt-offen', Boolean(offen));
    paneflaecheNachziehen();
  }
  inspBereichEl.replaceChildren();
  if (s && offen) {
    const wort = offen === 'ordner' ? t('inspektor.projekt') : t('inspektor.orchestrator');
    const wert = document.createElement('b');
    wert.textContent = offen === 'ordner' ? projektName(s.dir) : s.name;
    inspBereichEl.append(document.createTextNode(`${wort} `), wert);
  }
  // DER SCHLIESSEN-KNOPF WIRD SICHTBAR (04.09.2026, Befund 12). Die drei
  // Blaetter bringen je einen eigenen mit, aber ihre Kopfzeile steht auf
  // `display: none` -- fuer ein Skript erreichbar, fuer eine Maus nicht.
  //
  // Er steht hier und nicht in den drei Blaettern: die Zeile darueber nennt
  // ohnehin schon, WOZU das offene Blatt gehoert, und ein × an ihrem rechten
  // Ende ist eine Reihe Bedienelemente statt dreier. Er tut genau das, was ein
  // zweiter Klick auf den Reiter tut -- dieselbe eine Stelle (`flaeche.ts`,
  // `umschalten`), erreicht ueber den Reiter, den es schon gibt.
  if (offen) {
    const zu = document.createElement('button');
    zu.className = 'insp-zu';
    // EINE KENNUNG, DAMIT DER STEUERKANAL IHN ERREICHT (05.09.2026). `awb-ctl
    // klick` faellt auf `getElementById` zurueck, wenn kein `data-tot` passt --
    // ohne diese Zeile liess sich der Knopf kopflos nicht ausloesen, und damit
    // war die Zusage „ein Klick darauf schliesst das Blatt" nicht pruefbar.
    zu.id = 'blatt-schliessen';
    zu.type = 'button';
    zu.title = t('inspektor.blattSchliessen');
    zu.appendChild(svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 13, 1.5));
    zu.addEventListener('click', () => {
      rechtsEl.querySelector<HTMLButtonElement>(`.knopf[data-tot="${offen}"]`)?.click();
    });
    inspBereichEl.appendChild(zu);
  }

  // Die Kachelform bleibt als Hilfeschildchen erreichbar, steht aber nicht mehr
  // dauerhaft im Bild (A14: kein Dauerhinweis, der um Aufmerksamkeit wirbt).
  const kurz = [t('satz.kachelungKurz', {
    proTab: m.capacity.perTab, spalten: m.capacity.spalten, zeilen: m.capacity.zeilen,
  })];
  const teile = [t('satz.kachelung', {
    proTab: m.capacity.perTab,
    spalten: m.capacity.spalten,
    zeilen: m.capacity.zeilen,
    maxSpalten: m.capacity.perRow,
    maxZeilen: m.capacity.perColumn,
  })];
  if (m.capacity.cappedBySetting) teile.push(t('satz.obergrenze'));
  if (!m.mayArrange) {
    const eineMehrzahl = m.fremdeClients === 1 ? '.eins' : '';
    teile.push(t(`satz.fremdeSitzung${eineMehrzahl}`, { n: m.fremdeClients }));
    kurz.push(t(`satz.fremdeSitzungKurz${eineMehrzahl}`, { n: m.fremdeClients }));
  } else if (auskunft.regel.startsWith('eigene')) {
    teile.push(t('satz.eigeneSitzung'));
  } else if (auskunft.regel !== '-') {
    teile.push(t('satz.uebernommeneSitzung'));
  }
  hinweisEl.textContent = kurz.join(' · ');
  hinweisEl.title = teile.map((z) => (z.endsWith('.') ? z : `${z}.`)).join(' ');
  // Sie steht da, solange es etwas zu kacheln gibt. Liegt ein Gespraech auf der
  // Buehne oder ist der Streifen im Orchestrator-Modus gar nicht da, sagt sie
  // nichts ueber das, was man sieht.
  hinweisEl.hidden = Boolean(m.chatGezeigt ?? '') || Boolean(m.chatWerkstattGezeigt ?? '') || tabstreifenEl.hidden;
  rechtsEl.title = [
    `Session ${auskunft.session}`,
    `Pane ${auskunft.pane}`,
    `Groesse ${auskunft.groesse}`,
    `Groessenregel ${auskunft.regel}`,
    `Layout ${auskunft.layout}`,
  ].join('\n');
}

// DER SCHALTER OBEN RECHTS OEFFNET UND SCHLIESST DAS BLATT (05.09.2026,
// Electron-Befund 1). Vorher blendete er die Spalte aus und wieder ein, und
// die Spalte konnte dabei leer sein. Jetzt gibt es nur noch die zwei
// Zustaende, die man auch sieht: ein Blatt steht da, oder rechts ist nichts.
// Gedrueckt wird derselbe Reiter, den auch eine Maus draufklickt -- ein Weg,
// nicht zwei (flaeche.ts, `umschalten`).
inspKnopfEl.addEventListener('click', () => {
  const offen = offenesBlatt();
  rechtsEl.querySelector<HTMLButtonElement>(`.knopf[data-tot="${offen || letztesBlatt}"]`)?.click();
});
for (const k of rechtsEl.querySelectorAll<HTMLButtonElement>('.knopf[data-tot]')) {
  // Die Blaetter schalten sich selbst um (flaeche.ts, `umschalten`); hier wird
  // nur nachgezogen, welcher Reiter danach gewaehlt aussieht.
  k.addEventListener('click', () => {
    requestAnimationFrame(() => { if (modell) zeichneInspektor(modell); });
  });
}

// --- Maschinenkarten und Fusszeile der linken Leiste ------------------------
const statuszeileEl = initFussStatus();

function zeichneStatus(m: Model): void {
  if (statuszeileEl) zeichneStatuszeile(statuszeileEl, m.ampel, m.budget, m.maschinen ?? [], m.machine);
  const laufend = m.sessions.reduce(
    (n, s) => n + s.workers.filter((w) => w.state === 'running' || w.state === 'blocked' || w.state === 'stalled').length,
    0,
  );
  stWorkerEl.replaceChildren();
  const zahl = document.createElement('b');
  zahl.textContent = String(laufend);
  stWorkerEl.append(zahl, document.createTextNode(` ${t('status.workerLaufen')}`));
}

// --- Alles zusammen ---------------------------------------------------------
function alles(m: Model): void {
  if (m.selected && m.selected !== modusAngewandtFuer) {
    modusAngewandtFuer = m.selected;
    const s = m.sessions.find((x) => x.id === m.selected);
    if (s?.orchestratorPane && gemerkterModus(m, m.selected) === 'orchestrator') {
      window.awbBridge.bedienung('show-pane', s.orchestratorPane);
    }
  }
  zeichneKopf(m);
  zeichneInhaltskopf(m);
  if (sitzungskarteAuf) sitzungskarteZeichnen(m);
  if (workerlisteAuf) workerlisteZeichnen(m);
  zeichneBaum(m);
  zeichneStreifen(m);
  zeichneUebersicht(m);
  zeichneInspektor(m);
  zeichneStatus(m);
}

// --- Die Flaeche in der Mitte ----------------------------------------------
initPaneflaeche({
  /**
   * WAS IN DER KOPFZEILE EINES PANES STEHT. Der Name kommt aus dem Modell, das
   * Modell und der Tokenstand aus dem Worker dahinter -- und was die Bruecke
   * nicht kennt, bleibt leer. Ein Orchestrator-Pane hat weder Modell noch
   * Tokenstand in dieser Liste; ein Subagent hat seine Art statt eines Modells.
   */
  kopfZuPane(paneId) {
    const leer = { name: paneId, zustand: 'ruhig', modell: '', tokens: '' };
    const s = modell?.sessions.find((x) => x.id === modell?.selected);
    if (!s) return leer;
    if (paneId === s.orchestratorPane) {
      return { name: t('pane.orchestrator'), zustand: farbklasse(s.state), modell: s.model ?? '', tokens: '' };
    }
    const w = s.workers.find((x) => x.paneId === paneId);
    if (w) return { name: w.name, zustand: zustandFarbe(w.state), modell: w.model, tokens: tokenKurz(w) };
    for (const x of s.workers) {
      const sub = x.subagents.find((y) => y.paneId === paneId);
      if (sub) return { name: sub.name || sub.agentId, zustand: 'laeuft', modell: sub.type, tokens: '' };
    }
    const os = s.orphanSubagents.find((y) => y.paneId === paneId);
    if (os) return { name: os.name || os.agentId, zustand: 'laeuft', modell: os.type, tokens: '' };
    return leer;
  },
  /**
   * Der Zoom-Knopf einer Kopfzeile. Was auf der Flaeche liegt, entscheidet der
   * Hauptprozess -- hier wird nur gesagt, was gewuenscht ist: aus den Kacheln
   * heraus dieser eine Pane, aus dem Zoom zurueck zu allen Panes des Tabs.
   */
  aufZoom(paneId, gezoomt) {
    uebersichtAn = false;
    const m = modell;
    const s = m?.sessions.find((x) => x.id === m.selected);
    if (gezoomt && m && s) {
      tabZeigen(m, s, Math.min(m.ui.workerTab, Math.max(0, m.capacity.tabs - 1)));
      return;
    }
    window.awbBridge.bedienung('show-pane', paneId);
  },
  aufAktivemPane(paneId) {
    auskunft.pane = paneId || '-';
  },
  aufLage(p) {
    // WELCHE PANES WIRKLICH GEZEICHNET SIND. Daran haengt der Umschalter im
    // Inhaltskopf: er zeigt, was zu sehen ist, nicht was gemerkt wurde.
    gezeichnetePanes = p.panes.map((b) => b.paneId).filter(Boolean);
    auskunft.groesse = `${p.cols}x${p.rows}`;
    auskunft.ansicht = p.art === 'tab'
      ? `Tab mit ${p.panes.length} Panes${p.fehlend?.length ? `, ${p.fehlend.length} fehlen` : ''}`
      : 'ein Pane';
    // Eine neue Lage heisst: eine andere Ansicht liegt auf der Flaeche. Der
    // Dreifachschalter und die Tabs muessen das sofort zeigen, sonst behauptet
    // der Streifen etwas, das darunter nicht mehr stimmt.
    // AUCH DER INHALTSKOPF ZIEHT SOFORT NACH. Sein Umschalter zeigt, was auf
    // der Flaeche liegt; ohne diesen Aufruf bliebe er bis zum naechsten
    // Modelltakt auf dem vorigen Stand -- gemessen am Belegbild vom 04.09.:
    // „Orchestrator" gewaehlt, daneben drei Worker-Kacheln.
    if (modell) {
      rechtsZaehler.layout++;
      zeichneInhaltskopf(modell);
      zeichneStreifen(modell);
      zeichneInspektor(modell);
    }
  },
  aufSitzung(p) {
    auskunft.session = p.session || '-';
    auskunft.pane = p.activePane || '-';
    auskunft.regel = p.sizePolicy === 'owned'
      ? 'eigene Session (manual)'
      : p.sizePolicy ? 'fremde Session (uebernommen)' : '-';
    if (modell) { rechtsZaehler.session++; zeichneInspektor(modell); }
  },
});

// --- Die Blaetter -----------------------------------------------------------
initFreigabenView();
initEditorView();
// DER TAB AGENTS: DIE WELTEN (Auftrag agentsui Nr. 4, seit Nr. 6 im Tab). Ihre Daten kommen
// ueber `awb:aufgaben`, ihre Handlungen `welt:*` gehen ueber denselben Weg wie am Mac.
initWeltenView({
  handlung(befehl, opt) { return window.awbBridge.aufgabe(befehl, opt); },
  daten() { return window.awbBridge.aufgabenDaten(); },
  sichtbar(an) { window.awbBridge.aufgabenSichtbar(an); },
  ordnerWaehlen(echt) { return window.awbBridge.weltOrdnerWaehlen(echt); },
  testhaken: window.awbBridge.testhaken === true,
});
window.awbBridge.onAufgaben((p) => { weltenAufgaben(p); });
initAktivitaetView();
initOrdnerView();
initProtokolleView();

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

// Schritt 7: die uebernommenen Seiten. Sie liegen ueber der Flaeche und gehen
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
window.awbBridge.onSeite((p) => seiten.zeige(p.name));
window.awbBridge.onDateiGeaendert((p) => seiten.aufDateiAendern(p.name));
// Die Seite liegt in einem Rahmen mit EIGENER Herkunft und redet deshalb ueber
// postMessage mit uns -- so, wie ein Webview mit seinem Wirt redet.
window.addEventListener('message', (e) => {
  const d = e.data as { __awbSeite?: boolean; daten?: unknown } | null;
  if (!d || d.__awbSeite !== true) return;
  window.awbBridge.bedienung('seiten-nachricht', d.daten);
});
window.awbBridge.onPlan((p) => seiten.frage(p));
window.awbBridge.onPlanErgebnis((p) => seiten.ergebnis(p.ausgabe, p.ok));

/**
 * DIE AUFLAGE AUS DIESEM HAUS, an Zahnrad, Plus und Sitzungsfenster
 * gleichermassen: Das Fenster geht auf, weil ein MENSCH geklickt hat -- nie,
 * weil ein Test oder ein Agent es anfordert. Unterschieden wird an
 * `isTrusted`, nicht an einem Namen: ein echter Klick traegt `true` und
 * schickt 'einstellungen-zeigen' (dort steht show()), ein `element.click()`
 * aus einem Skript -- der Weg jedes Tests und jedes Steuerbefehls -- traegt
 * `false` und schickt 'einstellungen-bauen': das Fenster entsteht, ist lesbar
 * und fotografierbar, erscheint aber auf keinem Bildschirm.
 */
document.querySelector<HTMLButtonElement>('.knopf[data-tot="einstellungen"]')
  ?.addEventListener('click', (ereignis) => {
    window.awbBridge.bedienung(ereignis.isTrusted ? 'einstellungen-zeigen' : 'einstellungen-bauen', null);
  });
document.getElementById('neue-session')?.addEventListener('click', (ereignis) => {
  window.awbBridge.bedienung(ereignis.isTrusted ? 'sitzung-zeigen' : 'sitzung-bauen', null);
});

// --- Das Modell -------------------------------------------------------------
window.awbBridge.onModel((m) => {
  modell = m;
  setzeSchrift(m.schriftgroesse);
  setzeScroll(m.scrollZeilen);
  // Was auf der Flaeche liegt, entscheidet der Hauptprozess -- hier wird es nur
  // ausgefuehrt. Zuerst, damit der Baum darunter schon den neuen Stand zeichnet.
  chatbuehne.nachModell(
    m.chatGezeigt ?? '',
    (m.chats ?? []).find((c) => c.id === (m.chatGezeigt ?? ''))?.worker ?? [],
  );
  auskunft.layout = m.mayArrange ? 'eigene Session, darf geordnet werden' : 'fremde Session, nur gezeichnet';
  rechtsZaehler.model++;
  alles(m);
  // DIE NAMENSSCHILDER HAENGEN AM MODELL, nicht nur an der Lage: der NAME eines
  // Panes kommt aus dem Modell, und das trifft eigenen Takt. Ein Pane, der beim
  // letzten Zeichnen noch keinen Worker hatte, behielte sonst die rohe Kennung
  // (gemessen 19.08.: dauerhaft "%2" statt "mlxsrv").
  schilderNachziehen();
  // Jede stehende Ergebnismeldung gegen den laufenden Auftrag halten:
  // `resultPath` ist die Datei des Auftrags, an dem der Worker JETZT haengt.
  // Weicht sie von der Meldung ab, ist die Meldung ueberholt.
  const aktuell = new Map<string, string>();
  for (const s of m.sessions) for (const w of s.workers) aktuell.set(w.name, w.resultPath);
  meldungen.abgleich(aktuell);
  // Die Breite beider Leisten kommt aus dem Modell -- hat sie sich geaendert,
  // ist die Flaeche daneben eine andere, und tmux muss die neue Zellenzahl
  // bekommen. Ein Fenster-`resize` gibt es dabei nicht.
  flaecheMelden();
});

window.awbBridge.onFreigaben((roh) => {
  const p = (roh ?? {}) as Partial<FreigabenNutzlast>;
  freigabenStand = { requests: p.requests ?? [], guardBlocks: p.guardBlocks ?? [] };
  zeichneFreigaben();
});

// Ohne Steuerkanal laeuft das Fenster weiter -- aber es sagt es. Die Meldung
// bleibt stehen, solange der Zustand gilt; sie verschwindet nicht von selbst
// wie eine Notiz.
window.awbBridge.onKanal((k) => {
  kanalGrund = k.fehler ?? '';
  kanalwarnungEl.textContent = kanalGrund ? t('satz.keinKanal', { grund: kanalGrund }) : '';
  kanalwarnungEl.classList.toggle('sichtbar', !!kanalGrund);
});

window.awbBridge.onMeldung((p) => notiz(p.text ?? '', p.dauerMs));

// --- Umbenennen -------------------------------------------------------------
/**
 * „Namen ändern" aus dem Kontextmenue der Leiste. Gefragt wird IM PROGRAMM,
 * nicht in einem Terminal -- ein Zeilenfeld ueber der Flaeche, das mit der
 * Antwort wieder zugeht. Geschrieben wird der Name hier NICHT: die Antwort geht
 * zurueck an den Hauptprozess, und dort schreibt `wb-state` sie.
 */
const umbenennenEl = document.getElementById('umbenennen') as HTMLDivElement;
const umbenennenAltEl = document.getElementById('umbenennen-alt') as HTMLDivElement;
const umbenennenFeld = document.getElementById('umbenennen-feld') as HTMLInputElement;
let umbenennenId = '';

function umbenennenZu(): void {
  umbenennenEl.classList.remove('sichtbar');
  umbenennenId = '';
}

window.awbBridge.onUmbenennen((p) => {
  umbenennenId = p.id;
  umbenennenAltEl.textContent = t('umbenennen.bisher', { name: p.name }) + (p.dir ? ` — ${p.dir}` : '');
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

// --- Die beiden Leisten aufziehen -------------------------------------------
/**
 * WAEHREND DES ZIEHENS BLEIBT ALLES IM FENSTER (16.08.). Die Breite folgt der
 * Maus rein oertlich (hoechstens einmal je Einzelbild), GESPEICHERT wird beim
 * Loslassen -- einmal. Vorher schickte jede Mausbewegung eine Meldung an den
 * Hauptprozess, und der schrieb je Meldung `ui.json` und gab das volle Modell
 * zurueck: bei 60 bis 120 Ereignissen je Sekunde ebenso viele Schreibvorgaenge
 * fuer eine Zahl, die niemand ausser diesem Fenster braucht, solange die Maus
 * noch unten ist.
 *
 * ZWEI AUSNAHMEN, die kein Schmuck sind: wechselt die BREITENSTUFE, aendert
 * sich der Inhalt der Leiste, und die Meldung geht sofort raus -- ein- bis
 * zweimal je Zug, nicht sechzigmal je Sekunde. Und beim Loslassen meldet die
 * Flaeche ihre neue Groesse, ebenfalls einmal.
 */
// Rechts ist die Untergrenze die des Blattes (280) -- der Griff steht nur
// da, solange ein Blatt offen ist.
const ZIEH_GRENZEN = { links: { min: 48, max: 480 }, rechts: { min: 280, max: 900 } };
let zieht: '' | 'links' | 'rechts' = '';
let ziehBreite = 0;
let ziehRahmen = 0;
griffEl.addEventListener('mousedown', (e) => { zieht = 'links'; e.preventDefault(); });
griffRechtsEl.addEventListener('mousedown', (e) => { zieht = 'rechts'; e.preventDefault(); });

function ziehStufe(welche: 'links' | 'rechts', breite: number): string {
  if (welche === 'links') return schmalLinks(breite) ? 'schmal' : 'breit';
  // Rechts gibt es die schmale Stufe nicht mehr: der Griff steht nur da,
  // solange ein Blatt offen ist, und dessen Untergrenze liegt bei 280
  // (Electron-Befund 1).
  return 'breit';
}

function ziehBreiteZeichnen(welche: 'links' | 'rechts', breite: number): void {
  const el = welche === 'links' ? linksEl : rechtsEl;
  el.classList.toggle('schmal', ziehStufe(welche, breite) === 'schmal');
  el.style.width = `${breite}px`;
}

window.addEventListener('mousemove', (e) => {
  if (!zieht) return;
  const g = ZIEH_GRENZEN[zieht];
  const roh = zieht === 'links' ? e.clientX : window.innerWidth - e.clientX;
  const breite = Math.max(g.min, Math.min(g.max, Math.round(roh)));
  const vorher = zieht === 'links'
    ? (modell?.ui.sidebarWidth ?? 48)
    : (modell ? blattBreiteJetzt(modell) : 360);
  if (ziehStufe(zieht, vorher) !== ziehStufe(zieht, breite)) {
    window.awbBridge.bedienung(zieht === 'links' ? 'sidebar-width' : 'blatt-breite', breite);
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
  if (ziehRahmen) { cancelAnimationFrame(ziehRahmen); ziehRahmen = 0; }
  if (!ziehBreite) return;
  ziehBreiteZeichnen(welche, ziehBreite);
  // ERST JETZT wird gespeichert: ein Zug ist eine Entscheidung, nicht sechzig.
  window.awbBridge.bedienung(welche === 'links' ? 'sidebar-width' : 'blatt-breite', ziehBreite);
  paneflaecheNachziehen();
  ziehBreite = 0;
});

// --- Sprache, Thema, Fensterknoepfe ----------------------------------------
void window.awbEditorBridge.sprache().then((sp) => {
  setzeSprache(sp);
  setzeChatSprache(sp);
  document.documentElement.lang = sp === 'de' ? 'de' : 'en';
  document.title = t('fenster.titel');
  beschriftungenSetzen();
  if (modell) alles(modell);
  weltenSpracheGesetzt();
});

/**
 * Die FESTEN Beschriftungen nachtragen -- die aus index.html und die, die die
 * Blaetter beim Laden in ihr `innerHTML` schreiben. Drei Attribute, je eines
 * fuer die Stelle, an die der Text gehoert:
 *
 *   data-text              Aufschrift; sie geht in das `.beschriftung`-Kind,
 *                          wenn es eines gibt, sonst in das Element selbst.
 *                          Das Schildchen kommt aus demselben Schluessel mit
 *                          `.tipp`; fehlt der, wird die Aufschrift auch das
 *                          Schildchen.
 *   data-text-title        nur das Schildchen (Knoepfe, die ein Zeichen tragen)
 *   data-text-placeholder  nur der Platzhalter eines Eingabefeldes
 *
 * WARUM NICHT GLEICH BEIM BAUEN: die Sprache steht erst fest, wenn der
 * Hauptprozess geantwortet hat, und die Blaetter bauen ihr Geruest schon beim
 * Laden des Moduls -- also davor. Was einmal gebaut wird, traegt deshalb nur
 * den SCHLUESSEL, und der Text kommt von hier, wenn die Sprache bekannt ist.
 */
function beschriftungenSetzen(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-text]')) {
    const schluessel = el.dataset.text ?? '';
    if (!schluessel) continue;
    const aufschrift = t(schluessel);
    const ziel = el.querySelector<HTMLElement>('.beschriftung') ?? el;
    ziel.textContent = aufschrift;
    const tipp = t(`${schluessel}.tipp`);
    el.title = tipp.startsWith('[fehlender Text:') ? aufschrift : tipp;
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-text-title]')) {
    el.title = t(el.dataset.textTitle ?? '');
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-text-placeholder]')) {
    el.placeholder = t(el.dataset.textPlaceholder ?? '');
  }
}

/**
 * Farben durchreichen (11.08.): `data-thema` traegt hier immer den
 * AUFGELOESTEN Wert ('hell'/'dunkel'), nie 'system' -- `wirksam` kommt schon so
 * aus main/thema.ts, damit dieses Fenster nie selbst raten muss. Die vier
 * Zustandsfarben kommen bereits kontrastangepasst (`zustandsfarbenLesbar`),
 * ihre Tinte (fuer eine gefuellte Flaeche in dieser Farbe) separat dazu.
 */
function themaAnwenden(d: ThemaPayload): void {
  document.documentElement.dataset.thema = d.wirksam;
  document.documentElement.style.setProperty('--akzent', d.akzent);
  document.documentElement.style.setProperty('--akzent-tinte', d.akzentTinte);
  document.documentElement.style.setProperty('--akzent-text', d.akzentText);
  // ERST das Attribut setzen, DANN lesen: terminalThemaAnwenden() fragt die
  // Rollen ueber getComputedStyle ab, und die kennen das neue Thema erst,
  // nachdem data-thema oben schon steht.
  terminalThemaAnwenden();
  for (const [zustand, farbe] of Object.entries(d.zustandsfarbenLesbar)) {
    document.documentElement.style.setProperty(`--zustand-${zustand}`, farbe);
    document.documentElement.style.setProperty(`--zustand-${zustand}-tinte`, d.zustandsfarbenTinte[zustand] ?? '#05070a');
  }
  // Die Agentenfiguren lesen Grund und Zustandsfarben selbst -- nach einem
  // Themenwechsel einmal neu.
  figurenFarbenNeu();
  // Die uebernommene Seite bekommt Thema und Akzent nicht ueber ihre eigene
  // Auslieferung, sondern hier durchgereicht -- ueber denselben Steg wie
  // `acquireVsCodeApi` (postMessage): fremde Herkunft, ihr Dokument ist von hier
  // aus nicht lesbar, aber schreibbar per Botschaft.
  seiten.themaSetzen(d.wirksam, d.akzent, d.akzentTinte, d.akzentText);
}
window.awbBridge.onThema(themaAnwenden);
void window.awbBridge.thema().then(themaAnwenden);

/**
 * PLATZ FUER DIE DREI FENSTERKNOEPFE (main.ts: `titleBarStyle: 'hiddenInset'`).
 * Er wird IN DER TITELLEISTE genommen: sie ist die einzige Flaeche, die oben
 * durchlaeuft, und ihr Inhalt rueckt einfach hinter den Knoepfen an. Ein
 * fensterbreiter, fester Streifen darueber -- die Fassung vom 03.09. vormittags
 * -- deckte die obersten 28 Bildpunkte JEDER anderen Flaeche mit ab und brach
 * drei Suiten.
 *
 * Ziehen laesst sich am ganzen freien Grund der Titelleiste
 * (`-webkit-app-region: drag` in werkbank.css); jedes Bedienelement darin nimmt
 * sich ausdruecklich davon aus.
 */
if (window.awbBridge.plattform === 'darwin') document.documentElement.dataset.mac = 'ja';

// --- Der Rueckkanal fuer den Steuerkanal ------------------------------------
// Was im Puffer steht und was die Oberflaeche gerade zeigt. Damit laesst sich
// ein Foto gegen den Text pruefen.
window.__awb = {
  ...paneflaecheHaken(),

  /**
   * Wer an dieser Stelle den Zeiger faengt. Ein Foto zeigt, WAS uebereinander
   * liegt, aber nicht, wer den Klick bekommt. Gibt Kennung und Klassen des
   * obersten Elements zurueck, damit ein Test die Schicht benennen kann statt
   * sie zu vermuten.
   */
  trefferBei(x: number, y: number): { tag: string; id: string; klassen: string } {
    const el = document.elementFromPoint(x, y);
    if (!el) return { tag: '', id: '', klassen: '' };
    // `className` IST BEI SVG KEINE ZEICHENKETTE (05.09.2026). Dort ist es ein
    // `SVGAnimatedString`, und `toString()` darauf ergibt „[object
    // SVGAnimatedString]" -- ein Treffer auf ein gezeichnetes Symbol meldete
    // also nicht seine Klassen, sondern den Namen seines Wrappers. Das
    // Attribut liest beides richtig.
    return { tag: el.tagName.toLowerCase(), id: el.id || '', klassen: el.getAttribute('class') || '' };
  },

  /**
   * Wieviele Neuzeichnungen der Leisten seit dem Start dieses Fensters ueber
   * jede der drei Quellen kamen (`onModel`, `onLayout`, `onSession`).
   */
  rechtsTakt(): { model: number; layout: number; session: number } {
    return { ...rechtsZaehler };
  },

  /** Was in der uebernommenen Seite steht -- pruefbar ohne Foto. */
  seitenState(): Promise<unknown> { return seiten.zustand(); },
  seiteRollen(auswahl: string): Promise<boolean> { return seiten.rolleZu(auswahl); },
  seiteKlick(auswahl: string): Promise<boolean> { return seiten.klick(auswahl); },
  seiteFokus(auswahl: string): Promise<boolean> { return seiten.fokussiere(auswahl); },
  seiteUnfokus(): Promise<boolean> { return seiten.entfokussiere(); },
  seiteSchliessenKlick(): boolean { return seiten.schliessenKlick(); },

  /**
   * EINEN ZUG WIRKLICH AUSFUEHREN -- fuer die Pruefung des Ziehens in zwei
   * Ebenen. Es werden die ECHTEN Ereignisse gefeuert (`dragstart`, `dragover`,
   * `drop`) und nicht die Umbaufunktionen dahinter gerufen: sonst pruefte man
   * die Rechnung und nicht die Verdrahtung, und genau die war kaputt.
   *
   * `zielmarke` sagt, ob die Zeile unter dem Zeiger sich als Ziel gemeldet hat.
   * Bei einem Zug auf ein FREMDES Projekt muss sie false sein -- das ist die
   * sichtbare Haelfte der Zusage „ein Zug auf ein fremdes Projekt wird nicht
   * angenommen".
   */
  ziehprobe(p: { gezogen: string; ziel: string }): { gefunden: boolean; zielmarke: boolean } {
    const finde = (k: string): HTMLElement | null =>
      sessionsEl.querySelector<HTMLElement>(`.eintrag[data-id="${k}"]`)
      ?? sessionsEl.querySelector<HTMLElement>(`.projekt-zeile[data-projekt="${k}"]`);
    const von = finde(String(p?.gezogen ?? ''));
    const nach = finde(String(p?.ziel ?? ''));
    if (!von || !nach) return { gefunden: false, zielmarke: false };
    const daten = new DataTransfer();
    const feuere = (el: HTMLElement, art: string): void => {
      el.dispatchEvent(new DragEvent(art, { bubbles: true, cancelable: true, dataTransfer: daten }));
    };
    feuere(von, 'dragstart');
    feuere(nach, 'dragover');
    const zielmarke = nach.classList.contains('ziel');
    feuere(nach, 'drop');
    feuere(von, 'dragend');
    return { gefunden: true, zielmarke };
  },

  uiState(): unknown {
    // Die Zeilen der linken Leiste. `.eintrag` und `data-id` heissen weiter so
    // wie vor dem Neubau: der Steuerkanal liest sie, und eine Umbenennung
    // haette nur den Bericht gebrochen, nicht die Gestalt verbessert.
    const eintraege = [...sessionsEl.querySelectorAll<HTMLElement>('.eintrag')].map((e) => {
      const p = e.querySelector('.punkt');
      const r = p?.getBoundingClientRect();
      return {
        id: e.dataset.id ?? '',
        text: (e.textContent ?? '').trim(),
        /** NUR der Name -- `text` klebt Kuerzel, Name und Zusatzzeile aneinander. */
        name: (e.querySelector('.name')?.textContent ?? '').trim(),
        zustand: [...e.classList].find((c) => c.startsWith('zustand-'))?.slice(8) ?? '',
        // Die Merkmale einer Zeile, die NICHT ihr Zustand sind (Befund 9):
        // verloren, gescheiterter Start. Beide standen im Modell und wurden von
        // keiner Zeile gelesen; jetzt tragen sie eine eigene Klasse, und eine
        // Pruefung kann sie sehen.
        merkmale: ['verloren', 'startfehler', 'chat'].filter((c) => e.classList.contains(c)),
        gewaehlt: e.classList.contains('gewaehlt'),
        punktFarbe: p?.className.split(' ')[1] ?? '',
        // Ob der NAME wirklich zu sehen ist. `text` traegt ihn auch dann, wenn
        // er weggeblendet ist -- `textContent` kennt kein `display: none`, und
        // eine Pruefung auf „eingeklappt bleibt nur der Punkt" haette daran
        // still danebengegriffen.
        nameBreite: Math.round(e.querySelector('.name')?.getBoundingClientRect().width ?? 0),
        // Das Kuerzel (Befund 7) und die Zusatzzeile (Befund 8) -- beide nur,
        // wenn sie wirklich zu sehen sind. `textContent` allein wuesste nichts
        // von `display: none`, und genau daran haengen beide Zusagen.
        kuerzel: (e.querySelector<HTMLElement>('.kuerzel')?.getBoundingClientRect().width ?? 0) > 0
          ? (e.querySelector('.kuerzel')?.textContent ?? '') : '',
        kuerzelFarbe: (e.querySelector<HTMLElement>('.kuerzel')?.getBoundingClientRect().width ?? 0) > 0
          ? (e.querySelector('.kuerzel')?.className.split(' ')[1] ?? '') : '',
        zusatz: (e.querySelector<HTMLElement>('.zusatz')?.getBoundingClientRect().width ?? 0) > 0
          ? (e.querySelector('.zusatz')?.textContent ?? '').trim() : '',
        punktRect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
        // Steht der Punkt wirklich im SICHTBAREN Teil der Leiste, mit Rand?
        // Eine lange Liste rollt, und eine herausgerollte Zeile hat zwar eine
        // Lage, aber keine Bildpunkte -- wer dort misst, misst den Fensterrand
        // daneben. Die drei Bildpunkte Rand sind der Ausschnitt, den eine
        // Pixelmessung um den Punkt herum braucht (test-app-oberflaeche.sh).
        sichtbar: (() => {
          if (!r) return false;
          const k = linksEl.getBoundingClientRect();
          return r.top - 3 >= k.top && r.bottom + 3 <= k.bottom
            && r.left - 3 >= k.left && r.right + 3 <= k.right;
        })(),
      };
    });
    // Die Projekte darueber -- die Ebene, die es vor dem Neubau nicht gab.
    const projektzeilen = [...sessionsEl.querySelectorAll<HTMLElement>('.projekt-zeile')].map((e) => ({
      name: (e.querySelector('.name')?.textContent ?? '').trim(),
      pfad: e.title,
      // Die Kennung des Projekts -- dieselbe, auf die sich ein Zug bezieht.
      id: e.dataset.projekt ?? '',
      offen: !e.closest('.projekt')?.classList.contains('zu'),
      wartet: !!e.querySelector('.merker'),
      anzahl: Number((e.querySelector('.anzahl')?.textContent ?? '0').trim()) || 0,
      /**
       * Die SITZUNGEN dieses Blocks, in ihrer gezeichneten Reihenfolge. Ohne
       * sie liesse sich „ein Projektblock wandert vollstaendig mit allen
       * seinen Sitzungen" nur aus der flachen Liste erraten.
       */
      sitzungen: [...(e.closest('.projekt')?.querySelectorAll<HTMLElement>('.orch-zeile') ?? [])]
        .map((z) => z.dataset.id ?? ''),
      hoehe: Math.round(e.getBoundingClientRect().height),
    }));
    return {
      ...paneflaecheBericht(),
      notiz: notizEl.classList.contains('sichtbar') ? (notizEl.textContent ?? '') : '',
      neu: {
        knopf: !!document.getElementById('neue-session'),
        knopfOben: Math.round(document.getElementById('neue-session')?.getBoundingClientRect().top ?? -1),
        sessionsOben: Math.round(sessionsEl.getBoundingClientRect().top),
      },
      umbenennen: {
        offen: umbenennenEl.classList.contains('sichtbar'),
        id: umbenennenId,
        wert: umbenennenFeld.value,
        alt: umbenennenAltEl.textContent ?? '',
      },
      meldungen: [...document.querySelectorAll<HTMLDivElement>('#meldungen .meldung')].map((e) => ({
        worker: e.dataset.worker ?? '',
        pfad: e.dataset.pfad ?? '',
        veraltet: e.dataset.veraltet === '1',
        text: (e.textContent ?? '').trim(),
        /** NUR der Name -- `text` klebt Kuerzel, Name und Zusatzzeile aneinander. */
        name: (e.querySelector('.name')?.textContent ?? '').trim(),
      })),
      kanal: kanalGrund,
      kanalwarnung: kanalwarnungEl.classList.contains('sichtbar') ? (kanalwarnungEl.textContent ?? '') : '',
      // WO der Streifen liegt, in CSS-Punkten. Seit dem Neubau steht er quer
      // unter der Titelleiste statt in der Pane-Flaeche; ein Test, der seine
      // Farbe am Bildpunkt nachmisst, soll die Stelle erfragen koennen statt
      // sie zu raten.
      kanalwarnungRect: (() => {
        const r = kanalwarnungEl.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      })(),
      // Die Titelleiste: was sie ueber das Gewaehlte sagt, und dass die
      // Fensterknoepfe frei bleiben.
      kopf: {
        projekt: kProjektEl.textContent ?? '',
        orchestrator: kOrchEl.textContent ?? '',
        neben: kNebenEl.textContent ?? '',
        punktFarbe: kPunktEl.className.split(' ')[1] ?? '',
        hoehe: Math.round((document.getElementById('titelleiste')?.getBoundingClientRect().height ?? 0)),
        kontextLinks: Math.round(document.getElementById('kontext')?.getBoundingClientRect().left ?? -1),
        // Der Umschalter Code | Agents. Bis zum 08.09.2026 stand hier ein
        // `spaeter`-Merkmal: „Agents" war ein gedaempftes Segment mit einem
        // Schildchen „kommt noch" daneben. Beides ist weg, seit der Schalter
        // etwas tut -- was zaehlt, ist jetzt, welches Segment gewaehlt ist.
        modi: [...document.querySelectorAll<HTMLElement>('#modi > *')].map((e) => ({
          text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
          gewaehlt: e.classList.contains('gewaehlt'),
        })),
      },
      // Die Freigabeleiste: ob sie steht, wen sie nennt und was auf dem
      // Abzeichen daneben zaehlt.
      freigabeleiste: {
        offen: freigabeleisteEl.childElementCount > 0,
        anzahl: offeneFreigaben().length,
        abzeichen: abzeichenEl.hidden ? '' : (abzeichenEl.querySelector('.zahl')?.textContent ?? ''),
        // Das Abzeichen steht immer da; `leer` sagt, ob es gerade nichts zu
        // melden hat (Befund 2).
        abzeichenLeer: abzeichenEl.classList.contains('leer'),
        wer: (freigabeleisteEl.querySelector('.fr-wer')?.textContent ?? '').trim(),
        // Seit der Leiste EINE Zeile genuegt (Regelbruch 8), steht das „worum"
        // in derselben Zeile wie der Name -- gelesen wird der gedaempfte Teil.
        worum: (freigabeleisteEl.querySelector('.fr-text .leise')?.textContent ?? '').trim(),
        knoepfe: [...freigabeleisteEl.querySelectorAll('.fr-knoepfe button')].map((b) => (b.textContent ?? '').trim()),
        begruendungOffen: begruendungAuf,
      },
      projekte: projektzeilen,
      eintraege,
      /**
       * DER INHALTSKOPF. Was er benennt, was die Statuspille zaehlt, welche
       * Ansicht der Umschalter zeigt -- und ob der Tab-Streifen darunter
       * ueberhaupt dasteht. Genau daran haengt die Zusage „bei Orchestrator
       * gibt es nichts zu kacheln".
       */
      inhaltskopf: {
        da: !inhaltskopfEl.classList.contains('leer'),
        name: ikNameEl.textContent ?? '',
        nameGroesse: Math.round(parseFloat(getComputedStyle(ikNameEl).fontSize) * 10) / 10,
        nameGewicht: getComputedStyle(ikNameEl).fontWeight,
        herkunft: ikHerkunftEl.textContent ?? '',
        herkunftGroesse: Math.round(parseFloat(getComputedStyle(ikHerkunftEl).fontSize) * 10) / 10,
        pille: (ikWorkerEl.querySelector('.zahl')?.textContent ?? '').trim(),
        pilleFarbe: ikWorkerEl.querySelector('.punkt')?.className.split(' ')[1] ?? '',
        pilleHoehe: Math.round(ikWorkerEl.getBoundingClientRect().height),
        modus: [...ikModusEl.querySelectorAll<HTMLButtonElement>('[data-flaeche]')]
          .find((b) => b.classList.contains('gewaehlt'))?.dataset.flaeche ?? '',
        // Ob er ueberhaupt etwas zu schalten hat: seit dem 08.09. ist er grau,
        // solange der Tab Agents vorn liegt (Auftrag macagents, seit 14.09. die Welten).
        modusAus: ikModusEl.classList.contains('aus'),
        modusHoehe: Math.round(ikModusEl.getBoundingClientRect().height),
        streifen: !tabstreifenEl.hidden,
        /**
         * WIEVIEL DER KOPF DER BUEHNE WEGNIMMT, in Bildpunkten: vom oberen
         * Rand der Inhaltskarte bis zur Oberkante der Buehne. Genau diese Zahl
         * hat alice am 05.09. beanstandet -- sie war in der einen Sitzung
         * groesser als in der anderen. Gemessen wird der Abstand und nicht die
         * Summe zweier Hoehen: was dazwischen steht, zaehlt mit.
         */
        kopfHoehe: (() => {
          const mitte = document.getElementById('mitte')?.getBoundingClientRect();
          const buehne = document.getElementById('buehne')?.getBoundingClientRect();
          return mitte && buehne ? Math.round(buehne.top - mitte.top) : -1;
        })(),
        zahnrad: !!document.getElementById('ik-zahnrad'),
      },
      /**
       * Die Worker-Liste hinter der Pille (Befund 11): ob sie offen ist, was
       * sie zeigt, und wie breit sie steht -- damit eine Pruefung sagen kann,
       * dass die Auskunft da ist, OHNE dass die Buehne dafuer weichen musste.
       */
      workerliste: {
        offen: workerlisteAuf,
        breite: workerlisteAuf ? Math.round(workerlisteEl.getBoundingClientRect().width) : 0,
        zeilen: [...workerlisteEl.querySelectorAll<HTMLButtonElement>('.worker-zeile')].map((z) => ({
          name: (z.querySelector('.wname')?.textContent ?? '').trim(),
          modell: (z.querySelector('.wmodell')?.textContent ?? '').trim(),
          unten: (z.querySelector('.letzte')?.textContent ?? '').trim(),
          kinder: (z.querySelector('.wkinder')?.textContent ?? '').trim(),
          // Der Tokenstand steht seit dem Neubau in der Zeile; er fehlte hier
          // nur im Lesehaken, und was nicht abzulesen ist, laesst sich auch
          // nicht zusagen.
          tokens: (z.querySelector('.wtokens')?.textContent ?? '').trim(),
          // Maschine und Antragsteller, getrennt vom Rest der Unterzeile --
          // und die Hoehe der Zeile: die Herkunft darf sie nicht wachsen
          // lassen (Sitzungszeile 44 Punkte, die Worker-Zeile bleibt darunter).
          herkunft: (z.querySelector('.wherkunft')?.textContent ?? '').trim(),
          hoehe: Math.round(z.getBoundingClientRect().height),
          klasse: z.className,
          wegDa: !z.disabled,
        })),
      },
      /**
       * Der Inspektor: wie breit er steht, welches Blatt offen ist, ob seine
       * Reiter ihre Aufschrift tragen und ob der Schliessen-Knopf sichtbar
       * ist (Befunde 1 und 12).
       */
      inspektor: {
        blatt: offenesBlatt(),
        breite: rechtsEl.hidden ? 0 : Math.round(rechtsEl.getBoundingClientRect().width),
        // Die BREITE DES INHALTS, nicht die der Spalte: daran haengt die
        // Zusage „ein geoeffnetes Blatt ist mindestens 280 Punkte breit".
        blattBreite: Math.round(
          document.querySelector<HTMLElement>(
            '#schublade .or-panel.offen, #schublade .ak-panel.offen, #schublade .pl-panel.offen',
          )?.getBoundingClientRect().width ?? 0,
        ),
        nurSymbole: rechtsEl.classList.contains('nur-symbole'),
        // Traegt eine Aufschrift Auslassungspunkte? Dann waere ein Wort halb
        // abgeschnitten, und genau das darf nicht vorkommen.
        aufschriftGekuerzt: [...rechtsEl.querySelectorAll<HTMLElement>('.insp-reiter .beschriftung')]
          .some((el) => el.scrollWidth > el.clientWidth + 1),
        schliessenSichtbar:
          (document.querySelector<HTMLElement>('.insp-zu')?.getBoundingClientRect().width ?? 0) > 0,
      },
      /**
       * Die Knoepfe in den Kopfzeilen der Kacheln. Der Gespraechs-Knopf ist
       * seit dem 04.09. einer davon; vorher schwebte er ueber dem Terminal.
       */
      panekopfKnoepfe: [...document.querySelectorAll<HTMLElement>('.panekopf')].map((k) => ({
        pane: k.dataset.pane ?? '',
        zoom: !!k.querySelector('.pk-zoom'),
        gespraech: !!k.querySelector('.chat-griff'),
      })),
      /** Schwebt irgendwo noch ein Gespraechs-Knopf ausserhalb einer Kopfzeile? */
      gespraechSchwebend: [...document.querySelectorAll('.chat-griff')]
        .filter((el) => !el.closest('.panekopf')).length,
      /** Die Sitzungskarte hinter dem Zahnrad, wenn sie offen ist. */
      sitzungskarte: {
        offen: sitzungskarteAuf,
        name: skNameEl.value,
        felder: [...skListeEl.querySelectorAll('dt')].map((dt, i) => [
          (dt.textContent ?? '').trim(),
          (skListeEl.querySelectorAll('dd')[i]?.textContent ?? '').trim(),
        ]),
        knoepfe: [...skKnoepfeEl.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
      },
      /**
       * DIE GESTALT IN ZAHLEN -- damit eine Pruefung die neun Regeln des
       * Auftrags MESSEN kann statt sie am Bild zu schaetzen. Alles hier ist am
       * gezeichneten Fenster abgelesen, nichts steht doppelt im Quelltext.
       */
      gestalt: (() => {
        const wert = (el: Element | null, name: string): string =>
          el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
        const rahmen = document.getElementById('rahmen');
        const links = linksEl.getBoundingClientRect();
        const mitte = document.getElementById('mitte')?.getBoundingClientRect();
        const zeile = sessionsEl.querySelector('.orch-zeile');
        return {
          // Der Fenstergrund und die Kartenflaeche -- sie muessen verschieden sein.
          fenstergrund: getComputedStyle(document.documentElement).getPropertyValue('--fenster').trim(),
          rahmenPolster: wert(rahmen, 'padding-left'),
          kartenRadius: wert(linksEl, 'border-top-left-radius'),
          // Die Fuge zwischen linker Leiste und Mitte, in Bildpunkten.
          fugeLinks: mitte ? Math.round(mitte.left - links.right) : -1,
          // Seit dem 05.09.2026 steht unter der Mitte keine Karte mehr: die
          // Fuge unten ist die Polsterung des Rahmens bis zum Fensterrand.
          fugeUnten: mitte && rahmen ? Math.round(rahmen.getBoundingClientRect().bottom - mitte.bottom) : -1,
          // Keine Trennlinien mehr: die vier Kanten der Spalten und der
          // Fusszeile.
          linien: [linksEl, document.getElementById('mitte'), rechtsEl, document.getElementById('statusleiste')]
            .filter(Boolean)
            .map((el) => [
              wert(el, 'border-top-width'), wert(el, 'border-right-width'),
              wert(el, 'border-bottom-width'), wert(el, 'border-left-width'),
            ].join(' ')),
          zeilenhoehe: zeile ? Math.round(zeile.getBoundingClientRect().height) : -1,
          zeilenradius: wert(zeile, 'border-top-left-radius'),
          zeilenpolster: wert(zeile, 'padding-right'),
          zeilensymbol: zeile ? Math.round(zeile.querySelector('.zeilensymbol svg')?.getBoundingClientRect().width ?? 0) : -1,
          // Die Zeilenhoehe des Fliesstextes.
          zeilenabstand: getComputedStyle(document.body).lineHeight,
          // Die Karte der Inhaltsflaeche traegt ihren Innenabstand am Kopf.
          kopfpolster: wert(inhaltskopfEl, 'padding-left'),
        };
      })(),
      // Die Tab-Leiste ueber der Flaeche und der Dreifachschalter daneben.
      tabs: [...tabsEl.querySelectorAll('.tab')].map((e) => (e.textContent ?? '').trim()),
      tabsRollen: tabsEl.scrollWidth > tabsEl.clientWidth + 1,
      lage: lageJetzt(),
      // DER LEERZUSTAND, damit eine Pruefung ihn lesen kann, ohne ihn aus dem
      // Bild zu raten: die Zeile auf der Buehne, die Zeile im Baum und der
      // abgeschaltete Dreifachschalter.
      leer: {
        buehne: leerEl.classList.contains('an'),
        buehneText: (leerEl.textContent ?? '').trim(),
        baum: !!sessionsEl.querySelector('.baum-leer'),
        baumText: (sessionsEl.querySelector('.baum-leer')?.textContent ?? '').trim(),
        schalterAus: lageEl.classList.contains('aus'),
        schalterGewaehlt: [...lageEl.querySelectorAll('.gewaehlt')].length,
      },
      // Der Umschalter Code | Agents und die Welten dahinter (08.09.2026, seit 14.09. die Welten).
      // Er heisst hier `buehnenmodus`, weil `modus` schon vergeben ist: das
      // sagt seit dem Neubau, ob die linke Leiste schmal oder breit steht.
      buehnenmodus,
      modusKnoepfe: [...modiEl.querySelectorAll<HTMLButtonElement>('[data-modus]')].map((b) => ({
        id: b.dataset.modus ?? '',
        text: (b.textContent ?? '').trim(),
        gewaehlt: b.classList.contains('gewaehlt'),
      })),
      welten: weltenUiState(),
      weltenSichtbar: weltenSichtbar(),
      uebersicht: {
        an: uebersichtAn,
        karten: [...uebersichtEl.querySelectorAll('.tabkarte')].map((k) => ({
          kopf: (k.querySelector('.tabkarte-kopf .name')?.textContent ?? '').trim(),
          rubrik: !!k.querySelector('.tabkarte-kopf.rubrik'),
          zeilen: [...k.querySelectorAll<HTMLButtonElement>('.worker-zeile')].map((z) => ({
            text: (z.textContent ?? '').trim(),
            name: (z.querySelector('.wname')?.textContent ?? '').trim(),
            klasse: z.className,
            // Welche Zustandsfarbe der Punkt traegt -- damit eine Pruefung
            // sagen kann, dass hier eine bestimmte Farbe NICHT vorkommt.
            farbe: z.querySelector('.punkt')?.className.split(' ')[1] ?? '',
            // Wie weit der Punkt vom linken Rand der Karte einrueckt. Daran
            // haengt die Aussage, dass man die Gliederung Worker > Anhang
            // SIEHT und nicht an der Aufschrift ablesen muss.
            punktLinks: Math.round(
              ((z.querySelector('.punkt') ?? z).getBoundingClientRect().left) - k.getBoundingClientRect().left,
            ),
            nameBreite: Math.round(z.querySelector('.wname')?.getBoundingClientRect().width ?? 0),
            // Ohne Pane gibt es nichts zu zeigen: die Zeile ist reine Auskunft.
            wegDa: !z.disabled,
          })),
        })),
      },
      hinweis: hinweisEl.textContent ?? '',
      hinweisTitel: hinweisEl.title,
      hinweisVerborgen: hinweisEl.hidden,
      auskunft,
      modus: schmalLinks(modell?.ui.sidebarWidth ?? 48) ? 'schmal' : 'breit',
      sidebarWidth: modell?.ui.sidebarWidth ?? 0,
      linksBreite: linksEl.getBoundingClientRect().width,
      rechtsBreite: rechtsEl.hidden ? 0 : rechtsEl.getBoundingClientRect().width,
      inspektorOffen: !rechtsEl.hidden,
      rechtsTitel: rechtsEl.title,
      rechtsKlasse: rechtsEl.className,
      // Oberkante der ersten Zeile je Leiste -- beide sollen buendig sein.
      obenLinks: Math.round(linksEl.firstElementChild?.getBoundingClientRect().top ?? -1),
      obenRechts: Math.round((rechtsEl.querySelector('.insp-reiter') as HTMLElement)?.getBoundingClientRect().top ?? -1),
      // Die Fusszeile der linken Leiste (bis 05.09.2026 die Statusleiste
      // unten): Maschinenkarten darueber, Worker, Verbrauch, Zahnrad darin.
      // Die Feldnamen bleiben, damit die Suiten weiterlesen koennen.
      status: {
        hoehe: Math.round(document.getElementById('statusleiste')?.getBoundingClientRect().height ?? 0),
        breite: Math.round(document.getElementById('statusleiste')?.getBoundingClientRect().width ?? 0),
        // Sitzt die Leiste in der linken Karte, und reicht die Mitte bis zum
        // unteren Fensterrand? Beides ist die Zusage vom 05.09.
        inLinkerLeiste: !!document.getElementById('statusleiste')?.closest('#links'),
        mitteBisUnten: (() => {
          const rahmen = document.getElementById('rahmen')?.getBoundingClientRect();
          const mitte = document.getElementById('mitte')?.getBoundingClientRect();
          return rahmen && mitte ? Math.round(rahmen.bottom - mitte.bottom) : -1;
        })(),
        maschinenKarten: document.querySelectorAll('#maschinen .masch').length,
        maschinen: [...document.querySelectorAll<HTMLElement>('#maschinen .masch')].map((e) => ({
          name: (e.querySelector('.masch-name')?.textContent ?? '').trim(),
          punktFarbe: e.querySelector('.punkt')?.className.split(' ')[1] ?? '',
          feldOffen: !e.querySelector<HTMLElement>('.masch-feld')?.hidden,
          feld: (e.querySelector('.masch-feld')?.textContent ?? '').trim(),
          // Die Kurzzeile der Karte (05.09.): was ohne Klick dasteht.
          kurz: (e.querySelector('.masch-kurz')?.textContent ?? '').trim(),
          // Steht die Karte auf dem Schirm, ohne dass jemand geklickt hat?
          sichtbar: e.getBoundingClientRect().height > 0,
          // Der Maschinen-Schalter (05.09.): pausiert die Leiste diese
          // Maschine, und steht der Umschalter im Feld auf „laden"? Beides
          // aus dem DOM gelesen, nicht aus einer zweiten Buchfuehrung.
          pausiert: e.classList.contains('pausiert'),
          wort: (e.querySelector('.masch-wort')?.textContent ?? '').trim(),
          schalter: e.querySelector<HTMLInputElement>('.masch-schalter input')?.checked ?? null,
        })),
        worker: (stWorkerEl.textContent ?? '').trim(),
        verbrauch: (document.querySelector('#fuss .sz-budget')?.textContent ?? '').trim(),
        zahnrad: !!document.querySelector('#statusleiste .knopf[data-tot="einstellungen"]'),
      },
      // Die anklickbaren Pfade im Chat (chatdatei, 05.09.2026) -- gelesen aus dem
      // DOM, nicht aus einer Buchfuehrung: was hier steht, ist auch anklickbar.
      chatPfade: [...document.querySelectorAll<HTMLElement>('.chat-pfad')].map((e) => ({
        text: e.textContent ?? '',
        pfad: e.dataset.pfad ?? '',
        art: e.dataset.art ?? '',
        zeile: Number(e.dataset.zeile ?? 0) || 0,
        title: e.title,
        buehne: !!e.closest('#chatbuehne'),
      })),
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
        leiste: getComputedStyle(document.documentElement).getPropertyValue('--leiste').trim(),
      },
    };
  },
};

// Ohne diese Zeile bekommt das Fenster nie ein Modell: der Hauptprozess wartet
// darauf, dass die Oberflaeche steht.
void rahmenEl;
window.awbBridge.ready();
