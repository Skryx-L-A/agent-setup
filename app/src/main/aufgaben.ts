// DER KERN-KANAL `awb:aufgaben` (10.09.2026, Bau-Schritt 4 des Agents-Features;
// seit dem 14.09.2026 auf die Welten umgebaut, Auftrag agentsui Nr. 6). Er
// sammelt, was der Tab „Agents" beider Oberflaechen zeichnet: die Welten
// (welten.ts, Feld `welten`) und die Fusszeile mit Traeger, Kern, Lebenszeichen,
// Agent-Verkehr, Tageslimit und Maschinen.
//
// WAS HIER NICHT MEHR STEHT. Bis Fassung 26 trug der Kanal die Aufgaben des
// Vorrats („braucht dich", „läuft", „ohne Aufgabe", „Vorrat") samt den
// Handlungen `aufgabe:<handlung> <id>`. Seit Abnahme des Nutzers der
// Welten-Ansicht zeigt keine Oberflaeche sie mehr, und kein anderer Leser
// braucht sie: der Traeger (shell/agents_traeger.py, wb-traeger) liest den
// Vorrat selbst, der Companion liest Welten nur ueber `wb-welt`, `wb-kanal` und
// `wb-ticket` (nachgesehen am 14.09. per grep ueber shell/ und ~/AI/companion).
// Ein Befehl `aufgabe:…` wird deshalb mit Meldung abgelehnt.
//
// WAS BLEIBT, WEIL ES GELESEN WIRD: `traeger` und `kern_sauber` fuer die Fusszeile
// beider Oberflaechen, `figuren.arten` fuer die Vorschau der Agentenfiguren der
// Electron-Fassung (figurenblatt.ts), `welten` fuer die Ansicht selbst.
//
// DIESE DATEI RECHNET NICHTS, WAS EIN WERKZEUG SCHON WEISS. Der Traeger kommt
// aus `wb-traeger status --json`, Tageslimit aus `wb-budget --json`, die Frage
// „ist dieser Kern ein Mensch" aus `wb-mensch pruefen`. Jeder Aufruf hat eine
// Frist; ein Fehlschlag steht mit seiner Quelle in `fehler`, statt still einen
// leeren Stand zu liefern.
//
// DER TAKT: zwei Sekunden, solange eine Oberflaeche die Ansicht zeigt, sonst
// langsam (Befund M4). Die Welten stossen ueber ihre eigenen Waechter sofort
// einen Takt an. `wb-budget` laeuft jede Minute, `wb-mensch` alle 15 s.
import type { Herkunft, Herkunftsbeleg } from './herkunft';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SessionInfo } from './sessions';
import type { MaschinenAngabe } from './fernwelten';
import { WeltenQuelle, weltenOptionenAusUmgebung, type WeltenHandlungsErgebnis, type WeltenNutzlast, type WeltenOptionen } from './welten';

export interface TraegerStand {
  laeuft: boolean;
  seit: string | null;
  takt_s: number;
  lebenszeichen: { zeit: string | null; ok: boolean | null; grund: string | null };
  agent_verkehr: 'offen' | 'pausiert';
  tageslimit: { verbraucht: number | null; erlaubt: number | null };
  maschinen: string[];
  /** Wie viele Aufgaben der Traeger fuehrt (ohne abgenommene und verworfene). */
  aufgaben: number;
}

export interface AufgabenNutzlast {
  traeger: TraegerStand;
  /** Ob `wb-mensch pruefen` diesen Kern als Mensch belegt; null = noch nicht gemessen. */
  kern_sauber: boolean | null;
  /** Jede Quelle, die im letzten Takt nicht lieferte, mit ihrem Text. */
  fehler: { quelle: string; text: string }[];
  /** false bis zum ersten vollstaendigen Takt. */
  geladen: boolean;
  erzeugt: string;
  /** Art je Team (`agents.teams.<name>.art`, Vorgabe wie im Figurenblatt) -- fuer die Figurenvorschau. */
  figuren: { arten: Record<string, 'tier' | 'roboter'> };
  /** Die Welten der Agents mit Hauptagent, Teams, Tickets, Kanal, Direktchats und Fragen (welten.ts). */
  welten: WeltenNutzlast;
}

