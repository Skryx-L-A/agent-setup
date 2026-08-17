// Die Oberflaeche des Einstellungsfensters: links die Seitenliste, rechts der
// Stapel.
//
// NEU GESCHNITTEN NACH SPEC-V4 ABSCHNITT 3 (11.08.). Vorgabe des Nutzers im
// Wortlaut: "Die Einstellungen sollen viel weniger und uebersichtlicher werden
// mit mehr fokus darauf was der User wirklich braucht." Drei Dinge geben dieser
// Datei ihre Form:
//
// 1  SIEBEN SEITEN, jede kuerzer als die sechs davor. Sie folgen nicht mehr dem
//    Lebenslauf einer Sitzung, sondern der Frage, die ein Mensch stellt:
//    Sitzung, Erlaubnisse, Programme und Modelle, Maschinen, Aufsicht und
//    Meldungen, Aussehen, Programm. Die Worker-Seite ist ersatzlos weg -- seine
//    Worte: "er muss aber nur orchestrator einstellen, die worker nicht, die
//    macht ja der orchestrator fuer ihn".
//
// 2  JEDE EINSTELLUNG TRAEGT DREI EBENEN (seine Worte: "Namen, die dem Nutzer
//    erklaeren, worum es sich handelt, kurze, klare Namen und dann vielleicht
//    noch eine Beschreibung oder ein Infozeichen ... Fuer jeden."):
//      der kurze Name    -- was es IST, nicht wie der Schluessel heisst
//      die Wirkungszeile -- was passiert, wenn ich es umlege
//      das Infozeichen   -- der Grund, die Messung, die Nebenwirkung
//
// 3  KEIN TEXT STEHT MEHR IN DIESER DATEI. Jede Beschriftung, jede
//    Wirkungszeile und jede Hover-Erklaerung kommt aus `texte.ts` und wird
//    ueber `t()` abgefragt. Das ist die Vorbereitung der Sprachschicht, die
//    NACH diesem Umbau kommt: sie legt eine zweite Tabelle an, nicht einen
//    Sweep durch zweitausend Zeilen.
//
// DREI KLASSEN, ohne Lesen zu unterscheiden:
//   sofort        kein Etikett-Vorbehalt, der Betrieb liest den neuen Wert
//   spaeter       ein ruhiges Etikett nennt, worauf gewartet wird
//   mit Nachfrage was ein Sicherungsnetz wegnimmt, sitzt im Vorsicht-Block und
//                 braucht eine Bestaetigung, die die Folge in Klartext nennt
// Es gibt bewusst KEINE vierte Klasse "braucht einen Neustart des Programms".
//
// ZWEI SCHREIBWEGE, und beide sind die vorhandenen:
//   * `wb-state settings set` fuer alles aus ~/.claude/workbench/settings.json
//     -- ueber den Hauptprozess, weil nur dieser Weg die Sperre nimmt, die sich
//     Shell und Node teilen, und jede Aenderung mit Urheber protokolliert.
//   * die Bedienung 'ui-*' fuer showStopped und sort -- die liegen in ui.json
//     und gehoeren dem Programm selbst (uistate.ts).
// Kein OK-Knopf: wer umlegt, hat entschieden. Die Datei ist geteilter Zustand,
// den auch Worker beschreiben; ein Menue, das einen halbstuendigen Entwurf
// haelt und dann alles auf einmal schreibt, ueberschreibt fremde Aenderungen.
import { setzeSprache, sprache, spracheHatTabelle, t, tOpt } from './texte';

interface HarnessSicht {
  id: string;
  label: string;
  modelle: number;
  binaer: boolean;
}

interface ModellSicht {
  id: string;
  label: string;
  harness: string;
  harnessLabel: string;
  rollen: string[];
  efforts: string[];
  effortFaehig: boolean;
  kontext: number;
  startbar: boolean;
  deckelRegistry: string;
}

interface WacheRolle {
  an: boolean;
  mahnenAb: number;
  eingreifen: boolean;
  notbremseAb?: number;
  grund?: string;
}

interface GuardZeile {
  id: string;
  an: boolean;
  rolle: string;
  seit: string;
  grund: string;
}

interface DeckelSicht {
  model: string;
  cap: string;
  quelle: string;
  grund: string;
  registry: string;
  efforts: string[];
}

interface UiSicht {
  showStopped: boolean;
  sort: 'recent' | 'folder' | 'name';
}

interface AskMuster {
  befehl: string;
  unterbefehl?: string;
  muster?: string;
  grund: string;
  aus?: boolean;
}

/** Ob ein Programm angemeldet ist -- gemessen am Beleg, nie geraten. */
interface AnmeldeSicht {
  stand: 'ja' | 'nein' | 'unbekannt';
  grund: string;
}

/** Ein Anbieter mit der Frage, ob sein Zugang vorliegt. NIE mit dem Zugang selbst. */
interface AnbieterSicht {
  id: string;
  label: string;
  art: 'schluessel' | 'abo' | 'lokal';
  stand: 'ja' | 'nein' | 'unbekannt';
}

/** Der `session`-Block eines Harness aus der Registry (SPEC-V4 6.3). */
interface ChatQuelle {
  via: string;
  grund: string;
  live: boolean;
  zeigtNicht: string[];
  probe: string;
}

/**
 * Was gemeldet wird und wie. Die FORM ist vorgegeben und wird von zwei Seiten
 * gelesen: von dieser Oberflaeche und vom Sendeweg. E-Mail ist ausdruecklich
 * kein Weg und taucht deshalb gar nicht erst auf.
 */
interface MeldeSicht {
  an: boolean;
  ereignisse: string[];
  wege: string[];
  handyUrl: string;
  tonDatei: string;
  limitSchwelle: number;
}

/** Die Antwort des Testknopfs 'Test senden' -- je gewaehltem Weg, ob es klappte, sonst der Grund. */
interface MeldeWegErgebnis {
  ok: boolean;
  grund?: string;
  status?: number;
}
interface MeldeTestErgebnis {
  an: boolean;
  ergebnisse: Partial<Record<string, MeldeWegErgebnis>>;
}

interface Daten {
  settings: Record<string, unknown>;
  vorgaben: Record<string, unknown>;
  ui: UiSicht;
  machine: string;
  harnesses: HarnessSicht[];
  orchestratorModelle: ModellSicht[];
  workerModelle: ModellSicht[];
  maschinen: string[];
  askMuster: AskMuster[];
  guards: GuardZeile[];
  wache: Record<string, WacheRolle>;
  deckel: Record<string, DeckelSicht>;
  harnessStufen: Record<string, string[]>;
  effortCaps: Record<string, { cap: string; grund: string; gesetzt: string }>;
  ausschluss: { ordner: string[]; muster: string[] };
  protokolle: { label: string; path: string }[];
  pfade: { label: string; wert: string }[];
  anmeldung: Record<string, AnmeldeSicht>;
  anbieter: AnbieterSicht[];
  chatQuellen: Record<string, ChatQuelle>;
  chatAnsicht: Record<string, boolean>;
  /** Die Vorgabe je Rolle (12.08.): Orchestrator und Worker getrennt. */
  chatAnsichtVorgabe: { orchestrator: boolean; worker: boolean };
  meldungen: MeldeSicht;
  meldeEreignisse: string[];
  meldeWege: string[];
  ollamaEndpunkt: string;
  sprache: string;
  thema: string;
  zustandsfarben: Record<string, string>;
  hooks: { name: string; ereignis: string; lehntAb: boolean }[];
}

declare global {
  interface Window {
    awbEinstellungen: {
      daten(): Promise<Daten>;
      setzen(key: string, value: unknown): Promise<{ ok: boolean; ausgabe: string; aufruf: string }>;
      werkzeug(nachricht: Record<string, unknown>, echt: boolean): Promise<{ ok: boolean; ausgabe: string; aufruf: string }>;
      ui(key: string, value: unknown): Promise<{ ok: boolean }>;
      maschinePruefen(name: string): Promise<{ ok: boolean; ausgabe: string }>;
      onDaten(fn: (d: Daten) => void): void;
      bereit(): void;
      /** Je Anbieter-ID: liegt ein Schluessel im Schluesselbund vor? Nie der Wert. */
      schluesselStatus(): Promise<Record<string, boolean>>;
      /** Einen Wert fuer EINEN Anbieter ablegen. Geht nur hin, kommt nie zurueck. */
      schluesselSetzen(providerId: string, wert: string): Promise<{ ok: boolean }>;
      /** ECHTER Versand -- eine Probe ueber die gewaehlten Wege, Rueckmeldung je Weg. */
      meldungTesten(): Promise<MeldeTestErgebnis>;
      /** Denselben Weg wie das Zahnrad im Hauptfenster: isTrusted entscheidet. */
      erststartZeigen(echt: boolean): void;
    };
    /** Testhaken: was steht gerade da, und was ist gewaehlt. Nur Lesen und Klicken. */
    __awbEin: {
      seiten(): string[];
      offen(): string;
      zeige(name: string): boolean;
      text(): string;
      status(): string;
      klick(auswahl: string): boolean;
      /** Ein Bedienelement LESEN, ohne es anzufassen. */
      zustand(auswahl: string): { da: boolean; gehakt: boolean; wert: string; text: string };
      modelle(): { id: string; text: string; gewaehlt: boolean }[];
      /** Was das Infozeichen gerade zeigt -- und ob es wirklich zu sehen ist. */
      info(): { feld: string; text: string; sichtbar: boolean; hoehe: number };
      /** Jedes Feld mit seinen drei Ebenen -- fuer die Zusage "bei moeglichst vielen. Fuer jeden." */
      felder(): { id: string; name: string; wirkung: string; info: string }[];
    };
  }
}

let daten: Daten | null = null;
let aktuelleSeite = 'sitzung';
/** Je Modellwahl der zuletzt gewaehlte Harness-Filter -- sonst springt die Liste. */
const filterStand = new Map<string, string>();
const suchStand = new Map<string, string>();
/** Welches Infozeichen gerade offen ist (leer = keins). */
let offenesInfo = '';
/** Der Text im Sicherungsfeld der Programm-Seite -- er ueberlebt das Neuzeichnen. */
let sicherungsText = '';
/**
 * Je Anbieter-ID: liegt im Schluesselbund ein Eintrag vor? Eigenstaendig von
 * `daten.anbieter[].stand` (das prueft nur eine Umgebungsvariable, siehe
 * `einstellungsfenster.ts`) -- ein Wert, der GERADE erst abgelegt wurde, soll
 * sofort als vorhanden gelten, ohne auf die naechste `daten()`-Antwort zu
 * warten. Geladen bei jedem Start und nach jedem Speichern (`speicherKnopf`
 * unten); NIE aus `zeichne()` selbst angestossen, sonst zeichnete jeder Aufruf
 * dieser Funktion sich selbst neu.
 */
let schluesselStand: Record<string, boolean> = {};

async function schluesselStatusLaden(): Promise<void> {
  try {
    schluesselStand = await window.awbEinstellungen.schluesselStatus();
  } catch {
    schluesselStand = {};
  }
  zeichne();
}

const seitenlisteEl = document.getElementById('seitenliste') as HTMLElement;
const stapelEl = document.getElementById('stapel') as HTMLElement;
const statusEl = document.getElementById('statuszeile') as HTMLElement;
const infotextEl = document.getElementById('infotext') as HTMLElement;
const rueckfrageEl = document.getElementById('rueckfrage') as HTMLElement;
const rueckfrageTextEl = document.getElementById('rueckfrageText') as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  klasse?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

function melde(text: string, art: 'gut' | 'fehler' | '' = ''): void {
  statusEl.textContent = text;
  statusEl.className = art;
}

// --- Das Infozeichen --------------------------------------------------------
//
// Der Text liegt in einer eigenen, fest positionierten Lage ueber der Seite. Er
// nimmt im Fluss KEINEN Platz ein: nichts verschiebt sich, wenn er erscheint,
// und kein Element weicht ihm aus. Das ist die stehende Regel dieses Hauses und
// zugleich der Grund, warum es kein aufklappender Kasten unter der Zeile ist.

function infoZu(): void {
  offenesInfo = '';
  infotextEl.classList.remove('offen');
  for (const b of document.querySelectorAll('.infozeichen.offen')) b.classList.remove('offen');
}

function infoAuf(knopf: HTMLElement, kennung: string, text: string): void {
  infoZu();
  offenesInfo = kennung;
  infotextEl.textContent = text;
  infotextEl.classList.add('offen');
  knopf.classList.add('offen');
  // Erst zeigen, dann messen, dann setzen -- die Breite haengt am Text.
  infotextEl.style.left = '0px';
  infotextEl.style.top = '0px';
  const zeichen = knopf.getBoundingClientRect();
  const kasten = infotextEl.getBoundingClientRect();
  const links = Math.max(8, Math.min(zeichen.left, window.innerWidth - kasten.width - 10));
  let oben = zeichen.bottom + 6;
  if (oben + kasten.height > window.innerHeight - 8) oben = zeichen.top - kasten.height - 6;
  // Zuletzt in das Fenster zwingen. Ohne diese Zeile stand der Kasten halb
  // unter dem unteren Rand, wenn sein Zeichen selbst schon ausserhalb des
  // sichtbaren Bereichs lag -- am Bild gesehen, 06.08.
  oben = Math.max(8, Math.min(oben, window.innerHeight - kasten.height - 8));
  infotextEl.style.left = `${Math.round(links)}px`;
  infotextEl.style.top = `${Math.round(oben)}px`;
}

