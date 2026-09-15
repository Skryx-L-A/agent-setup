// DIE MASCHINENKARTEN UND DIE FUSSZEILE DER LINKEN LEISTE: was ueber ALLE
// Projekte gilt.
//
// Maschinen mit ihrer Erreichbarkeit, der Pruefstand je Maschine (V12) und der
// Verbrauch (V13). Vom 03.09. bis zum 05.09.2026 stand das als Statusleiste
// quer unten; Wort des Nutzers am 05.09. („Maschinen prominenter", „Statusleiste
// nicht unten") hat es zurueck in die linke Leiste gebracht -- die Maschinen
// als je eine Karte ueber der Fusszeile, dauerhaft sichtbar und ohne Klick,
// der Rest als Fusszeile darunter.
//
// Diese Datei ZEICHNET nur, was der Hauptprozess schon fertig ausgewertet hat
// (ampel.ts, budget.ts, remote.ts) -- hier entsteht keine zweite Bewertung.
// Und sie erfindet nichts: was die Bruecke nicht liefert, steht nicht da. Die
// Auslastung einer Maschine zum Beispiel liefert sie heute nicht, also nennt
// weder die Karte noch ihr Aufklappfeld sie.
import './fuss-status.css';
import { t } from './texte';

interface AmpelBefund { quelle: string; vorhanden: boolean; rot: boolean; ueberfaellig: boolean; ueberholt: boolean; ageDays: number; text: string }
interface AmpelStand { machine: string; befunde: AmpelBefund[]; farbe: 'rot' | 'gelb' | 'gruen' | 'unbekannt' }
interface BudgetStand {
  ok: boolean;
  heuteTokens: number;
  heuteStunden: number;
  hochrechnung24h: number;
  text: string;
  /**
   * Der Wochenstand, wie ihn main/budget.ts fuellt: verbraucht und erlaubt in
   * Prozent, beide -1, wenn `wb-budget` keinen Ruecksetzpunkt kennt. Optional,
   * damit ein aelterer Hauptprozess das Fenster nicht bricht -- dann fehlt die
   * Anzeige, statt eine Null zu behaupten.
   */
  wocheVerbraucht?: number;
  wocheErlaubt?: number;
}

/**
 * Eine Maschine, wie der Hauptprozess sie kennt (main.ts, `awb:model`).
 * `erreichbar: null` heisst NICHT „nicht erreichbar", sondern „noch nicht
 * nachgesehen" -- die eigene Maschine wird nie abgefragt, und eine fremde erst
 * nach dem ersten Durchgang des Abrufs. Beides als `false` zu zeichnen waere
 * eine Behauptung ueber etwas, das niemand gemessen hat.
 */
export interface MaschinenStand {
  name: string;
  eigen: boolean;
  erreichbar: boolean | null;
  /** Wie alt die letzte Antwort ist, in Sekunden. -1 = nie geantwortet. */
  alter: number;
  /** Warum sie nicht geantwortet hat -- leer, wenn sie es tat. */
  fehler: string;
  /** Wieviele Sitzungen dieses Programm auf ihr fuehrt. */
  sitzungen: number;
  /** Wieviele ihrer Worker gerade laufen. */
  worker: number;
  /**
   * Pausiert (05.09.2026): sie steht eingetragen, wird aber nicht abgerufen.
   * Das ist etwas ANDERES als `erreichbar: false` -- eines ist gewollt, das
   * andere ist ein Ausfall, und beides gleich zu zeichnen versteckt den
   * Ausfall. Optional, damit ein aelterer Hauptprozess das Fenster nicht
   * bricht: fehlt das Feld, ist nichts pausiert.
   */
  pausiert?: boolean;
}

const AMPELKLASSE: Record<AmpelStand['farbe'], string> = {
  rot: 'aus',
  gelb: 'will',
  gruen: 'laeuft',
  unbekannt: 'ruhig',
};