export interface AufgabenOptionen {
  traegerBin: string;
  budgetBin: string;
  menschBin: string;
  settingsFile: string;
  taktMs: number;
  fristMs: number;
  /** Wie lange ein Budget- und ein Mensch-Messwert gilt, bevor neu gefragt wird. */
  budgetMs: number;
  menschMs: number;
  /** Takt, solange keine Oberflaeche die Ansicht zeigt; die Waechter der Welten stossen weiter sofort an (Befund M4). */
  taktVerborgenMs: number;
  /**
   * Spaetestens so lange bleibt ein unveraenderter Stand ungesendet; danach geht er mit neuem `erzeugt`
   * hinaus. Das Netz unter dem Vergleich in `aufgabenVergleichsform`: eine Anzeige kann hoechstens so lange
   * veraltet sein, nie einfrieren.
   */
  herzschlagMs: number;
  /** Die Welten (welten.ts): Datenbibliothek, Wurzeln, globale Welt, Takte. */
  welten: WeltenOptionen;
  sitzungen: () => SessionInfo[];
  /** `geaendert`: der Stand hat sich fuer eine Anzeige geaendert; false beim Herzschlag und beim erzwungenen Senden. */
  aufNeu: (p: AufgabenNutzlast, geaendert: boolean) => void;
}

/** Die Werkzeuge ueber PATH, jedes per Umgebungsvariable umlenkbar (Tests, Schirme). */
export function aufgabenOptionenAusUmgebung(env: NodeJS.ProcessEnv, home: string, config: {
  settingsFile: string; budgetBin: string; wbMenschBin: string; stateDir?: string;
}): Omit<AufgabenOptionen, 'sitzungen' | 'aufNeu'> {
  return {
    traegerBin: env.AWB_WB_TRAEGER ?? 'wb-traeger',
    budgetBin: config.budgetBin,
    menschBin: config.wbMenschBin,
    settingsFile: config.settingsFile,
    taktMs: Number(env.AWB_AUFGABEN_TAKT_MS ?? 2000),
    fristMs: Number(env.AWB_AUFGABEN_FRIST_MS ?? 8000),
    budgetMs: Number(env.AWB_AUFGABEN_BUDGET_MS ?? 60_000),
    menschMs: Number(env.AWB_AUFGABEN_MENSCH_MS ?? 15_000),
    taktVerborgenMs: Number(env.AWB_AUFGABEN_TAKT_VERBORGEN_MS ?? 30_000),
    herzschlagMs: Number(env.AWB_AUFGABEN_HERZSCHLAG_MS ?? 30_000),
    welten: weltenOptionenAusUmgebung(env, home, __dirname, config.stateDir),
  };
}

/**
 * Die Maschinen der Agents mit ssh-Namen und Standard, wie `maschinen_liste` in wb-traeger:
 * `agents.maschinen` (verschachtelt, punktiert oder als JSON-Text), sonst mac und peer mit peer als Standard.
 * Die Welten brauchen daraus den ssh-Namen einer Fernwelt und die Vorgabe beim Anlegen.
 */
export function maschinenAngaben(einst: Record<string, unknown>): MaschinenAngabe[] {
  const agents = (einst.agents ?? {}) as Record<string, unknown>;
  let roh = agents.maschinen ?? einst['agents.maschinen'];
  if (typeof roh === 'string') {
    try {
      roh = JSON.parse(roh);
    } catch {
      roh = null;
    }
  }
  const liste = Array.isArray(roh) && roh.length
    ? roh.map((m) => m as { name?: unknown; ssh?: unknown; standard?: unknown })
      .filter((m) => m && typeof m.name === 'string' && m.name)
      .map((m) => ({ name: String(m.name), ssh: typeof m.ssh === 'string' && m.ssh ? m.ssh : String(m.name), standard: m.standard === true }))
    : [{ name: 'mac', ssh: 'mac', standard: false }, { name: 'peer', ssh: 'peer', standard: true }];
  return liste;
}

