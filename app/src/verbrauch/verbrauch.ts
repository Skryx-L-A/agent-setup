// Die Oberflaeche der Verbrauchsseite: EINE Seite, die gerollt wird.
//
// WAS HIER GESCHIEHT UND WAS NICHT. Gezeichnet wird hier, gerechnet in rechnen.ts, gemessen in
// `wb-budget --json`. Diese Datei liest keine Datei, ruft kein Programm und bildet keine Summe,
// die rechnen.ts nicht bildet -- sie ordnet an, faerbt und beschriftet.
//
// DREI AUFLAGEN AUS DER MESSUNG VOM 11.08. haengen sichtbar an dieser Datei, und keine davon ist
// eine Geschmacksfrage:
//
//   1. KOSTEN NIE ALS EINE ZAHL. Es gibt zwei Groessen mit verschiedenen Nennern -- einen
//      Dollarbetrag (und auch der ist bei den Abo-Zugaengen nur ein API-Aequivalent, das NIE
//      abgebucht wurde) und einen Kontingentanteil. Sie stehen getrennt, und der Satz „nie
//      abgebucht" steht AN der Zahl, nicht in einer Fussnote.
//   2. CACHE-LESEN BEKOMMT SEINE EIGENE ACHSE. Im 7-Tage-Fenster stehen 14,4 Milliarden
//      Cache-Lesetoken gegen 258 Millionen aller uebrigen. Auf einer gemeinsamen linearen Achse
//      bliebe vom Rest ein Strich. Ob getrennt gezeichnet wird, entscheidet `cacheAchse` am
//      gemessenen Verhaeltnis, nicht ein Schalter.
//   3. JEDE GENAEHERTE RATE IST ALS NAEHERUNG BEZEICHNET. Nur copilot/copilot-cloud tragen eine
//      echte Generierungsrate; alles andere ist Wanduhr mit Denkzeit und Werkzeugpausen darin.
//      Die Marke steht in der Zeile, der Grund im Titel derselben Zeile.
//
// Und: WAS NICHT MESSBAR IST, STEHT TROTZDEM DA. Sieben Harnesses hinterlassen auf dieser
// Maschine keine Spur, drei weitere eine unbrauchbare. Sie bekommen einen eigenen Abschnitt mit
// Grund -- eine Seite, die fuer claude Zahlen zeigt und fuer alles andere schweigt, laesst den
// Betrachter raten, ob nichts verbraucht wurde oder nichts gemessen werden kann.
import {
  balken,
  cacheAchse,
  filterModelle,
  filterSitzungen,
  filterTage,
  gemeinsamerVorspann,
  harnessAuswahlliste,
  kompakt,
  kostenBild,
  ohneCacheRead,
  leereAuswahl,
  limitVerlauf,
  linienPfad,
  modellAuswahlliste,
  prozent,
  sitzungenTeilweise,
  summiere,
  tagesreihe,
  umlaute,
  usd,
  vergleicheHarnesses,
  vergleicheWerte,
  vorherigerZeitraum,
  wochenbudget,
  zahl,
  zeitpunkt,
  type Auswahl,
  type ModellZeile,
  type SitzungZeile,
  type Verbrauch,
  type VerbrauchsAntwort,
  type VergleichsZeile,
  type Werte,
} from './rechnen';
import { setzeSprache, sprache, t } from './texte';

declare global {
  interface Window {
    awbVerbrauch: {
      daten(frage: { von?: string; bis?: string; tage?: number }): Promise<VerbrauchsAntwort>;
      sprache(): Promise<string>;
      bereit(): void;
      /** Farben durchreichen (11.08.): einmal alles, aus main/thema.ts. */
      thema(): Promise<ThemaPayload>;
      onThema(fn: (p: ThemaPayload) => void): void;
    };
    /** Testhaken: was steht gerade da. Nur Lesen und Klicken, nie Zeigen. */
    __awbVerbrauch: {
      text(): string;
      status(): string;
      klick(auswahl: string): boolean;
      zustand(auswahl: string): { da: boolean; gesperrt: boolean; wert: string; text: string };
      abschnitte(): string[];
    };
  }
}

/** Farben durchreichen (11.08.): dieselbe Form wie in main/thema.ts. */
interface ThemaPayload {
  thema: string;
  wirksam: 'hell' | 'dunkel';
  zustandsfarben: Record<string, string>;
  zustandsfarbenLesbar: Record<string, string>;
  zustandsfarbenTinte: Record<string, string>;
  /** Bereitgestellt fuer den Worker 'farbsystem' -- siehe main/thema.ts. Dieses Fenster liest sie nicht. */
  systemAkzentfarbe: string;
}

const NS = 'http://www.w3.org/2000/svg';
/** Die vier Tokenarten mit ihrer Farbe -- dieselbe in Kachel, Balken und Legende. */
const ARTFARBE: Record<string, string> = {
  input: 'var(--ein)',
  output: 'var(--raus)',
  cache_write: 'var(--cw)',
  cache_read: 'var(--cr)',
};

const inhaltEl = document.getElementById('inhalt') as HTMLElement;
const standEl = document.getElementById('stand') as HTMLElement;
const statusEl = document.getElementById('statuszeile') as HTMLElement;
const zeitraumEl = document.getElementById('zeitraum') as HTMLElement;
const filterHarnessEl = document.getElementById('filter-harness') as HTMLElement;
const filterModellEl = document.getElementById('filter-modell') as HTMLElement;

/** Kopfzeile, die keine zweite Wahl hat: einmal je Sprachwechsel, vor dem ersten Zeichnen. */
function kopfzeileBeschriften(): void {
  document.documentElement.lang = sprache();
  document.title = t('fenster.titel');
  (document.getElementById('titel') as HTMLElement).textContent = t('kopf.titel');
  (document.getElementById('unterzeile') as HTMLElement).textContent = t('kopf.unterzeile');
}

const ZEITRAEUME = [1, 2, 7, 14, 30];
let tage = 7;
let daten: Verbrauch | null = null;
let vergleichsDaten: Verbrauch | null = null;
let vergleichAn = false;
let auswahl: Auswahl = leereAuswahl();
let status = '';

