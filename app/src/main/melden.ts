// Benachrichtigungen nach aussen (SPEC-V4 3.5). Vier Ausloeser -- Worker
// fertig, Freigabe wartet, Sitzung tot, Limit fast voll -- melden sich an der
// Stelle, die ihren Zustand ohnehin schon kennt (main.ts liest sie zusammen).
// Diese Datei entscheidet nur: darf ueberhaupt etwas raus, ueber welchen Weg,
// und nicht zum zweiten Mal fuer dasselbe Ereignis.
//
// GESCHRIEBEN WIRD HIER NICHTS. Die Schluessel `meldungen.*` kommen aus
// derselben Datei wie alle anderen Einstellungen (einstellungen.ts); fehlt der
// Schluessel, gilt dasselbe wie ueberall in diesem Haus: die Vorgabe, und die
// Vorgabe fuer Benachrichtigungen ist AUS. Ein Programm, das nie von selbst
// meldet, ist der sichere Fehler -- eines, das ohne ausdrueckliches "an" doch
// meldet, ist der teure.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { einstellungenPfad, meldungen } from './einstellungen';

export type MeldungsEreignis = 'workerFertig' | 'freigabeWartet' | 'sitzungTot' | 'limitFastVoll';
export type MeldungsWeg = 'system' | 'ton' | 'handy';

export interface MeldungsEinstellungen {
  an: boolean;
  ereignisse: ReadonlySet<MeldungsEreignis>;
  wege: ReadonlySet<MeldungsWeg>;
  /** Ein Webhook, den der Mensch selbst eintraegt. Leer = 'handy' bleibt wirkungslos. */
  handyUrl: string;
  /** Leer = Systemton. */
  tonDatei: string;
  /** Prozent des Anthropic-Limits, ab dem 'limitFastVoll' meldet. */
  limitSchwelle: number;
}

/**
 * Liest `meldungen.*` -- ueber `meldungen()` aus `einstellungen.ts`, dieselbe
 * Funktion, die auch die Oberflaeche fuellt. Bis zum 11.08. hatte dieser Weg
 * eine EIGENE, vorsichtigere Lesart (fehlende `ereignisse`/`wege` -> leer,
 * waehrend die Oberflaeche auf die volle Vorgabe zurueckfiel); die Oberflaeche
 * traegt diese Vorsicht jetzt selbst, siehe die Begruendung dort. Die Wandlung
 * hier ist nur noch: Zeichenketten-Listen zu `Set`, fuer den bequemen
 * `.has(...)`-Aufruf in `melden()` unten.
 */
export function meldungsEinstellungen(pfad = einstellungenPfad()): MeldungsEinstellungen {
  const m = meldungen(pfad);
  return {
    an: m.an,
    ereignisse: new Set(m.ereignisse as MeldungsEreignis[]),
    wege: new Set(m.wege as MeldungsWeg[]),
    handyUrl: m.handyUrl,
    tonDatei: m.tonDatei,
    limitSchwelle: m.limitSchwelle,
  };
}

/** Die drei Sendewege, austauschbar -- ein Test ersetzt sie durch eine Attrappe. */
export interface Sendewege {
  system(text: string): void;
  ton(tonDatei: string): void;
  handy(url: string, text: string): void;
}

/**
 * DIE Entscheidung: darf dieses Ereignis ueberhaupt raus, und ueber welchen
 * Weg. Ohne Nebenwirkung ausser dem Aufruf der uebergebenen Wege -- ein Test
 * kann `wege` durch Attrappen ersetzen und diese Funktion trotzdem echt
 * ausfuehren.
 */
export function melden(
  ereignis: MeldungsEreignis,
  text: string,
  einstellungen: MeldungsEinstellungen,
  wege: Sendewege,
): void {
  if (!einstellungen.an) return;
  if (!einstellungen.ereignisse.has(ereignis)) return;
  if (einstellungen.wege.has('system')) wege.system(text);
  if (einstellungen.wege.has('ton')) wege.ton(einstellungen.tonDatei);
  if (einstellungen.wege.has('handy') && einstellungen.handyUrl) wege.handy(einstellungen.handyUrl, text);
}

/**
 * Entprellung fuer Ereignisse, die als STEHENDE Menge vorliegen (offene
 * Antraege, wartende Rueckfragen, verlorene Sitzungen): jeder Aufruf bekommt
 * die AKTUELLE volle Menge und bekommt zurueck, was seit dem letzten Aufruf
 * NEU dazugekommen ist. Verschwindet ein Schluessel und taucht er spaeter
 * wieder auf, gilt er erneut als neu -- das ist kein zweites Mal derselben
 * Meldung, sondern ein zweites Vorkommnis.
 */