/**
 * DIE INFO-MARKE. Ein typografisches Zeichen, kein Emoji -- die stehende Regel
 * dieses Hauses. Sie oeffnet beim Ueberfahren, beim Fokus und beim Klick; der
 * Klick haelt sie offen, damit man den Text lesen kann, ohne die Maus
 * stillzuhalten.
 */
function infozeichen(kennung: string, text: string): HTMLButtonElement {
  const b = el('button', 'infozeichen') as HTMLButtonElement;
  b.type = 'button';
  b.textContent = 'i';
  b.dataset.info = kennung;
  // Titel zusaetzlich, damit der Text auch dann erreichbar ist, wenn jemand
  // das Fenster mit der Tastatur bedient und nie klickt.
  b.title = text;
  b.setAttribute('aria-label', t('satz.infoTitel', { feld: kennung }));
  b.addEventListener('mouseenter', () => infoAuf(b, kennung, text));
  b.addEventListener('focus', () => infoAuf(b, kennung, text));
  b.addEventListener('mouseleave', () => {
    if (b.dataset.gehalten !== '1') infoZu();
  });
  b.addEventListener('blur', () => {
    if (b.dataset.gehalten !== '1') infoZu();
  });
  b.addEventListener('click', () => {
    const zu = offenesInfo === kennung && b.dataset.gehalten === '1';
    if (zu) {
      b.dataset.gehalten = '0';
      infoZu();
    } else {
      b.dataset.gehalten = '1';
      infoAuf(b, kennung, text);
    }
  });
  return b;
}

// --- Ein Feld mit seinen drei Ebenen ---------------------------------------

interface FeldOpt {
  /** Ebene 1: der kurze, klare Name. Ohne Vorwissen verstaendlich. */
  name: string;
  /** Ebene 2: was passiert, wenn ich es umlege. Eine Zeile, gedaempft. */
  wirkung: string;
  /** Ebene 3: der genaue Text hinter dem Infozeichen -- Grund, Messung, Nebenwirkung. */
  info: string;
  steuer: HTMLElement;
  /** Wann die Aenderung greift. Steht immer da, nicht erst nach dem Umlegen. */
  etikett?: string;
  /** Etikett gelb: es greift erst spaeter. */
  wartet?: boolean;
  /** Schluessel in settings.json -- traegt das Rueckstell-Zeichen. */
  schluessel?: string;
  /** Schluessel im Oberflaechen-Zustand (ui.json). */
  uiSchluessel?: string;
  breit?: boolean;
}

/**
 * Ein Feld aus seinem SCHLUESSEL bauen: Name, Wirkung, Info und Etikett kommen
 * aus der Texttabelle unter `feld.<kennung>.*`. Das ist der Normalfall; nur wo
 * ein Text einen Platzhalter fuellen muss, wird er einzeln uebergeben.
 */
function texte(kennung: string, werte?: Record<string, string | number>): {
  name: string; wirkung: string; info: string; etikett: string;
} {
  return {
    name: t(`feld.${kennung}.name`, werte),
    wirkung: t(`feld.${kennung}.wirkung`, werte),
    info: t(`feld.${kennung}.info`, werte),
    // Optional -- nicht jedes Feld hat eine Zeitfrage. tOpt() statt t(): ein
    // fehlender Schluessel darf hier nicht als sichtbarer Fehlertext erscheinen
    // (Befund 11.08.: 'anbieter', 'harnessTabelle', 'pfade', 'werkzeuge' zeigten
    // '[fehlender Text: feld.X.etikett]').
    etikett: tOpt(`feld.${kennung}.etikett`, werte),
  };
}

/** Alle gezeichneten Felder dieses Durchgangs -- fuer den Testhaken `felder()`. */
let gezeichneteFelder: { id: string; name: string; wirkung: string; info: string }[] = [];

function gleichwie(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function gruppe(seite: HTMLElement, titel: string, klasse = 'gruppe'): HTMLElement {
  const g = el('div', klasse);
  g.appendChild(el('h2', undefined, titel));
  seite.appendChild(g);
  return g;
}

/** Ein Satz im Klartext, wo kein Schalter steht. Nie ein graues Feld. */
function klartext(g: HTMLElement, text: string): HTMLElement {
  const p = el('div', 'klartext', text);
  g.appendChild(p);
  return p;
}

function feld(g: HTMLElement, o: FeldOpt): HTMLElement {
  const kennung = o.schluessel ?? o.uiSchluessel ?? o.name;
  const f = el('div', o.breit ? 'feld breit' : 'feld');
  f.dataset.feld = kennung;

  const kopf = el('div', 'kopf');
  kopf.appendChild(el('span', 'name', o.name));
  kopf.appendChild(infozeichen(kennung, o.info));

  // Das Rueckstell-Zeichen steht IMMER da und ist stumpf, solange der Wert auf
  // der Vorgabe steht. Es taucht nicht auf und verschwindet nicht -- sonst
  // ruckte die Zeile bei jeder Aenderung.
  if (o.schluessel && daten) {
    const vorgabe = daten.vorgaben[o.schluessel];
    const jetzt = daten.settings[o.schluessel];
    const steht = jetzt === undefined || gleichwie(jetzt, vorgabe);
    const z = el('button', 'zurueck') as HTMLButtonElement;
    z.type = 'button';
    z.textContent = '↺';
    z.dataset.zurueck = o.schluessel;
    z.disabled = steht || vorgabe === undefined;
    z.title = steht ? t('satz.stehtAufVorgabe') : t('satz.zurueckAufVorgabe', { wert: kurzWert(vorgabe) });
    if (!z.disabled) z.addEventListener('click', () => void setze(o.schluessel as string, vorgabe));
    kopf.appendChild(z);
  }
  // Bei einem breiten Feld steht das Etikett OBEN neben dem Namen: unter einer
  // Liste mit Eingabezeile stuende es zehn Zeilen von dem entfernt, worauf es
  // sich bezieht.
  const etikett = o.etikett
    ? el('span', o.wartet ? 'etikett wartet' : 'etikett', o.etikett)
    : null;
  if (etikett && o.breit) kopf.appendChild(etikett);
  f.appendChild(kopf);

  const steuer = el('div', 'steuer');
  steuer.appendChild(o.steuer);
  if (etikett && !o.breit) steuer.appendChild(etikett);
  f.appendChild(steuer);
  f.appendChild(el('div', 'desc', o.wirkung));
  g.appendChild(f);
  gezeichneteFelder.push({ id: kennung, name: o.name, wirkung: o.wirkung, info: o.info });
  return f;
}

function kurzWert(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return t('wort.leereListe');
    return v.length === 1 ? t('wort.einEintrag') : t('wort.mehrereEintraege', { anzahl: v.length });
  }
  if (typeof v === 'boolean') return v ? t('wort.an') : t('wort.aus');
  // Die drei Namensraeume der Werkzeuge sind Objekte. `String()` machte daraus
  // ein "[object Object]" -- eine Zeile, die nichts sagt, ist in dieser Liste
  // schlimmer als keine. Genannt werden die Schluessel, denn genau die sind
  // die Antwort auf "was steht da".
  if (v && typeof v === 'object') {
    const eintraege = Object.entries(v as Record<string, unknown>);
    if (eintraege.length === 0) return t('wort.nichtsGesetzt');
    // Nur die Namen zu nennen reicht hier nicht: bei der Kontextwache stuenden
    // links und rechts dieselben zwei Rollen, und die Zeile saehe gleich aus,
    // obwohl sie eine Abweichung meldet (am Bild gesehen, 06.08.). Also steht
    // dabei, WAS an der Rolle gesetzt ist -- ohne den Grund, der ein ganzer
    // Satz sein kann und die Spalte sprengt.
    const stueck = eintraege.slice(0, 3).map(([k, w]) => {
      if (!w || typeof w !== 'object') return `${k}=${String(w)}`;
      const inner = Object.entries(w as Record<string, unknown>)
        .filter(([ik]) => ik !== 'grund' && ik !== 'seit' && ik !== 'gesetzt')
        // Drei, weil die Vorgabe einer Wach-Rolle genau drei Felder hat -- bei
        // zwei fehlte rechts die Zahl, gegen die links verglichen wird.
        .slice(0, 3)
        .map(([ik, iw]) => `${ik}=${String(iw)}`);
      return inner.length ? `${k} (${inner.join(', ')})` : k;
    });
    return eintraege.length > 3 ? `${stueck.join(' · ')} … (${eintraege.length})` : stueck.join(' · ');
  }
  return String(v);
}

// --- Bedienelemente ---------------------------------------------------------

/**
 * DIE ECHTHEIT DES KLICKS, durch alle Bedienelemente durchgereicht.
 *
 * Jedes Ereignis traegt `isTrusted`: true nur, wenn ein Zeigegeraet oder eine
 * Tastatur es erzeugt hat. Ein `el.click()` aus dem Steuerkanal -- der Weg
 * jedes Tests und jedes Agenten -- traegt false, und der Browser laesst das
 * nicht faelschen. Dieselbe Grundlage, auf der das Fenster ueberhaupt nur nach
 * einem echten Klick SICHTBAR wird (siehe main/einstellungsfenster.ts).
 *
 * Gebraucht wird es fuer drei Wege, und nur fuer die: Guard, Wache, Deckel.
 * Was dort geschieht, lockert eine Sicherung, und `wb-state` verlangt dafuer
 * einen Menschen. Nur ein echter Klick reicht das Merkmal weiter; alles andere
 * laeuft ohne, und das Werkzeug weist es ab.
 */
function haken(id: string, wert: boolean, auf: (an: boolean, echt: boolean) => void): HTMLInputElement {
  const c = el('input') as HTMLInputElement;
  c.type = 'checkbox';
  c.id = id;
  c.checked = wert;
  c.addEventListener('change', (e) => auf(c.checked, e.isTrusted));
  return c;
}

function zahl(
  id: string,
  wert: number,
  min: number,
  max: number | undefined,
  einheit: string,
  auf: (n: number, echt: boolean) => void,
): HTMLElement {
  const box = el('span', 'steuerpaar');
  const i = el('input') as HTMLInputElement;
  i.type = 'number';
  i.id = id;
  i.min = String(min);
  if (max !== undefined) i.max = String(max);
  i.step = '1';
  i.value = String(wert);
  i.addEventListener('change', (e) => auf(Number(i.value), e.isTrusted));
  box.appendChild(i);
  if (einheit) {
    box.appendChild(document.createTextNode(' '));
    box.appendChild(el('span', 'einheit', einheit));
  }
  return box;
}

/**
 * Eine Zeile Text. Geschrieben wird beim VERLASSEN des Feldes, nicht bei jedem
 * Tastendruck -- sonst stuende nach "~/A" schon ein halber Pfad in der
 * geteilten Datei, und jeder Zwischenstand landete im Aenderungsprotokoll.
 */
function textzeile(
  id: string,
  wert: string,
  platzhalter: string,
  auf: (s: string, echt: boolean) => void,
): HTMLElement {
  const i = el('input', 'textzeile') as HTMLInputElement;
  i.type = 'text';
  i.id = id;
  i.value = wert;
  i.placeholder = platzhalter;
  i.spellcheck = false;
  i.addEventListener('change', (e) => auf(i.value.trim(), e.isTrusted));
  return i;
}

interface Segment {
  wert: string;
  label: string;
  gesperrt?: boolean;
  titel?: string;
  /** Zusatzklasse, z. B. `ueberDeckel` -- markiert, nicht gesperrt. */
  klasse?: string;
}

function segmente(
  id: string,
  wahl: string,
  stufen: Segment[],
  auf: (wert: string, echt: boolean) => void,
): HTMLElement {
  const box = el('div', 'segmente');
  box.id = id;
  for (const s of stufen) {
    const b = el('button') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = s.label;
    b.dataset.wert = s.wert;
    if (s.titel) b.title = s.titel;
    if (s.klasse) b.classList.add(s.klasse);
    if (s.wert === wahl) b.classList.add('gewaehlt');
    if (s.gesperrt) b.disabled = true;
    else b.addEventListener('click', (e) => auf(s.wert, e.isTrusted));
    box.appendChild(b);
  }
  return box;
}

function knopf(text: string, auf: (echt: boolean) => void, warnend = false): HTMLButtonElement {
  const b = el('button', warnend ? 'knopf warnend' : 'knopf') as HTMLButtonElement;
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', (e) => auf(e.isTrusted));
  return b;
}

// --- Schreiben --------------------------------------------------------------

async function setze(key: string, value: unknown): Promise<void> {
  melde(t('satz.schreibe', { schluessel: key }));
  const r = await window.awbEinstellungen.setzen(key, value);
  melde(
    r.ok ? `${r.aufruf} — ${r.ausgabe}` : t('satz.fehler', { aufruf: r.aufruf, ausgabe: r.ausgabe }),
    r.ok ? 'gut' : 'fehler',
  );
}