function setzeStatus(text: string): void {
  status = text;
  statusEl.textContent = text;
}

// --- kleine Bauhelfer -------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  name: K,
  klasse?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(name);
  if (klasse) n.className = klasse;
  if (text !== undefined) n.textContent = text;
  return n;
}

function abschnitt(titel: string, ...kinder: (Node | null)[]): HTMLElement {
  const s = el('section');
  s.dataset.abschnitt = titel;
  s.appendChild(el('h2', undefined, titel));
  for (const k of kinder) if (k) s.appendChild(k);
  return s;
}

function tabelle(kopf: { text: string; zahl?: boolean }[], zeilen: (Node | string)[][]): HTMLElement {
  const tb = el('table');
  const thead = el('thead');
  const kr = el('tr');
  for (const k of kopf) {
    const th = el('th', k.zahl ? 'zahl' : undefined, k.text);
    kr.appendChild(th);
  }
  thead.appendChild(kr);
  tb.appendChild(thead);
  const body = el('tbody');
  for (const z of zeilen) {
    const tr = el('tr');
    z.forEach((wert, i) => {
      const td = el('td', kopf[i]?.zahl ? 'zahl' : undefined);
      if (typeof wert === 'string') td.textContent = wert;
      else td.appendChild(wert);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  tb.appendChild(body);
  return tb;
}

function svgKnoten(name: string, attribute: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attribute)) n.setAttribute(k, String(v));
  return n;
}

function legende(arten: string[]): HTMLElement {
  const l = el('div', 'legende');
  for (const a of arten) {
    const s = el('span', undefined);
    const p = el('span', 'punkt');
    p.style.background = ARTFARBE[a] ?? 'var(--gedaempft)';
    s.appendChild(p);
    s.appendChild(document.createTextNode(t(`summe.${a}`)));
    l.appendChild(s);
  }
  return l;
}

// --- Kopfzeile: Zeitraum und Filter ----------------------------------------

function zeichneZeitraum(): void {
  zeitraumEl.replaceChildren();
  zeitraumEl.appendChild(el('span', 'marke', `${t('zeitraum.titel')}:`));
  // Die fuenf Zeitraeume sind EINE Wahl, nicht fuenf Schalter -- deshalb eine
  // Segmentleiste statt fuenf einzelner Chips. Der Vergleichsknopf steht
  // daneben und ausserhalb: er waehlt nicht mit, er schaltet etwas dazu.
  const streifen = el('div', 'segmente');
  for (const n of ZEITRAEUME) {
    const k = el('button', `knopf${n === tage ? ' gewaehlt' : ''}`, t(`zeitraum.${n}`));
    k.type = 'button';
    k.dataset.tage = String(n);
    k.addEventListener('click', () => {
      if (n === tage) return;
      tage = n;
      // Ein anderer Zeitraum macht jeden geladenen Vergleich ungueltig: er gehoerte zum alten.
      vergleichsDaten = null;
      void laden();
    });
    streifen.appendChild(k);
  }
  zeitraumEl.appendChild(streifen);
  const v = el('button', `knopf${vergleichAn ? ' gewaehlt' : ''}`, vergleichAn ? t('vergleich.aus') : t('vergleich.knopf'));
  v.type = 'button';
  v.id = 'vergleich-knopf';
  v.addEventListener('click', () => {
    vergleichAn = !vergleichAn;
    if (vergleichAn && !vergleichsDaten) void ladeVergleich();
    else zeichne();
  });
  zeitraumEl.appendChild(v);
}

function chipReihe(
  ziel: HTMLElement,
  beschriftung: string,
  eintraege: { id: string; tokens: number }[],
  gewaehlt: string[],
  umschalten: (id: string) => void,
  praefix: string,
): void {
  ziel.replaceChildren();
  if (eintraege.length === 0) return;
  ziel.appendChild(el('span', 'marke', `${beschriftung}:`));
  const alle = el('button', `knopf${gewaehlt.length === 0 ? ' gewaehlt' : ''}`, t('filter.alle'));
  alle.type = 'button';
  alle.dataset.filter = `${praefix}:alle`;
  alle.addEventListener('click', () => {
    if (gewaehlt.length === 0) return;
    gewaehlt.splice(0, gewaehlt.length);
    zeichne();
  });
  ziel.appendChild(alle);
  for (const e of eintraege) {
    const k = el('button', `knopf${gewaehlt.indexOf(e.id) >= 0 ? ' gewaehlt' : ''}`, e.id);
    k.type = 'button';
    k.dataset.filter = `${praefix}:${e.id}`;
    k.title = `${e.id} — ${zahl(e.tokens)} ${t('summe.gesamt')}`;
    k.addEventListener('click', () => umschalten(e.id));
    ziel.appendChild(k);
  }
}

function umschalten(liste: string[], id: string): void {
  const i = liste.indexOf(id);
  if (i >= 0) liste.splice(i, 1);
  else liste.push(id);
  zeichne();
}

// --- Die Abschnitte ---------------------------------------------------------

/**
 * Eine Zahl, wie sie hier ueberall steht: Beschriftung klein und gedaempft
 * darueber, die Zahl gross darunter, ein Farbstrich in der Farbe der Tokenart.
 * Kein Kasten -- die Zahl braucht keinen Rahmen, um eine Zahl zu sein.
 */
function kachel(klasse: string, titel: string, wert: string, neben?: string, titelText?: string): HTMLElement {
  const k = el('div', `zahlenfeld ${klasse}`);
  if (titelText) k.title = titelText;
  k.appendChild(el('div', 'titel', titel));
  k.appendChild(el('div', 'wert', wert));
  k.appendChild(el('div', 'strich'));
  if (neben) k.appendChild(el('div', 'neben', neben));
  return k;
}

function abschnittSummen(w: Werte): HTMLElement {
  const k = el('div', 'zahlenreihe');
  k.appendChild(kachel('summe', t('summe.gesamt'), zahl(w.ohne_cache_read), t('summe.nachrichten') + ': ' + zahl(w.nachrichten), t('summe.gesamt.hinweis')));
  k.appendChild(kachel('ein', t('summe.input'), zahl(w.input), kompakt(w.input)));
  k.appendChild(kachel('raus', t('summe.output'), zahl(w.output), kompakt(w.output)));
  k.appendChild(kachel('cw', t('summe.cache_write'), zahl(w.cache_write), kompakt(w.cache_write)));
  k.appendChild(kachel('cr', t('summe.cache_read'), zahl(w.cache_read), kompakt(w.cache_read)));
  return abschnitt(t('summe.titel'), k);
}

function balkenDiagramm(
  titel: string,
  reihen: { beschriftung: string; teile: { wert: number; art: string }[] }[],
  arten: string[],
): HTMLElement {
  const kasten = el('div', 'diagramm');
  const breite = 560;
  const hoehe = 150;
  const kopf = el('div', 'kopfzeile');
  kopf.appendChild(el('span', undefined, titel));
  const { balken: stangen, hoechstwert } = balken(reihen, breite, hoehe);
  kopf.appendChild(el('span', undefined, kompakt(hoechstwert)));
  kasten.appendChild(kopf);

  const svg = svgKnoten('svg', { viewBox: `0 0 ${breite} ${hoehe + 18}`, role: 'img' });
  svg.appendChild(svgKnoten('line', { x1: 0, y1: hoehe, x2: breite, y2: hoehe, stroke: 'var(--linie)' }));
  for (const s of stangen) {
    for (const teil of s.stapel) {
      if (teil.hoehe <= 0) continue;
      const r = svgKnoten('rect', {
        x: s.x.toFixed(1),
        y: teil.y.toFixed(1),
        width: s.breite.toFixed(1),
        height: Math.max(0.5, teil.hoehe).toFixed(1),
        fill: ARTFARBE[teil.art] ?? 'var(--gedaempft)',
      });
      const titelKnoten = svgKnoten('title', {});
      titelKnoten.textContent = `${s.beschriftung} — ${t(`summe.${teil.art}`)}: ${zahl((teil.hoehe / hoehe) * hoechstwert)}`;
      r.appendChild(titelKnoten);
      svg.appendChild(r);
    }
    // Nur jede zweite Beschriftung, sobald es eng wird -- lieber weniger lesbare Tage als
    // ineinandergeschobene Ziffern, die niemand mehr zuordnet.
    if (stangen.length <= 10 || stangen.indexOf(s) % 2 === 0) {
      const beschriftung = svgKnoten('text', {
        x: (s.x + s.breite / 2).toFixed(1),
        y: hoehe + 13,
        fill: 'var(--gedaempft)',
        'font-size': 9,
        'text-anchor': 'middle',
      });
      beschriftung.textContent = s.beschriftung.slice(5);
      svg.appendChild(beschriftung);
    }
  }
  kasten.appendChild(svg);
  kasten.appendChild(legende(arten));
  return kasten;
}

function abschnittTage(d: Verbrauch, gefiltertTage: ReturnType<typeof filterTage>, gesamt: Werte): HTMLElement {
  const reihe = tagesreihe(gefiltertTage, d.fenster.von, d.fenster.bis);
  const plan = cacheAchse(gesamt);
  const kasten = el('div', 'diagramme');
  if (reihe.length === 0) {
    return abschnitt(t('tage.titel'), el('p', 'hinweis', t('tage.leer')));
  }
  if (plan.art === 'getrennt') {
    kasten.appendChild(
      balkenDiagramm(
        t('cache.diagramm.ohne'),
        reihe.map((r) => ({
          beschriftung: r.tag,
          teile: [
            { wert: r.input, art: 'input' },
            { wert: r.output, art: 'output' },
            { wert: r.cache_write, art: 'cache_write' },
          ],
        })),
        ['input', 'output', 'cache_write'],
      ),
    );
    kasten.appendChild(
      balkenDiagramm(
        t('cache.diagramm.nur'),
        reihe.map((r) => ({ beschriftung: r.tag, teile: [{ wert: r.cache_read, art: 'cache_read' }] })),
        ['cache_read'],
      ),
    );
  } else {
    kasten.appendChild(
      balkenDiagramm(
        t('cache.diagramm.ohne'),
        reihe.map((r) => ({
          beschriftung: r.tag,
          teile: [
            { wert: r.input, art: 'input' },
            { wert: r.output, art: 'output' },
            { wert: r.cache_write, art: 'cache_write' },
            { wert: r.cache_read, art: 'cache_read' },
          ],
        })),
        ['input', 'output', 'cache_write', 'cache_read'],
      ),
    );
  }
  const verhaeltnis = Number.isFinite(plan.verhaeltnis) ? plan.verhaeltnis.toFixed(1).replace('.', ',') : '∞';
  const grund = el(
    'p',
    'hinweis',
    plan.art === 'getrennt' ? t('cache.grund', verhaeltnis) : t('cache.grund.klein', verhaeltnis),
  );
  return abschnitt(t('tage.titel'), el('p', 'hinweis', t('tage.hinweis')), grund, kasten);
}

function tempoMarke(z: ModellZeile): HTMLElement {
  const art = z.tempo?.art ?? 'unbekannt';
  const klasse = art === 'gemessen' ? 'gemessen' : art === 'naeherung' ? 'naeherung' : 'fehlt';
  const m = el('span', `marke-art ${klasse}`, t(`tempo.${art}`));
  m.title = umlaute(z.tempo?.grund ?? '');
  return m;
}

function tempoWert(z: ModellZeile): HTMLElement {
  const s = el('span');
  if (z.tempo?.wert === null || z.tempo?.wert === undefined) {
    s.textContent = '—';
    return s;
  }
  // Das Zeichen steht VOR der Zahl, nicht dahinter: wer die Spalte ueberfliegt, sieht zuerst,
  // ob die Zahl ueberhaupt eine Messung ist.
  const vorzeichen = z.tempo.art === 'naeherung' ? `${t('tempo.zeichen.naeherung')} ` : '';
  s.textContent = `${vorzeichen}${z.tempo.wert.toLocaleString('de-DE', { maximumFractionDigits: 1 })}`;
  if (z.tempo.sekunden) s.title = t('tempo.grundlage', zahl(z.tempo.sekunden));
  return s;
}

function preisZelle(z: ModellZeile): HTMLElement {
  const d = el('div');
  const p = z.preis;
  if (!p || p.usd === null || p.usd === undefined) {
    d.appendChild(el('span', 'fein', t('kosten.ohne')));
    return d;
  }
  d.appendChild(el('div', undefined, usd(p.usd)));
  const art = el('div', 'fein', t(`kosten.art.${p.art}`));
  art.title = p.quelle;
  d.appendChild(art);
  // Auflage 1: der Satz steht AN der Zahl.
  if (p.nie_abgebucht === true && p.usd > 0) d.appendChild(el('div', 'einschraenkung', t('kosten.nie_abgebucht')));
  if (z.aiu) d.appendChild(el('div', 'fein', `${z.aiu.toLocaleString('de-DE', { maximumFractionDigits: 3 })} ${t('kosten.aiu')}`));
  return d;
}

function abschnittHarnesses(modelle: ModellZeile[]): HTMLElement {
  const proHarness = new Map<string, ModellZeile[]>();
  for (const z of modelle) {
    const l = proHarness.get(z.harness) ?? [];
    l.push(z);
    proHarness.set(z.harness, l);
  }
  const zeilen = [...proHarness.entries()]
    .map(([h, l]) => ({ h, w: summiere(l) }))
    .sort((a, b) => b.w.ohne_cache_read - a.w.ohne_cache_read)
    .map(({ h, w }) => [
      h,
      zahl(w.ohne_cache_read),
      zahl(w.input),
      zahl(w.output),
      zahl(w.cache_write),
      zahl(w.cache_read),
      zahl(w.nachrichten),
    ]);
  return abschnitt(
    t('harness.titel'),
    tabelle(
      [
        { text: t('harness.spalte') },
        { text: t('summe.gesamt'), zahl: true },
        { text: t('summe.input'), zahl: true },
        { text: t('summe.output'), zahl: true },
        { text: t('summe.cache_write'), zahl: true },
        { text: t('summe.cache_read'), zahl: true },
        { text: t('summe.nachrichten'), zahl: true },
      ],
      zeilen,
    ),
  );
}

function abschnittModelle(modelle: ModellZeile[]): HTMLElement {
  const zeilen = modelle.map((z) => [
    z.harness,
    z.modell,
    zahl(ohneCacheRead(z)),
    zahl(z.input),
    zahl(z.output),
    zahl(z.cache_read),
    tempoWert(z),
    tempoMarke(z),
    preisZelle(z),
  ]);
  return abschnitt(
    t('modell.titel'),
    tabelle(
      [
        { text: t('harness.spalte') },
        { text: t('modell.spalte') },
        { text: t('summe.gesamt'), zahl: true },
        { text: t('summe.input'), zahl: true },
        { text: t('summe.output'), zahl: true },
        { text: t('summe.cache_read'), zahl: true },
        { text: t('tempo.spalte'), zahl: true },
        { text: t('kosten.art') },
        { text: t('kosten.usd') },
      ],
      zeilen,
    ),
  );
}

function abschnittTempo(modelle: ModellZeile[]): HTMLElement {
  const mit = modelle.filter((z) => z.tempo && z.tempo.wert !== null);
  const sortiert = [...mit].sort((a, b) => (b.tempo.wert ?? 0) - (a.tempo.wert ?? 0));
  const warnung = el('p', 'hinweis einschraenkung', t('tempo.warnung', t('tempo.gemessen')));
  if (sortiert.length === 0) return abschnitt(t('tempo.titel'), warnung, el('p', 'hinweis', t('leer')));
  // KEINE SPALTE "GRUND". Der Satz aus `wb-budget` ist fuer alle Zeilen
  // derselbe -- zehnmal untereinander verdoppelte er jede Zeilenhoehe und sagte
  // nichts, was nicht schon in der Warnzeile ueber der Tabelle steht. Er haengt
  // weiter als `title` an der Marke, wo ihn findet, wer ihn sucht.
  const zeilen = sortiert.map((z) => [z.harness, z.modell, tempoWert(z), tempoMarke(z)]);
  return abschnitt(
    t('tempo.titel'),
    warnung,
    tabelle(
      [
        { text: t('harness.spalte') },
        { text: t('modell.spalte') },
        { text: t('tempo.spalte'), zahl: true },
        { text: t('kosten.art') },
      ],
      zeilen,
    ),
  );
}

function abschnittKosten(modelle: ModellZeile[]): HTMLElement {
  const bild = kostenBild(modelle);
  const k = el('div', 'zahlenreihe');
  const aequivalent = kachel('summe', t('kosten.summe.aequivalent'), usd(bild.aequivalent));
  aequivalent.appendChild(el('div', 'einschraenkung', t('kosten.nie_abgebucht')));
  k.appendChild(aequivalent);
  k.appendChild(kachel('ein', t('kosten.summe.katalog'), usd(bild.katalog)));
  if (bild.aiu > 0) k.appendChild(kachel('cw', t('kosten.aiu'), bild.aiu.toLocaleString('de-DE', { maximumFractionDigits: 3 })));
  if (bild.ohnePreis.length > 0) k.appendChild(kachel('cr', t('kosten.ohne'), String(bild.ohnePreis.length), bild.ohnePreis.join(', ')));

  return abschnitt(t('kosten.titel'), el('p', 'hinweis', t('kosten.zwei')), k);
}

/**
 * Ein Balken je Kontingent -- die erste Frage beim Aufmachen dieses Fensters,
 * und deshalb der erste Abschnitt.
 *
 * DER BALKEN TRAEGT ZWEI ANGABEN, und sie sind nicht dieselbe: die Fuellung
 * sagt, wieviel verbraucht IST, die Marke darauf, wieviel bis heute Abend
 * verbraucht sein DARF. Ohne die Marke liest sich jeder Stand unter hundert
 * als reichlich.
 *
 * NUR ZAHLEN AUS DER BRUECKE. Wo eine Grenze fehlt, gibt es keinen Balken --
 * ein Balken ohne Nenner waere eine erfundene Zahl. Wer kein Kontingent hat,
 * verschwindet nicht, sondern bekommt eine Zeile mit dem Grund.
 */
function balkenZeile(o: {
  name: string;
  wert: string;
  anteil: number | null;
  marke?: number;
  rechts?: string;
  fuss?: Node | null;
  lage?: 'knapp' | 'voll';
}): HTMLElement {
  const z = el('div', 'balkenzeile');
  if (o.lage) z.dataset.lage = o.lage;
  const oben = el('div', 'oben');
  oben.appendChild(el('span', 'name', o.name));
  if (o.rechts) oben.appendChild(el('span', 'rechts', o.rechts));
  z.appendChild(oben);
  z.appendChild(el('div', 'wert', o.wert));
  // Kein Nenner, kein Balken: eine leere Bahn behauptete eine Grenze, die die
  // Bruecke gar nicht kennt.
  if (o.anteil !== null) {
    const bahn = el('div', 'bahn');
    const fuellung = el('div', 'fuellung');
    fuellung.style.width = `${Math.max(0, Math.min(100, o.anteil * 100)).toFixed(1)}%`;
    bahn.appendChild(fuellung);
    if (o.marke !== undefined && o.marke > 0 && o.marke < 1) {
      const marke = el('div', 'marke');
      marke.style.left = `${(o.marke * 100).toFixed(1)}%`;
      bahn.appendChild(marke);
    }
    z.appendChild(bahn);
  }
  if (o.fuss) z.appendChild(o.fuss);
  return z;
}

/**
 * Abkuerzungen, die `wb-kontingent` mitbringt, ausgeschrieben. "AIC" steht im
 * Fenster nirgends sonst und wird auch nirgends aufgeloest -- eine Abkuerzung,
 * die nur ihr Erfinder kennt, ist keine Beschriftung. Was hier nicht steht,
 * bleibt unveraendert stehen (nur die Umschrift wird zurueckgeholt).
 */
const EINHEIT_LANG: Record<string, string> = { AIC: 'einheit.aic' };

function einheitLesbar(e: string): string {
  const schluessel = EINHEIT_LANG[e];
  return schluessel ? t(schluessel) : umlaute(e);
}

/**
 * Ein Kontingentstand ohne Nenner. Die Nachkommastellen richten sich nach dem,
 * was die Zahl traegt: 2,6888 verbrauchte Credits sind auf Hundertstel genau
 * eine Aussage, auf Zehntausendstel eine Behauptung ueber die Messgenauigkeit
 * der Quelle. Ab hundert faellt der Rest ganz weg.
 */
function kontingentZahl(v: number): string {
  const stellen = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return v.toLocaleString(sprache() === 'en' ? 'en-US' : 'de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: stellen,
  });
}

