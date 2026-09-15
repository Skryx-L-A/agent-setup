// FERNWELTEN (15.09.2026, Auftrag fernwelten). Entscheidung des Nutzers vom 15.09.: die
// Welten liegen auf peer, die Mac-Oberflaeche greift ueber ssh zu (Plan Abschnitt 13:
// eine verbindliche Ablage je Welt auf einer festgelegten Maschine, keine stillen
// Schreibzugriffe auf eine zweite Kopie). Diese Datei ist der Weg dorthin; welten.ts
// entscheidet, was gelesen und geschrieben wird.
//
// EIN AUFRUF JE HANDLUNG. Jeder Weg zu einer Fernwelt ist genau ein
// `ssh <host> python3 <laufzeit>/agents_weltauftrag.py json`, der Auftrag steht als JSON
// auf stdin, die Antwort als JSON auf stdout. Die Befehlszeile der entfernten Shell
// traegt nur feste, gepruefte Zeichen: nichts wird fuer sie gequotet, und ein langes
// Gedaechtnis stoesst an keine Argumentgrenze. Die Laufzeit ist dieselbe wie beim
// CLI-Fernweg (`shell/agents_fernweg.py`): `~/.local/share/werkbank-agents/laufzeit/shell`.
//
// DER KERN HAENGT NIE. `BatchMode=yes` (keine Passwortfrage ohne Terminal),
// `ConnectTimeout`, ServerAlive und eine Frist je Aufruf, deren Ablauf die ganze
// Prozessgruppe beendet. Ein Aufruf, der an ssh scheitert (Exit 255 oder Frist), macht
// die Maschine „nicht erreichbar seit …"; der naechste gelungene macht sie wieder
// erreichbar. Fuer den Takt haelt ControlMaster eine Verbindung je Maschine offen
// (ControlPersist 60 s); `stop()` schliesst sie. Der Steuerpfad liegt unter /tmp, weil
// ein Unix-Socket samt dem Anhaengsel, das ssh beim Anlegen setzt, keine 104 Zeichen
// ueberschreiten darf; der Ordner gehoert dem Benutzer und hat 0700, sonst laeuft ssh
// ohne Multiplexing.
//
// AUS DEM FINDER. Der Kern hat dann die Umgebung von launchd; `ssh` liegt in /usr/bin,
// Schluessel und ~/.ssh/config liest ssh aus dem Home der Passwortdatenbank, nicht aus
// $HOME. Gemessen mit `env -i` (docs/AGENTS-OBERFLAECHE.md, „Fernwelten").
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import type { Lauf } from './welten';

export const LAUFZEIT = '.local/share/werkbank-agents/laufzeit/shell';
/** Zeichen, die die entfernte Shell woertlich nimmt. */
const EINFACH = /^[A-Za-z0-9._~/+-]+$/;
const HOST = /^[a-z][a-z0-9-]{0,62}$/;
const SCHLUESSEL = /^([a-z][a-z0-9-]{0,62}):(\/.*)$/;

export interface FernOptionen {
  ssh: string;
  laufzeit: string;
  python: string;
  /** `welten-fern.json` im Zustandsordner: die Fernwelten, die Oberflaeche oder `wb-welt umziehen` eingetragen haben. */
  register: string;
  fristMs: number;
  /** Frist fuer Anlegen mit Einrichten des Traegers. */
  anlegenMs: number;
  /** Frist fuer `wb-welt umziehen`. */
  umzugMs: number;
  verbindenS: number;
  /** Wie oft die gewaehlte Fernwelt nachgelesen wird. */
  taktMs: number;
  /** Ordner fuer die ControlMaster-Sockets; leer = ohne Multiplexing. */
  steuerOrdner: string;
  /** Der Name dieser Maschine in `agents.maschinen` (wie wb-traeger: peer oder mac). */
  eigene: string;
}

export function fernOptionenAusUmgebung(env: NodeJS.ProcessEnv, zustandOrdner: string): FernOptionen {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    ssh: env.AWB_WELTEN_SSH ?? 'ssh',
    laufzeit: env.AWB_WELTEN_FERN_SHELL ?? LAUFZEIT,
    python: env.AWB_WELTEN_FERN_PYTHON ?? 'python3',
    register: env.AWB_WELTEN_FERN ?? join(zustandOrdner, 'welten-fern.json'),
    fristMs: Number(env.AWB_WELTEN_FERN_FRIST_MS ?? 20_000),
    anlegenMs: Number(env.AWB_WELTEN_FERN_ANLEGEN_MS ?? 90_000),
    umzugMs: Number(env.AWB_WELTEN_UMZUG_MS ?? 600_000),
    verbindenS: Number(env.AWB_WELTEN_FERN_VERBINDEN_S ?? 8),
    taktMs: Number(env.AWB_WELTEN_FERN_TAKT_MS ?? 5000),
    steuerOrdner: env.AWB_WELTEN_SSH_STEUERUNG ?? `/tmp/awb-ssh-${uid}`,
    eigene: env.AWB_WELTEN_MASCHINE ?? eigeneMaschine(),
  };
}