/**
 * Guard, Wache und Deckel gehen NICHT ueber `setze`. Sie haben eigene
 * wb-state-Befehle, weil sie Grund, Datum und Rolle tragen und weil das
 * Lockern einen Menschen verlangt -- gemessen an der Herkunft des Aufrufs, nie
 * geglaubt. Was das Werkzeug antwortet, steht danach wortwoertlich in der
 * Fusszeile; eine Ablehnung ist damit lesbar und nicht nur ein ausbleibender
 * Haken.
 */
async function werkzeug(nachricht: Record<string, unknown>, echt: boolean): Promise<void> {
  melde(`${String(nachricht.command ?? '')} …`);
  const r = await window.awbEinstellungen.werkzeug(nachricht, echt === true);
  melde(
    r.ok ? `${r.aufruf} — ${r.ausgabe}` : t('satz.fehler', { aufruf: r.aufruf, ausgabe: r.ausgabe }),
    r.ok ? 'gut' : 'fehler',
  );
}

async function setzeUi(key: string, value: unknown): Promise<void> {
  await window.awbEinstellungen.ui(key, value);
  melde(t('satz.oberflaeche', { schluessel: key, wert: JSON.stringify(value) }), 'gut');
}

/**
 * Die Rueckfrage der dritten Klasse. Sie nennt die FOLGE in Klartext -- nicht
 * "Sind Sie sicher?", sondern den Satz, der beschreibt, was danach anders ist.
 */
function frage(
  text: string,
  tunText: string,
  ja: (grund: string, echt: boolean) => void,
  mitGrund = false,
): void {
  rueckfrageTextEl.textContent = text;
  rueckfrageEl.classList.add('offen');
  const knopfJa = document.getElementById('rueckfrageJa') as HTMLButtonElement;
  const knopfNein = document.getElementById('rueckfrageNein') as HTMLButtonElement;
  const grundFeld = document.getElementById('rueckfrageGrund') as HTMLInputElement;
  const grundZeile = document.getElementById('rueckfrageGrundZeile') as HTMLElement;
  const hinweisEl = document.getElementById('rueckfrageHinweis') as HTMLElement;
  knopfJa.textContent = tunText;
  grundFeld.value = '';
  hinweisEl.textContent = '';
  grundZeile.hidden = !mitGrund;
  const zu = (): void => {
    rueckfrageEl.classList.remove('offen');
    knopfJa.onclick = null;
    knopfNein.onclick = null;
  };
  knopfJa.onclick = (e) => {
    const grund = grundFeld.value.trim();
    // Leer heisst: nicht tun. Das ist keine Formalie -- ohne Grund liest sich
    // eine abgeschaltete Sicherung ein halbes Jahr spaeter wie eine technische
    // Grenze, und genau daran krankte der Zustand davor. Das Werkzeug lehnt es
    // ohnehin ab; hier steht es, damit man es vorher sieht statt hinterher.
    if (mitGrund && !grund) {
      hinweisEl.textContent = t('satz.ohneGrundNichts');
      grundFeld.focus();
      return;
    }
    zu();
    // Massgeblich ist der Klick auf DIESEN Knopf: er ist die letzte Handlung
    // vor der Aenderung, und nur er bestaetigt sie.
    ja(grund, e.isTrusted);
  };
  knopfNein.onclick = () => {
    zu();
    zeichne();
  };
  if (mitGrund) grundFeld.focus();
}

// --- Die Modellwahl ---------------------------------------------------------

/**
 * Erst der Harness, dann das Modell -- die Filterzeile traegt die Zahl je
 * Harness und schneidet die Liste zusammen. Sie steht OFFEN da, mit Kennung und
 * Maschinen-Wahrheit in derselben Zeile: alles, was die Wahl entscheidet, VOR
 * der Wahl.
 */
function modellwahl(
  g: HTMLElement,
  schluessel: string,
  o: { name: string; wirkung: string; info: string; etikett?: string },
  modelle: ModellSicht[],
  gewaehlt: string,
  auf: (id: string) => void,
): void {
  const box = el('div');
  const filter = filterStand.get(schluessel) ?? 'alle';
  const suche = (suchStand.get(schluessel) ?? '').trim().toLowerCase();

  const proHarness = new Map<string, number>();
  for (const m of modelle) proHarness.set(m.harness, (proHarness.get(m.harness) ?? 0) + 1);
  const filterzeile = el('div', 'filterzeile');
  const chips: { wert: string; label: string }[] = proHarness.size < 2 ? [] : [
    { wert: 'alle', label: t('wort.alleModelle', { anzahl: modelle.length }) },
    ...[...proHarness.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([h, n]) => ({
        wert: h,
        label: `${modelle.find((m) => m.harness === h)?.harnessLabel ?? h} ${n}`,
      })),
  ];
  for (const c of chips) {
    const b = el('button') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = c.label;
    b.dataset.filter = c.wert;
    b.dataset.fuer = schluessel;
    if (c.wert === filter) b.classList.add('gewaehlt');
    b.addEventListener('click', () => {
      filterStand.set(schluessel, c.wert);
      zeichne();
    });
    filterzeile.appendChild(b);
  }
  box.appendChild(filterzeile);

  const suchfeld = el('input', 'modellsuche') as HTMLInputElement;
  suchfeld.type = 'text';
  suchfeld.placeholder = t('platzhalter.modellsuche');
  suchfeld.value = suchStand.get(schluessel) ?? '';
  suchfeld.dataset.suche = schluessel;
  suchfeld.spellcheck = false;
  suchfeld.addEventListener('input', () => {
    suchStand.set(schluessel, suchfeld.value);
    zeichne();
    // Nach dem Neuzeichnen steht ein neues Feld da -- der Fokus muss mit,
    // sonst reisst das Tippen nach dem ersten Zeichen ab.
    const neu = document.querySelector<HTMLInputElement>(`input[data-suche="${schluessel}"]`);
    if (neu) {
      neu.focus();
      neu.setSelectionRange(neu.value.length, neu.value.length);
    }
  });
  box.appendChild(suchfeld);

  // Das Gewaehlte steht immer oben, auch wenn der Filter es sonst wegnaehme --
  // sonst sieht man nicht mehr, was gerade gilt.
  const passt = (m: ModellSicht): boolean =>
    (filter === 'alle' || m.harness === filter)
    && (!suche || m.label.toLowerCase().includes(suche) || m.id.toLowerCase().includes(suche));
  const treffer = modelle.filter((m) => m.id !== gewaehlt && passt(m));
  const dasGewaehlte = modelle.find((m) => m.id === gewaehlt);
  const liste = el('div', 'modelliste');
  const zeigen = dasGewaehlte ? [dasGewaehlte, ...treffer] : treffer;
  if (zeigen.length === 0) {
    liste.appendChild(el('div', 'leerhinweis', t('satz.keinTreffer')));
  }
  for (const m of zeigen) {
    const b = el('button', 'modelleintrag') as HTMLButtonElement;
    b.type = 'button';
    b.dataset.modell = m.id;
    b.dataset.fuer = schluessel;
    if (!m.startbar) {
      // Dieselben Merkmale, an denen die V11-Pruefung die Markierung findet.
      b.dataset.status = 'binary-missing';
      b.dataset.model = m.id;
    }
    if (m.id === gewaehlt) b.classList.add('gewaehlt');

    const z1 = el('div', 'zeile1');
    z1.appendChild(el('span', undefined, `${m.id === gewaehlt ? '● ' : '○ '}${m.label}`));
    z1.appendChild(el('span', 'kennung', m.id));
    b.appendChild(z1);

    const z2 = el('div', 'zeile2');
    const stuecke = [m.harnessLabel];
    if (m.kontext) stuecke.push(`${Math.round(m.kontext / 1000)}k Kontext`);
    z2.textContent = stuecke.join(' · ');
    if (!m.startbar) {
      const marke = el('span', 'marke tot', t('wort.nichtStartbar', { maschine: daten?.machine ?? '' }));
      marke.classList.add('statusLabel');
      z2.appendChild(marke);
    }
    b.appendChild(z2);

    b.addEventListener('click', () => auf(m.id));
    liste.appendChild(b);
  }
  box.appendChild(liste);

  feld(g, { ...o, schluessel, steuer: box, breit: true });
}

/**
 * DIE STUFE, UND DER UNTERSCHIED, AUF DEN ES ANKOMMT.
 *
 * Zwei verschiedene Dinge stehen hier nebeneinander, und sie werden staendig
 * verwechselt:
 *
 *   Die STUFE ist die Wahl eines Menschen. Wer selbst startet, dem stehen alle
 *   Stufen offen, die das Programm annimmt -- auch die ueber dem Deckel. Sie
 *   sind waehlbar und tragen nur eine Markierung.
 *
 *   Der DECKEL ist eine Selbstbindung des Orchestrators. Er gilt, wenn der
 *   Orchestrator OHNE Rueckfrage einen Worker startet. Er ist kein Merkmal des
 *   Modells und keine Grenze der Technik.
 *
 * Deshalb ist hier nichts gesperrt und trotzdem alles gesagt.
 */
function stufenwahl(
  g: HTMLElement,
  schluessel: 'orchestratorEffort',
  o: { name: string; wirkung: string; info: string; etikett?: string },
  modell: ModellSicht | undefined,
  deckel: DeckelSicht | undefined,
  stufen: string[],
  wert: string,
): void {
  if (stufen.length === 0) {
    feld(g, {
      ...o,
      schluessel,
      breit: true,
      steuer: el('div', 'leerhinweis',
        modell
          ? t('satz.stufenKeineWahl', { harness: modell.harnessLabel })
          : t('satz.stufenErstModell')),
    });
    return;
  }
  const deckelStufe = deckel?.cap ?? modell?.deckelRegistry ?? '';
  const grenze = deckelStufe ? stufen.indexOf(deckelStufe) : -1;
  const box = el('div');
  box.appendChild(segmente(
    schluessel,
    wert,
    stufen.map((s, i) => ({
      wert: s,
      label: s,
      // NICHTS ist gesperrt. Ueber dem Deckel steht eine Markierung, kein Riegel.
      titel: grenze >= 0 && i > grenze ? t('satz.deckelUeber', { deckel: deckelStufe }) : undefined,
      klasse: grenze >= 0 && i > grenze ? 'ueberDeckel' : undefined,
    })),
    (w) => void setze(schluessel, w),
  ));
  const zeile = el('div', 'deckelzeile');
  if (deckelStufe) {
    const quelle = deckel?.quelle === 'einstellung' ? t('wort.vonDir') : t('wort.ausAuslieferung');
    zeile.appendChild(document.createTextNode(t('satz.deckelDieses')));
    zeile.appendChild(el('b', undefined, `${deckelStufe} (${quelle})`));
    zeile.appendChild(document.createTextNode(
      t('satz.deckelGilt')
      + (grenze >= 0 && grenze < stufen.length - 1
        ? t('satz.deckelDarueber', { stufen: stufen.slice(grenze + 1).join(', ') })
        : ''),
    ));
    if (deckel?.grund) zeile.appendChild(el('div', undefined, t('satz.deckelGrund', { grund: deckel.grund })));
  } else {
    zeile.textContent = t('satz.deckelKeiner');
  }
  box.appendChild(zeile);
  feld(g, { ...o, schluessel, breit: true, steuer: box });
}

// --- Seite 1: Sitzung -------------------------------------------------------

