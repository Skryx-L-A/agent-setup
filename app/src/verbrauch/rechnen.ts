// Die Rechenlogik der Verbrauchsseite. KEIN DOM, kein Electron, kein Dateisystem.
//
// WARUM GETRENNT. Alles, was diese Seite an Zahlen behauptet -- Summen, Filter, Anteile, der
// Vergleich zweier Zeitraeume, die Wahl der Achse -- ist eine reine Umformung dessen, was
// `wb-budget --json` liefert. Genau das muss pruefbar sein, ohne ein Fenster zu bauen: eine
// falsche Summe faellt an einer Zusage auf, nie an einem Bild. Gezeichnet wird in verbrauch.ts,
// gerechnet nur hier.
//
// UND: HIER WIRD NICHTS NACHGERECHNET, WAS wb-budget SCHON WEISS. Preise, Raten, Luecken und
// Quellenzustaende kommen fertig herein; diese Datei waehlt aus, summiert und formatiert. Eine
// zweite Preistabelle oder eine zweite Vorstellung davon, was eine Naeherung ist, waere genau
// die Stelle, an der Werkzeug und Anzeige auseinanderlaufen.

// --- Die Form dessen, was wb-budget --json liefert ------------------------------------------

export interface Werte {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  reasoning: number;
  nachrichten: number;
  /** input + output + cache_write. Cache-Lesen bleibt draussen, siehe `cacheAchse`. */
  ohne_cache_read: number;
}

export interface Tempo {
  /** null heisst: fuer dieses Modell laesst sich keine Rate bilden. Nie 0 statt null. */
  wert: number | null;
  art: 'gemessen' | 'naeherung' | 'unbekannt';
  /** Der Satz von wb-budget selbst, warum diese Zahl so gut ist, wie sie ist. */
  grund: string;
  sekunden?: number;
}

export interface Preis {
  usd: number | null;
  art: 'abo-aequivalent' | 'katalogpreis' | 'harness-angabe' | 'kein-preis';
  quelle: string;
  /** true = dieser Betrag wurde NIE abgebucht (Abo oder lokales Modell). */
  nie_abgebucht: boolean | null;
}

export interface ModellZeile extends Werte {
  harness: string;
  modell: string;
  tempo: Tempo;
  preis: Preis;
  /** Copilots eigene Abrechnungseinheit, nur wo sie mitgeschrieben wird. */
  aiu?: number;
}

export interface HarnessZeile extends Werte {
  harness: string;
}

export interface SitzungZeile extends Werte {
  harness: string;
  sitzung: string;
  worker: string;
  ordner: string;
  modelle: string[];
  von: string;
  bis: string;
}

export interface TagZeile extends Werte {
  tag: string;
  harness: string;
  modell: string;
}

export interface QuelleZeile {
  harness: string;
  pfad: string;
  zustand: 'gelesen' | 'leer' | 'fehlt' | 'unlesbar';
  nachrichten: number;
  hinweis: string;
}

export interface LueckeZeile {
  harness: string;
  grund: string;
}

export interface LimitPunkt {
  ts: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_resets_at: string | null;
  seven_day_resets_at: string | null;
  letzter?: boolean;
}

export interface Verbrauch {
  erzeugt: string;
  fenster: { von: string; bis: string; tage: number };
  filter: { harness: string[]; modell: string[]; sitzung: string[] };
  gesamt: Werte;
  je_harness: HarnessZeile[];
  je_modell: ModellZeile[];
  je_sitzung: SitzungZeile[];
  je_tag: TagZeile[];
  limits: LimitPunkt[];
  kontingent: Record<string, unknown>;
  quellen: QuelleZeile[];
  luecken: LueckeZeile[];
}

/** Was das Fenster vom Hauptprozess bekommt: entweder Daten oder ein Grund. */
export interface VerbrauchsAntwort {
  ok: boolean;
  fehler: string;
  daten: Verbrauch | null;
}

// --- Lesen und Summieren ---------------------------------------------------------------------

const ARTEN = ['input', 'output', 'cache_write', 'cache_read', 'reasoning'] as const;

export function leereWerte(): Werte {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, reasoning: 0, nachrichten: 0, ohne_cache_read: 0 };
}

