// DIE AGENTENFIGUREN (Bau-Schritt 4, Auftrag ansicht4e, 10.09.2026).
//
// Der Zeichner aus docs/agentenfiguren.html -- fuenfter Entwurf, von alice
// am 10.09. als Richtung abgenommen -- als wiederverwendbares Modul. Die
// Mac-Fassung uebertraegt dieselbe Vorlage nach SwiftUI (Agentenfigur.swift);
// beide leiten den Bauplan GLEICH ab, damit ein Worker auf beiden Oberflaechen
// dieselbe Figur hat.
//
// WAS WOHER KOMMT (AGENTS-PLAN.md, Abschnitt 7, „Das Aussehen der Agenten"):
//   Rolle     -> Art (ueber das Team), Teamfarbe und Grundform (Koerper,
//                Antenne, Ohren, Augen, Fuesse, Schwanz)
//   Name      -> die sichtbare Abwandlung der Instanz: Muster, Zubehoer,
//                Toenung, Augengroesse; beim Kern Ringneigung und Satelliten,
//                bei der Linse Braue und Iris. Gleicher Name, gleiche Figur.
//   Zustand   -> Augen, Bewegung, Leuchte und ein Zeichen ueber dem Kopf.
// Der Hauptagent ist immer der Kern, der Reviewer immer die Linse.
//
// DIE FARBEN. Die Teamfarben sind die Kennfarben der Figurensprache (dieselben
// Werte wie im Blatt und in der Mac-Fassung) und stehen deshalb als Konstanten
// HIER, nicht als neue Farbtokens der Oberflaeche. Die Zustandsfarben lesen,
// wo es sie gibt, die vorhandenen `--zustand-*`-Tokens des Fensters -- damit
// die Leuchte einer Figur dieselbe Farbe hat wie der Punkt daneben in der
// Leiste. Hell oder dunkel liest das Modul am Grund des Fensters ab.
//
// DIE BEWEGUNG laeuft in EINEM gemeinsamen Animationsrahmen fuer alle Figuren
// des Fensters. Gezeichnet wird nur, was im DOM haengt und im Sichtbereich
// liegt; bei `prefers-reduced-motion` gibt es keinen Rahmen, jede Figur steht
// als Standbild mit demselben Zustandszeichen.

export type Art = 'roboter' | 'tier';
export type Gestalt = Art | 'kern' | 'linse';
export type Team = 'recherche' | 'entwicklung' | 'pruefung' | 'gestaltung' | 'hauptagent';
export type FigurZustand = 'ruhig' | 'arbeitet' | 'ungelesen' | 'entscheidung' | 'haengt' | 'fertig' | 'fern';

export interface Bibliotheksrolle { rolle: string; name: string; stufe: 'teamleiter' | 'mitglied' }
export interface Bibliotheksteam { team: Exclude<Team, 'hauptagent'>; art: Art; rollen: Bibliotheksrolle[] }

/** Die Rollen der Bibliothek, wie im Blatt -- Vorgabe der Art je Team inbegriffen. */
export const BIBLIOTHEK: Bibliotheksteam[] = [
  { team: 'recherche', art: 'tier', rollen: [
    { rolle: 'recherche-leiter', name: 'Recherche-Leiter', stufe: 'teamleiter' },
    { rolle: 'recherche-laeufer', name: 'Recherche-Läufer', stufe: 'mitglied' },
    { rolle: 'quellenpruefer', name: 'Quellenprüfer', stufe: 'mitglied' },
  ] },
  { team: 'entwicklung', art: 'roboter', rollen: [
    { rolle: 'entwicklungs-leiter', name: 'Entwicklungs-Leiter', stufe: 'teamleiter' },
    { rolle: 'senior-dev', name: 'Senior-Dev', stufe: 'mitglied' },
    { rolle: 'junior-dev', name: 'Junior-Dev', stufe: 'mitglied' },
    { rolle: 'tester', name: 'Tester', stufe: 'mitglied' },
  ] },
  { team: 'pruefung', art: 'roboter', rollen: [
    { rolle: 'sicherheitspruefer', name: 'Sicherheitsprüfer', stufe: 'mitglied' },
  ] },
  { team: 'gestaltung', art: 'tier', rollen: [
    { rolle: 'gestaltungs-leiter', name: 'Gestaltungs-Leiter', stufe: 'teamleiter' },
    { rolle: 'ui-gestalter', name: 'UI-Gestalter', stufe: 'mitglied' },
    { rolle: 'dokument-gestalter', name: 'Dokument-Gestalter', stufe: 'mitglied' },
    { rolle: 'bild-lokal', name: 'Bild lokal', stufe: 'mitglied' },
  ] },
];

export const FIGUR_ZUSTAENDE: FigurZustand[] = ['arbeitet', 'ungelesen', 'entscheidung', 'haengt', 'fertig', 'fern'];

const TEAMFARBE: Record<Team | 'reviewer', string> = {
  hauptagent: '#5856D6', reviewer: '#3A3F4B', recherche: '#1F9E8F',
  entwicklung: '#3478F6', pruefung: '#D9800A', gestaltung: '#D6337A',
};

/** Der Zustand aus dem Datenvertrag (`awb:aufgaben`) als Figurenzustand. */
export function figurZustandVon(zustand: string): FigurZustand {
  switch (zustand) {
    case 'arbeitet': return 'arbeitet';
    case 'ergebnis_ungelesen': return 'ungelesen';
    case 'braucht_entscheidung': return 'entscheidung';
    case 'haengt': return 'haengt';
    case 'fertig': return 'fertig';
    case 'nicht_einsehbar': return 'fern';
    default: return 'ruhig';
  }
}

/**
 * DAS TEAM EINER ROLLE. Der Datenvertrag nennt je Worker nur die Rolle; das
 * Team steht in der Bibliothek. Eine Rolle, die dort fehlt (eine vorlaeufige,
 * vom Hauptagenten angelegte), faellt nach ihrem Namen in ein Team, sonst in
 * die Entwicklung. Traegt der Kern spaeter ein Feld `team`, gewinnt es.
 */
export function teamVon(rolle: string, hinweis?: string): Team {
  if (hinweis && (hinweis in TEAMFARBE) && hinweis !== 'reviewer') return hinweis as Team;
  if (rolle === 'hauptagent') return 'hauptagent';
  if (rolle === 'reviewer') return 'pruefung';
  for (const t of BIBLIOTHEK) if (t.rollen.some((r) => r.rolle === rolle)) return t.team;
  if (/gestalt|design|bild|grafik|dokument|ui-/.test(rolle)) return 'gestaltung';
  if (/recherche|quelle|scout|such|leser/.test(rolle)) return 'recherche';
  if (/pruef|sicherheit|audit/.test(rolle)) return 'pruefung';
  return 'entwicklung';
}