function kompakt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function alterKurz(sekunden: number): string {
  if (sekunden < 0) return t('maschine.nieGeantwortet');
  if (sekunden < 60) return t('zeit.geradeEben');
  const min = Math.round(sekunden / 60);
  if (min < 60) return t('zeit.minuten', { n: min });
  return t('zeit.stundenMinuten', { std: Math.floor(min / 60), min: min % 60 });
}

/**
 * WELCHES AUFKLAPPFELD OFFEN IST -- als Name der Maschine, nicht als Verweis
 * auf ein Element (05.09.2026).
 *
 * `zeichneStatuszeile()` baut die ganze Leiste bei JEDEM Modelltakt neu, also
 * alle zwei Sekunden. Bis heute lag der Offen-Zustand allein im `hidden` des
 * Elements, und damit ging das Feld beim naechsten Takt von selbst wieder zu:
 * gemessen am laufenden Fenster, keine Vermutung. Solange darin nur eine
 * Auskunft stand, fiel das kaum auf; mit einem Schalter darin waere es ein
 * Feld, das sich unter der Hand schliesst. Der Name ueberlebt den Neubau, das
 * Element nicht.
 */
let offenesFeld = '';

let notizUhr: number | undefined;
function kurzHinweis(text: string): void {
  const el = document.getElementById('notiz');
  if (!el) return;
  if (notizUhr !== undefined) clearTimeout(notizUhr);
  el.textContent = text;
  el.classList.toggle('sichtbar', !!text);
  if (text) {
    notizUhr = setTimeout(() => {
      el.classList.remove('sichtbar');
      el.textContent = '';
    }, 4000) as unknown as number;
  }
}

export function initFussStatus(): HTMLDivElement | null {
  const fuss = document.getElementById('fuss');
  if (!fuss) return null;
  const el = document.createElement('div');
  el.id = 'statuszeile';
  fuss.appendChild(el);
  return el;
}

/**
 * Ein Aufklappfeld an einem Maschinennamen. Darin steht, was die Bruecke ueber
 * DIESE Maschine liefert -- Erreichbarkeit, das Alter der letzten Antwort, der
 * Grund einer ausgebliebenen, wieviele Sitzungen und Worker dieses Programm auf
 * ihr fuehrt und der Pruefstand. Mehr gibt es heute nicht; die Auslastung, die
 * der Auftrag in seiner Tabelle nennt, liefert die Bruecke NICHT, und eine
 * erfundene Zahl waere schlimmer als eine fehlende.
 */
