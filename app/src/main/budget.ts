// V13: Budget im Blick. `wb-budget` rechnet Verbrauch und Hochrechnung schon
// aus -- diese Datei ruft es auf und liest sein ERGEBNIS, sie rechnet nichts
// nach. Gemessen (05.08.): ein Lauf braucht 9,3 Sekunden (105 % CPU, scannt
// Transcripte bis zu acht Tage zurueck) -- weit zu langsam fuer den 2s-Takt
// von main.ts. Dieselbe Regel wie bei RemotePoller (remote.ts): ein eigener,
// deutlich langsamerer, ASYNCHRONER Takt, der nur den letzten Stand vorhaelt.
//
// DER POLLER NIMMT SEIT DEM 16.08. DEN JSON-WEG. Gemessen im Worktree, je drei
// Laeufe: der BERICHT (`wb-budget` ohne Argumente) braucht 11,2-11,5 s,
// `wb-budget --json --tage 1 --harness claude` 0,20-0,24 s -- dieselben Zahlen
// aus derselben Quelle, nur ohne den Textbericht ueber acht Tage drumherum.
// Alle fuenf Minuten den teuren Weg zu starten hiess rund 140 Sekunden
// Python-Volllast je Stunde fuer eine Fusszeilenzahl.
//
// Der Textleser `parseBudget` BLEIBT: `wb-budget` ohne Argumente ist weiter der
// Weg des Menschen am Terminal, und der Leser dafuer ist gemessen und geprueft
// (test-app-ampel-budget.sh, Teil B). Zwei Wege in dieselbe Auskunft sind hier
// kein Widerspruch, sondern zwei Quellen: Text fuer den Menschen, JSON fuer das
// Programm.
//
// WARUM `--harness claude`: die Fusszeile stand seit jeher fuer den
// Claude-Verbrauch (der Bericht liest ausschliesslich ~/.claude/projects), und
// die beiden Prozentzahlen darunter sind Anthropic-Limits. Ein Codex- oder
// pi-Worker in derselben Zahl waere eine andere Auskunft unter demselben Namen.
import { spawn } from 'node:child_process';

export interface BudgetStand {
  ok: boolean;
  fetchedAt: number;
  /** Leer, wenn der letzte Lauf glatt war. */
  error: string;
  heuteTokens: number;
  heuteStunden: number;
  hochrechnung24h: number;
  /** Ein Satz fuer den Klick-Hinweis, aus denselben Zahlen wie `wb-budget` selbst zeigt. */
  text: string;
  /**
   * Plan-Limit-Prozente (Anthropic 5h/7d-Fenster, Abschnitt "== Plan-Limit
   * =="). -1, wenn `wb-budget` keinen Log-Eintrag dafuer hatte -- fehlt der
   * Abschnitt, ist er unbekannt, nicht 0. Fuer 'limitFastVoll' (melden.ts)
   * die einzige Prozentzahl im Haus, die etwas ueber ein ECHTES Limit sagt.
   */
  fiveHourPct: number;
  sevenDayPct: number;
  /**
   * Wann das Kontingent zurueckfaellt, im Klartext von `wb-budget`
   * ("2026-08-12 14:00 CEST"). Leer, wenn der Abschnitt fehlt oder das Log
   * keinen Ruecksetzpunkt kennt -- dann steht in der Statusleiste keiner, statt
   * eines geratenen.
   */
  resetText: string;
}

function leererStand(error: string): BudgetStand {
  return {
    ok: false, fetchedAt: Date.now(), error, heuteTokens: 0, heuteStunden: 0, hochrechnung24h: 0,
    text: 'Budget: nicht verfuegbar', fiveHourPct: -1, sevenDayPct: -1, resetText: '',
  };
}

/**
 * Liest exakt die zwei Zeilen aus `wb-budget`s eigener Ausgabe, die fuer einen
 * Blick VOR dem Spawnen zaehlen: was heute schon verbraucht ist, und die
 * Hochrechnung auf 24 Stunden. Reine Funktion, gegen echten `wb-budget`-Text
 * getestet (test-app-budget-ampel.sh).
 */