/** Vorgabe des Plans (Abschnitt 7): Entwicklung und Pruefung Roboter, Recherche und Gestaltung Tier. */
export const ART_VORGABE: Record<string, 'tier' | 'roboter'> = {
  recherche: 'tier', entwicklung: 'roboter', pruefung: 'roboter', gestaltung: 'tier',
};

/** Die Art je Team aus den Einstellungen (`agents.teams.<name>.art`, verschachtelt oder punktiert). */
export function figurenArten(einstellungen: Record<string, unknown>): Record<string, 'tier' | 'roboter'> {
  const arten = { ...ART_VORGABE };
  const agents = einstellungen.agents as Record<string, unknown> | undefined;
  const teams = (agents?.teams ?? {}) as Record<string, unknown>;
  for (const team of Object.keys(arten)) {
    const verschachtelt = (teams[team] as Record<string, unknown> | undefined)?.art;
    const punktiert = einstellungen[`agents.teams.${team}.art`];
    const art = String(verschachtelt ?? punktiert ?? '');
    if (art === 'tier' || art === 'roboter') arten[team] = art;
  }
  return arten;
}

// ---------------------------------------------------------------------------
// Ein Werkzeug aufrufen, mit Frist.
// ---------------------------------------------------------------------------
export interface Lauf { code: number | null; out: string; err: string; fehler: string }

/** Die Prozessgruppen, die gerade laufen -- `stop()` raeumt sie ab (Reviewer-Hinweis H1). */
const laufendeGruppen = new Set<number>();

function gruppeBeenden(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // schon weg
  }
}

/** Beendet jede noch laufende Prozessgruppe dieser Datei; Rueckgabe: wie viele. */
export function laufendeAbraeumen(): number {
  const n = laufendeGruppen.size;
  for (const pid of laufendeGruppen) gruppeBeenden(pid);
  laufendeGruppen.clear();
  return n;
}

/**
 * Die Umgebung des Kerns ohne die Mensch-Marke (Befund K1). Startet der Kern aus
 * einem Pane einer anderen Werkbank, erbt er deren WB_MENSCH_QUELLE und WB_APP_PID;
 * die duerfen nur ueber `menschUmgebung` an ein Werkzeug gehen.
 */
function ohneMenschMarke(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.WB_MENSCH_QUELLE;
  delete rest.WB_APP_PID;
  return rest;
}

/**
 * Ein Werkzeug mit Frist, in einer EIGENEN Prozessgruppe (`detached`): so trifft
 * die Frist auch die Enkel. Ein SIGKILL nur an das Kind liess sie weiterlaufen.
 */
export function laufen(bin: string, args: string[], fristMs: number, env: NodeJS.ProcessEnv = ohneMenschMarke(process.env)): Promise<Lauf> {
  return new Promise((fertig) => {
    let out = '';
    let err = '';
    let erledigt = false;
    let kind: ReturnType<typeof spawn> | undefined;
    const ende = (code: number | null, fehler: string) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(uhr);
      if (kind?.pid) laufendeGruppen.delete(kind.pid);
      fertig({ code, out, err, fehler });
    };
    const uhr = setTimeout(() => {
      if (kind?.pid) gruppeBeenden(kind.pid);
      ende(null, `${bin} brauchte laenger als ${Math.round(fristMs / 1000)} s`);
    }, fristMs);
    try {
      kind = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: env ?? process.env });
    } catch (e) {
      ende(null, (e as Error).message);
      return;
    }
    if (kind.pid) laufendeGruppen.add(kind.pid);
    kind.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    kind.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    kind.on('error', (e) => ende(null, e.message));
    kind.on('close', (code) => ende(code, ''));
  });
}

function jsonAus<T>(l: Lauf): T | null {
  try {
    return JSON.parse(l.out) as T;
  } catch {
    return null;
  }
}

function kurz(l: Lauf): string {
  return (l.fehler || l.err.trim().split('\n').filter(Boolean).pop() || l.out.trim().split('\n').pop() || `Exit ${l.code}`).slice(0, 300);
}

