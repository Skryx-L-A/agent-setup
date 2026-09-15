// Die EINE gemeinsame Stelle fuer Thema und Zustandsfarben, gebraucht von allen
// Fenstern ausser dem Einstellungsfenster (das zieht seine eigene, bereits
// bestehende Anwendung nicht hierher um -- siehe der Auftrag). Reine Logik,
// OHNE 'electron'-Import: dieselbe Bauform wie `einstellungen.ts`, damit sich
// die Datei wie `dist/test/einstellungen.mjs` als eigenes Buendel bauen und mit
// blossem `node` pruefen laesst (build.mjs, `test/thema.mjs`). Die duenne
// electron-Seite -- `nativeTheme` lesen, den IPC-Kanal registrieren, an die
// Fenster senden -- steht bewusst NICHT hier, sondern in main.ts: sie ist zu
// klein, um eine zweite, nicht pruefbare Datei zu rechtfertigen.
import { VORGABEN, thema as themaGesetzt, zustandsfarben as zustandsfarbenGesetzt } from './einstellungen';

export type Wirksam = 'hell' | 'dunkel';

// --- Rollen: DAS Token-System, hell UND dunkel, an dieser einen Stelle -----
//
// Jede Rolle ist eine macOS-semantische Flaeche oder Schrift (Fenstergrund,
// Inhaltsgrund, Trennlinie, Primaertext, Sekundaertext, Auswahl, Akzent --
// nie ein VSCode-Name). Die Werte HIER sind die, die bisher fuenffach in
// jedem Fenster-HTML standen (renderer/, einstellungen/, sitzung/, verbrauch/,
// erststart/index.html) und dabei staendig auseinanderliefen -- wer eine Farbe
// aendert, aendert sie ab jetzt genau einmal. `main/seiten.ts` (der Schein fuer
// die uebernommenen VSCode-Seiten) und `build.mjs` (die statische
// `thema/tokens.css` fuer die fuenf Fenster) lesen beide von hier, keiner
// schreibt einen eigenen Hex-Wert.
export type Rollenname =
  | 'fenster' | 'grund' | 'leiste' | 'linie' | 'schrift' | 'gedaempft' | 'wahl' | 'tinte'
  | 'fern' | 'laeuft' | 'will' | 'aus' | 'erhoben' | 'vorsichtgrund';

interface RollenFarbe { hell: string; dunkel: string }

/**
 * `grund` ist die BASE-Ebene (HIG Dark Mode: "base", tritt zurueck), `erhoben`
 * die ELEVATED-Ebene (heller/vorne -- Chips, Hover, eingebettete Kacheln).
 * `leiste` ist die dritte, mittlere Flaeche fuer Seitenleiste/Werkzeugleiste.
 * Alle drei Ebenen zusammen sind die Tiefenstaffelung, die die HIG verlangt.
 */