function maschinenFeld(m: MaschinenStand, ampel: AmpelStand | undefined): HTMLDivElement {
  const feld = document.createElement('div');
  feld.className = 'masch-feld';
  feld.hidden = true;
  const kopf = document.createElement('div');
  kopf.className = 'kopf';
  kopf.textContent = m.name;
  feld.appendChild(kopf);
  const liste = document.createElement('dl');
  const paar = (was: string, wert: string): void => {
    const dt = document.createElement('dt');
    dt.textContent = was;
    const dd = document.createElement('dd');
    dd.textContent = wert;
    liste.append(dt, dd);
  };
  // DREI ZUSTAENDE, DREI WOERTER. „pausiert" steht hier an der Stelle, an der
  // sonst ja/nein steht, und ist ausdruecklich NICHT „nein": bei einer
  // pausierten Maschine hat niemand nachgesehen, sie hat also auch nicht
  // versagt.
  paar(t('maschine.erreichbar'), m.eigen
    ? t('maschine.diese')
    : m.pausiert ? t('maschine.pausiert')
      : m.erreichbar === null ? t('maschine.unbekannt')
        : m.erreichbar ? t('maschine.ja') : t('maschine.nein'));
  // Was ueber eine pausierte Maschine NICHT gemessen wurde, steht auch nicht
  // da: „noch nie geantwortet" waere hier ein Vorwurf an eine Maschine, die
  // gar nicht gefragt wurde.
  if (!m.eigen && !m.pausiert) paar(t('maschine.letzteAntwort'), alterKurz(m.alter));
  if (m.fehler && !m.pausiert) paar(t('maschine.grund'), m.fehler);
  paar(t('maschine.sitzungen'), String(m.sitzungen));
  paar(t('maschine.worker'), String(m.worker));
  if (ampel) paar(t('maschine.pruefstand'), ampel.befunde.map((b) => b.text).join(' · ') || t('maschine.unbekannt'));
  feld.appendChild(liste);
  // DER SCHALTER (05.09.2026). Er steht hier, weil hier die Maschine
  // angesehen wird, wenn sie stoert -- und er schreibt dieselbe Einstellung,
  // die die Seite „Maschinen" schreibt (`remoteMachinesPausiert`), ueber
  // denselben Weg. Die eigene Maschine bekommt keinen: dieses Programm laeuft
  // auf ihr, es kann sie nicht ungesehen lassen.
  if (!m.eigen) {
    const marke = document.createElement('label');
    marke.className = 'masch-schalter';
    const kasten = document.createElement('input');
    kasten.type = 'checkbox';
    kasten.checked = !m.pausiert;
    kasten.dataset.maschine = m.name;
    kasten.addEventListener('change', () => {
      window.awbBridge.bedienung('maschine-laden', { maschine: m.name, laden: kasten.checked });
    });
    const wort = document.createElement('span');
    wort.textContent = t('maschine.laden');
    marke.append(kasten, wort);
    feld.appendChild(marke);
    // Was NICHT passiert: die Sitzungen drueben laufen weiter, pausiert ist
    // nur der Blick dieser Werkbank darauf. Derselbe Satz wie auf der Seite
    // „Maschinen" -- eine Wirkung, ein Wortlaut.
    const wirkung = document.createElement('div');
    wirkung.className = 'masch-wirkung';
    wirkung.textContent = t('maschine.ladenWirkung');
    feld.appendChild(wirkung);
  }
  return feld;
}

/**
 * Die Maschinenkarten (in `#maschinen`) und die Fusszeile (in `el`, dem
 * Kind von `#fuss`) zeichnen. `maschinen` ist die Liste aus dem Modell; ist
 * sie leer (ein aelterer Hauptprozess), bleibt die Auskunft bei dem, was die
 * Ampel hergibt -- eine Karte weniger, aber keine falsche.
 */
/**
 * DER WOCHENSTAND (03.09.2026, Prueferbefund 9). Der Entwurf zeigt ihn rechts
 * neben dem Tagesverbrauch: ein schmaler Balken, wieviel Prozent des
 * Wochenkontingents weg sind, und daneben, wieviel an einem gleichmaessig
 * aufgeteilten Fenster bis heute Abend weg sein duerfte.
 *
 * Beide Zahlen kommen ueber den bestehenden Weg -- `wb-budget --json` liefert
 * `seven_day_pct` und `seven_day_resets_at`, main/budget.ts rechnet daraus mit
 * derselben Funktion, die auch das Verbrauchsfenster benutzt. Kein neuer Kanal.
 *
 * FEHLT DER STAND, FEHLT DIE ANZEIGE. Ohne Ruecksetzpunkt laesst sich nicht
 * sagen, welcher Tag des Fensters heute ist, und eine geratene Grenze waere
 * schlimmer als keine.
 */