function seiteSitzung(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'sitzung';
  s.appendChild(el('h1', undefined, t('seite.sitzung.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.sitzung.unterzeile')));

  const harness = String(d.settings.orchestratorHarness ?? 'claude');
  const g1 = gruppe(s, t('gruppe.sitzung.start'));
  feld(g1, {
    ...texte('orchestratorHarness', { maschine: d.machine }),
    wartet: true,
    schluessel: 'orchestratorHarness',
    steuer: segmente(
      'orchestratorHarness',
      harness,
      d.harnesses.map((h) => ({
        wert: h.id,
        label: `${h.label} ${h.modelle}${h.binaer ? '' : ' · fehlt hier'}`,
        titel: h.binaer ? undefined : t('wort.nichtStartbar', { maschine: d.machine }),
      })),
      (w) => void setze('orchestratorHarness', w),
    ),
  });

  const eigene = d.orchestratorModelle.filter((m) => m.harness === harness);
  const gewaehlt = String(d.settings.orchestratorModel ?? '');
  if (eigene.length === 0) {
    feld(g1, {
      name: t('feld.orchestratorModel.leerName'),
      wirkung: t('feld.orchestratorModel.leerWirkung'),
      info: t('feld.orchestratorModel.leerInfo'),
      schluessel: 'orchestratorModel',
      breit: true,
      steuer: el('div', 'leerhinweis', t('satz.keinModellFuerProgramm', { harness })),
    });
  } else {
    modellwahl(g1, 'orchestratorModel', texte('orchestratorModel', { anzahl: eigene.length }),
      eigene, gewaehlt, (id) => void setze('orchestratorModel', id));
  }
  const orchModell = d.orchestratorModelle.find((m) => m.id === gewaehlt);
  stufenwahl(g1, 'orchestratorEffort', texte('orchestratorEffort'),
    orchModell,
    d.deckel[gewaehlt],
    d.deckel[gewaehlt]?.efforts ?? d.harnessStufen[orchModell?.harness ?? ''] ?? [],
    String(d.settings.orchestratorEffort ?? 'xhigh'));

  feld(g1, {
    ...texte('newSessionDefaultDir'),
    wartet: true,
    schluessel: 'newSessionDefaultDir',
    steuer: textzeile(
      'newSessionDefaultDir',
      String(d.settings.newSessionDefaultDir ?? d.vorgaben.newSessionDefaultDir ?? ''),
      t('platzhalter.startordner'),
      (w) => void setze('newSessionDefaultDir', w),
    ),
  });

  const g2 = gruppe(s, t('gruppe.sitzung.leiste'));
  feld(g2, {
    ...texte('showStopped'),
    uiSchluessel: 'showStopped',
    steuer: haken('showStopped', d.ui.showStopped, (an) => void setzeUi('showStopped', an)),
  });
  feld(g2, {
    ...texte('sort'),
    uiSchluessel: 'sort',
    steuer: segmente(
      'sort',
      d.ui.sort,
      [
        { wert: 'recent', label: t('wort.sort.recent') },
        { wert: 'folder', label: t('wort.sort.folder') },
        { wert: 'name', label: t('wort.sort.name') },
      ],
      (w) => void setzeUi('sort', w),
    ),
  });

  const g3 = gruppe(s, t('gruppe.sitzung.schliessen'));
  feld(g3, {
    ...texte('closeSessionOnWindowClose'),
    schluessel: 'closeSessionOnWindowClose',
    // `=== true` und nicht `!== false`: seit dem 07.08. ist die Vorgabe AUS,
    // und ein Schlüssel, der in der Datei fehlt, muss denselben Haken zeigen
    // wie die Vorgabe — sonst verspricht das Menü das Gegenteil dessen, was
    // das Programm tut.
    steuer: haken('closeSessionOnWindowClose', d.settings.closeSessionOnWindowClose === true,
      (an) => void setze('closeSessionOnWindowClose', an)),
  });
  return s;
}

// --- Seite 2: Erlaubnisse ---------------------------------------------------
//
// Vorgabe des Nutzers fuer diese Seite im Wortlaut: "dort soll so viel
// einstellbar sein wie moeglich und die optionen sollen fuer den enduser
// beschriftet sein mit info ding daneben ueber das man hovern kann um mehr zu
// erfahren." Deshalb steht hier ALLES, was eine Sicherung setzt oder wegnimmt,
// und jede Zeile traegt ihre Info-Marke.
//
// Die neun Guards stehen NUR hier und nicht zusaetzlich auf der Aufsicht-Seite:
// zwei Orte fuer dieselbe Entscheidung sind zwei Wahrheiten, von denen eine
// irgendwann die falsche ist. Die Aufsicht-Seite verweist dorthin.

function seiteErlaubnisse(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'erlaubnisse';
  s.appendChild(el('h1', undefined, t('seite.erlaubnisse.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.erlaubnisse.unterzeile')));

  const v = gruppe(s, t('gruppe.erlaubnisse.vorsicht'), 'vorsicht');
  feld(v, {
    ...texte('workerSkipPermissions'),
    wartet: true,
    schluessel: 'workerSkipPermissions',
    steuer: haken('workerSkipPermissions', d.settings.workerSkipPermissions !== false, (an) => {
      if (!an) {
        void setze('workerSkipPermissions', false);
        return;
      }
      frage(t('frage.skipAn.text'), t('frage.skipAn.tun'), () => void setze('workerSkipPermissions', true));
    }),
  });
  feld(v, {
    ...texte('workerWorktrees'),
    wartet: true,
    schluessel: 'workerWorktrees',
    steuer: haken('workerWorktrees', d.settings.workerWorktrees !== false,
      (an) => void setze('workerWorktrees', an)),
  });

  // Die vierte Sicherung, die ein MENSCH lockert (2026-08-16, permmode-Auftrag).
  // Bewusst OHNE `schluessel`: mit ihm bekaeme das Feld ueber `feld()` ein
  // Ruecksstell-Zeichen, das ueber `setze()` liefe -- den ungesicherten
  // Schreibweg, der `wb-state` nie den Menschen-Nachweis mitgibt und darum das
  // Anheben auf bypassPermissions IMMER ablehnt. Genau dasselbe gilt fuer Guard,
  // Wache und Deckel oben und unten auf dieser Seite -- keiner von ihnen traegt
  // `schluessel`, aus demselben Grund.
  const permissionModi = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
  const permissionModeWert = String(d.settings.orchestratorPermissionMode ?? 'bypassPermissions');
  feld(v, {
    ...texte('orchestratorPermissionMode'),
    wartet: true,
    breit: true,
    steuer: segmente(
      'orchestratorPermissionMode',
      permissionModeWert,
      permissionModi.map((wert) => ({ wert, label: wert })),
      (wert, echt) => {
        if (wert === permissionModeWert) return;
        if (wert !== 'bypassPermissions') {
          void werkzeug({ command: 'permission-mode-set', value: wert }, echt);
          return;
        }
        frage(
          t('frage.permissionModeAn.text'),
          t('frage.permissionModeAn.tun'),
          (grund, echtJa) => void werkzeug({ command: 'permission-mode-set', value: wert, grund }, echtJa),
          true,
        );
      },
    ),
  });

  const g1 = gruppe(s, t('gruppe.erlaubnisse.guards'));
  const guardListe = el('div', 'zeilen');
  guardListe.id = 'guardListe';
  // Die Reihenfolge und die Kennungen kommen vom Werkzeug, der Anzeigetext aus
  // der Texttabelle. Ein Guard, den das Werkzeug fuehrt und die Tabelle nicht
  // kennt, faellt damit nicht unter den Tisch -- er steht mit seiner Kennung da.
  for (const zeileDaten of d.guards) {
    const name = t(`guard.${zeileDaten.id}.name`);
    const wirkung = t(`guard.${zeileDaten.id}.wirkung`);
    const info = t(`guard.${zeileDaten.id}.info`);
    const z = el('div', zeileDaten.an ? 'zeile' : 'zeile abgeschaltet');
    z.dataset.guard = zeileDaten.id;
    z.appendChild(haken(`guard-${zeileDaten.id}`, zeileDaten.an, (an, echt) => {
      if (an) {
        void werkzeug({ command: 'guard-set', guard: zeileDaten.id, an: true }, echt);
        return;
      }
      frage(
        t('frage.guardAus.text', { name, wirkung }),
        t('frage.guardAus.tun'),
        (grund, echtJa) => void werkzeug({ command: 'guard-set', guard: zeileDaten.id, an: false, grund }, echtJa),
        true,
      );
    }));
    z.appendChild(el('span', 'titel', name));
    z.appendChild(el('span', 'grund', zeileDaten.an
      ? wirkung
      : (zeileDaten.rolle && zeileDaten.rolle !== 'alle'
        ? t('satz.abgeschaltetFuer', { rolle: zeileDaten.rolle })
        : t('satz.abgeschaltet'))
        + (zeileDaten.seit ? t('satz.seit', { datum: zeileDaten.seit.slice(0, 10) }) : '')
        + (zeileDaten.grund ? `: ${zeileDaten.grund}` : '')));
    const rechts = el('div', 'rechts');
    rechts.appendChild(infozeichen(`guard-${zeileDaten.id}`, info));
    z.appendChild(rechts);
    guardListe.appendChild(z);
  }
  if (d.guards.length === 0) {
    guardListe.appendChild(el('div', 'leerhinweis', t('satz.keineGuards')));
  }
  feld(g1, { ...texte('guards'), breit: true, steuer: guardListe });

  const g2 = gruppe(s, t('gruppe.erlaubnisse.rueckfragen'));
  const musterListe = el('div', 'zeilen');
  musterListe.id = 'musterListe';
  if (d.askMuster.length === 0) {
    musterListe.appendChild(el('div', 'leerhinweis', t('satz.keineMuster')));
  }
  d.askMuster.forEach((m, i) => {
    const aus = m.aus === true;
    const z = el('div', aus ? 'zeile abgeschaltet' : 'zeile');
    z.dataset.muster = String(i);
    const bezeichnung = [m.befehl, m.unterbefehl].filter(Boolean).join(' ');
    z.appendChild(haken(`muster-${i}`, !aus, (an) => {
      const neu = d.askMuster.map((x, j) => (j === i ? { ...x, aus: !an } : { ...x }));
      for (const x of neu) if (!x.aus) delete x.aus;
      if (an) {
        void setze('askPatterns', neu);
        return;
      }
      frage(
        t('frage.musterAus.text', { name: bezeichnung, grund: m.grund }),
        t('frage.musterAus.tun'),
        () => void setze('askPatterns', neu),
      );
    }));
    z.appendChild(el('span', 'titel', bezeichnung));
    z.appendChild(el('span', 'grund', m.grund));
    const rechts = el('div', 'rechts');
    if (m.muster) rechts.appendChild(el('code', undefined, m.muster));
    rechts.appendChild(knopf(t('wort.entfernen'), () => {
      frage(
        t('frage.musterWeg.text', { name: bezeichnung }),
        t('frage.musterWeg.tun'),
        () => void setze('askPatterns', d.askMuster.filter((_x, j) => j !== i)),
      );
    }, true));
    z.appendChild(rechts);
    musterListe.appendChild(z);
  });

  const anlegen = el('div', 'anlegen');
  const nBefehl = el('input') as HTMLInputElement;
  nBefehl.type = 'text';
  nBefehl.id = 'musterBefehl';
  nBefehl.placeholder = t('platzhalter.musterBefehl');
  nBefehl.spellcheck = false;
  const nUnter = el('input') as HTMLInputElement;
  nUnter.type = 'text';
  nUnter.id = 'musterUnterbefehl';
  nUnter.placeholder = t('platzhalter.musterUnterbefehl');
  nUnter.spellcheck = false;
  const nGrund = el('input') as HTMLInputElement;
  nGrund.type = 'text';
  nGrund.id = 'musterGrund';
  nGrund.placeholder = t('platzhalter.musterGrund');
  nGrund.spellcheck = false;
  anlegen.append(nBefehl, nUnter, nGrund, knopf(t('wort.hinzufuegen'), () => {
    const befehl = nBefehl.value.trim();
    if (!befehl) {
      melde(t('satz.musterOhneBefehl'), 'fehler');
      return;
    }
    const neu: AskMuster = { befehl, grund: nGrund.value.trim() || t('satz.musterVonHand') };
    if (nUnter.value.trim()) neu.unterbefehl = nUnter.value.trim();
    void setze('askPatterns', [...d.askMuster, neu]);
  }));

  const musterBox = el('div');
  musterBox.append(musterListe, anlegen);
  feld(g2, { ...texte('askPatterns'), schluessel: 'askPatterns', breit: true, steuer: musterBox });

  const g3 = gruppe(s, t('gruppe.erlaubnisse.geheimnisse'));
  const chipListe = (
    werte: string[],
    id: string,
    schluessel: string,
    was: string,
  ): HTMLElement => {
    const box = el('div');
    const chips = el('div', 'chips');
    chips.id = id;
    if (werte.length === 0) {
      chips.appendChild(el('span', 'leerhinweis', t('wort.leerListe')));
    }
    for (const w of werte) {
      const c = el('span', 'chip');
      c.appendChild(el('code', undefined, w));
      const weg = el('button') as HTMLButtonElement;
      weg.type = 'button';
      weg.textContent = '×';
      weg.dataset.weg = w;
      weg.title = t('wort.entfernen');
      weg.addEventListener('click', () => {
        const neu = werte.filter((x) => x !== w);
        if (neu.length === 0) {
          frage(
            t('frage.listeLeer.text', { was }),
            t('frage.listeLeer.tun'),
            () => void setze(schluessel, neu),
          );
          return;
        }
        void setze(schluessel, neu);
      });
      c.appendChild(weg);
      chips.appendChild(c);
    }
    box.appendChild(chips);
    const anlegenBox = el('div', 'anlegen');
    const feldNeu = el('input') as HTMLInputElement;
    feldNeu.type = 'text';
    feldNeu.id = `${id}Neu`;
    feldNeu.placeholder = was;
    feldNeu.spellcheck = false;
    anlegenBox.append(feldNeu, knopf(t('wort.hinzufuegen'), () => {
      const wert = feldNeu.value.trim();
      if (!wert || werte.includes(wert)) return;
      void setze(schluessel, [...werte, wert]);
    }));
    box.appendChild(anlegenBox);
    return box;
  };
  feld(g3, {
    ...texte('secretExcludeDirs'),
    schluessel: 'secretExcludeDirs',
    breit: true,
    steuer: chipListe(d.ausschluss.ordner, 'secretExcludeDirs', 'secretExcludeDirs', t('platzhalter.ordner')),
  });
  feld(g3, {
    ...texte('secretExcludePatterns'),
    schluessel: 'secretExcludePatterns',
    breit: true,
    steuer: chipListe(d.ausschluss.muster, 'secretExcludePatterns', 'secretExcludePatterns',
      t('platzhalter.dateimuster')),
  });

  // Werkzeuge und MCP-Server: was ein Agent bekommt, steht heute in FREMDEN
  // Konfigurationen (~/.claude/settings.json, die Dienste von mcp-shared).
  // Gezeigt wird, was dort steht; geschrieben wird nichts. Ein Schalter, der
  // eine fremde Konfiguration halb ueberschreibt, waere schlimmer als keiner --
  // und ein graues Feld, das nichts tut, waere die Sorte stiller Luege, gegen
  // die dieses Menue gebaut ist.
  const g4 = gruppe(s, t('gruppe.erlaubnisse.werkzeuge'));
  const werkzeugBox = el('div');
  const hookListe = el('div', 'zeilen');
  hookListe.id = 'hookListe';
  if (d.hooks.length === 0) {
    hookListe.appendChild(el('div', 'leerhinweis', t('satz.werkzeugeOhneHooks')));
  }
  for (const h of d.hooks) {
    const z = el('div', 'zeile');
    z.dataset.hook = h.name;
    z.appendChild(el('span', 'titel', h.name));
    z.appendChild(el('span', 'grund', h.ereignis));
    const rechts = el('div', 'rechts');
    if (h.lehntAb) rechts.appendChild(el('span', 'marke', 'lehnt ab'));
    z.appendChild(rechts);
    hookListe.appendChild(z);
  }
  werkzeugBox.appendChild(hookListe);
  werkzeugBox.appendChild(el('div', 'klartext', t('satz.werkzeugeMcp')));
  feld(g4, { ...texte('werkzeuge'), breit: true, steuer: werkzeugBox });
  return s;
}

