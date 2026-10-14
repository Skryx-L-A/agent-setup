// DIE WELTEN-ANSICHT DER ELECTRON-FASSUNG (14.09.2026, Plan Fassung 28, Abschnitt 6
// und Bauschritt 7, erster Teil; Auftrag agentsui Nr. 4). Zwilling des Mac-Blatts
// „Agents-Welten" (mac/Sources/Werkbank/WeltenBlatt.swift, WeltenAnlegen.swift,
// WeltenSkills.swift) fuer peer: dieselben Bereiche, dieselben Kanaele.
//
// DATEN kommen ueber `awb:aufgaben`, Feld `welten` (main/welten.ts rechnet Zustand,
// Liste, Teams, Einzelchat, Zaehler, Ungelesen, Skills). HANDLUNGEN gehen als
// `welt:<handlung> <JSON>` ueber `awb:aufgabe` an den Kern, derselbe Weg wie am Mac;
// nur der Kern schreibt, ueber die Datenbibliothek. Ein echter Klick schickt
// `echt: true` (Absender `mensch`), ein Testhaken `echt: false` (`cli-operator`).
//
// ORT. Seit dem 14.09.2026 (Auftrag agentsui Nr. 6, nach Abnahme des Nutzers) ist die
// Ansicht der Tab „Agents" des Umschalters Code | Agents; das Aufgaben-Blatt aus
// Fassung 26 (agents-view.ts) und der dritte Modus „Welten" gibt es nicht mehr. Sie
// liegt als eigene Flaeche UEBER Leiste, Mitte und Inspektor des Fensters, statt deren
// Spalten umzubauen: so aendert sich an keiner Pane-Flaeche eine Groesse, und tmux
// bekommt beim Umschalten keine neuen Masse. Plan Abschnitt 11.1 will links die
// Agenten statt der Sitzungen; hier steht dafuer die Leiste der Welt. Unten steht die
// Fusszeile mit dem Traeger wie im Aufgaben-Blatt, und der Knopf „Figuren" im Kopf
// legt die Vorschau der Agentenfiguren (figurenblatt.ts) an die Stelle der Spalten.
//
// TEXTE kommen aus der Sprachschicht des Hauptfensters (`texte.ts`, Schluessel `welten.*`,
// Vorgabe Englisch wie im Rest der Electron-Fassung; Auftrag agentsui Nr. 5). Woerter, die der
// Kern als Daten liefert (Stand eines Tickets, Ereignisse, Zustandstexte), gehen ueber `wort()`
// und `zugText()`: bekannt heisst uebersetzt, unbekannt bleibt es roh stehen. BEDIENUNG: jedes Bedienelement traegt `data-w` (Handlung) und `data-arg`;
// ein Behandler am Blatt fuehrt sie aus. Eingaben tragen `data-feld` und schreiben nur
// in den Zustand; gezeichnet wird bei neuer Nutzlast und nach Handlungen, mit
// erhaltenem Fokus.
import './welten-view.css';
import { kurzerPfad } from './kurzpfad';
import type { AufgabenNutzlast } from '../main/aufgaben';
import type {
  ChatEintrag, GespraechZug, Welt, WeltAgent, WeltMaschine, WeltNachricht, WeltRechteAntrag, WeltSkills, WeltTicket, WeltenHandlungsErgebnis, WeltenNutzlast,
} from '../main/welten';
import { figur, figurenArtenSetzen, figurenAufraeumen, figurenBewegungErzwingen, figurenStand, figurZustandVon, type Art } from './agentenfigur';
import { figurenblattZeichnen, figurenblattZustand, initFigurenblatt } from './figurenblatt';
import { DE, sprache, t } from './texte';

export interface WeltenBruecke {
  handlung(befehl: string, opt: { echt: boolean; bestaetigt: boolean }): Promise<unknown>;
  daten?(): Promise<unknown>;
  sichtbar?(an: boolean): void;
  /** Auftrag agentsform: der Ordnerdialog des Systems fuer eine neue Welt (main.ts, `awb:welt-ordner`). */
  ordnerWaehlen?(echt: boolean): Promise<{ pfad: string; grund: string }>;
  testhaken?: boolean;
}

type Antwort = Partial<WeltenHandlungsErgebnis> & { ok?: boolean; meldung?: string };

// --- Zustand ----------------------------------------------------------------------

const KANAL = 'kanal';
const EINZEL = 'einzel';
const MERKER = 'awb.welten.darstellung';
const DENKSTUFEN = ['low', 'medium', 'high', 'xhigh'];
// WebFetch und WebSearch sind je Agent wählbar (Rechercheagenten, 2026-09-15); Vorgabe bleibt ohne Web.
// Auftrag agentsform: Bash gehoert zum Dienstweg und ist immer dabei; gewaehlt werden die uebrigen, Web nur mit Zugang.
const WERKZEUGE = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const WEB = ['WebFetch', 'WebSearch'];
const WERKZEUGE_VORGABE = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'];
const FIGUR_ARTEN = ['roboter', 'tier', 'linse'];
const FIGUR_FARBEN = ['entwicklung', 'recherche', 'pruefung', 'gestaltung'];
const STAENDE = ['triage', 'offen', 'läuft', 'wartet', 'braucht dich', 'zur Abnahme', 'in Prüfung', 'abgenommen', 'zurückgegeben', 'unterbrochen', 'verworfen'];
/** Die Spalten des Boards in Bearbeitungsrichtung (Plan Satz 47, AGIL Abschnitt 5). */
const BOARD_SPALTEN = ['triage', 'offen', 'läuft', 'wartet', 'braucht dich', 'zur Abnahme', 'in Prüfung', 'abgenommen'];
/** Welche Staende eine Board-Spalte fasst: `zurückgegeben` liegt in `offen`. */
const boardStaende = (spalte: string): string[] => (spalte === 'offen' ? ['offen', 'zurückgegeben'] : [spalte]);
/** Die Ticketarten des Kerns fuer Formular und Annahme (Plan Satz 3, AGIL Abschnitt 2). */
const TICKET_ARTEN = ['vorhaben', 'story', 'task', 'subtask', 'auftrag', 'fehler', 'recherche', 'pruefung'];
/** Die Grundcodes des Verwerfens (Plan Satz 40). */
const VERWERF_GRUENDE = ['duplikat', 'anderswo-erledigt', 'nicht-mehr-noetig', 'nicht-reproduzierbar', 'abgelehnt'];
/** Die Gruende, die der Kern bei der Abnahme annimmt (`ABNAHME_GRUENDE` in welten.ts). */
const ABNAHME_GRUENDE = ['erledigt', 'teilweise'];

interface Entwurf {
  id: string; stufe: string; team: string; spezialgebiet: string; modell: string; denkstufe: string; fallback: string;
  fallbackDenkstufe: string; maschine: string; werkzeuge: string[]; bash: string; skills: string; kontextgrenze: string;
  figurArt: string; figurFarbe: string; anweisungen: string; vorlage: string;
  /** Auftrag agentsform: Kennungen aus der Modellliste der Welt gehen woertlich hinaus (`sonnet:high`, `haiku`). */
  modellGenau: boolean;
}
interface Anlegen {
  entwurf: Entwurf; beschreibung: string; modell: string; neuesTeam: boolean; gesetzt: Set<string>; pruefung: string; info: string;
  /** Auftrag agentschat: Gespraech oder Formular, derselbe Entwurf; der Verlauf kommt aus dem Kern. */
  ansicht: 'gespraech' | 'formular'; verlauf: GespraechZug[]; eingabe: string;
  gFelder: string[]; gFragen: string[]; gFertig: boolean; gInfo: string;
  /** Eine Antwort gehoert nur zu dem Menue, aus dem sie kam. */
  sitzung: number;
}

let bruecke: WeltenBruecke | null = null;
let blatt: HTMLDivElement | null = null;
let nutzlast: WeltenNutzlast | null = null;
let letzterRoh = '';
/** Traeger und Kern fuer die Fusszeile, aus derselben Nutzlast `awb:aufgaben`. */
let fussStand: Pick<AufgabenNutzlast, 'traeger' | 'kern_sauber'> | null = null;
let letzterFuss = '';
let letzteArten = '';
/** Die Flaeche der Figurenvorschau: einmal gebaut und bei jedem Zeichnen wieder eingehaengt. */
let figurenEl: HTMLDivElement | null = null;
let sichtbarAn = false;
let gemeldetSichtbar: boolean | null = null;

/** Die Felder des Ticketformulars (Plan Sätze 1 bis 7, 42 bis 45). */
interface TicketEntwurf {
  titel: string; ziel: string; fertig: string; an: string;
  kind: string; prioritaet: number; punkte: string[];
  eltern: string; abhaengig: string; frist: string; runden: string;
}
const ticketEntwurfLeer = (an = ''): TicketEntwurf => ({
  titel: '', ziel: '', fertig: '', an, kind: 'auftrag', prioritaet: 2, punkte: [], eltern: '', abhaengig: '', frist: '', runden: '',
});
/**
 * Die Handlungen, die der Kern dem Menschen am Ticket erlaubt (docs/AGENTS-DATEN.md).
 * Abnehmen gehoert seit Entscheidung des Nutzers vom 18.09.2026 dazu (bestaetigt 29.09.:
 * fuer ihn freiwillig); der Kern nimmt sie nur von einem echten Klick an.
 */
type TicketHandlung = 'verwerfen' | 'annehmen' | 'umadressieren' | 'grenzen' | 'pruefer' | 'abnehmen';
interface TicketHandlungEntwurf {
  ticket: string; handlung: TicketHandlung;
  grund: string; bemerkung: string; duplikat: string; an: string; pruefer: string;
  kind: string; prioritaet: number; punkte: string[]; frist: string; runden: string;
  /** Abnehmen: die Definition of Done der Welt ist bestaetigt (`dod_geprueft`). */
  dodGeprueft: boolean;
}

const z = {
  weltPfad: '' as string,
  auswahl: KANAL as string,
  darstellung: merkerLesen() as 'baum' | 'liste',
  reiter: 'chat' as 'chat' | 'tickets',
  blatt: 'profil' as 'profil' | 'protokoll' | 'gedaechtnis' | 'skills',
  gespraech: EINZEL as string,
  zu: new Set<string>(),
  ticketAuswahl: '' as string,
  ticketFilter: 'offen',
  entwuerfe: new Map<string, string>(),
  adressfeld: '',
  antworten: new Map<string, string>(),
  meldung: null as { text: string; ok: boolean } | null,
  rueckfrage: null as { handlung: string; daten: Record<string, unknown>; text: string; warnungen: string[]; echt: boolean } | null,
  inspektor: true,
  gelesen: new Map<string, { zeit: string; id: string }>(),
  rueckgabe: '' as string, rueckgabeText: '',
  profil: null as null | { agent: string; modell: string; denkstufe: string; fallback: string; fallbackDenkstufe: string; maschine: string; spezialgebiet: string },
  gedaechtnis: null as null | { agent: string; text: string; sha: string },
  anlegen: null as Anlegen | null,
  skillOffen: new Set<string>(),
  skillAblehnen: '' as string, skillGrund: '',
  /** Das Formular für ein neues Ticket (Auftrag tickets4 C). */
  neuesTicket: null as null | TicketEntwurf,
  /** Liste oder Board (Plan Satz 47). */
  ticketAnsicht: 'liste' as 'liste' | 'board',
  /** Auftrag ticketboard: die zuletzt gemessene Breite des Boards in Pixeln (0 = noch nicht gemessen). */
  boardBreite: 0,
  /** Der Stand, der in der gestapelten Ansicht offen liegt; leer heisst: der erste mit Tickets. */
  boardSpalte: '',
  /** Leere Spalten, die der Mensch von Hand aufgeklappt hat. */
  boardOffen: new Set<string>(),
  /** NUR FUER TESTS: eine vorgegebene Boardbreite (Haken `breite`); 0 heisst: gemessen wird. */
  boardTestbreite: 0,
  /** Die offene Handlung im Ticketdetail (Auftrag tickets4 B); nur eine zur Zeit. */
  ticketHandlung: null as null | TicketHandlungEntwurf,
  /** Zyklus, Definition of Done und WIP-Grenze der Welt in Bearbeitung (Auftrag tickets4 D). */
  weltRegeln: null as null | { welt: string; tage: string; ziel: string; dod: string[]; wip: string },
  laufend: new Set<string>(),
  figuren: false,
  /** Auftrag agentsux Nr. 1: die Wege zu einer neuen Welt in der Leiste und der Ordner als Text. */
  weltNeuOffen: false,
  weltNeuOrdner: '',
  /** Die eben angelegte Welt: gewaehlt wird sie, sobald sie in der Nutzlast steht. */
  weltWunsch: '',
  /** Auftrag fernwelten: die Maschine der neuen Welt; leer = die Vorgabe (peer, sobald es als erreichbar belegt ist). */
  weltNeuMaschine: '',
  /** Die Maschinen wurden fuer „Neue Welt" schon einmal gefragt. */
  maschinenGefragt: false,
  /** Auftrag agentsform: die Rechte eines bestehenden Agenten in Bearbeitung (Profil); `bash` nur die eigenen Muster. */
  rechte: null as null | { agent: string; werkzeuge: string[]; bash: string; skills: string[] },
  /** Im Gespraech: die Karte „Was der Agent darf" aufgeklappt. */
  gRechteOffen: false,
  /** Vertrag rantrag: die getippte Bemerkung je Rechteantrag. */
  rantragBemerkung: new Map<string, string>(),
};
/** Die Fernwelt, die der Kern zuletzt als gewaehlt kennt. */
let gemeldetGewaehlt = '';

function merkerLesen(): 'baum' | 'liste' {
  try { return localStorage.getItem(MERKER) === 'liste' ? 'liste' : 'baum'; } catch { return 'baum'; }
}
function merkerSchreiben(): void {
  try { localStorage.setItem(MERKER, z.darstellung); } catch { /* ohne Speicher bleibt es beim Baum */ }
}

// --- Kleine Helfer ------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, klasse?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}
function knopf(text: string, w: string, arg = '', klasse = 'knopf-rand', aus = false): HTMLButtonElement {
  const b = el('button', klasse, text);
  b.type = 'button';
  b.dataset.w = w;
  b.dataset.arg = arg;
  b.disabled = aus;
  return b;
}
function feld(tag: 'input' | 'textarea', schluessel: string, wert: string, platzhalter = ''): HTMLInputElement | HTMLTextAreaElement {
  const f = document.createElement(tag);
  f.dataset.feld = schluessel;
  f.value = wert;
  if (platzhalter) f.placeholder = platzhalter;
  f.className = tag === 'textarea' ? 'wv-textfeld' : 'wv-feld';
  return f;
}
function auswahlFeld(schluessel: string, wert: string, optionen: [string, string][], gesperrt: Set<string> = new Set()): HTMLSelectElement {
  const s = el('select', 'wv-auswahl');
  s.dataset.feld = schluessel;
  for (const [v, text] of optionen) {
    const o = el('option', undefined, text);
    o.value = v;
    o.disabled = gesperrt.has(v);
    s.appendChild(o);
  }
  s.value = wert;
  return s;
}
function segment(w: string, wert: string, optionen: [string, string][]): HTMLDivElement {
  const s = el('div', 'segment wv-segment');
  s.setAttribute('role', 'tablist');
  for (const [v, text] of optionen) {
    const b = knopf(text, w, v, v === wert ? 'gewaehlt' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v === wert));
    s.appendChild(b);
  }
  return s;
}
function punkt(art: string): HTMLSpanElement { return el('span', `punkt ${art}`); }