export class NeuheitsFilter {
  private aktiv = new Set<string>();

  neue(jetzt: Iterable<string>): string[] {
    const jetztMenge = new Set(jetzt);
    const frisch: string[] = [];
    for (const schluessel of jetztMenge) if (!this.aktiv.has(schluessel)) frisch.push(schluessel);
    this.aktiv = jetztMenge;
    return frisch;
  }
}

/**
 * Entprellung fuer eine Schwelle: meldet nur den UEBERGANG von unter- auf
 * ueber-Schwelle, nicht jeden Takt, in dem der Wert weiter darueber liegt.
 * Faellt der Wert wieder unter die Schwelle, ist der Melder erneut scharf.
 * -1 (unbekannt, siehe budget.ts) zaehlt nie als ueberschritten.
 */
export class SchwellenMelder {
  private ueber = false;

  ueberschritten(prozent: number, schwelle: number): boolean {
    if (prozent < 0) {
      this.ueber = false;
      return false;
    }
    const jetzt = prozent >= schwelle;
    const neu = jetzt && !this.ueber;
    this.ueber = jetzt;
    return neu;
  }
}

/** Das hoehere der beiden Anthropic-Limit-Prozente -- welcher Topf zuerst voll wird, zaehlt. */
export function budgetProzent(stand: { fiveHourPct: number; sevenDayPct: number }): number {
  return Math.max(stand.fiveHourPct, stand.sevenDayPct);
}

// --- Die drei echten Sendewege -----------------------------------------------
//
// Alle drei sind fire-and-forget: ein fehlendes Programm, eine unerreichbare
// URL oder ein leerer Ton haelt das Programm nie an und wirft nie -- eine
// Benachrichtigung, die selbst zum Fehler wird, ist schlimmer als eine, die
// ausbleibt.