/** Wie `eigene_maschine_name` in wb-traeger: peer, wenn der Hostname es sagt, sonst mac. */
export function eigeneMaschine(name = hostname()): string {
  return name.toLowerCase().includes('peer') ? 'peer' : 'mac';
}

/** Die Kennung einer Fernwelt in der Nutzlast: `<maschine>:<ablage>`, dieselbe Form wie beim CLI-Fernweg. */
export function fernSchluessel(maschine: string, ablage: string): string {
  return `${maschine}:${ablage}`;
}

export function fernSchluesselLesen(schluessel: string): { maschine: string; ablage: string } | null {
  const m = schluessel.match(SCHLUESSEL);
  return m ? { maschine: m[1], ablage: m[2] } : null;
}

/** Ein Pfad unter dem eigenen Home als `~/…` fuer die andere Maschine; ausserhalb null. */
export function homeRelativ(pfad: string, home: string): string | null {
  const h = home.replace(/\/+$/, '');
  if (!h || !pfad.startsWith(`${h}/`)) return null;
  const rest = pfad.slice(h.length + 1).replace(/\/+$/, '');
  if (!rest || rest.split('/').includes('..')) return null;
  return `~/${rest}`;
}

// ---------------------------------------------------------------------------
// Das Register der Fernwelten
// ---------------------------------------------------------------------------

export interface FernEintrag { maschine: string; pfad: string; projekt: string | null }

export function registerLesen(datei: string): FernEintrag[] {
  try {
    const roh = JSON.parse(readFileSync(datei, 'utf8')) as { welten?: unknown };
    const welten = Array.isArray(roh?.welten) ? roh.welten : [];
    return welten.filter((w): w is FernEintrag => !!w && typeof w === 'object'
      && typeof (w as FernEintrag).maschine === 'string' && HOST.test((w as FernEintrag).maschine)
      && typeof (w as FernEintrag).pfad === 'string' && (w as FernEintrag).pfad.startsWith('/'))
      .map((w) => ({ maschine: w.maschine, pfad: w.pfad, projekt: typeof w.projekt === 'string' ? w.projekt : null }));
  } catch {
    return [];
  }
}