/** Ein Schluessel aus einem Datenwort: „zur Abnahme" wird `zur_abnahme`, „läuft" `laeuft`. */
function schluesselVon(roh: string): string {
  return roh.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
/** Ein Wort aus einer Aufzaehlung des Kerns: uebersetzt, wenn die Tabelle es kennt, sonst roh. */
function wort(bereich: string, roh: string): string {
  const k = `welten.${bereich}.${schluesselVon(roh)}`;
  return DE[k] === undefined ? roh : t(k);
}
/** Deutsche Anfuehrung aus dem Kern („…“) in der englischen Form (“…”). */
function anfuehrung(s: string): string {
  return sprache() === 'de' ? s : s.replace(/„([^“]*)“/g, '“$1”');
}
// Die Zustandstexte rechnet der Kern auf Deutsch (main/welten.ts, agentZustand); fuer Englisch
// werden sie hier nach ihrem Muster uebersetzt. Ein Text ohne Muster bleibt stehen.
const ZUG_MUSTER: [RegExp, string][] = [
  [/^gestoppt mit der Welt$/, 'welten.zug.gestopptWelt'],
  [/^gestoppt: ([\s\S]+)$/, 'welten.zug.gestopptGrund'],
  [/^braucht dich: eine Frage$/, 'welten.zug.eineFrage'],
  [/^braucht dich: (\d+) Fragen$/, 'welten.zug.fragen'],
  [/^braucht dich: ein Ergebnis im Chat$/, 'welten.zug.ergebnisImChat'],
  [/^braucht dich: eine Frage im Chat$/, 'welten.zug.frageImChat'],
  [/^braucht dich bei ([\s\S]+)$/, 'welten.zug.brauchtBei'],
  [/^pausiert mit der Welt$/, 'welten.zug.pausiertWelt'],
  [/^pausiert: ([\s\S]+)$/, 'welten.zug.pausiertGrund'],
  [/^arbeitet an ([\s\S]+)$/, 'welten.zug.arbeitetAn'],
  [/^Ergebnis zu ([\s\S]+) wartet auf Abnahme$/, 'welten.zug.ergebnisWartet'],
  [/^wartet bei ([\s\S]+)$/, 'welten.zug.wartetBei'],
  [/^schläft, ([\s\S]+) zurückgegeben$/, 'welten.zug.schlaeftZurueck'],
  [/^schläft, (\d+) Tickets offen$/, 'welten.zug.schlaeftTickets'],
  [/^schläft, ([\s\S]+) läuft$/, 'welten.zug.schlaeftLaeuft'],
  [/^schläft, ([\s\S]+) offen$/, 'welten.zug.schlaeftOffen'],
];
function zugText(roh: string): string {
  if (sprache() === 'de') return roh;
  for (const [muster, k] of ZUG_MUSTER) {
    const m = muster.exec(roh);
    if (m) return t(k, { a: anfuehrung(m[1] ?? '') });
  }
  return wort('zustand', roh);
}

const zweistellig = (n: number): string => String(n).padStart(2, '0');
function uhrzeit(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${zweistellig(d.getHours())}:${zweistellig(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : t('welten.zeit.datum', { tag: zweistellig(d.getDate()), monat: zweistellig(d.getMonth() + 1), uhr: hm });
}
function alter(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return t('welten.zeit.gerade');
  if (s < 3600) return t('welten.zeit.minuten', { n: Math.floor(s / 60) });
  if (s < 86400) return t('welten.zeit.stunden', { n: Math.floor(s / 3600) });
  return uhrzeit(iso);
}
// --- Das Lebenszeichen (Auftrag agentaktiv) ------------------------------------------------
// Der Kern liefert je Agent `leben` und `antwort` mit Zeiten; die laufende Uhr und die 30 Sekunden bis
// „nicht gestartet" rechnet die Ansicht, damit die Nutzlast nicht jede Sekunde anders aussieht.

/** Nach so vielen Millisekunden ohne Zugbeginn heisst eine zugestellte Nachricht „nicht gestartet". */
export const NICHT_GESTARTET_MS = 30_000;

/** m:ss, ab einer Stunde h:mm:ss, seit einer ISO-Zeit. */
export function dauerSeit(iso: string | null | undefined, jetzt = Date.now()): string {
  const d = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(d)) return '';
  const sek = Math.max(0, Math.floor((jetzt - d) / 1000));
  const h = Math.floor(sek / 3600);
  const m = Math.floor((sek % 3600) / 60);
  return h ? `${h}:${zweistellig(m)}:${zweistellig(sek % 60)}` : `${m}:${zweistellig(sek % 60)}`;
}

function grundWort(g: string | null | undefined): string { return g ? wort('grund', g) : ''; }

/**
 * Das Wort neben dem Avatar, wenn der Traeger etwas zu sagen hat: arbeitet seit, wartet auf den Traeger,
 * Traeger nicht erreichbar. null heisst: es gilt das Zustandswort (schläft, braucht dich, hat Ergebnis …).
 */
export function lebenWort(a: Pick<WeltAgent, 'leben' | 'zustand'>, jetzt = Date.now()): string | null {
  const l = a.leben;
  if (!l) return null;
  if (l.stand === 'arbeitet') return l.seit ? t('welten.leben.arbeitetSeit', { dauer: dauerSeit(l.seit, jetzt) }) : t('welten.leben.arbeitet');
  if (['braucht_dich', 'pausiert', 'gestoppt', 'archiviert'].includes(a.zustand)) return null;
  if (l.stand === 'wartet') return t('welten.leben.wartet');
  if (l.stand === 'nicht_erreichbar') return t('welten.leben.weg');
  return null;
}

/** Der Punkt zum Wort: steht das Lebenszeichen da, zeigt auch der Punkt es (arbeitet gefuellt, wartet hohl, weg aus). */
function agentPunkt(a: WeltAgent): string {
  if (lebenWort(a) === null) return zustandPunkt(a.zustand);
  return a.leben?.stand === 'arbeitet' ? 'laeuft' : a.leben?.stand === 'wartet' ? 'ruhig' : 'aus';
}

/** Das Wort neben dem Punkt: das Lebenszeichen, sonst das Zustandswort. */
function agentWort(a: WeltAgent, jetzt = Date.now()): string { return lebenWort(a, jetzt) ?? zustandWort(a.zustand); }

/**
 * Auftrag pausezaehler (10.10.2026): Die Zeile in der Seitenleiste sagt bei einem pausierten Agenten mit laufendem
 * Zug beides -- „pausiert · laufender Zug endet noch“ --, nicht nur „arbeitet seit …“ wie der Kopf. Sonst das Wort
 * neben dem Punkt wie ueberall.
 */
export function zeilenWort(a: Pick<WeltAgent, 'leben' | 'zustand' | 'zug'>, jetzt = Date.now()): string {
  if (pauseZeile(a)) return `${zustandWort('pausiert')} · ${t('welten.pause.zugEndet')}`;
  return lebenWort(a, jetzt) ?? zustandWort(a.zustand);
}
function pauseZeile(a: Pick<WeltAgent, 'zustand' | 'zug'>): boolean { return a.zustand === 'pausiert' && a.zug?.laeuft === true; }
/** Nachtrag pausezaehler: eine schmale Leiste kuerzt die Zeile; der volle Text steht dann im title, sonst keiner. */
function zeilenTitel(sp: HTMLElement, a: Pick<WeltAgent, 'zustand' | 'zug'>, text: string): void {
  if (pauseZeile(a)) { if (sp.title !== text) sp.title = text; } else if (sp.hasAttribute('title')) sp.removeAttribute('title');
}

/** Der Ring um die Figur: `arbeitet` (bewegt), `wartet` (gepunktet, still), sonst keiner. */
export function ringVon(a: Pick<WeltAgent, 'leben'>): '' | 'arbeitet' | 'wartet' {
  return a.leben?.stand === 'arbeitet' ? 'arbeitet' : a.leben?.stand === 'wartet' ? 'wartet' : '';
}

/** Der Stand unter der eigenen Nachricht; null, wenn keiner gilt. */
export function antwortText(a: Pick<WeltAgent, 'antwort' | 'name'>, jetzt = Date.now()): { text: string; art: string } | null {
  const st = a.antwort;
  if (!st) return null;
  if (st.stand === 'arbeitet') return { text: t('welten.antwort.arbeitet', { name: a.name }), art: 'arbeitet' };
  if (st.stand === 'beendet') return { text: t('welten.antwort.beendet', { grund: grundWort(st.grund) }), art: 'beendet' };
  if (st.stand === 'nicht_erreichbar') return { text: t('welten.antwort.weg'), art: 'weg' };
  const gesendet = Date.parse(st.zeit);
  if (!Number.isNaN(gesendet) && jetzt - gesendet >= NICHT_GESTARTET_MS) {
    return { text: st.grund ? t('welten.antwort.nichtGestartetGrund', { grund: grundWort(st.grund) }) : t('welten.antwort.nichtGestartet'), art: 'nicht_gestartet' };
  }
  const k = st.wecken === 'gestartet' ? 'welten.antwort.geweckt' : st.wecken === 'laeuft' ? 'welten.antwort.lief' : st.wecken === 'fehler' ? 'welten.antwort.nichtGeweckt' : 'welten.antwort.zugestellt';
  return { text: t(k), art: 'zugestellt' };
}

/** Der Punkt der Zeile unter der Nachricht: gefuellt beim Arbeiten, hohl beim Zustellen, sonst der Hinweis. */
function antwortPunkt(art: string): string { return art === 'arbeitet' ? 'laeuft' : art === 'zugestellt' ? 'ruhig' : 'will'; }

/** Ein Wort, dessen Text die Uhr jede Sekunde neu setzt (`uhrenStellen`). */
function uhrWort(klasse: string, agent: string, form: 'leben' | 'zeile' | 'antwort', text: string): HTMLSpanElement {
  const sp = el('span', klasse, text);
  sp.dataset.uhr = form;
  sp.dataset.agent = agent;
  return sp;
}

let uhr: ReturnType<typeof setInterval> | null = null;
/** Jede Sekunde: die Worte mit `data-uhr` neu setzen, ohne das Blatt neu zu zeichnen (Fokus und Auswahl bleiben). */
function uhrenStellen(): void {
  const w = welt();
  if (!blatt || !sichtbarAn || !w) return;
  const jetzt = Date.now();
  for (const sp of blatt.querySelectorAll<HTMLElement>('[data-uhr]')) {
    const a = agentVon(w, sp.dataset.agent ?? '');
    if (!a) continue;
    if (sp.dataset.uhr === 'leben' || sp.dataset.uhr === 'zeile') {
      const neu = sp.dataset.uhr === 'zeile' ? zeilenWort(a, jetzt) : agentWort(a, jetzt);
      if (sp.textContent !== neu) sp.textContent = neu;
      if (sp.dataset.uhr === 'zeile') zeilenTitel(sp, a, neu);
    } else {
      const at = antwortText(a, jetzt);
      const zeile = sp.closest<HTMLElement>('.wv-antwortstand');
      if (!at || !zeile) continue;
      if (sp.textContent !== at.text) sp.textContent = at.text;
      // Nach 30 Sekunden wechselt mit dem Wort auch die Art: Farbe und Punkt der Zeile folgen ihr.
      if (zeile.dataset.art !== at.art) {
        zeile.dataset.art = at.art;
        zeile.querySelector('.punkt')?.replaceWith(punkt(antwortPunkt(at.art)));
      }
    }
  }
}

/** Ein Umlauf des Bogens: ruhig genug fuer den Blick zur Seite, schnell genug, um Bewegung zu sehen. */
const ZUG_UMLAUF_MS = 1800;

const ZUG_STIL = `
#weltenblatt .wv-figur { position: relative; display: inline-flex; flex: 0 0 auto; }
#weltenblatt .wv-figur::before, #weltenblatt .wv-figur::after { content: ''; position: absolute; inset: -3px; border-radius: 50%; pointer-events: none; box-sizing: border-box; }
#weltenblatt .wv-figur.ring-arbeitet::before { border: 2px solid var(--zustand-laeuft); opacity: 0.28; }
#weltenblatt .wv-figur.ring-arbeitet::after { border: 2px solid transparent; border-top-color: var(--zustand-laeuft); border-right-color: var(--zustand-laeuft); animation: wv-zug-dreh ${ZUG_UMLAUF_MS}ms linear infinite; animation-delay: var(--wv-verzug, 0ms); }
#weltenblatt .wv-figur.ring-wartet::before { border: 1.5px dashed var(--gedaempft); }
#weltenblatt.ruhig .wv-figur.ring-arbeitet::after { animation: none; border-color: var(--zustand-laeuft); }
@media (prefers-reduced-motion: reduce) { #weltenblatt .wv-figur.ring-arbeitet::after { animation: none; border-color: var(--zustand-laeuft); } }
@keyframes wv-zug-dreh { to { transform: rotate(360deg); } }
#weltenblatt .wv-antwortstand { align-self: flex-end; margin-top: -6px; font-size: 11px; color: var(--gedaempft); display: flex; align-items: center; gap: 5px; }
#weltenblatt .wv-antwortstand[data-art="nicht_gestartet"], #weltenblatt .wv-antwortstand[data-art="beendet"], #weltenblatt .wv-antwortstand[data-art="weg"] { color: var(--zustand-wartet); }
#weltenblatt .wv-rantrag { display: flex; flex-direction: column; gap: 6px; padding: 9px 11px; border-radius: 9px; background: var(--fenster); }
#weltenblatt .wv-rantrag.offen { box-shadow: inset 0 0 0 1.5px var(--zustand-wartet); }
#weltenblatt .wv-rantrag-kopf { font-weight: 600; }
#weltenblatt .wv-rantrag-aenderung { display: flex; flex-direction: column; gap: 2px; padding: 6px 9px; border-radius: 7px; background: var(--erhoben); }
#weltenblatt .wv-rantrag-alt { color: var(--gedaempft); }
#weltenblatt .wv-rantrag-plus { color: var(--zustand-laeuft); }
#weltenblatt .wv-rantrag-minus { color: var(--zustand-tot); }
#weltenblatt .wv-rantrag-hinweis { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px 11px; border-radius: 9px; background: var(--erhoben); box-shadow: inset 0 0 0 1.5px var(--zustand-wartet); }
`;

function stufeWort(s: string): string { return wort('stufe', s); }
function teamWort(t: string): string { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
function zustandWort(zu: string): string { return wort('zustand', zu); }
function teamText(name: string): string { return t('welten.team', { name: teamWort(name) }); }
function zustandPunkt(zu: string): string {
  return zu === 'braucht_dich' ? 'will' : zu === 'arbeitet' ? 'laeuft' : zu === 'hat_ergebnis' ? 'fertig' : zu === 'pausiert' || zu === 'gestoppt' ? 'aus' : 'ruhig';
}
function ticketPunkt(stand: string): string {
  return stand === 'braucht dich' || stand === 'zur Abnahme' || stand === 'in Prüfung' ? 'will' : stand === 'läuft' ? 'laeuft' : stand === 'abgenommen' ? 'fertig' : stand === 'verworfen' || stand === 'unterbrochen' ? 'aus' : 'ruhig';
}
function zaehlerText(w: Welt): string {
  // Plan Satz 35: „braucht dich", Triage, laufende und offene Tickets getrennt.
  const b = w.zaehler.brauchen_dich; const l = w.zaehler.laufen; const o = w.zaehler.tickets_offen;
  return [t(b === 1 ? 'welten.zaehler.brauchtEins' : 'welten.zaehler.brauchenViele', { n: b }),
    t('welten.zaehler.triage', { n: w.zaehler.triage }),
    t(l === 1 ? 'welten.zaehler.laeuftEins' : 'welten.zaehler.laufenViele', { n: l }),
    t(o === 1 ? 'welten.zaehler.ticketEins' : 'welten.zaehler.ticketsViele', { n: o })].join(' · ');
}

// --- tickets4: die Worte des Ticketsystems (Plan Saetze 3, 5, 31, 40, 43, 50) --------------

function kindWort(k: string): string { return wort('kind', k); }
function kindErklaerung(k: string): string { return wort('kinderklaerung', k); }
function prioritaetWort(p: number): string { return t(`welten.prioritaet.p${p >= 0 && p <= 3 ? p : 2}`); }
function prioritaetText(p: number): string { return t(`welten.prioritaetText.p${p >= 0 && p <= 3 ? p : 2}`); }
/** 0 und 1 stehen hervorgehoben (Auftrag tickets4 A). */
const prioritaetHervor = (p: number): boolean => p <= 1;
function ampelWort(a: string): string { return a ? wort('ampel', a) : ''; }
function ampelPunkt(a: string): string { return a === 'rot' ? 'will' : a === 'gelb' ? 'fertig' : 'ruhig'; }
function verwerfGrundWort(g: string): string { return wort('verwerfgrund', g); }
function abnahmeGrundWort(g: string): string { return wort('abnahmegrund', g); }
function urteilWort(u: string): string { return wort('urteil', u); }
/** Eine Dauer in Sekunden als Wort (Plan Satz 50). */
function dauerWort(s: number): string {
  if (s < 60) return t('welten.dauer.sekunden', { n: s });
  if (s < 3600) return t('welten.dauer.minuten', { n: Math.floor(s / 60) });
  if (s < 86_400) return t('welten.dauer.stunden', { n: Math.floor(s / 3600) });
  const tage = Math.floor(s / 86_400);
  return t(tage === 1 ? 'welten.dauer.tagEins' : 'welten.dauer.tageViele', { n: tage });
}
/** „3 von 4", rot bei Überschreitung (Plan Satz 48). */
function wipText(w: Welt): { text: string; rot: boolean } {
  return { text: t('welten.wip.zaehler', { n: w.wip.laufend, m: w.wip.grenze }), rot: w.wip.grenze > 0 && w.wip.laufend > w.wip.grenze };
}
/**
 * DIE DEFINITION OF READY ALS VORSCHAU (Plan Satz 45, Auftrag tickets4 C). Dieselbe
 * Reihenfolge wie `_definition_of_ready_grund` in shell/agents_data.py; sie warnt, sie
 * blockt nicht. Leer heisst: das Ticket wird zugestellt.
 */
export function bereitschaftText(e: { kind: string; punkte: number; frist: string; runden: string; an: string; titel: string; ziel: string; fertig: string }): string {
  const leer = (s: string): boolean => !s.trim();
  if (leer(e.titel) || leer(e.ziel) || leer(e.fertig)) return t('welten.dor.auftrag');
  if (e.kind === 'vorhaben') return '';
  if (['story', 'task', 'subtask'].includes(e.kind) && e.punkte === 0) return t('welten.dor.liste');
  if (leer(e.frist) && leer(e.runden)) return t('welten.dor.grenzen');
  if (!e.an) return t('welten.dor.adressat');
  return '';
}
function anzeigename(w: Welt, id: string): string {
  if (id === 'mensch' || id === 'alice') return t('welten.name.du');
  if (id === 'cli-operator') return t('welten.name.steuerkanal');
  if (id === 'alle') return t('welten.name.alle');
  return w.agenten.find((a) => a.id === id)?.name ?? id;
}
function tokenKurz(n: number): string {
  const f = (x: number): string => (Math.round(x * 10) / 10).toFixed(1).replace('.', sprache() === 'de' ? ',' : '.');
  if (n >= 1_000_000) return `${f(n / 1_000_000)} M`;
  if (n >= 1000) return `${f(n / 1000)} k`;
  return String(Math.round(n));
}
export function messungZeile(m: WeltSkills['messungen'][number]): string {
  const teile = [t(m.anzahl === 1 ? 'welten.messung.zugEins' : 'welten.messung.zuegeViele', { n: m.anzahl }), t('welten.messung.mittel', { wert: tokenKurz(m.mittel) })];
  if (m.letzte.length) teile.push(t('welten.messung.letzte', { n: m.letzte.length, wert: tokenKurz(m.mittel_letzte), werte: m.letzte.map((x) => tokenKurz(x).replace(' k', '')).join(' · ') }));
  if (m.veraenderung !== null) teile.push(`${m.veraenderung < 0 ? '−' : '+'}${Math.round(Math.abs(m.veraenderung) * 100)} %`);
  return teile.join(' · ');
}

// --- Maschinen (Auftrag fernwelten) ------------------------------------------------------

function maschineWort(m: string): string { return m === 'mac' ? 'Mac' : m; }

/** Die Maschinen, auf denen eine neue Welt entstehen kann: die eigene und die Agent-Maschinen mit Traeger, Standard zuerst. */
function neuWege(n: WeltenNutzlast | null): WeltMaschine[] {
  const ms = (n?.maschinen ?? []).filter((m) => m.eigene || m.traeger);
  return [...ms.filter((m) => m.standard), ...ms.filter((m) => !m.standard)];
}

/**
 * Die Vorgabe beim Anlegen: die Standardmaschine, sobald sie als erreichbar belegt ist, sonst die eigene.
 * Gefragt wird erst auf einen echten Klick (`welt-neu-offen`, Wahl der Maschine); ein nachgestellter Klick
 * einer Suite erreicht so nie eine fremde Maschine.
 */
export function maschineVorgabe(ms: WeltMaschine[], vorgabe: string): string {
  const eigene = ms.find((m) => m.eigene)?.name ?? '';
  const m = ms.find((x) => x.name === vorgabe && !x.eigene && x.traeger);
  return m && m.erreichbar === true ? m.name : eigene;
}

function neuMaschine(n: WeltenNutzlast | null): string {
  const wege = neuWege(n);
  if (z.weltNeuMaschine && wege.some((m) => m.name === z.weltNeuMaschine)) return z.weltNeuMaschine;
  return maschineVorgabe(n?.maschinen ?? [], n?.maschine_vorgabe ?? '');
}

function neuMaschineText(n: WeltenNutzlast | null, name: string): string {
  const m = n?.maschinen.find((x) => x.name === name);
  if (!m) return '';
  if (m.eigene) return m.traeger ? t('welten.neu.maschineHier') : m.name === 'mac' ? t('welten.neu.maschineMac') : t('welten.neu.maschineOhneTraeger', { maschine: maschineWort(m.name) });
  if (m.erreichbar === false) return t('welten.neu.maschineWeg', { maschine: m.name, text: m.text });
  if (m.erreichbar === null) return t('welten.neu.maschineFrage', { maschine: m.name });
  return t('welten.neu.maschineFern', { maschine: m.name });
}

/** Was der Welt fehlt, damit ihre Agenten antworten; null, wenn nichts fehlt. */
export function maschinenHinweis(w: Pick<Welt, 'maschine' | 'verbindung' | 'traeger'>): { text: string; weg: boolean } | null {
  if (!w.maschine) return null;
  const m = maschineWort(w.maschine);
  if (!w.verbindung.ok) return { text: t('welten.maschine.hinweisWeg', { maschine: m, zeit: uhrzeit(w.verbindung.seit) }), weg: true };
  if (!w.traeger.moeglich) return { text: w.maschine === 'mac' ? t('welten.maschine.hinweisMac') : t('welten.maschine.hinweisOhneTraeger', { maschine: m }), weg: false };
  if (!w.traeger.eingerichtet) return { text: t('welten.maschine.hinweisNichtEingerichtet', { maschine: m }), weg: false };
  return null;
}

function traegerWort(w: Welt): string {
  if (!w.traeger.eingerichtet) return t(w.traeger.moeglich ? 'welten.maschine.traegerFehlt' : 'welten.maschine.traegerUnmoeglich');
  return t(w.traeger.laeuft === true ? 'welten.maschine.traegerLaeuft' : w.traeger.laeuft === false ? 'welten.maschine.traegerSchlaeft' : 'welten.maschine.traegerEingerichtet');
}

function maschinenBand(w: Welt, n: WeltenNutzlast): HTMLElement | null {
  const h = maschinenHinweis(w);
  if (!h) return null;
  const band = el('div', `wv-meldung wv-maschinenband${h.weg ? ' abgelehnt' : ''}`);
  band.append(punkt(h.weg ? 'will' : 'ruhig'), el('span', 'wv-meldung-text', h.text));
  const ziel = n.maschinen.find((m) => m.name === n.maschine_vorgabe && !m.eigene && m.traeger) ?? n.maschinen.find((m) => !m.eigene && m.traeger);
  if (!w.fern && !w.traeger.moeglich && ziel) {
    const k = knopf(t('welten.maschine.umziehen', { maschine: ziel.name }), 'umziehen', ziel.name, 'knopf-rand', z.laufend.has('umziehen'));
    k.title = t('welten.maschine.umziehenText');
    band.appendChild(k);
  }
  return band;
}

// --- Welt, Auswahl, Ungelesen --------------------------------------------------------

function welt(): Welt | null {
  const n = nutzlast;
  if (!n) return null;
  if (z.weltWunsch) {
    const neu = n.welten.find((w) => w.pfad === z.weltWunsch);
    if (neu) { z.weltPfad = neu.pfad; z.weltWunsch = ''; z.auswahl = KANAL; return neu; }
  }
  return n.welten.find((w) => w.pfad === z.weltPfad) ?? n.welten.find((w) => !w.fehler.length) ?? n.welten[0] ?? null;
}
function agentId(): string { return z.auswahl.startsWith('agent:') ? z.auswahl.slice(6) : ''; }
function agentVon(w: Welt, id: string): WeltAgent | undefined { return w.agenten.find((a) => a.id === id); }
function gespraechSchluessel(): string {
  const a = agentId();
  if (!a) return KANAL;
  return z.gespraech === EINZEL ? `einzel:${a}` : `direkt:${z.gespraech}`;
}
function nachrichtenVon(w: Welt, schluessel: string): WeltNachricht[] {
  if (schluessel === KANAL) return w.kanal;
  if (schluessel.startsWith('einzel:')) {
    return (agentVon(w, schluessel.slice(7))?.einzelchat ?? []).map((e) => e.nachricht).filter((n): n is WeltNachricht => !!n);
  }
  return w.direktchats.find((c) => c.id === schluessel.slice(7))?.nachrichten ?? [];
}
const neuer = (a?: { zeit: string; id: string }, b?: { zeit: string; id: string }): { zeit: string; id: string } | undefined => {
  if (!a) return b;
  if (!b) return a;
  return a.zeit > b.zeit || (a.zeit === b.zeit && a.id >= b.id) ? a : b;
};
export function ungelesen(w: Welt, schluessel: string): number {
  const marke = neuer(w.mensch.gelesen[schluessel], z.gelesen.get(`${w.id}|${schluessel}`));
  return nachrichtenVon(w, schluessel).filter((n) => !n.von_mensch && (!marke || n.zeit > marke.zeit || (n.zeit === marke.zeit && n.id > marke.id))).length;
}
function gesehen(w: Welt, echt: boolean): void {
  if (!sichtbarAn) return;
  const k = gespraechSchluessel();
  if (z.reiter !== 'chat' && k !== KANAL) return;
  const liste = nachrichtenVon(w, k);
  if (!liste.length) return;
  const letzte = liste.reduce((a, b) => (b.zeit > a.zeit || (b.zeit === a.zeit && b.id > a.id) ? b : a));
  const lokal = `${w.id}|${k}`;
  const alt = z.gelesen.get(lokal);
  if (!alt || letzte.zeit > alt.zeit || (letzte.zeit === alt.zeit && letzte.id > alt.id)) z.gelesen.set(lokal, { zeit: letzte.zeit, id: letzte.id });
  const imWelt = w.mensch.gelesen[k];
  if (imWelt && (imWelt.zeit > letzte.zeit || (imWelt.zeit === letzte.zeit && imWelt.id >= letzte.id))) return;
  void ausfuehren('gelesen', { welt: w.pfad, gespraech: k, zeit: letzte.zeit, id: letzte.id }, echt, false, true);
}

// --- Handlungen ------------------------------------------------------------------------

async function ausfuehren(handlung: string, daten: Record<string, unknown>, echt: boolean, bestaetigt = false, still = false): Promise<Antwort> {
  if (!bruecke) return { ok: false, meldung: t('welten.meldung.keinKern') };
  z.laufend.add(handlung);
  if (!still) zeichnen();
  let r: Antwort;
  try {
    r = (await bruecke.handlung(`welt:${handlung} ${JSON.stringify(daten)}`, { echt, bestaetigt })) as Antwort;
  } catch (e) {
    r = { ok: false, meldung: String((e as Error)?.message ?? e) };
  }
  z.laufend.delete(handlung);
  if (r.rueckfrage && !bestaetigt) {
    z.rueckfrage = { handlung, daten, text: r.rueckfrage, warnungen: r.warnungen ?? [], echt };
  } else if (handlung === 'gelesen' && !r.ok) {
    // Der Lesestand geht im Hintergrund mit (jede neue Nutzlast, jede Wahl), nie auf einen
    // Klick des Menschen. Scheitert er -- Steuerkanal (cli-operator darf ihn nie setzen) oder
    // ein Kern ohne M2 (Dev-Buendel, Worktree, Test seit dem strengen wb-mensch, 14.10.2026) --,
    // ueberschrieb seine spaete Antwort die Meldung der Handlung, die der Mensch gerade sah.
    // Die lokale Marke traegt die Anzeige weiter; der Grund geht ins Protokoll.
    console.warn(`Lesestand nicht geteilt: ${r.meldung ?? ''}`);
  } else if (!(still && r.ok)) {
    z.meldung = { text: r.meldung ?? '', ok: !!r.ok };
  }
  zeichnen();
  return r;
}

function waehlen(ziel: string, w: Welt, echt: boolean): void {
  z.auswahl = ziel;
  z.gespraech = EINZEL;
  z.ticketAuswahl = '';
  z.rueckgabe = '';
  z.anlegen = null;
  if (z.profil && z.profil.agent !== agentId()) z.profil = null;
  if (z.gedaechtnis && z.gedaechtnis.agent !== agentId()) z.gedaechtnis = null;
  zeichnen();
  gesehen(w, echt);
}

function adressenLesen(w: Welt, text: string): { an: string[]; fehler: string } {
  const teile = text.split(/[\s,]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean);
  if (!teile.length) return { an: [], fehler: t('welten.adresse.fehlt') };
  const an: string[] = [];
  for (const roh of teile) {
    const klein = roh.toLowerCase();
    let id = '';
    if (klein === 'alle') id = 'alle';
    else if (klein.startsWith('team:') && w.teams.some((x) => x.name === klein.slice(5))) id = klein;
    else if (w.teams.some((x) => x.name === klein)) id = `team:${klein}`;
    else if (w.agenten.some((a) => a.id === klein)) id = klein;
    if (!id) return { an: [], fehler: t('welten.adresse.unbekannt', { name: roh, welt: w.name }) };
    if (!an.includes(id)) an.push(id);
  }
  if (an.includes('alle') && an.length > 1) return { an: [], fehler: t('welten.adresse.alleAllein') };
  return { an, fehler: '' };
}

async function senden(w: Welt, echt: boolean): Promise<void> {
  const k = gespraechSchluessel();
  const text = (z.entwuerfe.get(k) ?? '').trim();
  if (!text) return;
  const a = agentId();
  let r: Antwort;
  if (a) {
    r = await ausfuehren('senden', { welt: w.pfad, an: [a], text, direkt: true }, echt);
  } else {
    const ad = adressenLesen(w, z.adressfeld || (w.hauptagent ? `@${w.hauptagent}` : ''));
    if (ad.fehler) { z.meldung = { text: ad.fehler, ok: false }; zeichnen(); return; }
    r = await ausfuehren('senden', { welt: w.pfad, an: ad.an, text }, echt);
  }
  if (r.ok) { z.entwuerfe.delete(k); zeichnen(); }
}

function entwurfLeer(): Entwurf {
  return { id: '', stufe: 'mitglied', team: '', spezialgebiet: '', modell: 'sonnet', denkstufe: 'high', fallback: '', fallbackDenkstufe: '', maschine: 'peer',
    werkzeuge: [...WERKZEUGE_VORGABE], bash: '', skills: '', kontextgrenze: '', figurArt: 'roboter', figurFarbe: 'entwicklung', anweisungen: '', vorlage: '', modellGenau: false };
}
const basis = (m: string): string => m.split(':')[0] ?? m;
const suffix = (m: string): string => (m.includes(':') ? m.split(':')[1] : '');
const mitStufe = (m: string, s: string): string => (basis(m) ? (s ? `${basis(m)}:${s}` : basis(m)) : '');
export function entwurfAus(j: Record<string, unknown>, genau = false): Entwurf {
  const s = (k: string): string => (typeof j[k] === 'string' ? (j[k] as string) : '');
  const l = (k: string): string[] => (Array.isArray(j[k]) ? (j[k] as unknown[]).map(String) : []);
  const f = (j.figure ?? {}) as { family?: string; color?: string };
  return {
    id: s('id'), stufe: s('stage') || 'mitglied', team: s('team'), spezialgebiet: s('specialty'),
    modell: genau ? s('model') : basis(s('model')), denkstufe: s('effort') || suffix(s('model')), fallback: genau ? s('fallback_model') : basis(s('fallback_model')),
    fallbackDenkstufe: s('fallback_effort') || suffix(s('fallback_model')), maschine: s('machine'), werkzeuge: l('tools'),
    // Auftrag agentsform: im Formular stehen nur die eigenen Muster; die Dienstwegmuster gibt die Bibliothek ohnehin dazu.
    bash: eigeneMuster(l('bash'), s('stage') || 'mitglied').join('\n'), skills: l('skills').join(', '), kontextgrenze: s('context_limit'),
    figurArt: f.family || 'roboter', figurFarbe: f.color || 'entwicklung', anweisungen: s('instructions'), vorlage: s('template'), modellGenau: genau,
  };
}
/** Was als `model` hinausgeht: woertlich aus der Modellliste der Welt, sonst Basis mit Denkstufe. */
export function modellText(m: string, stufe: string, genau: boolean): string { return genau ? m : mitStufe(m, stufe); }
export function entwurfJson(e: Entwurf): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  const setze = (k: string, v: string): void => { const x = v.trim(); if (x) j[k] = x; };
  setze('id', e.id); setze('stage', e.stufe); if (e.stufe !== 'hauptagent') setze('team', e.team);
  setze('specialty', e.spezialgebiet); setze('model', modellText(e.modell, e.denkstufe, e.modellGenau)); setze('effort', e.denkstufe);
  if (e.fallback) { setze('fallback_model', modellText(e.fallback, e.fallbackDenkstufe, e.modellGenau)); setze('fallback_effort', e.fallbackDenkstufe); }
  setze('machine', e.maschine); setze('context_limit', e.kontextgrenze); setze('template', e.vorlage);
  j.tools = [...e.werkzeuge];
  j.bash = e.werkzeuge.includes('Bash') ? e.bash.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  j.skills = e.skills.split(',').map((x) => x.trim()).filter(Boolean);
  j.figure = { family: e.figurArt, color: e.figurFarbe };
  if (e.anweisungen.trim()) j.instructions = e.anweisungen;
  return j;
}
const VORGABE_FELDER: Record<string, string[]> = {
  name: ['id'], stufe: ['stage'], team: ['team'], spezialgebiet: ['specialty'], modell: ['model', 'effort'], denkstufe: ['model', 'effort'],
  fallback: ['fallback_model', 'fallback_effort'], maschine: ['machine'], werkzeuge: ['tools', 'bash'], bash: ['bash'], skills: ['skills'],
  kontextgrenze: ['context_limit'], figur: ['figure'], farbe: ['figure'], anweisungen: ['instructions'],
};
function vorgaben(a: Anlegen): Record<string, unknown> {
  const j = entwurfJson(a.entwurf);
  const raus: Record<string, unknown> = {};
  for (const f of a.gesetzt) for (const k of VORGABE_FELDER[f] ?? []) if (k in j) raus[k] = j[k];
  return raus;
}

let anlegenSitzung = 0;
function anlegenOeffnen(w: Welt, vorlage?: string, ansicht: Anlegen['ansicht'] = 'formular'): void {
  const e = entwurfLeer();
  e.team = w.teams[0]?.name ?? '';
  if (!w.hauptagent) { e.stufe = 'hauptagent'; e.team = ''; }
  // Auftrag fernwelten: ein Agent laeuft, wo seine Welt liegt; seit agentsform auf der Traegermaschine der Welt.
  e.maschine = agentMaschine(w, e.maschine);
  // Auftrag agentsform: mit einer Modellliste der Welt gehen die Kennungen woertlich hinaus; die Vorgabe ist die erste verfuegbare.
  if (w.modelle) {
    e.modellGenau = true;
    const m = w.modelle.find((x) => x.verfuegbar && x.id === mitStufe(e.modell, e.denkstufe)) ?? w.modelle.find((x) => x.verfuegbar);
    if (m) { e.modell = m.id; if (suffix(m.id)) e.denkstufe = suffix(m.id); }
  }
  z.anlegen = {
    entwurf: e, beschreibung: '', modell: nutzlast?.entwurf_modelle[0] ?? 'sonnet:high', neuesTeam: !w.teams.length, gesetzt: new Set(), pruefung: '', info: '',
    ansicht, verlauf: [], eingabe: '', gFelder: [], gFragen: [], gFertig: false, gInfo: '', sitzung: ++anlegenSitzung,
  };
  z.meldung = null;
  z.inspektor = true;
  if (vorlage) vorlageAnwenden(w, vorlage);
}
function vorlageAnwenden(w: Welt, name: string): void {
  const v = nutzlast?.vorlagen.find((x) => x.name === name);
  if (!z.anlegen || !v) return;
  const e = entwurfAus(v.draft);
  let id = e.id;
  let n = 2;
  while (w.agenten.some((a) => a.id === id)) id = `${e.id}-${n++}`;
  e.id = id;
  e.vorlage = v.name;
  e.maschine = agentMaschine(w, e.maschine);
  if (w.modelle) {
    e.modell = mitStufe(e.modell, e.denkstufe);
    if (e.fallback) e.fallback = mitStufe(e.fallback, e.fallbackDenkstufe);
    e.modellGenau = true;
  }
  z.anlegen.entwurf = e;
  z.anlegen.neuesTeam = !w.teams.some((t) => t.name === e.team);
  z.anlegen.gesetzt = new Set();
  z.anlegen.pruefung = '';
  z.anlegen.info = t('welten.anlegen.ausVorlage', { titel: v.title });
}
async function vorschlag(w: Welt, echt: boolean, trocken = false): Promise<void> {
  const a = z.anlegen;
  if (!a) return;
  if (!a.beschreibung.trim()) { z.meldung = { text: t('welten.anlegen.beschreibungFehlt'), ok: false }; zeichnen(); return; }
  const daten: Record<string, unknown> = { welt: w.pfad, beschreibung: a.beschreibung.trim(), modell: a.modell, vorgaben: vorgaben(a) };
  if (trocken) daten.trocken = true;
  const r = await ausfuehren('vorschlag', daten, echt);
  if (!r.ok || !z.anlegen) return;
  if (trocken) { z.anlegen.info = r.meldung ?? ''; zeichnen(); return; }
  if (r.entwurf) {
    const gesetzt = z.anlegen.gesetzt;
    z.anlegen.entwurf = entwurfAus(r.entwurf, z.anlegen.entwurf.modellGenau);
    if (r.anweisungen) z.anlegen.entwurf.anweisungen = r.anweisungen;
    z.anlegen.gesetzt = gesetzt;
    z.anlegen.neuesTeam = !!z.anlegen.entwurf.team && !w.teams.some((t) => t.name === z.anlegen!.entwurf.team);
  }
  z.anlegen.pruefung = r.pruefung ?? '';
  const kosten = typeof r.kosten === 'number' ? ` · ${r.kosten.toFixed(3)} $` : '';
  z.anlegen.info = t('welten.anlegen.vorschlagVon', { kennung: r.aufruf?.kennung ?? a.modell, stufe: r.aufruf?.stufe ?? '', kosten });
  zeichnen();
}
async function pruefen(w: Welt, echt: boolean, ausVorlage = false): Promise<void> {
  const a = z.anlegen;
  if (!a) return;
  const e = entwurfJson(a.entwurf);
  if (ausVorlage) delete e.instructions;
  const r = await ausfuehren('entwurf', { welt: w.pfad, entwurf: e }, echt);
  if (!z.anlegen) return;
  z.anlegen.pruefung = r.ok ? '' : (r.pruefung ?? r.meldung ?? '');
  if (r.ok && ausVorlage && r.anweisungen) { z.anlegen.entwurf.anweisungen = r.anweisungen; z.anlegen.gesetzt.add('anweisungen'); }
  zeichnen();
}
async function anlegenSichern(w: Welt, echt: boolean): Promise<void> {
  const a = z.anlegen;
  if (!a) return;
  const id = a.entwurf.id.trim();
  const r = await ausfuehren('anlegen', { welt: w.pfad, entwurf: entwurfJson(a.entwurf) }, echt);
  if (r.ok) {
    z.anlegen = null;
    z.auswahl = `agent:${id}`;
    z.gespraech = EINZEL;
    z.blatt = 'profil';
  } else if (z.anlegen) {
    z.anlegen.pruefung = r.meldung ?? '';
  }
  zeichnen();
}

/** Ein Zug des Gespraechs (`welt:gespraech`): Nachricht, Entwurf und Vorgaben an den Kern; zurueck kommen Verlauf und Entwurf. */
async function gespraechSenden(w: Welt, echt: boolean, trocken = false): Promise<void> {
  const a = z.anlegen;
  if (!a) return;
  const text = a.eingabe.trim();
  if (!text) { z.meldung = { text: t('welten.anlegen.nachrichtFehlt'), ok: false }; zeichnen(); return; }
  const daten: Record<string, unknown> = { welt: w.pfad, text, modell: a.modell, entwurf: entwurfJson(a.entwurf), vorgaben: vorgaben(a), neu: !a.verlauf.length };
  if (trocken) daten.trocken = true;
  // Still: ein gelungener Zug zeigt kein Meldungsband, nur den Verlauf. Gezeichnet wird trotzdem
  // sofort, damit „antwortet …" steht (`laufend` ist beim Aufruf schon gesetzt).
  const lauf = ausfuehren('gespraech', daten, echt, false, true);
  zeichnen();
  const r = await lauf;
  const jetzt = z.anlegen;
  if (!r.ok || !jetzt || jetzt.sitzung !== a.sitzung) return;
  if (trocken) { jetzt.gInfo = r.meldung ?? ''; zeichnen(); return; }
  if (r.entwurf) {
    // Was der Mensch waehrend des Zuges im Formular gesetzt hat, bleibt stehen.
    const neu = entwurfAus({ ...r.entwurf, ...vorgaben(jetzt) }, jetzt.entwurf.modellGenau);
    neu.vorlage = neu.vorlage || jetzt.entwurf.vorlage;
    jetzt.entwurf = neu;
    jetzt.neuesTeam = !!neu.team && !w.teams.some((x) => x.name === neu.team);
  }
  jetzt.verlauf = r.verlauf ?? [];
  jetzt.gFelder = r.felder ?? [];
  jetzt.gFragen = r.fragen ?? [];
  jetzt.gFertig = r.fertig === true;
  jetzt.pruefung = r.pruefung ?? '';
  const kosten = typeof r.kosten === 'number' ? ` · ${r.kosten.toFixed(3)} $` : '';
  jetzt.gInfo = t('welten.anlegen.antwortVon', { kennung: r.aufruf?.kennung ?? a.modell, stufe: r.aufruf?.stufe ?? '', kosten });
  if (jetzt.eingabe.trim() === text) jetzt.eingabe = '';
  zeichnen();
  const liste = blatt?.querySelector<HTMLElement>('.wv-gespraech');
  if (liste) liste.scrollTop = liste.scrollHeight;
}

/** „Abbrechen": das Menue geht zu; ein Gespraech wird im Kern verworfen. */
function anlegenAbbrechen(w: Welt, echt: boolean): void {
  const mitGespraech = !!z.anlegen?.verlauf.length;
  z.anlegen = null;
  z.meldung = null;
  if (mitGespraech) void ausfuehren('gespraech', { welt: w.pfad, verwerfen: true }, echt, false, true);
}

/** „Zuletzt gesetzt: …" in den Worten des Formulars. */
function feldWorte(felder: string[]): string {
  return felder.map((f) => t(`welten.entwurfsfeld.${f}`)).join(', ');
}

async function profilSichern(w: Welt, echt: boolean): Promise<void> {
  const p = z.profil;
  const a = p && agentVon(w, p.agent);
  if (!p || !a) return;
  const d: Record<string, unknown> = { welt: w.pfad, agent: a.id };
  if (p.modell !== a.modell) d.modell = p.modell;
  if (p.denkstufe !== a.denkstufe) d.denkstufe = p.denkstufe;
  if (p.fallback !== a.fallback) d.fallback = p.fallback;
  if (p.fallbackDenkstufe !== a.fallback_denkstufe) d.fallback_denkstufe = p.fallbackDenkstufe;
  if (p.maschine !== a.maschine) d.maschine = p.maschine;
  if (p.spezialgebiet !== a.spezialgebiet) d.spezialgebiet = p.spezialgebiet;
  if (Object.keys(d).length === 2) { z.profil = null; zeichnen(); return; }
  const r = await ausfuehren('profil', d, echt);
  if (r.ok) { z.profil = null; zeichnen(); }
}

/** `welt:neu`: die neue Welt ist danach gewaehlt; ohne Hauptagenten laedt die Mitte zu ihm ein. */
async function weltAnlegen(global: boolean, echt: boolean): Promise<void> {
  const ordner = z.weltNeuOrdner.trim();
  if (!global && !ordner) { z.meldung = { text: t('welten.neu.ordnerFehlt'), ok: false }; zeichnen(); return; }
  const daten: Record<string, unknown> = global ? { art: 'global' } : { art: 'projekt', ordner };
  if (neuWege(nutzlast).length > 1) daten.maschine = neuMaschine(nutzlast);
  const r = await ausfuehren('neu', daten, echt);
  if (!r.ok) return;
  // Die Nutzlast mit der neuen Welt kommt gleich nach; bis dahin haelt `weltWunsch` die Wahl fest.
  if (r.pfad) { z.weltPfad = r.pfad; z.weltWunsch = r.pfad; z.auswahl = KANAL; z.anlegen = null; z.ticketAuswahl = ''; }
  z.weltNeuOffen = false;
  z.weltNeuOrdner = '';
  z.weltNeuMaschine = '';
  zeichnen();
}

// --- Rechte und Modelle (Auftrag agentsform) ------------------------------------------------

/** Die Maschine eines neuen Agenten: die Traegermaschine der Welt (`maschine_vorgabe`), sonst die Maschine ihrer Ablage. */
export function agentMaschine(w: Pick<Welt, 'maschine' | 'maschine_vorgabe'>, sonst = ''): string {
  return w.maschine_vorgabe || w.maschine || sonst;
}

/** Die Dienstwegmuster einer Stufe, wie die Bibliothek sie jedem Agenten gibt. */
function dienstweg(stufe: string): string[] {
  return nutzlast?.bash_vorgabe?.[stufe] ?? nutzlast?.bash_vorgabe?.mitglied ?? [];
}

/** Die eigenen Bash-Muster: ohne die Dienstwegmuster der Stufe und ohne Leerzeilen. */
export function eigeneMuster(muster: string[], stufe: string, vorgabe: string[] = dienstweg(stufe)): string[] {
  return muster.map((m) => m.trim()).filter((m) => m && !vorgabe.includes(m));
}

/** Die Modelle fuer Modell und Fallback: die der Welt (nicht verfuegbare gesperrt, mit Grund), sonst die Registry. */
export function modellOptionen(w: Pick<Welt, 'modelle'>, registry: WeltenNutzlast['modelle'], eigene: string[]): { optionen: [string, string][]; gesperrt: Set<string> } {
  const optionen: [string, string][] = [];
  const gesperrt = new Set<string>();
  const gesehen = new Set<string>();
  if (w.modelle) {
    // Die Kennung der Welt woertlich: der Traeger sucht genau diesen Namen.
    for (const m of w.modelle) {
      if (gesehen.has(m.id)) continue;
      gesehen.add(m.id);
      optionen.push([m.id, m.verfuegbar ? `${m.id} · ${m.harness}` : `${m.id} · ${t('welten.modell.nichtVerfuegbar', { grund: m.grund ? wort('modellgrund', m.grund) : '–' })}`]);
      if (!m.verfuegbar) gesperrt.add(m.id);
    }
  } else {
    for (const m of registry) { const b = basis(m.kennung); if (!gesehen.has(b)) { gesehen.add(b); optionen.push([b, `${b} · ${m.harness}`]); } }
  }
  for (const e of eigene) if (e && !gesehen.has(e)) { gesehen.add(e); optionen.push([e, e]); }
  return { optionen, gesperrt };
}

/** Der Befehl, mit dem der Mensch einer Welt einen Zugang der Art web gibt. */
function webBefehl(w: Welt): string {
  return `wb-welt zugang ${w.ablage || w.pfad} hinzufuegen --art web --name netz --bestaetigt`;
}

/**
 * Was ein Agent darf, als Zeilen einer Karte -- dieselben im Formular, im Gespraech und im Profil:
 * Werkzeuge (Bash fest als Dienstweg), Web nur mit Zugang, eigene Bash-Muster ueber den festen
 * Dienstwegmustern, Skills der Welt und der Bibliothek. `bereich` ist `anlegen` oder `rechte`.
 */
function rechteZeilen(w: Welt, r: { werkzeuge: string[]; bash: string; skills: string[]; stufe: string }, bereich: 'anlegen' | 'rechte'): HTMLElement[] {
  const zeile = (name: string, ...inhalt: (HTMLElement | null)[]): HTMLElement => {
    const z2 = el('div', 'wv-formzeile');
    z2.appendChild(el('span', 'wv-formname', name));
    const rechts = el('div', 'wv-formwert');
    for (const i of inhalt) if (i) rechts.appendChild(i);
    z2.appendChild(rechts);
    return z2;
  };
  const wahl = (text: string, w2: string, arg: string, an: boolean, aus = false): HTMLButtonElement => {
    const b = knopf(text, w2, arg, an ? 'wv-wahl an' : 'wv-wahl', aus);
    b.setAttribute('aria-pressed', String(an));
    return b;
  };
  const werkzeuge = el('div', 'wv-werkzeuge');
  const bash = wahl(t('welten.rechte.bashFest'), `${bereich}-werkzeug`, 'Bash', true, true);
  bash.title = t('welten.rechte.bashFestTipp');
  werkzeuge.appendChild(bash);
  for (const x of WERKZEUGE) werkzeuge.appendChild(wahl(x, `${bereich}-werkzeug`, x, r.werkzeuge.includes(x)));
  let web: HTMLElement;
  if (w.web_zugang) {
    web = el('div', 'wv-werkzeuge');
    for (const x of WEB) web.appendChild(wahl(x, `${bereich}-werkzeug`, x, r.werkzeuge.includes(x)));
  } else {
    web = el('div', 'wv-leise wv-rechte-web');
    web.append(el('span', undefined, t('welten.rechte.webOhne')), el('code', 'wv-mono wv-befehl', webBefehl(w)));
  }
  const fest = dienstweg(r.stufe);
  const muster = el('div', 'wv-rechte-muster');
  const eigene = feld('textarea', `${bereich}:bash`, r.bash, t('welten.rechte.bashPlatzhalter'));
  (eigene as HTMLTextAreaElement).rows = 2;
  muster.appendChild(eigene);
  const festBox = el('div', 'wv-rechte-fest');
  festBox.appendChild(el('div', 'wv-leise klein', fest.length ? t('welten.rechte.dienstweg', { n: fest.length }) : t('welten.rechte.dienstwegUnbekannt')));
  for (const m of fest) festBox.appendChild(el('div', 'wv-mono wv-rechte-festzeile', m));
  muster.appendChild(festBox);
  const skills = el('div', 'wv-rechte-skills');
  const katalog = [...w.skill_katalog.welt.map((k) => ({ ...k, ebene: 'welt' })), ...w.skill_katalog.bibliothek.map((k) => ({ ...k, ebene: 'bibliothek' }))];
  const namen = new Set(katalog.map((k) => k.name));
  for (const k of katalog) {
    const b = wahl(`${k.name} · ${wort('ebene', k.ebene)}`, `${bereich}-skill`, k.name, r.skills.includes(k.name));
    b.title = k.beschreibung;
    skills.appendChild(b);
  }
  for (const name of r.skills.filter((x) => !namen.has(x))) skills.appendChild(wahl(t('welten.rechte.skillFremd', { name }), `${bereich}-skill`, name, true));
  if (!skills.childElementCount) skills.appendChild(el('span', 'wv-leise', t('welten.rechte.keineSkills')));
  return [
    zeile(t('welten.feld.werkzeuge'), werkzeuge),
    zeile(t('welten.rechte.web'), web),
    zeile(t('welten.feld.bash'), muster),
    zeile(t('welten.blatt.skills'), skills),
  ];
}

/** Die Rechte in einer Zeile: fuer den zugeklappten Stand im Gespraech und das Profil. */
export function rechteKurz(r: { werkzeuge: string[]; bash: string[]; skills: string[] }, festAnzahl: number): string {
  const wz = ['Bash', ...r.werkzeuge.filter((x) => x !== 'Bash')];
  return t('welten.rechte.kurz', { werkzeuge: wz.join(', '), eigene: r.bash.length, fest: festAnzahl, skills: r.skills.join(', ') || '–' });
}

/** Ob und wie „Agent anlegen" geht; der Grund steht als Text da, nicht nur im Schildchen. */
export function anlegenLage(w: Pick<Welt, 'hauptagent' | 'stand' | 'fehler'>): { titel: string; aktiv: boolean; grund: string } {
  const titel = t(w.hauptagent ? 'welten.anlegen.titel' : 'welten.anlegen.hauptagent');
  if (w.fehler.length) return { titel, aktiv: false, grund: t('welten.anlegen.grundFehler') };
  if (w.stand === 'läuft') return { titel, aktiv: true, grund: '' };
  return { titel, aktiv: false, grund: t('welten.anlegen.weltSteht', { stand: wort('stand', w.stand) }) };
}

/** Auftrag agentsform: „Ordner wählen …" -- der Dialog des Systems (main.ts), danach wie „Welt anlegen". */
async function ordnerDialogUndAnlegen(echt: boolean): Promise<void> {
  if (!bruecke?.ordnerWaehlen) { z.meldung = { text: t('welten.neu.dialogFehlt'), ok: false }; zeichnen(); return; }
  const r = await bruecke.ordnerWaehlen(echt);
  if (!r.pfad) { if (r.grund) { z.meldung = { text: r.grund, ok: false }; zeichnen(); } return; }
  z.weltNeuOrdner = r.pfad;
  await weltAnlegen(false, echt);
}

/** Die Wege zu einer neuen Welt: Projektordner als Text oder Global. Leiste und Leerzustand zeigen dasselbe. */
function weltNeuZeichnen(n: WeltenNutzlast | null): HTMLElement {
  const box = el('div', 'wv-weltneu');
  // Auftrag fernwelten: wo die Welt entsteht; gefragt werden die Maschinen auf einen echten Klick (`maschinenFragen`).
  const wege = neuWege(n);
  if (wege.length > 1) {
    const wahl = neuMaschine(n);
    box.append(el('div', 'wv-karte-titel', t('welten.neu.maschine')),
      segment('weltneu-maschine', wahl, wege.map((m): [string, string] => [m.name, maschineWort(m.name)])),
      el('div', 'wv-leise wv-weltneu-maschine', neuMaschineText(n, wahl)));
  }
  const pz = el('div', 'wv-zeile-knoepfe');
  const f = feld('input', 'weltneu:ordner', z.weltNeuOrdner, t('welten.neu.ordnerPlatzhalter'));
  f.setAttribute('aria-label', t('welten.neu.ordner'));
  pz.append(f, knopf(t('welten.neu.anlegen'), 'welt-neu', 'projekt', 'knopf-rand', z.laufend.has('neu')));
  // Auftrag agentsform: der Dialog ist der erste Weg, der Pfad als Text bleibt daneben.
  const dialogZeile = el('div', 'wv-zeile-knoepfe');
  dialogZeile.append(knopf(t('welten.neu.ordnerWaehlen'), 'welt-neu-dialog', '', 'knopf-voll', z.laufend.has('neu')), el('span', 'wv-leise', t('welten.neu.oderPfad')));
  box.append(el('div', 'wv-karte-titel', t('welten.neu.projekt')), el('div', 'wv-leise', t('welten.neu.projektText')), dialogZeile, pz);
  const globalDa = !!n?.welten.some((x) => x.art === 'global');
  box.append(el('div', 'wv-karte-titel', t('welten.neu.global')));
  if (globalDa) {
    box.append(el('div', 'wv-leise', t('welten.neu.globalDa')));
  } else {
    const pfad = n?.global_pfad || '~/.claude/workbench/agents';
    box.append(el('div', 'wv-leise', t('welten.neu.globalText', { pfad })), knopf(t('welten.neu.globalAnlegen'), 'welt-neu', 'global', 'knopf-rand', z.laufend.has('neu')));
  }
  // Auftrag agentsform: gemerkte Projektordner lassen sich aus der Liste nehmen; der Ordner bleibt unberuehrt.
  const gemerkt = n?.gemerkte_projekte ?? [];
  if (gemerkt.length) {
    box.append(el('div', 'wv-karte-titel', t('welten.neu.gemerkt')), el('div', 'wv-leise', t('welten.neu.gemerktText')));
    for (const ordner of gemerkt) {
      const zeile = el('div', 'wv-zeile-knoepfe wv-gemerkt');
      zeile.dataset.ordner = ordner;
      const pfadEl = el('span', 'wv-mono wv-gemerkt-pfad', ordner);
      pfadEl.title = ordner;
      zeile.append(pfadEl, knopf(t('welten.neu.vergessen'), 'welt-vergessen', ordner, 'wv-verweis', z.laufend.has('vergessen')));
      box.appendChild(zeile);
    }
  }
  return box;
}

/** Der Leerzustand ohne Welt: was eine Welt ist, die Wege zu einer, was danach kommt. */
function einladungZeichnen(n: WeltenNutzlast): HTMLElement {
  const d = el('div', 'wv-leer wv-ganz wv-einladung');
  d.append(el('div', 'wv-leer-titel', t('welten.leer.keineWelt')), el('div', 'wv-leise wv-einladung-text', t('welten.leer.keineWeltText')));
  const karte = weltNeuZeichnen(n);
  karte.classList.add('wv-karte');
  d.appendChild(karte);
  if (z.meldung) d.appendChild(meldungBand());
  d.append(el('div', 'wv-leise wv-einladung-text', t('welten.leer.danach')));
  if (n.fehler.length) d.appendChild(el('div', 'wv-warnung', n.fehler.map((x) => `${x.quelle}: ${x.text}`).join('\n')));
  return d;
}

/** Die Agent-Maschinen einmal fragen -- nur auf einen echten Klick, nie aus einer Suite. */
function maschinenFragen(echt: boolean): void {
  if (!echt || z.maschinenGefragt || neuWege(nutzlast).length < 2) return;
  z.maschinenGefragt = true;
  void ausfuehren('maschinen', { pruefen: true }, echt, false, true);
}

/** Der eine Behandler aller Bedienelemente mit `data-w`. */
async function handeln(w: string, arg: string, echt: boolean): Promise<void> {
  if (w === 'figuren') { z.figuren = !z.figuren; zeichnen(); return; }
  const wl = welt();
  const n = nutzlast;
  if (w === 'welt') { z.weltPfad = arg; z.weltWunsch = ''; z.auswahl = KANAL; z.anlegen = null; z.ticketAuswahl = ''; z.meldung = null; zeichnen(); return; }
  // Eine neue Welt geht auch ohne Welt: Projektordner als Text (die Electron-Fassung hat hier keinen Dialog) oder Global.
  if (w === 'welt-neu-offen') {
    z.weltNeuOffen = !z.weltNeuOffen;
    zeichnen();
    if (z.weltNeuOffen) maschinenFragen(echt);
    return;
  }
  if (w === 'welt-neu') { await weltAnlegen(arg === 'global', echt); return; }
  if (w === 'welt-neu-dialog') { await ordnerDialogUndAnlegen(echt); return; }
  if (w === 'welt-vergessen') { await ausfuehren('vergessen', { ordner: arg }, echt); zeichnen(); return; }
  if (w === 'weltneu-maschine') { z.weltNeuMaschine = arg; zeichnen(); maschinenFragen(echt); return; }
  if (!wl || !n) return;
  const a = agentVon(wl, agentId());
  switch (w) {
    case 'waehlen': waehlen(arg, wl, echt); return;
    case 'darstellung': z.darstellung = arg === 'liste' ? 'liste' : 'baum'; merkerSchreiben(); break;
    case 'klappen': if (z.zu.has(arg)) z.zu.delete(arg); else z.zu.add(arg); break;
    case 'reiter': z.reiter = arg === 'tickets' ? 'tickets' : 'chat'; z.ticketAuswahl = ''; break;
    case 'blatt': z.blatt = (['profil', 'protokoll', 'gedaechtnis', 'skills'].includes(arg) ? arg : 'profil') as typeof z.blatt; break;
    case 'gespraech': z.gespraech = arg || EINZEL; zeichnen(); gesehen(wl, echt); return;
    case 'inspektor': z.inspektor = !z.inspektor; break;
    case 'meldung-zu': z.meldung = null; break;
    case 'senden': await senden(wl, echt); return;
    case 'antworten': {
      const [frage, ...rest] = arg.split('|');
      const text = rest.join('|') || (z.antworten.get(frage) ?? '').trim();
      if (!text) return;
      const r = await ausfuehren('antworten', { welt: wl.pfad, frage, text }, echt);
      if (r.ok) z.antworten.delete(frage);
      break;
    }
    case 'zuruecknehmen': await ausfuehren('zuruecknehmen', { welt: wl.pfad, frage: arg }, echt); return;
    case 'frage-ansehen': {
      const f = wl.fragen.find((x) => x.id === arg);
      if (f && wl.hauptagent) { z.auswahl = `agent:${wl.hauptagent}`; z.gespraech = EINZEL; z.reiter = 'chat'; }
      break;
    }
    case 'pause':
      // Nur ein Wechsel geht hinaus: ein Klick auf den schon gewaehlten Teil tut nichts.
      if ((arg === 'an') === (wl.stand === 'pausiert') || wl.stand === 'gestoppt') return;
      await ausfuehren(arg === 'an' ? 'pausieren' : 'fortsetzen', { welt: wl.pfad }, echt);
      return;
    case 'pause-agent': {
      const [wie, id] = arg.split(':');
      const ziel = agentVon(wl, id);
      if (!ziel || (wie === 'an') === (ziel.stand === 'pausiert') || ziel.stand === 'gestoppt') return;
      await ausfuehren(wie === 'an' ? 'pausieren' : 'fortsetzen', { welt: wl.pfad, agent: id }, echt);
      return;
    }
    case 'stoppen': await ausfuehren('stoppen', arg ? { welt: wl.pfad, agent: arg } : { welt: wl.pfad }, echt); return;
    case 'bestaetigen': {
      const rf = z.rueckfrage;
      z.rueckfrage = null;
      if (!rf) return;
      const r = await ausfuehren(rf.handlung, rf.daten, echt, true);
      // Nach einem Umzug heisst die Welt `<maschine>:<ablage>`; gewaehlt wird sie, sobald sie in der Nutzlast steht.
      if (r.ok && rf.handlung.startsWith('ticket_')) z.ticketHandlung = null;
      if (rf.handlung === 'umziehen' && r.ok && r.pfad) { z.weltPfad = r.pfad; z.weltWunsch = r.pfad; z.auswahl = KANAL; zeichnen(); }
      return;
    }
    case 'umziehen': await ausfuehren('umziehen', { welt: wl.pfad, maschine: arg }, echt); return;
    case 'abbrechen': z.rueckfrage = null; break;
    case 'quittieren': await ausfuehren('quittieren', { welt: wl.pfad, zustellung: arg }, echt); return;
    case 'ticketfilter': z.ticketFilter = arg; break;
    case 'ticketansicht': z.ticketAnsicht = arg === 'board' ? 'board' : 'liste'; break;
    // Auftrag ticketboard: der Reiter der gestapelten Ansicht und der Klick auf einen schmalen Streifen.
    case 'board-spalte': z.boardSpalte = arg; break;
    // Der Streifen zeigt seinen Stand: als offene Spalte, wo der Platz reicht, sonst als
    // gewaehlter Reiter der gestapelten Ansicht.
    case 'board-auf': z.boardOffen.add(arg); z.boardSpalte = arg; break;
    case 'ticket': z.ticketAuswahl = arg; z.reiter = 'tickets'; z.ticketHandlung = null; break;
    case 'ticket-neu': z.neuesTicket = ticketEntwurfLeer(a?.id ?? ''); break;
    case 'ticket-neu-zu': z.neuesTicket = null; break;
    case 'ticket-punkt-plus': if (z.neuesTicket) z.neuesTicket.punkte = [...z.neuesTicket.punkte, '']; break;
    case 'ticket-punkt-weg': if (z.neuesTicket) z.neuesTicket.punkte = z.neuesTicket.punkte.filter((_, i) => i !== Number(arg)); break;
    case 'ticket-anlegen': {
      const nt = z.neuesTicket;
      if (!nt) return;
      const r = await ausfuehren('ticket', {
        welt: wl.pfad, titel: nt.titel, ziel: nt.ziel, fertig: nt.fertig, an: nt.an ? [nt.an] : [],
        art: nt.kind, prioritaet: nt.prioritaet, fertig_punkte: nt.punkte.filter((p) => p.trim()),
        eltern: nt.eltern, abhaengig: nt.abhaengig ? [nt.abhaengig] : [], frist: nt.frist, runden: nt.runden,
      }, echt);
      if (r.ok) z.neuesTicket = null;
      break;
    }

    // --- tickets4: die Handlungen des Menschen am Ticket, das Backlog, die Weltregeln ------
    case 'handlung': {
      const [h, id] = arg.split('|');
      const tk = wl.tickets.find((x) => x.id === id);
      if (!tk) return;
      z.reiter = 'tickets';
      z.ticketAuswahl = tk.id;
      z.rueckgabe = '';
      z.ticketHandlung = {
        ticket: tk.id, handlung: h as TicketHandlung,
        grund: h === 'verwerfen' ? 'nicht-mehr-noetig' : h === 'abnehmen' ? 'erledigt' : '',
        bemerkung: '', duplikat: '',
        an: h === 'annehmen' ? (wl.hauptagent ?? '') : h === 'umadressieren' ? (tk.bearbeiter ?? tk.adressaten[0] ?? '') : '',
        pruefer: h === 'pruefer' ? (wl.agenten.find((x) => x.id !== tk.bearbeiter && x.stand === 'aktiv')?.id ?? '') : '',
        kind: tk.kind, prioritaet: tk.prioritaet, punkte: [],
        frist: h === 'grenzen' ? String(tk.grenzen.frist ?? '') : '', runden: h === 'grenzen' ? String(tk.grenzen.runden ?? '') : '',
        dodGeprueft: false,
      };
      break;
    }
    case 'handlung-zu': z.ticketHandlung = null; break;
    case 'handlung-dod': if (z.ticketHandlung) z.ticketHandlung.dodGeprueft = !z.ticketHandlung.dodGeprueft; break;
    case 'handlung-punkt-plus': if (z.ticketHandlung) z.ticketHandlung.punkte = [...z.ticketHandlung.punkte, '']; break;
    case 'handlung-punkt-weg': if (z.ticketHandlung) z.ticketHandlung.punkte = z.ticketHandlung.punkte.filter((_, i) => i !== Number(arg)); break;
    case 'handlung-ausfuehren': {
      const e = z.ticketHandlung;
      if (!e || !handlungBereit(e, wl)) return;
      const punkte = e.punkte.map((p) => p.trim()).filter(Boolean);
      const daten: Record<string, unknown> = { welt: wl.pfad, ticket: e.ticket };
      let handlung = '';
      switch (e.handlung) {
        case 'verwerfen':
          handlung = 'ticket_verwerfen';
          Object.assign(daten, { grund: e.grund, bemerkung: e.bemerkung, duplikat_von: e.duplikat });
          break;
        case 'annehmen':
          handlung = 'ticket_annehmen';
          Object.assign(daten, { an: [e.an], art: e.kind, prioritaet: e.prioritaet, fertig_punkte: punkte });
          break;
        case 'umadressieren':
          handlung = 'ticket_umadressieren';
          Object.assign(daten, { an: [e.an], grund: e.grund });
          break;
        case 'grenzen':
          handlung = 'ticket_grenzen';
          Object.assign(daten, { frist: e.frist, runden: e.runden });
          break;
        case 'pruefer':
          handlung = 'ticket_pruefen';
          Object.assign(daten, { pruefer: e.pruefer });
          break;
        case 'abnehmen':
          handlung = 'ticket_abnehmen';
          Object.assign(daten, { grund: e.grund, bemerkung: e.bemerkung.trim(), dod_geprueft: e.dodGeprueft });
          break;
        default: return;
      }
      const r = await ausfuehren(handlung, daten, echt);
      if (r.ok) z.ticketHandlung = null;
      break;
    }
    case 'backlog-hoch':
    case 'backlog-runter': {
      const reihe = backlogVon(wl).map((x) => x.id);
      const jetzt = reihe.indexOf(arg);
      if (jetzt < 0) return;
      const ziel = Math.max(0, Math.min(reihe.length - 1, jetzt + (w === 'backlog-hoch' ? -1 : 1)));
      if (ziel === jetzt) return;
      reihe.splice(jetzt, 1);
      reihe.splice(ziel, 0, arg);
      await ausfuehren('backlog', { welt: wl.pfad, ordnen: reihe }, echt);
      return;
    }
    case 'regeln-bearbeiten':
      z.weltRegeln = { welt: wl.pfad, tage: String(wl.zyklus.tage || 7), ziel: wl.zyklus.jetzt?.ziel ?? '', dod: [...wl.dod], wip: wl.wip.grenze > 0 ? String(wl.wip.grenze) : '' };
      break;
    case 'regeln-zu': z.weltRegeln = null; break;
    case 'dod-punkt-plus': if (z.weltRegeln) z.weltRegeln.dod = [...z.weltRegeln.dod, '']; break;
    case 'dod-punkt-weg': if (z.weltRegeln) z.weltRegeln.dod = z.weltRegeln.dod.filter((_, i) => i !== Number(arg)); break;
    case 'dod-sichern': {
      const r2 = z.weltRegeln;
      if (!r2) return;
      await ausfuehren('dod', { welt: wl.pfad, punkte: r2.dod.map((p) => p.trim()).filter(Boolean) }, echt);
      return;
    }
    case 'wip-setzen': {
      const r2 = z.weltRegeln;
      if (!r2) return;
      await ausfuehren('wip', { welt: wl.pfad, limit: r2.wip }, echt);
      return;
    }
    case 'zyklus-ein': {
      const r2 = z.weltRegeln;
      await ausfuehren('zyklus', { welt: wl.pfad, aktion: 'einschalten', tage: r2?.tage ?? '', ziel: r2?.ziel ?? '' }, echt);
      return;
    }
    case 'zyklus-aus': await ausfuehren('zyklus', { welt: wl.pfad, aktion: 'ausschalten' }, echt); return;
    case 'rueckgabe': z.rueckgabe = arg; z.rueckgabeText = ''; break;
    case 'rueckgabe-zu': z.rueckgabe = ''; break;
    case 'zurueckgeben': {
      const text = z.rueckgabeText.trim();
      if (!text) { z.meldung = { text: t('welten.meldung.rueckgabeOhneBemerkung'), ok: false }; break; }
      const r = await ausfuehren('zurueckgeben', { welt: wl.pfad, ticket: arg, bemerkung: text }, echt);
      if (r.ok) { z.rueckgabe = ''; z.rueckgabeText = ''; }
      break;
    }
    case 'skill-zeigen': if (z.skillOffen.has(arg)) z.skillOffen.delete(arg); else z.skillOffen.add(arg); break;
    case 'skill-abnehmen': await ausfuehren('skill_abnehmen', { welt: wl.pfad, ticket: arg }, echt); return;
    case 'skill-ablehnen-offen': z.skillAblehnen = arg; z.skillGrund = ''; break;
    case 'skill-ablehnen-zu': z.skillAblehnen = ''; break;
    case 'skill-ablehnen': {
      const grund = z.skillGrund.trim();
      if (!grund) { z.meldung = { text: t('welten.meldung.ablehnungOhneGrund'), ok: false }; break; }
      const r = await ausfuehren('skill_ablehnen', { welt: wl.pfad, ticket: arg, grund }, echt);
      if (r.ok) { z.skillAblehnen = ''; z.skillGrund = ''; }
      break;
    }
    case 'profil-bearbeiten':
      if (a) z.profil = { agent: a.id, modell: a.modell, denkstufe: a.denkstufe, fallback: a.fallback, fallbackDenkstufe: a.fallback_denkstufe, maschine: a.maschine, spezialgebiet: a.spezialgebiet };
      break;
    case 'profil-zu': z.profil = null; break;
    case 'profil-sichern': await profilSichern(wl, echt); return;
    case 'gedaechtnis-bearbeiten': if (a) z.gedaechtnis = { agent: a.id, text: a.gedaechtnis.text, sha: a.gedaechtnis.sha256 }; break;
    case 'gedaechtnis-zu': z.gedaechtnis = null; break;
    case 'gedaechtnis-sichern': {
      const g = z.gedaechtnis;
      if (!g) return;
      const r = await ausfuehren('gedaechtnis', { welt: wl.pfad, agent: g.agent, text: g.text, erwartet: g.sha }, echt);
      if (r.ok) z.gedaechtnis = null;
      break;
    }
    case 'anlegen': anlegenOeffnen(wl, arg || undefined); break;
    case 'anlegen-vorschlag':
      // Auftrag agentschat: wer sich vorschlagen laesst, landet im Gespraech; das Formular bleibt einen Klick entfernt.
      anlegenOeffnen(wl, undefined, 'gespraech');
      if (z.anlegen) z.anlegen.info = t(wl.hauptagent ? 'welten.anlegen.vorschlagHinweis' : 'welten.anlegen.vorschlagHinweisHaupt', { welt: wl.name });
      break;
    case 'anlegen-zu': anlegenAbbrechen(wl, echt); break;
    case 'anlegen-ansicht': if (z.anlegen) z.anlegen.ansicht = arg === 'gespraech' ? 'gespraech' : 'formular'; break;
    case 'gespraech-senden': await gespraechSenden(wl, echt, arg === 'trocken'); return;
    case 'vorlage': vorlageAnwenden(wl, arg); break;
    case 'vorschlag': await vorschlag(wl, echt, arg === 'trocken'); return;
    case 'pruefen': await pruefen(wl, echt, arg === 'hausvorlage'); return;
    case 'anlegen-sichern': await anlegenSichern(wl, echt); return;
    case 'werkzeug':
    case 'anlegen-werkzeug': {
      const an = z.anlegen;
      if (!an || arg === 'Bash') return;
      if (WEB.includes(arg) && !wl.web_zugang) { z.meldung = { text: t('welten.rechte.webOhneMeldung', { befehl: webBefehl(wl) }), ok: false }; break; }
      if (an.entwurf.werkzeuge.includes(arg)) an.entwurf.werkzeuge = an.entwurf.werkzeuge.filter((x) => x !== arg);
      else an.entwurf.werkzeuge = [...an.entwurf.werkzeuge, arg];
      if (!an.entwurf.werkzeuge.includes('Bash')) an.entwurf.werkzeuge = ['Bash', ...an.entwurf.werkzeuge];
      an.gesetzt.add('werkzeuge');
      break;
    }
    case 'anlegen-skill': {
      const an = z.anlegen;
      if (!an) return;
      const liste = an.entwurf.skills.split(',').map((x) => x.trim()).filter(Boolean);
      an.entwurf.skills = (liste.includes(arg) ? liste.filter((x) => x !== arg) : [...liste, arg]).join(', ');
      an.gesetzt.add('skills');
      break;
    }
    case 'gespraech-rechte': z.gRechteOffen = !z.gRechteOffen; break;
    // --- Rechte eines bestehenden Agenten (Profil) ---
    case 'rechte-bearbeiten':
      if (a && wl.rechte_aenderbar) z.rechte = { agent: a.id, werkzeuge: a.werkzeuge.filter((x) => x !== 'Bash'), bash: eigeneMuster(a.bash, a.stufe).join('\n'), skills: [...a.skills] };
      break;
    case 'rechte-zu': z.rechte = null; break;
    case 'rechte-werkzeug': {
      const r = z.rechte;
      if (!r || arg === 'Bash') return;
      if (WEB.includes(arg) && !wl.web_zugang) { z.meldung = { text: t('welten.rechte.webOhneMeldung', { befehl: webBefehl(wl) }), ok: false }; break; }
      r.werkzeuge = r.werkzeuge.includes(arg) ? r.werkzeuge.filter((x) => x !== arg) : [...r.werkzeuge, arg];
      break;
    }
    case 'rechte-skill': {
      const r = z.rechte;
      if (!r) return;
      r.skills = r.skills.includes(arg) ? r.skills.filter((x) => x !== arg) : [...r.skills, arg];
      break;
    }
    case 'rechte-sichern': {
      const r = z.rechte;
      if (!r) return;
      const res = await ausfuehren('rechte', { welt: wl.pfad, agent: r.agent, werkzeuge: ['Bash', ...r.werkzeuge], bash: r.bash.split('\n').map((x) => x.trim()).filter(Boolean), skills: r.skills }, echt);
      if (res.ok) z.rechte = null;
      break;
    }
    case 'rantrag-freigeben':
    case 'rantrag-ablehnen': {
      // Vertrag rantrag: nur Kennung, Entscheidung und Bemerkung; die Aenderung ist die gespeicherte.
      const bemerkung = (z.rantragBemerkung.get(arg) ?? '').trim();
      const res = await ausfuehren('rechte_antrag_entscheiden', { welt: wl.pfad, id: arg, annehmen: w === 'rantrag-freigeben', ...(bemerkung ? { bemerkung } : {}) }, echt);
      if (res.ok) z.rantragBemerkung.delete(arg);
      break;
    }
    default: return;
  }
  zeichnen();
}

/** Eine Eingabe in den Zustand; nur die Vorschau des Anlege-Menues wird dabei neu gezeichnet. */
function eingabe(schluessel: string, wert: string): void {
  const k = gespraechSchluessel();
  const a = z.anlegen;
  const [bereich, name] = schluessel.split(':');
  switch (bereich) {
    case 'entwurf': z.entwuerfe.set(k, wert); return;
    case 'adressen': z.adressfeld = wert; return;
    case 'antwort': z.antworten.set(name, wert); return;
    case 'rantrag': z.rantragBemerkung.set(name, wert); return;
    case 'rueckgabe': z.rueckgabeText = wert; return;
    case 'skillgrund': z.skillGrund = wert; return;
    case 'welt': void handeln('welt', wert, true); return;
    case 'weltneu': z.weltNeuOrdner = wert; return;
    case 'gespraech': void handeln('gespraech', wert, true); return;
    case 'ticketfilter': void handeln('ticketfilter', wert, true); return;
    case 'ticket': {
      const nt = z.neuesTicket;
      if (!nt) return;
      const [, feldname, nr] = schluessel.split(':');
      if (feldname === 'punkt') { const i = Number(nr); if (nt.punkte[i] !== undefined) nt.punkte[i] = wert; zeichnen(); return; }
      if (feldname === 'prioritaet') { nt.prioritaet = Number(wert) || 0; zeichnen(); return; }
      if (feldname === 'art') { nt.kind = wert; zeichnen(); return; }
      const karte: Record<string, keyof TicketEntwurf> = { titel: 'titel', ziel: 'ziel', fertig: 'fertig', an: 'an', eltern: 'eltern', abhaengig: 'abhaengig', frist: 'frist', runden: 'runden' };
      const feldZiel = karte[feldname ?? ''];
      if (feldZiel) (nt as unknown as Record<string, string>)[feldZiel] = wert;
      // Die Vorschau der Definition of Ready haengt an jedem dieser Felder.
      zeichnen();
      return;
    }
    case 'handlung': {
      const e = z.ticketHandlung;
      if (!e) return;
      const [, feldname, nr] = schluessel.split(':');
      if (feldname === 'punkt') { const i = Number(nr); if (e.punkte[i] !== undefined) e.punkte[i] = wert; return; }
      if (feldname === 'prioritaet') { e.prioritaet = Number(wert) || 0; zeichnen(); return; }
      if (['grund', 'bemerkung', 'duplikat', 'an', 'pruefer', 'frist', 'runden'].includes(feldname ?? '')) {
        (e as unknown as Record<string, string>)[feldname ?? ''] = wert;
      } else if (feldname === 'art') { e.kind = wert; }
      zeichnen();
      return;
    }
    case 'regel': {
      const r = z.weltRegeln;
      if (!r) return;
      const [, feldname, nr] = schluessel.split(':');
      if (feldname === 'dod') { const i = Number(nr); if (r.dod[i] !== undefined) r.dod[i] = wert; return; }
      if (feldname === 'tage' || feldname === 'ziel' || feldname === 'wip') (r as unknown as Record<string, string>)[feldname] = wert;
      return;
    }
    case 'profil': if (z.profil) (z.profil as Record<string, string>)[name] = wert; return;
    case 'rechte': if (z.rechte && name === 'bash') z.rechte.bash = wert; return;
    case 'gedaechtnis': if (z.gedaechtnis) z.gedaechtnis.text = wert; return;
    case 'anlegen': {
      if (!a) return;
      if (name === 'beschreibung') a.beschreibung = wert;
      else if (name === 'gespraech-eingabe') { a.eingabe = wert; return; }
      else if (name === 'modell-vorschlag') a.modell = wert;
      else if (name === 'vorlage') { const wl = welt(); if (wl) vorlageAnwenden(wl, wert); zeichnen(); return; }
      else {
        const e = a.entwurf as unknown as Record<string, string>;
        const karte: Record<string, string> = { name: 'id', figur: 'figurArt', farbe: 'figurFarbe', 'fallback-denkstufe': 'fallbackDenkstufe' };
        if (name === 'team') {
          if (wert === 'neu') { a.neuesTeam = true; a.entwurf.team = ''; zeichnen(); return; }
          a.neuesTeam = false;
        }
        if (name === 'neues-team') { a.entwurf.team = wert; a.gesetzt.add('team'); vorschauZeichnen(); return; }
        if ((name === 'modell' || name === 'fallback') && wert) {
          const wl = welt();
          const m = wl?.modelle?.find((x) => x.id === wert);
          if (m && !m.verfuegbar) { z.meldung = { text: t('welten.modell.abgelehnt', { modell: wert, grund: wort('modellgrund', m.grund) }), ok: false }; zeichnen(); return; }
          if (a.entwurf.modellGenau && suffix(wert) && DENKSTUFEN.includes(suffix(wert))) {
            e[name === 'modell' ? 'denkstufe' : 'fallbackDenkstufe'] = suffix(wert);
            a.gesetzt.add(name === 'modell' ? 'denkstufe' : 'fallback-denkstufe');
          }
        }
        e[karte[name] ?? name] = wert;
        a.gesetzt.add(name);
        if (['stufe', 'team', 'fallback'].includes(name)) { zeichnen(); return; }
      }
      vorschauZeichnen();
      // Auftrag agentsform: „Anlegen" geht, sobald Name und Spezialgebiet stehen -- nicht erst nach dem naechsten Zeichnen.
      if (name === 'name' || name === 'spezialgebiet') fussAktualisieren();
      return;
    }
    default:
  }
}

/** Die Fusszeile des Anlege-Menues neu, ohne das Blatt neu zu zeichnen (das Eingabefeld behaelt den Fokus). */
function fussAktualisieren(): void {
  const alt = blatt?.querySelector('.wv-anlegen > .wv-fuss');
  if (alt && z.anlegen) alt.replaceWith(anlegenFuss(z.anlegen));
}

// --- Zeichnen ----------------------------------------------------------------------------

const figurenCache = new Map<string, HTMLCanvasElement>();
/**
 * Die Figur eines Agenten, in einer Huelle mit dem Ring des Lebenszeichens (Auftrag agentaktiv): ein ruhig
 * kreisender Bogen, solange ein Zug laeuft, ein gepunkteter Ring, solange eine Zustellung auf den Traeger
 * wartet. Bei „Bewegung reduzieren" (System oder `welten bewegung reduziert`) steht der Bogen als voller Ring.
 */
function agentFigur(a: WeltAgent, groesse: number): HTMLElement {
  const art: Art = a.figur.art === 'tier' ? 'tier' : 'roboter';
  const rolle = a.figur.art === 'kern' ? 'hauptagent' : a.figur.art === 'linse' ? 'reviewer' : a.id;
  const team = a.figur.art === 'kern' ? 'hauptagent' : (a.figur.farbe || a.team || 'entwicklung');
  const schluessel = `${a.id}|${groesse}|${a.figur_zustand}|${a.figur.art}|${team}`;
  const c = figur({ rolle, stufe: a.stufe, name: a.id, team, art, groesse, zustand: figurZustandVon(a.figur_zustand), titel: a.name }, figurenCache.get(schluessel));
  figurenCache.set(schluessel, c);
  const ring = ringVon(a);
  const huelle = el('span', `wv-figur${ring ? ` ring-${ring}` : ''}`);
  huelle.dataset.ring = ring;
  // Der Bogen dreht nach der Uhr weiter, statt bei jedem Neuzeichnen (alle paar Sekunden) von vorn zu beginnen.
  if (ring === 'arbeitet') huelle.style.setProperty('--wv-verzug', `-${Date.now() % ZUG_UMLAUF_MS}ms`);
  huelle.appendChild(c);
  return huelle;
}
function entwurfFigur(e: Entwurf, groesse: number): HTMLCanvasElement {
  const name = e.id || 'neu';
  if (e.stufe === 'hauptagent') return figur({ rolle: 'hauptagent', stufe: 'hauptagent', name, team: 'hauptagent', groesse });
  return figur({ rolle: e.figurArt === 'linse' ? 'reviewer' : name, stufe: e.stufe, name, team: e.figurFarbe, art: e.figurArt === 'tier' ? 'tier' : 'roboter', groesse });
}

function leisteZeichnen(w: Welt, n: WeltenNutzlast): HTMLElement {
  const box = el('nav', 'wv-leiste');
  const kopf = el('div', 'wv-leiste-kopf');
  const zeile = el('div', 'wv-zeile-knoepfe');
  zeile.appendChild(auswahlFeld('welt', w.pfad, n.welten.map((x) => [x.pfad, [x.art === 'global' ? t('welten.global') : x.name, maschineWort(x.maschine ?? '')].filter(Boolean).join(' · ')])));
  const neu = knopf(t('welten.neu.knopf'), 'welt-neu-offen', '', z.weltNeuOffen ? 'knopf-rand gewaehlt' : 'knopf-rand');
  neu.setAttribute('aria-expanded', String(z.weltNeuOffen));
  zeile.appendChild(neu);
  kopf.appendChild(zeile);
  if (z.weltNeuOffen) kopf.appendChild(weltNeuZeichnen(n));
  // „Agent anlegen" beschriftet statt eines Plus; geht es nicht, steht der Grund darunter.
  const lage = anlegenLage(w);
  const anlegenKnopf = knopf(lage.titel, 'anlegen', '', 'knopf-rand wv-anlegen', !lage.aktiv);
  anlegenKnopf.title = lage.aktiv ? t('welten.anlegen.in', { welt: w.name }) : lage.grund;
  kopf.appendChild(anlegenKnopf);
  if (!lage.aktiv) kopf.appendChild(el('div', 'wv-leise wv-anlegen-grund', lage.grund));
  if (n.vorlagen.length && w.hauptagent) {
    const vorlagen = el('div', 'wv-vorlagen');
    vorlagen.appendChild(el('span', 'wv-leise', t('welten.leiste.vorlagen')));
    for (const v of n.vorlagen) {
      const b = knopf(v.title, 'anlegen', v.name, 'wv-verweis', w.stand !== 'läuft');
      b.title = v.summary;
      vorlagen.appendChild(b);
    }
    kopf.appendChild(vorlagen);
  }
  kopf.appendChild(segment('darstellung', z.darstellung, [['baum', t('welten.leiste.baum')], ['liste', t('welten.leiste.liste')]]));
  if (w.fehler.length || !w.konsistent) kopf.appendChild(el('div', 'wv-warnung', w.fehler.join('\n') || t('welten.leiste.inkonsistent')));
  box.appendChild(kopf);
  const liste = el('div', 'wv-zeilen');
  liste.setAttribute('role', 'tree');
  const kanal = el('button', `wv-zeile wv-kanal${z.auswahl === KANAL ? ' gewaehlt' : ''}`);
  kanal.dataset.w = 'waehlen'; kanal.dataset.arg = KANAL; kanal.dataset.id = KANAL;
  const kanalText = el('div', 'wv-zeile-text');
  kanalText.append(el('div', 'wv-name', t('welten.kanal.name')), el('div', 'wv-unter', t(w.kanal_gesamt === 1 ? 'welten.kanal.nachrichtEins' : 'welten.kanal.nachrichtenViele', { n: w.kanal_gesamt })));
  kanal.append(el('span', 'wv-kanal-symbol', '#'), kanalText);
  const ku = ungelesen(w, KANAL);
  if (ku) kanal.appendChild(el('span', 'wv-zahl', String(ku)));
  liste.appendChild(kanal);
  const agentZeile = (id: string, ebene: number, mitTeam: boolean): void => {
    const a = agentVon(w, id);
    if (!a) return;
    const b = el('button', `wv-zeile ebene-${ebene}${z.auswahl === `agent:${id}` ? ' gewaehlt' : ''}`);
    b.dataset.w = 'waehlen'; b.dataset.arg = `agent:${id}`; b.dataset.id = `agent:${id}`;
    b.appendChild(agentFigur(a, 28));
    const tz = el('div', 'wv-zeile-text');
    const nameZeile = el('div', 'wv-name');
    nameZeile.append(el('span', undefined, a.name));
    if (a.stufe !== 'mitglied') nameZeile.append(el('span', 'wv-stufe', a.stufe === 'hauptagent' ? stufeWort('hauptagent') : t('welten.stufe.leiterKurz')));
    if (mitTeam && a.team) nameZeile.append(el('span', 'wv-stufe', teamWort(a.team)));
    const unter = el('div', 'wv-unter');
    const wortZeile = uhrWort('wv-leben', a.id, 'zeile', zeilenWort(a));
    zeilenTitel(wortZeile, a, wortZeile.textContent ?? '');
    unter.append(punkt(agentPunkt(a)), el('span', undefined, ' '), wortZeile, el('span', undefined, ` · ${a.spezialgebiet}`));
    tz.append(nameZeile, unter);
    b.appendChild(tz);
    const u = ungelesen(w, `einzel:${id}`);
    if (u) b.appendChild(el('span', 'wv-zahl', String(u)));
    liste.appendChild(b);
  };
  liste.appendChild(el('div', 'wv-kopf', t('welten.leiste.hauptagent')));
  if (w.hauptagent) agentZeile(w.hauptagent, 0, false);
  else liste.appendChild(el('div', 'wv-leise wv-hinweis', t('welten.leiste.keinHauptagent')));
  if (z.darstellung === 'baum') {
    if (w.teams.length) liste.appendChild(el('div', 'wv-kopf', t('welten.leiste.teams')));
    for (const team of w.teams) {
      const zu = z.zu.has(team.name);
      const k = el('button', 'wv-team');
      k.dataset.w = 'klappen'; k.dataset.arg = team.name; k.dataset.id = `team:${team.name}`;
      k.setAttribute('aria-expanded', String(!zu));
      k.append(el('span', 'wv-klappe', zu ? '▸' : '▾'), el('span', undefined, teamText(team.name)));
      if (zu && team.aktiv) k.appendChild(el('span', 'wv-leise', ` · ${t('welten.leiste.aktiv', { n: team.aktiv })}`));
      liste.appendChild(k);
      if (team.leiter) agentZeile(team.leiter, 1, false);
      if (!zu) for (const m of team.mitglieder) agentZeile(m, 2, false);
    }
    if (w.ohne_team.length) {
      liste.appendChild(el('div', 'wv-kopf', t('welten.leiste.ohneTeam')));
      for (const id of w.ohne_team) agentZeile(id, 1, false);
    }
  } else {
    if (w.liste.some((id) => id !== w.hauptagent)) liste.appendChild(el('div', 'wv-kopf', t('welten.leiste.agenten')));
    for (const id of w.liste) if (id !== w.hauptagent) agentZeile(id, 1, true);
  }
  box.appendChild(liste);
  return box;
}

function mitteZeichnen(w: Welt): HTMLElement {
  if (z.anlegen) return anlegenZeichnen(w, z.anlegen);
  const box = el('main', 'wv-mitte');
  const a = agentVon(w, agentId());
  const kopf = el('div', 'wv-mkopf');
  if (a) {
    kopf.appendChild(agentFigur(a, 40));
    const kt = el('div', 'wv-mkopf-text');
    const oben = el('div', 'wv-mtitel');
    oben.append(el('span', 'wv-titel', a.name), el('span', 'wv-leise', `${stufeWort(a.stufe)}${a.team ? ` · ${teamText(a.team)}` : ''}`));
    const unten = el('div', 'wv-unter');
    unten.append(el('span', 'wv-mono', a.modell), el('span', undefined, ` · ${a.maschine === 'mac' ? 'Mac' : a.maschine} · `), punkt(agentPunkt(a)), el('span', undefined, ' '));
    if (lebenWort(a) !== null) unten.append(uhrWort('wv-leben', a.id, 'leben', agentWort(a)), el('span', 'wv-leise', a.zustand === 'arbeitet' && a.zustand_text !== 'arbeitet' ? ` · ${zugText(a.zustand_text)}` : ''));
    else unten.append(el('span', 'wv-leben', zugText(a.zustand_text)));
    kt.append(oben, unten);
    kopf.appendChild(kt);
  } else {
    kopf.appendChild(el('span', 'wv-kanal-symbol gross', '#'));
    const kt = el('div', 'wv-mkopf-text');
    kt.append(el('div', 'wv-titel', t('welten.kanal.name')), el('div', 'wv-unter', t('welten.kanal.unter', { welt: w.name, n: w.kanal_gesamt })));
    kopf.appendChild(kt);
  }
  const rechts = el('div', 'wv-mkopf-rechts');
  if (a && a.direktchats.length && z.reiter === 'chat') {
    rechts.appendChild(auswahlFeld('gespraech', z.gespraech, [[EINZEL, t('welten.chat.mitDir')], ...w.direktchats.filter((c) => a.direktchats.includes(c.id)).map((c): [string, string] => [c.id, t('welten.chat.direktMit', { namen: c.teilnehmer.filter((x) => x !== a.id).map((x) => anzeigename(w, x)).join(', ') })])]));
  }
  rechts.appendChild(segment('reiter', z.reiter, [['chat', t('welten.reiter.chat')], ['tickets', t('welten.reiter.tickets')]]));
  kopf.appendChild(rechts);
  box.appendChild(kopf);
  if (z.meldung) box.appendChild(meldungBand());
  if (!w.hauptagent) {
    const lage = anlegenLage(w);
    const band = el('div', 'wv-einladung-band');
    const text = el('div', 'wv-einladung-band-text');
    text.append(el('div', 'wv-titel', t('welten.einladung.titel')), el('div', 'wv-leise', t('welten.einladung.text')));
    const k = el('div', 'wv-zeile-knoepfe');
    k.append(knopf(t('welten.anlegen.hauptagentOffen'), 'anlegen', '', 'knopf-voll', !lage.aktiv), knopf(t('welten.anlegen.vorschlagen'), 'anlegen-vorschlag', '', 'knopf-rand', !lage.aktiv));
    text.appendChild(k);
    if (!lage.aktiv) text.appendChild(el('div', 'wv-leise', lage.grund));
    band.appendChild(text);
    box.appendChild(band);
  }
  const offen = w.fragen.filter((f) => f.stand === 'offen');
  const imEinzel = a && a.id === w.hauptagent && z.gespraech === EINZEL && z.reiter === 'chat';
  if (offen.length && !imEinzel) {
    const f = offen[0];
    const band = el('div', 'wv-frageband');
    band.dataset.frage = f.id;
    band.append(punkt('will'), el('span', 'wv-frageband-text', t('welten.frage.band', { name: anzeigename(w, f.von), text: f.text })), knopf(t('welten.frage.ansehen'), 'frage-ansehen', f.id));
    box.appendChild(band);
    // Auftrag agentsform: „Braucht dich" -- gleich hier beantworten, mit Option oder eigenem Text.
    const antwort = el('div', 'wv-frageband-antwort');
    const optionen = [...f.optionen].sort((x, y) => (x === f.empfehlung ? -1 : y === f.empfehlung ? 1 : 0));
    for (const o of optionen) antwort.appendChild(knopf(o === f.empfehlung ? t('welten.frage.empfohlen', { option: o }) : o, 'antworten', `${f.id}|${o}`, o === f.empfehlung ? 'knopf-voll' : 'knopf-rand', z.laufend.has('antworten')));
    antwort.append(feld('input', `antwort:${f.id}`, z.antworten.get(f.id) ?? '', t('welten.frage.eigeneAntwort')), knopf(t('welten.frage.antworten'), 'antworten', f.id, 'knopf-rand', z.laufend.has('antworten')));
    box.appendChild(antwort);
  }
  box.appendChild(z.reiter === 'tickets' ? ticketsZeichnen(w, a) : chatZeichnen(w, a));
  return box;
}

function meldungBand(): HTMLElement {
  const m = z.meldung!;
  const band = el('div', `wv-meldung ${m.ok ? 'ok' : 'abgelehnt'}`);
  band.setAttribute('role', 'status');
  band.append(el('span', 'wv-meldung-text', m.text), knopf(t('welten.meldung.ausblenden'), 'meldung-zu', '', 'wv-verweis'));
  return band;
}

function nachrichtKarte(w: Welt, m: WeltNachricht): HTMLElement {
  const mensch = m.von_mensch;
  const karte = el('div', `wv-nachricht${mensch ? ' vom-menschen' : ''}${m.markierung && m.offen_fuer_mensch ? ' markiert' : ''}`);
  karte.dataset.id = m.id;
  const kopf = el('div', 'wv-nkopf');
  kopf.append(el('span', 'wv-name', anzeigename(w, m.von)));
  if (m.an.length && !(m.an.length === 1 && m.an[0] === 'mensch')) kopf.append(el('span', 'wv-leise', ` ${t('welten.nachricht.an', { namen: m.an.map((x) => anzeigename(w, x)).join(', ') })}`));
  kopf.append(el('span', 'wv-leise', ` · ${alter(m.zeit)}`));
  karte.appendChild(kopf);
  if (m.markierung) karte.appendChild(el('div', 'wv-marke', t(m.markierung === 'frage' ? 'welten.nachricht.frageAnDich' : 'welten.nachricht.ergebnisFuerDich')));
  karte.appendChild(el('div', 'wv-ntext', m.text));
  if (m.ticket) karte.appendChild(el('div', 'wv-leise', t('welten.nachricht.ticket', { titel: w.tickets.find((x) => x.id === m.ticket)?.titel ?? m.ticket })));
  if (m.markierung) {
    if (m.offen_fuer_mensch) karte.appendChild(knopf(t('welten.nachricht.quittieren'), 'quittieren', m.id, 'knopf-rand', z.laufend.has('quittieren')));
    else karte.appendChild(el('div', 'wv-leise', t('welten.nachricht.quittiert')));
  }
  return karte;
}

function frageKarte(w: Welt, id: string): HTMLElement | null {
  const f = w.fragen.find((x) => x.id === id);
  if (!f) return null;
  const karte = el('div', `wv-frage ${f.stand === 'offen' ? 'offen' : ''}`);
  karte.dataset.id = f.id;
  karte.append(el('div', 'wv-nkopf', t('welten.frage.kopf', { name: anzeigename(w, f.von), stand: wort('frage', f.stand) })), el('div', 'wv-ntext', f.text));
  if (f.stand === 'offen') {
    const wahl = el('div', 'wv-optionen');
    const optionen = [...f.optionen].sort((x, y) => (x === f.empfehlung ? -1 : y === f.empfehlung ? 1 : 0));
    for (const o of optionen) wahl.appendChild(knopf(o === f.empfehlung ? t('welten.frage.empfohlen', { option: o }) : o, 'antworten', `${f.id}|${o}`, o === f.empfehlung ? 'knopf-voll' : 'knopf-rand'));
    karte.appendChild(wahl);
    const eigen = el('div', 'wv-zeile-knoepfe');
    eigen.append(feld('input', `antwort:${f.id}`, z.antworten.get(f.id) ?? '', t('welten.frage.eigeneAntwort')), knopf(t('welten.frage.antworten'), 'antworten', f.id), knopf(t('welten.frage.zuruecknehmen'), 'zuruecknehmen', f.id, 'wv-verweis'));
    karte.appendChild(eigen);
  } else if (f.antwort) {
    karte.appendChild(el('div', 'wv-leise', t('welten.frage.antwortVon', { name: anzeigename(w, f.antwort.von), text: f.antwort.text })));
  }
  return karte;
}

function chatZeichnen(w: Welt, a: WeltAgent | undefined): HTMLElement {
  const box = el('div', 'wv-chat');
  const verlauf = el('div', 'wv-verlauf');
  const k = gespraechSchluessel();
  const eintraege: ChatEintrag[] = k.startsWith('einzel:') && a ? a.einzelchat
    : nachrichtenVon(w, k).map((m) => ({ art: 'nachricht' as const, id: m.id, zeit: m.zeit, nachricht: m, frage: null }));
  if (!eintraege.length) {
    const leer = el('div', 'wv-leer');
    leer.append(el('div', 'wv-leer-titel', t('welten.chat.leer')), el('div', 'wv-leise', a ? t('welten.chat.leerAgent', { name: a.name }) : t('welten.chat.leerKanal')));
    verlauf.appendChild(leer);
  }
  const stand = k.startsWith('einzel:') && a ? antwortText(a) : null;
  for (const e of eintraege) {
    const karte = e.nachricht ? nachrichtKarte(w, e.nachricht) : e.frage ? frageKarte(w, e.frage) : null;
    if (karte) verlauf.appendChild(karte);
    // Auftrag agentaktiv: direkt unter der eigenen, noch unbeantworteten Nachricht, bis die Antwort da ist.
    if (stand && a && e.nachricht && e.id === a.antwort?.nachricht) {
      const zeile = el('div', 'wv-antwortstand');
      zeile.setAttribute('role', 'status');
      zeile.dataset.art = stand.art;
      const wortEl = uhrWort('wv-antwortstand-text', a.id, 'antwort', stand.text);
      zeile.append(punkt(antwortPunkt(stand.art)), wortEl);
      verlauf.appendChild(zeile);
    }
  }
  box.appendChild(verlauf);
  const eing = el('div', 'wv-eingabe');
  if (k.startsWith('direkt:')) {
    eing.appendChild(el('div', 'wv-leise', t('welten.chat.direktNurLesen')));
  } else {
    if (!a) {
      const an = el('label', 'wv-an');
      an.append(el('span', 'wv-leise', t('welten.chat.an')), feld('input', 'adressen:', z.adressfeld || (w.hauptagent ? `@${w.hauptagent}` : ''), '@name, @team, @alle'));
      eing.appendChild(an);
    }
    const f = feld('textarea', 'entwurf:', z.entwuerfe.get(k) ?? '', a ? t('welten.chat.nachrichtAn', { name: a.name }) : t('welten.chat.nachrichtKanal'));
    (f as HTMLTextAreaElement).rows = 2;
    eing.appendChild(f);
    eing.appendChild(knopf(t('welten.chat.senden'), 'senden', '', 'knopf-voll', z.laufend.has('senden')));
  }
  box.appendChild(eing);
  return box;
}

function ticketsFuer(w: Welt, a: WeltAgent | undefined): WeltTicket[] {
  let liste = a ? w.tickets.filter((t) => a.tickets.includes(t.id)) : [...w.tickets];
  if (z.ticketFilter === 'offen') liste = liste.filter((t) => t.stand !== 'abgenommen' && t.stand !== 'verworfen');
  else if (z.ticketFilter !== 'alle') liste = liste.filter((t) => t.stand === z.ticketFilter);
  // Die Triage ist das geordnete Backlog (Plan Satz 44) und steht in ihrer Reihenfolge.
  if (z.ticketFilter === 'triage') return backlogFolge(liste);
  return liste.sort((x, y) => (x.geaendert < y.geaendert ? 1 : -1));
}

/** Die Triage in Backlog-Reihenfolge: `ordnung` aufsteigend, ohne Feld ans Ende. */
export function backlogFolge(liste: WeltTicket[]): WeltTicket[] {
  return [...liste].sort((a, b) => {
    const x = a.ordnung ?? Number.MAX_SAFE_INTEGER; const y = b.ordnung ?? Number.MAX_SAFE_INTEGER;
    if (x !== y) return x - y;
    if (a.angelegt !== b.angelegt) return a.angelegt < b.angelegt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}
const backlogVon = (w: Welt): WeltTicket[] => backlogFolge(w.tickets.filter((x) => x.stand === 'triage'));

/**
 * DAS BOARD (Plan Satz 47): je Vorhaben eine Swimlane, Tickets ohne Vorhaben in „Ohne
 * Vorhaben". Ein Ticket gehoert zu dem Vorhaben an der Wurzel seiner Elternkette.
 */
export function boardSpuren(w: Welt, tickets: WeltTicket[]): { id: string; titel: string; spalten: { name: string; tickets: WeltTicket[] }[] }[] {
  const nachId = new Map(w.tickets.map((x) => [x.id, x]));
  const vorhabenVon = (x: WeltTicket): WeltTicket | null => {
    if (x.kind === 'vorhaben') return x;
    let jetzt = x;
    for (let tiefe = 0; tiefe < 5 && jetzt.eltern; tiefe += 1) {
      const naechst = nachId.get(jetzt.eltern);
      if (!naechst) return null;
      if (naechst.kind === 'vorhaben') return naechst;
      jetzt = naechst;
    }
    return null;
  };
  const folge: string[] = [];
  const gruppen = new Map<string, WeltTicket[]>();
  for (const x of tickets) {
    const s = vorhabenVon(x)?.id ?? '';
    if (!gruppen.has(s)) { gruppen.set(s, []); folge.push(s); }
    gruppen.get(s)?.push(x);
  }
  const reihe = [...folge.filter((s) => s), ...(gruppen.has('') ? [''] : [])];
  return reihe.map((s) => ({
    id: s || 'ohne-vorhaben',
    titel: s ? (nachId.get(s)?.titel ?? s) : t('welten.board.ohneVorhaben'),
    spalten: BOARD_SPALTEN.map((name) => {
      const drin = (gruppen.get(s) ?? []).filter((x) => boardStaende(name).includes(x.stand));
      return { name, tickets: name === 'triage' ? backlogFolge(drin) : drin.sort((a, b) => (a.prioritaet !== b.prioritaet ? a.prioritaet - b.prioritaet : (a.id < b.id ? -1 : 1))) };
    }),
  }));
}

/** Ein Abzeichen an der Ticketkarte: Art, Priorität, Zyklus. */
function abzeichen(text: string, hilfe = '', hervor = false): HTMLSpanElement {
  const s = el('span', `wv-abzeichen${hervor ? ' hervor' : ''}`, text);
  if (hilfe) s.title = hilfe;
  return s;
}
/** Die Frist-Ampel: Punkt und Wort (Plan Satz 31). */
function ampel(stand: string, frist: string): HTMLSpanElement | null {
  if (!stand) return null;
  const s = el('span', `wv-ampel ${stand}`);
  s.append(punkt(ampelPunkt(stand)), el('span', undefined, ampelWort(stand)));
  s.title = frist ? `${ampelWort(stand)}: ${uhrzeit(frist)}` : ampelWort(stand);
  return s;
}

/** Zeile zwei der Karte: an wen, von wem, wie alt, Kinderzähler. */
function ticketZeile(w: Welt, x: WeltTicket): string {
  const an = x.adressaten.map((id) => anzeigename(w, id)).join(', ') || (x.team ? teamText(x.team) : '–');
  return [t('welten.ticket.an', { namen: an }), t('welten.ticket.von', { name: anzeigename(w, x.absender) }), alter(x.geaendert),
    ...(x.wartet_auf.length ? [t('welten.ticket.wartetAuf', { liste: x.wartet_auf.join(', ') })] : []),
    ...(x.kinder_gesamt ? [t('welten.ticket.kinder', { n: x.kinder_abgenommen, m: x.kinder_gesamt })] : [])].join(' · ');
}

/** Zeile drei: was der Stand erklären muss (Auftrag tickets4 A). Leer, wenn nichts zu sagen ist. */
export function ticketStandzeile(w: Welt, x: WeltTicket): string {
  const teile: string[] = [];
  const titelVon = (id: string): string => w.tickets.find((y) => y.id === id)?.titel ?? id;
  if (x.stand === 'wartet' && x.geparkt) {
    const weck = x.geparkt.bis ? t('welten.ticket.wecktBis', { zeit: uhrzeit(x.geparkt.bis) })
      : x.geparkt.auf ? t('welten.ticket.wecktAuf', { titel: titelVon(x.geparkt.auf) }) : t('welten.ticket.wecktOhne');
    teile.push(x.geparkt.grund ? `${weck}: ${x.geparkt.grund}` : weck);
  }
  if (x.stand === 'braucht dich' && x.flagge) teile.push(t('welten.ticket.brauchtGrund', { grund: x.flagge.grund || t('welten.ticket.ohneGrund') }));
  if (x.stand === 'verworfen' && x.verworfen) {
    teile.push(t('welten.ticket.verworfenGrund', { grund: verwerfGrundWort(x.verworfen.code) })
      + (x.verworfen.duplikat_von ? ` (${titelVon(x.verworfen.duplikat_von)})` : ''));
  } else if (x.duplikat_von) {
    teile.push(t('welten.ticket.duplikatVon', { titel: titelVon(x.duplikat_von) }));
  }
  if (x.stand === 'in Prüfung' && x.pruefung) teile.push(t('welten.ticket.prueft', { name: anzeigename(w, x.pruefung.pruefer) }));
  if (x.eltern) teile.push(t('welten.ticket.gehoertZu', { titel: titelVon(x.eltern), id: x.eltern }));
  return teile.join(' · ');
}

function ticketKarte(w: Welt, x: WeltTicket, ziehbar: boolean): HTMLElement {
  const b = el('button', 'wv-ticket');
  b.dataset.w = 'ticket'; b.dataset.arg = x.id; b.dataset.id = x.id;
  const oben = el('div', 'wv-ticket-oben');
  oben.append(punkt(ticketPunkt(x.stand)), el('span', 'wv-name', x.titel), el('span', 'wv-leise', ` · ${wort('stand', x.stand)}`),
    abzeichen(kindWort(x.kind), kindErklaerung(x.kind)),
    abzeichen(prioritaetWort(x.prioritaet), x.prioritaet_text || prioritaetText(x.prioritaet), prioritaetHervor(x.prioritaet)));
  const a = ampel(x.ampel, String(x.grenzen.frist ?? ''));
  if (a) oben.appendChild(a);
  // Ein abgelehnter Vorschlag schliesst sein Ticket ebenfalls als „abgenommen“; erst der
  // Stand des Vorschlags sagt, wie entschieden wurde.
  if (x.art === 'skill-vorschlag') oben.appendChild(el('span', 'wv-stufe', x.skill_vorschlag ? `${t('welten.vorschlag.titel')} · ${wort('vorschlag', x.skill_vorschlag.stand)}` : t('welten.vorschlag.titel')));
  b.append(oben, el('div', 'wv-leise wv-ticket-zeile', ticketZeile(w, x)));
  const zusatz = ticketStandzeile(w, x);
  if (zusatz) b.appendChild(el('div', 'wv-leise wv-ticket-standzeile', zusatz));
  if (ziehbar) {
    // Plan Satz 44 in der Electron-Fassung: die Reihenfolge geht mit den Pfeiltasten.
    b.classList.add('wv-ticket-ordnen');
    b.dataset.ordnen = x.id;
    const knoepfe = el('div', 'wv-zeile-knoepfe wv-ordnen');
    knoepfe.append(knopf('↑', 'backlog-hoch', x.id, 'knopf-rand wv-ordnen-knopf'), knopf('↓', 'backlog-runter', x.id, 'knopf-rand wv-ordnen-knopf'));
    b.appendChild(knoepfe);
    b.title = t('welten.backlog.ziehen');
  }
  return b;
}

// --- Das Board bei schmaler Mitte (Auftrag ticketboard) -----------------------------

/** Die Breiten einer vollen und einer zusammengeklappten Spalte und der Abstand dazwischen. */
const SPALTE_MIN = 140;
const SPALTE_MAX = 300;
const SPALTE_SCHMAL = 34;
const SPALTE_ABSTAND = 8;

/**
 * WIE DAS BOARD IN DIE MITTE PASST (Auftrag ticketboard; Befund tickets4: acht Spalten
 * rollten waagerecht aus dem Bild). Leere Spalten klappen zu einem schmalen Streifen mit
 * Titel und Zaehler zusammen, die uebrigen teilen sich den Platz zwischen Mindest- und
 * Hoechstbreite. Reicht er auch dann nicht, wechselt das Board in die gestapelte Ansicht:
 * die Staende als Reiter mit Zaehler, darunter ein Stand ueber die ganze Breite. Waagerecht
 * gerollt wird nie.
 *
 * `läuft` klappt nie zu, auch leer nicht: an ihrem Kopf haengt die WIP-Anzeige der Welt
 * (Plan Satz 48).
 */
export function boardLage(verfuegbar: number, spalten: { name: string; anzahl: number; offen: boolean }[]):
{ modus: 'spalten' | 'gestapelt'; breite: number; schmal: string[] } {
  const zu = spalten.filter((s) => s.anzahl === 0 && !s.offen && s.name !== 'läuft').map((s) => s.name);
  // Ein Board ganz ohne Tickets klappt nicht alles weg: dann stehen alle Spalten offen.
  const schmal = spalten.every((s) => s.anzahl === 0) ? [] : zu;
  const voll = spalten.length - schmal.length;
  if (verfuegbar <= 0 || voll <= 0) return { modus: 'spalten', breite: SPALTE_MIN, schmal };
  const rest = verfuegbar - Math.max(0, spalten.length - 1) * SPALTE_ABSTAND - schmal.length * SPALTE_SCHMAL;
  if (rest < voll * SPALTE_MIN) return { modus: 'gestapelt', breite: 0, schmal: [] };
  return { modus: 'spalten', breite: Math.min(SPALTE_MAX, Math.floor(rest / voll)), schmal };
}

/** Welcher Stand in der gestapelten Ansicht offen liegt: die Wahl, sonst der erste mit Tickets. */
function boardStand(zahlen: Map<string, number>): string {
  if (z.boardSpalte && BOARD_SPALTEN.includes(z.boardSpalte)) return z.boardSpalte;
  return BOARD_SPALTEN.find((s) => (zahlen.get(s) ?? 0) > 0) ?? BOARD_SPALTEN[0];
}

/**
 * Der Kopf einer Board-Spalte in seinen drei Gestalten: die offene Spalte (Punkt, Wort,
 * Zaehler, an `läuft` die WIP-Grenze), der schmale Streifen einer leeren Spalte (Zaehler und
 * senkrechter Titel, ein Klick klappt sie auf) und der Reiter der gestapelten Ansicht.
 */
function boardSpaltenkopf(w: Welt, spalte: string, anzahl: number, art: 'spalte' | 'schmal' | 'reiter', gewaehlt: boolean): HTMLElement {
  const k = el(art === 'spalte' ? 'div' : 'button', `wv-board-spaltenkopf${art === 'spalte' ? '' : ` ${art}`}${gewaehlt ? ' gewaehlt' : ''}`);
  k.dataset.spalte = spalte;
  k.dataset.anzahl = String(anzahl);
  if (art !== 'spalte') {
    (k as HTMLButtonElement).type = 'button';
    k.dataset.w = art === 'schmal' ? 'board-auf' : 'board-spalte';
    k.dataset.arg = spalte;
    k.setAttribute('aria-pressed', String(gewaehlt));
    k.title = art === 'schmal' ? t('welten.board.spalteAuf', { stand: wort('stand', spalte) })
      : t('welten.board.standZeigen', { stand: wort('stand', spalte) });
  }
  if (art === 'schmal') {
    k.append(el('div', 'wv-board-schmalzahl', String(anzahl)), el('div', 'wv-board-schmalname', wort('stand', spalte)));
    return k;
  }
  const zeile = el('div', 'wv-board-spaltenname');
  zeile.append(punkt(ticketPunkt(spalte)), el('span', undefined, wort('stand', spalte)), el('span', 'wv-leise', String(anzahl)));
  k.appendChild(zeile);
  if (spalte === 'läuft') {
    const wi = wipText(w);
    const e = el('div', `wv-board-wip${wi.rot ? ' rot' : ''}`, wi.text);
    e.title = t('welten.wip.hilfe');
    k.appendChild(e);
  }
  return k;
}

/** Eine Kachel des Boards: Titel, Abzeichen, Ampel und wer daran sitzt. */
function boardKachel(w: Welt, x: WeltTicket): HTMLElement {
  const k = el('button', 'wv-board-kachel');
  k.dataset.w = 'ticket'; k.dataset.arg = x.id; k.dataset.id = x.id;
  k.appendChild(el('div', 'wv-name', x.titel));
  const marken = el('div', 'wv-board-marken');
  marken.append(abzeichen(kindWort(x.kind), kindErklaerung(x.kind)),
    abzeichen(prioritaetWort(x.prioritaet), x.prioritaet_text || prioritaetText(x.prioritaet), prioritaetHervor(x.prioritaet)));
  const a = ampel(x.ampel, String(x.grenzen.frist ?? ''));
  if (a) marken.appendChild(a);
  k.appendChild(marken);
  k.appendChild(el('div', 'wv-leise', x.bearbeiter ? anzeigename(w, x.bearbeiter) : (x.adressaten[0] ? anzeigename(w, x.adressaten[0]) : t('welten.ticket.ohneAdressat'))));
  return k;
}

function boardZeichnen(w: Welt, tickets: WeltTicket[]): HTMLElement {
  const zahlen = new Map(BOARD_SPALTEN.map((s) => [s, tickets.filter((x) => boardStaende(s).includes(x.stand)).length]));
  const lage = boardLage(z.boardTestbreite || z.boardBreite,
    BOARD_SPALTEN.map((name) => ({ name, anzahl: zahlen.get(name) ?? 0, offen: z.boardOffen.has(name) })));
  const gestapelt = lage.modus === 'gestapelt';
  const offen = gestapelt ? boardStand(zahlen) : '';
  const box = el('div', `wv-board${gestapelt ? ' gestapelt' : ''}`);
  box.dataset.modus = lage.modus;
  // Die Testbreite steht auch im Bild: was die Ansicht entscheidet, zeigt sie auch so breit.
  if (z.boardTestbreite) box.style.width = `${z.boardTestbreite}px`;
  if (!gestapelt) {
    box.style.setProperty('--wv-board-spalten',
      BOARD_SPALTEN.map((s) => `${lage.schmal.includes(s) ? SPALTE_SCHMAL : lage.breite}px`).join(' '));
  }
  const kopf = el('div', 'wv-board-kopf');
  for (const spalte of BOARD_SPALTEN) {
    kopf.appendChild(boardSpaltenkopf(w, spalte, zahlen.get(spalte) ?? 0,
      gestapelt ? 'reiter' : lage.schmal.includes(spalte) ? 'schmal' : 'spalte', gestapelt && spalte === offen));
  }
  box.appendChild(kopf);
  if (gestapelt) box.appendChild(el('div', 'wv-leise wv-board-hinweis', t('welten.board.gestapelt')));
  const spuren = boardSpuren(w, tickets);
  if (!spuren.length) box.appendChild(el('div', 'wv-leer wv-leise', t('welten.tickets.keine')));
  for (const spur of spuren) {
    const s = el('div', 'wv-board-spur');
    s.dataset.spur = spur.id;
    s.appendChild(el('div', 'wv-board-spurname', spur.titel));
    const spalten = el('div', 'wv-board-spalten');
    for (const sp of spur.spalten) {
      if (gestapelt && sp.name !== offen) continue;
      const schmal = lage.schmal.includes(sp.name);
      const c = el('div', `wv-board-spalte${schmal ? ' schmal' : ''}`);
      c.dataset.spalte = sp.name;
      for (const x of sp.tickets) c.appendChild(boardKachel(w, x));
      if (!sp.tickets.length && !schmal) c.appendChild(el('div', 'wv-leise', gestapelt ? t('welten.board.keineImStand') : '–'));
      spalten.appendChild(c);
    }
    s.appendChild(spalten);
    box.appendChild(s);
  }
  return box;
}

function ticketFormular(w: Welt, e: TicketEntwurf): HTMLElement {
  const f = el('div', 'wv-karte wv-ticketformular');
  f.append(el('div', 'wv-karte-titel', t('welten.tickets.neuIn', { welt: w.name })),
    feld('input', 'ticket:titel', e.titel, t('welten.tickets.titel')),
    feld('textarea', 'ticket:ziel', e.ziel, t('welten.tickets.ziel')),
    feld('textarea', 'ticket:fertig', e.fertig, t('welten.tickets.fertig')));
  // Fertig-Punkte: hinzufuegen und entfernen (Plan Satz 2).
  const punkte = el('div', 'wv-punkte');
  punkte.appendChild(el('div', 'wv-leise', t('welten.tickets.punkte')));
  e.punkte.forEach((p, i) => {
    const zeile = el('div', 'wv-zeile-knoepfe');
    zeile.append(feld('input', `ticket:punkt:${i}`, p, t('welten.tickets.punkt')), knopf('−', 'ticket-punkt-weg', String(i)));
    punkte.appendChild(zeile);
  });
  punkte.appendChild(knopf(t('welten.tickets.punktPlus'), 'ticket-punkt-plus'));
  f.appendChild(punkte);
  f.append(auswahlFeld('ticket:art', e.kind, TICKET_ARTEN.map((k): [string, string] => [k, kindWort(k)])),
    el('div', 'wv-leise wv-ticket-arterklaerung', kindErklaerung(e.kind)),
    auswahlFeld('ticket:prioritaet', String(e.prioritaet), [0, 1, 2, 3].map((p): [string, string] => [String(p), `${prioritaetWort(p)} – ${prioritaetText(p)}`])),
    auswahlFeld('ticket:an', e.an, [['', t('welten.tickets.hauptagentEntscheidet')], ...w.teams.map((x): [string, string] => [`team:${x.name}`, teamText(x.name)]), ...w.liste.map((id): [string, string] => [id, anzeigename(w, id)])]));
  const elternArt = e.kind === 'story' ? 'vorhaben' : e.kind === 'task' ? 'story' : e.kind === 'subtask' ? 'task' : '';
  const elternWahl = elternArt ? w.tickets.filter((x) => x.kind === elternArt && x.stand !== 'verworfen' && x.stand !== 'abgenommen') : [];
  if (elternWahl.length) {
    f.appendChild(auswahlFeld('ticket:eltern', e.eltern, [['', t('welten.tickets.ohneEltern')], ...elternWahl.map((x): [string, string] => [x.id, x.titel])]));
  }
  f.append(auswahlFeld('ticket:abhaengig', e.abhaengig, [['', t('welten.tickets.ohneAbhaengigkeit')], ...w.tickets.filter((x) => x.stand !== 'verworfen').map((x): [string, string] => [x.id, x.titel])]),
    feld('input', 'ticket:frist', e.frist, t('welten.tickets.frist')),
    feld('input', 'ticket:runden', e.runden, t('welten.tickets.runden')));
  // Vorschau der Definition of Ready: sie warnt, sie blockt nicht (Plan Satz 45).
  const grund = bereitschaftText({ kind: e.kind, punkte: e.punkte.filter((p) => p.trim()).length, frist: e.frist, runden: e.runden, an: e.an, titel: e.titel, ziel: e.ziel, fertig: e.fertig });
  const vorschau = el('div', 'wv-dor');
  vorschau.dataset.bereit = grund ? 'nein' : 'ja';
  vorschau.append(punkt(grund ? 'will' : 'laeuft'), el('span', undefined, grund ? t('welten.dor.nicht', { grund }) : t('welten.dor.ja')));
  f.appendChild(vorschau);
  f.appendChild(el('div', 'wv-leise', t('welten.dor.hinweis')));
  const k = el('div', 'wv-zeile-knoepfe rechts');
  k.append(knopf(t('welten.knopf.abbrechen'), 'ticket-neu-zu'), knopf(t('welten.knopf.anlegen'), 'ticket-anlegen', '', 'knopf-voll'));
  f.appendChild(k);
  return f;
}

function ticketsZeichnen(w: Welt, a: WeltAgent | undefined): HTMLElement {
  const box = el('div', 'wv-tickets');
  const gewaehlt = z.ticketAuswahl ? w.tickets.find((x) => x.id === z.ticketAuswahl) : undefined;
  if (gewaehlt) { box.appendChild(ticketDetail(w, gewaehlt)); return box; }
  const kopf = el('div', 'wv-zeile-knoepfe');
  kopf.append(auswahlFeld('ticketfilter', z.ticketFilter, [['offen', t('welten.tickets.filterOffen')], ['alle', t('welten.tickets.filterAlle')], ...STAENDE.map((s): [string, string] => [s, wort('stand', s)])]),
    segment('ticketansicht', z.ticketAnsicht, [['liste', t('welten.tickets.liste')], ['board', t('welten.tickets.board')]]),
    knopf(t('welten.tickets.neu'), 'ticket-neu'));
  box.appendChild(kopf);
  if (z.neuesTicket) box.appendChild(ticketFormular(w, z.neuesTicket));
  const liste = ticketsFuer(w, a);
  if (z.ticketAnsicht === 'board') { box.appendChild(boardZeichnen(w, liste)); return box; }
  if (!liste.length) box.appendChild(el('div', 'wv-leer wv-leise', t('welten.tickets.keine')));
  for (const x of liste) box.appendChild(ticketKarte(w, x, z.ticketFilter === 'triage'));
  return box;
}

function karte(titel: string, ...inhalt: (HTMLElement | null)[]): HTMLElement {
  const k = el('div', 'wv-karte');
  k.appendChild(el('div', 'wv-karte-titel', titel));
  for (const i of inhalt) if (i) k.appendChild(i);
  return k;
}
function wert(name: string, text: string, mono = false): HTMLElement {
  const z2 = el('div', 'wv-wert');
  z2.append(el('div', 'wv-wert-name', name), el('div', `wv-wert-text${mono ? ' wv-mono' : ''}`, text || '–'));
  return z2;
}

function ticketDetail(w: Welt, tk: WeltTicket): HTMLElement {
  const box = el('div', 'wv-detail');
  box.dataset.ticket = tk.id;
  box.append(knopf(t('welten.tickets.alle'), 'ticket', '', 'wv-verweis'));
  const titel = el('div', 'wv-mtitel');
  titel.append(el('span', 'wv-titel', tk.titel), punkt(ticketPunkt(tk.stand)), el('span', 'wv-leise', ` ${wort('stand', tk.stand)}`));
  box.appendChild(titel);
  const v = tk.skill_vorschlag;
  if (v) {
    const k = karte(t('welten.vorschlag.titel'),
      el('div', undefined, t('welten.vorschlag.zeile', { skill: v.skill, agent: anzeigename(w, v.agent), ziel: t(v.ziel === 'bibliothek' ? 'welten.vorschlag.zielBibliothek' : v.ziel === 'agent' ? 'welten.vorschlag.zielAgent' : 'welten.vorschlag.zielWelt'), pruefer: anzeigename(w, v.pruefer), stand: wort('vorschlag', v.stand) })),
      v.beschreibung ? el('div', 'wv-leise', v.beschreibung) : null,
      v.begruendung ? el('div', 'wv-leise', t('welten.vorschlag.begruendung', { text: v.begruendung })) : null,
      el('div', 'wv-leise wv-mono', t('welten.vorschlag.version', { version: v.version.slice(0, 12), basis: v.basis_version ? v.basis_version.slice(0, 12) : t('welten.vorschlag.neu') })));
    const diff = el('pre', 'wv-diff');
    for (const zeile of (v.diff + (v.diff_gekuerzt ? `\n${t('welten.vorschlag.diffGekuerzt')}` : '')).split('\n')) {
      diff.appendChild(el('span', zeile.startsWith('+') && !zeile.startsWith('+++') ? 'plus' : zeile.startsWith('-') && !zeile.startsWith('---') ? 'minus' : '', `${zeile}\n`));
    }
    k.appendChild(diff);
    if (v.entschieden_von) k.appendChild(el('div', undefined, `${t(v.stand === 'übernommen' ? 'welten.vorschlag.uebernommenVon' : 'welten.vorschlag.abgelehntVon', { name: anzeigename(w, v.entschieden_von) })}${v.bemerkung || v.grund ? `: ${v.bemerkung ?? v.grund}` : ''}`));
    if (v.stand === 'offen' && tk.stand !== 'abgenommen' && tk.stand !== 'verworfen') {
      if (z.skillAblehnen === tk.id) {
        const f = el('div', 'wv-zeile-knoepfe');
        f.append(feld('input', 'skillgrund:', z.skillGrund, t('welten.vorschlag.grundPlatzhalter')), knopf(t('welten.knopf.abbrechen'), 'skill-ablehnen-zu'), knopf(t('welten.vorschlag.ablehnen'), 'skill-ablehnen', tk.id, 'knopf-rand gefahr'));
        k.appendChild(f);
      } else {
        const f = el('div', 'wv-zeile-knoepfe rechts');
        f.append(el('span', 'wv-leise', t('welten.vorschlag.pruefen')),
          knopf(t('welten.vorschlag.ablehnenOffen'), 'skill-ablehnen-offen', tk.id), knopf(t('welten.vorschlag.uebernehmen'), 'skill-abnehmen', tk.id, 'knopf-voll', z.laufend.has('skill_abnehmen')));
        k.appendChild(f);
      }
    }
    box.appendChild(k);
  }
  const titelVon = (id: string): string => w.tickets.find((y) => y.id === id)?.titel ?? id;
  const kinder = w.tickets.filter((x) => x.eltern === tk.id).sort((a, b) => (a.angelegt < b.angelegt ? -1 : 1));
  const auftrag = karte(t('welten.detail.auftrag'),
    wert(t('welten.tickets.ziel'), v ? (tk.ziel.split('\n\n')[0] ?? tk.ziel) : tk.ziel), wert(t('welten.tickets.fertig'), tk.fertig),
    wert(t('welten.detail.adressiertAn'), [...tk.adressaten.map((id) => anzeigename(w, id)), ...(tk.team ? [teamText(tk.team)] : [])].join(', ')),
    tk.bearbeiter ? wert(t('welten.detail.bearbeiter'), anzeigename(w, tk.bearbeiter)) : null, wert(t('welten.detail.absender'), anzeigename(w, tk.absender)), wert(t('welten.detail.angelegt'), uhrzeit(tk.angelegt)),
    tk.abhaengig.length ? wert(t('welten.detail.haengtAb'), tk.abhaengig.map((id) => `${anfuehrung(`„${titelVon(id)}“`)} (${w.tickets.find((y) => y.id === id)?.stand ?? '?'})`).join(', ')) : null,
    Object.keys(tk.grenzen).length ? wert(t('welten.detail.grenzen'), Object.entries(tk.grenzen).sort().map(([k2, v2]) => `${k2}: ${String(v2)}`).join(', ')) : null,
    tk.eltern ? wert(t('welten.detail.eltern'), anfuehrung(`„${titelVon(tk.eltern)}“`)) : null,
    tk.herkunft ? wert(t('welten.detail.herkunft'), anfuehrung(`„${titelVon(tk.herkunft)}“`)) : null);
  if (kinder.length) {
    auftrag.appendChild(wert(t('welten.detail.kinder'), t('welten.ticket.kinder', { n: tk.kinder_abgenommen, m: tk.kinder_gesamt })));
    const liste2 = el('div', 'wv-liste');
    for (const k2 of kinder) {
      const b = knopf(`${anfuehrung(`„${k2.titel}“`)} (${wort('stand', k2.stand)})`, 'ticket', k2.id, 'wv-verweis');
      liste2.appendChild(b);
    }
    auftrag.appendChild(liste2);
  }
  box.appendChild(auftrag);
  // Fertig-Liste mit Haken (Plan Satz 2); abgehakt wird vom Bearbeiter, hier nur gezeigt.
  if (tk.fertig_punkte.length) {
    const erledigt = tk.fertig_punkte.filter((p) => p.erledigt).length;
    const k = karte(t('welten.detail.fertigListe', { n: erledigt, m: tk.fertig_punkte.length }));
    for (const p of tk.fertig_punkte) {
      const zeile = el('div', `wv-fertigpunkt${p.erledigt ? ' erledigt' : ''}`);
      zeile.append(el('span', 'wv-haken', p.erledigt ? '☑' : '☐'), el('span', undefined, p.text));
      if (p.erledigt && p.von) zeile.appendChild(el('span', 'wv-leise', ` · ${anzeigename(w, p.von)}`));
      k.appendChild(zeile);
    }
    k.appendChild(el('div', 'wv-leise', t('welten.detail.fertigListeHinweis')));
    box.appendChild(k);
  }
  const zwischen = tk.verlauf.filter((e) => e.ereignis === 'zwischenstand');
  if (zwischen.length) {
    const k = karte(t('welten.detail.zwischenstaende'));
    for (const e of zwischen) {
      k.append(el('div', 'wv-leise', `${anzeigename(w, e.von)} · ${uhrzeit(e.zeit)}`), el('div', 'wv-ntext', e.text));
    }
    box.appendChild(k);
  }
  if (tk.ergebnis) box.appendChild(karte(t('welten.detail.ergebnis'), el('div', 'wv-ntext', tk.ergebnis.text), el('div', 'wv-leise', `${anzeigename(w, tk.ergebnis.von)} · ${uhrzeit(tk.ergebnis.zeit)}${tk.ergebnis.commit ? ` · Commit ${tk.ergebnis.commit}` : ''}`)));
  if (tk.pruefung) {
    box.appendChild(karte(t('welten.detail.pruefung'),
      wert(t('welten.detail.pruefer'), anzeigename(w, tk.pruefung.pruefer)),
      wert(t('welten.detail.angefordertVon'), anzeigename(w, tk.pruefung.angefordert_von)),
      tk.pruefung.urteil ? wert(t('welten.detail.urteil'), urteilWort(tk.pruefung.urteil)) : null,
      el('div', tk.pruefung.notiz ? 'wv-ntext' : 'wv-leise', tk.pruefung.notiz ?? t('welten.detail.pruefnotizFehlt'))));
  }
  if (tk.abnahme) {
    const k = karte(t(tk.stand === 'zurückgegeben' ? 'welten.detail.zurueckgegeben' : 'welten.detail.abnahme'),
      el('div', undefined, `${anzeigename(w, tk.abnahme.von)} · ${uhrzeit(tk.abnahme.zeit)}${tk.abnahme.grund ? ` · ${abnahmeGrundWort(tk.abnahme.grund)}` : ''}`),
      tk.abnahme.bemerkung ? el('div', 'wv-leise', tk.abnahme.bemerkung) : null);
    if (tk.stand === 'abgenommen') {
      if (z.rueckgabe === tk.id) {
        const f = el('div', 'wv-zeile-knoepfe');
        f.append(feld('input', 'rueckgabe:', z.rueckgabeText, t('welten.detail.wasFehlt')), knopf(t('welten.knopf.abbrechen'), 'rueckgabe-zu'), knopf(t('welten.detail.zurueckgeben'), 'zurueckgeben', tk.id, 'knopf-voll'));
        k.appendChild(f);
      } else {
        k.appendChild(knopf(t('welten.detail.zurueckgebenOffen'), 'rueckgabe', tk.id));
      }
    }
    box.appendChild(k);
  }
  if (tk.verworfen) {
    box.appendChild(karte(t('welten.detail.verworfen'),
      wert(t('welten.detail.grund'), verwerfGrundWort(tk.verworfen.code)),
      tk.verworfen.bemerkung ? wert(t('welten.detail.bemerkung'), tk.verworfen.bemerkung) : null,
      tk.verworfen.duplikat_von ? wert(t('welten.detail.duplikatVon'), anfuehrung(`„${titelVon(tk.verworfen.duplikat_von)}“`)) : null));
  }
  box.appendChild(handlungenZeichnen(w, tk));
  box.appendChild(karte(t('welten.detail.messung'),
    el('div', 'wv-messzeile', [t('welten.messung.durchlauf', { wert: dauerWort(tk.durchlaufzeit_s) }),
      t(tk.zuege === 1 ? 'welten.messung.zugEins' : 'welten.messung.zuegeViele', { n: tk.zuege }),
      t('welten.messung.alter', { wert: dauerWort(tk.alter_s) })].join(' · ')),
    tk.zyklus ? wert(t('welten.detail.zyklus'), tk.zyklus) : null));
  const verlauf = el('div', 'wv-liste');
  for (const e of tk.verlauf) verlauf.appendChild(el('div', 'wv-leise', `${uhrzeit(e.zeit)} · ${anzeigename(w, e.von)}: ${wort('ereignis', e.ereignis)}${e.text ? ` – ${e.text}` : ''}`));
  box.appendChild(karte(t('welten.detail.verlauf'), verlauf));
  return box;
}

/**
 * WELCHE HANDLUNGEN DER KERN DEM MENSCHEN ERLAUBT (docs/AGENTS-DATEN.md, Plan Sätze 22,
 * 23, 25, 27, 31, 39). Was er nicht erlaubt, bietet die Ansicht nicht an: Parken,
 * Zwischenstand, Haken und Prüfnotiz gehören dem Bearbeiter beziehungsweise dem Prüfer.
 */
export function moeglicheHandlungen(tk: WeltTicket): TicketHandlung[] {
  const raus: TicketHandlung[] = [];
  if (tk.stand === 'triage') raus.push('annehmen');
  if (tk.stand !== 'abgenommen') raus.push('verwerfen');
  raus.push('umadressieren');
  if (tk.stand !== 'abgenommen' && tk.stand !== 'verworfen') raus.push('grenzen');
  if (tk.stand === 'zur Abnahme') raus.push('pruefer');
  // Abnehmen aus denselben zwei Staenden wie der Kern (`approve_ticket`); nur ein echter Klick zaehlt.
  if (tk.stand === 'zur Abnahme' || tk.stand === 'zurückgegeben') raus.push('abnehmen');
  return raus;
}

/**
 * Was der Abnahme noch fehlt, als Textschluessel; null = bereit. Dieselben Regeln wie im Kern
 * und am Mac, dazu kein `|` in der Bemerkung (Trennzeichen des Mobilbelegs).
 */
export function abnahmeFehlt(e: Pick<TicketHandlungEntwurf, 'grund' | 'bemerkung' | 'dodGeprueft'>, dod: string[]): string | null {
  const bemerkung = e.bemerkung.trim();
  if (!ABNAHME_GRUENDE.includes(e.grund)) return 'welten.abnehmen.grundFehlt';
  if (e.grund === 'teilweise' && !bemerkung) return 'welten.abnehmen.bemerkungPflicht';
  if (bemerkung.includes('|')) return 'welten.abnehmen.trennzeichen';
  if (dod.length && !e.dodGeprueft) return 'welten.abnehmen.dodFehlt';
  return null;
}

/** Ob die offene Handlung ausgefuehrt werden darf (dieselben Regeln wie am Mac). */
function handlungBereit(e: TicketHandlungEntwurf, w: Welt): boolean {
  switch (e.handlung) {
    case 'verwerfen': return e.grund !== 'duplikat' || !!e.duplikat;
    case 'annehmen': return !!e.an;
    case 'umadressieren': return !!e.an && !!e.grund.trim();
    case 'grenzen': return !!e.frist || !!e.runden;
    case 'pruefer': return !!e.pruefer;
    case 'abnehmen': return abnahmeFehlt(e, w.dod) === null;
    default: return false;
  }
}

function handlungenZeichnen(w: Welt, tk: WeltTicket): HTMLElement {
  const offen = z.ticketHandlung && z.ticketHandlung.ticket === tk.id ? z.ticketHandlung : null;
  if (!offen) {
    const k = karte(t('welten.handlung.titel'));
    const zeile = el('div', 'wv-zeile-knoepfe');
    for (const h of moeglicheHandlungen(tk)) zeile.appendChild(knopf(t(`welten.handlung.${h}`), 'handlung', `${h}|${tk.id}`));
    k.append(zeile, el('div', 'wv-leise', t('welten.handlung.hinweis')));
    return k;
  }
  const k = karte(t(`welten.handlung.${offen.handlung}`));
  k.dataset.handlung = offen.handlung;
  const adressat = (): HTMLElement => auswahlFeld('handlung:an', offen.an,
    [['', t('welten.handlung.bitteWaehlen')], ...w.teams.map((x): [string, string] => [`team:${x.name}`, teamText(x.name)]), ...w.liste.map((id): [string, string] => [id, anzeigename(w, id)])]);
  switch (offen.handlung) {
    case 'verwerfen':
      k.append(auswahlFeld('handlung:grund', offen.grund, VERWERF_GRUENDE.map((g): [string, string] => [g, verwerfGrundWort(g)])),
        feld('input', 'handlung:bemerkung', offen.bemerkung, t('welten.handlung.bemerkungFrei')));
      if (offen.grund === 'duplikat') {
        k.appendChild(auswahlFeld('handlung:duplikat', offen.duplikat,
          [['', t('welten.handlung.bitteWaehlen')], ...w.tickets.filter((x) => x.id !== tk.id).map((x): [string, string] => [x.id, x.titel])]));
      }
      break;
    case 'annehmen':
      k.append(adressat(), auswahlFeld('handlung:art', offen.kind, TICKET_ARTEN.map((a): [string, string] => [a, kindWort(a)])),
        auswahlFeld('handlung:prioritaet', String(offen.prioritaet), [0, 1, 2, 3].map((p): [string, string] => [String(p), `${prioritaetWort(p)} – ${prioritaetText(p)}`])));
      offen.punkte.forEach((p, i) => {
        const zeile = el('div', 'wv-zeile-knoepfe');
        zeile.append(feld('input', `handlung:punkt:${i}`, p, t('welten.tickets.punkt')), knopf('−', 'handlung-punkt-weg', String(i)));
        k.appendChild(zeile);
      });
      k.appendChild(knopf(t('welten.tickets.punktPlus'), 'handlung-punkt-plus'));
      break;
    case 'umadressieren':
      k.append(adressat(), feld('input', 'handlung:grund', offen.grund, t('welten.handlung.grund')));
      break;
    case 'grenzen':
      k.append(feld('input', 'handlung:frist', offen.frist, t('welten.tickets.frist')), feld('input', 'handlung:runden', offen.runden, t('welten.tickets.runden')));
      break;
    case 'pruefer':
      k.append(auswahlFeld('handlung:pruefer', offen.pruefer,
        [['', t('welten.handlung.bitteWaehlen')], ...w.agenten.filter((a) => a.id !== tk.bearbeiter && a.stand === 'aktiv').map((a): [string, string] => [a.id, a.name])]),
        el('div', 'wv-leise', t('welten.handlung.prueferHinweis')));
      break;
    case 'abnehmen': {
      k.append(auswahlFeld('handlung:grund', offen.grund, ABNAHME_GRUENDE.map((g): [string, string] => [g, abnahmeGrundWort(g)])),
        feld('input', 'handlung:bemerkung', offen.bemerkung, t(offen.grund === 'teilweise' ? 'welten.abnehmen.bemerkungOffen' : 'welten.handlung.bemerkungFrei')));
      if (w.dod.length) {
        const punkte = el('div', 'wv-punkte');
        punkte.appendChild(el('div', 'wv-leise', t('welten.abnehmen.dodTitel')));
        for (const p of w.dod) {
          const zeile = el('div', 'wv-fertigpunkt');
          zeile.append(el('span', 'wv-haken', offen.dodGeprueft ? '☑' : '☐'), el('span', undefined, p));
          punkte.appendChild(zeile);
        }
        const haken = knopf(`${offen.dodGeprueft ? '☑' : '☐'} ${t('welten.abnehmen.dodGeprueft')}`, 'handlung-dod', '', 'knopf-rand');
        haken.setAttribute('role', 'checkbox');
        haken.setAttribute('aria-checked', String(offen.dodGeprueft));
        const zeile = el('div', 'wv-zeile-knoepfe');
        zeile.appendChild(haken);
        punkte.appendChild(zeile);
        k.appendChild(punkte);
      }
      k.appendChild(el('div', 'wv-leise', t('welten.abnehmen.endgueltig', { titel: tk.titel })));
      const fehlt = abnahmeFehlt(offen, w.dod);
      if (fehlt && (fehlt === 'welten.abnehmen.bemerkungPflicht' || fehlt === 'welten.abnehmen.trennzeichen')) {
        k.appendChild(el('div', 'wv-warnung', t(fehlt)));
      }
      break;
    }
    default: break;
  }
  const knoepfe = el('div', 'wv-zeile-knoepfe rechts');
  knoepfe.append(knopf(t('welten.knopf.abbrechen'), 'handlung-zu'),
    knopf(t(`welten.handlung.${offen.handlung}Knopf`), 'handlung-ausfuehren', '', 'knopf-voll', !handlungBereit(offen, w)));
  k.appendChild(knoepfe);
  return k;
}

/**
 * Ein Vorhaben mit Fortschritt (Plan Sätze 42 und 51): „3 von 5 Stories abgenommen".
 * Ein abgeschlossenes steht markiert und zuletzt.
 */
export function vorhabenStand(w: Welt): { id: string; titel: string; stand: string; abgenommen: number; gesamt: number; fertig: boolean }[] {
  return w.tickets.filter((x) => x.kind === 'vorhaben').map((v) => {
    const stories = w.tickets.filter((x) => x.eltern === v.id && x.stand !== 'verworfen');
    return { id: v.id, titel: v.titel, stand: v.stand, abgenommen: stories.filter((x) => x.stand === 'abgenommen').length, gesamt: stories.length, fertig: v.stand === 'abgenommen' };
  }).sort((a, b) => (a.fertig !== b.fertig ? Number(a.fertig) - Number(b.fertig) : (a.id < b.id ? -1 : 1)));
}

/** Karten „Braucht dich", „Triage" und „Vorhaben" für den Weltinspektor (Auftrag tickets4 E). */
function weltUeberblick(w: Welt): HTMLElement[] {
  const raus: HTMLElement[] = [];
  const braucht = w.tickets.filter((x) => x.stand === 'braucht dich');
  if (braucht.length) {
    const k = karte(t('welten.uebersicht.brauchtDich'));
    for (const x of braucht) {
      const b = knopf(`${anfuehrung(`„${x.titel}“`)} – ${x.flagge?.grund || t('welten.ticket.ohneGrund')}`, 'ticket', x.id, 'wv-verweis');
      b.dataset.brauchtDich = x.id;
      k.appendChild(b);
    }
    raus.push(k);
  }
  const backlog = backlogVon(w);
  if (backlog.length) {
    const k = karte(t('welten.uebersicht.triage'));
    backlog.slice(0, 5).forEach((x, i) => {
      const b = knopf(`${i + 1}. ${x.titel} · ${kindWort(x.kind)}`, 'ticket', x.id, 'wv-verweis');
      b.dataset.triage = x.id;
      k.appendChild(b);
    });
    if (backlog.length > 5) k.appendChild(el('div', 'wv-leise', t('welten.uebersicht.triageMehr', { n: backlog.length - 5 })));
    raus.push(k);
  }
  const vorhaben = vorhabenStand(w);
  if (vorhaben.length) {
    const k = karte(t('welten.uebersicht.vorhaben'));
    for (const v of vorhaben) {
      const b = knopf(`${v.titel} · ${t('welten.uebersicht.stories', { n: v.abgenommen, m: v.gesamt })}${v.fertig ? ` · ${t('welten.uebersicht.abgeschlossen')}` : ''}`, 'ticket', v.id, `wv-verweis${v.fertig ? ' wv-fertig' : ''}`);
      b.dataset.vorhaben = v.id;
      k.appendChild(b);
    }
    raus.push(k);
  }
  return raus;
}

/** Zyklus, Definition of Done und WIP-Grenze der Welt (Auftrag tickets4 D). */
function weltRegelKarten(w: Welt): HTMLElement[] {
  const r = z.weltRegeln && z.weltRegeln.welt === w.pfad ? z.weltRegeln : null;
  const zyklus = karte(t('welten.zyklus.titel'));
  if (w.zyklus.jetzt && w.zyklus.an) {
    zyklus.append(wert(t('welten.zyklus.laeuft'), `${w.zyklus.jetzt.id} · ${uhrzeit(w.zyklus.jetzt.start)} – ${uhrzeit(w.zyklus.jetzt.ende)}`));
    if (w.zyklus.jetzt.ziel) zyklus.appendChild(wert(t('welten.zyklus.ziel'), w.zyklus.jetzt.ziel));
  } else if (w.zyklus.jetzt) {
    zyklus.appendChild(wert(t('welten.zyklus.aus'), w.zyklus.jetzt.id));
  } else {
    zyklus.appendChild(el('div', 'wv-leise', t('welten.zyklus.ohne')));
  }
  zyklus.appendChild(wert(t('welten.zyklus.laenge'), t(w.zyklus.tage === 1 ? 'welten.zyklus.tagEins' : 'welten.zyklus.tageViele', { n: w.zyklus.tage })));
  if (r) {
    zyklus.append(feld('input', 'regel:tage', r.tage, t('welten.zyklus.tageFeld')), feld('input', 'regel:ziel', r.ziel, t('welten.zyklus.zielFeld')));
    const k = el('div', 'wv-zeile-knoepfe');
    k.appendChild(knopf(t(w.zyklus.an ? 'welten.zyklus.neu' : 'welten.zyklus.ein'), 'zyklus-ein'));
    if (w.zyklus.an) k.appendChild(knopf(t('welten.zyklus.ausschalten'), 'zyklus-aus'));
    zyklus.appendChild(k);
  } else {
    zyklus.appendChild(knopf(t('welten.knopf.bearbeiten'), 'regeln-bearbeiten'));
  }
  for (const h of [...w.zyklus.historie].reverse()) {
    const e = el('div', 'wv-leise wv-zyklus-historie', t('welten.zyklus.historie', { id: h.id, a: h.angelegt, b: h.abgenommen, c: h.uebertragen }));
    e.dataset.zyklus = h.id;
    zyklus.appendChild(e);
  }
  const dod = karte(t('welten.dod.titel'));
  if (r) {
    r.dod.forEach((p, i) => {
      const zeile = el('div', 'wv-zeile-knoepfe');
      zeile.append(feld('input', `regel:dod:${i}`, p, t('welten.dod.punkt')), knopf('−', 'dod-punkt-weg', String(i)));
      dod.appendChild(zeile);
    });
    const k = el('div', 'wv-zeile-knoepfe');
    k.append(knopf(t('welten.dod.punktPlus'), 'dod-punkt-plus'), knopf(t('welten.knopf.sichern'), 'dod-sichern', '', 'knopf-voll'));
    dod.appendChild(k);
  } else if (!w.dod.length) {
    dod.appendChild(el('div', 'wv-leise', t('welten.dod.keine')));
  } else {
    for (const p of w.dod) dod.appendChild(el('div', 'wv-dod-punkt', `✓ ${p}`));
  }
  const wi = wipText(w);
  const wip = karte(t('welten.wip.titel'));
  const zeile = el('div', `wv-wip${wi.rot ? ' rot' : ''}`, `${wi.text} – ${t(wi.rot ? 'welten.wip.ueber' : 'welten.wip.text')}`);
  wip.appendChild(zeile);
  if (r) {
    wip.append(feld('input', 'regel:wip', r.wip, t('welten.wip.feld')), knopf(t('welten.wip.setzen'), 'wip-setzen'));
    wip.appendChild(knopf(t('welten.knopf.abbrechen'), 'regeln-zu'));
  }
  return [zyklus, dod, wip];
}

// --- Rechteantraege (Vertrag rantrag, 13.10.2026) ----------------------------------

/** Datum und Uhrzeit, auch heute mit Datum: „abgelaufen am …“ braucht den Tag. */
function datumUhr(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return t('welten.zeit.datum', { tag: zweistellig(d.getDate()), monat: zweistellig(d.getMonth() + 1), uhr: `${zweistellig(d.getHours())}:${zweistellig(d.getMinutes())}` });
}

/** Offen und noch entscheidbar; die Uhr der Oberflaeche zaehlt mit, falls der Kern seit dem Ablauf nicht neu gelesen hat. */
export function rantragOffen(x: Pick<WeltRechteAntrag, 'stand' | 'abgelaufen' | 'laeuft_ab'>, jetzt = Date.now()): boolean {
  if (x.stand !== 'offen' || x.abgelaufen) return false;
  const ab = Date.parse(x.laeuft_ab);
  return Number.isFinite(ab) && ab > jetzt;
}

const gross = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function rantragStand(x: WeltRechteAntrag): string {
  if (x.stand === 'offen') return t(rantragOffen(x) ? 'welten.rantrag.stand.offen' : 'welten.rantrag.stand.abgelaufen');
  if (x.stand === 'beantwortet' && x.entscheidung) return wort('rantrag.stand', x.entscheidung);
  return wort('rantrag.stand', x.stand);
}

/**
 * Je Feld der gespeicherten Aenderung eine Zeile „vorher → nachher“, darunter, was dazukommt und was wegfaellt.
 * Nachher so, wie die Bibliothek es schreibt (`_plan_rights`): Bash ist immer dabei, `web` setzt WebFetch und
 * WebSearch, die Dienstwegmuster (`fest`) gibt sie selbst dazu -- gezeigt werden deshalb nur die eigenen Muster.
 */
export function rantragAenderung(x: Pick<WeltRechteAntrag, 'changes' | 'vorher'>, fest: string[] = []): { feld: string; vorher: string; nachher: string; plus: string[]; minus: string[] }[] {
  const zeilen: { feld: string; vorher: string; nachher: string; plus: string[]; minus: string[] }[] = [];
  const liste = (l: string[]): string => (l.length ? l.join(', ') : t('welten.rantrag.keine'));
  const zeile = (feld: string, alt: string[], neu: string[]): void => {
    zeilen.push({ feld, vorher: liste(alt), nachher: liste(neu), plus: neu.filter((v) => !alt.includes(v)), minus: alt.filter((v) => !neu.includes(v)) });
  };
  const web = x.changes.web;
  if (x.changes.tools || typeof web === 'boolean') {
    const alt = x.vorher.tools ?? [];
    let neu = [...(x.changes.tools ?? alt)];
    if (web === true) neu.push(...WEB.filter((v) => !neu.includes(v)));
    if (web === false) neu = neu.filter((v) => !WEB.includes(v));
    if (!neu.includes('Bash')) neu.push('Bash');
    if (x.changes.tools || neu.join() !== alt.join()) zeile(t('welten.rantrag.werkzeuge'), alt, neu);
  }
  if (x.changes.bash) zeile(t('welten.rantrag.bash'), eigeneMuster(x.vorher.bash ?? [], '', fest), eigeneMuster(x.changes.bash, '', fest));
  if (x.changes.skills) zeile(t('welten.rantrag.skills'), x.vorher.skills ?? [], x.changes.skills);
  if (typeof web === 'boolean') {
    const alt = typeof x.vorher.web === 'boolean' ? x.vorher.web : (x.vorher.tools ?? []).some((v) => WEB.includes(v));
    const an = (b: boolean): string => t(b ? 'welten.rantrag.webAn' : 'welten.rantrag.webAus');
    zeilen.push({ feld: t('welten.rantrag.web'), vorher: an(alt), nachher: an(web), plus: [], minus: [] });
  }
  return zeilen;
}

function rantragZeichnen(w: Welt, x: WeltRechteAntrag): HTMLElement {
  const offen = rantragOffen(x);
  const box = el('div', `wv-rantrag${offen ? ' offen' : ''}${x.stand === 'offen' && !offen ? ' abgelaufen' : ''}`);
  box.dataset.id = x.id;
  box.appendChild(el('div', 'wv-rantrag-kopf', t('welten.rantrag.kopf', { name: anzeigename(w, x.agent), stand: rantragStand(x) })));
  const aenderung = el('div', 'wv-rantrag-aenderung');
  const stufe = agentVon(w, x.agent)?.stufe ?? 'mitglied';
  for (const z2 of rantragAenderung(x, dienstweg(stufe))) {
    const zeile = el('div');
    zeile.append(el('span', 'wv-rantrag-feld', `${z2.feld}: `), el('span', 'wv-rantrag-alt', z2.vorher), document.createTextNode(' → '), el('span', 'wv-rantrag-neu', z2.nachher));
    aenderung.appendChild(zeile);
    if (z2.plus.length || z2.minus.length) {
      const d = el('div', 'wv-leise');
      if (z2.plus.length) d.appendChild(el('span', 'wv-rantrag-plus', `+ ${z2.plus.join(', ')}`));
      if (z2.plus.length && z2.minus.length) d.appendChild(document.createTextNode('  '));
      if (z2.minus.length) d.appendChild(el('span', 'wv-rantrag-minus', `− ${z2.minus.join(', ')}`));
      aenderung.appendChild(d);
    }
  }
  if (aenderung.childElementCount) box.appendChild(aenderung);
  if (x.grund) box.appendChild(wert(t('welten.rantrag.grund'), x.grund));
  if (offen) {
    const anMensch = x.an === 'mensch';
    box.appendChild(el('div', 'wv-leise', anMensch ? t('welten.rantrag.anDich')
      : t('welten.rantrag.entscheidet', { name: x.an ? anzeigename(w, x.an) : t('welten.antrag.derHauptagent') })));
    if (x.laeuft_ab) box.appendChild(el('div', 'wv-leise', t('welten.rantrag.laeuftAb', { zeit: datumUhr(x.laeuft_ab) })));
    if (!w.rechteantrag_entscheidbar) {
      box.appendChild(el('div', 'wv-warnung wv-rantrag-nurlesen', t('welten.rantrag.nurLesen')));
    } else {
      const aus = z.laufend.has('rechte_antrag_entscheiden');
      const zeile = el('div', 'wv-zeile-knoepfe');
      zeile.append(feld('input', `rantrag:${x.id}`, z.rantragBemerkung.get(x.id) ?? '', t('welten.rantrag.bemerkungFeld')),
        knopf(t('welten.rantrag.freigeben'), 'rantrag-freigeben', x.id, anMensch ? 'knopf-voll' : 'knopf-rand', aus),
        knopf(t('welten.rantrag.ablehnen'), 'rantrag-ablehnen', x.id, 'knopf-rand', aus));
      box.append(zeile, el('div', 'wv-leise', t('welten.rantrag.gespeichert')));
    }
  } else if (x.stand === 'offen') {
    box.appendChild(el('div', 'wv-warnung', t('welten.rantrag.abgelaufen', { zeit: datumUhr(x.laeuft_ab) })));
  } else if (x.stand === 'zurueckgezogen') {
    box.appendChild(el('div', 'wv-leise', t('welten.rantrag.zurueckgezogen', { name: anzeigename(w, x.entschieden_von ?? x.agent), zeit: datumUhr(x.entschieden_am) })));
  } else {
    const durchDich = x.entschieden_von === 'mensch' || x.entschieden_von === 'alice';
    box.appendChild(el('div', 'wv-leise', t(durchDich ? 'welten.rantrag.entschiedenDu' : 'welten.rantrag.entschieden', {
      entscheidung: gross(x.entscheidung ? wort('rantrag.stand', x.entscheidung) : t('welten.rantrag.stand.beantwortet')),
      name: x.entschieden_von ? anzeigename(w, x.entschieden_von) : '–', zeit: datumUhr(x.entschieden_am),
    })));
  }
  if (x.bemerkung && x.stand !== 'offen') box.appendChild(el('div', 'wv-leise', t('welten.rantrag.bemerkung', { text: x.bemerkung })));
  return box;
}

/** Die Karte „Rechteanträge“ der Welt; null ohne Antraege. */
function rantragKarte(w: Welt): HTMLElement | null {
  if (!w.rechteantraege.length) return null;
  const k = karte(t('welten.rantrag.titel'));
  k.classList.add('wv-rantragkarte');
  for (const x of w.rechteantraege) k.appendChild(rantragZeichnen(w, x));
  return k;
}

function inspektorZeichnen(w: Welt): HTMLElement {
  const box = el('aside', 'wv-inspektor');
  if (z.anlegen) { box.appendChild(anlegenVorschau(z.anlegen)); return box; }
  const a = agentVon(w, agentId());
  if (!a) {
    box.appendChild(el('div', 'wv-ikopf', t('welten.welt.titel')));
    const inhalt = el('div', 'wv-iinhalt');
    inhalt.append(el('div', 'wv-titel', w.name), karte(t('welten.welt.titel'), wert(t('welten.welt.art'), t(w.art === 'global' ? 'welten.global' : 'welten.welt.projekt')), wert(t('welten.welt.ablage'), w.fern ? `${w.maschine}:${w.ablage}` : kurzerPfad(w.pfad), true),
      wert(t('welten.welt.stand'), `${wort('stand', w.stand)}${w.stand_grund ? `, ${w.stand_grund}` : ''}`), wert(t('welten.stufe.hauptagent'), w.hauptagent ? anzeigename(w, w.hauptagent) : t('welten.wort.keiner')),
      wert(t('welten.leiste.agenten'), t(w.teams.length === 1 ? 'welten.welt.agentenTeamEins' : 'welten.welt.agentenTeamsViele', { n: w.agenten.length, m: w.teams.length })),
      wert(t('welten.reiter.tickets'), t('welten.welt.ticketsTriage', { n: w.tickets.length, m: w.zaehler.tickets_offen, k: w.zaehler.triage })), wert(t('welten.welt.fragen'), t('welten.welt.fragenOffen', { n: w.fragen.filter((f) => f.stand === 'offen').length, m: w.fragen.length }))));
    // tickets4: was dich braucht, das Backlog und die Vorhaben (Auftrag E); die
    // Electron-Fassung hat keine eigene Uebersichtsseite, also stehen sie hier.
    inhalt.append(...weltUeberblick(w));
    inhalt.append(...weltRegelKarten(w));
    if (w.maschine) {
      const mk = karte(t('welten.maschine.titel'),
        wert(t('welten.maschine.titel'), w.fern ? maschineWort(w.maschine) : t('welten.maschine.diese', { maschine: maschineWort(w.maschine) })),
        w.fern ? wert(t('welten.maschine.verbindung'), w.verbindung.ok ? t('welten.maschine.erreichbar') : t('welten.maschine.wegSeit', { zeit: uhrzeit(w.verbindung.seit), text: w.verbindung.text })) : null,
        wert(t('welten.maschine.traeger'), traegerWort(w)));
      mk.classList.add('wv-maschinenkarte');
      const ziele = w.fern ? [] : (nutzlast?.maschinen ?? []).filter((m) => !m.eigene && m.traeger);
      for (const m of ziele) {
        const k = knopf(t('welten.maschine.umziehen', { maschine: m.name }), 'umziehen', m.name, 'knopf-rand', z.laufend.has('umziehen'));
        k.title = t('welten.maschine.umziehenText');
        mk.appendChild(k);
      }
      if (ziele.length) mk.appendChild(el('div', 'wv-leise', t('welten.maschine.umziehenText')));
      inhalt.appendChild(mk);
    }
    if (w.zugaenge.length) {
      inhalt.appendChild(karte(t('welten.zugaenge.titel'), el('div', undefined, t('welten.zugaenge.zeile', { liste: w.zugaenge.map((x) => `${x.name} (${x.art})`).join(', ') }))));
    }
    const stopp = karte(t('welten.welt.sofortstopp'), el('div', 'wv-leise', t('welten.welt.sofortstoppText')));
    if (w.stand !== 'gestoppt') stopp.appendChild(knopf(t('welten.welt.stoppen'), 'stoppen', '', 'knopf-rand gefahr'));
    inhalt.appendChild(stopp);
    if (w.antraege.length) {
      const k = karte(t('welten.antrag.titel'));
      for (const x of w.antraege) k.appendChild(el('div', undefined, t('welten.antrag.zeile', { agent: x.agent, team: teamWort(x.team ?? ''), stand: t(x.stand === 'offen' ? 'welten.antrag.offen' : x.entscheidung === 'anlegen' ? 'welten.antrag.angelegt' : 'welten.antrag.abgelehnt'), name: anzeigename(w, x.von), text: x.spezialgebiet })));
      k.appendChild(el('div', 'wv-leise', t('welten.antrag.entscheidet', { name: w.hauptagent ? anzeigename(w, w.hauptagent) : t('welten.antrag.derHauptagent') })));
      inhalt.appendChild(k);
    }
    const rk = rantragKarte(w);
    if (rk) inhalt.appendChild(rk);
    if (w.skills_fehler) inhalt.appendChild(el('div', 'wv-warnung', w.skills_fehler));
    box.appendChild(inhalt);
    return box;
  }
  const kopf = el('div', 'wv-ikopf');
  kopf.appendChild(segment('blatt', z.blatt, [['profil', t('welten.blatt.profil')], ['protokoll', t('welten.blatt.protokoll')], ['gedaechtnis', t('welten.blatt.gedaechtnis')], ['skills', t('welten.blatt.skills')]]));
  box.appendChild(kopf);
  const inhalt = el('div', 'wv-iinhalt');
  if (z.blatt === 'profil') profilBlatt(w, a, inhalt);
  else if (z.blatt === 'protokoll') {
    const k = karte(t('welten.blatt.protokoll'), el('div', 'wv-leise', t('welten.protokoll.hinweis', { name: a.name })));
    const eintraege = [
      ...(a.verlauf as { time?: string; event?: string; note?: string; stand?: string }[]).map((e) => ({ zeit: e.time ?? '', text: `${wort('ereignis', e.event ?? '')}${e.event === 'rechte-antrag' && e.stand ? ` ${wort('rantrag.stand', e.stand)}` : ''}${e.note ? ` – ${e.note}` : ''}` })),
      ...w.tickets.flatMap((x) => x.verlauf.filter((e) => e.von === a.id).map((e) => ({ zeit: e.zeit, text: `${t('welten.protokoll.ticketEintrag', { ereignis: wort('ereignis', e.ereignis), titel: x.titel })}${e.text ? ` – ${e.text}` : ''}` }))),
    ].sort((x, y) => (x.zeit < y.zeit ? 1 : -1));
    for (const e of eintraege) k.appendChild(el('div', undefined, `${uhrzeit(e.zeit)} · ${e.text}`));
    inhalt.appendChild(k);
  } else if (z.blatt === 'gedaechtnis') {
    if (z.gedaechtnis && z.gedaechtnis.agent === a.id) {
      const k = karte(t('welten.gedaechtnis.bearbeiten'), el('div', 'wv-warnung', t('welten.gedaechtnis.warnung', { name: a.name })),
        feld('textarea', 'gedaechtnis:', z.gedaechtnis.text));
      const knoepfe = el('div', 'wv-zeile-knoepfe rechts');
      knoepfe.append(knopf(t('welten.knopf.verwerfen'), 'gedaechtnis-zu'), knopf(t('welten.knopf.sichern'), 'gedaechtnis-sichern', '', 'knopf-voll'));
      k.appendChild(knoepfe);
      inhalt.appendChild(k);
    } else {
      inhalt.appendChild(karte('MEMORY.md', el('pre', 'wv-md', a.gedaechtnis.text || t('welten.wort.leer')), knopf(t('welten.knopf.bearbeitenOffen'), 'gedaechtnis-bearbeiten')));
    }
  } else {
    skillBlatt(a, inhalt);
  }
  box.appendChild(inhalt);
  return box;
}

function profilBlatt(w: Welt, a: WeltAgent, inhalt: HTMLElement): void {
  const kopf = el('div', 'wv-profilkopf');
  const pt = el('div');
  const zeile = el('div');
  zeile.append(uhrWort('wv-leben', a.id, 'leben', agentWort(a)));
  pt.append(el('div', 'wv-titel', a.name), el('div', 'wv-leise', `${stufeWort(a.stufe)}${a.team ? ` · ${teamText(a.team)}` : ''}`), zeile);
  kopf.append(agentFigur(a, 64), pt);
  inhalt.appendChild(kopf);
  const offeneRechte = w.rechteantraege.filter((x) => x.agent === a.id && rantragOffen(x)).length;
  if (offeneRechte) {
    const h = el('div', 'wv-rantrag-hinweis');
    h.append(el('div', undefined, t(offeneRechte === 1 ? 'welten.rantrag.agentHinweisEins' : 'welten.rantrag.agentHinweisViele', { name: a.name, n: offeneRechte })),
      knopf(t('welten.rantrag.zeigen'), 'waehlen', KANAL, 'wv-verweis'));
    inhalt.appendChild(h);
  }
  const lk = lebenszeichenKarte(w, a);
  if (lk) inhalt.appendChild(lk);
  const betrieb = karte(t('welten.profil.betrieb'));
  const schalter = el('div', 'wv-zeile-knoepfe');
  const pausiert = a.stand === 'pausiert';
  const pauseAgent = segment('pause-agent', pausiert ? `an:${a.id}` : `aus:${a.id}`, [[`aus:${a.id}`, wort('stand', 'läuft')], [`an:${a.id}`, wort('stand', 'pausiert')]]);
  pauseBeschriften(pauseAgent, w, a);
  schalter.append(el('span', undefined, t('welten.profil.schalter')), pauseAgent, ...pauseZusatz(w, a));
  betrieb.appendChild(schalter);
  if (a.stand !== 'gestoppt') betrieb.appendChild(knopf(t('welten.profil.stoppen'), 'stoppen', a.id, 'knopf-rand gefahr'));
  betrieb.appendChild(el('div', 'wv-leise', t('welten.profil.postfach', { n: a.postfach_offen, m: a.postfach_gesamt })));
  inhalt.appendChild(betrieb);
  const p = z.profil;
  if (p && p.agent === a.id) {
    const k = karte(t('welten.profil.bearbeiten'), el('label', 'wv-leise', t('welten.feld.spezialgebiet')), feld('textarea', 'profil:spezialgebiet', p.spezialgebiet),
      el('label', 'wv-leise', t('welten.feld.modell')), feld('input', 'profil:modell', p.modell, t('welten.profil.modellBeispiel')),
      el('label', 'wv-leise', t('welten.feld.denkstufe')), auswahlFeld('profil:denkstufe', p.denkstufe, DENKSTUFEN.map((x): [string, string] => [x, x])),
      el('label', 'wv-leise', t('welten.feld.fallback')), feld('input', 'profil:fallback', p.fallback, t('welten.profil.fallbackLeer')),
      el('label', 'wv-leise', t('welten.feld.maschine')), feld('input', 'profil:maschine', p.maschine),
      el('div', 'wv-leise', t('welten.profil.modellwechsel')));
    const knoepfe = el('div', 'wv-zeile-knoepfe rechts');
    knoepfe.append(knopf(t('welten.knopf.abbrechen'), 'profil-zu'), knopf(t('welten.knopf.sichern'), 'profil-sichern', '', 'knopf-voll'));
    k.appendChild(knoepfe);
    inhalt.appendChild(k);
    return;
  }
  inhalt.appendChild(karte(t('welten.blatt.profil'), knopf(t('welten.knopf.bearbeiten'), 'profil-bearbeiten', '', 'wv-verweis rechts'), wert(t('welten.feld.spezialgebiet'), a.spezialgebiet),
    wert(t('welten.feld.modell'), a.modell, true), wert(t('welten.feld.fallback'), a.fallback, true), wert(t('welten.feld.maschine'), a.maschine === 'mac' ? 'Mac' : a.maschine),
    a.kontextgrenze ? wert(t('welten.feld.kontextgrenze'), a.kontextgrenze) : null,
    wert(t('welten.detail.angelegt'), `${uhrzeit(a.angelegt)}${a.angelegt_von ? ` ${t('welten.profil.angelegtVon', { name: anzeigename(w, a.angelegt_von) })}` : ''}${a.vorlage ? `, ${t('welten.profil.vorlage', { name: a.vorlage })}` : ''}`), wert(t('welten.profil.kennung'), a.id, true)));
  inhalt.appendChild(rechteKarte(w, a));
}

/** Auftrag agentsform: was der Agent darf; aendern nur, wenn die Bibliothek `agent rechte` kennt, sonst mit Grund. */
function rechteKarte(w: Welt, a: WeltAgent): HTMLElement {
  const r = z.rechte;
  if (r && r.agent === a.id && w.rechte_aenderbar) {
    const k = karte(t('welten.rechte.bearbeiten'), ...rechteZeilen(w, { werkzeuge: r.werkzeuge, bash: r.bash, skills: r.skills, stufe: a.stufe }, 'rechte'),
      el('div', 'wv-leise', t('welten.rechte.abNaechstemZug')));
    const knoepfe = el('div', 'wv-zeile-knoepfe rechts');
    knoepfe.append(knopf(t('welten.knopf.abbrechen'), 'rechte-zu'), knopf(t('welten.knopf.sichern'), 'rechte-sichern', '', 'knopf-voll', z.laufend.has('rechte')));
    k.appendChild(knoepfe);
    k.classList.add('wv-rechtekarte');
    return k;
  }
  const fest = dienstweg(a.stufe);
  const eigene = eigeneMuster(a.bash, a.stufe);
  const web = a.werkzeuge.filter((x) => WEB.includes(x));
  const k = karte(t('welten.rechte.titel'),
    wert(t('welten.feld.werkzeuge'), a.werkzeuge.filter((x) => !WEB.includes(x)).join(', ') || t('welten.wort.keineEingetragen'), true),
    wert(t('welten.rechte.web'), web.length ? web.join(', ') : w.web_zugang ? t('welten.rechte.webAus') : t('welten.rechte.webKeinZugang')),
    wert(t('welten.feld.bash'), `${eigene.join(' · ') || t('welten.rechte.keineEigenen')}${fest.length ? ` ${t('welten.rechte.plusDienstweg', { n: a.bash.length - eigene.length })}` : ''}`, true),
    wert(t('welten.blatt.skills'), a.skills.join(', ') || t('welten.wort.keineEingetragen')));
  k.classList.add('wv-rechtekarte');
  const aendern = knopf(t('welten.rechte.aendernOffen'), 'rechte-bearbeiten', '', 'knopf-rand', !w.rechte_aenderbar);
  aendern.title = w.rechte_aenderbar ? t('welten.rechte.aendernTipp') : t('welten.rechte.nichtAusgerollt');
  k.appendChild(aendern);
  if (!w.rechte_aenderbar) k.appendChild(el('div', 'wv-leise wv-rechte-grund', t('welten.rechte.nichtAusgerollt')));
  return k;
}

/** Auftrag agentaktiv: was der Traeger ueber den Zug dieses Agenten sagt; ohne Traeger keine Karte. */
function lebenszeichenKarte(w: Welt, a: WeltAgent): HTMLElement | null {
  if (!a.leben) return null;
  const z2 = a.zug;
  const jetzt = el('div', 'wv-wert');
  jetzt.append(el('div', 'wv-wert-name', t('welten.lebenszeichen.jetzt')), uhrWort('wv-wert-text', a.id, 'leben', lebenWort(a) ?? t(a.leben.stand === 'schlaeft' ? 'welten.leben.schlaeft' : 'welten.leben.wartet')));
  const k = karte(t('welten.lebenszeichen.titel'), jetzt,
    z2?.laeuft && z2.art ? wert(t('welten.lebenszeichen.art'), wort('zugart', z2.art)) : null,
    a.leben.grund ? wert(t('welten.lebenszeichen.grund'), grundWort(a.leben.grund)) : null,
    a.leben.wecker ? wert(t('welten.lebenszeichen.wecker'), uhrzeit(a.leben.wecker)) : null,
    z2?.letzter ? wert(t('welten.lebenszeichen.letzter'), t('welten.lebenszeichen.letzterText', { zeit: uhrzeit(z2.letzter.ende), ergebnis: z2.letzter.ergebnis })) : null,
    w.traeger.zug_fehler ? el('div', 'wv-warnung', t('welten.lebenszeichen.fehler', { text: w.traeger.zug_fehler })) : null);
  k.classList.add('wv-lebenszeichen');
  return k;
}

function skillBlatt(a: WeltAgent, inhalt: HTMLElement): void {
  const s = a.skill_ansicht;
  for (const f of s.fehler) inhalt.appendChild(el('div', 'wv-warnung', f));
  const k = karte(t('welten.blatt.skills'));
  if (!s.liste.length) k.appendChild(el('div', 'wv-leise', t('welten.skills.keine')));
  for (const skill of s.liste) {
    const offen = z.skillOffen.has(skill.name);
    const zeile = el('div', 'wv-skill');
    zeile.dataset.skill = skill.name;
    const oben = el('div', 'wv-zeile-knoepfe');
    const klappe = knopf(offen ? '▾' : '▸', 'skill-zeigen', skill.name, 'wv-klappe-knopf');
    klappe.setAttribute('aria-label', t(offen ? 'welten.skills.zuklappen' : 'welten.skills.zeigen'));
    oben.append(klappe, el('span', 'wv-name wv-mono', skill.name), el('span', 'wv-stufe', wort('ebene', skill.ebene)));
    if (skill.vorgeladen) oben.appendChild(el('span', 'wv-leise', t('welten.skills.vorgeladen')));
    oben.appendChild(el('span', 'wv-leise wv-mono wv-rechtsbuendig', skill.version.slice(0, 8)));
    zeile.append(oben, el('div', 'wv-leise', skill.beschreibung));
    if (skill.verdeckt.length) zeile.appendChild(el('div', 'wv-leise', t('welten.skills.verdeckt', { liste: skill.verdeckt.map((v) => `${wort('ebene', v.ebene)}${v.gleich ? ` ${t('welten.skills.gleicherStand')}` : ''}`).join(', ') })));
    if (skill.veraltet) zeile.appendChild(el('div', 'wv-warnung', t('welten.skills.veraltet')));
    if (offen) zeile.appendChild(el('pre', 'wv-md', skill.skill_md + (skill.gekuerzt ? `\n${t('welten.skills.gekuerzt')}` : '')));
    k.appendChild(zeile);
  }
  if (s.fehlend.length) k.appendChild(el('div', 'wv-warnung', t('welten.skills.fehlt', { liste: s.fehlend.join(', ') })));
  if (s.ungueltig.length) k.appendChild(el('div', 'wv-warnung', t('welten.skills.ungueltig', { liste: s.ungueltig.map((x) => `${x.name} (${wort('ebene', x.ebene)}): ${x.text}`).join('; ') })));
  k.appendChild(el('div', 'wv-leise klein', s.quelle === 'skills.json' ? (s.stand ? t('welten.skills.quelleStand', { zeit: uhrzeit(s.stand) }) : t('welten.skills.quelle')) : t('welten.skills.quelleOrdner')));
  inhalt.appendChild(k);
  const m = karte(t('welten.skills.token'));
  if (!s.messungen.length) m.appendChild(el('div', 'wv-leise', t('welten.skills.keineMessung')));
  for (const x of s.messungen) {
    const zeile = el('div', 'wv-messung');
    zeile.dataset.art = x.art;
    zeile.append(el('div', 'wv-name', x.art), el('div', 'wv-leise wv-ziffern', messungZeile(x)));
    m.appendChild(zeile);
  }
  inhalt.appendChild(m);
  const v = karte(t('welten.skills.verlauf'));
  if (!s.verlauf.length) v.appendChild(el('div', 'wv-leise', t('welten.skills.nochNichts')));
  for (const e of [...s.verlauf].reverse()) v.appendChild(el('div', undefined, `${uhrzeit(e.zeit)} · ${wort('aktion', e.aktion)}${e.skill ? ` · ${e.skill}` : ''}${e.ziel ? ` → ${wort('ebene', e.ziel)}` : ''}${e.text ? ` – ${e.text}` : ''}`));
  inhalt.appendChild(v);
}

function anlegenZeichnen(w: Welt, a: Anlegen): HTMLElement {
  const n = nutzlast!;
  const box = el('main', 'wv-mitte wv-anlegen');
  const kopf = el('div', 'wv-mkopf');
  const kt = el('div', 'wv-mkopf-text');
  // Der Untertitel in einem span: nur so kuerzt `.wv-unter span:last-child` mit Auslassung, wenn der Umschalter Platz braucht.
  const unter = el('div', 'wv-unter');
  unter.appendChild(el('span', undefined, t('welten.anlegen.unter', { welt: w.name })));
  unter.title = t('welten.anlegen.unter', { welt: w.name });
  kt.append(el('div', 'wv-titel', t('welten.anlegen.titel')), unter);
  const umschalter = segment('anlegen-ansicht', a.ansicht, [['gespraech', t('welten.anlegen.gespraech')], ['formular', t('welten.anlegen.formular')]]);
  umschalter.title = t('welten.anlegen.ansichtTipp');
  const rechts = el('div', 'wv-mkopf-rechts');
  rechts.appendChild(umschalter);
  kopf.append(kt, rechts);
  box.appendChild(kopf);
  if (z.meldung) box.appendChild(meldungBand());
  if (a.ansicht === 'gespraech') {
    box.appendChild(gespraechZeichnen(w, a));
    box.appendChild(anlegenFuss(a));
    return box;
  }
  const form = el('div', 'wv-formular');
  const e = a.entwurf;
  const abschnitt = (titel: string, fuss: string, ...inhalt: (HTMLElement | null)[]): void => {
    const s = el('section', 'wv-abschnitt');
    s.appendChild(el('h3', undefined, titel));
    const k = el('div', 'wv-karte');
    for (const i of inhalt) if (i) k.appendChild(i);
    s.appendChild(k);
    if (fuss) s.appendChild(el('div', 'wv-leise klein', fuss));
    form.appendChild(s);
  };
  const zeile = (name: string, ...inhalt: HTMLElement[]): HTMLElement => {
    const z2 = el('label', 'wv-formzeile');
    z2.appendChild(el('span', 'wv-formname', name));
    const r = el('div', 'wv-formwert');
    r.append(...inhalt);
    z2.appendChild(r);
    return z2;
  };
  const { optionen: modelle, gesperrt } = modellOptionen(w, n.modelle, [e.modell, e.fallback]);
  const vorschlagZeile = el('div', 'wv-zeile-knoepfe');
  vorschlagZeile.append(auswahlFeld('anlegen:modell-vorschlag', a.modell, (n.entwurf_modelle.length ? n.entwurf_modelle : ['sonnet:high']).map((x): [string, string] => [x, x])),
    knopf(t(z.laufend.has('vorschlag') ? 'welten.anlegen.vorschlagLaeuft' : 'welten.anlegen.vorschlagErzeugen'), 'vorschlag', '', 'knopf-rand', z.laufend.has('vorschlag')));
  abschnitt(t('welten.anlegen.beschreibung'), a.info || t('welten.anlegen.beschreibungFuss'),
    feld('textarea', 'anlegen:beschreibung', a.beschreibung, t('welten.anlegen.beschreibungPlatzhalter')), vorschlagZeile,
    n.vorlagen.length ? zeile(t('welten.anlegen.vorlage'), auswahlFeld('anlegen:vorlage', e.vorlage, [['', t('welten.wort.keine')], ...n.vorlagen.map((v): [string, string] => [v.name, v.title])])) : null);
  const stufen: [string, string][] = [['mitglied', stufeWort('mitglied')], ['teamleiter', stufeWort('teamleiter')]];
  if (!w.hauptagent) stufen.push(['hauptagent', stufeWort('hauptagent')]);
  const teams: [string, string][] = [...(e.stufe === 'mitglied' ? [['', t('welten.anlegen.ohneTeam')] as [string, string]] : []), ...w.teams.map((x): [string, string] => [x.name, teamWort(x.name)]), ['neu', t('welten.anlegen.neuesTeamOffen')]];
  abschnitt(t('welten.anlegen.agent'), '',
    zeile(t('welten.anlegen.name'), feld('input', 'anlegen:name', e.id)), zeile(t('welten.anlegen.stufe'), auswahlFeld('anlegen:stufe', e.stufe, stufen)),
    e.stufe !== 'hauptagent' ? zeile(t('welten.anlegen.team'), auswahlFeld('anlegen:team', a.neuesTeam ? 'neu' : e.team, teams)) : null,
    e.stufe !== 'hauptagent' && a.neuesTeam ? zeile(t('welten.anlegen.neuesTeam'), feld('input', 'anlegen:neues-team', e.team, t('welten.anlegen.neuesTeamPlatzhalter'))) : null,
    zeile(t('welten.feld.spezialgebiet'), feld('textarea', 'anlegen:spezialgebiet', e.spezialgebiet, t('welten.anlegen.einSatz'))));
  // Auftrag agentsform: was der Agent darf, in einem Blick -- gleich nach Name und Stufe.
  const rechte = rechteZeilen(w, { werkzeuge: e.werkzeuge, bash: e.bash, skills: e.skills.split(',').map((x) => x.trim()).filter(Boolean), stufe: e.stufe }, 'anlegen');
  const rechteAbschnitt = (): void => {
    const sek = el('section', 'wv-abschnitt wv-rechte');
    sek.appendChild(el('h3', undefined, t('welten.rechte.titel')));
    const k = el('div', 'wv-karte');
    k.append(...rechte, zeile(t('welten.feld.kontextgrenze'), feld('textarea', 'anlegen:kontextgrenze', e.kontextgrenze, t('welten.anlegen.kontextPlatzhalter'))));
    sek.append(k, el('div', 'wv-leise klein', t('welten.anlegen.werkzeugeFuss')));
    form.appendChild(sek);
  };
  rechteAbschnitt();
  abschnitt(t('welten.anlegen.modellUndMaschine'), w.modelle ? t('welten.anlegen.modellFussWelt') : t('welten.anlegen.modellFuss'),
    ...modellZeilen(w, e, 'anlegen', modelle, gesperrt, zeile));
  abschnitt(t('welten.anlegen.figur'), '', e.stufe === 'hauptagent' ? el('div', 'wv-leise', t('welten.anlegen.hauptagentKern')) : zeile(t('welten.welt.art'), auswahlFeld('anlegen:figur', e.figurArt, FIGUR_ARTEN.map((x): [string, string] => [x, t(`welten.figur.${x}`)]))),
    e.stufe === 'hauptagent' ? null : zeile(t('welten.anlegen.farbe'), auswahlFeld('anlegen:farbe', e.figurFarbe, FIGUR_FARBEN.map((x): [string, string] => [x, t(`welten.farbe.${x}`)]))));
  abschnitt(t('welten.anlegen.anweisungen'), t('welten.anlegen.anweisungenFuss'),
    feld('textarea', 'anlegen:anweisungen', e.anweisungen), knopf(t('welten.anlegen.hausvorlage'), 'pruefen', 'hausvorlage', 'wv-verweis'));
  box.appendChild(form);
  box.appendChild(anlegenFuss(a));
  return box;
}

/** Modell, Denkstufe, Fallback, Fallback-Denkstufe und Maschine: im Formular und im Gespraech dieselben Felder. */
function modellZeilen(w: Welt, e: Entwurf, bereich: string, modelle: [string, string][], gesperrt: Set<string>,
  zeile: (name: string, ...inhalt: HTMLElement[]) => HTMLElement): (HTMLElement | null)[] {
  const n = nutzlast;
  const maschinen = [...new Set([e.maschine, agentMaschine(w), ...(n?.maschinen ?? []).map((m) => m.name)].filter(Boolean))];
  const stufen = DENKSTUFEN.map((x): [string, string] => [x, x]);
  return [
    zeile(t('welten.feld.modell'), auswahlFeld(`${bereich}:modell`, e.modell, modelle, gesperrt)), zeile(t('welten.feld.denkstufe'), auswahlFeld(`${bereich}:denkstufe`, e.denkstufe, stufen)),
    zeile(t('welten.feld.fallback'), auswahlFeld(`${bereich}:fallback`, e.fallback, [['', t('welten.wort.keiner')], ...modelle], gesperrt)),
    e.fallback ? zeile(t('welten.feld.fallbackDenkstufe'), auswahlFeld(`${bereich}:fallback-denkstufe`, e.fallbackDenkstufe, stufen)) : null,
    zeile(t('welten.feld.maschine'), auswahlFeld(`${bereich}:maschine`, e.maschine, maschinen.map((m): [string, string] => [m, m === agentMaschine(w) ? t(w.traeger.eingerichtet ? 'welten.rechte.maschineTraeger' : 'welten.rechte.maschineVorgabe', { maschine: maschineWort(m) }) : maschineWort(m)]))),
  ];
}

/** Die Fusszeile des Anlege-Menues, in beiden Ansichten dieselbe. */
function anlegenFuss(a: Anlegen): HTMLElement {
  const e = a.entwurf;
  const fuss = el('div', 'wv-fuss');
  if (a.pruefung) fuss.appendChild(el('span', 'wv-warnung', a.pruefung));
  fuss.append(el('span', 'wv-luecke'), knopf(t('welten.knopf.abbrechen'), 'anlegen-zu'), knopf(t('welten.knopf.pruefen'), 'pruefen'),
    knopf(t('welten.knopf.anlegen'), 'anlegen-sichern', '', 'knopf-voll', z.laufend.has('anlegen') || !e.id.trim() || !e.spezialgebiet.trim()));
  return fuss;
}

/** Das Gespraech: Verlauf (Mensch rechts, Modell links), Hinweis auf gesetzte Felder, Modellwahl und Eingabe mit ⌘↩. */
function gespraechZeichnen(w: Welt, a: Anlegen): HTMLElement {
  const box = el('div', 'wv-chat');
  const verlauf = el('div', 'wv-verlauf wv-gespraech');
  if (!a.verlauf.length) {
    const karte = el('div', 'wv-karte wv-gespraech-einladung');
    karte.append(el('div', 'wv-karte-titel', t('welten.anlegen.gespraechTitel')),
      el('div', undefined, t(w.hauptagent ? 'welten.anlegen.gespraechEinladung' : 'welten.anlegen.gespraechEinladungHaupt', { welt: w.name })),
      el('div', 'wv-leise', t('welten.anlegen.gespraechErklaerung')));
    verlauf.appendChild(karte);
  }
  a.verlauf.forEach((zug, i) => {
    const mensch = zug.rolle === 'mensch';
    const blase = el('div', `wv-nachricht${mensch ? ' vom-menschen' : ''}`);
    blase.dataset.zug = String(i);
    blase.dataset.rolle = zug.rolle;
    blase.setAttribute('aria-label', `${t(mensch ? 'welten.anlegen.du' : 'welten.anlegen.modell')}: ${zug.text}`);
    blase.appendChild(el('div', 'wv-ntext', zug.text));
    if (!mensch && zug.felder.length) blase.appendChild(el('div', 'wv-leise', t('welten.anlegen.gesetzt', { felder: feldWorte(zug.felder) })));
    verlauf.appendChild(blase);
  });
  if (z.laufend.has('gespraech')) {
    const laeuft = el('div', 'wv-leise wv-gespraech-laeuft', t('welten.anlegen.gespraechLaeuft', { modell: a.modell }));
    laeuft.setAttribute('role', 'status');
    verlauf.appendChild(laeuft);
  }
  box.appendChild(verlauf);
  // Auftrag agentsform: auch im Gespraech steht, was der Agent darf; aufgeklappt laesst es sich dort setzen.
  const e = a.entwurf;
  const skills = e.skills.split(',').map((x) => x.trim()).filter(Boolean);
  const rechte = el('div', `wv-gespraech-rechte${z.gRechteOffen ? ' offen' : ''}`);
  const kopf = el('div', 'wv-zeile-knoepfe');
  kopf.append(el('span', 'wv-karte-titel', t('welten.rechte.titel')),
    el('span', 'wv-leise wv-rechte-kurz', `${rechteKurz({ werkzeuge: e.werkzeuge, bash: e.bash.split('\n').filter((x) => x.trim()), skills }, dienstweg(e.stufe).length)} · ${modellText(e.modell, e.denkstufe, e.modellGenau) || '–'}${e.fallback ? ` / ${modellText(e.fallback, e.fallbackDenkstufe, e.modellGenau)}` : ''} · ${maschineWort(e.maschine)}`),
    knopf(t(z.gRechteOffen ? 'welten.rechte.zuklappen' : 'welten.rechte.aendern'), 'gespraech-rechte', '', 'wv-verweis'));
  rechte.appendChild(kopf);
  if (z.gRechteOffen) {
    const zeile = (name: string, ...inhalt: HTMLElement[]): HTMLElement => {
      const z2 = el('div', 'wv-formzeile');
      z2.appendChild(el('span', 'wv-formname', name));
      const r = el('div', 'wv-formwert');
      r.append(...inhalt);
      z2.appendChild(r);
      return z2;
    };
    const { optionen, gesperrt } = modellOptionen(w, nutzlast?.modelle ?? [], [e.modell, e.fallback]);
    const karte = el('div', 'wv-karte');
    karte.append(...rechteZeilen(w, { werkzeuge: e.werkzeuge, bash: e.bash, skills, stufe: e.stufe }, 'anlegen'));
    for (const x of modellZeilen(w, e, 'anlegen', optionen, gesperrt, zeile)) if (x) karte.appendChild(x);
    rechte.appendChild(karte);
  }
  box.appendChild(rechte);
  if (a.gFertig || a.gFelder.length || a.gInfo) {
    const hinweis = el('div', 'wv-gespraech-hinweis');
    hinweis.style.padding = '6px 14px 0';
    if (a.gFertig) hinweis.appendChild(el('div', 'wv-leise', t('welten.anlegen.gespraechFertig')));
    if (a.gFelder.length) {
      const zeile = el('div', 'wv-zeile-knoepfe');
      zeile.append(el('span', 'wv-leise', t('welten.anlegen.zuletztGesetzt', { felder: feldWorte(a.gFelder) })), knopf(t('welten.anlegen.imFormular'), 'anlegen-ansicht', 'formular', 'wv-verweis'));
      hinweis.appendChild(zeile);
    }
    if (a.gInfo) hinweis.appendChild(el('div', 'wv-leise klein', a.gInfo));
    box.appendChild(hinweis);
  }
  const eing = el('div', 'wv-eingabe');
  const modelle = (nutzlast?.entwurf_modelle.length ? nutzlast.entwurf_modelle : ['sonnet:high']).map((x): [string, string] => [x, x]);
  const wahl = auswahlFeld('anlegen:modell-vorschlag', a.modell, modelle);
  wahl.setAttribute('aria-label', t('welten.anlegen.gespraechModell'));
  const f = feld('textarea', 'anlegen:gespraech-eingabe', a.eingabe, t(a.verlauf.length ? 'welten.anlegen.gespraechAntwortPlatzhalter' : 'welten.anlegen.gespraechPlatzhalter'));
  (f as HTMLTextAreaElement).rows = 2;
  const senden = knopf(t('welten.chat.senden'), 'gespraech-senden', '', 'knopf-voll', z.laufend.has('gespraech'));
  senden.title = t('welten.anlegen.sendenTipp');
  eing.append(wahl, f, senden);
  box.appendChild(eing);
  return box;
}

function anlegenVorschau(a: Anlegen): HTMLElement {
  const box = el('div', 'wv-vorschau');
  box.appendChild(el('div', 'wv-ikopf', t('welten.vorschau.titel')));
  const inhalt = el('div', 'wv-iinhalt');
  const e = a.entwurf;
  const kopf = el('div', 'wv-profilkopf');
  const vt = el('div');
  vt.append(el('div', 'wv-titel', e.id || t('welten.vorschau.ohneNamen')), el('div', 'wv-leise', `${stufeWort(e.stufe)}${e.team && e.stufe !== 'hauptagent' ? ` · ${teamText(e.team)}` : ''}`), el('div', 'wv-mono wv-leise', modellText(e.modell, e.denkstufe, e.modellGenau)));
  kopf.append(entwurfFigur(e, 96), vt);
  const eigene = e.bash.split('\n').map((x) => x.trim()).filter(Boolean);
  const skills = e.skills.split(',').map((x) => x.trim()).filter(Boolean);
  const darf = karte(t('welten.rechte.titel'), wert(t('welten.feld.werkzeuge'), ['Bash', ...e.werkzeuge.filter((x) => x !== 'Bash')].join(', '), true),
    wert(t('welten.feld.bash'), `${eigene.join(' · ') || t('welten.rechte.keineEigenen')} ${t('welten.rechte.plusDienstweg', { n: dienstweg(e.stufe).length })}`, true),
    wert(t('welten.blatt.skills'), skills.join(', ') || '–'),
    wert(t('welten.feld.modell'), `${modellText(e.modell, e.denkstufe, e.modellGenau) || '–'}${e.modellGenau ? ` · ${e.denkstufe}` : ''}${e.fallback ? ` · ${t('welten.feld.fallback')} ${modellText(e.fallback, e.fallbackDenkstufe, e.modellGenau)}` : ''}`, true),
    wert(t('welten.feld.maschine'), maschineWort(e.maschine)));
  darf.classList.add('wv-vorschau-darf');
  inhalt.append(kopf, wert(t('welten.feld.spezialgebiet'), e.spezialgebiet), darf, ...(e.kontextgrenze ? [wert(t('welten.feld.kontextgrenze'), e.kontextgrenze)] : []),
    el('div', 'wv-karte-titel', t('welten.vorschau.anweisungen')), el('pre', 'wv-md', e.anweisungen || t('welten.vorschau.ausHausvorlage')));
  box.appendChild(inhalt);
  return box;
}

function vorschauZeichnen(): void {
  const w = welt();
  const alt = blatt?.querySelector('.wv-inspektor');
  if (!w || !alt || !z.anlegen) return;
  const neu = inspektorZeichnen(w);
  alt.replaceWith(neu);
  figurenAufraeumen();
}

/**
 * Auftrag pausetext (10.10.2026): Die Pause friert einen laufenden Zug nicht ein (shell/agents_claude_lauf.py,
 * `ClaudeZugLauncher`); er arbeitet zu Ende, danach startet keiner mehr, sofort haelt nur „Stoppen". Wer laut
 * `status --nur-zug` gerade einen Zug hat -- fuer die Welt jeder Agent, fuer einen Agenten nur er.
 */
function laufendeZuege(w: Welt, a: WeltAgent | null): number {
  return (a ? [a] : w.agenten).filter((x) => x.zug?.laeuft === true).length;
}
/** Der Hinweis am Schalter; mit laufendem Zug auch, dass er noch zu Ende arbeitet. */
function pauseBeschriften(s: HTMLElement, w: Welt, a: WeltAgent | null): void {
  const basis = a ? t('welten.pause.tippAgent', { a: a.name }) : t('welten.pause.tipp');
  s.title = laufendeZuege(w, a) ? `${basis} ${t('welten.pause.tippZug')}` : basis;
}
/** Hinter „pausiert", solange ein Zug noch laeuft: „laufender Zug endet noch"; sonst nichts. */
function pauseZusatz(w: Welt, a: WeltAgent | null): HTMLElement[] {
  const n = laufendeZuege(w, a);
  if ((a ? a.stand : w.stand) !== 'pausiert' || !n) return [];
  const x = el('span', 'wv-leise wv-pause-zusatz', n === 1 ? t('welten.pause.zugEndet') : t('welten.pause.zuegeEnden', { n }));
  x.title = t('welten.pause.tippZug');
  return [x];
}

function kopfZeichnen(w: Welt): HTMLElement {
  const kopf = el('header', 'wv-kopfleiste');
  const kt = el('div', 'wv-kopf-titel');
  const herkunft = [w.art === 'global' ? t('welten.kopf.globaleWelt') : kurzerPfad(w.projekt ?? ''), maschineWort(w.maschine ?? '')].filter(Boolean).join(' · ');
  kt.append(el('span', 'wv-titel', w.name), el('span', 'wv-leise wv-herkunft', herkunft));
  const rechts = el('div', 'wv-kopf-rechts');
  const zaehler = el('span', 'wv-zaehler', zaehlerText(w));
  zaehler.dataset.zaehler = '1';
  const pause = segment('pause', w.stand === 'pausiert' ? 'an' : 'aus', [['aus', wort('stand', 'läuft')], ['an', wort('stand', 'pausiert')]]);
  pause.classList.add('wv-pause');
  if (w.stand === 'gestoppt') pause.classList.add('aus');
  pauseBeschriften(pause, w, null);
  const insp = knopf(t('welten.kopf.inspektor'), 'inspektor', '', 'knopf-schlicht', z.figuren);
  insp.setAttribute('aria-pressed', String(z.inspektor));
  const fig = knopf(t(z.figuren ? 'agents.figuren.zurueck' : 'agents.figuren'), 'figuren', '', 'knopf-schlicht wv-figuren-knopf');
  fig.title = t('agents.figuren.tipp');
  fig.setAttribute('aria-pressed', String(z.figuren));
  rechts.append(zaehler, pause, ...pauseZusatz(w, null), fig, insp);
  kopf.append(kt, rechts);
  return kopf;
}

function dialogZeichnen(): HTMLElement | null {
  const rf = z.rueckfrage;
  if (!rf) return null;
  const schicht = el('div', 'wv-dialog-schicht');
  const d = el('div', 'wv-dialog');
  d.setAttribute('role', 'alertdialog');
  d.appendChild(el('div', 'wv-titel', rf.text));
  d.appendChild(el('div', 'wv-leise', rf.warnungen.length ? rf.warnungen.join('\n') : t('welten.dialog.hinweis')));
  const k = el('div', 'wv-zeile-knoepfe rechts');
  k.append(knopf(t('welten.knopf.abbrechen'), 'abbrechen'), knopf(t(rf.handlung === 'stoppen' ? 'welten.dialog.stoppen' : rf.handlung === 'umziehen' ? 'welten.dialog.umziehen' : rf.handlung === 'vergessen' ? 'welten.dialog.entfernen' : 'welten.dialog.zuruecknehmen'), 'bestaetigen', '', rf.handlung === 'umziehen' || rf.handlung === 'vergessen' ? 'knopf-voll' : 'knopf-voll gefahr'));
  d.appendChild(k);
  schicht.appendChild(d);
  return schicht;
}

function zeichnen(): void {
  if (!blatt || !sichtbarAn) return;
  const aktiv = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const fokus = aktiv && blatt.contains(aktiv) ? { feld: aktiv.dataset.feld ?? '', start: aktiv.selectionStart ?? null, ende: aktiv.selectionEnd ?? null } : null;
  const scrolls = [...blatt.querySelectorAll<HTMLElement>('[data-scroll]')].map((x) => [x.dataset.scroll ?? '', x.scrollTop] as const);
  blatt.replaceChildren();
  const n = nutzlast;
  const w = welt();
  if (!n || !n.geladen) {
    blatt.appendChild(leer(t('welten.leer.laden'), t('welten.leer.ladenText')));
  } else if (!w) {
    blatt.appendChild(einladungZeichnen(n));
  } else if (z.figuren && figurenEl) {
    if (z.weltPfad !== w.pfad) z.weltPfad = w.pfad;
    blatt.appendChild(kopfZeichnen(w));
    blatt.appendChild(figurenEl);
    figurenblattZeichnen();
  } else {
    if (z.weltPfad !== w.pfad) z.weltPfad = w.pfad;
    blatt.appendChild(kopfZeichnen(w));
    const band = maschinenBand(w, n);
    if (band) blatt.appendChild(band);
    // Eine Fernwelt, die hier steht, liest der Kern oefter (Auftrag fernwelten).
    if (w.fern && gemeldetGewaehlt !== w.pfad && bruecke) {
      gemeldetGewaehlt = w.pfad;
      void bruecke.handlung(`welt:gewaehlt ${JSON.stringify({ welt: w.pfad })}`, { echt: false, bestaetigt: false }).catch(() => undefined);
    }
    const raster = el('div', `wv-raster${z.inspektor ? '' : ' ohne-inspektor'}`);
    const leiste = leisteZeichnen(w, n);
    const mitte = mitteZeichnen(w);
    raster.append(leiste, mitte);
    if (z.inspektor) raster.appendChild(inspektorZeichnen(w));
    blatt.appendChild(raster);
    leiste.querySelector<HTMLElement>('.wv-zeilen')!.dataset.scroll = 'leiste';
    const v = mitte.querySelector<HTMLElement>('.wv-verlauf, .wv-tickets, .wv-formular');
    if (v) v.dataset.scroll = `mitte:${gespraechSchluessel()}:${z.reiter}:${z.anlegen ? 'anlegen' : ''}`;
    const i = raster.querySelector<HTMLElement>('.wv-iinhalt');
    if (i) i.dataset.scroll = `inspektor:${z.blatt}`;
    const d = dialogZeichnen();
    if (d) blatt.appendChild(d);
  }
  blatt.appendChild(fussZeichnen());
  blatt.classList.toggle('ruhig', figurenStand().reduziert === true);
  for (const [schluessel, top] of scrolls) {
    const x = blatt.querySelector<HTMLElement>(`[data-scroll="${CSS.escape(schluessel)}"]`);
    if (x) x.scrollTop = top;
  }
  if (fokus?.feld) {
    const f = blatt.querySelector<HTMLInputElement>(`[data-feld="${CSS.escape(fokus.feld)}"]`);
    if (f) {
      f.focus();
      if (fokus.start !== null && 'setSelectionRange' in f) { try { f.setSelectionRange(fokus.start, fokus.ende ?? fokus.start); } catch { /* select */ } }
    }
  }
  // Auftrag ticketboard: erst das gezeichnete Board kennt seine Breite. Ist sie eine andere
  // als die, mit der es gezeichnet wurde, zeichnet es ein zweites Mal -- die Breite haengt
  // nicht am Modus (das Board fuellt seine Spalte in beiden), also endet das nach einem Zug.
  const brett = blatt.querySelector<HTMLElement>('.wv-board');
  if (brett && !z.boardTestbreite) {
    const gemessen = Math.round(brett.clientWidth);
    if (gemessen > 0 && gemessen !== z.boardBreite) { z.boardBreite = gemessen; zeichnen(); return; }
  }
  figurenAufraeumen();
}

/**
 * DIE FUSSZEILE WIE IM AUFGABEN-BLATT (bis 14.09.2026 agents-view.ts): Traeger mit
 * seinen Aufgaben, Kern sauber, Lebenszeichen, Agent-Verkehr, Tageslimit, Maschinen.
 */
function fussZeichnen(): HTMLElement {
  const fuss = el('div', 'wv-traegerfuss');
  const st = fussStand;
  if (!st) {
    fuss.textContent = t('agents.fuss.keinStand');
    return fuss;
  }
  const tr = st.traeger;
  const teile: { teil: string; text: string; warnung?: boolean }[] = [];
  teile.push({ teil: 'traeger', text: tr.laeuft ? t('agents.fuss.traegerSeit', { zeit: uhrzeit(tr.seit) }) : t('agents.fuss.traegerAus'), warnung: !tr.laeuft });
  teile.push({ teil: 'aufgaben', text: t('agents.fuss.aufgaben', { n: typeof tr.aufgaben === 'number' ? tr.aufgaben : 0 }) });
  const sauber = st.kern_sauber;
  teile.push({
    teil: 'kern',
    text: sauber === true ? t('agents.fuss.kernSauber') : sauber === false ? t('agents.fuss.kernUnsauber') : t('agents.fuss.kernUnbekannt'),
    warnung: sauber === false,
  });
  const lz = tr.lebenszeichen;
  teile.push({
    teil: 'lebenszeichen',
    text: !lz?.zeit ? t('agents.fuss.lebenszeichenNie')
      : lz.ok === false ? t('agents.fuss.lebenszeichenFehler', { zeit: uhrzeit(lz.zeit), grund: lz.grund ?? '' })
        : t('agents.fuss.lebenszeichenOk', { zeit: uhrzeit(lz.zeit) }),
    warnung: lz?.ok === false,
  });
  teile.push({ teil: 'verkehr', text: tr.agent_verkehr === 'pausiert' ? t('agents.fuss.verkehrPausiert') : t('agents.fuss.verkehrOffen') });
  const tl = tr.tageslimit;
  if (tl && typeof tl.verbraucht === 'number' && typeof tl.erlaubt === 'number') {
    // `wb-budget` liefert Prozentpunkte mit Nachkommastelle (47,2 von 57,1).
    const punkte = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', sprache() === 'de' ? ',' : '.'));
    teile.push({ teil: 'tageslimit', text: t('agents.fuss.tageslimit', { verbraucht: punkte(tl.verbraucht), erlaubt: punkte(tl.erlaubt) }), warnung: tl.erlaubt > 0 && tl.verbraucht >= tl.erlaubt });
  }
  teile.push({ teil: 'maschinen', text: (tr.maschinen ?? []).map((m) => (m === 'mac' ? 'Mac' : m)).join(', ') });
  // Auftrag fernwelten: dahinter jede Agent-Maschine, die der Kern schon gefragt hat.
  for (const m of nutzlast?.maschinen ?? []) {
    if (m.eigene || m.erreichbar === null) continue;
    teile.push(m.erreichbar
      ? { teil: `maschine:${m.name}`, text: t('welten.maschine.fussErreichbar', { maschine: m.name, n: m.traeger_eingerichtet }) }
      : { teil: `maschine:${m.name}`, text: t('welten.maschine.fussWeg', { maschine: m.name, zeit: uhrzeit(m.seit) }), warnung: true });
  }
  teile.forEach((x, i) => {
    if (i) fuss.append(el('span', 'wv-traegerfuss-fuge', i === 1 ? ', ' : ' · '));
    const sp = el('span', `wv-traegerfuss-teil${x.warnung ? ' warnung' : ''}`, x.text);
    sp.dataset.teil = x.teil;
    fuss.append(sp);
  });
  fuss.title = fuss.textContent ?? '';
  return fuss;
}

function leer(titel: string, text: string): HTMLElement {
  const d = el('div', 'wv-leer wv-ganz');
  d.append(el('div', 'wv-leer-titel', titel), el('div', 'wv-leise', text));
  return d;
}

// --- Oeffentliche Wege ---------------------------------------------------------------------

/** Die ganze Nutzlast von `awb:aufgaben`; gebraucht wird nur das Feld `welten`. */
export function weltenAufgaben(p: unknown): void {
  const ganz = (p && typeof p === 'object' ? p : {}) as Partial<AufgabenNutzlast>;
  // Die Art je Team aus den Einstellungen gilt fuer die Figurenvorschau (die Figuren der Welt tragen ihre eigene).
  if (ganz.figuren?.arten) {
    const vorher = JSON.stringify(ganz.figuren.arten);
    if (vorher !== letzteArten) {
      letzteArten = vorher;
      figurenArtenSetzen(ganz.figuren.arten);
      if (z.figuren && sichtbarAn) figurenblattZeichnen(true);
    }
  }
  if (ganz.traeger && typeof ganz.traeger === 'object') {
    const fuss = { traeger: ganz.traeger, kern_sauber: ganz.kern_sauber ?? null };
    const fussText = JSON.stringify(fuss);
    if (fussText !== letzterFuss) {
      letzterFuss = fussText;
      fussStand = fuss;
      const alt = blatt?.querySelector('.wv-traegerfuss');
      if (alt) alt.replaceWith(fussZeichnen());
    }
  }
  const roh = ganz.welten as WeltenNutzlast | null | undefined;
  if (!roh || typeof roh !== 'object' || !Array.isArray(roh.welten)) return;
  const text = JSON.stringify(roh);
  if (text === letzterRoh) return;
  letzterRoh = text;
  nutzlast = {
    ...roh, vorlagen: roh.vorlagen ?? [], modelle: roh.modelle ?? [], entwurf_modelle: roh.entwurf_modelle ?? [], global_pfad: roh.global_pfad ?? '',
    gemerkte_projekte: roh.gemerkte_projekte ?? [], bash_vorgabe: roh.bash_vorgabe ?? {},
    // Ein Kern ohne die Felder von agentsform: die Welten tragen sie dann leer.
    welten: roh.welten.map((x) => ({ ...x, modelle: x.modelle ?? null, maschine_vorgabe: x.maschine_vorgabe ?? '', skill_katalog: x.skill_katalog ?? { welt: [], bibliothek: [] },
      web_zugang: x.web_zugang ?? false, rechte_aenderbar: x.rechte_aenderbar ?? false,
      // Vertrag rantrag: ein Kern ohne Rechteantraege zeigt keine Karte und nichts zum Entscheiden.
      rechteantraege: x.rechteantraege ?? [], rechteantrag_entscheidbar: x.rechteantrag_entscheidbar ?? false })),
  };
  zeichnen();
  const w = welt();
  if (w) gesehen(w, true);
}

export function weltenSichtbar(): boolean { return sichtbarAn; }

export function weltenAnzeigen(an: boolean): void {
  if (!blatt) return;
  sichtbarAn = an;
  blatt.classList.toggle('an', an);
  if (an) { lageSetzen(); zeichnen(); const w = welt(); if (w) gesehen(w, true); }
  if (an && !uhr) uhr = setInterval(uhrenStellen, 1000);
  if (!an && uhr) { clearInterval(uhr); uhr = null; }
  sichtbarkeitMelden();
}

/** Dem Kern nur melden, was sich aendert: Modus sichtbar UND Fenster sichtbar. */
function sichtbarkeitMelden(): void {
  const an = sichtbarAn && document.visibilityState === 'visible';
  if (an === gemeldetSichtbar) return;
  gemeldetSichtbar = an;
  bruecke?.sichtbar?.(an);
}

/** Nach dem Setzen der Sprache (renderer.ts): alles in der neuen Sprache neu zeichnen. */
export function weltenSpracheGesetzt(): void { zeichnen(); }

function lageSetzen(): void {
  const app = document.getElementById('app');
  if (!blatt || !app) return;
  const r = app.getBoundingClientRect();
  blatt.style.top = `${Math.round(r.top)}px`;
}

/** Was `awb-ctl ui` unter `welten` liest und die Suite prueft. */
export function weltenUiState(): Record<string, unknown> {
  const w = welt();
  const a = w ? agentVon(w, agentId()) : undefined;
  const text = (sel: string): string => (blatt?.querySelector(sel)?.textContent ?? '').trim();
  return {
    sichtbar: sichtbarAn, geladen: !!nutzlast?.geladen, welten: nutzlast?.welten.map((x) => x.name) ?? [],
    welt: w ? { name: w.name, pfad: w.pfad, stand: w.stand, zaehler: zaehlerText(w), maschine: w.maschine, fern: w.fern } : null,
    weltOptionen: [...(blatt?.querySelectorAll<HTMLOptionElement>('select[data-feld="welt"] option') ?? [])].map((o) => o.textContent ?? ''),
    herkunft: text('.wv-herkunft'),
    maschinenBand: text('.wv-maschinenband .wv-meldung-text'),
    maschinenKarte: text('.wv-maschinenkarte'),
    neuMaschine: { wahl: neuMaschine(nutzlast), text: text('.wv-weltneu-maschine'), wege: neuWege(nutzlast).map((m) => m.name) },
    darstellung: z.darstellung, reiter: z.reiter, blatt: z.blatt, auswahl: z.auswahl, gespraech: z.gespraech, inspektor: z.inspektor,
    zeilen: [...(blatt?.querySelectorAll<HTMLElement>('.wv-zeilen [data-id]') ?? [])].map((x) => ({
      id: x.dataset.id ?? '', text: (x.querySelector('.wv-name')?.textContent ?? x.textContent ?? '').trim(),
      ungelesen: Number(x.querySelector('.wv-zahl')?.textContent ?? 0), figur: x.querySelector<HTMLCanvasElement>('canvas.agentenfigur')?.dataset.gestalt ?? '',
      leben: (x.querySelector('.wv-leben')?.textContent ?? '').trim(), lebenTitel: x.querySelector('.wv-leben')?.getAttribute('title') ?? null, ring: x.querySelector<HTMLElement>('.wv-figur')?.dataset.ring ?? '',
      figurZustand: x.querySelector<HTMLCanvasElement>('canvas.agentenfigur')?.dataset.zustand ?? '',
    })),
    kopfLeben: { text: text('.wv-mkopf .wv-unter'), ring: blatt?.querySelector<HTMLElement>('.wv-mkopf .wv-figur')?.dataset.ring ?? '' },
    antwortStand: (() => {
      const x = blatt?.querySelector<HTMLElement>('.wv-antwortstand');
      return x ? { text: (x.textContent ?? '').trim(), art: x.dataset.art ?? '', nach: x.previousElementSibling instanceof HTMLElement ? x.previousElementSibling.dataset.id ?? '' : '' } : null;
    })(),
    lebenszeichen: text('.wv-lebenszeichen'),
    inspektorRing: blatt?.querySelector<HTMLElement>('.wv-profilkopf .wv-figur')?.dataset.ring ?? '',
    ruhig: !!blatt?.classList.contains('ruhig'),
    kopf: text('.wv-mkopf .wv-titel'), zaehler: text('[data-zaehler]'), pause: text('.wv-pause .gewaehlt'), pauseZusatz: text('.wv-kopf-rechts .wv-pause-zusatz'),
    pauseTipp: blatt?.querySelector<HTMLElement>('.wv-pause')?.title ?? '', agentPauseZusatz: text('.wv-zeile-knoepfe .wv-pause-zusatz'),
    chat: [...(blatt?.querySelectorAll<HTMLElement>('.wv-verlauf > [data-id]') ?? [])].map((x) => ({
      id: x.dataset.id ?? '', art: x.classList.contains('wv-frage') ? 'frage' : 'nachricht', text: (x.querySelector('.wv-ntext')?.textContent ?? '').trim(),
      marke: (x.querySelector('.wv-marke')?.textContent ?? '').trim(), quittieren: !!x.querySelector('[data-w="quittieren"]'),
    })),
    meldung: z.meldung ?? {}, rueckfrage: z.rueckfrage ? { handlung: z.rueckfrage.handlung, text: z.rueckfrage.text, warnungen: z.rueckfrage.warnungen } : {},
    tickets: [...(blatt?.querySelectorAll<HTMLElement>('.wv-ticket') ?? [])].map((x) => x.dataset.id ?? ''),
    ticketDetail: blatt?.querySelector<HTMLElement>('.wv-detail')?.dataset.ticket ?? '',
    // tickets4: Karte, Board, Detailhandlungen, Formular und die Regeln der Welt.
    ticketAnsicht: z.ticketAnsicht,
    ticketKarten: [...(blatt?.querySelectorAll<HTMLElement>('.wv-ticket') ?? [])].map((x) => ({
      id: x.dataset.id ?? '',
      abzeichen: [...x.querySelectorAll('.wv-abzeichen')].map((y) => (y.textContent ?? '').trim()),
      ampel: x.querySelector<HTMLElement>('.wv-ampel')?.className.replace('wv-ampel ', '') ?? '',
      zeile: (x.querySelector('.wv-ticket-zeile')?.textContent ?? '').trim(),
      standzeile: (x.querySelector('.wv-ticket-standzeile')?.textContent ?? '').trim(),
      ordnen: !!x.dataset.ordnen,
    })),
    board: {
      // Auftrag ticketboard: `modus` sagt, ob Spalten oder Reiter stehen, `schmal` die
      // zusammengeklappten Spalten, `gewaehlt` den Stand der gestapelten Ansicht.
      modus: (blatt?.querySelector<HTMLElement>('.wv-board')?.dataset.modus) ?? '',
      schmal: [...(blatt?.querySelectorAll<HTMLElement>('.wv-board-spaltenkopf.schmal') ?? [])].map((x) => x.dataset.spalte ?? ''),
      gewaehlt: (blatt?.querySelector<HTMLElement>('.wv-board-spaltenkopf.gewaehlt')?.dataset.spalte) ?? '',
      spalten: [...(blatt?.querySelectorAll<HTMLElement>('.wv-board-spaltenkopf') ?? [])].map((x) => x.dataset.spalte ?? ''),
      spaltenZahl: Object.fromEntries([...(blatt?.querySelectorAll<HTMLElement>('.wv-board-spaltenkopf') ?? [])].map((x) => [x.dataset.spalte ?? '', Number(x.dataset.anzahl ?? '0')])),
      wip: text('.wv-board-wip'),
      wipRot: !!blatt?.querySelector('.wv-board-wip.rot'),
      spuren: [...(blatt?.querySelectorAll<HTMLElement>('.wv-board-spur') ?? [])].map((x) => ({
        id: x.dataset.spur ?? '',
        titel: (x.querySelector('.wv-board-spurname')?.textContent ?? '').trim(),
        spalten: [...x.querySelectorAll<HTMLElement>('.wv-board-spalte')].map((c) => ({
          name: c.dataset.spalte ?? '', tickets: [...c.querySelectorAll<HTMLElement>('.wv-board-kachel')].map((k) => k.dataset.id ?? ''),
        })),
      })),
    },
    ticketHandlung: z.ticketHandlung ? {
      ticket: z.ticketHandlung.ticket, handlung: z.ticketHandlung.handlung, grund: z.ticketHandlung.grund,
      bemerkung: z.ticketHandlung.bemerkung, duplikat: z.ticketHandlung.duplikat, an: z.ticketHandlung.an,
      pruefer: z.ticketHandlung.pruefer, art: z.ticketHandlung.kind, prioritaet: z.ticketHandlung.prioritaet,
      punkte: z.ticketHandlung.punkte, frist: z.ticketHandlung.frist, runden: z.ticketHandlung.runden,
      dodGeprueft: z.ticketHandlung.dodGeprueft,
      fehlt: w && z.ticketHandlung.handlung === 'abnehmen' ? abnahmeFehlt(z.ticketHandlung, w.dod) : null,
    } : null,
    handlungen: [...(blatt?.querySelectorAll<HTMLButtonElement>('[data-w="handlung"]') ?? [])].map((b) => (b.dataset.arg ?? '').split('|')[0] ?? ''),
    ticketFormular: z.neuesTicket ? { ...z.neuesTicket, bereitschaft: text('.wv-dor'), bereit: blatt?.querySelector<HTMLElement>('.wv-dor')?.dataset.bereit ?? '' } : null,
    weltRegeln: z.weltRegeln,
    zyklus: { an: w?.zyklus.an ?? false, jetzt: w?.zyklus.jetzt?.id ?? '', ziel: w?.zyklus.jetzt?.ziel ?? '', historie: [...(blatt?.querySelectorAll<HTMLElement>('.wv-zyklus-historie') ?? [])].map((x) => x.dataset.zyklus ?? '') },
    dod: w?.dod ?? [],
    wip: { text: text('.wv-wip'), rot: !!blatt?.querySelector('.wv-wip.rot') },
    uebersicht: {
      brauchtDich: [...(blatt?.querySelectorAll<HTMLElement>('[data-braucht-dich]') ?? [])].map((x) => x.dataset.brauchtDich ?? ''),
      triage: [...(blatt?.querySelectorAll<HTMLElement>('[data-triage]') ?? [])].map((x) => x.dataset.triage ?? ''),
      vorhaben: [...(blatt?.querySelectorAll<HTMLElement>('[data-vorhaben]') ?? [])].map((x) => ({ id: x.dataset.vorhaben ?? '', text: (x.textContent ?? '').trim() })),
    },
    diffZeilen: blatt?.querySelectorAll('.wv-diff span').length ?? 0,
    skillKnoepfe: [...(blatt?.querySelectorAll<HTMLButtonElement>('.wv-detail [data-w^="skill-"]') ?? [])].map((b) => b.dataset.w ?? ''),
    inspektorKopf: text('.wv-ikopf'),
    skills: [...(blatt?.querySelectorAll<HTMLElement>('.wv-skill') ?? [])].map((x) => ({ name: x.dataset.skill ?? '', md: !!x.querySelector('.wv-md') })),
    messungen: [...(blatt?.querySelectorAll<HTMLElement>('.wv-messung') ?? [])].map((x) => ({ art: x.dataset.art ?? '', zeile: (x.querySelector('.wv-ziffern')?.textContent ?? '').trim() })),
    agent: a ? { id: a.id, skills: a.skill_ansicht.liste.map((s) => s.name) } : null,
    fuss: {
      text: (blatt?.querySelector('.wv-traegerfuss')?.textContent ?? '').trim(),
      teile: Object.fromEntries([...(blatt?.querySelectorAll<HTMLElement>('.wv-traegerfuss-teil') ?? [])].map((x) => [x.dataset.teil ?? '', (x.textContent ?? '').trim()])),
    },
    figurenAn: z.figuren,
    figurenStand: figurenStand(),
    figurenblatt: z.figuren && blatt?.contains(figurenEl) ? figurenblattZustand() : null,
    anlegen: z.anlegen ? {
      entwurf: entwurfJson(z.anlegen.entwurf), beschreibung: z.anlegen.beschreibung, modell: z.anlegen.modell, pruefung: z.anlegen.pruefung, info: z.anlegen.info, gesetzt: [...z.anlegen.gesetzt].sort(), vorgaben: vorgaben(z.anlegen),
      ansicht: z.anlegen.ansicht,
      gespraech: {
        verlauf: z.anlegen.verlauf.map((x) => ({ rolle: x.rolle, text: x.text, felder: x.felder })), eingabe: z.anlegen.eingabe, felder: z.anlegen.gFelder,
        fragen: z.anlegen.gFragen, fertig: z.anlegen.gFertig, info: z.anlegen.gInfo, laeuft: z.laufend.has('gespraech'),
        blasen: [...(blatt?.querySelectorAll<HTMLElement>('.wv-gespraech [data-zug]') ?? [])].map((x) => ({ rolle: x.dataset.rolle ?? '', rechts: x.classList.contains('vom-menschen') })),
        hinweis: text('.wv-gespraech-hinweis .wv-zeile-knoepfe .wv-leise'),
      },
    } : {},
    vorschau: text('.wv-vorschau .wv-titel'),
    leer: text('.wv-leer-titel'),
    einladung: !!blatt?.querySelector('.wv-einladung'),
    hauptagentEinladung: !!blatt?.querySelector('.wv-einladung-band'),
    weltNeu: { offen: z.weltNeuOffen, ordner: z.weltNeuOrdner, global: !!blatt?.querySelector('[data-w="welt-neu"][data-arg="global"]') },
    anlegenKnopf: w ? { text: text('.wv-anlegen'), aus: !!blatt?.querySelector<HTMLButtonElement>('.wv-anlegen')?.disabled, grund: text('.wv-anlegen-grund') } : null,
    vorlagen: nutzlast?.vorlagen.map((v) => v.name) ?? [],
    // Auftrag agentsform: Rechte, Modelle, gemerkte Ordner und die Frage im Band.
    rechte: (() => {
      const box = blatt?.querySelector<HTMLElement>('.wv-rechte, .wv-gespraech-rechte.offen, .wv-rechtekarte');
      if (!box) return null;
      const knoepfe = [...box.querySelectorAll<HTMLButtonElement>('.wv-wahl')];
      return {
        werkzeuge: knoepfe.filter((b) => b.dataset.w?.endsWith('-werkzeug')).map((b) => ({ name: b.dataset.arg ?? '', an: b.classList.contains('an'), aus: b.disabled })),
        skills: knoepfe.filter((b) => b.dataset.w?.endsWith('-skill')).map((b) => ({ name: b.dataset.arg ?? '', an: b.classList.contains('an') })),
        webSatz: (box.querySelector('.wv-rechte-web')?.textContent ?? '').trim(),
        dienstweg: [...box.querySelectorAll('.wv-rechte-festzeile')].map((x) => x.textContent ?? ''),
      };
    })(),
    gespraechRechte: { offen: z.gRechteOffen, kurz: text('.wv-gespraech-rechte .wv-rechte-kurz') },
    modellOptionen: [...(blatt?.querySelectorAll<HTMLOptionElement>('select[data-feld="anlegen:modell"] option') ?? [])].map((o) => ({ wert: o.value, text: o.textContent ?? '', aus: o.disabled })),
    maschineWahl: (blatt?.querySelector<HTMLSelectElement>('select[data-feld="anlegen:maschine"]')?.value) ?? '',
    profilRechte: (() => {
      const k = blatt?.querySelector<HTMLElement>('.wv-rechtekarte');
      if (!k) return null;
      const b = k.querySelector<HTMLButtonElement>('[data-w="rechte-bearbeiten"]');
      return { text: (k.textContent ?? '').trim(), aendernAus: b ? b.disabled : null, grund: (k.querySelector('.wv-rechte-grund')?.textContent ?? '').trim(), bearbeiten: !!z.rechte };
    })(),
    gemerkt: [...(blatt?.querySelectorAll<HTMLElement>('.wv-gemerkt') ?? [])].map((x) => x.dataset.ordner ?? ''),
    frageband: (() => {
      const b = blatt?.querySelector<HTMLElement>('.wv-frageband');
      return b ? { frage: b.dataset.frage ?? '', optionen: [...(blatt?.querySelectorAll<HTMLButtonElement>('.wv-frageband-antwort [data-w="antworten"]') ?? [])].map((x) => x.dataset.arg ?? '') } : null;
    })(),
    antraege: w?.antraege.map((x) => x.id) ?? [],
    // Vertrag rantrag: die gezeichnete Karte je Antrag und der Hinweis am Agenten.
    rechteantraege: [...(blatt?.querySelectorAll<HTMLElement>('.wv-rantragkarte .wv-rantrag') ?? [])].map((x) => ({
      id: x.dataset.id ?? '', offen: x.classList.contains('offen'), abgelaufen: x.classList.contains('abgelaufen'), text: (x.textContent ?? '').trim(),
      knoepfe: [...x.querySelectorAll<HTMLButtonElement>('[data-w]')].map((b) => `${b.dataset.w}:${b.dataset.arg ?? ''}${b.disabled ? ':aus' : ''}`),
      nurLesen: !!x.querySelector('.wv-rantrag-nurlesen'),
    })),
    rechteantragHinweis: text('.wv-rantrag-hinweis'),
    fragenIds: w?.fragen.map((f) => f.id) ?? [],
    inspektorText: text('.wv-iinhalt'),
    rechteantraegeDaten: w?.rechteantraege.map((x) => ({ id: x.id, stand: x.stand, abgelaufen: x.abgelaufen, an: x.an })) ?? [],
    knoepfe: [...(blatt?.querySelectorAll<HTMLButtonElement>('[data-w]') ?? [])].slice(0, 400).map((b) => `${b.dataset.w}:${b.dataset.arg ?? ''}${b.disabled ? ':aus' : ''}`),
  };
}

export function initWeltenView(b: WeltenBruecke): void {
  bruecke = b;
  const rahmen = document.getElementById('rahmen') ?? document.body;
  const d = document.createElement('div');
  d.id = 'weltenblatt';
  rahmen.appendChild(d);
  // Auftrag agentaktiv: Ring und Stand unter der Nachricht; die Regeln stehen hier, weil sie nur diese Ansicht betreffen.
  const stil = document.createElement('style');
  stil.id = 'wv-zug-stil';
  stil.textContent = ZUG_STIL;
  document.head.appendChild(stil);
  blatt = d;
  figurenEl = document.createElement('div');
  figurenEl.className = 'wv-figuren';
  initFigurenblatt(figurenEl);
  d.addEventListener('click', (ev) => {
    const ziel = (ev.target as HTMLElement).closest<HTMLElement>('[data-w]');
    if (!ziel || !d.contains(ziel) || (ziel as HTMLButtonElement).disabled) return;
    ev.preventDefault();
    void handeln(ziel.dataset.w ?? '', ziel.dataset.arg ?? '', ev.isTrusted);
  });
  const eingabeBehandler = (ev: Event): void => {
    const f = ev.target as HTMLInputElement;
    if (!f.dataset?.feld) return;
    if (ev.type === 'input' && f.tagName === 'SELECT') return;
    if (ev.type === 'change' && f.tagName !== 'SELECT') return;
    eingabe(f.dataset.feld, f.value);
  };
  d.addEventListener('input', eingabeBehandler);
  d.addEventListener('change', eingabeBehandler);
  d.addEventListener('keydown', (ev) => {
    const f = ev.target as HTMLElement;
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && f.dataset?.feld === 'entwurf:') { ev.preventDefault(); void handeln('senden', '', ev.isTrusted); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && f.dataset?.feld === 'anlegen:gespraech-eingabe' && !z.laufend.has('gespraech')) {
      ev.preventDefault();
      void handeln('gespraech-senden', '', ev.isTrusted);
    }
  });
  window.addEventListener('resize', () => {
    if (!sichtbarAn) return;
    lageSetzen();
    // Auftrag ticketboard: ein schmaleres Fenster kann das Board auf Reiter umstellen.
    if (z.reiter === 'tickets' && z.ticketAnsicht === 'board') zeichnen();
  });
  document.addEventListener('visibilitychange', sichtbarkeitMelden);
  b.daten?.().then((p) => { if (p) weltenAufgaben(p); }).catch(() => undefined);

  // NUR FUER TESTS, dieselbe Bauart wie `__awbAgents`: der Steuerkanal ruft einen Haken
  // (awb-ctl welten <was> [wert]). Er drueckt das gezeichnete Bedienelement mit `data-w`,
  // also laeuft die Handlung durch denselben Behandler wie die Maus; der Klick ist
  // synthetisch (`echt: false`, Absender cli-operator). Eingaben setzen das Feld wie
  // getippt. Warten auf den Kern: `warten` loest auf, wenn keine Handlung mehr laeuft.
  const druecke = (w: string, arg = ''): Record<string, unknown> => {
    const k = [...d.querySelectorAll<HTMLElement>('[data-w]')].find((x) => x.dataset.w === w && (x.dataset.arg ?? '') === arg);
    if (!k) throw new Error(`kein Bedienelement ${w}${arg ? ` (${arg})` : ''}`);
    if ((k as HTMLButtonElement).disabled) throw new Error(`${w}${arg ? ` (${arg})` : ''} ist gesperrt`);
    k.click();
    return weltenUiState();
  };
  const tippe = (schluessel: string, wert: string): Record<string, unknown> => {
    const f = d.querySelector<HTMLInputElement>(`[data-feld="${CSS.escape(schluessel)}"]`);
    if (!f) throw new Error(`kein Feld ${schluessel}`);
    f.value = wert;
    f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return weltenUiState();
  };
  const geteilt = (spec: string): [string, string] => { const i = spec.indexOf('|'); return i < 0 ? [spec, ''] : [spec.slice(0, i), spec.slice(i + 1)]; };
  const haken: Record<string, (wert: string) => unknown> = {
    zustand: () => weltenUiState(),
    /** `<data-w>|<data-arg>` -- ein Bedienelement druecken. */
    druecke: (spec) => { const [w, arg] = geteilt(spec); return druecke(w, arg); },
    /** `<data-feld>|<wert>` -- ein Feld setzen, wie getippt oder gewaehlt. */
    tippe: (spec) => { const [f, wert] = geteilt(spec); return tippe(f, wert); },
    welt: (name) => {
      const x = nutzlast?.welten.find((y) => y.name === name || y.pfad === name);
      if (!x) throw new Error(`keine Welt ${name}`);
      return tippe('welt', x.pfad);
    },
    laufend: () => ({ laufend: [...z.laufend] }),
    /** NUR FUER TESTS (Vertrag rantrag): ein gezeichnetes Element in den sichtbaren Bereich rollen, fuer Belegbilder. */
    zeige: (selektor) => {
      const x = d.querySelector<HTMLElement>(selektor);
      if (!x) throw new Error(`kein Element ${selektor}`);
      x.scrollIntoView({ block: 'start' });
      return weltenUiState();
    },
    /** `an|aus` -- die Vorschau der Agentenfiguren ueber den Knopf im Kopf. */
    figuren: (wert) => ((wert !== 'aus') !== z.figuren ? druecke('figuren') : weltenUiState()),
    /** `reduziert`, `normal` oder `system` -- „Bewegung reduzieren" ohne Systemeinstellung. */
    bewegung: (wert) => {
      figurenBewegungErzwingen(wert === 'reduziert' ? true : wert === 'normal' ? false : null);
      if (z.figuren) figurenblattZeichnen(true);
      zeichnen();
      return weltenUiState();
    },
    /** Auftrag agentaktiv: die Uhr einmal stellen, als waere eine Sekunde vergangen (Suiten warten sonst 30 s). */
    uhr: () => { uhrenStellen(); return weltenUiState(); },
    /** NUR FUER TESTS (Auftrag ticketboard): die Breite, die das Board fuer sich hat; `0` misst wieder. */
    breite: (wert) => {
      z.boardTestbreite = Math.max(0, Math.round(Number(wert) || 0));
      zeichnen();
      return weltenUiState();
    },
    /** `hidden|visible` -- das Fenster verbirgt sich oder erscheint wieder, wie beim Wechsel des Space. */
    fenster: (wert) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (wert === 'hidden' ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
      return { gemeldet: gemeldetSichtbar };
    },
  };
  (window as unknown as { __awbWelten: unknown }).__awbWelten = haken;
}