export const ROLLEN: Record<Rollenname, RollenFarbe> = {
  /**
   * DER FENSTERGRUND, unter allem (04.09.2026). Er ist NICHT `grund`: die
   * Karten der Oberflaeche -- linke Leiste, Inhaltsflaeche, Inspektor,
   * Statusleiste -- liegen auf `grund`/`leiste`, und zwischen ihnen blitzt
   * diese Flaeche als vier Bildpunkte breite Fuge durch. Genau daran
   * unterscheidet sich ein Mac-Programm von einer randlosen Flaeche mit
   * Gitternetz: die Trennung entsteht aus Flaeche gegen Flaeche.
   *
   * Er muss deshalb in BEIDEN Themen DUNKLER sein als jede Karte darauf.
   * Dunkel: #0b0d10 gegen `grund` #101216 -- ein Schritt unter der
   * Basis-Ebene, den die HIG fuer den Fensterhintergrund vorsieht. Hell:
   * #dfe2e7 gegen die weissen Karten (#ffffff) und `leiste` (#f4f5f7); ein
   * hellerer Wert liesse die Fuge im hellen Thema verschwinden, und die
   * Gestalt haette nur ein Thema.
   */
  fenster: { dunkel: '#0b0d10', hell: '#dfe2e7' },
  grund: { dunkel: '#101216', hell: '#ffffff' },
  leiste: { dunkel: '#171a20', hell: '#f4f5f7' },
  erhoben: { dunkel: '#1e232b', hell: '#eceef2' },
  linie: { dunkel: '#262b34', hell: '#d8dbe1' },
  schrift: { dunkel: '#d8dee9', hell: '#1b1f27' },
  gedaempft: { dunkel: '#8b93a1', hell: '#5c6472' },
  wahl: { dunkel: '#222833', hell: '#e4e8f4' },
  tinte: { dunkel: '#05070a', hell: '#ffffff' },
  /* DIESE VIER SIND NICHT DIE ZUSTANDSFARBEN (klargestellt 08.09.2026, weil die
     Namen dieselben sind und ein Leser sie zwangslaeufig verwechselt).
     `fern/laeuft/will/aus` hier sind der feste Akzent der UMGEBUNG: der
     Unterstrich am gewaehlten Editor-Tab (`--laeuft`), der linke Rand einer
     Antragskarte (`--fern`) und einer angehaltenen Freigabe (`--will`), die
     Schrift einer Fehlerzeile (`--aus`). Sie sind nicht einstellbar.
     Die Punkte in der Leiste lesen dagegen `--zustand-laeuft` und die drei
     anderen; die kommen aus `VORGABEN.zustandsfarben` (einstellungen.ts), der
     Mensch waehlt sie unter „Aussehen", und `zustandsblock()` weiter unten
     schreibt sie. Wer die Punktfarbe aendern will, aendert DORT -- hier
     aendert er den Editor-Tab. Die Mac-Fassung liest ebenfalls die
     Zustandsfarben (mac/Sources/WerkbankProtokoll/Thema.swift). */
  fern: { dunkel: '#6a7fd0', hell: '#3355c4' },
  laeuft: { dunkel: '#46a758', hell: '#22803c' },
  will: { dunkel: '#e0a020', hell: '#9a6600' },
  /* Dunkel am 03.09. von #d24c4c auf #d85858 aufgehellt: der alte Wert trug auf
     `grund` nur 4,36 und auf `vorsichtgrund` 4,25 und blieb damit unter der
     eigenen MINDESTKONTRAST-Schwelle dieser Datei. Der neue traegt 4,87 / 4,75,
     bei gleichem Farbton -- nur die Helligkeit ist gewichen, dieselbe Regel,
     die `lesbareFarbe` auf die Farben des Menschen anwendet. */
  aus: { dunkel: '#d85858', hell: '#b3261e' },
  /** Die Flaeche einer Warn-/Fehlerzeile -- vorher zweimal (einstellungen/index.html, renderer/index.html), leicht auseinandergelaufen. */
  vorsichtgrund: { dunkel: '#1a1315', hell: '#fdf2f1' },
};

/** Der Wert einer Rolle im aufgeloesten Thema. */
export function rolle(name: Rollenname, wirksam: Wirksam): string {
  return ROLLEN[name][wirksam];
}

/**
 * 'system' aufgeloest. Kein Rateversuch beim Start: der Aufrufer reicht den
 * LEBENDEN Wert von `nativeTheme.shouldUseDarkColors` durch, jedesmal neu
 * gelesen -- bei jeder Anfrage, bei jeder Einstellungsaenderung und beim
 * `nativeTheme`-Ereignis 'updated'. 'hell' und 'dunkel' sind ausdrueckliche
 * Wahlen und ignorieren das Betriebssystem vollstaendig.
 */
export function wirksamesThema(gesetzt: string, systemIstDunkel: boolean): Wirksam {
  if (gesetzt === 'hell') return 'hell';
  if (gesetzt === 'dunkel') return 'dunkel';
  return systemIstDunkel ? 'dunkel' : 'hell';
}

// --- Kontrast (WCAG 2.x, relative Luminanz) ---------------------------------

function hexZuRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function kanalLinear(kanal255: number): number {
  const c = kanal255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminanz(hex: string): number {
  const [r, g, b] = hexZuRgb(hex);
  return 0.2126 * kanalLinear(r) + 0.7152 * kanalLinear(g) + 0.0722 * kanalLinear(b);
}

/** Das Kontrastverhaeltnis zweier Farben, immer >= 1. */
export function kontrastVerhaeltnis(a: string, b: string): number {
  const la = relativeLuminanz(a);
  const lb = relativeLuminanz(b);
  const hell = Math.max(la, lb);
  const dunkel = Math.min(la, lb);
  return (hell + 0.05) / (dunkel + 0.05);
}

function rgbZuHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslZuHex(h: number, s: number, l: number): string {
  const lc = Math.min(1, Math.max(0, l));
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = lc;
  } else {
    const q = lc < 0.5 ? lc * (1 + s) : lc + s - lc * s;
    const p = 2 * lc - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const kanal = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${kanal(r)}${kanal(g)}${kanal(b)}`;
}

/** WCAG AA fuer normalen Text -- dieselbe Schwelle, die der Kommentar in renderer/index.html schon nennt. */
export const MINDESTKONTRAST = 4.5;

/** Die Grundflaeche je Thema -- dieselben Werte wie `--grund` in jedem Fenster. */
const GRUND_HELL = '#ffffff';
const GRUND_DUNKEL = '#101216';

/**
 * Eine vom Menschen frei gewaehlte Farbe, lesbar gemacht auf der Grundflaeche
 * DIESES Themas. Angefasst wird nur die HELLIGKEIT (HSL), nie Farbton oder
 * Saettigung -- wer Blau fuer "laeuft" waehlt, sieht in beiden Themen Blau,
 * nur in einer Abstufung, die auf dem jeweiligen Grund zu lesen ist. Reicht
 * die gewaehlte Farbe schon, kommt sie unveraendert zurueck.
 *
 * Die Regel in einem Satz: im hellen Thema wird dunkler geschraubt, im
 * dunklen heller -- solange bis der Kontrast zur Grundflaeche 4,5 erreicht
 * oder der Rand (fast Schwarz/fast Weiss) es nicht mehr hergibt.
 *
 * `flaeche` verschiebt den Bezugspunkt weg von `--grund`: eine Farbe, die auch
 * auf einer ANDEREN Flaeche des Themas landen kann, wird gegen die
 * ungünstigere von beiden gemessen. Gebraucht fuer `akzentText`, der nicht nur
 * auf dem Fenstergrund steht, sondern auch auf `--wahl` (die ausgewaehlte
 * Kachel in erststart/ und verbrauch/). Ohne das Argument bleibt alles wie
 * bisher -- die vier Zustandsfarben messen weiter gegen den Grund.
 */
export function lesbareFarbe(hex: string, wirksam: Wirksam, flaeche?: string): string {
  const grund = flaeche ?? (wirksam === 'hell' ? GRUND_HELL : GRUND_DUNKEL);
  if (kontrastVerhaeltnis(hex, grund) >= MINDESTKONTRAST) return hex;
  const [r, g, b] = hexZuRgb(hex);
  const [h, s] = rgbZuHsl(r, g, b);
  let l = rgbZuHsl(r, g, b)[2];
  const schritt = wirksam === 'hell' ? -0.04 : 0.04;
  for (let i = 0; i < 24; i++) {
    l += schritt;
    if (l <= 0.02 || l >= 0.98) break;
    const kandidat = hslZuHex(h, s, l);
    if (kontrastVerhaeltnis(kandidat, grund) >= MINDESTKONTRAST) return kandidat;
  }
  // Grenzfall (z. B. eine Farbe fast ohne Saettigung): der Rand traegt den
  // Kontrast in jedem Fall, auch wenn er keine Farbe mehr zeigt.
  return wirksam === 'hell' ? '#000000' : '#ffffff';
}

/**
 * Alle vier Zustandsfarben, je einzeln lesbar gemacht -- ein Ausreisser reisst
 * die anderen drei nicht mit.
 *
 * GEMESSEN WIRD GEGEN `erhoben`, NICHT GEGEN `grund` (03.09.2026, Prueferbefund
 * 4). Ein Zustandspunkt steht nirgends auf der blossen Fensterflaeche: im Baum
 * liegt er auf `leiste`, auf einer ueberfahrenen Zeile und auf jeder Kachel auf
 * `erhoben`. `erhoben` ist von diesen dreien in BEIDEN Themen die
 * unguenstigste -- im hellen die dunkelste (#eceef2 gegen #f4f5f7 und
 * #ffffff), im dunklen die hellste (#1e232b gegen #171a20 und #101216) --,
 * und wer gegen die unguenstigste rechnet, hat die uebrigen mit erledigt.
 *
 * Vorher stand hier der blosse Grund, und die Zahl im Ergebnis hielt gegen die
 * Flaeche, auf der die Punkte wirklich liegen, nicht: hell trugen zwei der vier
 * auf `leiste` und alle vier auf `erhoben` weniger als 4,5.
 */
export function zustandsfarbenLesbar(farben: Record<string, string>, wirksam: Wirksam): Record<string, string> {
  const raus: Record<string, string> = {};
  for (const [zustand, farbe] of Object.entries(farben)) {
    raus[zustand] = lesbareFarbe(farbe, wirksam, ROLLEN.erhoben[wirksam]);
  }
  return raus;
}

const TINTE_DUNKEL = '#05070a';
const TINTE_HELL = '#ffffff';

/**
 * Die Tinte fuer eine gefuellte Flaeche in genau dieser Farbe (renderer/index.html,
 * `.kuerzel`: die Zustandsfarbe als Flaeche, zwei Buchstaben Schrift darauf).
 * Hier zaehlt NICHT der Kontrast zur Fensterflaeche wie bei `lesbareFarbe`,
 * sondern der zur Farbe selbst -- deshalb die eigene, kleinere Funktion: sie
 * nimmt einfach die von beiden Tinten (fast Schwarz, fast Weiss), die auf DIESER
 * Flaeche mehr Kontrast traegt.
 */
export function tinteFuer(hex: string): string {
  return kontrastVerhaeltnis(TINTE_DUNKEL, hex) >= kontrastVerhaeltnis(TINTE_HELL, hex) ? TINTE_DUNKEL : TINTE_HELL;
}

/** Alle vier Tinten, passend zu den (bereits lesbar gemachten) Zustandsfarben. */
export function zustandsfarbenTinte(farbenLesbar: Record<string, string>): Record<string, string> {
  const raus: Record<string, string> = {};
  for (const [zustand, farbe] of Object.entries(farbenLesbar)) raus[zustand] = tinteFuer(farbe);
  return raus;
}

// --- Akzent: die Systemfarbe des Menschen, nicht eine erfundene Markenfarbe -

/**
 * Apples eigene Vorgabe fuer `NSColor.controlAccentColor` (Systemblau), je
 * Thema -- NUR der Rueckfall, wenn `systemAkzentRoh` fehlt oder die
 * Systemeinstellung auf "mehrfarbig" steht (HIG Color: dann liefert das
 * System keine EINE Akzentfarbe, und eine App-eigene ist der dokumentierte
 * Rueckfall dafuer). Werte: Apple HIG systemBlue, hell #007AFF / dunkel #0A84FF.
 */
const AKZENT_VORGABE: RollenFarbe = { hell: '#007aff', dunkel: '#0a84ff' };

/**
 * `systemPreferences.getAccentColor()` liefert je nach Plattform 6 oder 8
 * Hexziffern (mit Alphakanal), ohne '#'. Dieser Rand wird hier gesaeubert --
 * die Datei bleibt ELECTRON-frei, der Aufrufer reicht nur die rohe Zeichenkette
 * durch (main.ts, ueber den Kanal, den der Worker 'fenster' baut).
 */
function akzentSaeubern(roh: string | undefined): string {
  const s = (roh ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return '';
  return `#${s.slice(0, 6)}`;
}

/**
 * Welche Tinte macOS auf einer Akzentflaeche zeigt. NICHT `tinteFuer`: das
 * nimmt schlicht den hoeheren Kontrast und landet auf Apples eigenem Systemblau
 * bei SCHWARZ (5,02 gegen 4,18 fuer Weiss) -- ein blauer Knopf mit schwarzer
 * Beschriftung, den es auf einem Mac nirgends gibt. Der Mac entscheidet nach
 * der HELLIGKEIT der Flaeche: dunkle Akzente (Blau, Violett, Rot) tragen weisse
 * Schrift, helle (Gelb, Mint) schwarze. Die Schwelle liegt zwischen Apples
 * systemBlue (Leuchtdichte 0,21) und systemYellow (0,65).
 */
function akzentTinteWahl(flaeche: string): string {
  return relativeLuminanz(flaeche) > 0.35 ? TINTE_DUNKEL : TINTE_HELL;
}

/**
 * Dieselbe Flaeche, so weit in der Helligkeit verschoben, dass die GEWAEHLTE
 * Tinte darauf `MINDESTKONTRAST` erreicht -- Farbton und Saettigung bleiben,
 * wie bei `lesbareFarbe`, nur ist der Bezugspunkt hier die Tinte auf der
 * Flaeche und nicht die Flaeche auf dem Fenstergrund.
 *
 * Warum ueberhaupt: Weiss auf Apples systemBlue traegt nur 4,18. Zwischen
 * "sieht aus wie ein Mac" (weisse Schrift) und "ist lesbar" (4,5) muss man
 * sich nicht entscheiden -- man nimmt die weisse Schrift und dunkelt das Blau
 * um die fehlende Stufe nach. Genau das tut auch macOS selbst, sobald in den
 * Bedienungshilfen "Kontrast erhoehen" steht.
 */
function flaecheFuerTinte(flaeche: string, tinte: string): string {
  if (kontrastVerhaeltnis(tinte, flaeche) >= MINDESTKONTRAST) return flaeche;
  const [r, g, b] = hexZuRgb(flaeche);
  const [h, sat] = rgbZuHsl(r, g, b);
  let l = rgbZuHsl(r, g, b)[2];
  // Weisse Tinte verlangt eine DUNKLERE Flaeche, schwarze eine hellere.
  const schritt = tinte === TINTE_HELL ? -0.02 : 0.02;
  for (let i = 0; i < 40; i++) {
    l += schritt;
    if (l <= 0.02 || l >= 0.98) break;
    const kandidat = hslZuHex(h, sat, l);
    if (kontrastVerhaeltnis(tinte, kandidat) >= MINDESTKONTRAST) return kandidat;
  }
  // Kommt die Flaeche selbst mit ihrer Tinte nicht zurecht (eine Farbe fast
  // ohne Saettigung in der Mitte des Bereichs), bleibt sie, wie sie ist: eine
  // Flaeche zu verfaelschen, bis sie keine Farbe mehr zeigt, hilft niemandem.
  return flaeche;
}

/**
 * Die Akzentfarbe in DREI Werten, weil ein Akzent drei verschiedene Jobs hat
 * und jeder eine andere Bedingung stellt:
 *
 * - `akzent` ist die FLAECHE (gefuellter Knopf, Fokusring, Rahmen). Sie startet
 *   als die Systemfarbe und wird nur so weit nachgedunkelt oder aufgehellt, wie
 *   ihre Tinte es braucht (`flaecheFuerTinte`) -- bei Apples systemBlue ist das
 *   eine knappe Stufe.
 * - `akzentTinte` ist die Schrift AUF dieser Flaeche. Welche von beiden Tinten,
 *   entscheidet `akzentTinteWahl` nach der Helligkeit der Flaeche, so wie macOS
 *   es tut -- NICHT `tinteFuer`, das hier zum falschen Ergebnis kaeme.
 * - `akzentText` ist der Akzent als SCHRIFT (Links, hervorgehobene Werte). Der
 *   geht durch `lesbareFarbe`, und zwar gegen `--wahl` statt gegen `--grund`:
 *   von den beiden Flaechen, auf denen er vorkommt, ist `--wahl` in BEIDEN
 *   Themen die ungünstigere (im dunklen heller als der Grund, im hellen
 *   dunkler). Wer gegen die schwerere misst, besteht auf beiden.
 *
 * Warum die Trennung noetig war: Apples systemBlue `#007aff` erreicht auf Weiss
 * nur 4,02:1. Vorher lief Flaeche wie Text ueber EINEN Wert, und der
 * Vorgabewert kam ausserdem gar nicht erst an `lesbareFarbe` vorbei -- der
 * Rueckfall war damit schlechter geprueft als jede echte Systemfarbe.
 *
 * Ohne gueltige Systemfarbe gilt `AKZENT_VORGABE`.
 */
export function akzentAufloesen(systemAkzentRoh: string | undefined, wirksam: Wirksam): { akzent: string; akzentTinte: string; akzentText: string } {
  const roh = akzentSaeubern(systemAkzentRoh);
  const gewuenscht = roh || AKZENT_VORGABE[wirksam];
  const tinte = akzentTinteWahl(gewuenscht);
  return {
    akzent: flaecheFuerTinte(gewuenscht, tinte),
    akzentTinte: tinte,
    akzentText: lesbareFarbe(gewuenscht, wirksam, ROLLEN.wahl[wirksam]),
  };
}

export interface ThemaPayload {
  /** Der rohe Einstellungswert: 'system' | 'hell' | 'dunkel'. */
  thema: string;
  /** 'system' aufgeloest -- das ist es, was ein Fenster auf `data-thema` setzt. */
  wirksam: Wirksam;
  /** Die Farben, genau wie eingestellt. */
  zustandsfarben: Record<string, string>;
  /** Dieselben Farben, je nach `wirksam` kontrastangepasst -- das setzt ein Fenster als `--zustand-*`. */
  zustandsfarbenLesbar: Record<string, string>;
  /** Die Tinte fuer eine GEFUELLTE Flaeche in einer Zustandsfarbe -- `--zustand-*-tinte`. */
  zustandsfarbenTinte: Record<string, string>;
  /** Die Systemakzentfarbe (oder `AKZENT_VORGABE`) als FLAECHE, unveraendert -- `--akzent`. */
  akzent: string;
  /** Die Tinte auf der Akzentflaeche -- `--akzent-tinte`. */
  akzentTinte: string;
  /** Dieselbe Farbe als SCHRIFT auf dem Grund, kontrastangepasst -- `--akzent-text`. */
  akzentText: string;
  /**
   * Die System-Akzentfarbe (Electron `systemPreferences.getAccentColor()`,
   * RGBA-Hex wie z. B. "1a56dbff") -- oder leer, wenn die Plattform sie nicht
   * liefert. Diese Datei STELLT den Wert nur durch; gelesen wird er in main.ts
   * (siehe Kopf: kein 'electron'-Import hier), verwendet ihn der Worker
   * 'farbsystem'.
   *
   * ROH, absichtlich: `akzent` daneben ist derselbe Wert, aber schon gegen den
   * Grund kontrastangepasst. Ein Fenster nimmt `akzent`; `systemAkzentfarbe`
   * bleibt fuer den Fall, dass jemand den ungefilterten Systemwert braucht.
   */
  systemAkzentfarbe: string;
}

/**
 * Alles, was ein Fenster zum Zeichnen braucht, in einem Zug. `systemIstDunkel`
 * kommt vom Aufrufer (main.ts, `nativeTheme.shouldUseDarkColors`) -- diese
 * Datei importiert 'electron' bewusst nicht, siehe Kopf. Dasselbe gilt fuer
 * `systemAkzentfarbe` (main.ts, `systemPreferences.getAccentColor()`) -- die
 * rohe Ausgabe, oder ungesetzt: dann gilt `AKZENT_VORGABE`. Optional, damit der
 * bestehende Zwei-Argumente-Aufruf (Test: dist/test/thema.mjs) unveraendert
 * bleibt.
 */
export function themaPayload(systemIstDunkel: boolean, pfad?: string, systemAkzentfarbe = ''): ThemaPayload {
  const gesetzt = themaGesetzt(pfad);
  const wirksam = wirksamesThema(gesetzt, systemIstDunkel);
  const farben = zustandsfarbenGesetzt(pfad);
  const lesbar = zustandsfarbenLesbar(farben, wirksam);
  const { akzent, akzentTinte, akzentText } = akzentAufloesen(systemAkzentfarbe, wirksam);
  return {
    thema: gesetzt,
    wirksam,
    zustandsfarben: farben,
    akzent,
    akzentTinte,
    akzentText,
    zustandsfarbenLesbar: lesbar,
    zustandsfarbenTinte: zustandsfarbenTinte(lesbar),
    systemAkzentfarbe,
  };
}

// --- CSS-Text: derselbe Rollensatz, einmal als Text -------------------------
//
// EINE Quelle fuer ZWEI Abnehmer: `build.mjs` schreibt das hier woertlich nach
// `thema/tokens.css` und verlinkt sie in alle fuenf Fenster (renderer/,
// einstellungen/, sitzung/, verbrauch/, erststart/index.html); `main/seiten.ts`
// braucht denselben Text ein zweites Mal, gebettet in die uebernommenen
// VSCode-Seiten (dort gibt es kein <link>, nur ein injiziertes <style>). Keiner
// der beiden schreibt einen eigenen Hex-Wert -- aendert sich eine Farbe, aendert
// sich diese Funktion, und beide Abnehmer ziehen beim naechsten Bau nach.
//
// `--akzent`/`--akzent-tinte`/`--akzent-text` tragen hier nur die VORGABE (Apples Systemblau):
// die echte Systemfarbe kommt live per JS (`document.documentElement.style.
// setProperty`, wie `--zustand-*` es schon vormacht), sobald der Kanal des
// Worker 'fenster' sie liefert -- eine STATISCHE Datei kann sie nicht kennen.
/**
 * DIE VIER ZUSTANDSFARBEN ALS ROLLE, HELL UND DUNKEL (03.09.2026).
 *
 * Ihre Werte sind seit jeher eine EINSTELLUNG (`zustandsfarben`, Seite
 * „Aussehen"); der Mensch darf sie waehlen, und `themaPayload` reicht sie
 * kontrastangepasst als `--zustand-*` an jedes Fenster. Was fehlte, war die
 * VORGABE im erzeugten Stilblatt: `rollenCss()` schrieb die vier dunklen Werte
 * fest in `:root` und im hellen Block gar keine. Damit trug ein Fenster im
 * Hellmodus fuer den Augenblick vor der ersten Themenmeldung -- und dauerhaft,
 * wenn sie ausbliebe -- die DUNKLEN Zustandsfarben auf hellem Grund. Der
 * Wartegelb-Wert `#e0a33e` traegt auf Weiss 1,90:1 und war damit die einzige
 * Farbe des Hauses unter der eigenen Schwelle von 4,5.
 *
 * Jetzt kommt die Vorgabe aus derselben Stelle wie die Einstellung selbst
 * (`VORGABEN.zustandsfarben`) und laeuft durch dieselbe Anpassung wie eine vom
 * Menschen gewaehlte Farbe (`lesbareFarbe`, gegen `grund` des jeweiligen
 * Themas). Gemessen nach der Aenderung -- dunkel: laeuft 7,02, wartet 8,46,
 * fertig 6,14, tot 5,11; hell: 4,88 / 4,53 / 5,24 / 4,91. Alle acht ueber
 * MINDESTKONTRAST, ohne dass jemand eine zweite Farbtabelle pflegen muesste.
 */
function zustandsblock(wirksam: Wirksam): string[] {
  const vorgabe = VORGABEN.zustandsfarben as Record<string, string>;
  const lesbar = zustandsfarbenLesbar(vorgabe, wirksam);
  const tinte = zustandsfarbenTinte(lesbar);
  return Object.keys(vorgabe).flatMap((zustand) => [
    `    --zustand-${zustand}: ${lesbar[zustand]};`,
    `    --zustand-${zustand}-tinte: ${tinte[zustand]};`,
  ]);
}

function block(wirksam: Wirksam): string {
  const paar = (name: Rollenname) => `    --${name}: ${ROLLEN[name][wirksam]};`;
  const namen: Rollenname[] = ['fenster', 'grund', 'leiste', 'erhoben', 'linie', 'schrift', 'gedaempft', 'wahl', 'tinte', 'fern', 'laeuft', 'will', 'aus', 'vorsichtgrund'];
  const { akzent, akzentTinte, akzentText } = akzentAufloesen(undefined, wirksam);
  return [
    ...namen.map(paar),
    `    --akzent: ${akzent};`,
    `    --akzent-tinte: ${akzentTinte};`,
    `    --akzent-text: ${akzentText};`,
    // Zustandsfarben: nur die VORGABE fuer den einen Wimpernschlag vor dem
    // ersten 'awb:thema-neu'. Danach liefert main/thema.ts die vom Menschen
    // gewaehlten, ebenso kontrastangepassten Werte per JS.
    ...zustandsblock(wirksam),
    // Die sechzehn ANSI-Farben des Terminals -- xterm traegt keine
    // CSS-Variablen selbst, deshalb reicht paneflaeche.ts sie ihm von hier aus
    // durch (Regelbruch 11).
    ...terminalblock(wirksam),
  ].join('\n');
}

/**
 * DIE 16 ANSI-FARBEN DES TERMINALS (05.09.2026, Regelbruch 11).
 *
 * xterm bringt eine eigene Palette mit, und sie ist fuer einen DUNKLEN Grund
 * gebaut: `white` ist #d3d7cf, `brightWhite` #eeeeec. Im hellen Thema liegt das
 * Terminal auf `--erhoben` (#eceef2), und damit war eine Zeile in \e[1;37m
 * -- die fette Kopfzeile, mit der sich ein Agent im Pane meldet -- schlicht
 * nicht mehr da. Gemessen am Belegbild: sie fehlte im hellen Thema
 * vollstaendig und stand im dunklen.
 *
 * DUNKEL BLEIBT, WAS ES WAR: die Werte hier sind Zeichen fuer Zeichen xterms
 * eigene `DEFAULT_ANSI_COLORS`. Damit aendert sich am dunklen Bild nichts, und
 * die Palette steht trotzdem an EINER Stelle statt in einer Bibliothek.
 *
 * HELL laeuft jede der sechzehn durch dieselbe Anpassung wie jede andere frei
 * gewaehlte Farbe des Hauses (`lesbareFarbe`, gemessen gegen `erhoben` -- die
 * Flaeche, auf der das Terminal wirklich liegt): der Farbton bleibt, die
 * Helligkeit geht so weit herunter, bis 4,5 erreicht sind. Zwei Ausnahmen, und
 * beide sind die eigentliche Behebung:
 *
 *   `brightWhite` wird die Schriftfarbe des Themas. Es ist im Terminal die
 *   STAERKSTE Tinte, nicht die hellste Flaeche -- so haelt es Terminal.app im
 *   Profil "Basic" auch, und genau daran haengt die fette Kopfzeile.
 *   `white` wird ein dunkles Grau, eine Stufe unter `brightWhite`, damit die
 *   beiden auch im hellen Thema unterscheidbar bleiben.
 */
const TERMINAL_NAMEN = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

/** xterms `DEFAULT_ANSI_COLORS`, unveraendert -- die Palette des dunklen Themas. */
const TERMINAL_DUNKEL = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

export function terminalPalette(wirksam: Wirksam): Record<string, string> {
  const raus: Record<string, string> = {};
  TERMINAL_NAMEN.forEach((name, i) => {
    if (wirksam === 'dunkel') { raus[name] = TERMINAL_DUNKEL[i]; return; }
    if (name === 'brightWhite') { raus[name] = ROLLEN.schrift.hell; return; }
    if (name === 'white') { raus[name] = lesbareFarbe('#8b9189', 'hell', ROLLEN.erhoben.hell); return; }
    raus[name] = lesbareFarbe(TERMINAL_DUNKEL[i], 'hell', ROLLEN.erhoben.hell);
  });
  return raus;
}

function terminalblock(wirksam: Wirksam): string[] {
  const p = terminalPalette(wirksam);
  return TERMINAL_NAMEN.map((name) => `    --term-${name}: ${p[name]};`);
}

export function rollenCss(): string {
  return `:root {
  color-scheme: dark;
${block('dunkel')}
}
:root[data-thema='hell'] {
  color-scheme: light;
${block('hell')}
}
/* Nur das Einstellungsfenster traegt 'system' je als LITERALEN Attributwert
   (main/einstellungen.ts loest ihn NICHT auf, siehe dessen Kopf) -- die
   anderen vier Fenster bekommen von main/thema.ts immer schon 'hell' oder
   'dunkel' und treffen diese Regel nie. Harmlos hier zu tragen, statt ein
   sechstes Mal dieselben Werte in einstellungen/index.html zu wiederholen. */
@media (prefers-color-scheme: light) {
  :root[data-thema='system'] {
    color-scheme: light;
${block('hell')}
  }
}
`;
}
