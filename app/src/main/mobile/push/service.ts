import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { MobileRouteHandlers } from '../http/server';
import { MobileAuthError } from '../auth/auth';
import type { MobileEventBroker } from '../events/ereignisse';
import type { JsonObject, NotificationEventType } from '../../../mobile-shared/vertrag';
import { PushJournal, dedupeKey, neutralNotificationText, notificationLink, sourceFor } from './journal';
import { workerFertigEinstufen } from './dringend';
import type { WorkerFertigFelder, WorkerFertigGrund } from './dringend';
import { encryptWebPushPayload, loadVapidKeyMaterial, vapidAuthorization, vapidPublicKey } from './webpush';
import type { VapidKeyMaterial, WebPushSubscription } from './webpush';

/**
 * Entscheidung alice 09.10.2026: nur Dringendes wird als Push verschickt
 * (Freigabe-Anfrage, Fehler, Frage an ihn). `worker.done` steht nur im Journal,
 * also in der App (Tab „Meldungen"), mit Zustellung `in_app` -- ausser die feste
 * Regel in dringend.ts stuft es hoch (Wartewunsch, Frage an alice, Spur steht).
 */
export const PUSH_TYPES: ReadonlySet<NotificationEventType> = new Set<NotificationEventType>([
  'command.blocked', 'worker.stalled', 'session.lost', 'orchestrator.waiting',
]);

export interface PushTrigger {
  /** Persistente Event-ID aus dem vorhandenen Ereignisstrom, nicht aus Chatinhalt erzeugt. */
  readonly event_id: string;
  readonly type: NotificationEventType;
  readonly authoritative_machine: string;
  readonly target_id: string;
  readonly state_fingerprint: string;
  readonly created_at?: number;
  /** Nur bei `worker.done`: die gezaehlten Felder fuer dringend.ts. Fehlen sie, zaehlt nur der Wartewunsch. */
  readonly worker?: WorkerFertigFelder;
}

/** Wartewunsch „Bescheid geben“: bis zum ersten ausgeloesten Push, hoechstens 12 Stunden (Entscheidung alice 09.10.2026). */
export const WARTEWUNSCH_MS = 12 * 60 * 60 * 1000;

export interface PushDelivery {
  readonly event_id: string;
  readonly sent: number;
  readonly suppressed: boolean;
}

export interface MobilePushServiceOptions {
  readonly machine: string;
  readonly stateDirectory: string;
  /**
   * Vom Betreiber gesetzter 0600-Laufzeitpfad, nie ein Repositorypfad. Leer
   * (Paket 10): kein Web Push, das Meldungsjournal laeuft trotzdem -- die
   * Meldungen erscheinen in der App, nur nicht auf dem Sperrbildschirm.
   */
  readonly vapidKeyPath: string;
  readonly dedupeTtlMs?: number;
  readonly journalMaximum?: number;
  /** Nur die isolierte lokale Push-Attrappe darf HTTP verwenden. */
  readonly allowInsecureEndpointForTests?: boolean;
  readonly now?: () => number;
  /** Der vorhandene Paket-4-Ring informiert beide PWA-Origin-Clients ueber Journalaenderungen. */
  readonly events?: Pick<MobileEventBroker, 'publish'>;
}

interface HttpResult { readonly status: number; }
type PushTransport = (endpoint: URL, headers: Readonly<Record<string, string>>, body: Buffer) => Promise<HttpResult>;

function validateSubscription(value: unknown): WebPushSubscription {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('push subscription is malformed');
  const record = value as Record<string, unknown>;
  const keys = record.keys;
  if (typeof record.endpoint !== 'string' || typeof keys !== 'object' || keys === null || Array.isArray(keys)
    || typeof (keys as Record<string, unknown>).p256dh !== 'string' || typeof (keys as Record<string, unknown>).auth !== 'string') {
    throw new Error('push subscription is malformed');
  }
  return { endpoint: record.endpoint, keys: { p256dh: (keys as Record<string, string>).p256dh, auth: (keys as Record<string, string>).auth } };
}