/**
 * Die Stufe, in der eine Dauer angezeigt wird (`dauerWort` in welten-view.ts, `WeltenWorte.dauerWort` in
 * WeltenNutzlast.swift -- beide gleich): Sekunden unter einer Minute, dann abgerundete Minuten, Stunden, Tage.
 */
export function dauerStufe(sekunden: unknown): string {
  const s = typeof sekunden === 'number' && Number.isFinite(sekunden) ? sekunden : 0;
  if (s < 60) return `s${s}`;
  if (s < 3600) return `m${Math.floor(s / 60)}`;
  if (s < 86_400) return `h${Math.floor(s / 3600)}`;
  return `d${Math.floor(s / 86_400)}`;
}

/**
 * Die Vergleichsform von `awb:aufgaben` (09.10.2026, Auftrag perf-aufgaben). Gemessen im Leerlauf, mit
 * Demo-Welten: von Nachricht zu Nachricht aenderten sich nur
 *   * `erzeugt` (der Herzschlag; kein Empfaenger zeigt es an),
 *   * `welten.welten[].gelesen` (wann der Kern die Welt zuletzt las; kein Empfaenger zeigt es an --
 *     welten-view.ts liest nur `mensch.gelesen`, WeltenNutzlast.swift nutzt es allein im Gleichheitstest),
 *   * `welten.welten[].tickets[].alter_s` und `.durchlaufzeit_s` (die Zeit zaehlt weiter; angezeigt als
 *     `dauerWort`, also in der Stufe von `dauerStufe`).
 * Alles andere -- auch eine Stufe, die kippt -- ist eine Aenderung und geht sofort hinaus.
 */
export function aufgabenVergleichsform(p: AufgabenNutzlast): string {
  const { erzeugt: _erzeugt, welten, ...rest } = p;
  const liste = (welten as { welten?: unknown } | null | undefined)?.welten;
  if (!Array.isArray(liste)) return JSON.stringify({ ...rest, welten });
  const jeWelt = liste.map((w: Record<string, unknown>) => {
    const { gelesen: _gelesen, tickets, ...welt } = w;
    if (!Array.isArray(tickets)) return { ...welt, tickets };
    return {
      ...welt,
      tickets: tickets.map((t: Record<string, unknown>) => ({
        ...t, alter_s: dauerStufe(t.alter_s), durchlaufzeit_s: dauerStufe(t.durchlaufzeit_s),
      })),
    };
  });
  return JSON.stringify({ ...rest, welten: { ...welten, welten: jeWelt } });
}

export class AufgabenQuelle {
  private timer: NodeJS.Timeout | null = null;
  /** Der Herzschlag: ein Zeitgeber, der mit jedem Senden neu beginnt -- so liegen zwischen zwei Nachrichten hoechstens `herzschlagMs`. */
  private herz: NodeJS.Timeout | null = null;
  private anstoss: NodeJS.Timeout | null = null;
  /** Der laufende Takt -- `frisch()` wartet genau ihn ab (Reviewer-Hinweis H2). */
  private laeuftGerade: Promise<void> | null = null;
  private nochmal = false;
  /** Zaehlt jedes `stop()`: ein Takt, der ueber ein `stop()` hinweg lief, sendet seinen Stand nicht mehr. */
  private epoche = 0;
  /** Ob eine Oberflaeche die Ansicht gerade zeigt (`awb:aufgaben-sichtbar`). */
  private sichtbar = false;
  private budget: Record<string, unknown> | null = null;
  private budgetFehler = '';
  private budgetZeit = 0;
  private mensch: boolean | null = null;
  private menschZeit = 0;
  private stand: AufgabenNutzlast;
  /** Die Vergleichsform des zuletzt gesendeten Stands (`aufgabenVergleichsform`). */
  private zuletztGesendet = '';
  private readonly welten: WeltenQuelle;