function abschnittKontingente(d: Verbrauch): HTMLElement {
  const liste = el('div', 'balkenliste');
  let balken = 0;

  // 1. Das Wochenfenster mit der Marke "erlaubt bis heute Abend".
  const woche = wochenbudget(d.limits ?? []);
  if (woche) {
    const fuss = el('div', 'fuss');
    fuss.appendChild(document.createTextNode(`${t('wochen.erlaubt')} `));
    fuss.appendChild(el('b', undefined, prozent(woche.erlaubt)));
    fuss.appendChild(document.createTextNode(' · '));
    fuss.appendChild(
      document.createTextNode(
        woche.luft >= 0
          // Punkte, nicht Prozent: die Luft ist die DIFFERENZ zweier
          // Prozentwerte, und "6 % Luft" hiesse etwas anderes als "6 Punkte".
          ? t('wochen.luft', zahl(woche.luft))
          : t('wochen.darueber', zahl(Math.abs(woche.luft))),
      ),
    );
    liste.appendChild(
      balkenZeile({
        name: t('limit.7d'),
        wert: prozent(woche.verbraucht),
        anteil: woche.verbraucht / 100,
        marke: woche.erlaubt / 100,
        rechts: t('wochen.tag', woche.tag),
        fuss,
        lage: woche.luft < 0 ? 'knapp' : undefined,
      }),
    );
    balken += 1;
  }

  // 2. Je Harness, was `wb-kontingent` ueber ihn weiss.
  const roh = d.kontingent as Record<string, unknown> | undefined;
  const harnesses = roh && typeof roh === 'object' ? (roh['harnesses'] as Record<string, Record<string, unknown>> | undefined) : undefined;
  const ohne: { wer: string; grund: string }[] = [];
  const ohneStand: { wer: string; grund: string }[] = [];
  if (harnesses) {
    for (const [id, e] of Object.entries(harnesses)) {
      const kont = (e['kontingent'] ?? {}) as Record<string, unknown>;
      const art = String(kont['art'] ?? '');
      const einheit = einheitLesbar(String(kont['einheit'] ?? ''));
      // `Number(null)` ist 0, nicht NaN: bis zum 03.09. wurde daraus eine
      // grosse, nackte "0" fuer jeden Harness, dessen Stand die Bruecke gar
      // nicht kennt (agy, codex). Eine erfundene Null ist schlimmer als keine
      // Zahl -- deshalb zaehlt nur, was wirklich als Zahl ankommt.
      const verbraucht = typeof kont['verbraucht'] === 'number' ? (kont['verbraucht'] as number) : NaN;
      const grenze = typeof kont['grenze'] === 'number' ? (kont['grenze'] as number) : NaN;
      const rest = kont['rest'];
      const zurueck = kont['faellt_zurueck_am'];
      const erschoepft = e['erschoepft'] === true;
      if (art === 'keins' || art === '' || !Number.isFinite(verbraucht)) {
        // Zwei Ueberschriften, weil es zwei verschiedene Aussagen sind: "hat
        // kein Kontingent" und "hat eines, aber niemand kann seinen Stand
        // lesen". codex unter "kein Kontingent" zu fuehren waere schlicht
        // falsch.
        const wohin = art === 'keins' || art === '' ? ohne : ohneStand;
        wohin.push({ wer: id, grund: umlaute(String(e['hinweis'] ?? '')) || t('kontingent.keins') });
        continue;
      }
      const teile: string[] = [];
      if (rest !== null && rest !== undefined) teile.push(`${t('kontingent.rest')} ${String(rest)}`);
      if (zurueck) teile.push(t('kontingent.zurueck', zeitpunkt(String(zurueck))));
      const hatGrenze = Number.isFinite(grenze) && grenze > 0;
      // Die Bedeutungszeile unter der Zahl. Steht ein Prozentwert da, sagt die
      // Einheit, WOVON er Prozent sind; steht der rohe Wert da, fehlt ohne
      // dieses Wort jeder Bezug -- "2,69" allein ist keine Aussage.
      const bedeutung = hatGrenze ? einheit : [einheit, t('kontingent.verbraucht')].filter(Boolean).join(' ');
      const fuss = el('div', 'fuss', bedeutung);
      if (erschoepft) {
        fuss.textContent = '';
        fuss.appendChild(el('b', undefined, t('kontingent.erschoepft')));
        if (bedeutung) fuss.appendChild(document.createTextNode(` · ${bedeutung}`));
      }
      liste.appendChild(
        balkenZeile({
          name: id,
          // Ohne Grenze keine Prozentzahl: dann steht der rohe Wert da, und der
          // Balken bleibt leer, statt einen Nenner zu behaupten.
          wert: hatGrenze ? prozent((verbraucht / grenze) * 100) : kontingentZahl(verbraucht),
          anteil: hatGrenze ? verbraucht / grenze : null,
          rechts: teile.join(' · '),
          fuss,
          lage: erschoepft ? 'voll' : undefined,
        }),
      );
      balken += 1;
    }
  }

  const teile: (Node | null)[] = [];
  if (balken > 0) teile.push(liste);
  if (!harnesses) {
    // DIE MELDUNG SAGT DEN NAECHSTEN SCHRITT, DER ROHTEXT STEHT IM SCHILDCHEN
    // (08.09.2026). Vorher stand der Rohtext IN der Zeile, und wer kein
    // `wb-kontingent` hat, las hier „JSONDecodeError: Expecting value…" --
    // eine wahre Angabe, die niemandem sagt, was zu tun ist.
    const grund = roh && typeof roh['fehler'] === 'string' && roh['fehler'].trim()
      ? String(roh['fehler']).trim()
      : t('kontingent.werkzeug.fehlt');
    const zeile = el('p', 'hinweis', t('kontingent.fehlt'));
    zeile.dataset.grund = grund;
    zeile.title = t('kontingent.fehlt.tipp', grund);
    teile.push(zeile);
  }
  if (!woche) teile.push(el('p', 'hinweis', t('wochen.fehlt')));
  for (const [ueberschrift, zeilen] of [
    [t('kontingent.ohnestand'), ohneStand],
    [t('kontingent.keins'), ohne],
  ] as [string, { wer: string; grund: string }[]][]) {
    if (zeilen.length === 0) continue;
    teile.push(el('div', 'untertitel', ueberschrift));
    // Was in JEDER Zeile gleich steht, steht einmal ueber der Liste. Vierzehn
    // Zeilen mit demselben ersten Satz verdecken genau das, was sie
    // unterscheidet -- dieselbe Regel wie bei der Token-je-Sekunde-Tabelle.
    const vorspann = gemeinsamerVorspann(zeilen.map((z) => z.grund));
    if (vorspann) teile.push(el('p', 'hinweis', vorspann));
    const kasten = el('div');
    for (const z of zeilen) {
      const zeile = el('div', 'ohnekontingent');
      zeile.appendChild(el('span', 'wer', z.wer));
      zeile.appendChild(el('span', undefined, z.grund.slice(vorspann.length).trim()));
      kasten.appendChild(zeile);
    }
    teile.push(kasten);
  }
  return abschnitt(t('kontingent.titel'), ...teile);
}

