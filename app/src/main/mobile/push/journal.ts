import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Notification, NotificationEventType, Source } from '../../../mobile-shared/vertrag';
import type { WorkerFertigGrund } from './dringend';

export interface NotificationRecord extends Notification {
  readonly link: string;
  /** `in_app`: bewusst kein Push, die Meldung steht nur in der App. */
  readonly delivery: 'sent' | 'suppressed' | 'failed' | 'in_app';
  /** Nur bei `worker.done`: das Kuerzel der Regel aus dringend.ts, die entschieden hat. */
  readonly grund?: WorkerFertigGrund;
}

/** Der Wartewunsch „Bescheid geben“ einer Sitzung: gilt bis `bis` oder bis zum ersten ausgeloesten Push. */
interface WartewunschRecord { readonly bis: number; }

export interface PushSubscriptionRecord {
  readonly id: string;
  readonly device_id: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly created_at: number;
}

interface DedupeRecord { readonly expires_at: number; }

interface PersistedState {
  version: 1;
  subscriptions: PushSubscriptionRecord[];
  notifications: NotificationRecord[];
  dedupe: Record<string, DedupeRecord>;
  /** Je globaler Sitzungskennung; fehlt in Dateien von vor dem 09.10.2026 (dann leer). */
  wartewuensche?: Record<string, WartewunschRecord>;
}

const emptyState = (): PersistedState => ({ version: 1, subscriptions: [], notifications: [], dedupe: {} });

function subscriptionId(deviceId: string, endpoint: string): string {
  return createHash('sha256').update(`${deviceId}\0${endpoint}`).digest('base64url');
}

/**
 * Eine einzelne 0600-Datei sichert Reihenfolge, Journal, Abos und Dedupe
 * gemeinsam atomar. Ein Integrator kann denselben State-Ordner auf beiden
 * Hosts replizieren, die Zuständigkeitsprüfung bleibt trotzdem die erste
 * Doppelmeldungsschranke.
 */
export class PushJournal {
  private readonly path: string;

  constructor(stateDirectory: string, private readonly maximum = 256) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('journal maximum must be positive');
    this.path = join(stateDirectory, 'push-state.json');
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  }

  list(): readonly NotificationRecord[] {
    return [...this.load().notifications].sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id));
  }

  subscriptions(): readonly PushSubscriptionRecord[] {
    return [...this.load().subscriptions];
  }

  saveSubscription(deviceId: string, value: { endpoint: string; keys: { p256dh: string; auth: string } }, now = Date.now()): PushSubscriptionRecord {
    const state = this.load();
    const id = subscriptionId(deviceId, value.endpoint);
    const record: PushSubscriptionRecord = { id, device_id: deviceId, endpoint: value.endpoint, keys: { ...value.keys }, created_at: now };
    state.subscriptions = [...state.subscriptions.filter((subscription) => subscription.id !== id), record];
    this.save(state);
    return record;
  }

  removeSubscription(deviceId: string, id: string): boolean {
    const state = this.load();
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter((subscription) => subscription.id !== id || subscription.device_id !== deviceId);
    if (before !== state.subscriptions.length) this.save(state);
    return before !== state.subscriptions.length;
  }

  hasEvent(id: string): boolean {
    return this.load().notifications.some((notification) => notification.id === id && notification.delivery !== 'failed');
  }

  reserveDedupe(key: string, expiresAt: number, now = Date.now()): boolean {
    const state = this.load();
    for (const [candidate, value] of Object.entries(state.dedupe)) if (value.expires_at <= now) delete state.dedupe[candidate];
    if (state.dedupe[key]) {
      this.save(state);
      return false;
    }
    state.dedupe[key] = { expires_at: expiresAt };
    this.save(state);
    return true;
  }

  clearState(type: NotificationEventType, machine: string, targetId: string, stateFingerprint: string): void {
    const state = this.load();
    delete state.dedupe[dedupeKey(type, machine, targetId, stateFingerprint)];
    this.save(state);
  }

  releaseDedupe(key: string): void {
    const state = this.load();
    if (!state.dedupe[key]) return;
    delete state.dedupe[key];
    this.save(state);
  }

  /** Setzt (`bis` als Zeitpunkt) oder loescht (`null`) den Wartewunsch einer Sitzung. */
  wartewunschSetzen(sessionId: string, bis: number | null, now = Date.now()): void {
    const state = this.load();
    const wuensche = abgelaufeneEntfernen(state.wartewuensche ?? {}, now);
    if (bis === null) delete wuensche[sessionId];
    else wuensche[sessionId] = { bis };
    state.wartewuensche = wuensche;
    this.save(state);
  }

  /** Bis wann der Wartewunsch einer Sitzung gilt; null ohne (oder nach Ablauf). */
  wartewunschBis(sessionId: string, now = Date.now()): number | null {
    const eintrag = this.load().wartewuensche?.[sessionId];
    return eintrag && Number.isSafeInteger(eintrag.bis) && eintrag.bis > now ? eintrag.bis : null;
  }

  wartewuensche(now = Date.now()): Record<string, number> {
    const rest = abgelaufeneEntfernen(this.load().wartewuensche ?? {}, now);
    return Object.fromEntries(Object.entries(rest).map(([id, eintrag]) => [id, eintrag.bis]));
  }

  append(notification: NotificationRecord): void {
    const state = this.load();
    const existing = state.notifications.findIndex((item) => item.id === notification.id);
    if (existing >= 0) {
      if (state.notifications[existing].delivery !== 'failed') return;
      state.notifications[existing] = notification;
    } else state.notifications.push(notification);
    state.notifications.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
    if (state.notifications.length > this.maximum) state.notifications.splice(0, state.notifications.length - this.maximum);
    this.save(state);
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1) return emptyState();
      const state = parsed as PersistedState;
      if (!Array.isArray(state.subscriptions) || !Array.isArray(state.notifications) || typeof state.dedupe !== 'object' || state.dedupe === null) return emptyState();
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw new Error('push state is unreadable');
    }
  }

  /**
   * Atomar UND mit garantierten Rechten (Sicherheits-Review 2026-09-21).
   * `mode` in `writeFileSync` gilt nur, wenn die Datei neu angelegt wird: lag
   * unter dem festen Namen `<pfad>.tmp` schon eine Datei, erbte `push-state.json`
   * beim Umbenennen deren Rechte -- und darin stehen die `auth`-Geheimnisse der
   * Push-Abos. Deshalb derselbe Weg wie im Geraetezustand (auth.ts): eindeutiger
   * Name, `wx` (O_EXCL), chmod nach dem Schreiben, und das Verzeichnis bleibt 0700.
   */
  private save(state: PersistedState): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
      chmodSync(temporary, 0o600);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
}