function wochenStueck(budget: BudgetStand): HTMLElement {
  const stueck = document.createElement('div');
  stueck.className = 'sz-stueck sz-woche';
  const verbraucht = budget.wocheVerbraucht ?? -1;
  const erlaubt = budget.wocheErlaubt ?? -1;
  if (verbraucht < 0 || erlaubt < 0) {
    stueck.hidden = true;
    return stueck;
  }
  const wort = document.createElement('span');
  wort.textContent = t('fuss.woche', { prozent: Math.round(verbraucht) });
  const balken = document.createElement('div');
  balken.className = 'minibalken';
  const fuellung = document.createElement('i');
  fuellung.style.width = `${Math.max(0, Math.min(100, verbraucht))}%`;
  // Ueber der Grenze faerbt der Balken um: dieselbe Wartefarbe wie ueberall,
  // wo etwas Aufmerksamkeit will.
  if (verbraucht > erlaubt) fuellung.classList.add('drueber');
  balken.appendChild(fuellung);
  const grenze = document.createElement('span');
  grenze.className = 'sz-erlaubt';
  grenze.textContent = t('fuss.erlaubt', { erlaubt: Math.round(erlaubt) });
  stueck.append(wort, balken, grenze);
  stueck.title = t('fuss.woche.tipp', {
    prozent: Math.round(verbraucht), erlaubt: Math.round(erlaubt),
  });
  stueck.addEventListener('click', (ereignis) => {
    window.awbBridge.bedienung(ereignis.isTrusted ? 'verbrauch-zeigen' : 'verbrauch-bauen', null);
  });
  return stueck;
}