// --- Seite 3: Programme und Modelle ----------------------------------------

function seiteHarnesses(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'harnesses';
  s.appendChild(el('h1', undefined, t('seite.harnesses.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.harnesses.unterzeile')));

  const g1 = gruppe(s, t('gruppe.harnesses.programme'));
  const st = el('table');
  st.id = 'harnessTabelle';
  const sk = el('tr');
  for (const h of [
    t('spalte.programm'), t('spalte.hier', { maschine: d.machine }), t('spalte.anmeldung'),
    t('spalte.stufen'), t('spalte.modelle'), t('spalte.chat'),
  ]) sk.appendChild(el('th', undefined, h));
  st.appendChild(sk);
  for (const h of d.harnesses) {
    const stufen = d.harnessStufen[h.id];
    const r = el('tr');
    r.dataset.harness = h.id;
    if (!h.binaer) r.className = 'warnung';
    r.appendChild(el('td', undefined, h.label));
    r.appendChild(el('td', undefined,
      h.binaer ? t('wort.startbar') : t('wort.nichtStartbar', { maschine: d.machine })));

    // Die Anmeldung ist gemessen, nicht geraten: liegt kein Beleg VOR, steht
    // "nicht pruefbar" da und nicht "nicht angemeldet". Der ORT des Belegs
    // steht bewusst nirgends in der Oberflaeche.
    const an = d.anmeldung[h.id];
    const anZelle = el('td', an?.stand === 'ja' ? 'gesetzt' : 'stufenzelle',
      an?.stand === 'ja' ? t('wort.angemeldet')
        : an?.stand === 'nein' ? t('wort.nichtAngemeldet')
          : t('wort.anmeldungUnbekannt'));
    if (an?.grund) anZelle.title = an.grund;
    r.appendChild(anZelle);

    // Drei verschiedene Aussagen, und sie werden nicht vermischt: eine Liste,
    // "kennt keine Stufen" (das Programm hat keine) und "nicht ermittelt"
    // (die Frage blieb unbeantwortet). Am Bild gesehen, 06.08.: eine
    // gescheiterte Abfrage stand als Tatsachenbehauptung in der Tabelle.
    r.appendChild(el('td', 'stufenzelle', stufen === undefined
      ? t('wort.stufenNichtErmittelt')
      : (stufen.length ? stufen.join(' ') : t('wort.keineStufen'))));
    r.appendChild(el('td', undefined, String(h.modelle)));

    // Die Chat-Ansicht: ein Schalter nur dort, wo die Registry einen gemessenen
    // Weg zum Gespraechsverlauf fuehrt. Sonst der GRUND im Klartext -- kein
    // graues Feld (SPEC-V4 6.3, Punkt 6).
    const quelle = d.chatQuellen[h.id];
    const chatZelle = el('td');
    if (quelle && quelle.via && quelle.probe) {
      const kasten = el('div', 'chatzelle');
      kasten.appendChild(haken(`chat-${h.id}`, d.chatAnsicht[h.id] === true, (anAus) => {
        void setze('chatAnsicht', { ...d.chatAnsicht, [h.id]: anAus });
      }));
      const wie = el('span', 'grund',
        quelle.live ? t('satz.chatKannLive') : t('satz.chatKannNichtLive'));
      kasten.appendChild(wie);
      if (quelle.zeigtNicht.length) {
        kasten.appendChild(el('div', 'grund', t('satz.chatZeigtNicht', { liste: quelle.zeigtNicht.join(', ') })));
      }
      chatZelle.appendChild(kasten);
    } else {
      chatZelle.className = 'stufenzelle';
      chatZelle.textContent = quelle && quelle.via && !quelle.probe
        ? t('satz.chatOhneMessung')
        : (quelle?.grund || t('satz.chatKannNicht'));
    }
    r.appendChild(chatZelle);
    st.appendChild(r);
  }
  feld(g1, { ...texte('harnessTabelle'), breit: true, steuer: st });
  feld(g1, {
    ...texte('chatAnsicht'),
    wartet: true,
    schluessel: 'chatAnsicht',
    breit: true,
    steuer: el('div', 'klartext', t('satz.chatKannNicht')),
  });

  const g2 = gruppe(s, t('gruppe.harnesses.lokal'));
  const ollamaBox = el('div');
  ollamaBox.appendChild(textzeile('ollamaEndpoint', d.ollamaEndpunkt, t('platzhalter.ollama'),
    (w) => void setze('ollamaEndpoint', w)));
  ollamaBox.appendChild(el('div', 'klartext', t('satz.ollamaNochNichtVerdrahtet')));
  feld(g2, {
    ...texte('ollamaEndpoint'),
    wartet: true,
    schluessel: 'ollamaEndpoint',
    breit: true,
    steuer: ollamaBox,
  });
  feld(g2, {
    ...texte('modelDiscoveryAuto'),
    schluessel: 'modelDiscoveryAuto',
    steuer: haken('modelDiscoveryAuto', d.settings.modelDiscoveryAuto !== false,
      (an) => void setze('modelDiscoveryAuto', an)),
  });

  const g3 = gruppe(s, t('gruppe.harnesses.schluessel'));
  const at = el('table');
  at.id = 'anbieterTabelle';
  const ak = el('tr');
  for (const h of [t('spalte.anbieter'), t('spalte.zugang'), t('spalte.eingabe')]) {
    ak.appendChild(el('th', undefined, h));
  }
  at.appendChild(ak);
  for (const p of d.anbieter) {
    const r = el('tr');
    r.dataset.anbieter = p.id;
    r.appendChild(el('td', undefined, p.label));
    // Der Schluesselbund-Stand ist eigenstaendig von `p.stand` (das prueft nur
    // eine Umgebungsvariable) und ueberschreibt ihn nur in EINE Richtung: von
    // "liegt nicht vor" auf "liegt vor", nie zurueck -- ein Zugang, der schon
    // auf einem der beiden Wege galt, gilt weiter.
    const imSchluesselbund = p.art === 'schluessel' && schluesselStand[p.id] === true;
    const stand = imSchluesselbund ? 'ja' : p.stand;
    const wort = p.art === 'lokal' ? t('wort.zugangLokal')
      : stand === 'ja' ? t('wort.zugangDa')
        : stand === 'nein' ? (p.art === 'abo' ? t('wort.zugangAbo') : t('wort.zugangFehlt'))
          : t('wort.zugangUnbekannt');
    r.appendChild(el('td', stand === 'ja' ? 'gesetzt' : 'stufenzelle', wort));

    // Eingeben kann man nur, wo ueberhaupt ein Schluessel der richtige Zugang
    // ist -- ein Abo oder ein lokaler Anbieter hat keinen Schluesselbund-Dienst,
    // dem man etwas eintragen koennte (siehe `anbieterMitSchluessel` in
    // main/schluesselbund.ts, dieselbe Auflage).
    const eingabeZelle = el('td');
    if (p.art === 'schluessel') {
      const eingabe = el('input') as HTMLInputElement;
      eingabe.type = 'password';
      eingabe.autocomplete = 'off';
      eingabe.spellcheck = false;
      eingabe.placeholder = t('platzhalter.schluesselEingabe');
      eingabe.dataset.schluesselEingabe = p.id;
      const paar = el('span', 'steuerpaar');
      const speichern = knopf(t('wort.speichern'), () => {
        // Geloescht wird SOFORT, gleich ob der Aufruf noch glueckt oder nicht --
        // der Klartext soll im Feld nie laenger stehen als bis zum Klick.
        const wert = eingabe.value;
        eingabe.value = '';
        if (!wert.trim()) {
          melde(t('satz.schluesselLeer'), 'fehler');
          return;
        }
        melde(t('satz.schreibe', { schluessel: p.id }));
        void window.awbEinstellungen.schluesselSetzen(p.id, wert).then((antwort) => {
          melde(
            antwort.ok ? t('satz.schluesselGespeichert', { anbieter: p.label }) : t('satz.schluesselFehler'),
            antwort.ok ? 'gut' : 'fehler',
          );
          void schluesselStatusLaden();
        });
      });
      speichern.dataset.schluesselSpeichern = p.id;
      paar.append(eingabe, speichern);
      eingabeZelle.appendChild(paar);
    }
    r.appendChild(eingabeZelle);
    at.appendChild(r);
  }
  feld(g3, { ...texte('anbieter'), breit: true, steuer: at });

  const g4 = gruppe(s, t('gruppe.harnesses.deckel'));
  // Der eine Satz, der die Gruppe trägt. Er steht offen und nicht in einem
  // Infozeichen, weil er die häufigste Verwechslung dieser Werkbank ausräumt.
  const satz = el('div', 'reserviert');
  satz.dataset.leitsatz = 'deckel';
  const p = el('p');
  p.appendChild(el('strong', undefined, t('satz.deckelLeitsatzFett')));
  p.appendChild(document.createTextNode(t('satz.deckelLeitsatz')));
  p.style.margin = '0';
  satz.appendChild(p);
  g4.appendChild(satz);

  const alle = [...d.orchestratorModelle];
  for (const m of d.workerModelle) if (!alle.some((x) => x.id === m.id)) alle.push(m);
  alle.sort((a, b) => a.harness.localeCompare(b.harness) || a.label.localeCompare(b.label));

  const suche = (suchStand.get('deckel') ?? '').trim().toLowerCase();
  const suchfeld = el('input', 'modellsuche') as HTMLInputElement;
  suchfeld.type = 'text';
  suchfeld.placeholder = t('platzhalter.suche');
  suchfeld.value = suchStand.get('deckel') ?? '';
  suchfeld.dataset.suche = 'deckel';
  suchfeld.spellcheck = false;
  suchfeld.addEventListener('input', () => {
    suchStand.set('deckel', suchfeld.value);
    zeichne();
    const neu = document.querySelector<HTMLInputElement>('input[data-suche="deckel"]');
    if (neu) {
      neu.focus();
      neu.setSelectionRange(neu.value.length, neu.value.length);
    }
  });

  const dt = el('table');
  dt.id = 'deckelTabelle';
  const dk = el('tr');
  for (const h of [t('spalte.modell'), t('spalte.programm'), t('spalte.deckel'),
    t('spalte.herkunft'), t('spalte.grund')]) dk.appendChild(el('th', undefined, h));
  dt.appendChild(dk);
  const treffer = alle.filter((m) => !suche
    || m.label.toLowerCase().includes(suche) || m.id.toLowerCase().includes(suche));
  for (const m of treffer.slice(0, 60)) {
    const gesetzt = d.effortCaps[m.id];
    // Dieselbe Regel wie in `wb-state` (effective_cap): eine Setzung schlaegt
    // die Auslieferung, sonst gilt die Registry. Sie steht hier ein zweites
    // Mal, weil 86 einzelne Werkzeugaufrufe eine halbe Minute Wartezeit fuer
    // eine Tabelle waeren -- der Test vergleicht eine Zeile davon gegen
    // `wb-state models cap`, damit die zweite Antwort nicht abdriftet.
    const quelle = gesetzt ? 'einstellung' : (m.deckelRegistry ? 'registry' : '-');
    const stufen = d.harnessStufen[m.harness];
    const r = el('tr');
    r.dataset.modell = m.id;
    const erste = el('td');
    erste.appendChild(el('div', undefined, m.label));
    erste.appendChild(el('div', 'wert', m.id));
    r.appendChild(erste);
    r.appendChild(el('td', 'wert', m.harnessLabel));

    const wahlZelle = el('td');
    if (stufen === undefined) {
      wahlZelle.appendChild(el('span', 'stufenzelle', t('wort.stufenNichtErmittelt')));
    } else if (stufen.length === 0) {
      wahlZelle.appendChild(el('span', 'stufenzelle', t('wort.keineStufen')));
    } else {
      const wahl = el('select') as HTMLSelectElement;
      wahl.dataset.deckel = m.id;
      const aus = el('option') as HTMLOptionElement;
      aus.value = '';
      aus.textContent = t('satz.deckelAuslieferungWahl', { deckel: m.deckelRegistry || t('wort.ohne') });
      wahl.appendChild(aus);
      for (const st2 of stufen) {
        const o = el('option') as HTMLOptionElement;
        o.value = st2;
        o.textContent = st2;
        if (gesetzt && gesetzt.cap === st2) o.selected = true;
        wahl.appendChild(o);
      }
      wahl.addEventListener('change', (e) => {
        const stufe = wahl.value;
        if (!stufe) {
          void werkzeug({ command: 'effort-cap', model: m.id }, e.isTrusted);
          return;
        }
        frage(
          t('frage.deckel.text', { modell: m.label, stufe }),
          t('frage.deckel.tun'),
          (grund, echtJa) => void werkzeug({ command: 'effort-cap', model: m.id, stufe, grund }, echtJa),
          true,
        );
      });
      wahlZelle.appendChild(wahl);
    }
    r.appendChild(wahlZelle);
    const qz = el('td', gesetzt ? 'gesetzt' : 'stufenzelle',
      quelle === 'einstellung' ? t('wort.vonDirAm', { datum: (gesetzt?.gesetzt ?? '').slice(0, 10) }) : quelle);
    r.appendChild(qz);
    r.appendChild(el('td', 'stufenzelle', gesetzt?.grund ?? ''));
    dt.appendChild(r);
  }
  if (treffer.length === 0) {
    const r = el('tr');
    const c = el('td', 'wert', t('satz.keinTrefferSuche'));
    c.colSpan = 5;
    r.appendChild(c);
    dt.appendChild(r);
  }
  const deckelBox = el('div');
  deckelBox.append(suchfeld, dt);
  if (treffer.length > 60) {
    deckelBox.appendChild(el('div', 'leerhinweis', t('satz.zuVieleTreffer', { anzahl: treffer.length })));
  }
  feld(g4, { ...texte('effortCaps'), wartet: true, breit: true, steuer: deckelBox });
  return s;
}