function abschnittLimit(d: Verbrauch): HTMLElement {
  if (!d.limits || d.limits.length === 0) {
    return abschnitt(t('limit.titel'), el('p', 'hinweis', t('limit.leer')), el('p', 'hinweis', t('limit.quelle')));
  }
  const kasten = el('div', 'diagramme');
  for (const feld of ['five_hour_pct', 'seven_day_pct'] as const) {
    const v = limitVerlauf(d.limits, feld);
    if (v.segmente.length === 0) continue;
    const diagramm = el('div', 'diagramm');
    const kopf = el('div', 'kopfzeile');
    kopf.appendChild(el('span', undefined, feld === 'five_hour_pct' ? t('limit.5h') : t('limit.7d')));
    kopf.appendChild(el('span', undefined, v.zuletzt === null ? '' : t('limit.stand', prozent(v.zuletzt))));
    diagramm.appendChild(kopf);

    const breite = 560;
    const hoehe = 120;
    const svg = svgKnoten('svg', { viewBox: `0 0 ${breite} ${hoehe + 16}`, role: 'img' });
    svg.appendChild(svgKnoten('line', { x1: 0, y1: hoehe, x2: breite, y2: hoehe, stroke: 'var(--linie)' }));
    // Die 100-Prozent-Kante als eigene Linie: ohne sie liest sich jede Kurve als „fast voll",
    // egal wie weit sie vom Anschlag entfernt ist.
    svg.appendChild(svgKnoten('line', { x1: 0, y1: 0, x2: breite, y2: 0, stroke: 'var(--aus)', 'stroke-dasharray': '3 4', opacity: 0.5 }));
    for (const seg of v.segmente) {
      svg.appendChild(
        svgKnoten('path', {
          d: linienPfad(seg, v.von, v.bis, v.hoechstwert, breite, hoehe),
          fill: 'none',
          stroke: feld === 'five_hour_pct' ? 'var(--ein)' : 'var(--cw)',
          'stroke-width': 1.5,
        }),
      );
    }
    for (const r of v.ruecksetzpunkte) {
      const x = ((r - v.von) / (v.bis - v.von || 1)) * breite;
      const linie = svgKnoten('line', { x1: x.toFixed(1), y1: 0, x2: x.toFixed(1), y2: hoehe, stroke: 'var(--laeuft)', 'stroke-dasharray': '2 3' });
      const titelKnoten = svgKnoten('title', {});
      titelKnoten.textContent = `${t('limit.reset')}: ${zeitpunkt(new Date(r).toISOString())}`;
      linie.appendChild(titelKnoten);
      svg.appendChild(linie);
    }
    diagramm.appendChild(svg);
    const fuss = el('div', 'legende');
    fuss.appendChild(el('span', undefined, t('limit.reset.anzahl', v.ruecksetzpunkte.length)));
    if (v.naechsterReset) fuss.appendChild(el('span', undefined, t('limit.reset.naechster', zeitpunkt(new Date(v.naechsterReset).toISOString()))));
    diagramm.appendChild(fuss);
    kasten.appendChild(diagramm);
  }
  return abschnitt(t('limit.titel'), kasten, el('p', 'hinweis', t('limit.quelle')));
}