/**
 * Die Ausgabe von `wb-budget --json` einlesen.
 *
 * Streng: fehlt eines der Felder, auf denen die Seite steht, gibt es `null` und keinen
 * halbleeren Bericht. Eine Seite, die aus einem unerwarteten Text eine 0 macht, behauptet
 * "nichts verbraucht", wo "nicht gelesen" richtig waere -- derselbe Unterschied, den `parseBudget`
 * schon einmal gekostet hat.
 */
export function parseVerbrauch(roh: string): Verbrauch | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  const pflicht = ['gesamt', 'je_harness', 'je_modell', 'je_sitzung', 'je_tag', 'quellen', 'luecken', 'fenster'];
  for (const f of pflicht) if (!(f in o)) return null;
  return o as unknown as Verbrauch;
}

/**
 * Die Summe ohne Cache-Lesen -- aus dem Datensatz, wenn sie darin steht, sonst gerechnet.
 *
 * Der Rueckfall ist kein Schmuck: am 11.08. fehlte das Feld in `je_modell`, und die Tabelle
 * zeigte in ihrer wichtigsten Spalte "NaN", waehrend die Kacheln darueber stimmten -- weil die
 * Kacheln summieren und die Tabelle das Feld las. Eine fehlende Zahl darf zu einer gerechneten
 * werden; sie darf nie zu einem NaN auf dem Bildschirm werden.
 */
export function ohneCacheRead(w: Werte): number {
  return Number.isFinite(w.ohne_cache_read) ? w.ohne_cache_read : (w.input || 0) + (w.output || 0) + (w.cache_write || 0);
}

export function summiere(zeilen: Werte[]): Werte {
  const s = leereWerte();
  for (const z of zeilen) {
    for (const a of ARTEN) s[a] += z[a] || 0;
    s.nachrichten += z.nachrichten || 0;
  }
  s.ohne_cache_read = s.input + s.output + s.cache_write;
  return s;
}

// --- Filter ----------------------------------------------------------------------------------

export interface Auswahl {
  /** Leer heisst: alle. Nie als "keine" gelesen -- eine leere Auswahl ist keine Einschraenkung. */
  harness: string[];
  modell: string[];
}

export function leereAuswahl(): Auswahl {
  return { harness: [], modell: [] };
}

function trifft(auswahl: string[], wert: string): boolean {
  return auswahl.length === 0 || auswahl.indexOf(wert) >= 0;
}

/** Harness UND Modell zugleich: die Auswahlen schneiden sich, sie addieren sich nicht. */
export function filterModelle(zeilen: ModellZeile[], a: Auswahl): ModellZeile[] {
  return zeilen.filter((z) => trifft(a.harness, z.harness) && trifft(a.modell, z.modell));
}

export function filterTage(zeilen: TagZeile[], a: Auswahl): TagZeile[] {
  return zeilen.filter((z) => trifft(a.harness, z.harness) && trifft(a.modell, z.modell));
}

/**
 * Eine Sitzung faehrt oft mehrere Modelle. Sie zaehlt mit, sobald EINES der gewaehlten dabei
 * ist -- ihre Zahlen bleiben dabei die der ganzen Sitzung, weil `wb-budget` sie nicht je Modell
 * aufschluesselt. Genau das sagt `sitzungenTeilweise` weiter, damit die Anzeige es hinschreiben
 * kann, statt eine genauere Zahl vorzutaeuschen.
 */
export function filterSitzungen(zeilen: SitzungZeile[], a: Auswahl): SitzungZeile[] {
  return zeilen.filter(
    (z) => trifft(a.harness, z.harness) && (a.modell.length === 0 || z.modelle.some((m) => a.modell.indexOf(m) >= 0)),
  );
}

/** Sind unter den gezeigten Sitzungen welche, die auch nicht gewaehlte Modelle enthalten? */
export function sitzungenTeilweise(zeilen: SitzungZeile[], a: Auswahl): boolean {
  if (a.modell.length === 0) return false;
  return zeilen.some((z) => z.modelle.some((m) => a.modell.indexOf(m) < 0));
}

