import { createHash } from 'node:crypto';
import { validatePromptAnswerBody } from '../../../mobile-shared/validierung';
import type { JsonValue, Prompt } from '../../../mobile-shared/vertrag';
import { MobileAuthError } from '../auth/auth';
import type { MobileRouteHandlers } from '../http/server';

const MEASURED_VERSION = '1.18.31';
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;
const OPTION_REPLIES = Object.freeze({ allow_once: 'once', reject: 'reject' } as const);

export const MEASURED_DIALOG_CAPABILITIES = Object.freeze({
  'prompt.answer.claude': false,
  'prompt.answer.codex': false,
  'prompt.answer.opencode': true,
  'prompt.answer.pi': false,
});

export interface MobileDialogSession {
  readonly id: string;
  readonly machine: string;
  readonly harness: string;
}

/**
 * Paket 10 resolves this from the freshly selected local OpenCode pane. The
 * password is process state inherited by that OpenCode server; it is never
 * returned to the mobile client or included in an error.
 */
export interface OpenCodeDialogConnection {
  readonly origin: string;
  readonly version: string;
  readonly sessionID: string;
  readonly username: 'opencode';
  readonly password: string;
}

export interface DialogsForMobile {
  readonly localMachine: string;
  fresh(): Promise<readonly MobileDialogSession[]> | readonly MobileDialogSession[];
  openCode(session: MobileDialogSession): Promise<OpenCodeDialogConnection | null> | OpenCodeDialogConnection | null;
  /** Test seam only; production uses the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface PendingPermission {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface MeasuredPermission extends PendingPermission {
  readonly action: 'external_directory';
  readonly resources: readonly [string];
  readonly metadata: Readonly<{ command: string }>;
}

interface HttpResult {
  readonly status: number;
  readonly text: string;
}

function fail(code: 'bad_request' | 'stale_target' | 'capability_unavailable' | 'prompt_changed' | 'internal_error', message: string): never {
  throw new MobileAuthError(code, message);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedPlainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function id(value: unknown, prefix: 'per' | 'ses'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
}

function permission(value: unknown): PendingPermission | null {
  if (!object(value) || !id(value.id, 'per') || !id(value.sessionID, 'ses') || !boundedPlainText(value.action, 80)) return null;
  if (!Array.isArray(value.resources) || value.resources.length > 16
    || !value.resources.every((item) => boundedPlainText(item, 1024))) return null;
  if (!object(value.metadata)) return null;
  return {
    id: value.id,
    sessionID: value.sessionID,
    action: value.action,
    resources: value.resources as string[],
    metadata: value.metadata,
    raw: value,
  };
}

function pendingPermissions(text: string): readonly PendingPermission[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('capability_unavailable', 'OpenCode returned malformed permission JSON');
  }
  if (!object(value) || !Array.isArray(value.data) || value.data.length > 32) {
    return fail('capability_unavailable', 'OpenCode returned an unknown permission envelope');
  }
  const parsed = value.data.map(permission);
  if (parsed.some((item) => item === null)) {
    return fail('capability_unavailable', 'OpenCode returned an unknown permission record');
  }
  return parsed as PendingPermission[];
}

function measured(permission: PendingPermission): permission is MeasuredPermission {
  const metadataKeys = Object.keys(permission.metadata).sort();
  const rawKeys = Object.keys(permission.raw).sort();
  return permission.action === 'external_directory'
    && permission.resources.length === 1
    && /^\/(?:[^/\0]+\/)*[^/\0*]+\/\*$/.test(permission.resources[0])
    && metadataKeys.length === 1 && metadataKeys[0] === 'command'
    && boundedPlainText(permission.metadata.command, 4096)
    && rawKeys.length === 5
    && rawKeys.every((key) => ['action', 'id', 'metadata', 'resources', 'sessionID'].includes(key));
}

function canonicalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}`;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    return fail('capability_unavailable', 'OpenCode returned an oversized permission response');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return fail('capability_unavailable', 'OpenCode returned an oversized permission response');
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function localSession(source: DialogsForMobile, sessionId: string): Promise<MobileDialogSession> {
  const matches = (await source.fresh()).filter((session) => session.id === sessionId);
  if (matches.length !== 1) fail('stale_target', 'session is no longer current');
  const session = matches[0];
  if (session.machine !== source.localMachine) fail('capability_unavailable', 'mirrored sessions cannot expose prompts');
  if (session.harness !== 'opencode') fail('capability_unavailable', 'this harness has no measured mobile dialog adapter');
  return session;
}

async function connection(source: DialogsForMobile, session: MobileDialogSession): Promise<OpenCodeDialogConnection & { origin: string }> {
  const candidate = await source.openCode(session);
  if (!candidate) fail('capability_unavailable', 'the OpenCode dialog endpoint is unavailable');
  if (candidate.version !== MEASURED_VERSION) fail('capability_unavailable', 'the OpenCode version is not measured');
  const origin = canonicalOrigin(candidate.origin);
  if (!origin) fail('capability_unavailable', 'the OpenCode dialog endpoint is not an exact loopback origin');
  if (candidate.username !== 'opencode' || !boundedPlainText(candidate.password, 4096) || !id(candidate.sessionID, 'ses')) {
    fail('capability_unavailable', 'the measured OpenCode authentication or session binding is unavailable');
  }
  return { ...candidate, origin };
}

async function request(source: DialogsForMobile, connection: OpenCodeDialogConnection, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const authorization = Buffer.from(`${connection.username}:${connection.password}`, 'utf8').toString('base64');
  try {
    const response = await (source.fetchImpl ?? fetch)(`${connection.origin}${path}`, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${authorization}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    const text = await readBoundedBody(response);
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof MobileAuthError) throw error;
    return fail('capability_unavailable', 'the OpenCode dialog endpoint did not answer');
  } finally {
    clearTimeout(timeout);
  }
}

function fingerprint(connection: OpenCodeDialogConnection, permission: MeasuredPermission): string {
  const canonical = JSON.stringify({
    adapter: 'opencode-v2-permission',
    version: MEASURED_VERSION,
    origin: connection.origin,
    sessionID: permission.sessionID,
    requestID: permission.id,
    action: permission.action,
    resources: permission.resources,
    command: permission.metadata.command,
    options: Object.keys(OPTION_REPLIES),
  });
  return `opencode-${MEASURED_VERSION}:${createHash('sha256').update(canonical).digest('hex')}`;
}

function prompt(connection: OpenCodeDialogConnection, permission: MeasuredPermission): Prompt {
  return {
    fingerprint: fingerprint(connection, permission),
    harness: 'opencode',
    harness_version: MEASURED_VERSION,
    text: `Allow OpenCode external directory access to ${permission.resources[0]} for: ${permission.metadata.command}`,
    selection: 'single',
    // Native HTTP permissions have no TUI cursor. No selected state is invented.
    options: [
      { id: 'allow_once', label: 'Allow once', selected: false },
      { id: 'reject', label: 'Reject', selected: false },
    ],
  };
}

async function currentPrompt(source: DialogsForMobile, sessionId: string): Promise<{ connection: OpenCodeDialogConnection; permission: MeasuredPermission; prompt: Prompt } | null> {
  const session = await localSession(source, sessionId);
  const active = await connection(source, session);
  const response = await request(source, active, '/api/permission/request');
  if (response.status === 401) fail('capability_unavailable', 'OpenCode rejected its measured Basic authentication');
  if (response.status !== 200) fail('capability_unavailable', 'OpenCode permission listing is unavailable');
  const matching = pendingPermissions(response.text)
    .filter((item) => item.sessionID === active.sessionID && measured(item)) as MeasuredPermission[];
  if (matching.length > 1) fail('capability_unavailable', 'OpenCode returned more than one matching permission prompt');
  if (matching.length === 0) return null;
  return { connection: active, permission: matching[0], prompt: prompt(active, matching[0]) };
}

export function createDialogHandlers(source: DialogsForMobile): Pick<MobileRouteHandlers,
  'GET /sessions/:id/prompt' | 'POST /sessions/:id/prompt-answer'> {
  return {
    'GET /sessions/:id/prompt': async (route) => {
      const current = await currentPrompt(source, route.params.id);
      return { data: { prompt: current?.prompt ?? null } as unknown as JsonValue };
    },
    'POST /sessions/:id/prompt-answer': async (route) => {
      const body = validatePromptAnswerBody(route.body);
      if (!body.ok) fail('bad_request', body.error);
      if (body.value.text !== undefined) fail('bad_request', 'OpenCode permission answers do not accept text');

      // This is intentionally a new fetch, not a cached GET result. It rebinds
      // session, exact version, loopback endpoint and prompt immediately before
      // the answer is sent.
      const current = await currentPrompt(source, route.params.id);
      if (!current || current.prompt.fingerprint !== body.value.fingerprint) {
        fail('prompt_changed', 'OpenCode permission changed before it could be answered');
      }
      const reply = OPTION_REPLIES[body.value.option_id as keyof typeof OPTION_REPLIES];
      if (!reply) fail('bad_request', 'option_id is not available for this measured OpenCode permission');
      const path = `/api/session/${encodeURIComponent(current.permission.sessionID)}/permission/${encodeURIComponent(current.permission.id)}/reply`;
      const response = await request(source, current.connection, path, { method: 'POST', body: JSON.stringify({ reply }) });
      if (response.status === 401) fail('capability_unavailable', 'OpenCode rejected its measured Basic authentication');
      if (response.status === 404 || response.status === 409) fail('prompt_changed', 'OpenCode permission changed during the answer');
      if (response.status !== 204 || response.text.trim() !== '') fail('internal_error', 'OpenCode returned an unknown permission reply result');
      return { data: { accepted_at: (source.now ?? Date.now)() } as unknown as JsonValue };
    },
  };
}