  constructor(private readonly opt: AufgabenOptionen) {
    this.stand = AufgabenQuelle.leer();
    this.welten = new WeltenQuelle(opt.welten, laufen, () => this.anstossen());
  }

  static leer(): AufgabenNutzlast {
    return {
      traeger: {
        laeuft: false, seit: null, takt_s: 0, lebenszeichen: { zeit: null, ok: null, grund: null },
        agent_verkehr: 'offen', tageslimit: { verbraucht: null, erlaubt: null }, maschinen: [], aufgaben: 0,
      },
      kern_sauber: null, fehler: [], geladen: false, erzeugt: new Date().toISOString(), figuren: { arten: { ...ART_VORGABE } },
      welten: WeltenQuelle.leer(),
    };
  }

  aktuell(): AufgabenNutzlast {
    return this.stand;
  }

  start(): void {
    if (this.timer) return;
    void this.takt();
    this.taktStellen();
    this.herzStellen();
  }

  /**
   * DER TAKT HAENGT AN DER SICHTBARKEIT (Befund M4, gemessen 11.09.: rund 70 ms
   * CPU je Takt, im Zwei-Sekunden-Takt eine Stunde CPU am Tag). Zwei Sekunden,
   * solange eine Oberflaeche die Ansicht zeigt, sonst `taktVerborgenMs`. Die
   * Waechter der Welten stossen in beiden Faellen sofort an.
   */
  private taktStellen(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.takt(), this.sichtbar ? this.opt.taktMs : this.opt.taktVerborgenMs);
  }

  /** Eine Oberflaeche meldet, ob sie die Ansicht zeigt. Wird sie sichtbar, gleich ein Takt. */
  sichtbarSetzen(an: boolean): void {
    if (an === this.sichtbar) return;
    this.sichtbar = an;
    if (this.timer) this.taktStellen();
    if (an) this.anstossen();
  }

  istSichtbar(): boolean {
    return this.sichtbar;
  }

  /**
   * DER HERZSCHLAG (Befund H2 der Electron-Pruefung): der Stand geht spaetestens alle `herzschlagMs`
   * hinaus, auch unveraendert und mit neuem `erzeugt`. Seit perf-aufgaben dreissig statt zehn Sekunden und
   * ohne Mobil-Ereignis: gemessen gingen im Leerlauf alle Nachrichten allein wegen `erzeugt` hinaus.
   */
  private herzStellen(): void {
    if (this.herz) clearTimeout(this.herz);
    this.herz = this.timer ? setTimeout(() => this.herzschlag(), Math.max(500, this.opt.herzschlagMs)) : null;
  }

  private herzschlag(): void {
    this.stand = { ...this.stand, erzeugt: new Date().toISOString() };
    this.senden(this.stand, false);
  }

  /** Den Stand jetzt an alle Oberflaechen schicken, auch unveraendert: fuer einen neuen Empfaenger (`awb:ready`). */
  erzwingen(): void {
    this.stand = { ...this.stand, erzeugt: new Date().toISOString() };
    this.zuletztGesendet = aufgabenVergleichsform(this.stand);
    this.senden(this.stand, false);
  }

  private senden(p: AufgabenNutzlast, geaendert: boolean): void {
    this.herzStellen();
    this.opt.aufNeu(p, geaendert);
  }

  stop(): void {
    this.epoche++;
    this.nochmal = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.herz) clearTimeout(this.herz);
    this.herz = null;
    if (this.anstoss) clearTimeout(this.anstoss);
    this.anstoss = null;
    this.welten.stop();
    laufendeAbraeumen();
  }

  /**
   * Frisch gelesen zurueck: wartet den laufenden Takt ab -- sein Versprechen,
   * nicht eine Frist (Befund H2) -- und fuehrt dann einen eigenen aus. Fuer den
   * Steuerkanal (`aufgaben` mit `frisch`).
   */
  async frisch(): Promise<AufgabenNutzlast> {
    if (this.laeuftGerade) await this.laeuftGerade;
    await this.takt();
    return this.stand;
  }

  /** Ein Takt gleich, nicht erst in zwei Sekunden -- nach einer Dateiaenderung oder einer Handlung. */
  anstossen(): void {
    if (this.anstoss) return;
    this.anstoss = setTimeout(() => {
      this.anstoss = null;
      void this.takt();
    }, 250);
  }

  /** Ein Takt; laeuft schon einer, bekommt der Aufrufer dessen Versprechen, und danach folgt noch einer. */
  takt(): Promise<void> {
    if (this.laeuftGerade) {
      this.nochmal = true;
      return this.laeuftGerade;
    }
    this.laeuftGerade = this.taktAusfuehren().finally(() => {
      this.laeuftGerade = null;
      if (this.nochmal) {
        this.nochmal = false;
        this.anstossen();
      }
    });
    return this.laeuftGerade;
  }

  /** Takte laufen strikt nacheinander (`laeuftGerade`); keiner kann einen spaeteren ueberholen. */
  private async taktAusfuehren(): Promise<void> {
    const epoche = this.epoche;
    try {
      const neu = await this.sammeln();
      // stop() raeumt die Werkzeuge ab, die dieser Takt gerade las: sein Stand waere ein Fehlerstand.
      if (epoche !== this.epoche) return;
      this.stand = neu;
      const vergleich = aufgabenVergleichsform(neu);
      if (vergleich !== this.zuletztGesendet) {
        this.zuletztGesendet = vergleich;
        this.senden(neu, true);
      }
    } catch (e) {
      process.stderr.write(`aufgaben: Takt gescheitert: ${(e as Error).message}\n`);
    }
  }

  /** Die Umgebung des Wegs M2 in `wb-mensch`: die Oberflaeche (dieser Prozess) als geprueften Ahnen. */
  private menschUmgebung(): NodeJS.ProcessEnv {
    return { ...process.env, WB_MENSCH_QUELLE: 'oberflaeche', WB_APP_PID: String(process.pid) };
  }

  /**
   * „Kern sauber" -- gemessen mit derselben Umgebung, mit der ein echter Klick
   * ein Werkzeug erreicht (M2). Die Fusszeile sagt damit, ob ein Klick hier als Mensch gilt.
   */
  private async menschMessen(): Promise<boolean | null> {
    if (this.mensch !== null && Date.now() - this.menschZeit < this.opt.menschMs) return this.mensch;
    const l = await laufen(this.opt.menschBin, ['pruefen'], this.opt.fristMs, this.menschUmgebung());
    this.mensch = l.fehler ? null : l.code === 0;
    this.menschZeit = Date.now();
    return this.mensch;
  }

  private async budgetLesen(): Promise<void> {
    if (this.budgetZeit && Date.now() - this.budgetZeit < this.opt.budgetMs) return;
    this.budgetZeit = Date.now();
    // `wb-budget --json` ohne Filter ist der Limitstand-Modus: Exit 1 am
    // Tageslimit, 2 am Fuenf-Stunden-Fenster -- beide mit gueltigem JSON.
    const l = await laufen(this.opt.budgetBin, ['--json'], this.opt.fristMs);
    const d = jsonAus<Record<string, unknown>>(l);
    if (d && !d.fehler && [0, 1, 2].includes(l.code ?? -1)) {
      this.budget = d;
      this.budgetFehler = '';
    } else {
      this.budget = null;
      this.budgetFehler = d?.fehler ? String(d.fehler) : kurz(l);
    }
  }

  private async sammeln(): Promise<AufgabenNutzlast> {
    const fehler: { quelle: string; text: string }[] = [];
    // Die Welten laufen neben dem Rest her; ihre Projekte kennt der Kern aus den Sitzungen, ihre Maschinen aus den Einstellungen.
    const einst = this.einstellungen();
    this.welten.maschinenSetzen(maschinenAngaben(einst));
    const weltenL = this.welten.sammeln(this.opt.sitzungen().map((s) => s.dir));
    const [traegerL] = await Promise.all([
      laufen(this.opt.traegerBin, ['status', '--json'], this.opt.fristMs),
      this.budgetLesen(),
      this.menschMessen(),
    ]);
    const traeger = traegerL.code === 0 ? jsonAus<Record<string, unknown>>(traegerL) : null;
    if (!traeger) fehler.push({ quelle: 'wb-traeger status', text: kurz(traegerL) });
    if (this.budgetFehler) fehler.push({ quelle: 'wb-budget', text: this.budgetFehler });

    const b = this.budget;
    const lz = (traeger?.lebenszeichen ?? {}) as Record<string, unknown>;
    const lzFehler = lz.fehler;
    const grund = Array.isArray(lzFehler) ? lzFehler.join('; ')
      : lzFehler && typeof lzFehler === 'object' ? Object.entries(lzFehler).map(([k, v]) => `${k}: ${String(v)}`).join('; ')
        : lzFehler ? String(lzFehler) : null;
    const jeStand = (traeger?.aufgaben ?? {}) as Record<string, string[]>;
    const traegerStand: TraegerStand = {
      laeuft: traeger?.laeuft === true,
      seit: traeger?.laeuft === true ? (traeger.gestartet as string | null) ?? null : null,
      takt_s: Number(traeger?.takt_sekunden ?? 0) || 0,
      lebenszeichen: {
        zeit: (lz.zeit as string | undefined) ?? null,
        ok: lz.ergebnis === undefined ? null : lz.ergebnis === 'ok',
        grund: grund || null,
      },
      agent_verkehr: traeger?.pausenschalter === true ? 'pausiert' : 'offen',
      tageslimit: {
        verbraucht: typeof b?.seven_day_pct === 'number' ? b.seven_day_pct : null,
        erlaubt: typeof b?.erlaubt_pct === 'number' ? b.erlaubt_pct : null,
      },
      maschinen: this.maschinen(einst, String(traeger?.maschine ?? '')),
      aufgaben: Object.entries(jeStand).filter(([st]) => st !== 'abgenommen' && st !== 'verworfen')
        .reduce((n, [, l]) => n + (Array.isArray(l) ? l.length : 0), 0),
    };

    return {
      traeger: traegerStand,
      kern_sauber: this.mensch,
      fehler,
      geladen: true,
      erzeugt: new Date().toISOString(),
      figuren: { arten: figurenArten(einst) },
      welten: await weltenL,
    };
  }

  private einstellungen(): Record<string, unknown> {
    try {
      const roh = JSON.parse(readFileSync(this.opt.settingsFile, 'utf8')) as unknown;
      return roh && typeof roh === 'object' && !Array.isArray(roh) ? roh as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  /** Die Maschinen der Agents: `agents.maschinen` aus den Einstellungen (wie wb-traeger), sonst dessen Vorgabe. */
  private maschinen(einst: Record<string, unknown>, eigene: string): string[] {
    const namen = maschinenAngaben(einst).map((m) => m.name);
    for (const n of [eigene]) if (n && !namen.includes(n)) namen.push(n);
    return namen;
  }

  // -------------------------------------------------------------------------
  // Handlungen: nur noch an Welten (welten.ts, `welt:<handlung> <JSON>`).
  // -------------------------------------------------------------------------

  async ausfuehren(befehl: string, herkunft: Herkunft | Herkunftsbeleg, opt: unknown = {}): Promise<WeltenHandlungsErgebnis> {
    if (befehl.trim().startsWith('welt:')) {
      const r = await this.welten.ausfuehren(befehl, herkunft, opt);
      this.anstossen();
      return r;
    }
    const kopf = befehl.trim().split(/\s+/)[0] ?? '';
    if (kopf.startsWith('aufgabe:')) {
      return {
        ok: false, handlung: kopf, id: '',
        meldung: 'Die Aufgaben-Handlungen aus Fassung 26 gibt es nicht mehr: der Tab „Agents" zeigt die Welten. Aufgaben des Vorrats laufen über wb-aufgabe.',
      };
    }
    return { ok: false, handlung: '', id: '', meldung: `Befehl nicht lesbar: „${befehl.slice(0, 80)}" -- erwartet welt:<handlung> <JSON>` };
  }
}