const SITZUNGEN_MAX = 40;

function abschnittSitzungen(sitzungen: SitzungZeile[]): HTMLElement {
  const gezeigt = sitzungen.slice(0, SITZUNGEN_MAX);
  const zeilen = gezeigt.map((z) => [
    z.harness,
    z.worker || t('sitzung.ohne_worker'),
    z.sitzung.slice(0, 12),
    z.modelle.join(', '),
    zahl(ohneCacheRead(z)),
    zahl(z.output),
    zahl(z.cache_read),
    `${zeitpunkt(z.von)} – ${zeitpunkt(z.bis)}`,
  ]);
  const teile: (Node | null)[] = [
    tabelle(
      [
        { text: t('harness.spalte') },
        { text: t('sitzung.worker') },
        { text: t('sitzung.spalte') },
        { text: t('modell.spalte') },
        { text: t('summe.gesamt'), zahl: true },
        { text: t('summe.output'), zahl: true },
        { text: t('summe.cache_read'), zahl: true },
        { text: t('sitzung.zeitraum') },
      ],
      zeilen,
    ),
  ];
  if (sitzungen.length > gezeigt.length) {
    teile.push(el('p', 'hinweis', t('sitzung.mehr', sitzungen.length - gezeigt.length)));
  }
  if (sitzungenTeilweise(sitzungen, auswahl)) {
    // Ehrlichkeit vor Bequemlichkeit: wb-budget schluesselt eine Sitzung nicht je Modell auf.
    teile.push(el('p', 'hinweis einschraenkung', t('filter.aktiv')));
  }
  return abschnitt(t('sitzung.titel'), ...teile);
}