/** Aus den Modellzeilen die Liste der Harnesses, die ueberhaupt etwas verbraucht haben. */
export function harnessAuswahlliste(zeilen: ModellZeile[]): { id: string; tokens: number }[] {
  const m = new Map<string, number>();
  for (const z of zeilen) m.set(z.harness, (m.get(z.harness) ?? 0) + ohneCacheRead(z));
  return [...m.entries()]
    .map(([id, tokens]) => ({ id, tokens }))
    .sort((x, y) => y.tokens - x.tokens || x.id.localeCompare(y.id));
}

/**
 * Die Modelle zur Wahl. Sie folgen der HARNESS-Auswahl, nicht der eigenen: wer „nur codex"
 * gewaehlt hat, soll nicht zwischen achtzig Claude-Modellen suchen. Die eigene Auswahl darf die
 * Liste dagegen nie kuerzen, sonst verschwindet der einzige Weg, sie wieder aufzuheben.
 */
export function modellAuswahlliste(zeilen: ModellZeile[], a: Auswahl): { id: string; harness: string; tokens: number }[] {
  const m = new Map<string, { harness: string; tokens: number }>();
  for (const z of zeilen) {
    if (!trifft(a.harness, z.harness)) continue;
    const da = m.get(z.modell);
    if (da) da.tokens += ohneCacheRead(z);
    else m.set(z.modell, { harness: z.harness, tokens: ohneCacheRead(z) });
  }
  return [...m.entries()]
    .map(([id, w]) => ({ id, harness: w.harness, tokens: w.tokens }))
    .sort((x, y) => y.tokens - x.tokens || x.id.localeCompare(y.id));
}

// --- Cache-Lesen: die Achsenfrage -------------------------------------------------------------

/**
 * Gemessen am 11.08.: im 7-Tage-Fenster stehen 14,4 Milliarden Cache-Lesetoken gegen 258
 * Millionen aller uebrigen -- rund 56 zu 1. Auf einer gemeinsamen linearen Achse ist alles
 * andere ein Strich am unteren Rand. Ab diesem Verhaeltnis wird deshalb GETRENNT gezeichnet.
 *
 * Vier ist keine willkuerliche Zahl, sondern die Grenze, ab der der kleinere Posten weniger als
 * ein Fuenftel der Hoehe bekommt und seine Unterschiede nicht mehr ablesbar sind. Unterhalb
 * davon traegt eine gemeinsame Achse noch, und zwei Diagramme waeren zwei halbleere.
 */
export const CACHE_SCHWELLE = 4;

export interface AchsenPlan {
  art: 'getrennt' | 'gemeinsam';
  /** Cache-Lesen geteilt durch alles uebrige. 0, wenn nichts uebriges da ist. */
  verhaeltnis: number;
}

export function cacheAchse(w: Werte): AchsenPlan {
  const rest = w.ohne_cache_read || w.input + w.output + w.cache_write;
  if (w.cache_read <= 0) return { art: 'gemeinsam', verhaeltnis: 0 };
  if (rest <= 0) return { art: 'getrennt', verhaeltnis: Infinity };
  const v = w.cache_read / rest;
  return { art: v >= CACHE_SCHWELLE ? 'getrennt' : 'gemeinsam', verhaeltnis: v };
}

// --- Tagesverlauf ------------------------------------------------------------------------------

export interface TagesSumme {
  tag: string;
  ohne_cache_read: number;
  cache_read: number;
  input: number;
  output: number;
  cache_write: number;
}

/**
 * Die gefilterten Tageszeilen zu einer Reihe je Tag verdichten -- LUECKENLOS. Ein Tag ohne
 * Verbrauch bekommt eine Null und faellt nicht aus der Reihe: sonst stuenden zwei Balken
 * nebeneinander, zwischen denen drei stille Tage lagen, und die Kurve loege eine Stetigkeit,
 * die es nicht gab.
 */