export function parseBudget(raw: string): BudgetStand {
  const heute = raw.match(/bisher heute:\s*(\d+)\s*Tokens[^\n]*?in\s*([\d.]+)h/);
  const projektion = raw.match(/Hochrechnung auf 24h:\s*~(\d+)\s*Tokens/);
  if (!heute || !projektion) return leererStand('Ausgabe von wb-budget nicht im erwarteten Format');
  const heuteTokens = Number(heute[1]);
  const heuteStunden = Number(heute[2]);
  const hochrechnung24h = Number(projektion[1]);
  // Eigene, separate Zeile ("Stand ...: 5h=NN%  7d=NN%  Reset=..."), deshalb
  // ein eigener, unabhaengiger Treffer -- ihr Fehlen darf `ok` oben nicht
  // beruehren, das Log dafuer kann schlicht noch nicht existieren.
  const limit = raw.match(/5h=([\d.]+)%\s+7d=([\d.]+)%(?:\s+Reset=([^\n]*))?/);
  const fiveHourPct = limit ? Number(limit[1]) : -1;
  const sevenDayPct = limit ? Number(limit[2]) : -1;
  // 'unbekannt' ist die Antwort von wb-budget, wenn das Log keinen
  // Ruecksetzpunkt fuehrt -- sie hier stehenzulassen hiesse, ein Wort als
  // Zeitpunkt auszugeben.
  const rohReset = (limit?.[3] ?? '').trim();
  const resetText = rohReset && rohReset !== 'unbekannt' ? rohReset : '';
  const text = `Budget heute: ${heuteTokens.toLocaleString('de-DE')} Tokens in ${heuteStunden.toFixed(1)} h -- Hochrechnung auf 24h: ~${hochrechnung24h.toLocaleString('de-DE')}`;
  return { ok: true, fetchedAt: Date.now(), error: '', heuteTokens, heuteStunden, hochrechnung24h, text, fiveHourPct, sevenDayPct, resetText };
}

/** Die Argumente des JSON-Wegs, an EINER Stelle -- Poller und Test nehmen dieselben. */
export const BUDGET_JSON_ARGV = ['--json', '--tage', '1', '--harness', 'claude'];

/**
 * Ein Ruecksetzpunkt im Klartext, aus der Epochensekunde, die `wb-budget --json`
 * mitgibt.
 *
 * Der Textbericht liess `date -r … '+%Y-%m-%d %H:%M %Z'` schreiben und bekam
 * damit die Kuerzel des Systems ("CEST"). Hier steht stattdessen, was die
 * Laufzeitumgebung wirklich hergibt -- "2026-08-16 04:10 GMT+2". Ein Kuerzel,
 * das wir uns selbst ausdenken, waere eine Zeitzonen-Behauptung; der Versatz
 * ist dieselbe Auskunft, nur nachpruefbar.
 */
export function resetKlartext(roh: unknown): string {
  const epoch = Number(roh);
  if (!roh || !Number.isFinite(epoch) || epoch <= 0) return '';
  const teile = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(new Date(epoch * 1000));
  const w = (art: string) => teile.find((t) => t.type === art)?.value ?? '';
  const zone = w('timeZoneName');
  return `${w('year')}-${w('month')}-${w('day')} ${w('hour')}:${w('minute')}${zone ? ` ${zone}` : ''}`;
}

/**
 * Liest die Ausgabe von `wb-budget --json` (Argumente: BUDGET_JSON_ARGV).
 *
 * DIESELBEN Zahlen wie `parseBudget` aus dem Textbericht, nur aus Feldern statt
 * aus Saetzen:
 *
 *   heuteTokens      Summe `ohne_cache_read` aller `je_tag`-Zeilen des heutigen
 *                    UTC-Tages -- genau die Groesse, die der Bericht "bisher
 *                    heute (input+output+cache_write)" nennt. Cache-LESEN
 *                    bleibt draussen, aus demselben Grund wie dort.
 *   heuteStunden     Wie weit der UTC-Tag zum Zeitpunkt `erzeugt` gelaufen ist
 *                    -- die Uhr des Berichts, nicht unsere.
 *   hochrechnung24h  Dieselbe lineare Fortschreibung wie im Bericht. Frueher
 *                    als eine Viertelstunde nach Mitternacht UTC rechnet der
 *                    Bericht nicht (zu wenig Tag fuer eine Steigung); dann
 *                    steht hier 0, und der Satz sagt es.
 *   fiveHourPct/…    Der letzte Punkt aus `limits` (aus limits.jsonl, das die
 *                    Statuszeile fortschreibt). Fehlt er, bleibt es bei -1 --
 *                    unbekannt ist nicht 0.
 *
 * Streng wie `parseVerbrauch` (verbrauch/rechnen.ts): fehlt eines der Felder,
 * auf denen die Auskunft steht, gibt es einen Fehlerstand und keine gerechnete
 * Null.
 */
