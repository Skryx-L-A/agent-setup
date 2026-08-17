// Die EINE gemeinsame Stelle fuer Thema und Zustandsfarben, gebraucht von allen
// Fenstern ausser dem Einstellungsfenster (das zieht seine eigene, bereits
// bestehende Anwendung nicht hierher um -- siehe der Auftrag). Reine Logik,
// OHNE 'electron'-Import: dieselbe Bauform wie `einstellungen.ts`, damit sich
// die Datei wie `dist/test/einstellungen.mjs` als eigenes Buendel bauen und mit
// blossem `node` pruefen laesst (build.mjs, `test/thema.mjs`). Die duenne
// electron-Seite -- `nativeTheme` lesen, den IPC-Kanal registrieren, an die
// Fenster senden -- steht bewusst NICHT hier, sondern in main.ts: sie ist zu
// klein, um eine zweite, nicht pruefbare Datei zu rechtfertigen.
import { thema as themaGesetzt, zustandsfarben as zustandsfarbenGesetzt } from './einstellungen';

export type Wirksam = 'hell' | 'dunkel';

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
 */
export function lesbareFarbe(hex: string, wirksam: Wirksam): string {
  const grund = wirksam === 'hell' ? GRUND_HELL : GRUND_DUNKEL;
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

/** Alle vier Zustandsfarben, je einzeln lesbar gemacht -- ein Ausreisser reisst die anderen drei nicht mit. */
export function zustandsfarbenLesbar(farben: Record<string, string>, wirksam: Wirksam): Record<string, string> {
  const raus: Record<string, string> = {};
  for (const [zustand, farbe] of Object.entries(farben)) raus[zustand] = lesbareFarbe(farbe, wirksam);
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
}

/**
 * Alles, was ein Fenster zum Zeichnen braucht, in einem Zug. `systemIstDunkel`
 * kommt vom Aufrufer (main.ts, `nativeTheme.shouldUseDarkColors`) -- diese
 * Datei importiert 'electron' bewusst nicht, siehe Kopf.
 */
export function themaPayload(systemIstDunkel: boolean, pfad?: string): ThemaPayload {
  const gesetzt = themaGesetzt(pfad);
  const wirksam = wirksamesThema(gesetzt, systemIstDunkel);
  const farben = zustandsfarbenGesetzt(pfad);
  const lesbar = zustandsfarbenLesbar(farben, wirksam);
  return {
    thema: gesetzt,
    wirksam,
    zustandsfarben: farben,
    zustandsfarbenLesbar: lesbar,
    zustandsfarbenTinte: zustandsfarbenTinte(lesbar),
  };
}