function abgelaufeneEntfernen(wuensche: Record<string, WartewunschRecord>, now: number): Record<string, WartewunschRecord> {
  const rest: Record<string, WartewunschRecord> = {};
  for (const [id, eintrag] of Object.entries(wuensche)) if (Number.isSafeInteger(eintrag?.bis) && eintrag.bis > now) rest[id] = { bis: eintrag.bis };
  return rest;
}

export function dedupeKey(type: NotificationEventType, authoritativeMachine: string, targetId: string, stateFingerprint: string): string {
  return `${type}:${authoritativeMachine}:${targetId}:${stateFingerprint}`;
}

export function neutralNotificationText(type: NotificationEventType): string {
  const texts: Record<NotificationEventType, string> = {
    'orchestrator.waiting': 'Eine Orchestrator-Sitzung wartet auf Aufmerksamkeit.',
    'worker.done': 'Ein Worker ist fertig.',
    'command.blocked': 'Eine Werkbankaktion wartet auf Entscheidung.',
    'session.lost': 'Eine Sitzung ist nicht mehr erreichbar.',
    'worker.stalled': 'Ein lokaler Worker steht still.',
  };
  return texts[type];
}

/**
 * Deep Links sind Hash-Routen der PWA (router.ts): die Huelle liegt unter der
 * Origin-Wurzel, ihre Assets sind relativ, und ein Pfad wie `/sessions/<id>`
 * laedt deshalb nicht (Befund Paket 9). Sitzungsereignisse fuehren in den Chat
 * ihrer Sitzung, alles andere in die Meldung selbst.
 */
export function notificationLink(type: NotificationEventType, targetId: string, eventId: string): string {
  if (type === 'worker.done' || type === 'worker.stalled' || type === 'orchestrator.waiting' || type === 'session.lost') {
    return `/#/sitzungen/${encodeURIComponent(targetId)}`;
  }
  return `/#/meldungen/${encodeURIComponent(eventId)}`;
}

export function sourceFor(authoritativeMachine: string, localMachine: string): Source {
  return authoritativeMachine === localMachine ? 'authoritative' : 'mirror';
}