/** Traegt eine Fernwelt ein (dieselbe Form wie agents_weltumzug.py `registrieren`). */
export function registerEintragen(datei: string, eintrag: FernEintrag): void {
  const welten = registerLesen(datei).filter((w) => !(w.maschine === eintrag.maschine && w.pfad === eintrag.pfad));
  welten.push(eintrag);
  mkdirSync(dirname(datei), { recursive: true });
  const tmp = `${datei}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, welten }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, datei);
}

// ---------------------------------------------------------------------------
// Ein Prozess mit Eingabe und Frist
// ---------------------------------------------------------------------------

const laufendeGruppen = new Set<number>();

/** Wie `laufen` in aufgaben.ts (eigene Prozessgruppe, Frist trifft die Enkel), dazu stdin. */
export function mitEingabeLaufen(bin: string, args: string[], eingabe: string, fristMs: number): Promise<Lauf> {
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
      if (kind?.pid) {
        try { process.kill(-kind.pid, 'SIGKILL'); } catch { /* schon weg */ }
      }
      ende(null, `${bin} brauchte laenger als ${Math.round(fristMs / 1000)} s`);
    }, fristMs);
    const env = { ...process.env };
    delete env.WB_MENSCH_QUELLE;
    delete env.WB_APP_PID;
    try {
      kind = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env });
    } catch (e) {
      ende(null, (e as Error).message);
      return;
    }
    if (kind.pid) laufendeGruppen.add(kind.pid);
    kind.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    kind.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    kind.stdin?.on('error', () => { /* ein frueh beendetes Kind liest nicht mehr */ });
    kind.on('error', (e) => ende(null, e.message));
    kind.on('close', (code) => ende(code, ''));
    kind.stdin?.end(eingabe);
  });
}

// ---------------------------------------------------------------------------
// Die Maschinen und ihre Erreichbarkeit
// ---------------------------------------------------------------------------

export interface MaschinenAngabe { name: string; ssh: string; standard: boolean }

export interface MaschinenStand { erreichbar: boolean | null; seit: string | null; text: string; geprueft: string | null }

export type FernAntwort<T> = { ok: true; daten: T } | { ok: false; verbindung: boolean; text: string };

export class FernWeg {
  private stand = new Map<string, MaschinenStand>();
  private benutzt = new Set<string>();
  private steuerGeprueft: string | null = null;

  constructor(readonly opt: FernOptionen) {}

  maschinenStand(name: string): MaschinenStand {
    return this.stand.get(name) ?? { erreichbar: null, seit: null, text: '', geprueft: null };
  }

  /** Der Ordner der Steuersockets, einmal geprueft: eigener, 0700, kein Symlink -- sonst ohne Multiplexing. */
  private steuerOrdner(): string {
    if (this.steuerGeprueft !== null) return this.steuerGeprueft;
    let ordner = this.opt.steuerOrdner;
    if (ordner) {
      try {
        mkdirSync(ordner, { mode: 0o700 });
      } catch {
        // schon da
      }
      try {
        const st = lstatSync(ordner);
        const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0 || ordner.length > 60) ordner = '';
      } catch {
        ordner = '';
      }
    }
    this.steuerGeprueft = ordner;
    return ordner;
  }

  sshArgumente(host: string, befehl: string): string[] {
    const steuer = this.steuerOrdner();
    return [
      '-oBatchMode=yes', `-oConnectTimeout=${this.opt.verbindenS}`, '-oServerAliveInterval=5', '-oServerAliveCountMax=3',
      ...(steuer ? ['-oControlMaster=auto', '-oControlPersist=60', `-oControlPath=${steuer}/%C`] : []),
      host, befehl,
    ];
  }

  private merken(name: string, ok: boolean, text: string): void {
    const jetzt = new Date().toISOString();
    const alt = this.maschinenStand(name);
    this.stand.set(name, ok
      ? { erreichbar: true, seit: null, text: '', geprueft: jetzt }
      : { erreichbar: false, seit: alt.erreichbar === false ? alt.seit : jetzt, text, geprueft: jetzt });
  }

  /** Ein Auftrag an `agents_weltauftrag.py` auf `maschine` (ssh-Name `host`). */
  async auftrag<T>(maschine: string, host: string, job: Record<string, unknown>, fristMs = this.opt.fristMs): Promise<FernAntwort<T>> {
    if (!HOST.test(host)) return { ok: false, verbindung: true, text: `„${host}“ ist kein gültiger ssh-Name.` };
    if (!EINFACH.test(this.opt.laufzeit) || !EINFACH.test(this.opt.python)) {
      return { ok: false, verbindung: true, text: `Laufzeit oder Python für ${maschine} enthalten Sonderzeichen (AWB_WELTEN_FERN_SHELL).` };
    }
    this.benutzt.add(host);
    const befehl = `${this.opt.python} ${this.opt.laufzeit.replace(/\/+$/, '')}/agents_weltauftrag.py json`;
    const l = await mitEingabeLaufen(this.opt.ssh, this.sshArgumente(host, befehl), JSON.stringify(job), fristMs);
    const letzte = (s: string) => s.trim().split('\n').filter(Boolean).pop() ?? '';
    if (l.fehler || l.code === 255) {
      const text = (l.fehler || letzte(l.err) || `ssh ${host}: Exit 255`).slice(0, 300);
      this.merken(maschine, false, text);
      return { ok: false, verbindung: false, text };
    }
    this.merken(maschine, true, '');
    let daten: unknown = null;
    try {
      daten = JSON.parse(l.out);
    } catch {
      const text = letzte(l.err) || letzte(l.out) || `Exit ${l.code}`;
      return { ok: false, verbindung: true, text: `${maschine}: ${text.slice(0, 240)} (Laufzeit dort aktuell? ${this.opt.laufzeit})` };
    }
    if (l.code !== 0) {
      const f = (daten as { fehler?: unknown } | null)?.fehler;
      return { ok: false, verbindung: true, text: typeof f === 'string' ? f : `${maschine}: Exit ${l.code}` };
    }
    return { ok: true, daten: daten as T };
  }

  /** Beendet jede noch laufende Gruppe und schliesst die Steuerverbindungen dieses Kerns. */
  stop(): void {
    for (const pid of laufendeGruppen) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* schon weg */ }
    }
    laufendeGruppen.clear();
    const steuer = this.steuerGeprueft;
    if (!steuer) return;
    for (const host of this.benutzt) {
      spawnSync(this.opt.ssh, ['-oBatchMode=yes', `-oControlPath=${steuer}/%C`, '-O', 'exit', host], { stdio: 'ignore', timeout: 3000 });
    }
    this.benutzt.clear();
  }
}