// --- Seite 4: Maschinen -----------------------------------------------------

function seiteMaschinen(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'maschinen';
  s.appendChild(el('h1', undefined, t('seite.maschinen.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.maschinen.unterzeile')));

  const g = gruppe(s, t('gruppe.maschinen.liste'));
  const liste = el('div', 'zeilen');
  liste.id = 'maschinenListe';

  const eigen = el('div', 'zeile');
  eigen.dataset.maschine = 'local';
  eigen.appendChild(el('span', 'titel', d.machine));
  eigen.appendChild(el('span', 'grund', t('satz.eigeneMaschine')));
  liste.appendChild(eigen);

  if (d.maschinen.length === 0) {
    liste.appendChild(el('div', 'leerhinweis', t('satz.keineMaschine')));
  }
  for (const m of d.maschinen) {
    const z = el('div', 'zeile');
    z.dataset.maschine = m;
    z.appendChild(el('span', 'titel', m));
    z.appendChild(el('span', 'grund', t('satz.fremdeMaschine', { name: m })));
    const rechts = el('div', 'rechts');
    const antwort = el('span', 'antwort', '');
    antwort.dataset.antwort = m;
    rechts.appendChild(antwort);
    rechts.appendChild(knopf(t('wort.pruefen'), () => {
      antwort.textContent = t('wort.frage');
      antwort.className = 'antwort';
      void window.awbEinstellungen.maschinePruefen(m).then((r) => {
        antwort.textContent = r.ok ? t('wort.erreichbar') : t('wort.nichtErreichbar', { grund: r.ausgabe });
        antwort.className = r.ok ? 'antwort gut' : 'antwort schlecht';
        melde(`ssh ${m}: ${r.ausgabe}`, r.ok ? 'gut' : 'fehler');
      });
    }));
    rechts.appendChild(knopf(t('wort.entfernen'), () => {
      void setze('remoteMachines', d.maschinen.filter((x) => x !== m));
    }, true));
    z.appendChild(rechts);
    liste.appendChild(z);
    // Wie viel eine ANDERE Maschine traegt, steht in IHRER Einstellungsdatei.
    // Eine zweite Zahl hier waere eine zweite Wahrheit, von der eine falsch
    // ist -- der Weg dorthin steht im Klartext daneben.
    const hinweis = el('div', 'klartext', t('satz.fremdeLast', { name: m }));
    hinweis.dataset.fremdelast = m;
    liste.appendChild(hinweis);
  }

  const anlegen = el('div', 'anlegen');
  const neuFeld = el('input') as HTMLInputElement;
  neuFeld.type = 'text';
  neuFeld.id = 'maschineNeu';
  neuFeld.placeholder = t('platzhalter.maschine');
  neuFeld.spellcheck = false;
  anlegen.append(neuFeld, knopf(t('wort.hinzufuegen'), () => {
    const name = neuFeld.value.trim();
    if (!name) return;
    if (d.maschinen.includes(name)) {
      melde(t('satz.maschineSchonDa', { name }), 'fehler');
      return;
    }
    void setze('remoteMachines', [...d.maschinen, name]);
  }));

  const box = el('div');
  box.append(liste, anlegen);
  feld(g, { ...texte('remoteMachines'), schluessel: 'remoteMachines', breit: true, steuer: box });

  const g2 = gruppe(s, t('gruppe.maschinen.last'));
  feld(g2, {
    ...texte('maxWorkers'),
    schluessel: 'maxWorkers',
    steuer: zahl('maxWorkers', Number(d.settings.maxWorkers ?? 8), 1, 64, 'Worker',
      (n) => void setze('maxWorkers', n)),
  });
  const maschinenwahl: Segment[] = [
    { wert: 'local', label: t('wort.dieseMaschine', { name: d.machine }) },
    ...d.maschinen.map((m) => ({ wert: m, label: m })),
  ];
  feld(g2, {
    ...texte('defaultWorkerMachine'),
    wartet: true,
    schluessel: 'defaultWorkerMachine',
    steuer: segmente(
      'defaultWorkerMachine',
      String(d.settings.defaultWorkerMachine ?? 'local'),
      maschinenwahl,
      (w) => void setze('defaultWorkerMachine', w),
    ),
  });
  return s;
}

// --- Seite 5: Aufsicht und Meldungen ---------------------------------------

/**
 * Die Antwort des Testknopfs -- eine Zeile je Weg, in der Reihenfolge von
 * `meldeWege`, nicht in der Einfuegereihenfolge des Objekts. `wege` steht
 * hier fuer die Beschriftung ('weg.system' etc.), nicht fuer den Sendeweg
 * selbst.
 */
function meldungTestZeile(weg: string, ergebnis: MeldeWegErgebnis): HTMLElement {
  const z = el('div', 'zeile');
  z.dataset.meldungTest = weg;
  z.appendChild(el('span', 'titel', t(`weg.${weg}`)));
  const antwort = el('span', ergebnis.ok ? 'antwort gut' : 'antwort schlecht');
  antwort.textContent = weg === 'handy'
    ? (ergebnis.ok
      ? t('meldungTesten.handy.ok', { status: ergebnis.status ?? 0 })
      : t('meldungTesten.handy.fehler', { grund: ergebnis.grund ?? '' }))
    : t(`meldungTesten.${weg}.${ergebnis.ok ? 'ok' : 'fehler'}`, { grund: ergebnis.grund ?? '' });
  z.appendChild(antwort);
  return z;
}

function meldungTestErgebnisZeichnen(box: HTMLElement, r: MeldeTestErgebnis, meldeWege: string[]): void {
  box.textContent = '';
  if (!r.an) {
    box.className = 'klartext';
    box.textContent = t('meldungTesten.hauptschalterAus');
    return;
  }
  const gewaehlt = meldeWege.filter((weg) => r.ergebnisse[weg] !== undefined);
  if (gewaehlt.length === 0) {
    box.className = 'klartext';
    box.textContent = t('meldungTesten.keinWeg');
    return;
  }
  box.className = 'zeilen';
  for (const weg of gewaehlt) box.appendChild(meldungTestZeile(weg, r.ergebnisse[weg] as MeldeWegErgebnis));
}