/** Der Anzeigename einer Rolle: aus der Bibliothek, sonst der Rollenname selbst. */
export function rollenName(rolle: string): string {
  if (rolle === 'reviewer') return 'Reviewer';
  for (const t of BIBLIOTHEK) for (const r of t.rollen) if (r.rolle === rolle) return r.name;
  return rolle;
}

/** Die Vorgabe der Art je Team, wie im Blatt. */
export function artVorgabe(team: Team): Art {
  return BIBLIOTHEK.find((t) => t.team === team)?.art ?? 'roboter';
}

/**
 * Die Art je Team aus den Einstellungen (`agents.teams.<name>.art`). Gesetzt
 * von aussen, sobald die Werte da sind; ohne Eintrag gilt die Vorgabe.
 */
let artenEingestellt: Record<string, Art> = {};
export function figurenArtenSetzen(arten: Record<string, unknown> | null | undefined): void {
  const neu: Record<string, Art> = {};
  for (const [team, wert] of Object.entries(arten ?? {})) {
    const art = typeof wert === 'string' ? wert : (wert as { art?: unknown } | null)?.art;
    if (art === 'roboter' || art === 'tier') neu[team] = art;
  }
  artenEingestellt = neu;
}
export function artVon(team: Team): Art {
  return artenEingestellt[team] ?? artVorgabe(team);
}
export function artEingestellt(team: Team): boolean {
  return team in artenEingestellt;
}