function appleScriptZeichenkette(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const MACOS_STANDARDTON = '/System/Library/Sounds/Glass.aiff';
const LINUX_STANDARDTON = '/usr/share/sounds/freedesktop/stereo/complete.oga';

function systemMeldungSenden(text: string): void {
  // Welche Maschine laeuft, steht bereits in process.platform -- nicht raten.
  if (process.platform === 'darwin') {
    const skript = `display notification ${appleScriptZeichenkette(text)} with title "Agent-Workbench"`;
    spawn('osascript', ['-e', skript], { stdio: 'ignore' }).on('error', () => {});
  } else {
    spawn('notify-send', ['Agent-Workbench', text], { stdio: 'ignore' }).on('error', () => {});
  }
}

function tonMeldungSenden(tonDatei: string): void {
  if (process.platform === 'darwin') {
    spawn('afplay', [tonDatei || MACOS_STANDARDTON], { stdio: 'ignore' }).on('error', () => {});
  } else {
    spawn('paplay', [tonDatei || LINUX_STANDARDTON], { stdio: 'ignore' }).on('error', () => {});
  }
}

function handyMeldungSenden(url: string, text: string): void {
  let ziel: URL;
  try {
    ziel = new URL(url);
  } catch {
    return;
  }
  const aufrufen = ziel.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = JSON.stringify({ text });
  try {
    const req = aufrufen(ziel, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch {
    // Ein nicht erreichbares Handy haelt das Programm nicht auf.
  }
}

export const STANDARD_WEGE: Sendewege = {
  system: systemMeldungSenden,
  ton: tonMeldungSenden,
  handy: handyMeldungSenden,
};

// --- Der Testknopf -----------------------------------------------------------
//
// Der Knopf 'Test senden' im Einstellungsfenster (SPEC-V4 3.5, 12.08.) schickt
// EINE echte Probe ueber genau die gewaehlten Wege und meldet danach je Weg
// zurueck, was passiert ist -- die drei Sendewege oben sind fire-and-forget
// und liefern nie eine Rueckmeldung, dafuer sind sie nicht gebaut. Deshalb ein
// eigenes, ZWEITES Interface (`TestSendewege`), aber dieselbe Bauform wie
// `Sendewege`: Wege als Parameter, damit ein Test sie durch eine Attrappe
// ersetzen kann, ohne dass `meldenTesten()` selbst etwas anderes zutraut.
export interface WegErgebnis {
  ok: boolean;
  /** Nur bei !ok -- der Grund, warum es nicht ging. */
  grund?: string;
  /** Nur bei 'handy' -- der HTTP-Status der Antwort. */
  status?: number;
}

export interface TestSendewege {
  system(text: string): Promise<WegErgebnis>;
  ton(tonDatei: string): Promise<WegErgebnis>;
  handy(url: string, text: string): Promise<WegErgebnis>;
}

export interface TestErgebnis {
  /** Der Hauptschalter -- bei 'false' wurde NICHTS gesendet, `ergebnisse` bleibt leer. */
  an: boolean;
  ergebnisse: Partial<Record<MeldungsWeg, WegErgebnis>>;
}

/** Nichts als der Hinweis, dass es eine Probe ist -- kein Pfad, kein Sitzungsinhalt, kein Schluessel. */
export const PROBE_TEXT = 'Das ist eine Probemeldung des Agent-Workbench -- keine echte Meldung.';

/**
 * Die Entscheidung fuer den Testknopf: ohne `an` wird nichts gesendet, und das
 * ist die Antwort selbst (der Knopf sagt es, statt heimlich zu senden). Mit
 * `an` bekommt jeder GEWAEHLTE Weg genau einen Aufruf, unabhaengig von
 * `ereignisse` -- der Test prueft den Weg, nicht ein Ereignis.
 */
export async function meldenTesten(
  einstellungen: MeldungsEinstellungen,
  wege: TestSendewege,
): Promise<TestErgebnis> {
  if (!einstellungen.an) return { an: false, ergebnisse: {} };
  const ergebnisse: Partial<Record<MeldungsWeg, WegErgebnis>> = {};
  if (einstellungen.wege.has('system')) ergebnisse.system = await wege.system(PROBE_TEXT);
  if (einstellungen.wege.has('ton')) ergebnisse.ton = await wege.ton(einstellungen.tonDatei);
  if (einstellungen.wege.has('handy')) {
    ergebnisse.handy = einstellungen.handyUrl
      ? await wege.handy(einstellungen.handyUrl, PROBE_TEXT)
      : { ok: false, grund: 'keine Adresse eingetragen' };
  }
  return { an: true, ergebnisse };
}

/** Wartet auf das Ende eines Kindprozesses und meldet Erfolg/Grund, statt nur fire-and-forget zu sein. */
function kindprozessAbwarten(kommando: string, argumente: string[]): Promise<WegErgebnis> {
  return new Promise((resolve) => {
    const kind = spawn(kommando, argumente);
    let stderr = '';
    kind.stderr?.on('data', (stueck: Buffer) => { stderr += stueck.toString(); });
    kind.on('error', (fehler) => resolve({ ok: false, grund: fehler.message }));
    kind.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, grund: stderr.trim() || `beendet mit Code ${String(code)}` });
    });
  });
}

function systemMeldungTesten(text: string): Promise<WegErgebnis> {
  if (process.platform === 'darwin') {
    const skript = `display notification ${appleScriptZeichenkette(text)} with title "Agent-Workbench"`;
    return kindprozessAbwarten('osascript', ['-e', skript]);
  }
  return kindprozessAbwarten('notify-send', ['Agent-Workbench', text]);
}

function tonMeldungTesten(tonDatei: string): Promise<WegErgebnis> {
  if (process.platform === 'darwin') return kindprozessAbwarten('afplay', [tonDatei || MACOS_STANDARDTON]);
  return kindprozessAbwarten('paplay', [tonDatei || LINUX_STANDARDTON]);
}

function handyMeldungTesten(url: string, text: string): Promise<WegErgebnis> {
  return new Promise((resolve) => {
    let ziel: URL;
    try {
      ziel = new URL(url);
    } catch {
      resolve({ ok: false, grund: 'ungueltige Adresse' });
      return;
    }
    const aufrufen = ziel.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = JSON.stringify({ text });
    try {
      const req = aufrufen(ziel, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        resolve(ok ? { ok, status } : { ok, status, grund: `HTTP ${status}` });
      });
      req.on('error', (fehler) => resolve({ ok: false, grund: fehler.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, grund: 'Zeitueberschreitung' });
      });
      req.write(payload);
      req.end();
    } catch (fehler) {
      resolve({ ok: false, grund: fehler instanceof Error ? fehler.message : String(fehler) });
    }
  });
}

export const STANDARD_TEST_WEGE: TestSendewege = {
  system: systemMeldungTesten,
  ton: tonMeldungTesten,
  handy: handyMeldungTesten,
};