function vergleichsTabelle(zeilen: VergleichsZeile[], beschriftung: (s: string) => string): HTMLElement {
  return tabelle(
    [
      { text: '' },
      { text: t('vergleich.jetzt'), zahl: true },
      { text: t('vergleich.vorher'), zahl: true },
      { text: t('vergleich.differenz'), zahl: true },
      { text: '', zahl: true },
    ],
    zeilen.map((z) => {
      const zeichen = z.richtung === 'mehr' ? t('zeichen.mehr') : z.richtung === 'weniger' ? t('zeichen.weniger') : t('zeichen.gleich');
      const p = el('span', z.richtung);
      p.textContent = z.prozent === null ? t('vergleich.kein_vorher') : `${zeichen} ${prozent(Math.abs(z.prozent))}`;
      return [beschriftung(z.schluessel), zahl(z.jetzt), zahl(z.vorher), zahl(z.differenz), p];
    }),
  );
}

function abschnittVergleich(d: Verbrauch, gefiltert: ModellZeile[]): HTMLElement | null {
  if (!vergleichAn) return null;
  if (!vergleichsDaten) return abschnitt(t('vergleich.titel'), el('p', 'hinweis', t('vergleich.laedt')));
  const vorherModelle = filterModelle(vergleichsDaten.je_modell, auswahl);
  const jetztWerte = summiere(gefiltert);
  const vorherWerte = summiere(vorherModelle);
  const spanne = el(
    'p',
    'hinweis',
    `${t('vergleich.jetzt')}: ${zeitpunkt(d.fenster.von)} – ${zeitpunkt(d.fenster.bis)} · ${t('vergleich.vorher')}: ${zeitpunkt(vergleichsDaten.fenster.von)} – ${zeitpunkt(vergleichsDaten.fenster.bis)}`,
  );
  return abschnitt(
    t('vergleich.titel'),
    spanne,
    vergleichsTabelle(vergleicheWerte(jetztWerte, vorherWerte), (s) => t(`summe.${s}`)),
    el('p', 'hinweis', t('harness.titel')),
    vergleichsTabelle(
      vergleicheHarnesses(
        harnessAuswahlliste(gefiltert).map((h) => ({ ...summiere(gefiltert.filter((z) => z.harness === h.id)), harness: h.id })),
        harnessAuswahlliste(vorherModelle).map((h) => ({ ...summiere(vorherModelle.filter((z) => z.harness === h.id)), harness: h.id })),
      ),
      (s) => s,
    ),
  );
}

