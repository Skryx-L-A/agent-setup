import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { harnessUpdateAuto, harnessUpdateIntervalHours } from './einstellungen';

export interface HarnessUpdateRecord {
  harness: string;
  installedBefore: string | null;
  installedAfter: string | null;
  latest: string | null;
  status: string;
  pending: boolean;
  liveSessions: number;
}

export interface HarnessUpdateState {
  checkedAt: string;
  action: string;
  harnesses: HarnessUpdateRecord[];
}

export interface HarnessVersionSicht {
  installed: string;
  latest: string;
  status: string;
  checkedAt: string;
}

export function harnessUpdateStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WB_HARNESS_UPDATE_STATE_FILE ?? join(homedir(), '.local', 'state', 'wb-harness-update.json');
}

/**
 * Test instances use a private HOME and test-only markers.  The three socket
 * variables are deliberately not markers: Kernstart.swift supplies them to
 * every production core as part of the Mac-native app handshake.
 */
export function harnessUpdateAutomatikErlaubt(env: NodeJS.ProcessEnv = process.env): boolean {
  let userHome: string;
  try {
    userHome = userInfo().homedir;
  } catch {
    return false;
  }
  if ((env.HOME ?? homedir()) !== userHome) return false;
  if ('AWB_MODELS_FILE' in env) return false;
  return !Object.keys(env).some((name) => name.startsWith('AWB_TEST') || name.startsWith('WB_TEST_'));
}

export function harnessVersionenLesen(pfad = harnessUpdateStatePath()): Record<string, HarnessVersionSicht> {
  let data: HarnessUpdateState;
  try {
    data = JSON.parse(readFileSync(pfad, 'utf8')) as HarnessUpdateState;
  } catch {
    return {};
  }
  if (!data || !Array.isArray(data.harnesses)) return {};
  const raus: Record<string, HarnessVersionSicht> = {};
  for (const h of data.harnesses) {
    if (!h || typeof h.harness !== 'string') continue;
    raus[h.harness] = {
      installed: String(h.installedAfter ?? h.installedBefore ?? ''),
      latest: String(h.latest ?? ''),
      status: String(h.status ?? ''),
      checkedAt: typeof data.checkedAt === 'string' ? data.checkedAt : '',
    };
  }
  return raus;
}

export function harnessUpdateMeldungen(state: HarnessUpdateState): string[] {
  if (!state || !Array.isArray(state.harnesses)) return [];
  const out: string[] = [];
  for (const h of state.harnesses) {
    if (h.status === 'aktualisiert') {
      out.push(`${h.harness} ${h.installedBefore ?? '?'} -> ${h.installedAfter ?? '?'} aktualisiert`);
    } else if (h.pending) {
      const grund = h.liveSessions > 0 ? `${h.liveSessions} Sitzung(en) laufen` : h.status.replace(/^vorgemerkt:\s*/, '');
      out.push(`${h.harness}-Update vorgemerkt: ${grund}`);
    } else if (h.status.includes('fehlgeschlagen')) {
      out.push(`${h.harness}-Update fehlgeschlagen`);
    }
  }
  return out;
}

export interface HarnessUpdateSchedulerOptions {
  bin?: string;
  settingsFile: string;
  startDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  melden(text: string): void;
  aktualisiert?(): void;
}

/**
 * Ein abgeloester Lauf nach dem Start, danach jeweils nach dem eingestellten
 * Abstand. Die Sperrdatei im Shell-Werkzeug ist die maschinenweite Instanz-
 * sperre; `kind` verhindert zusaetzlich einen zweiten Kindprozess dieses Kerns.
 */
export class HarnessUpdateScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private kind: ChildProcess | null = null;
  private beendet = false;

  constructor(private readonly opt: HarnessUpdateSchedulerOptions) {}

  start(): void {
    if (this.timer || this.kind || this.beendet) return;
    if (!harnessUpdateAutomatikErlaubt(this.opt.env ?? process.env)) return;
    this.plane(this.opt.startDelayMs ?? 20_000);
  }

  stop(): void {
    this.beendet = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Der abgeloeste Updateprozess wird nicht mitten in einem Paketwechsel
    // beendet. Er haelt selbst die Sperrdatei und endet nach seinem Lauf.
  }

  private plane(ms: number): void {
    if (this.beendet) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lauf();
    }, ms);
    this.timer.unref?.();
  }

  private naechsterLauf(): void {
    this.plane(harnessUpdateIntervalHours(this.opt.settingsFile) * 60 * 60 * 1000);
  }

  private lauf(): void {
    if (this.beendet || this.kind) return;
    if (!harnessUpdateAuto(this.opt.settingsFile)) {
      this.naechsterLauf();
      return;
    }
    const env = { ...(this.opt.env ?? process.env), AWB_SETTINGS_FILE: this.opt.settingsFile };
    const kind = spawn(this.opt.bin ?? 'wb-harness-update', ['anwenden', '--all', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
    });
    this.kind = kind;
    kind.unref();
    let out = '';
    let err = '';
    const sammeln = (alt: string, chunk: Buffer): string => (alt + chunk.toString()).slice(-2_000_000);
    kind.stdout?.on('data', (b: Buffer) => { out = sammeln(out, b); });
    kind.stderr?.on('data', (b: Buffer) => { err = sammeln(err, b); });
    kind.on('error', (e) => {
      err = String(e);
    });
    kind.on('close', (code) => {
      this.kind = null;
      if (code === 0 || out.trim()) {
        try {
          const state = JSON.parse(out) as HarnessUpdateState;
          for (const text of harnessUpdateMeldungen(state)) this.opt.melden(text);
          this.opt.aktualisiert?.();
        } catch {
          if (code !== 0) this.opt.melden(`Harness-Aktualisierung fehlgeschlagen: ${err.trim() || `Exit ${code}`}`);
        }
      } else if (code !== 3) {
        // Exit 3 bedeutet nur: Ein anderer Kern/Lauf haelt die Sperrdatei.
        this.opt.melden(`Harness-Aktualisierung fehlgeschlagen: ${err.trim() || `Exit ${code}`}`);
      }
      this.naechsterLauf();
    });
  }
}
