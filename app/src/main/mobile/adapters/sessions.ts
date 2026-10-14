import { validateCreateSessionBody } from '../../../mobile-shared/validierung';
import type { JsonValue, PaneBinding, SessionState } from '../../../mobile-shared/vertrag';
import { MobileAuthError } from '../auth/auth';
import type { MobileRouteHandlers, MobileRouteRequest } from '../http/server';

/** Der minimale Teil von SessionInfo, den die Mobilansicht wirklich braucht. */
export interface MobileSessionRecord {
  readonly id: string;
  readonly name: string;
  readonly machine: string;
  readonly harness: string;
  readonly model: string;
  readonly state: SessionState;
  readonly lastActive: string;
  readonly workers: readonly { readonly state: string }[];
  readonly pendingApprovals: number;
  /** Vertrag 1.2: Ziel fuer den signierten Body von messages/keys; nur lokal und mit Orchestrator-Pane. */
  readonly binding?: PaneBinding | null;
  /**
   * Letzte Regung des Orchestrator-Panes (tmux `window_activity`), nur lokal.
   * Aendert sich, sobald im Pane etwas geschrieben wird -- waehrend der
   * Harness antwortet, also genau dann, wenn der Chat waechst. Nur fuer den
   * Takt des Kerns (`chat.changed`), nie an die App ausgeliefert.
   */
  readonly chatRegung?: string;
}

export interface SessionStartInput {
  readonly directory: string;
  readonly name: string;
  readonly machine: string;
  readonly harness: string;
  readonly model: string;
}

/**
 * Schmale Bruecke zu main.ts. Paket 10 befuellt sie mit `modellLesen()`,
 * `sessionAnlegen()` (main.ts:1737), `sessionWiederherstellen()` (:1245) und
 * `menuePunktAusfuehren(id, 'schliessen', false, true)` (:5201). Der Adapter
 * darf diese Kernpruefungen weder nachbauen noch Sitzungen selbst starten.
 */
export interface SessionsForMobile {
  readonly localMachine: string;
  /** `modellLesen()` — app/src/main/main.ts:1034. */
  fresh(): Promise<readonly MobileSessionRecord[]> | readonly MobileSessionRecord[];
  /** RemotePoller snapshot timestamp; local records return 0, mirrors their exact age. */
  dataAgeMs(session: MobileSessionRecord): number;
  /** `sessionAnlegen()` — app/src/main/main.ts:1737. */
  start(input: SessionStartInput): Promise<MobileSessionRecord>;
  /** `sessionWiederherstellen()` — app/src/main/main.ts:1245. */
  resume(id: string): Promise<MobileSessionRecord>;
  /** `menuePunktAusfuehren(id, 'schliessen', false, true)` — main.ts:5201. */
  close(id: string): Promise<{ readonly ok: boolean; readonly workersRunning: boolean; readonly message: string }>;
  /**
   * v1.7: bis wann der Wartewunsch „Bescheid geben“ einer autoritativen Sitzung
   * gilt (null = keiner). Fehlt die Funktion, fehlt auch das Feld `notify_until`.
   */
  notifyUntil?(id: string): number | null;
}

export interface MobileSessionProjection {
  id: string;
  source: 'authoritative' | 'mirror';
  name: string;
  harness: string;
  model: string;
  state: SessionState;
  updated_at: number;
  /** Privacy decision: worker details never leave the kernel for the PWA. */
  workers: [];
  worker_count: number;
  running_worker_count: number;
  open_approvals: number;
  data_age_ms: number;
  binding?: PaneBinding;
  notify_until?: number | null;
}

function failure(code: 'bad_request' | 'stale_target' | 'capability_unavailable', message: string): never {
  throw new MobileAuthError(code, message);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function project(session: MobileSessionRecord, source: SessionsForMobile): MobileSessionProjection {
  const dataAge = source.dataAgeMs(session);
  if (!Number.isSafeInteger(dataAge) || dataAge < 0) {
    throw new Error(`dataAgeMs must return a non-negative safe integer for ${session.id}`);
  }
  return {
    id: session.id,
    source: session.machine === source.localMachine ? 'authoritative' : 'mirror',
    name: session.name,
    harness: session.harness,
    model: session.model,
    state: session.state,
    updated_at: timestamp(session.lastActive),
    workers: [],
    worker_count: session.workers.length,
    running_worker_count: session.workers.filter((worker) => worker.state === 'running').length,
    open_approvals: session.pendingApprovals,
    data_age_ms: dataAge,
    // Ein Spiegel bekommt nie eine Bindung: geschrieben wird nur an die autoritative Origin.
    ...(session.machine === source.localMachine && session.binding ? { binding: { ...session.binding } } : {}),
    // v1.7: nur die autoritative Origin kennt und nimmt den Wartewunsch an.
    ...(session.machine === source.localMachine && source.notifyUntil ? { notify_until: source.notifyUntil(session.id) } : {}),
  };
}

async function localCurrent(source: SessionsForMobile, id: string): Promise<MobileSessionRecord> {
  const matches = (await source.fresh()).filter((session) => session.id === id);
  if (matches.length !== 1) failure('stale_target', 'session is no longer current');
  if (matches[0].machine !== source.localMachine) {
    failure('capability_unavailable', 'mirrored sessions are read-only on this origin');
  }
  return matches[0];
}

/** Paket 10 merges this object with the other route adapters. */
export function createSessionHandlers(source: SessionsForMobile): Pick<MobileRouteHandlers,
  'GET /sessions' | 'POST /sessions' | 'POST /sessions/:id/resume' | 'POST /sessions/:id/close'> {
  return {
    'GET /sessions': async () => ({ data: { sessions: (await source.fresh()).map((session) => project(session, source)) } as unknown as JsonValue }),
    'POST /sessions': async (request: MobileRouteRequest) => {
      const body = validateCreateSessionBody(request.body);
      if (!body.ok) failure('bad_request', body.error);
      if (body.value.machine !== source.localMachine) {
        failure('capability_unavailable', 'a session can only be started on its authoritative origin');
      }
      const session = await source.start(body.value);
      return { data: { session: project(session, source) } as unknown as JsonValue };
    },
    'POST /sessions/:id/resume': async (request) => {
      await localCurrent(source, request.params.id);
      const session = await source.resume(request.params.id);
      return { data: { session: project(session, source) } as unknown as JsonValue };
    },
    'POST /sessions/:id/close': async (request) => {
      await localCurrent(source, request.params.id);
      const result = await source.close(request.params.id);
      if (!result.ok) {
        if (result.workersRunning) {
          // Der Server bildet diesen v1.1-Vertragscode auf HTTP 409 ab.
          throw new MobileAuthError('close_rejected_workers_running', result.message);
        }
        failure('stale_target', result.message || 'session could not be closed');
      }
      return { data: { accepted_at: Date.now() } as unknown as JsonValue };
    },
  };
}
