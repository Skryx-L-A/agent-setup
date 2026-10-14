import { createHash } from 'node:crypto';
import { validateDecisionBody } from '../../../mobile-shared/validierung';
import type { Approval, JsonValue } from '../../../mobile-shared/vertrag';
import { MobileAuthError } from '../auth/auth';
import type { MobileRouteHandlers } from '../http/server';
import { mobilBeleg, type Herkunftsbeleg } from '../../herkunft';

export interface MobileRequestApproval {
  readonly path: string;
  readonly parent: string;
  readonly childName: string;
  readonly task: string;
  readonly ts: string;
}

export interface MobileGuardApproval {
  readonly path: string;
  readonly schluessel: string;
  readonly sessionId: string;
  readonly workerName: string;
  readonly reason: string;
  readonly musterGrund: string;
  readonly ts: string;
  readonly wartet: boolean;
}

/**
 * Paket 10 fills this from readRequests/readGuardBlocks (freigaben.ts:46/:281)
 * and decides through decideRequest (:100) / musterEntscheiden (main.ts:2017).
 * A verified mobile request is never converted to the old boolean `mensch`.
 */
export interface ApprovalsForMobile {
  /** `readRequests()` / `readGuardBlocks()` — freigaben.ts:46/:281. */
  list(): Promise<{ readonly requests: readonly MobileRequestApproval[]; readonly guards: readonly MobileGuardApproval[] }>
    | { readonly requests: readonly MobileRequestApproval[]; readonly guards: readonly MobileGuardApproval[] };
  /** `decideRequest()` — freigaben.ts:100. */
  decideRequest(entry: MobileRequestApproval, decision: 'approve' | 'reject', reason: string, origin: Herkunftsbeleg): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** `musterEntscheiden()` — main.ts:2017; false until typed proof reaches wb-freigabe. */
  decideGuard(entry: MobileGuardApproval, decision: 'approve' | 'reject', reason: string, human: false): Promise<{ readonly ok: boolean; readonly message: string }>;
}

const id = (kind: string, value: string): string => `${kind}:${createHash('sha256').update(value).digest('hex')}`;
const time = (value: string): number => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const unavailable = (message: string): never => { throw new MobileAuthError('capability_unavailable', message); };
const stale = (message: string): never => { throw new MobileAuthError('stale_target', message); };

function approvalForRequest(entry: MobileRequestApproval): Approval {
  return { id: id('request', entry.path), kind: 'request', source: 'authoritative', session_id: null,
    summary: `${entry.parent} requested worker ${entry.childName}: ${entry.task}`, created_at: time(entry.ts) };
}

function approvalForGuard(entry: MobileGuardApproval): Approval {
  return { id: id('guard', entry.schluessel || entry.path), kind: 'guard', source: 'authoritative',
    session_id: /^[^:]+:.+$/.test(entry.sessionId) ? entry.sessionId as `${string}:${string}` : null,
    summary: entry.musterGrund || entry.reason || `blocked command for ${entry.workerName}`,
    created_at: time(entry.ts) };
}

export function createApprovalHandlers(source: ApprovalsForMobile): Pick<MobileRouteHandlers,
  'GET /approvals' | 'POST /approvals/requests/:id/decision' | 'POST /approvals/guards/:id/decision'> {
  return {
    'GET /approvals': async () => {
      const snapshot = await source.list();
      return { data: { approvals: [...snapshot.requests.map(approvalForRequest), ...snapshot.guards.filter((guard) => guard.wartet).map(approvalForGuard)] } as unknown as JsonValue };
    },
    'POST /approvals/requests/:id/decision': async (request) => {
      const body = validateDecisionBody(request.body);
      if (!body.ok) throw new MobileAuthError('bad_request', body.error);
      const snapshot = await source.list();
      const entry = snapshot.requests.find((item) => id('request', item.path) === request.params.id);
      if (!entry) return stale('worker request is no longer current');
      // The origin travels with the decision (13.10.2026): only a verified device
      // counts as a human for approving; anything else is refused in the core.
      const origin: Herkunftsbeleg = request.device ? mobilBeleg(request.device) : { art: 'steuerkanal' };
      const result = await source.decideRequest(entry, body.value.decision, body.value.reason, origin);
      if (!result.ok) stale(result.message || 'worker request could not be decided');
      return { data: { decided_at: Date.now() } as unknown as JsonValue };
    },
    'POST /approvals/guards/:id/decision': async (request) => {
      const body = validateDecisionBody(request.body);
      if (!body.ok) throw new MobileAuthError('bad_request', body.error);
      if (body.value.decision === 'approve') {
        unavailable('guard approval requires a typed mobile origin proof at wb-freigabe');
      }
      const snapshot = await source.list();
      const entry = snapshot.guards.find((item) => item.wartet && id('guard', item.schluessel || item.path) === request.params.id);
      if (!entry) return stale('guard block is no longer current');
      const result = await source.decideGuard(entry, 'reject', body.value.reason, false);
      if (!result.ok) stale(result.message || 'guard block could not be rejected');
      return { data: { decided_at: Date.now() } as unknown as JsonValue };
    },
  };
}