function abschnittLuecken(d: Verbrauch): HTMLElement {
  const zeilen = (d.luecken ?? []).map((l) => [l.harness, umlaute(l.grund)]);
  return abschnitt(
    t('luecke.titel'),
    el('p', 'hinweis', t('luecke.einleitung')),
    tabelle([{ text: t('luecke.spalte') }, { text: t('luecke.grund') }], zeilen),
  );
}

function abschnittQuellen(d: Verbrauch): HTMLElement {
  const zeilen = (d.quellen ?? []).map((q) => {
    const zeichen = el('span', 'marke-art ' + (q.zustand === 'gelesen' ? 'gemessen' : q.zustand === 'unlesbar' ? 'fehlt' : ''), t(`zeichen.${q.zustand}`));
    zeichen.title = t(`quelle.zustand.${q.zustand}`);
    return [
      q.harness,
      zeichen,
      t(`quelle.zustand.${q.zustand}`),
      q.pfad,
      t('quelle.nachrichten', zahl(q.nachrichten)),
      el('span', 'fein', umlaute(q.hinweis)),
    ];
  });
  return abschnitt(
    t('quelle.titel'),
    tabelle(
      [
        { text: t('harness.spalte') },
        { text: '' },
        { text: '' },
        { text: t('quelle.spalte') },
        { text: '', zahl: true },
        { text: t('luecke.grund') },
      ],
      zeilen,
    ),
  );
}