export function parseBudgetJson(raw: string): BudgetStand {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return leererStand('Ausgabe von wb-budget --json ist kein JSON');
  }
  if (!d || typeof d !== 'object') return leererStand('Ausgabe von wb-budget --json ist kein Objekt');
  const o = d as Record<string, unknown>;
  const erzeugt = typeof o.erzeugt === 'string' ? Date.parse(o.erzeugt) : NaN;
  if (!Array.isArray(o.je_tag) || !Number.isFinite(erzeugt)) {
    return leererStand('Ausgabe von wb-budget --json nicht im erwarteten Format');
  }
  const heuteTag = new Date(erzeugt).toISOString().slice(0, 10);
  let heuteTokens = 0;
  for (const z of o.je_tag as Record<string, unknown>[]) {
    if (!z || z.tag !== heuteTag) continue;
    const fertig = Number(z.ohne_cache_read);
    heuteTokens += Number.isFinite(fertig)
      ? fertig
      : (Number(z.input) || 0) + (Number(z.output) || 0) + (Number(z.cache_write) || 0);
  }
  const heuteStunden = (erzeugt / 1000 % 86400) / 3600;
  // Dieselbe Schranke wie im Bericht (wb-budget: "zu frueh am UTC-Tag").
  const hochrechnung24h = heuteStunden >= 0.25 ? Math.round(heuteTokens / heuteStunden * 24) : 0;

  const limits = Array.isArray(o.limits) ? (o.limits as Record<string, unknown>[]) : [];
  const letzter = limits.length ? limits[limits.length - 1] : null;
  const fuenf = Number(letzter?.five_hour_pct);
  const sieben = Number(letzter?.seven_day_pct);
  const fiveHourPct = Number.isFinite(fuenf) ? fuenf : -1;
  const sevenDayPct = Number.isFinite(sieben) ? sieben : -1;
  const resetText = resetKlartext(letzter?.five_hour_resets_at);

  const text = hochrechnung24h > 0
    ? `Budget heute: ${heuteTokens.toLocaleString('de-DE')} Tokens in ${heuteStunden.toFixed(1)} h -- Hochrechnung auf 24h: ~${hochrechnung24h.toLocaleString('de-DE')}`
    : `Budget heute: ${heuteTokens.toLocaleString('de-DE')} Tokens in ${heuteStunden.toFixed(1)} h -- zu frueh am UTC-Tag fuer eine Hochrechnung`;
  return { ok: true, fetchedAt: Date.now(), error: '', heuteTokens, heuteStunden, hochrechnung24h, text, fiveHourPct, sevenDayPct, resetText };
}

export interface BudgetPollerOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Testhaken: ein anderes Programm statt `wb-budget` anspringen. */
  bin?: string;
}

export class BudgetPoller {
  private stand: BudgetStand | null = null;
  private timer: NodeJS.Timeout | null = null;
  private laufend = false;

  constructor(private readonly opt: BudgetPollerOptions) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opt.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  aktuell(): BudgetStand | null {
    return this.stand;
  }

  private tick(): void {
    if (this.laufend) return;
    this.laufend = true;
    let out = '';
    let fertig = false;
    const kind = spawn(this.opt.bin ?? 'wb-budget', BUDGET_JSON_ARGV, { stdio: ['ignore', 'pipe', 'pipe'] });
    const uhr = setTimeout(() => kind.kill('SIGKILL'), this.opt.timeoutMs);
    const beenden = (fehler: string) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(uhr);
      this.stand = fehler ? { ...leererStand(fehler), fetchedAt: Date.now() } : parseBudgetJson(out);
      this.laufend = false;
    };
    kind.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    kind.on('error', (e) => beenden(e.message));
    kind.on('close', (code) => beenden(code === 0 ? '' : `wb-budget beendet mit Code ${code}`));
  }
}