function defaultTransport(endpoint: URL, headers: Readonly<Record<string, string>>, body: Buffer): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(endpoint, { method: 'POST', headers }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

/**
 * Die Abbildung in den Kern wird im Integrationspaket an bestehende Waechter
 * angeschlossen. Diese kleine Schnittstelle verhindert einen zweiten Beobachter
 * und verlangt fuer jedes Ereignis die bereits bekannte Autoritaet und ID.
 */
export interface MobilePushTriggers {
  orchestratorWaiting(trigger: Omit<PushTrigger, 'type'>): Promise<PushDelivery>;
  workerDone(trigger: Omit<PushTrigger, 'type'>): Promise<PushDelivery>;
  commandBlocked(trigger: Omit<PushTrigger, 'type'>): Promise<PushDelivery>;
  sessionLost(trigger: Omit<PushTrigger, 'type'>): Promise<PushDelivery>;
  workerStalled(trigger: Omit<PushTrigger, 'type'>): Promise<PushDelivery>;
}

export class MobilePushService {
  readonly journal: PushJournal;
  private readonly material: VapidKeyMaterial | null;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly options: MobilePushServiceOptions, private readonly transport: PushTransport = defaultTransport) {
    this.journal = new PushJournal(options.stateDirectory, options.journalMaximum);
    this.material = options.vapidKeyPath ? loadVapidKeyMaterial(options.vapidKeyPath) : null;
    this.ttl = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1) throw new Error('dedupe TTL must be positive');
  }

  /** Der oeffentliche VAPID-Schluessel fuer `GET /bootstrap`; null ohne Schluesseldatei. */
  publicKey(): string | null {
    return this.material ? vapidPublicKey(this.material) : null;
  }

  handlers(): Pick<MobileRouteHandlers, 'PUT /push/subscription' | 'DELETE /push/subscription/:id' | 'GET /notifications'> {
    return {
      'PUT /push/subscription': (request) => {
        if (!this.material) throw new MobileAuthError('capability_unavailable', 'web push has no VAPID key on this host');
        const subscription = validateSubscription((request.body as { subscription?: unknown } | undefined)?.subscription);
        this.assertEndpoint(subscription.endpoint);
        const saved = this.journal.saveSubscription(request.device?.device_id ?? '', subscription, this.now());
        return { data: { subscription_id: saved.id } as JsonObject };
      },
      'DELETE /push/subscription/:id': (request) => {
        this.journal.removeSubscription(request.device?.device_id ?? '', request.params.id);
        return { data: undefined, status: 204 };
      },
      'GET /notifications': () => ({ data: { notifications: this.journal.list(), cursor: null } as unknown as JsonObject }),
    };
  }

  triggers(): MobilePushTriggers {
    return {
      orchestratorWaiting: (trigger) => this.publish({ ...trigger, type: 'orchestrator.waiting' }),
      workerDone: (trigger) => this.publish({ ...trigger, type: 'worker.done' }),
      commandBlocked: (trigger) => this.publish({ ...trigger, type: 'command.blocked' }),
      sessionLost: (trigger) => this.publish({ ...trigger, type: 'session.lost' }),
      workerStalled: (trigger) => this.publish({ ...trigger, type: 'worker.stalled' }),
    };
  }

  async publish(trigger: PushTrigger): Promise<PushDelivery> {
    const createdAt = trigger.created_at ?? this.now();
    const source = sourceFor(trigger.authoritative_machine, this.options.machine);
    const key = dedupeKey(trigger.type, trigger.authoritative_machine, trigger.target_id, trigger.state_fingerprint);
    if (this.journal.hasEvent(trigger.event_id)) return { event_id: trigger.event_id, sent: 0, suppressed: true };
    // Spiegel werden protokolliert, aber erzeugen nie eine sichtbare Pushmeldung.
    if (source === 'mirror') {
      this.recordNotification({ id: trigger.event_id, type: trigger.type, source, machine: trigger.authoritative_machine,
        target_id: trigger.target_id, created_at: createdAt, text: neutralNotificationText(trigger.type),
        link: notificationLink(trigger.type, trigger.target_id, trigger.event_id), delivery: 'suppressed' });
      return { event_id: trigger.event_id, sent: 0, suppressed: true };
    }
    if (!this.journal.reserveDedupe(key, createdAt + this.ttl, createdAt)) return { event_id: trigger.event_id, sent: 0, suppressed: true };
    // Die eine Entscheidungsstelle fuer `worker.done` (dringend.ts); die vier
    // dringenden Arten fragt sie nie.
    const stufe = trigger.type === 'worker.done'
      ? workerFertigEinstufen(this.journal.wartewunschBis(trigger.target_id, createdAt) !== null, trigger.worker ?? null)
      : null;
    const grund: { grund?: WorkerFertigGrund } = stufe ? { grund: stufe.grund } : {};
    if (!PUSH_TYPES.has(trigger.type) && stufe?.zustellung !== 'push') {
      this.recordNotification({ id: trigger.event_id, type: trigger.type, source, machine: trigger.authoritative_machine,
        target_id: trigger.target_id, created_at: createdAt, text: neutralNotificationText(trigger.type),
        link: notificationLink(trigger.type, trigger.target_id, trigger.event_id), delivery: 'in_app', ...grund });
      return { event_id: trigger.event_id, sent: 0, suppressed: true };
    }
    const material = this.material;
    if (!material) {
      // Ohne VAPID-Schluessel gibt es keinen Pushdienst: die Meldung steht im
      // Journal (Tab „Meldungen"), ausdruecklich als nicht zugestellt.
      this.journal.releaseDedupe(key);
      this.recordNotification({ id: trigger.event_id, type: trigger.type, source, machine: trigger.authoritative_machine,
        target_id: trigger.target_id, created_at: createdAt, text: neutralNotificationText(trigger.type),
        link: notificationLink(trigger.type, trigger.target_id, trigger.event_id), delivery: 'suppressed', ...grund });
      return { event_id: trigger.event_id, sent: 0, suppressed: true };
    }
    const payload = Buffer.from(JSON.stringify({ event_id: trigger.event_id, type: trigger.type, machine: trigger.authoritative_machine,
      target_id: trigger.target_id, created_at: createdAt, text: neutralNotificationText(trigger.type),
      link: notificationLink(trigger.type, trigger.target_id, trigger.event_id) }), 'utf8');
    let sent = 0;
    let failed = false;
    for (const subscription of this.journal.subscriptions()) {
      try {
        const encrypted = encryptWebPushPayload(payload, subscription);
        const endpoint = new URL(subscription.endpoint);
        const response = await this.transport(endpoint, {
          Authorization: vapidAuthorization(material, subscription.endpoint, createdAt),
          'Content-Encoding': encrypted.contentEncoding,
          TTL: '60',
          'Content-Length': String(encrypted.body.length),
        }, encrypted.body);
        if (response.status >= 200 && response.status < 300) sent += 1;
        else failed = true;
      } catch {
        failed = true;
      }
    }
    // Der Ledger-Eintrag gilt nur nach mindestens einer erfolgreichen
    // Uebergabe an den Pushdienst; ein Ausfall darf die erneute Zustellung
    // beim naechsten beobachteten Zustand nicht dauerhaft sperren.
    if (sent === 0) this.journal.releaseDedupe(key);
    // Der Wartewunsch gilt bis zum ersten ausgeloesten Push dieser Sitzung; ein
    // Ausfall des Pushdienstes verbraucht ihn nicht.
    if (stufe && sent > 0) this.journal.wartewunschSetzen(trigger.target_id, null, createdAt);
    this.recordNotification({ id: trigger.event_id, type: trigger.type, source, machine: trigger.authoritative_machine,
      target_id: trigger.target_id, created_at: createdAt, text: neutralNotificationText(trigger.type),
      link: notificationLink(trigger.type, trigger.target_id, trigger.event_id), delivery: failed ? 'failed' : 'sent', ...grund });
    return { event_id: trigger.event_id, sent, suppressed: false };
  }

  /**
   * Wartewunsch „Bescheid geben“ setzen oder zuruecknehmen. Zurueck kommt, bis
   * wann er gilt (null = keiner). Kein Geheimnis, kein Pfad: nur die globale
   * Sitzungskennung und ein Zeitpunkt.
   */
  wartewunschSetzen(sessionId: string, an: boolean): number | null {
    const jetzt = this.now();
    const bis = an ? jetzt + WARTEWUNSCH_MS : null;
    this.journal.wartewunschSetzen(sessionId, bis, jetzt);
    return bis;
  }

  wartewunschBis(sessionId: string): number | null {
    return this.journal.wartewunschBis(sessionId, this.now());
  }

  /** Alle geltenden Wartewuensche (Sitzung -> bis), fuer den Takt des Kerns mit einem Lesezugriff. */
  wartewuensche(): Readonly<Record<string, number>> {
    return this.journal.wartewuensche(this.now());
  }

  clearState(type: NotificationEventType, authoritativeMachine: string, targetId: string, stateFingerprint: string): void {
    this.journal.clearState(type, authoritativeMachine, targetId, stateFingerprint);
  }

  private assertEndpoint(value: string): void {
    let endpoint: URL;
    try { endpoint = new URL(value); } catch { throw new Error('push endpoint is invalid'); }
    if (endpoint.protocol !== 'https:' && !(this.options.allowInsecureEndpointForTests && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')) {
      throw new Error('push endpoint must use HTTPS');
    }
  }

  private recordNotification(notification: Parameters<PushJournal['append']>[0]): void {
    this.journal.append(notification);
    this.options.events?.publish('notification.changed', [notification.id], notification.source);
  }
}