// --- Zeichnen ---------------------------------------------------------------

function zeichne(): void {
  zeichneZeitraum();
  if (!daten) return;
  const d = daten;
  const alleModelle = d.je_modell ?? [];
  chipReihe(filterHarnessEl, t('filter.harness'), harnessAuswahlliste(alleModelle), auswahl.harness, (id) => umschalten(auswahl.harness, id), 'harness');
  chipReihe(
    filterModellEl,
    t('filter.modell'),
    modellAuswahlliste(alleModelle, auswahl).map((m) => ({ id: m.id, tokens: m.tokens })),
    auswahl.modell,
    (id) => umschalten(auswahl.modell, id),
    'modell',
  );

  const gefiltert = filterModelle(alleModelle, auswahl);
  const gesamt = summiere(gefiltert);
  standEl.textContent = t('stand', zeitpunkt(d.erzeugt), zeitpunkt(d.fenster.von), zeitpunkt(d.fenster.bis));

  inhaltEl.replaceChildren();
  // Die Kontingente zuerst: "wieviel darf ich heute noch" ist die Frage, wegen
  // der dieses Fenster aufgeht. Der Zeitraumfilter beruehrt sie nicht -- ein
  // Kontingentstand ist immer der von jetzt.
  inhaltEl.appendChild(abschnittKontingente(d));
  inhaltEl.appendChild(abschnittSummen(gesamt));
  inhaltEl.appendChild(abschnittTage(d, filterTage(d.je_tag ?? [], auswahl), gesamt));
  inhaltEl.appendChild(abschnittHarnesses(gefiltert));
  inhaltEl.appendChild(abschnittModelle(gefiltert));
  inhaltEl.appendChild(abschnittTempo(gefiltert));
  inhaltEl.appendChild(abschnittKosten(gefiltert));
  inhaltEl.appendChild(abschnittLimit(d));
  inhaltEl.appendChild(abschnittSitzungen(filterSitzungen(d.je_sitzung ?? [], auswahl)));
  const v = abschnittVergleich(d, gefiltert);
  if (v) inhaltEl.appendChild(v);
  inhaltEl.appendChild(abschnittLuecken(d));
  inhaltEl.appendChild(abschnittQuellen(d));
}

function zeigeFehler(text: string): void {
  inhaltEl.replaceChildren();
  const k = el('div');
  k.id = 'fehler';
  k.appendChild(el('div', undefined, t('fehler.titel')));
  k.appendChild(el('div', 'fein', text));
  inhaltEl.appendChild(k);
}

async function laden(): Promise<void> {
  setzeStatus(t('laden'));
  zeichneZeitraum();
  const antwort = await window.awbVerbrauch.daten({ tage });
  if (!antwort || !antwort.ok || !antwort.daten) {
    daten = null;
    zeigeFehler(antwort?.fehler ?? t('fehler.titel'));
    setzeStatus(antwort?.fehler ?? t('fehler.titel'));
    return;
  }
  daten = antwort.daten;
  setzeStatus('');
  zeichne();
  if (vergleichAn && !vergleichsDaten) void ladeVergleich();
}

async function ladeVergleich(): Promise<void> {
  if (!daten) return;
  const zeitraum = vorherigerZeitraum(daten.fenster.von, daten.fenster.bis);
  if (!zeitraum) return;
  setzeStatus(t('vergleich.laedt'));
  zeichne();
  const antwort = await window.awbVerbrauch.daten(zeitraum);
  if (antwort && antwort.ok && antwort.daten) {
    vergleichsDaten = antwort.daten;
    setzeStatus('');
  } else {
    setzeStatus(antwort?.fehler ?? t('fehler.titel'));
  }
  zeichne();
}

window.__awbVerbrauch = {
  text: () => document.body.innerText,
  status: () => status,
  klick: (a: string) => {
    const e = document.querySelector<HTMLElement>(a);
    if (!e) return false;
    e.click();
    return true;
  },
  zustand: (a: string) => {
    const e = document.querySelector<HTMLElement>(a);
    if (!e) return { da: false, gesperrt: false, wert: '', text: '' };
    return {
      da: true,
      gesperrt: (e as HTMLButtonElement).disabled === true,
      wert: (e as HTMLInputElement).value ?? '',
      text: e.textContent ?? '',
    };
  },
  abschnitte: () => [...document.querySelectorAll<HTMLElement>('section')].map((s) => s.dataset.abschnitt ?? ''),
};

/**
 * Farben durchreichen (11.08.): dieselbe Mechanik wie im Einstellungsfenster
 * und im Hauptfenster -- `data-thema` traegt den aufgeloesten Wert, nie
 * 'system'. Diese Seite hat keine Zustandsmarken, also nur die erste Haelfte.
 */
function themaAnwenden(d: ThemaPayload): void {
  document.documentElement.dataset.thema = d.wirksam;
}
window.awbVerbrauch.onThema(themaAnwenden);
void window.awbVerbrauch.thema().then(themaAnwenden);

void (async () => {
  setzeSprache(await window.awbVerbrauch.sprache());
  kopfzeileBeschriften();
  await laden();
  window.awbVerbrauch.bereit();
})();