export function zeichneStatuszeile(
  el: HTMLDivElement,
  ampel: AmpelStand[],
  budget: BudgetStand | null,
  maschinen: MaschinenStand[],
  eigeneMaschine: string,
): void {
  el.replaceChildren();
  const ampelJe = new Map(ampel.map((a) => [a.machine, a]));
  const gezeigt: MaschinenStand[] = maschinen.length
    ? maschinen
    : ampel.map((a) => ({
        name: a.machine, eigen: a.machine === eigeneMaschine, erreichbar: null,
        alter: -1, fehler: '', sitzungen: 0, worker: 0,
      } satisfies MaschinenStand));
  // Eine Maschine, die aus der Liste faellt, nimmt ihr offenes Feld mit --
  // sonst spraenge es auf, sobald sie wiederkaeme.
  if (offenesFeld && !gezeigt.some((m) => m.name === offenesFeld)) offenesFeld = '';

  const karten = document.getElementById('maschinen');
  karten?.replaceChildren();
  for (const m of gezeigt) {
    const stueck = document.createElement('div');
    stueck.className = m.pausiert ? 'masch pausiert' : 'masch';
    const kopf = document.createElement('div');
    kopf.className = 'masch-kopf';
    const punkt = document.createElement('span');
    // Die Form traegt mit: gefuellt heisst erreichbar, ein Ring heisst „noch
    // nicht nachgesehen", hohl und rot heisst „hat nicht geantwortet", und
    // gedaempft gefuellt heisst „pausiert" -- gewollt abgestellt, nicht
    // ausgefallen. Die Zeile darunter sagt es noch einmal, damit die Form
    // allein die Last nicht traegt.
    punkt.className = `punkt ${m.pausiert ? 'pausiert'
      : m.eigen || m.erreichbar === true ? 'laeuft'
        : m.erreichbar === null ? 'ruhig' : 'aus'}`;
    kopf.appendChild(punkt);

    const name = document.createElement('button');
    name.className = 'masch-name';
    name.textContent = m.name;
    name.title = t('maschine.karte.tipp');
    const feld = maschinenFeld(m, ampelJe.get(m.name));
    feld.hidden = offenesFeld !== m.name;
    name.addEventListener('click', () => {
      // Immer nur EINES offen: zwei Felder uebereinander sagen weniger als eins.
      offenesFeld = feld.hidden ? m.name : '';
      for (const f of (karten ?? el).querySelectorAll<HTMLElement>('.masch-feld')) f.hidden = true;
      feld.hidden = offenesFeld !== m.name;
    });
    kopf.appendChild(name);

    // Ihr eigenes Wort, gedaempft hinter dem Namen. Ohne es waere „pausiert"
    // nur eine Farbe, und eine Farbe allein kann man mit „ausgefallen"
    // verwechseln -- genau die Verwechslung, die einen Ausfall versteckt.
    if (m.pausiert) {
      const wort = document.createElement('span');
      wort.className = 'masch-wort';
      wort.textContent = t('maschine.pausiert');
      kopf.appendChild(wort);
    }

    // Der Pruefstand bleibt als Marke daneben: rot heisst, dass drueben etwas
    // im Argen liegt, und das soll man sehen, ohne zu klicken.
    //
    // EIN VIERECK, KEIN KUERZEL. Bis zum Neubau standen hier zwei Buchstaben.
    // Die waren erfunden -- „PS" heisst nirgends etwas --, und sie standen
    // ausserdem unmittelbar neben dem runden Zustandspunkt der Maschine, wo
    // zwei verschiedene Farben in derselben Form leicht als dieselbe Aussage
    // gelesen werden. Das Viereck traegt die Unterscheidung in der FORM: rund
    // heisst „Maschine", eckig heisst „Pruefstand". Was er sagt, steht im
    // Hilfeschildchen und im Aufklappfeld darunter, im Wortlaut.
    const a = ampelJe.get(m.name);
    if (a) {
      const marke = document.createElement('span');
      marke.className = `sz-marke ${AMPELKLASSE[a.farbe]}`;
      marke.title = t('fuss.pruefstand', { maschine: a.machine, befunde: a.befunde.map((b) => b.text).join(' | ') });
      kopf.appendChild(marke);
    }
    stueck.appendChild(kopf);

    // DIE KURZZEILE -- das, was alice ohne Klick sehen will (05.09.2026):
    // Erreichbarkeit im Wort, dann Sitzungen und laufende Worker. Genau die
    // Felder, die die Bruecke fuellt (main.ts, `maschinenStand`); eine
    // Auslastung liefert sie nicht, also steht hier auch keine.
    const kurz = document.createElement('div');
    kurz.className = 'masch-kurz';
    // „hier" statt „diese Maschine": das kuerzere Wort, damit die Zeile bei
    // 232 Bildpunkten nicht mitten in „2 Worker" umbricht. Im Aufklappfeld
    // steht weiter der volle Ausdruck.
    const lage = m.eigen ? t('maschine.hier')
      : m.pausiert ? t('maschine.pausiert')
        : m.erreichbar === null ? t('maschine.unbekannt')
          : m.erreichbar ? t('maschine.erreichbarWort') : t('maschine.nichtErreichbarWort');
    kurz.textContent = `${lage} · ${t('maschine.kurz', { sitzungen: m.sitzungen, worker: m.worker })}`;
    stueck.appendChild(kurz);
    stueck.appendChild(feld);
    (karten ?? el).appendChild(stueck);
  }

  if (budget) {
    const stueck = document.createElement('div');
    stueck.className = 'sz-stueck sz-budget';
    const wort = document.createElement('span');
    wort.textContent = budget.ok ? t('fuss.heute', { tokens: kompakt(budget.heuteTokens) }) : t('fuss.budget.kurz');
    stueck.appendChild(wort);
    stueck.title = budget.ok ? t('fuss.budget', { text: budget.text }) : t('fuss.budget.fehlt');
    // DER KLICK OEFFNET DIE VERBRAUCHSSEITE. Unterschieden wird an `isTrusted`,
    // nicht an einem Namen -- dieselbe Auflage wie am Zahnrad und am Plus: ein
    // echter Klick schickt 'verbrauch-zeigen' und macht das Fenster sichtbar,
    // ein programmatischer schickt 'verbrauch-bauen' und kann es nur bauen
    // lassen.
    stueck.addEventListener('click', (ereignis) => {
      window.awbBridge.bedienung(ereignis.isTrusted ? 'verbrauch-zeigen' : 'verbrauch-bauen', null);
    });
    el.appendChild(stueck);
    el.appendChild(wochenStueck(budget));
  } else {
    // Ohne Budgetdaten steht hier nichts -- aber der Klick auf die Leiste soll
    // trotzdem etwas sagen, statt stumm zu bleiben.
    const stueck = document.createElement('div');
    stueck.className = 'sz-stueck sz-budget';
    stueck.textContent = t('fuss.budget.kurz');
    stueck.title = t('fuss.budget.fehlt');
    stueck.addEventListener('click', () => kurzHinweis(t('fuss.budget.fehlt')));
    el.appendChild(stueck);
  }
}