function seiteAufsicht(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'aufsicht';
  s.appendChild(el('h1', undefined, t('seite.aufsicht.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.aufsicht.unterzeile')));

  const wacheAn = d.settings.contextGuardAutostart !== false;
  const g1 = gruppe(s, t('gruppe.aufsicht.wache'));
  feld(g1, {
    ...texte('contextGuardAutostart'),
    wartet: true,
    schluessel: 'contextGuardAutostart',
    steuer: haken('contextGuardAutostart', wacheAn, (an) => {
      if (an) {
        void setze('contextGuardAutostart', true);
        return;
      }
      frage(t('frage.wacheAus.text'), t('frage.wacheAus.tun'),
        () => void setze('contextGuardAutostart', false));
    }),
  });
  const orch = d.wache.orchestrator ?? { an: true, mahnenAb: 75, eingreifen: true, notbremseAb: 80 };
  const wkr = d.wache.worker ?? { an: true, mahnenAb: 80, eingreifen: true };
  feld(g1, {
    ...texte('wacheOrchAn'),
    wartet: true,
    steuer: haken('wacheOrchAn', orch.an, (an, echt) => {
      if (an) {
        void werkzeug({ command: 'wache-set', rolle: 'orchestrator', an: true }, echt);
        return;
      }
      frage(
        t('frage.wacheOrchAus.text'),
        t('frage.wacheOrchAus.tun'),
        (grund, echtJa) => void werkzeug({ command: 'wache-set', rolle: 'orchestrator', an: false, grund }, echtJa),
        true,
      );
    }),
  });
  feld(g1, {
    ...texte('wacheWorkerAn'),
    wartet: true,
    steuer: haken('wacheWorkerAn', wkr.an, (an, echt) => {
      if (an) {
        void werkzeug({ command: 'wache-set', rolle: 'worker', an: true }, echt);
        return;
      }
      frage(
        t('frage.wacheWorkerAus.text'),
        t('frage.wacheWorkerAus.tun'),
        (grund, echtJa) => void werkzeug({ command: 'wache-set', rolle: 'worker', an: false, grund }, echtJa),
        true,
      );
    }),
  });
  feld(g1, {
    ...texte('wacheWorkerMahnenAb'),
    wartet: true,
    steuer: zahl('wacheWorkerMahnenAb', wkr.mahnenAb, 1, 99, '%', (n, echt) => {
      if (n <= wkr.mahnenAb) {
        void werkzeug({ command: 'wache-set', rolle: 'worker', mahnenAb: n }, echt);
        return;
      }
      frage(
        t('frage.mahnenHoch.worker', { wert: n }),
        t('frage.mahnenHoch.tun'),
        (grund, echtJa) => void werkzeug({ command: 'wache-set', rolle: 'worker', mahnenAb: n, grund }, echtJa),
        true,
      );
    }),
  });
  feld(g1, {
    ...texte('wacheOrchMahnenAb'),
    wartet: true,
    steuer: zahl('wacheOrchMahnenAb', orch.mahnenAb, 1, 99, '%', (n, echt) => {
      if (n <= orch.mahnenAb) {
        void werkzeug({ command: 'wache-set', rolle: 'orchestrator', mahnenAb: n }, echt);
        return;
      }
      frage(
        t('frage.mahnenHoch.orch', { wert: n }),
        t('frage.mahnenHoch.tun'),
        (grund, echtJa) => void werkzeug({ command: 'wache-set', rolle: 'orchestrator', mahnenAb: n, grund }, echtJa),
        true,
      );
    }),
  });
  feld(g1, {
    ...texte('wacheOrchEingreifen'),
    wartet: true,
    steuer: haken('wacheOrchEingreifen', orch.eingreifen, (an, echt) => {
      if (an) {
        void werkzeug({ command: 'wache-set', rolle: 'orchestrator', eingreifen: true }, echt);
        return;
      }
      frage(
        t('frage.eingreifenAus.text'),
        t('frage.eingreifenAus.tun'),
        (grund, echtJa) => void werkzeug({ command: 'wache-set', rolle: 'orchestrator', eingreifen: false, grund }, echtJa),
        true,
      );
    }),
  });
  feld(g1, {
    ...texte('wacheOrchNotbremseAb'),
    wartet: true,
    steuer: zahl('wacheOrchNotbremseAb', orch.notbremseAb ?? 80, 1, 99, '%', (n, echt) => {
      const alt = orch.notbremseAb ?? 80;
      if (n <= alt) {
        void werkzeug({ command: 'wache-set', rolle: 'orchestrator', notbremseAb: n }, echt);
        return;
      }
      frage(
        t('frage.notbremseHoch.text', { wert: n }),
        t('frage.notbremseHoch.tun'),
        (grund, echtJa) => void werkzeug({ command: 'wache-set', rolle: 'orchestrator', notbremseAb: n, grund }, echtJa),
        true,
      );
    }),
  });
  klartext(g1, t('satz.guardsWohnenAnderswo'));

  const g2 = gruppe(s, t('gruppe.aufsicht.stillstand'));
  feld(g2, {
    ...texte('stallMinutes'),
    schluessel: 'stallMinutes',
    steuer: zahl('stallMinutes', Number(d.settings.stallMinutes ?? 10), 1, 120, 'Minuten Stille',
      (n) => void setze('stallMinutes', n)),
  });
  feld(g2, {
    ...texte('guardMeldetWorkerStatus'),
    wartet: true,
    schluessel: 'guardMeldetWorkerStatus',
    steuer: haken('guardMeldetWorkerStatus', d.settings.guardMeldetWorkerStatus === true,
      (an) => void setze('guardMeldetWorkerStatus', an)),
  });

  // Benachrichtigungen. Die FORM dieses Blocks ist vorgegeben und wird von zwei
  // Seiten gelesen -- hier und vom Sendeweg. Deshalb schreibt jedes Feld den
  // GANZEN Block zurueck: ein halb geschriebener Block waere fuer den Leser auf
  // der anderen Seite ein anderer Vertrag.
  const g3 = gruppe(s, t('gruppe.aufsicht.meldungen'));
  const m = d.meldungen;
  const meldeSetzen = (aenderung: Partial<typeof m>): void => {
    void setze('meldungen', { ...m, ...aenderung });
  };
  feld(g3, {
    ...texte('meldungenAn'),
    wartet: true,
    schluessel: 'meldungen',
    // Wird der Schalter angelegt, waehrend weder Ereignisse noch Wege stehen
    // (die Vorgabe fuer beide ist LEER, Absicht -- siehe meldungen() in
    // main/einstellungen.ts), zeigte die Oberflaeche danach vier gehakte
    // Kaesten, ohne dass je etwas verschickt wuerde: der Sendeweg liest
    // dieselbe leere Liste. Deshalb schreibt EINMAL, beim Einschalten, der
    // volle Vorgabeblock auf die Platte -- kein Vorgabe-Ruckfall beim Lesen,
    // sondern ein einmaliges Schreiben beim Umlegen des Schalters. Wer die
    // Listen danach von Hand leert, meint es so: das Schreiben greift nur an
    // dieser einen Flanke.
    steuer: haken('meldungenAn', m.an, (an) => {
      if (an && m.ereignisse.length === 0 && m.wege.length === 0) {
        const vorgabe = d.vorgaben.meldungen as MeldeSicht;
        meldeSetzen({
          an,
          ereignisse: [...vorgabe.ereignisse],
          wege: [...vorgabe.wege],
          limitSchwelle: vorgabe.limitSchwelle,
        });
      } else {
        meldeSetzen({ an });
      }
    }),
  });
  const ereignisBox = el('div', 'zeilen');
  ereignisBox.id = 'meldeEreignisse';
  for (const ereignis of d.meldeEreignisse) {
    const gewaehlt = m.ereignisse.includes(ereignis);
    const z = el('div', gewaehlt ? 'zeile' : 'zeile abgeschaltet');
    z.dataset.meldung = ereignis;
    z.appendChild(haken(`meldung-${ereignis}`, gewaehlt, (an) => {
      meldeSetzen({
        ereignisse: an
          ? d.meldeEreignisse.filter((x) => x === ereignis || m.ereignisse.includes(x))
          : m.ereignisse.filter((x) => x !== ereignis),
      });
    }));
    z.appendChild(el('span', 'titel', t(`meldung.${ereignis}`)));
    ereignisBox.appendChild(z);
  }
  feld(g3, { ...texte('meldungenEreignisse'), wartet: true, breit: true, steuer: ereignisBox });

  const wegBox = el('div');
  for (const weg of d.meldeWege) {
    const marke = el('label', 'wegwahl');
    marke.appendChild(haken(`weg-${weg}`, m.wege.includes(weg), (an) => {
      meldeSetzen({
        wege: an
          ? d.meldeWege.filter((x) => x === weg || m.wege.includes(x))
          : m.wege.filter((x) => x !== weg),
      });
    }));
    marke.appendChild(el('span', undefined, t(`weg.${weg}`)));
    wegBox.appendChild(marke);
  }
  feld(g3, { ...texte('meldungenWege'), wartet: true, breit: true, steuer: wegBox });
  feld(g3, {
    ...texte('meldungenHandyUrl'),
    wartet: true,
    breit: true,
    steuer: textzeile('meldungenHandyUrl', m.handyUrl, t('platzhalter.handyUrl'),
      (w) => meldeSetzen({ handyUrl: w })),
  });
  feld(g3, {
    ...texte('meldungenTonDatei'),
    wartet: true,
    breit: true,
    steuer: textzeile('meldungenTonDatei', m.tonDatei, t('platzhalter.tonDatei'),
      (w) => meldeSetzen({ tonDatei: w })),
  });
  feld(g3, {
    ...texte('meldungenLimitSchwelle'),
    wartet: true,
    steuer: zahl('meldungenLimitSchwelle', m.limitSchwelle, 1, 99, '%',
      (n) => meldeSetzen({ limitSchwelle: n })),
  });
  const testBox = el('div');
  const testErgebnisEl = el('div');
  testErgebnisEl.id = 'meldungTestErgebnis';
  // ECHTER Versand -- anders als jeder andere Knopf auf dieser Seite loest
  // dieser Klick eine wirkliche Meldung aus (Systemhinweis, Ton, Webhook).
  // Ein Testhaken darf ihn nie ueber __awbEin.klick() antippen.
  testBox.appendChild(knopf(t('knopf.meldungTesten'), () => {
    testErgebnisEl.className = 'klartext';
    testErgebnisEl.textContent = t('meldungTesten.laeuft');
    void window.awbEinstellungen.meldungTesten().then((r) => {
      meldungTestErgebnisZeichnen(testErgebnisEl, r, d.meldeWege);
    });
  }));
  testBox.appendChild(testErgebnisEl);
  feld(g3, { ...texte('meldungTesten'), breit: true, steuer: testBox });
  return s;
}

// --- Seite 6: Aussehen ------------------------------------------------------

function seiteAussehen(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'aussehen';
  s.appendChild(el('h1', undefined, t('seite.aussehen.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.aussehen.unterzeile')));

  const g1 = gruppe(s, t('gruppe.aussehen.thema'));
  feld(g1, {
    ...texte('thema'),
    schluessel: 'thema',
    steuer: segmente(
      'thema',
      d.thema,
      [
        { wert: 'system', label: t('wort.thema.system') },
        { wert: 'hell', label: t('wort.thema.hell') },
        { wert: 'dunkel', label: t('wort.thema.dunkel') },
      ],
      (w) => void setze('thema', w),
    ),
  });
  const farbBox = el('div', 'farben');
  for (const zustand of ['laeuft', 'wartet', 'fertig', 'tot']) {
    const zelle = el('label', 'farbe');
    const i = el('input') as HTMLInputElement;
    i.type = 'color';
    i.id = `farbe-${zustand}`;
    i.value = d.zustandsfarben[zustand] ?? '#888888';
    i.addEventListener('change', () => {
      void setze('zustandsfarben', { ...d.zustandsfarben, [zustand]: i.value });
    });
    zelle.appendChild(i);
    zelle.appendChild(el('span', undefined, t(`zustand.${zustand}`)));
    farbBox.appendChild(zelle);
  }
  feld(g1, { ...texte('zustandsfarben'), schluessel: 'zustandsfarben', breit: true, steuer: farbBox });

  const g2 = gruppe(s, t('gruppe.aussehen.terminal'));
  feld(g2, {
    ...texte('terminalFontSize'),
    schluessel: 'terminalFontSize',
    steuer: zahl('terminalFontSize', Number(d.settings.terminalFontSize ?? 13), 8, 32, 'Punkt',
      (n) => void setze('terminalFontSize', n)),
  });
  feld(g2, {
    ...texte('terminalScrollLines'),
    schluessel: 'terminalScrollLines',
    steuer: zahl('terminalScrollLines', Number(d.settings.terminalScrollLines ?? 3), 1, 20, 'Zeilen',
      (n) => void setze('terminalScrollLines', n)),
  });

  const g3 = gruppe(s, t('gruppe.aussehen.panes'));
  feld(g3, {
    ...texte('minWorkerPaneWidth'),
    schluessel: 'minWorkerPaneWidth',
    steuer: zahl('minWorkerPaneWidth', Number(d.settings.minWorkerPaneWidth ?? 80), 20, 1000, 'Spalten',
      (n) => void setze('minWorkerPaneWidth', n)),
  });
  feld(g3, {
    ...texte('maxWorkerPanesPerTab'),
    wartet: true,
    schluessel: 'maxWorkerPanesPerTab',
    steuer: zahl('maxWorkerPanesPerTab', Number(d.settings.maxWorkerPanesPerTab ?? 6), 0, 64, 'Panes',
      (n) => void setze('maxWorkerPanesPerTab', n)),
  });
  feld(g3, {
    ...texte('workerLayout'),
    wartet: true,
    schluessel: 'workerLayout',
    steuer: segmente(
      'workerLayout',
      String(d.settings.workerLayout ?? 'split'),
      [
        { wert: 'split', label: t('wort.workerLayout.split') },
        { wert: 'window', label: t('wort.workerLayout.window') },
      ],
      (w) => void setze('workerLayout', w),
    ),
  });

  const g4 = gruppe(s, t('gruppe.aussehen.sprache'));
  const sprachBox = el('div');
  sprachBox.appendChild(segmente(
    'sprache',
    d.sprache,
    [
      { wert: 'de', label: t('wort.sprache.de') },
      { wert: 'en', label: t('wort.sprache.en') },
    ],
    (w) => void setze('sprache', w),
  ));
  if (!spracheHatTabelle()) sprachBox.appendChild(el('div', 'klartext', t('satz.spracheNochNichtDa')));
  feld(g4, { ...texte('sprache'), wartet: true, schluessel: 'sprache', breit: true, steuer: sprachBox });
  // ZWEI SCHALTER, EIN SCHLUESSEL (12.08.): Orchestrator und Worker lassen sich
  // getrennt einstellen, aber sie bleiben EINE Einstellung -- deshalb ein Feld
  // mit zwei Haken und nicht zwei Felder. Nur so behaelt die Zeile ihr
  // Rueckstell-Zeichen und ihren Eintrag in der Liste "was bei dir anders ist";
  // zwei Felder mit demselben Schluessel haetten beides doppelt gezeigt.
  const rollenBox = el('div', 'rollen');
  for (const rolle of ['orchestrator', 'worker'] as const) {
    const zelle = el('label', 'rolle');
    zelle.appendChild(haken(
      `chatAnsichtVorgabe-${rolle}`,
      d.chatAnsichtVorgabe[rolle] === true,
      (an) => void setze('chatAnsichtVorgabe', { ...d.chatAnsichtVorgabe, [rolle]: an }),
    ));
    zelle.appendChild(el('span', undefined, t(`wort.rolle.${rolle}`)));
    rollenBox.appendChild(zelle);
  }
  feld(g4, {
    ...texte('chatAnsichtVorgabe'),
    wartet: true,
    schluessel: 'chatAnsichtVorgabe',
    breit: true,
    steuer: rollenBox,
  });
  return s;
}

// --- Seite 7: Programm ------------------------------------------------------

/** Was von der Auslieferung abweicht -- die Grundlage von Liste und Sicherung. */
function abweichungen(d: Daten): string[] {
  return Object.keys(d.vorgaben)
    .filter((k) => d.settings[k] !== undefined && !gleichwie(d.settings[k], d.vorgaben[k]))
    .sort();
}

