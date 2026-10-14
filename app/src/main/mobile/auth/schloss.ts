import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_DIRECTORY = 'auth.lock';
const TAKEOVER_DIRECTORY = 'auth.lock.takeover';
const HOLDER_FILE = 'holder.json';
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export interface MobileAuthLockHolder {
  readonly pid: number;
  readonly started_at: string;
}

export class MobileStateLockError extends Error {
  constructor(readonly holder: MobileAuthLockHolder | null, readonly reason: 'held' | 'unknown' | 'takeover') {
    super(holder
      ? `Mobilweg gesperrt, Schloss von PID ${holder.pid} seit ${holder.started_at}.`
      : 'Mobilweg gesperrt, der Halter des Schlosses ist nicht feststellbar.');
    this.name = 'MobileStateLockError';
  }
}

export interface MobileAuthLock {
  readonly recovered: boolean;
  release(): void;
}

interface ProcessState {
  readonly state: 'alive' | 'dead' | 'unknown';
  readonly holder: MobileAuthLockHolder | null;
}

function lockPath(directory: string): string {
  return join(directory, LOCK_DIRECTORY);
}

function holderPath(path: string): string {
  return join(path, HOLDER_FILE);
}

export function mobileAuthProcessStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 });
  if (result.error || result.signal || result.status !== 0) return null;
  const startedAt = result.stdout.trim();
  return startedAt ? startedAt : null;
}

function readHolder(path: string): MobileAuthLockHolder | null {
  try {
    const value = JSON.parse(readFileSync(holderPath(path), 'utf8')) as { pid?: unknown; started_at?: unknown };
    const pid = value.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.started_at !== 'string' || !value.started_at) return null;
    return { pid, started_at: value.started_at };
  } catch {
    return null;
  }
}

function holderState(path: string): ProcessState {
  const holder = readHolder(path);
  if (!holder) return { state: 'unknown', holder: null };
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown', holder };
  }
  const startedAt = mobileAuthProcessStartTime(holder.pid);
  if (!startedAt) return { state: 'unknown', holder };
  return { state: startedAt === holder.started_at ? 'alive' : 'dead', holder };
}

function ownHolder(): MobileAuthLockHolder {
  const startedAt = mobileAuthProcessStartTime(process.pid);
  if (!startedAt) throw new MobileStateLockError(null, 'unknown');
  return { pid: process.pid, started_at: startedAt };
}

function writeHolder(path: string, holder: MobileAuthLockHolder): void {
  writeFileSync(holderPath(path), `${JSON.stringify(holder)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function sameHolder(left: MobileAuthLockHolder | null, right: MobileAuthLockHolder): boolean {
  return left?.pid === right.pid && left.started_at === right.started_at;
}

function releaseOwnedLock(path: string, holder: MobileAuthLockHolder): void {
  if (sameHolder(readHolder(path), holder)) rmSync(path, { recursive: true, force: true });
}

function wait(): void {
  Atomics.wait(LOCK_WAIT, 0, 0, 10);
}

/**
 * Ein eigenes, festes Reservierungsverzeichnis entscheidet atomar, wer ein
 * nachweislich totes Schloss uebernehmen darf. Es ist selbst wieder mit einer
 * Halterdatei versehen: auch ein abgestuerzter Anwarter wird nie blind entfernt.
 */
function reserveTakeover(directory: string): MobileAuthLockHolder | null {
  const reservation = join(directory, TAKEOVER_DIRECTORY);
  const current = holderState(reservation);
  if (existsSync(reservation)) {
    if (current.state !== 'dead') return null;
    // Ein nachweislich toter Anwarter kann seine Reservierung nicht mehr nutzen.
    // rename ist die atomare Eigentumsuebernahme; nur ihr Gewinner darf entfernen.
    const retired = `${reservation}.retired.${process.pid}.${Date.now()}`;
    try {
      renameSync(reservation, retired);
      rmSync(retired, { recursive: true, force: true });
    } catch {
      return null;
    }
  }
  try {
    mkdirSync(reservation, { mode: 0o700 });
    const holder = ownHolder();
    writeHolder(reservation, holder);
    return holder;
  } catch {
    return null;
  }
}

function releaseTakeover(directory: string, holder: MobileAuthLockHolder): void {
  releaseOwnedLock(join(directory, TAKEOVER_DIRECTORY), holder);
}

function claimDeadLock(directory: string, holder: MobileAuthLockHolder): boolean {
  const reservation = reserveTakeover(directory);
  if (!reservation) return false;
  const path = lockPath(directory);
  try {
    const current = holderState(path);
    if (current.state !== 'dead' || current.holder?.pid !== holder.pid || current.holder.started_at !== holder.started_at) return false;
    rmSync(path, { recursive: true, force: false });
    return true;
  } finally {
    releaseTakeover(directory, reservation);
  }
}

export function acquireMobileAuthLock(directory: string, timeoutMs: number): MobileAuthLock {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = lockPath(directory);
  const deadline = Date.now() + timeoutMs;
  let recovered = false;
  let last: ProcessState = { state: 'unknown', holder: null };
  for (;;) {
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
      const holder = ownHolder();
      writeHolder(path, holder);
      return { recovered, release: () => releaseOwnedLock(path, holder) };
    } catch (error) {
      // Ein Fehler nach mkdir (etwa eine nicht schreibbare Halterdatei) darf
      // kein namenloses Schloss zuruecklassen.
      if (created) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Der Halter kann zwischen dem gescheiterten mkdir und dieser Pruefung
      // freigegeben haben: dann ist das Schloss frei und der naechste Versuch gilt.
      if (!existsSync(path)) continue;
      last = holderState(path);
      if (last.state === 'dead' && last.holder && claimDeadLock(directory, last.holder)) {
        recovered = true;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MobileStateLockError(last.holder, last.state === 'alive' ? 'held' : last.state === 'unknown' ? 'unknown' : 'takeover');
      }
      wait();
    }
  }
}