// --- Der Bauplan: deterministisch aus Rolle und Name ---------------------------

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function rng(seed: number): () => number {
  let x = seed || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

export interface Bauplan {
  body: string; antenna: string; ears: string; eye: string; eyeGap: number; eyeSize: number; feet: string;
  wobble: number[]; tEars: string; tEye: number; tGap: number; tCheeks: boolean; tTail: string; leiter: boolean;
  pattern: string; accessory: string; tint: number; eyeMul: number; ringTilt: number; sats: number; brow: string; hueShift: number;
}

/**
 * Der Bauplan einer Figur. Die Reihenfolge der Zufallszuege ist DIESELBE wie
 * im Blatt (`spec()`): wer sie aendert, gibt jedem Worker eine andere Figur.
 */
export function bauplan(rolle: string, stufe: string, name?: string): Bauplan {
  const r = rng(hash(rolle));
  const q = rng(hash((name || rolle) + '#' + rolle));
  const inst = {
    pattern: pick(q, ['none', 'spots', 'stripe', 'patch', 'none']),
    accessory: pick(q, ['none', 'scarf', 'badge', 'sticker', 'tip', 'none']),
    tint: Math.round((q() - 0.5) * 36),
    eyeMul: 0.9 + q() * 0.25,
    ringTilt: -0.6 + q() * 0.5,
    sats: q() < 0.35 ? 2 : 1,
    brow: pick(q, ['flat', 'arc', 'angle']),
    hueShift: Math.round((q() - 0.5) * 40),
  };
  return {
    body: pick(r, ['dome', 'box', 'capsule', 'wide']),
    antenna: pick(r, ['none', 'single', 'twin', 'loop', 'single']),
    ears: pick(r, ['none', 'round', 'fin', 'none']),
    eye: pick(r, ['tall', 'round', 'wide', 'tall']),
    eyeGap: 0.17 + r() * 0.08,
    eyeSize: 0.12 + r() * 0.04,
    feet: pick(r, ['stubs', 'wheel', 'stubs']),
    wobble: [0.92 + r() * 0.2, 0.92 + r() * 0.2, 0.92 + r() * 0.2, 0.92 + r() * 0.2, 0.92 + r() * 0.2, 0.92 + r() * 0.2],
    tEars: pick(r, ['pointy', 'round', 'feeler', 'round']),
    tEye: 0.11 + r() * 0.04,
    tGap: 0.2 + r() * 0.08,
    tCheeks: r() < 0.5,
    tTail: pick(r, ['none', 'stub', 'curl']),
    leiter: stufe === 'teamleiter',
    ...inst,
  };
}

// --- Farben -----------------------------------------------------------------

interface Palette {
  dunkel: boolean;
  zustand: Record<FigurZustand, string>;
  screen: string; eye: string; shadow: string; bubble: string; bubbleline: string;
}

let normCtx: CanvasRenderingContext2D | null = null;
/** Eine CSS-Farbe in die Form, die ein Canvas selbst schreibt (#rrggbb oder rgba()). */
function normFarbe(v: string): string {
  if (!normCtx) normCtx = document.createElement('canvas').getContext('2d');
  if (!normCtx || !v) return '';
  normCtx.fillStyle = '#000000';
  normCtx.fillStyle = v;
  return String(normCtx.fillStyle);
}
function helligkeit(farbe: string): number {
  const f = normFarbe(farbe);
  let r = 0, g = 0, b = 0;
  if (f.startsWith('#')) { const n = parseInt(f.slice(1), 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else { const m = f.match(/[\d.]+/g); if (m) [r, g, b] = m.map(Number); }
  return (0.3 * r + 0.59 * g + 0.11 * b) / 255;
}

let palettenStand: { zeit: number; p: Palette } | null = null;
function palette(): Palette {
  const jetzt = performance.now();
  if (palettenStand && jetzt - palettenStand.zeit < 500) return palettenStand.p;
  const st = getComputedStyle(document.documentElement);
  const token = (name: string, sonst: string): string => normFarbe(st.getPropertyValue(name).trim()) || sonst;
  const grund = st.getPropertyValue('--grund').trim() || st.getPropertyValue('--fenster').trim();
  const dunkel = grund ? helligkeit(grund) < 0.45 : matchMedia('(prefers-color-scheme: dark)').matches;
  const p: Palette = {
    dunkel,
    zustand: {
      ruhig: token('--gedaempft', '#9A9AA2'),
      arbeitet: token('--zustand-laeuft', '#34C759'),
      ungelesen: '#AF52DE',
      entscheidung: token('--zustand-wartet', '#FF9F0A'),
      haengt: '#FF3B30',
      fertig: token('--gedaempft', dunkel ? '#8A8A92' : '#9A9AA2'),
      fern: dunkel ? '#5A5A62' : '#B0B0B8',
    },
    screen: dunkel ? '#0C0C10' : '#15151A',
    eye: '#F2F6FF',
    shadow: dunkel ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.14)',
    bubble: dunkel ? '#2C2C31' : '#FFFFFF',
    bubbleline: dunkel ? '#4A4A52' : '#D0D0D6',
  };
  palettenStand = { zeit: jetzt, p };
  return p;
}
/** Das Thema hat gewechselt: die naechste Zeichnung liest die Farben neu. */
export function figurenFarbenNeu(): void {
  palettenStand = null;
  figurenAufraeumen();
  for (const f of lebende) zeichne(f, (performance.now() - f.t0) / 1000);
}

function hexrgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(hex: string, amt: number, grey: boolean): string {
  let [r, g, b] = hexrgb(hex);
  if (grey) { const l = 0.3 * r + 0.59 * g + 0.11 * b; r = g = b = l; }
  r = Math.min(255, Math.max(0, r + amt)); g = Math.min(255, Math.max(0, g + amt)); b = Math.min(255, Math.max(0, b + amt));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- Bewegung ---------------------------------------------------------------

const reduziertAbfrage = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Nur fuer Tests: die Systemeinstellung uebersteuern (null heisst: wieder das System). */
let reduziertErzwungen: boolean | null = null;
function reduziert(): boolean {
  return reduziertErzwungen ?? !!reduziertAbfrage?.matches;
}
export function figurenBewegungErzwingen(reduziertWert: boolean | null): void {
  reduziertErzwungen = reduziertWert;
  figurenAufraeumen();
  for (const f of lebende) zeichne(f, (performance.now() - f.t0) / 1000);
  starten();
}

interface Figur {
  c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; S: number; dpr: number; sp: Bauplan;
  team: Team; gestalt: Gestalt; zustand: FigurZustand;
  t0: number; nextBlink: number; blinkAt: number; sichtbar: boolean;
}

interface Ausdruck { bob: number; sway: number; breathe: number; lookX: number; lookY: number; lidL: number; lidR: number; tilt: number; cross: boolean }

function ausdruck(o: Figur, t: number): Ausdruck {
  const st = o.zustand;
  const e: Ausdruck = { bob: 0, sway: 0, breathe: 1, lookX: 0, lookY: 0, lidL: 1, lidR: 1, tilt: 0, cross: false };
  if (reduziert()) {
    if (st === 'entscheidung') { e.tilt = -0.08; e.lidL = 1.2; e.lidR = 0.8; }
    if (st === 'haengt') { e.cross = true; e.tilt = 0.08; }
    if (st === 'fertig') { e.lidL = e.lidR = 0.06; }
    if (st === 'fern') { e.lidL = e.lidR = 0.6; }
    if (st === 'arbeitet') { e.lookY = 0.35; }
    return e;
  }
  if (st === 'arbeitet') { e.lookX = Math.sin(t * 2.8) * 0.9; e.lookY = 0.3 + Math.sin(t * 0.9) * 0.15; e.bob = Math.sin(t * 3) * 0.8; }
  else if (st === 'ungelesen') { e.lookX = 0; e.lookY = -0.1; e.lidL = e.lidR = 1.15; }
  else if (st === 'entscheidung') { e.tilt = -0.1; e.lidL = 1.3; e.lidR = 0.75; e.lookX = 0.35; e.lookY = -0.35; }
  else if (st === 'haengt') { e.sway = Math.sin(t * 1.2) * 3; e.tilt = Math.sin(t * 1.2) * 0.06; e.cross = true; }
  else if (st === 'fertig') { e.breathe = 1 + Math.sin(t * 1.0) * 0.014; e.lidL = e.lidR = 0.06; }
  else if (st === 'fern') { e.lidL = e.lidR = 0.6; }
  else { e.lookX = Math.sin(t * 0.5) * 0.35; e.lookY = Math.sin(t * 0.37) * 0.15; e.breathe = 1 + Math.sin(t * 1.4) * 0.008; }
  // Blinzeln in unregelmaessigem Takt -- nicht beim Schlafen und nicht beim Haengen.
  if (st !== 'fertig' && st !== 'haengt') {
    if (o.blinkAt < 0 && t > o.nextBlink) o.blinkAt = t;
    if (o.blinkAt >= 0) {
      const p = (t - o.blinkAt) / 0.16;
      if (p < 1) { const k = 1 - Math.abs(p * 2 - 1); e.lidL *= 1 - k * 0.95; e.lidR *= 1 - k * 0.95; }
      else { o.blinkAt = -1; o.nextBlink = t + 2 + Math.random() * 4; }
    }
  }
  return e;
}

const SCHRIFT = '-apple-system,BlinkMacSystemFont,Helvetica,Arial';

/** Das Zeichen ueber dem Kopf -- auch still und bei 16 Punkt lesbar. */
function zeichen(ctx: CanvasRenderingContext2D, S: number, st: FigurZustand, t: number, x: number, y: number, pal: Palette): void {
  const u = S / 100;
  const col = pal.zustand[st];
  const still = reduziert();
  ctx.save();
  if (st === 'arbeitet') {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = still ? 1 : 0.55 + 0.45 * Math.sin(t * 5 - i * 0.9);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x + (i - 1) * 7 * u, y, 2.6 * u, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (st === 'ungelesen' || st === 'entscheidung') {
    const w = 20 * u, h = 16 * u;
    ctx.fillStyle = pal.bubble; ctx.strokeStyle = pal.bubbleline; ctx.lineWidth = 1.2 * u;
    rr(ctx, x - w / 2, y - h / 2, w, h, 5 * u); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 3 * u, y + h / 2 - 0.5 * u); ctx.lineTo(x - 6 * u, y + h / 2 + 4 * u); ctx.lineTo(x + 1 * u, y + h / 2 - 0.5 * u);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = pal.bubble; ctx.fillRect(x - 3.5 * u, y + h / 2 - 1.5 * u, 5 * u, 2 * u);
    if (st === 'ungelesen') {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 3.6 * u, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = col; ctx.font = `700 ${13 * u}px ${SCHRIFT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', x, y + 0.5 * u);
    }
  } else if (st === 'haengt') {
    const dy = still ? 0 : (t * 18 * u) % (9 * u);
    ctx.fillStyle = '#4FA3F7';
    ctx.beginPath(); ctx.moveTo(x, y - 6 * u + dy);
    ctx.quadraticCurveTo(x + 5 * u, y + 2 * u + dy, x, y + 5 * u + dy);
    ctx.quadraticCurveTo(x - 5 * u, y + 2 * u + dy, x, y - 6 * u + dy); ctx.fill();
  } else if (st === 'fertig') {
    const ph = still ? 0 : (t * 0.6) % 1;
    ctx.fillStyle = col; ctx.globalAlpha = 1 - ph * 0.7;
    ctx.font = `700 ${11 * u}px ${SCHRIFT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('z', x - 2 * u, y + 2 * u - ph * 8 * u);
    ctx.font = `700 ${8 * u}px ${SCHRIFT}`;
    ctx.fillText('z', x + 6 * u, y - 4 * u - ph * 8 * u);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function kreuzAugen(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, col: string): void {
  ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, s * 0.22); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - s / 2, y - s / 2); ctx.lineTo(x + s / 2, y + s / 2);
  ctx.moveTo(x + s / 2, y - s / 2); ctx.lineTo(x - s / 2, y + s / 2); ctx.stroke();
}

/** Die kleine Leuchte in der Zustandsfarbe -- der Handlungsbedarf auch bei 16 Punkt. */
function leuchte(ctx: CanvasRenderingContext2D, S: number, st: FigurZustand, t: number, x: number, y: number, pal: Palette): void {
  if (st === 'ruhig') return;
  const u = S / 100;
  const lc = pal.zustand[st];
  const puls = (!reduziert() && (st === 'ungelesen' || st === 'arbeitet')) ? 0.65 + 0.35 * Math.sin(t * 4) : 1;
  ctx.globalAlpha = puls; ctx.fillStyle = lc;
  ctx.beginPath(); ctx.arc(x, y, 3.8 * u, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = puls * 0.35;
  ctx.beginPath(); ctx.arc(x, y, 6.5 * u, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

function fernRahmen(ctx: CanvasRenderingContext2D, S: number, pal: Palette): void {
  const u = S / 100;
  ctx.save(); ctx.setLineDash([4 * u, 3 * u]); ctx.strokeStyle = pal.zustand.fern; ctx.lineWidth = 1.4 * u;
  rr(ctx, 3 * u, 3 * u, 94 * u, 94 * u, 14 * u); ctx.stroke(); ctx.restore();
}

type Ton = (a: number) => string;
interface Kasten { x: number; y: number; w: number; h: number; r?: number }

function muster(ctx: CanvasRenderingContext2D, u: number, sp: Bauplan, b: Kasten): void {
  const r = rng(hash('m' + sp.pattern + b.w));
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.28)';
  if (sp.pattern === 'spots') {
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc((b.x + b.w * (0.2 + r() * 0.6)) * u, (b.y + b.h * (0.55 + r() * 0.35)) * u, (2 + r() * 2.5) * u, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (sp.pattern === 'stripe') {
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    for (let i = 0; i < 2; i++) { rr(ctx, (b.x + b.w * 0.1) * u, (b.y + b.h * (0.68 + i * 0.12)) * u, b.w * 0.8 * u, 3 * u, 1.5 * u); ctx.fill(); }
  } else if (sp.pattern === 'patch') {
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    ctx.beginPath(); ctx.ellipse((b.x + b.w * 0.72) * u, (b.y + b.h * 0.72) * u, b.w * 0.16 * u, b.h * 0.12 * u, 0.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function zubehoer(ctx: CanvasRenderingContext2D, u: number, sp: Bauplan, C: Ton, b: Kasten, art: Art): void {
  ctx.save();
  const cx = (b.x + b.w / 2) * u;
  if (sp.accessory === 'scarf') {
    ctx.fillStyle = C(-55);
    rr(ctx, (b.x + b.w * 0.15) * u, (b.y + b.h * (art === 'tier' ? 0.66 : 0.62)) * u, b.w * 0.7 * u, 5 * u, 2.5 * u); ctx.fill();
    rr(ctx, (b.x + b.w * 0.62) * u, (b.y + b.h * 0.66) * u, 5 * u, 12 * u, 2.5 * u); ctx.fill();
  } else if (sp.accessory === 'badge') {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.arc((b.x + b.w * 0.22) * u, (b.y + b.h * 0.74) * u, 4 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C(-30);
    ctx.beginPath(); ctx.arc((b.x + b.w * 0.22) * u, (b.y + b.h * 0.74) * u, 2 * u, 0, Math.PI * 2); ctx.fill();
  } else if (sp.accessory === 'sticker') {
    ctx.save(); ctx.translate((b.x + b.w * 0.78) * u, (b.y + b.h * 0.7) * u); ctx.rotate(-0.4);
    ctx.fillStyle = '#FFD60A'; rr(ctx, -4 * u, -3 * u, 8 * u, 6 * u, 1.2 * u); ctx.fill(); ctx.restore();
  } else if (sp.accessory === 'tip') {
    ctx.fillStyle = '#FFD60A';
    ctx.beginPath(); ctx.arc(cx, (b.y - (art === 'tier' ? b.h * 0.42 : 0) - 13 * u), 2.4 * u, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---------- Roboter ----------
function zeichneRoboter(o: Figur, t: number, e: Ausdruck, fern: boolean, pal: Palette): void {
  const { ctx, S, sp, zustand: st } = o;
  const u = S / 100;
  const col = TEAMFARBE[o.team];
  const C: Ton = (a) => shade(col, a + sp.tint, fern);
  ctx.save();
  ctx.translate(S / 2 + e.sway * u, S / 2 + e.bob * u); ctx.rotate(e.tilt); ctx.scale(e.breathe, e.breathe); ctx.translate(-S / 2, -S / 2);
  let bx = 20, by = 26, bw = 60, bh = 60, br = 14;
  if (sp.body === 'dome') { by = 24; bh = 64; br = 28; }
  else if (sp.body === 'capsule') { bx = 26; bw = 48; by = 18; bh = 72; br = 24; }
  else if (sp.body === 'wide') { bx = 12; bw = 76; by = 32; bh = 54; br = 18; }
  ctx.fillStyle = pal.shadow;
  ctx.beginPath(); ctx.ellipse(S / 2, (by + bh + 6) * u, bw * 0.42 * u, 3.5 * u, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C(-40);
  if (sp.feet === 'stubs') {
    rr(ctx, (bx + bw * 0.2) * u, (by + bh - 4) * u, 12 * u, 9 * u, 4 * u); ctx.fill();
    rr(ctx, (bx + bw * 0.8 - 12) * u, (by + bh - 4) * u, 12 * u, 9 * u, 4 * u); ctx.fill();
  } else { ctx.beginPath(); ctx.arc(S / 2, (by + bh) * u, 7 * u, 0, Math.PI * 2); ctx.fill(); }
  if (sp.ears === 'round') {
    ctx.fillStyle = C(-18); ctx.beginPath();
    ctx.arc(bx * u, (by + bh * 0.45) * u, 8 * u, 0, Math.PI * 2); ctx.arc((bx + bw) * u, (by + bh * 0.45) * u, 8 * u, 0, Math.PI * 2); ctx.fill();
  } else if (sp.ears === 'fin') {
    ctx.fillStyle = C(-18);
    rr(ctx, (bx - 7) * u, (by + bh * 0.3) * u, 8 * u, 22 * u, 3 * u); ctx.fill();
    rr(ctx, (bx + bw - 1) * u, (by + bh * 0.3) * u, 8 * u, 22 * u, 3 * u); ctx.fill();
  }
  ctx.strokeStyle = C(-30); ctx.lineWidth = 3 * u; ctx.lineCap = 'round'; ctx.fillStyle = C(-30);
  const ant = (x: number, h: number): void => {
    ctx.beginPath(); ctx.moveTo(x * u, by * u); ctx.lineTo(x * u, (by - h) * u); ctx.stroke();
    ctx.beginPath(); ctx.arc(x * u, (by - h) * u, 3.2 * u, 0, Math.PI * 2); ctx.fill();
  };
  if (sp.antenna === 'single') ant(50, 12);
  else if (sp.antenna === 'twin') { ant(38, 9); ant(62, 9); }
  else if (sp.antenna === 'loop') { ctx.beginPath(); ctx.arc(50 * u, (by - 4) * u, 9 * u, Math.PI, 0); ctx.stroke(); }
  const g = ctx.createLinearGradient(0, by * u, 0, (by + bh) * u);
  g.addColorStop(0, C(26)); g.addColorStop(1, C(-20));
  ctx.fillStyle = g; rr(ctx, bx * u, by * u, bw * u, bh * u, br * u); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.2 * u;
  rr(ctx, (bx + 1) * u, (by + 1) * u, (bw - 2) * u, (bh - 2) * u, (br - 1) * u); ctx.stroke();
  muster(ctx, u, sp, { x: bx, y: by, w: bw, h: bh, r: br });
  const fx = bx + bw * 0.12, fw = bw * 0.76, fy = by + bh * 0.14, fh = bh * 0.46;
  ctx.fillStyle = pal.screen; rr(ctx, fx * u, fy * u, fw * u, fh * u, 8 * u); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.06)'; rr(ctx, (fx + 2) * u, (fy + 2) * u, (fw - 4) * u, fh * 0.35 * u, 6 * u); ctx.fill();
  // Das Visier des Teamleiters.
  if (sp.leiter) { ctx.fillStyle = 'rgba(255,255,255,.6)'; rr(ctx, (fx + 3) * u, (fy + 3) * u, (fw - 6) * u, 3 * u, 1.5 * u); ctx.fill(); }
  const cx = S / 2, cy = (fy + fh * 0.55) * u;
  const gap = sp.eyeGap * S, es = sp.eyeSize * S * sp.eyeMul;
  const auge = (x: number, lid: number): void => {
    let w = es, h = es * 1.35;
    if (sp.eye === 'round') h = es; else if (sp.eye === 'wide') { w = es * 1.3; h = es * 0.9; }
    const ex = x + e.lookX * es * 0.5, ey = cy + e.lookY * es * 0.5;
    if (e.cross) { kreuzAugen(ctx, x, cy, es * 0.9, pal.eye); return; }
    if (st === 'fertig') { ctx.fillStyle = pal.eye; rr(ctx, ex - w / 2, ey - 1.2 * u, w, 2.4 * u, 1.2 * u); ctx.fill(); return; }
    h *= lid;
    ctx.fillStyle = pal.eye; rr(ctx, ex - w / 2, ey - h / 2, w, Math.max(1.5 * u, h), Math.min(w, h) * 0.42); ctx.fill();
    if (h > 3 * u) {
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(ex + w * 0.22, ey - h * 0.22, Math.max(0.6 * u, w * 0.14), 0, Math.PI * 2); ctx.fill();
    }
  };
  auge(cx - gap / 2, e.lidL); auge(cx + gap / 2, e.lidR);
  zubehoer(ctx, u, sp, C, { x: bx, y: by, w: bw, h: bh }, 'roboter');
  leuchte(ctx, S, st, t, (bx + bw - 9) * u, (by + bh - 9) * u, pal);
  ctx.restore();
}

// ---------- Tier ----------
function zeichneTier(o: Figur, t: number, e: Ausdruck, fern: boolean, pal: Palette): void {
  const { ctx, S, sp, zustand: st } = o;
  const u = S / 100;
  const col = TEAMFARBE[o.team];
  const pupille = pal.screen;
  const C: Ton = (a) => shade(col, a + sp.tint, fern);
  ctx.save();
  ctx.translate(S / 2 + e.sway * u, S / 2 + e.bob * u * 0.5); ctx.rotate(e.tilt); ctx.scale(e.breathe, e.breathe); ctx.translate(-S / 2, -S / 2);
  const cx = S / 2, cy = 57 * u, R = 31 * u;
  ctx.fillStyle = pal.shadow;
  ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.98, R * 0.8, 3.5 * u, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = C(-20); ctx.lineWidth = 4 * u; ctx.lineCap = 'round';
  if (sp.tTail === 'stub') { ctx.beginPath(); ctx.moveTo(cx + R * 0.85, cy + R * 0.5); ctx.lineTo(cx + R * 1.15, cy + R * 0.65); ctx.stroke(); }
  else if (sp.tTail === 'curl') { ctx.beginPath(); ctx.arc(cx + R * 1.05, cy + R * 0.45, R * 0.22, Math.PI * 0.9, Math.PI * 2.2); ctx.stroke(); }
  ctx.fillStyle = C(-8);
  if (sp.tEars === 'pointy') {
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(cx + s * R * 0.4, cy - R * 0.75); ctx.lineTo(cx + s * R * 0.7, cy - R * 1.35); ctx.lineTo(cx + s * R * 0.92, cy - R * 0.5);
      ctx.closePath(); ctx.fill();
    }
  } else if (sp.tEars === 'round') {
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + s * R * 0.75, cy - R * 0.78, R * 0.3, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.strokeStyle = C(-20); ctx.lineWidth = 2.5 * u;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(cx + s * R * 0.35, cy - R * 0.9);
      ctx.quadraticCurveTo(cx + s * R * 0.6, cy - R * 1.5, cx + s * R * 0.95, cy - R * 1.35); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + s * R * 0.95, cy - R * 1.35, 3 * u, 0, Math.PI * 2); ctx.fill();
    }
  }
  const w = sp.wobble;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / 6) * Math.PI * 2 - Math.PI / 2;
    const r0 = R * w[i], r1 = R * w[(i + 1) % 6];
    const x0 = cx + Math.cos(a0) * r0, y0 = cy + Math.sin(a0) * r0, x1 = cx + Math.cos(a1) * r1, y1 = cy + Math.sin(a1) * r1;
    const am = (a0 + a1) / 2, rm = (r0 + r1) / 2 * 1.08;
    if (i === 0) ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx + Math.cos(am) * rm, cy + Math.sin(am) * rm, x1, y1);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.4, R * 0.1, cx, cy, R * 1.2);
  g.addColorStop(0, C(40)); g.addColorStop(1, C(-18));
  ctx.fillStyle = g; ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.22)';
  ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.35, R * 0.45, R * 0.38, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2); ctx.clip();
  muster(ctx, u, sp, { x: cx / u - R / u, y: cy / u - R / u, w: 2 * R / u, h: 2 * R / u, r: R / u });
  ctx.restore();
  // Das Halsband des Teamleiters.
  if (sp.leiter) {
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 2.2 * u;
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.62, R * 0.72, R * 0.16, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (sp.tCheeks) {
    ctx.fillStyle = 'rgba(255,120,140,.35)';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + s * R * 0.55, cy + R * 0.12, R * 0.14, R * 0.09, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  const es = sp.tEye * S * sp.eyeMul, gap = sp.tGap * S, ey0 = cy - R * 0.2;
  const auge = (x: number, lid: number): void => {
    if (e.cross) { kreuzAugen(ctx, x, ey0, es * 1.4, pupille); return; }
    if (st === 'fertig') {
      ctx.strokeStyle = pupille; ctx.lineWidth = Math.max(1.4 * u, es * 0.22); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, ey0 - es * 0.2, es * 0.8, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke(); return;
    }
    const h = es * 2 * lid;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.ellipse(x, ey0, es, Math.max(1.2 * u, h / 2), 0, 0, Math.PI * 2); ctx.fill();
    if (h > 2.5 * u) {
      ctx.save(); ctx.beginPath(); ctx.ellipse(x, ey0, es, h / 2, 0, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = pupille;
      ctx.beginPath(); ctx.arc(x + e.lookX * es * 0.45, ey0 + e.lookY * es * 0.45, es * 0.58, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.beginPath(); ctx.arc(x + e.lookX * es * 0.45 + es * 0.2, ey0 + e.lookY * es * 0.45 - es * 0.22, Math.max(0.7 * u, es * 0.18), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  };
  auge(cx - gap / 2, e.lidL); auge(cx + gap / 2, e.lidR);
  zubehoer(ctx, u, sp, C, { x: cx / u - R / u, y: cy / u - R / u, w: 2 * R / u, h: 2 * R / u }, 'tier');
  leuchte(ctx, S, st, t, cx + R * 0.62, cy + R * 0.72, pal);
  ctx.restore();
}

// ---------- Hauptagent: der Kern ----------
function zeichneKern(o: Figur, t: number, e: Ausdruck, fern: boolean, pal: Palette): void {
  const { ctx, S, sp, zustand: st } = o;
  const u = S / 100;
  const col = TEAMFARBE.hauptagent;
  const C: Ton = (a) => shade(col, a + sp.tint, fern);
  const TILT = sp.ringTilt;
  const still = reduziert();
  const schweben = still ? 0 : Math.sin(t * 1.3) * 2.5;
  const dreh = still ? 0.6 : t * (st === 'arbeitet' ? 2.2 : 0.7);
  ctx.save();
  ctx.translate(S / 2 + e.sway * u, S / 2 + schweben * u); ctx.rotate(e.tilt * 0.5); ctx.translate(-S / 2, -S / 2);
  const cx = S / 2, cy = 52 * u, R = 26 * u;
  ctx.fillStyle = pal.shadow;
  ctx.beginPath(); ctx.ellipse(cx, 88 * u, R * 0.7, 3 * u, 0, 0, Math.PI * 2); ctx.fill();
  // Glut
  const glut = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.7);
  glut.addColorStop(0, fern ? 'rgba(120,120,130,.25)' : 'rgba(88,86,214,.28)'); glut.addColorStop(1, 'rgba(88,86,214,0)');
  ctx.fillStyle = glut; ctx.beginPath(); ctx.arc(cx, cy, R * 1.7, 0, Math.PI * 2); ctx.fill();
  // Ring hinten
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(TILT); ctx.scale(1, 0.32);
  ctx.strokeStyle = C(-30); ctx.lineWidth = 3.2 * u; ctx.beginPath(); ctx.arc(0, 0, R * 1.55, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.restore();
  const satPos = (a: number): [number, number] => {
    const rx = Math.cos(a) * R * 1.55, ry = Math.sin(a) * R * 1.55 * 0.32;
    return [cx + rx * Math.cos(TILT) - ry * Math.sin(TILT), cy + rx * Math.sin(TILT) + ry * Math.cos(TILT)];
  };
  // Der Satellit verschwindet hinter dem Kern, wenn er dort ist.
  const sats: { a: number; hinten: boolean; r: number }[] = [];
  for (let i = 0; i < sp.sats; i++) { const a = dreh + i * Math.PI * 1.1; sats.push({ a, hinten: Math.sin(a) < 0, r: (i === 0 ? 3.6 : 2.6) * u }); }
  for (const sat of sats) {
    if (!sat.hinten) continue;
    const [sx, sy] = satPos(sat.a);
    ctx.fillStyle = C(-25); ctx.beginPath(); ctx.arc(sx, sy, sat.r, 0, Math.PI * 2); ctx.fill();
  }
  // Kern
  const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.05);
  g.addColorStop(0, C(70)); g.addColorStop(0.6, C(0)); g.addColorStop(1, C(-45));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.2 * u; ctx.beginPath(); ctx.arc(cx, cy, R - 1 * u, 0, Math.PI * 2); ctx.stroke();
  // Augen
  const es = 8.5 * u, gap = 17 * u;
  const auge = (x: number, lid: number): void => {
    const ex = x + e.lookX * es * 0.4, ey = cy - 2 * u + e.lookY * es * 0.4;
    if (e.cross) { kreuzAugen(ctx, x, cy - 2 * u, es * 1.1, pal.eye); return; }
    if (st === 'fertig') { ctx.fillStyle = pal.eye; rr(ctx, ex - es * 0.6, ey - 1.1 * u, es * 1.2, 2.2 * u, 1.1 * u); ctx.fill(); return; }
    const h = Math.max(1.5 * u, es * 1.5 * lid);
    ctx.fillStyle = pal.eye; rr(ctx, ex - es * 0.55, ey - h / 2, es * 1.1, h, es * 0.45); ctx.fill();
    if (h > 3 * u) { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(ex + es * 0.25, ey - h * 0.25, 0.9 * u, 0, Math.PI * 2); ctx.fill(); }
  };
  auge(cx - gap / 2, e.lidL); auge(cx + gap / 2, e.lidR);
  // Ring vorn und Satellit
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(TILT); ctx.scale(1, 0.32);
  ctx.strokeStyle = C(-10); ctx.lineWidth = 3.2 * u; ctx.beginPath(); ctx.arc(0, 0, R * 1.55, 0, Math.PI); ctx.stroke();
  ctx.restore();
  for (const sat of sats) {
    if (sat.hinten) continue;
    const [sx, sy] = satPos(sat.a);
    ctx.fillStyle = C(12); ctx.beginPath(); ctx.arc(sx, sy, sat.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.beginPath(); ctx.arc(sx - sat.r * 0.3, sy - sat.r * 0.3, sat.r * 0.35, 0, Math.PI * 2); ctx.fill();
  }
  leuchte(ctx, S, st, t, cx + R * 0.75, cy + R * 0.75, pal);
  ctx.restore();
}

// ---------- Reviewer: die Linse ----------
function zeichneLinse(o: Figur, t: number, e: Ausdruck, fern: boolean, pal: Palette): void {
  const { ctx, S, sp, zustand: st } = o;
  const u = S / 100;
  const C: Ton = (a) => shade(TEAMFARBE.reviewer, a + sp.tint * 0.5, fern);
  const I: Ton = (a) => shade(TEAMFARBE.pruefung, a + sp.hueShift, fern);
  ctx.save();
  ctx.translate(S / 2 + e.sway * u, S / 2 + e.bob * u); ctx.rotate(e.tilt); ctx.translate(-S / 2, -S / 2);
  const bx = 30, by = 14, bw = 40, bh = 64; const cx = S / 2;
  ctx.fillStyle = pal.shadow; ctx.beginPath(); ctx.ellipse(cx, 92 * u, 22 * u, 3.5 * u, 0, 0, Math.PI * 2); ctx.fill();
  // Dreibein
  ctx.strokeStyle = C(-25); ctx.lineWidth = 3.2 * u; ctx.lineCap = 'round';
  for (const dx of [-16, 0, 16]) { ctx.beginPath(); ctx.moveTo(cx, (by + bh - 6) * u); ctx.lineTo(cx + dx * u, 91 * u); ctx.stroke(); }
  // Gehaeuse
  const g = ctx.createLinearGradient(bx * u, 0, (bx + bw) * u, 0);
  g.addColorStop(0, C(30)); g.addColorStop(0.5, C(8)); g.addColorStop(1, C(-25));
  ctx.fillStyle = g; rr(ctx, bx * u, by * u, bw * u, bh * u, 10 * u); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1.2 * u; rr(ctx, (bx + 1) * u, (by + 1) * u, (bw - 2) * u, (bh - 2) * u, 9 * u); ctx.stroke();
  // Braue
  ctx.save(); ctx.translate(cx, (by + 9) * u); ctx.rotate(st === 'entscheidung' ? -0.18 : 0); ctx.fillStyle = C(-40);
  if (sp.brow === 'flat') { rr(ctx, -15 * u, -2.5 * u, 30 * u, 5 * u, 2.5 * u); ctx.fill(); }
  else if (sp.brow === 'arc') { ctx.lineWidth = 5 * u; ctx.strokeStyle = C(-40); ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(0, 6 * u, 16 * u, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
  else {
    ctx.beginPath(); ctx.moveTo(-15 * u, 2 * u); ctx.lineTo(0, -3 * u); ctx.lineTo(15 * u, 2 * u); ctx.lineTo(15 * u, 5 * u); ctx.lineTo(0, 0); ctx.lineTo(-15 * u, 5 * u);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // Linse
  const ly = (by + 30) * u, LR = 15 * u;
  ctx.fillStyle = pal.screen; ctx.beginPath(); ctx.arc(cx, ly, LR, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(cx, ly, LR - 1.5 * u, 0, Math.PI * 2); ctx.clip();
  if (e.cross) { kreuzAugen(ctx, cx, ly, LR * 1.1, I(20)); }
  else {
    const ir = st === 'arbeitet' ? LR * 0.42 : st === 'ungelesen' ? LR * 0.7 : LR * 0.55;
    const lid = Math.min(e.lidL, e.lidR);
    const ix = cx + e.lookX * LR * 0.3, iy = ly + e.lookY * LR * 0.3;
    if (st === 'fertig' || lid < 0.2) {
      ctx.fillStyle = C(-10); ctx.fillRect(cx - LR, ly - LR, LR * 2, LR * 2);
      ctx.strokeStyle = I(0); ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.moveTo(cx - LR * 0.6, ly); ctx.lineTo(cx + LR * 0.6, ly); ctx.stroke();
    } else {
      const ig = ctx.createRadialGradient(ix, iy, ir * 0.2, ix, iy, ir);
      ig.addColorStop(0, I(60)); ig.addColorStop(0.7, I(0)); ig.addColorStop(1, I(-40));
      ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(ix, iy, ir, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pal.screen; ctx.beginPath(); ctx.arc(ix, iy, ir * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(ix - ir * 0.35, iy - ir * 0.4, Math.max(0.8 * u, ir * 0.18), 0, Math.PI * 2); ctx.fill();
      // Der Abtastbalken beim Pruefen.
      if (st === 'arbeitet' && !reduziert()) {
        const sy = ly - LR + ((t * 30 * u) % (LR * 2));
        ctx.fillStyle = 'rgba(255,200,120,.55)'; ctx.fillRect(cx - LR, sy, LR * 2, 1.6 * u);
      }
    }
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5 * u; ctx.beginPath(); ctx.arc(cx, ly, LR, 0, Math.PI * 2); ctx.stroke();
  // Haekchen
  ctx.strokeStyle = I(10); ctx.lineWidth = 1.8 * u; ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const yy = (by + 52 + i * 6) * u;
    ctx.beginPath(); ctx.moveTo(cx - 6 * u, yy); ctx.lineTo(cx - 3 * u, yy + 2.5 * u); ctx.lineTo(cx + 5 * u, yy - 3 * u); ctx.stroke();
  }
  leuchte(ctx, S, st, t, (bx + bw - 6) * u, (by + bh - 7) * u, pal);
  ctx.restore();
}

const ZEICHNER: Record<Gestalt, (o: Figur, t: number, e: Ausdruck, fern: boolean, pal: Palette) => void> = {
  roboter: zeichneRoboter, tier: zeichneTier, kern: zeichneKern, linse: zeichneLinse,
};

let gezeichnet = 0;
function zeichne(o: Figur, t: number): void {
  const { ctx, S, dpr } = o;
  const pal = palette();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);
  const e = ausdruck(o, t);
  const fern = o.zustand === 'fern';
  ctx.save();
  if (fern) ctx.globalAlpha = 0.5;
  ZEICHNER[o.gestalt](o, t, e, fern, pal);
  ctx.restore();
  if (fern) fernRahmen(ctx, S, pal);
  if (o.zustand !== 'ruhig' && !fern) zeichen(ctx, S, o.zustand, t, S * 0.8, S * 0.17, pal);
  gezeichnet++;
}

// --- Der gemeinsame Animationsrahmen ------------------------------------------

const lebende = new Set<Figur>();
const figurVon = new WeakMap<HTMLCanvasElement, Figur>();
let rahmenLaeuft = false;
let rahmen = 0;

const beobachter = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((eintraege) => {
    for (const e of eintraege) {
      const f = figurVon.get(e.target as HTMLCanvasElement);
      if (f) f.sichtbar = e.isIntersecting;
    }
    // Eine Figur ist wieder zu sehen: der angehaltene Rahmen laeuft an.
    if (eintraege.some((e) => e.isIntersecting)) starten();
  })
  : null;

function austragen(f: Figur): void {
  lebende.delete(f);
  beobachter?.unobserve(f.c);
}

/**
 * ABGEHAENGTE FIGUREN AUSTRAGEN (Reviewer-Befund M3, 11.09.2026). Bis dahin
 * flog eine ersetzte Figur nur im Animationsrahmen aus der Liste -- und den
 * gibt es bei „Bewegung reduzieren" nicht. Jeder Neubau der Vorschau liess
 * dann 92 Canvas samt Kontext im Speicher. Wer neu zeichnet, ruft das hier
 * danach auf. Gibt die Zahl der lebenden Figuren zurueck.
 */
export function figurenAufraeumen(): number {
  for (const f of [...lebende]) if (!f.c.isConnected) austragen(f);
  return lebende.size;
}

function animiert(): boolean {
  return !reduziert() && !document.hidden;
}

function schleife(jetzt: number): void {
  if (!animiert() || !lebende.size) { rahmenLaeuft = false; return; }
  let gezeigt = 0;
  for (const f of lebende) {
    if (!f.c.isConnected) { austragen(f); continue; }
    if (f.sichtbar) { zeichne(f, (jetzt - f.t0) / 1000); gezeigt++; }
  }
  // Nichts zu sehen (Code-Modus, verborgenes Blatt): der Rahmen haelt an, bis
  // der Beobachter wieder eine Figur im Bild meldet.
  if (!gezeigt) { rahmenLaeuft = false; return; }
  rahmen++;
  requestAnimationFrame(schleife);
}

function starten(): void {
  if (rahmenLaeuft || !animiert() || !lebende.size) return;
  rahmenLaeuft = true;
  requestAnimationFrame(schleife);
}

document.addEventListener('visibilitychange', starten);
reduziertAbfrage?.addEventListener('change', () => figurenBewegungErzwingen(reduziertErzwungen));

// --- Die Figur als Element ---------------------------------------------------

export interface FigurWunsch {
  rolle: string;
  stufe?: string;
  /** Der Worker-Name -- er waehlt die Instanz-Abwandlung. */
  name?: string;
  /** Das Team, falls der Kern es nennt; sonst aus der Rolle. */
  team?: string;
  /** Die Art ausdruecklich, fuer die Vorschau; sonst aus den Einstellungen. */
  art?: Art;
  groesse: number;
  zustand?: FigurZustand;
  /** Was ein Screenreader und das Schildchen sagen. */
  titel?: string;
}

function gestaltVon(w: FigurWunsch, team: Team): Gestalt {
  if (w.rolle === 'hauptagent') return 'kern';
  if (w.rolle === 'reviewer') return 'linse';
  return w.art ?? artVon(team);
}

function merkmal(w: FigurWunsch): string {
  const team = teamVon(w.rolle, w.team);
  return [w.rolle, w.stufe ?? '', w.name ?? '', team, gestaltVon(w, team), w.groesse, w.zustand ?? 'ruhig'].join('|');
}

/**
 * Eine Figur als Canvas. `wiederverwenden` nimmt ein Canvas, das dieselbe
 * Figur schon zeigt: die Ansicht zeichnet alle zwei Sekunden neu, und ohne das
 * finge jede Figur im Takt von vorn an zu blinzeln.
 */
export function figur(w: FigurWunsch, wiederverwenden?: HTMLCanvasElement | null): HTMLCanvasElement {
  if (wiederverwenden && wiederverwenden.dataset.figur === merkmal(w)) return wiederverwenden;
  const dpr = window.devicePixelRatio || 1;
  const S = w.groesse;
  const c = document.createElement('canvas');
  c.width = Math.round(S * dpr); c.height = Math.round(S * dpr);
  c.style.width = `${S}px`; c.style.height = `${S}px`;
  c.className = 'agentenfigur';
  c.dataset.figur = merkmal(w);
  const team = teamVon(w.rolle, w.team);
  const gestalt = gestaltVon(w, team);
  c.dataset.gestalt = gestalt;
  c.dataset.zustand = w.zustand ?? 'ruhig';
  c.setAttribute('role', 'img');
  if (w.titel) { c.setAttribute('aria-label', w.titel); c.title = w.titel; }
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const o: Figur = {
    c, ctx, S, dpr, sp: bauplan(w.rolle, w.stufe ?? 'mitglied', w.name), team, gestalt,
    zustand: w.zustand ?? 'ruhig', t0: performance.now() - Math.random() * 4000,
    nextBlink: 1 + Math.random() * 4, blinkAt: -1, sichtbar: true,
  };
  figurVon.set(c, o);
  zeichne(o, (performance.now() - o.t0) / 1000);
  lebende.add(o);
  beobachter?.observe(c);
  starten();
  return c;
}

/** Hat das Canvas wirklich etwas gezeichnet? Die Probe der Suiten: Deckung ueber null. */
export function figurDeckung(c: HTMLCanvasElement): number {
  const ctx = c.getContext('2d');
  if (!ctx || !c.width || !c.height) return 0;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let gedeckt = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 16) gedeckt++;
  return gedeckt / (c.width * c.height);
}

/** Was eine Suite ueber den Rahmen wissen will. */
export function figurenStand(): Record<string, unknown> {
  return {
    lebende: lebende.size, sichtbar: [...lebende].filter((f) => f.sichtbar).length, rahmen, gezeichnet, reduziert: reduziert(),
    animiert: animiert(), rahmenLaeuft, erzwungen: reduziertErzwungen,
  };
}