function seiteProgramm(d: Daten): HTMLElement {
  const s = el('section', 'seite');
  s.dataset.seite = 'programm';
  s.appendChild(el('h1', undefined, t('seite.programm.titel')));
  s.appendChild(el('p', 'unterzeile', t('seite.programm.unterzeile')));

  const g1 = gruppe(s, t('gruppe.programm.abweichungen'));
  const liste = abweichungen(d);
  const abTabelle = el('table');
  abTabelle.id = 'abweichungen';
  const abKopf = el('tr');
  for (const h of [t('spalte.einstellung'), t('spalte.beiDir'), t('spalte.auslieferung'), '']) {
    abKopf.appendChild(el('th', undefined, h));
  }
  abTabelle.appendChild(abKopf);
  if (liste.length === 0) {
    const r = el('tr');
    const c = el('td', 'wert', t('satz.keineAbweichung'));
    c.colSpan = 4;
    r.appendChild(c);
    abTabelle.appendChild(r);
  }
  for (const k of liste) {
    const r = el('tr');
    r.dataset.abweichung = k;
    r.appendChild(el('td', undefined, t(`bezeichnung.${k}`)));
    r.appendChild(el('td', 'wert', kurzWert(d.settings[k])));
    r.appendChild(el('td', 'wert', kurzWert(d.vorgaben[k])));
    const zelle = el('td');
    zelle.appendChild(knopf(t('wort.zuruecksetzen'), () => void setze(k, d.vorgaben[k])));
    r.appendChild(zelle);
    abTabelle.appendChild(r);
  }
  feld(g1, { ...texte('abweichungen'), breit: true, steuer: abTabelle });

  // Sichern, zuruecksetzen, uebertragen. Gesichert wird, was ABWEICHT, nicht
  // die ganze Datei: Vorgaben mitzunehmen hiesse, sie auf dem Zielrechner
  // festzuschreiben, und die naechste Auslieferung koennte sie nicht mehr
  // aendern. Eingesetzt wird ueber denselben Schreibweg wie jeder Haken --
  // Schluessel fuer Schluessel, mit derselben Pruefung durch `wb-state`.
  const g2 = gruppe(s, t('gruppe.programm.sicherung'));
  const sicherBox = el('div');
  const stand: Record<string, unknown> = {};
  for (const k of liste) stand[k] = d.settings[k];
  const text = el('textarea', 'sicherungsfeld') as HTMLTextAreaElement;
  text.id = 'sicherungsfeld';
  text.rows = 6;
  text.spellcheck = false;
  text.placeholder = t('platzhalter.sicherung');
  text.value = sicherungsText;
  text.addEventListener('input', () => { sicherungsText = text.value; });
  const reihe = el('div', 'anlegen');
  reihe.appendChild(knopf(t('wort.kopieren'), () => {
    if (liste.length === 0) {
      melde(t('satz.sicherungLeer'), 'fehler');
      return;
    }
    const roh = JSON.stringify(stand, null, 2);
    sicherungsText = roh;
    text.value = roh;
    void navigator.clipboard?.writeText(roh).then(
      () => melde(t('satz.sicherungKopiert', { zeichen: roh.length }), 'gut'),
      // Ohne Zwischenablage steht der Text trotzdem im Feld und laesst sich von
      // Hand nehmen -- das ist der Punkt der Sicherung, nicht der Knopf.
      () => melde(t('satz.sicherungKopiert', { zeichen: roh.length }), 'gut'),
    );
  }));
  reihe.appendChild(knopf(t('wort.einsetzen'), () => {
    const roh = text.value.trim();
    if (!roh) {
      melde(t('satz.sicherungKeinText'), 'fehler');
      return;
    }
    let geparst: unknown;
    try {
      geparst = JSON.parse(roh);
    } catch {
      melde(t('satz.sicherungKeinJson'), 'fehler');
      return;
    }
    if (!geparst || typeof geparst !== 'object' || Array.isArray(geparst)) {
      melde(t('satz.sicherungKeinJson'), 'fehler');
      return;
    }
    const eintraege = Object.entries(geparst as Record<string, unknown>);
    frage(
      t('frage.einsetzen.text', { anzahl: eintraege.length }),
      t('frage.einsetzen.tun'),
      () => {
        void (async () => {
          for (const [k, w] of eintraege) await setze(k, w);
          melde(t('satz.sicherungEingesetzt', { anzahl: eintraege.length }), 'gut');
        })();
      },
    );
  }));
  reihe.appendChild(knopf(t('wort.allesZurueck'), () => {
    if (liste.length === 0) {
      melde(t('satz.keineAbweichung'), 'gut');
      return;
    }
    frage(
      t('frage.allesZurueck.text', { anzahl: liste.length }),
      t('frage.allesZurueck.tun'),
      () => {
        void (async () => {
          for (const k of liste) await setze(k, d.vorgaben[k]);
        })();
      },
    );
  }, true));
  sicherBox.append(text, reihe);
  feld(g2, { ...texte('sicherung'), breit: true, steuer: sicherBox });

  const g3 = gruppe(s, t('gruppe.programm.dateien'));
  const pt = el('table');
  pt.id = 'pfadTabelle';
  for (const p of d.pfade) {
    const r = el('tr');
    r.appendChild(el('td', undefined, p.label));
    r.appendChild(el('td', 'wert', p.wert));
    pt.appendChild(r);
  }
  for (const p of d.protokolle) {
    const r = el('tr');
    r.appendChild(el('td', undefined, `Protokoll: ${p.label}`));
    r.appendChild(el('td', 'wert', p.path));
    pt.appendChild(r);
  }
  feld(g3, { ...texte('pfade'), breit: true, steuer: pt });

  // Der Knopf zum Zahnrad-Weg: derselbe Kanal wie das Zahnrad im Hauptfenster
  // fuer DIESES Fenster (renderer.ts) -- `isTrusted` entscheidet zwischen
  // 'erststart-zeigen' (echter Klick, das Fenster erscheint wirklich) und
  // 'erststart-bauen' (Skript-Klick, nur gebaut). `knopf()` reicht `isTrusted`
  // schon durch, hier wird es nur an die Bruecke weitergegeben.
  const g4 = gruppe(s, t('gruppe.programm.erststart'));
  feld(g4, {
    ...texte('erststartZeigen'),
    steuer: knopf(t('wort.erneutZeigen'), (echt) => window.awbEinstellungen.erststartZeigen(echt)),
  });
  return s;
}

const SEITEN: { name: string; bau: (d: Daten) => HTMLElement }[] = [
  { name: 'sitzung', bau: seiteSitzung },
  { name: 'erlaubnisse', bau: seiteErlaubnisse },
  { name: 'harnesses', bau: seiteHarnesses },
  { name: 'maschinen', bau: seiteMaschinen },
  { name: 'aufsicht', bau: seiteAufsicht },
  { name: 'aussehen', bau: seiteAussehen },
  { name: 'programm', bau: seiteProgramm },
];

/**
 * Hell und dunkel wirken HIER sofort -- das Fenster setzt sein eigenes Merkmal
 * und die Farben der Zustaende als CSS-Variablen. Die uebrigen Fenster ziehen
 * nach, sobald ihre Farben aus derselben Quelle kommen; bis dahin ist das die
 * einzige Stelle, an der die Wahl etwas tut, und genau das sagt ihr Infotext.
 */
function themaAnwenden(d: Daten): void {
  document.documentElement.dataset.thema = d.thema;
  for (const [zustand, farbe] of Object.entries(d.zustandsfarben)) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(farbe)) {
      document.documentElement.style.setProperty(`--zustand-${zustand}`, farbe);
    }
  }
}

/** Wie oft die sieben Seiten seit dem Fensterstart wirklich neu gebaut wurden -- die Zahl, an der die Sparsamkeit messbar ist. */
let zeichnungen = 0;

function zeichne(): void {
  if (!daten) return;
  zeichnungen += 1;
  infoZu();
  setzeSprache(daten.sprache);
  // `<html lang>` und der Dokumenttitel stehen sonst statisch Deutsch im Markup -- fuer den
  // Fenstertitel der Betriebssystemleiste ist das ohne Wirkung (der kommt aus dem `title:` von
  // BrowserWindow), aber wer die Seite in einem Browser oder Werkzeug oeffnet, sieht sonst die
  // falsche Sprache behauptet.
  document.documentElement.lang = sprache();
  document.title = t('fenster.titel');
  themaAnwenden(daten);
  gezeichneteFelder = [];
  // Die Kopfzeile steht im Markup und bleibt stehen; die Knoepfe entstehen bei
  // JEDEM Zeichnen neu, weil ihre Beschriftung an der Sprache haengt.
  for (const alt of seitenlisteEl.querySelectorAll('button')) alt.remove();
  for (const s of SEITEN) {
    const b = el('button') as HTMLButtonElement;
    b.type = 'button';
    b.dataset.seite = s.name;
    b.appendChild(document.createTextNode(t(`seite.${s.name}.titel`)));
    b.appendChild(el('span', 'zweitzeile', t(`seite.${s.name}.wofuer`)));
    b.addEventListener('click', () => waehle(s.name));
    b.classList.toggle('gewaehlt', s.name === aktuelleSeite);
    seitenlisteEl.appendChild(b);
  }
  stapelEl.textContent = '';
  for (const s of SEITEN) {
    const seite = s.bau(daten);
    if (s.name === aktuelleSeite) seite.classList.add('offen');
    stapelEl.appendChild(seite);
  }
}

/**
 * Seitenwechsel ohne Neubau (Befund 9, 15.08.): Alle sieben Seiten stehen
 * bereits im Dokument, sichtbar ist die mit der Klasse `offen`. Bis heute rief
 * diese Funktion `zeichne()` und baute damit fuer einen blossen Blaetterschritt
 * alle sieben Seiten neu -- samt jedem Aufklappmenue darin.
 */
function waehle(name: string): void {
  if (!SEITEN.some((s) => s.name === name)) return;
  aktuelleSeite = name;
  if (!stapelEl.children.length) {
    // Vor dem ersten Zeichnen gibt es nichts umzuschalten; `aktuelleSeite`
    // steht, den Rest erledigt der erste Aufbau.
    zeichne();
    stapelEl.scrollTop = 0;
    return;
  }
  infoZu();
  for (const b of seitenlisteEl.querySelectorAll('button')) {
    b.classList.toggle('gewaehlt', b.dataset.seite === name);
  }
  for (const seite of stapelEl.children) {
    seite.classList.toggle('offen', (seite as HTMLElement).dataset.seite === name);
  }
  stapelEl.scrollTop = 0;
}

// --- Anlauf -----------------------------------------------------------------

window.__awbEin = {
  seiten: () => SEITEN.map((s) => s.name),
  offen: () => aktuelleSeite,
  zeige: (name: string) => {
    if (!SEITEN.some((s) => s.name === name)) return false;
    waehle(name);
    return true;
  },
  text: () => stapelEl.innerText,
  status: () => statusEl.textContent ?? '',
  klick: (auswahl: string) => {
    const e = document.querySelector<HTMLElement>(auswahl);
    if (!e) return false;
    e.click();
    return true;
  },
  // Lesen statt klicken. Ohne diesen Haken liesse sich "der Haken steht auf
  // aus" nur pruefen, indem man ihn drueckt -- und damit umlegt.
  zustand: (auswahl: string) => {
    const e = document.querySelector<HTMLElement>(auswahl);
    if (!e) return { da: false, gehakt: false, wert: '', text: '' };
    const i = e as HTMLInputElement;
    return {
      da: true,
      gehakt: i.checked === true,
      wert: typeof i.value === 'string' ? i.value : '',
      text: (e.innerText ?? '').replace(/\s+/g, ' ').trim(),
      // Haengt nicht am gewaehlten Element, kommt aber ueber diesen einen
      // Lese-Weg nach draussen (main.ts reicht die Antwort unveraendert
      // weiter): wie oft die sieben Seiten seit dem Start neu gebaut wurden.
      // Ein Aufklappmenue kann nur zuschnappen, wenn neu gebaut wird -- diese
      // Zahl ist deshalb das Mass fuer den Befund vom 15.08.
      zeichnungen,
    };
  },
  modelle: () => [...document.querySelectorAll<HTMLElement>('.modelleintrag')].map((b) => ({
    id: b.dataset.modell ?? '',
    text: b.innerText.replace(/\s+/g, ' ').trim(),
    gewaehlt: b.classList.contains('gewaehlt'),
  })),
  // Nicht "steht die Klasse dran", sondern: ist der Kasten wirklich zu sehen.
  // Ein Infozeichen, dessen Text hinter display:none liegt, hat keine Hoehe.
  info: () => ({
    feld: offenesInfo,
    text: infotextEl.textContent ?? '',
    sichtbar: getComputedStyle(infotextEl).display !== 'none' && infotextEl.getBoundingClientRect().height > 0,
    hoehe: Math.round(infotextEl.getBoundingClientRect().height),
  }),
  felder: () => gezeichneteFelder.map((f) => ({ ...f })),
};

/**
 * Der Stand, der gerade auf dem Bildschirm steht -- als Text, zum Vergleichen.
 *
 * Der Dateiwaechter des Hauptprozesses (main.ts, 300 ms entprellt) schickt bei
 * JEDEM Schreibvorgang an der Einstellungs-, Modell- oder Sessiondatei den
 * ganzen Datenstand herueber, auch wenn sich nichts geaendert hat -- und jede
 * dieser Meldungen baute bis zum 16.08. alle sieben Seiten neu. Wer dabei ein
 * Aufklappmenue offen hatte, sah es zuschnappen. Ist der Stand derselbe, wird
 * jetzt nicht gezeichnet; eine echte Aenderung kommt weiterhin sofort an.
 */
let gezeichneterStand = '';

window.awbEinstellungen.onDaten((d) => {
  const stand = JSON.stringify(d);
  if (stand === gezeichneterStand) return;
  gezeichneterStand = stand;
  daten = d;
  zeichne();
});

void (async () => {
  daten = await window.awbEinstellungen.daten();
  gezeichneterStand = JSON.stringify(daten);
  zeichne();
  window.awbEinstellungen.bereit();
  void schluesselStatusLaden();
})();

// Macht diese Datei zu einem Modul -- ohne das gilt sie als Skript, und die
// `declare global`-Erweiterung oben waere unzulaessig.
export {};
