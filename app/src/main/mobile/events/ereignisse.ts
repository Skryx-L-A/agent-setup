import { randomBytes } from 'node:crypto';
import { MOBILE_API_VERSION } from '../../../mobile-shared/vertrag';
import type { MachineId, Source, SseEvent, SseEventType } from '../../../mobile-shared/vertrag';

export interface EventSourceMeta {
  readonly machine: MachineId;
  readonly server_build: string;
  readonly source: Source;
}

export interface MobileEventBrokerOptions extends EventSourceMeta {
  /** Der Ring begrenzt die Wiederaufnahme bewusst auf einen kleinen, bekannten Zeitraum. */
  readonly epoch?: string;
  readonly historySize?: number;
}

export interface EventReplay {
  readonly reset: boolean;
  readonly events: readonly SseEvent[];
}

type Subscriber = (event: SseEvent) => void;

/**
 * Prozesslokaler SSE-Ring. Persistenz und die Abbildung von Kernzustand auf
 * Ereignisse liegen in den folgenden Adapterpaketen; dieser Baustein verwaltet
 * nur Reihenfolge, Wiederaufnahme und die begrenzte Retention.
 */
export class MobileEventBroker {
  private readonly epoch: string;
  private readonly historySize: number;
  private readonly events: SseEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private sequence = 0n;

  constructor(private readonly options: MobileEventBrokerOptions) {
    this.epoch = options.epoch ?? randomBytes(12).toString('base64url');
    this.historySize = options.historySize ?? 256;
    if (!Number.isSafeInteger(this.historySize) || this.historySize < 1) {
      throw new Error('historySize must be a positive safe integer');
    }
  }

  get eventEpoch(): string {
    return this.epoch;
  }

  publish(type: SseEventType, ids: readonly string[] = [], source = this.options.source): SseEvent {
    const event = this.newEvent(type, ids, source);
    this.events.push(event);
    if (this.events.length > this.historySize) this.events.splice(0, this.events.length - this.historySize);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  /** Ein Reset wird nur an den betroffenen Reconnect geliefert, nicht erneut gepuffert. */
  resetEvent(): SseEvent {
    return this.newEvent('server.reset', []);
  }

  replay(lastEventId: string | undefined): EventReplay {
    if (!lastEventId) return { reset: false, events: [...this.events] };
    const prefix = `${this.options.machine}:${this.epoch}:`;
    if (!lastEventId.startsWith(prefix)) return { reset: true, events: [] };
    const sequenceText = lastEventId.slice(prefix.length);
    if (!/^(0|[1-9][0-9]*)$/.test(sequenceText)) return { reset: true, events: [] };
    const sequence = BigInt(sequenceText);
    const current = this.sequence;
    if (sequence > current) return { reset: true, events: [] };
    const first = this.events[0];
    if (first) {
      const firstSequence = this.sequenceFromId(first.id);
      if (sequence < firstSequence - 1n) return { reset: true, events: [] };
    } else if (sequence !== current) {
      return { reset: true, events: [] };
    }
    return { reset: false, events: this.events.filter((event) => this.sequenceFromId(event.id) > sequence) };
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private newEvent(type: SseEventType, ids: readonly string[], source = this.options.source): SseEvent {
    this.sequence += 1n;
    return {
      id: `${this.options.machine}:${this.epoch}:${this.sequence}`,
      type,
      machine: this.options.machine,
      source,
      api_version: MOBILE_API_VERSION,
      server_build: this.options.server_build,
      ids: [...ids],
    };
  }

  private sequenceFromId(id: string): bigint {
    return BigInt(id.slice(`${this.options.machine}:${this.epoch}:`.length));
  }
}