export function tagesreihe(zeilen: TagZeile[], vonISO: string, bisISO: string): TagesSumme[] {
  const proTag = new Map<string, TagesSumme>();
  for (const z of zeilen) {
    const e = proTag.get(z.tag) ?? { tag: z.tag, ohne_cache_read: 0, cache_read: 0, input: 0, output: 0, cache_write: 0 };
    e.ohne_cache_read += ohneCacheRead(z);
    e.cache_read += z.cache_read || 0;
    e.input += z.input || 0;
    e.output += z.output || 0;
    e.cache_write += z.cache_write || 0;
    proTag.set(z.tag, e);
  }
  const von = Date.parse(vonISO);
  const bis = Date.parse(bisISO);
  if (!Number.isFinite(von) || !Number.isFinite(bis) || bis < von) {
    return [...proTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }
  const raus: TagesSumme[] = [];
  for (let t = Date.UTC(new Date(von).getUTCFullYear(), new Date(von).getUTCMonth(), new Date(von).getUTCDate()); t <= bis; t += 86400000) {
    const tag = new Date(t).toISOString().slice(0, 10);
    raus.push(proTag.get(tag) ?? { tag, ohne_cache_read: 0, cache_read: 0, input: 0, output: 0, cache_write: 0 });
  }
  return raus;
}

// --- Balken- und Liniengeometrie (reine Zahlen, kein SVG-Knoten) --------------------------------

export interface Balken {
  x: number;
  breite: number;
  /** Von unten nach oben gestapelt; y ist die Oberkante, hoehe die Laenge. */
  stapel: { y: number; hoehe: number; art: string }[];
  beschriftung: string;
  summe: number;
}

/**
 * Gestapelte Balken. Die Skala kommt von aussen (`hoechstwert`), damit zwei Diagramme
 * nebeneinander dieselbe Achse teilen koennen, wenn sie sollen -- und ausdruecklich nicht
 * muessen, wenn Cache-Lesen dabei ist.
 */
export function balken(
  reihen: { beschriftung: string; teile: { wert: number; art: string }[] }[],
  breite: number,
  hoehe: number,
  hoechstwert?: number,
): { balken: Balken[]; hoechstwert: number } {
  const summen = reihen.map((r) => r.teile.reduce((s, t) => s + Math.max(0, t.wert), 0));
  const max = hoechstwert !== undefined ? hoechstwert : Math.max(1, ...summen);
  const schritt = reihen.length > 0 ? breite / reihen.length : breite;
  const balkenBreite = Math.max(1, schritt * 0.7);
  const raus = reihen.map((r, i) => {
    let unten = hoehe;
    const stapel = r.teile.map((teil) => {
      const h = max > 0 ? (Math.max(0, teil.wert) / max) * hoehe : 0;
      unten -= h;
      return { y: unten, hoehe: h, art: teil.art };
    });
    return {
      x: i * schritt + (schritt - balkenBreite) / 2,
      breite: balkenBreite,
      stapel,
      beschriftung: r.beschriftung,
      summe: summen[i],
    };
  });
  return { balken: raus, hoechstwert: max };
}

// --- Der Weg zum Limit --------------------------------------------------------------------------

export interface LimitPunktXY {
  t: number;
  pct: number;
}

export interface LimitVerlauf {
  /** Je Abschnitt zwischen zwei Ruecksetzpunkten eine eigene Linie -- nie ueber den Sprung hinweg. */
  segmente: LimitPunktXY[][];
  /** Die Zeitpunkte, an denen der Wert zurueckfiel. */
  ruecksetzpunkte: number[];
  von: number;
  bis: number;
  hoechstwert: number;
  /** Der zuletzt geloggte Stand, oder null. */
  zuletzt: number | null;
  /** Wann das Fenster laut Log als naechstes zurueckfaellt (Epoche in ms), oder null. */
  naechsterReset: number | null;
}

/**
 * Aus den geloggten Prozentstaenden eine Zeitachse mit dem Ruecksetzpunkt.
 *
 * EIN RUECKFALL TRENNT, ER VERBINDET NICHT. Zoege man eine Linie ueber den Sprung von 94 auf 3
 * Prozent hinweg, saehe es aus wie ein Verbrauch, der in Sekunden verschwand. Deshalb endet dort
 * ein Abschnitt und ein neuer beginnt -- dieselbe Regel, nach der `--limit-kalibrierung` nie
 * ueber einen Reset hinweg rechnet.
 *
 * `toleranz` faengt das Rauschen ab, das entsteht, weil alle laufenden Sitzungen in dieselbe
 * Datei schreiben und dabei zeitversetzte Staende sehen: ein Rueckfall zaehlt erst ab der
 * Haelfte des bisherigen Spitzenwerts als echt, genauso wie in wb-budget.
 */
export function limitVerlauf(punkte: LimitPunkt[], feld: 'five_hour_pct' | 'seven_day_pct'): LimitVerlauf {
  const resetFeld = feld === 'five_hour_pct' ? 'five_hour_resets_at' : 'seven_day_resets_at';
  const segmente: LimitPunktXY[][] = [];
  const ruecksetzpunkte: number[] = [];
  let laufend: LimitPunktXY[] = [];
  let spitze = 0;
  let zuletzt: number | null = null;
  let naechsterReset: number | null = null;
  let von = Infinity;
  let bis = -Infinity;
  let hoechstwert = 0;

  for (const p of punkte) {
    const wert = p[feld];
    const t = Date.parse(p.ts);
    if (wert === null || wert === undefined || !Number.isFinite(t)) continue;
    von = Math.min(von, t);
    bis = Math.max(bis, t);
    hoechstwert = Math.max(hoechstwert, wert);
    if (laufend.length > 0 && wert < spitze / 2) {
      segmente.push(laufend);
      ruecksetzpunkte.push(t);
      laufend = [];
      spitze = 0;
    }
    laufend.push({ t, pct: wert });
    spitze = Math.max(spitze, wert);
    zuletzt = wert;
    const roh = p[resetFeld];
    if (roh) {
      // Das Log fuehrt den Ruecksetzpunkt mal als Epochensekunden, mal als ISO-Zeit.
      const zahl = Number(roh);
      const ms = Number.isFinite(zahl) && zahl > 1e9 ? zahl * 1000 : Date.parse(String(roh));
      if (Number.isFinite(ms)) naechsterReset = ms;
    }
  }
  if (laufend.length > 0) segmente.push(laufend);
  return {
    segmente,
    ruecksetzpunkte,
    von: Number.isFinite(von) ? von : 0,
    bis: Number.isFinite(bis) ? bis : 0,
    hoechstwert: Math.max(hoechstwert, 100),
    zuletzt,
    naechsterReset,
  };
}

/** Eine Linie als SVG-Pfad. Leere Eingabe ergibt einen leeren Pfad, nie ein `NaN` im Attribut. */
export function linienPfad(punkte: LimitPunktXY[], von: number, bis: number, hoechstwert: number, breite: number, hoehe: number): string {
  if (punkte.length === 0) return '';
  const spanne = bis - von || 1;
  const teile = punkte.map((p, i) => {
    const x = ((p.t - von) / spanne) * breite;
    const y = hoehe - (p.pct / (hoechstwert || 100)) * hoehe;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return teile.join(' ');
}

// --- Kosten: zwei Groessen, nie eine Zahl ---------------------------------------------------------

export interface KostenBild {
  /** Was nie abgebucht wurde -- der hypothetische API-Gegenwert der Abo-Nutzung. */
  aequivalent: number;
  /** Listenpreise echter Cloud-Anbieter, plus was ein Harness selbst gerechnet hat. */
  katalog: number;
  /** Copilots eigene Abrechnungseinheit. */
  aiu: number;
  /** Modelle, fuer die kein Preis bekannt ist -- sie fallen nie unter den Tisch. */
  ohnePreis: string[];
}

/**
 * Die beiden Betraege getrennt aufsummieren. EINE Zahl waere falsch: ein API-Aequivalent hat
 * einen anderen Nenner als ein Listenpreis, und keiner von beiden ist das Kontingent, das
 * tatsaechlich verbraucht wurde.
 */
export function kostenBild(zeilen: ModellZeile[]): KostenBild {
  const raus: KostenBild = { aequivalent: 0, katalog: 0, aiu: 0, ohnePreis: [] };
  for (const z of zeilen) {
    if (z.aiu) raus.aiu += z.aiu;
    const p = z.preis;
    if (!p || p.usd === null || p.usd === undefined) {
      if (ohneCacheRead(z) > 0) raus.ohnePreis.push(`${z.harness}/${z.modell}`);
      continue;
    }
    if (p.art === 'kein-preis') {
      if (ohneCacheRead(z) > 0 && p.usd === 0 && p.nie_abgebucht !== true) raus.ohnePreis.push(`${z.harness}/${z.modell}`);
      continue;
    }
    if (p.nie_abgebucht === true) raus.aequivalent += p.usd;
    else raus.katalog += p.usd;
  }
  return raus;
}

// --- Vergleich zweier Zeitraeume -------------------------------------------------------------------

export interface VergleichsZeile {
  schluessel: string;
  jetzt: number;
  vorher: number;
  differenz: number;
  /** null, wenn vorher 0 war -- ein Prozentwert waere dort eine Division durch null. */
  prozent: number | null;
  richtung: 'mehr' | 'weniger' | 'gleich';
}

function vergleichsZeile(schluessel: string, jetzt: number, vorher: number): VergleichsZeile {
  const differenz = jetzt - vorher;
  return {
    schluessel,
    jetzt,
    vorher,
    differenz,
    prozent: vorher === 0 ? null : (differenz / vorher) * 100,
    richtung: differenz > 0 ? 'mehr' : differenz < 0 ? 'weniger' : 'gleich',
  };
}

/** Die Summen zweier Zeitraeume Posten fuer Posten nebeneinander. */
export function vergleicheWerte(jetzt: Werte, vorher: Werte): VergleichsZeile[] {
  const felder: (keyof Werte)[] = ['ohne_cache_read', 'input', 'output', 'cache_write', 'cache_read', 'nachrichten'];
  return felder.map((f) => vergleichsZeile(String(f), jetzt[f] || 0, vorher[f] || 0));
}

/**
 * Dasselbe je Harness. Ein Harness, der nur in EINEM der beiden Zeitraeume vorkommt, steht
 * trotzdem da -- mit 0 auf der anderen Seite. Ihn wegzulassen hiesse, genau die Aenderung zu
 * verschweigen, wegen der jemand vergleicht.
 */
export function vergleicheHarnesses(jetzt: HarnessZeile[], vorher: HarnessZeile[]): VergleichsZeile[] {
  const a = new Map(jetzt.map((z) => [z.harness, z.ohne_cache_read]));
  const b = new Map(vorher.map((z) => [z.harness, z.ohne_cache_read]));
  const alle = [...new Set([...a.keys(), ...b.keys()])].sort();
  return alle
    .map((h) => vergleichsZeile(h, a.get(h) ?? 0, b.get(h) ?? 0))
    .sort((x, y) => Math.abs(y.differenz) - Math.abs(x.differenz));
}

/**
 * Der gleich lange Zeitraum unmittelbar davor. Gleich LANG, nicht „die Woche davor" -- wer drei
 * Tage ansieht, vergleicht mit den drei Tagen davor, sonst vergleicht er Ungleiches.
 */
export function vorherigerZeitraum(vonISO: string, bisISO: string): { von: string; bis: string } | null {
  const von = Date.parse(vonISO);
  const bis = Date.parse(bisISO);
  if (!Number.isFinite(von) || !Number.isFinite(bis) || bis <= von) return null;
  const dauer = bis - von;
  return { von: new Date(von - dauer).toISOString(), bis: new Date(von).toISOString() };
}

// --- Darstellung von Zahlen (keine DOM-Beruehrung) ---------------------------------------------

/** Kurzform fuer enge Stellen: 14,4 Mrd. statt 14448108175. */
export function kompakt(n: number): string {
  const z = Math.abs(n);
  if (z >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace('.', ',')} Mrd.`;
  if (z >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} Mio.`;
  if (z >= 1_000) return `${(n / 1_000).toFixed(1).replace('.', ',')}k`;
  return String(Math.round(n));
}

/** Die volle Zahl mit Punkten, fuer Tabellen und Titel. */
export function zahl(n: number): string {
  return Math.round(n).toLocaleString('de-DE');
}

export function usd(n: number): string {
  return `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

export function prozent(n: number): string {
  return `${n.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} %`;
}

/** Ein Zeitpunkt, wie ihn ein Mensch liest -- Ortszeit, weil er auf eine Uhr sieht. */
export function zeitpunkt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}
