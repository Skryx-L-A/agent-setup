import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonicalAudience, canonicalPath, canonicalQuery } from '../../../mobile-shared/kanonisch';
import { MOBILE_API_PREFIX, MOBILE_API_VERSION } from '../../../mobile-shared/vertrag';
import type { JsonValue, MobileApiErrorCode, SignedRequestEnvelope } from '../../../mobile-shared/vertrag';
import { istJournalFehler, MobileAuthError, MobileAuthenticator, MobileReplayedResult } from '../auth/auth';
import type { AuthenticatedRequest, JournalErgebnis } from '../auth/auth';
import { MobileEventBroker } from '../events/ereignisse';
import type { MobileEventBrokerOptions } from '../events/ereignisse';
import { mobilanfrageBelegen } from '../../herkunft';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const ENVELOPE_HEADER = 'x-awb-mobile-envelope';

type RouteName =
  | 'POST /pairings/complete'
  | 'GET /bootstrap'
  | 'GET /sessions'
  | 'GET /sessions/:id/chat'
  | 'POST /sessions/:id/messages'
  | 'POST /sessions/:id/keys'
  | 'GET /sessions/:id/prompt'
  | 'POST /sessions/:id/prompt-answer'
  | 'GET /approvals'
  | 'POST /approvals/requests/:id/decision'
  | 'POST /approvals/guards/:id/decision'
  | 'POST /sessions'
  | 'POST /sessions/:id/resume'
  | 'POST /sessions/:id/close'
  | 'POST /sessions/:id/notify'
  | 'GET /session-options'
  | 'GET /agents'
  | 'POST /agents/actions'
  | 'GET /notifications'
  | 'PUT /push/subscription'
  | 'DELETE /push/subscription/:id';

export interface MobileHttpMeta {
  readonly server_build: string;
  readonly machine: string;
  readonly authoritative: boolean;
}

export interface MobileRouteRequest {
  readonly route: RouteName;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly body: unknown;
  readonly rawBody: Buffer;
  /** Pairing ist absichtlich die einzige Route ohne vorher verifiziertes Geraet. */
  readonly device?: AuthenticatedRequest;
  /**
   * Der vollstaendige, bereits gepruefte Umschlag (Paket 10). `messages` und
   * `keys` reichen ihn unveraendert an `wb-pane-write` weiter, das ihn ein
   * zweites Mal pruefen und dabei verbrauchen laesst.
   */
  readonly envelope?: SignedRequestEnvelope;
  /**
   * `Tailscale-User-Login`, wie `tailscale serve` ihn setzt. Nur Pairing liest
   * ihn; er ist nie ein Menschenbeleg, ein lokaler Prozess kann ihn faelschen.
   */
  readonly identity?: string;
}

export interface MobileRouteResult {
  readonly data: JsonValue | undefined;
  readonly status?: number;
}

export type MobileRouteHandler = (request: MobileRouteRequest) => Promise<MobileRouteResult> | MobileRouteResult;
export type MobileRouteHandlers = Partial<Record<RouteName, MobileRouteHandler>>;

export interface StaticShellResponse {
  readonly body: string | Buffer;
  readonly contentType: string;
}

export type StaticShellHandler = (pathname: string) => Promise<StaticShellResponse | undefined> | StaticShellResponse | undefined;

export interface MobileHttpServerOptions extends MobileHttpMeta {
  readonly port: number;
  /** Beide vollstaendigen Tailnet-Origins, niemals ein Prefix oder Wildcard. */
  readonly origins: readonly string[];
  /** Die eine exakte Origin, fuer die dieser Prozess Signaturen akzeptiert. */
  readonly audience: string;
  readonly authenticator: MobileAuthenticator;
  /**
   * Paket 4 kennt keine Werkbankhandlungen. Erst die spaeteren Adapter duerfen
   * eine Route registrieren; ohne sie bleibt der Weg sichtbar fail-closed.
   */
  readonly handlers?: MobileRouteHandlers;
  /** Paket 9 liefert die Dateien; Paket 4 setzt nur deren sichere Transportgrenze. */
  readonly staticShell?: StaticShellHandler;
  /**
   * Ob DIESE Anfrage ihren Umschlag selbst von `wb-mobil-pruefen` beanspruchen
   * laesst (Spezifikation 4.3). Nur fuer Routen gefragt, bei denen das vom
   * Harness der Sitzung abhaengt: die Promptantwort geht bei einem Pane-Harness
   * als signierter `mobil-taste`-Umschlag hinaus, bei einem Harness mit eigenem
   * Antwortweg (OpenCode) nicht. Ohne diese Auskunft gilt der Normalfall
   * (der Server reserviert selbst).
   */
  readonly paneWriteRoute?: (route: RouteName, request: { readonly params: Readonly<Record<string, string>>; readonly rawBody: Buffer }) => boolean | Promise<boolean>;
  readonly maxBodyBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly eventOptions?: Pick<MobileEventBrokerOptions, 'epoch' | 'historySize'>;
}

export interface MobileHttpServer {
  readonly events: MobileEventBroker;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: MobileApiErrorCode, readonly safeMessage: string) {
    super(safeMessage);
  }
}

interface MatchedRoute {
  readonly route: RouteName | 'GET /events';
  readonly params: Record<string, string>;
}

interface ParsedRequestTarget {
  readonly rawPath: string;
  readonly canonicalPath: string;
  readonly query: readonly { name: string; value: string }[];
  readonly queryMap: Readonly<Record<string, readonly string[]>>;
}

function safeMessage(code: MobileApiErrorCode): string {
  const messages: Record<MobileApiErrorCode, string> = {
    bad_request: 'request is malformed',
    unsupported_api_version: 'mobile API version is unsupported',
    unauthorized_origin: 'origin is not allowed',
    device_not_paired: 'device is not paired',
    device_revoked: 'device is revoked',
    key_not_found: 'device key is not available',
    invalid_signature: 'request signature is invalid',
    invalid_envelope: 'request envelope is invalid',
    audience_mismatch: 'request audience does not match this server',
    request_expired: 'request has expired',
    nonce_replayed: 'request was already used',
    counter_replayed: 'request counter was already used',
    request_id_conflict: 'request identifier conflicts with an earlier request',
    stale_target: 'requested target is no longer current',
    capability_unavailable: 'this mobile capability is not available',
    prompt_changed: 'prompt changed before the action could be applied',
    pane_busy: 'session pane does not accept input right now',
    close_rejected_workers_running: 'session was not closed because workers are still running',
    state_locked: 'mobile state is temporarily locked',
    not_found: 'endpoint was not found',
    rate_limited: 'request rate is limited',
    internal_error: 'internal server error',
  };
  return messages[code];
}

function statusFor(code: MobileApiErrorCode): number {
  if (code === 'not_found') return 404;
  if (code === 'capability_unavailable') return 501;
  if (code === 'stale_target' || code === 'prompt_changed' || code === 'pane_busy' || code === 'request_id_conflict'
    || code === 'state_locked'
    || code === 'close_rejected_workers_running') return 409;
  if (code === 'unauthorized_origin') return 403;
  if (['device_not_paired', 'device_revoked', 'key_not_found', 'invalid_signature', 'audience_mismatch', 'request_expired', 'nonce_replayed', 'counter_replayed'].includes(code)) return 401;
  return 400;
}

function route(method: string, pathname: string): MatchedRoute | undefined {
  const exact: Record<string, RouteName | 'GET /events'> = {
    'POST /mobile/v1/pairings/complete': 'POST /pairings/complete',
    'GET /mobile/v1/bootstrap': 'GET /bootstrap',
    'GET /mobile/v1/sessions': 'GET /sessions',
    'GET /mobile/v1/approvals': 'GET /approvals',
    'POST /mobile/v1/sessions': 'POST /sessions',
    'GET /mobile/v1/agents': 'GET /agents',
    'GET /mobile/v1/session-options': 'GET /session-options',
    'POST /mobile/v1/agents/actions': 'POST /agents/actions',
    'GET /mobile/v1/notifications': 'GET /notifications',
    'PUT /mobile/v1/push/subscription': 'PUT /push/subscription',
    'GET /mobile/v1/events': 'GET /events',
  };
  const direct = exact[`${method} ${pathname}`];
  if (direct) return { route: direct, params: {} };
  const patterns: readonly [RegExp, RouteName][] = [
    [/^GET \/mobile\/v1\/sessions\/([^/]+)\/chat$/, 'GET /sessions/:id/chat'],
    [/^POST \/mobile\/v1\/sessions\/([^/]+)\/messages$/, 'POST /sessions/:id/messages'],
    [/^POST \/mobile\/v1\/sessions\/([^/]+)\/keys$/, 'POST /sessions/:id/keys'],
    [/^GET \/mobile\/v1\/sessions\/([^/]+)\/prompt$/, 'GET /sessions/:id/prompt'],
    [/^POST \/mobile\/v1\/sessions\/([^/]+)\/prompt-answer$/, 'POST /sessions/:id/prompt-answer'],
    [/^POST \/mobile\/v1\/approvals\/requests\/([^/]+)\/decision$/, 'POST /approvals/requests/:id/decision'],
    [/^POST \/mobile\/v1\/approvals\/guards\/([^/]+)\/decision$/, 'POST /approvals/guards/:id/decision'],
    [/^POST \/mobile\/v1\/sessions\/([^/]+)\/resume$/, 'POST /sessions/:id/resume'],
    [/^POST \/mobile\/v1\/sessions\/([^/]+)\/close$/, 'POST /sessions/:id/close'],
    [/^POST \/mobile\/v1\/sessions\/([^/]+)\/notify$/, 'POST /sessions/:id/notify'],
    [/^DELETE \/mobile\/v1\/push\/subscription\/([^/]+)$/, 'DELETE /push/subscription/:id'],
  ];
  for (const [pattern, name] of patterns) {
    const match = `${method} ${pathname}`.match(pattern);
    if (match) return { route: name, params: { id: decodeURIComponent(match[1]) } };
  }
  return undefined;
}

function parseTarget(rawUrl: string | undefined): ParsedRequestTarget {
  const value = rawUrl ?? '/';
  const question = value.indexOf('?');
  const rawPath = question === -1 ? value : value.slice(0, question);
  const rawQuery = question === -1 ? '' : value.slice(question + 1);
  let canonical: string;
  try {
    canonical = canonicalPath(rawPath);
  } catch {
    throw new HttpFailure(400, 'bad_request', safeMessage('bad_request'));
  }
  if (!rawQuery) return { rawPath, canonicalPath: canonical, query: [], queryMap: {} };
  const query: { name: string; value: string }[] = [];
  const queryMap: Record<string, string[]> = {};
  for (const part of rawQuery.split('&')) {
    const equal = part.indexOf('=');
    if (equal === -1) throw new HttpFailure(400, 'bad_request', safeMessage('bad_request'));
    try {
      const name = decodeURIComponent(part.slice(0, equal));
      const queryValue = decodeURIComponent(part.slice(equal + 1));
      query.push({ name, value: queryValue });
      (queryMap[name] ??= []).push(queryValue);
    } catch {
      throw new HttpFailure(400, 'bad_request', safeMessage('bad_request'));
    }
  }
  return { rawPath, canonicalPath: canonical, query, queryMap };
}

function parseEnvelope(header: string | string[] | undefined): SignedRequestEnvelope {
  if (typeof header !== 'string' || Buffer.byteLength(header, 'utf8') > 32 * 1024) {
    throw new MobileAuthError('invalid_envelope');
  }
  try {
    return JSON.parse(header) as SignedRequestEnvelope;
  } catch {
    throw new MobileAuthError('invalid_envelope');
  }
}

function assertEnvelopeBindsRequest(envelope: SignedRequestEnvelope, method: string, target: ParsedRequestTarget): void {
  try {
    if (envelope.method.toUpperCase() !== method || envelope.path !== target.canonicalPath
      || canonicalQuery(envelope.query) !== canonicalQuery(target.query)) {
      throw new MobileAuthError('invalid_envelope');
    }
  } catch (error) {
    if (error instanceof MobileAuthError) throw error;
    throw new MobileAuthError('invalid_envelope');
  }
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new HttpFailure(400, 'bad_request', safeMessage('bad_request'));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined && (typeof contentLength !== 'string' || !/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximum)) {
    request.resume();
    return Promise.reject(new HttpFailure(413, 'bad_request', safeMessage('bad_request')));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) {
        request.resume();
        reject(new HttpFailure(413, 'bad_request', safeMessage('bad_request')));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', () => reject(new HttpFailure(400, 'bad_request', safeMessage('bad_request'))));
  });
}

/**
 * Routen, deren nicht wiederholbare Handlung `wb-pane-write` ueber
 * `wb-mobil-pruefen` selbst atomar beansprucht (Spezifikation 4.3). Der Server
 * prueft hier vollstaendig, reserviert aber nicht -- sonst scheiterte die
 * zweite, massgebliche Pruefung im Werkzeug immer als Wiederholung.
 */
const PANE_WRITE_ROUTES: ReadonlySet<RouteName | 'GET /events'> = new Set<RouteName | 'GET /events'>([
  'POST /sessions/:id/messages',
  'POST /sessions/:id/keys',
]);

/** Routen, bei denen erst die Zusammensetzung (Harness der Sitzung) das entscheidet. */
const VIELLEICHT_PANE_WRITE: ReadonlySet<RouteName | 'GET /events'> = new Set<RouteName | 'GET /events'>([
  'POST /sessions/:id/prompt-answer',
]);

/** Nur Mutationen kommen ins Ergebnisjournal; ein wiederholtes GET holt ohnehin den frischen Stand. */
function journalPflichtig(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/** Was ins Journal kommt, wenn eine Mutation scheitert: Klasse und Status, nie ein Text aus dem Fehler. */
function fehlerErgebnis(error: unknown): JournalErgebnis {
  if (error instanceof HttpFailure) return { status: error.status, code: error.code };
  if (error instanceof MobileAuthError) return { status: statusFor(error.code), code: error.code };
  return { status: 500, code: 'internal_error' };
}

function requestId(envelope?: SignedRequestEnvelope): string {
  return envelope?.request_id ?? randomBytes(12).toString('base64url');
}

/** Kleiner als das lohnt gzip nicht: Kopf und Verwaltung kosten mehr, als sie sparen. */
const GZIP_MINDESTBYTES = 256;
const KOMPRIMIERBAR = /^(text\/|application\/(json|manifest\+json|javascript|xml)|image\/svg\+xml)/;

/** `Accept-Encoding` nennt gzip (oder `*`), und nicht mit q=0 ausgeschlossen. */
function akzeptiertGzip(header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  for (const teil of header.split(',')) {
    const [name, ...parameter] = teil.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = parameter.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

/**
 * Die Huelle liegt im Kern als dauerhafter Buffer im Speicher (gleiches Objekt
 * bei jeder Anfrage): einmal verdichten und merken. Ein Text (die index.html mit
 * eingesetzten Origins) wird bei jeder Anfrage neu gebildet, hat aber stets
 * denselben Inhalt; er wird ueber den Text selbst gefunden. Beide Merker sind
 * klein, weil die Huelle nur wenige Dateien hat.
 */
const verdichteteBuffer = new WeakMap<Buffer, Buffer>();
const verdichteteTexte = new Map<string, Buffer>();
const MAX_MERKTEXTE = 16;

function huelleVerdichten(body: string | Buffer): Buffer {
  if (typeof body !== 'string') {
    let fertig = verdichteteBuffer.get(body);
    if (!fertig) verdichteteBuffer.set(body, fertig = gzipSync(body, { level: 9 }));
    return fertig;
  }
  let fertig = verdichteteTexte.get(body);
  if (!fertig) {
    if (verdichteteTexte.size >= MAX_MERKTEXTE) verdichteteTexte.clear();
    verdichteteTexte.set(body, fertig = gzipSync(body, { level: 9 }));
  }
  return fertig;
}

/**
 * Die Antwort mit Inhalt, bei Bedarf gzip. `Content-Length` wird nur gesetzt, wenn
 * die Laenge feststeht (verdichtet); `Vary: Accept-Encoding` immer, denn derselbe
 * Pfad antwortet je nach Kopf verschieden. Nie fuer SSE: der Ereignisweg
 * (`serveEvents`) schreibt direkt und kommt hier nicht vorbei.
 */
function inhaltSenden(request: IncomingMessage, response: ServerResponse, body: string | Buffer, contentType: string, dauerhaft: boolean): void {
  const vary = response.getHeader('Vary');
  response.setHeader('Vary', typeof vary === 'string' && vary !== '' ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  const laenge = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;
  let verdichtet: Buffer | undefined;
  if (laenge >= GZIP_MINDESTBYTES && KOMPRIMIERBAR.test(contentType) && akzeptiertGzip(request.headers['accept-encoding'])) {
    try {
      verdichtet = dauerhaft ? huelleVerdichten(body) : gzipSync(body);
    } catch {
      verdichtet = undefined;
    }
  }
  if (verdichtet && verdichtet.length < laenge) {
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Length', verdichtet.length);
    response.end(request.method === 'HEAD' ? undefined : verdichtet);
    return;
  }
  response.end(request.method === 'HEAD' ? undefined : body);
}

export function createMobileHttpServer(options: MobileHttpServerOptions): MobileHttpServer {
  const origins = new Set(options.origins.map((origin) => canonicalAudience(origin)));
  const audience = canonicalAudience(options.audience);
  if (!origins.has(audience)) throw new Error('audience must be in the CORS origin allowlist');
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('port must be between 0 and 65535');
  const maximum = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('maxBodyBytes must be a positive safe integer');
  const heartbeat = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeat) || heartbeat < 1) throw new Error('heartbeatIntervalMs must be a positive safe integer');
  const events = new MobileEventBroker({
    machine: options.machine,
    server_build: options.server_build,
    source: options.authoritative ? 'authoritative' : 'mirror',
    ...options.eventOptions,
  });
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const applyCors = (request: IncomingMessage, response: ServerResponse): boolean => {
    const origin = request.headers.origin;
    response.setHeader('Vary', 'Origin');
    if (typeof origin !== 'string' || !origins.has(origin)) return false;
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AWB-Mobile-Envelope, Last-Event-ID');
    response.setHeader('Access-Control-Max-Age', '600');
    return true;
  };

  const apiHeaders = (response: ServerResponse): void => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  };

  const jsonSenden = (request: IncomingMessage, response: ServerResponse, text: string): void => {
    inhaltSenden(request, response, text, 'application/json', false);
  };

  const erfolgSenden = (request: IncomingMessage, response: ServerResponse, id: string, ergebnis: JournalErgebnis): void => {
    apiHeaders(response);
    response.statusCode = ergebnis.status;
    jsonSenden(request, response, JSON.stringify({
      api_version: MOBILE_API_VERSION, server_build: options.server_build, machine: options.machine,
      authoritative: options.authoritative, request_id: id, data: istJournalFehler(ergebnis) ? null : ergebnis.data,
    }));
  };

  const sendFailure = (request: IncomingMessage, response: ServerResponse, failure: HttpFailure | MobileAuthError, id: string): void => {
    const code = failure instanceof HttpFailure ? failure.code : failure.code;
    const status = failure instanceof HttpFailure ? failure.status : statusFor(code);
    apiHeaders(response);
    response.statusCode = status;
    jsonSenden(request, response, JSON.stringify({
      api_version: MOBILE_API_VERSION,
      server_build: options.server_build,
      machine: options.machine,
      authoritative: options.authoritative,
      request_id: id,
      error: {
        code,
        message: code === 'state_locked' ? failure.message : safeMessage(code),
        retryable: code === 'internal_error' || code === 'rate_limited' || code === 'state_locked',
      },
    }));
  };

  const serveStatic = async (request: IncomingMessage, response: ServerResponse, target: ParsedRequestTarget): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${[...origins].join(' ')}; form-action 'none'`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.end();
      return;
    }
    const shell = await options.staticShell?.(target.canonicalPath);
    if (!shell) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', shell.contentType);
    inhaltSenden(request, response, shell.body, shell.contentType, true);
  };

  const serveEvents = (request: IncomingMessage, response: ServerResponse): void => {
    const last = request.headers['last-event-id'];
    if (last !== undefined && (typeof last !== 'string' || last.length > 256)) throw new HttpFailure(400, 'bad_request', safeMessage('bad_request'));
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const write = (event: ReturnType<MobileEventBroker['publish']>, name: string = event.type): void => {
      response.write(`id: ${event.id}\nevent: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const replay = events.replay(last);
    if (replay.reset) write(events.resetEvent(), 'reset');
    else for (const event of replay.events) write(event);
    const unsubscribe = events.subscribe((event) => write(event));
    const cleanup = (): void => {
      unsubscribe();
    };
    request.once('close', cleanup);
    response.once('close', cleanup);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let envelope: SignedRequestEnvelope | undefined;
    try {
      const target = parseTarget(request.url);
      if (!target.canonicalPath.startsWith(`${MOBILE_API_PREFIX}/`) && target.canonicalPath !== MOBILE_API_PREFIX) {
        await serveStatic(request, response, target);
        return;
      }
      const corsAllowed = applyCors(request, response);
      if (request.method === 'OPTIONS') {
        response.statusCode = corsAllowed ? 204 : 403;
        response.end();
        return;
      }
      const matched = route(request.method ?? '', target.canonicalPath);
      if (!matched) throw new HttpFailure(404, 'not_found', safeMessage('not_found'));
      const rawBody = await readBody(request, maximum);
      if (matched.route === 'POST /pairings/complete') {
        const handler = options.handlers?.[matched.route];
        if (!handler) throw new HttpFailure(501, 'capability_unavailable', safeMessage('capability_unavailable'));
        const login = request.headers['tailscale-user-login'];
        const result = await handler({ route: matched.route, params: matched.params, query: target.queryMap, body: parseJsonBody(rawBody), rawBody,
          ...(typeof login === 'string' && login.length <= 256 ? { identity: login } : {}) });
        apiHeaders(response);
        response.statusCode = result.status ?? 200;
        jsonSenden(request, response, JSON.stringify({ api_version: MOBILE_API_VERSION, server_build: options.server_build, machine: options.machine,
          authoritative: options.authoritative, request_id: requestId(), data: result.data ?? null }));
        return;
      }
      envelope = parseEnvelope(request.headers[ENVELOPE_HEADER]);
      assertEnvelopeBindsRequest(envelope, request.method ?? '', target);
      const journal = journalPflichtig(request.method ?? '');
      // `paneWriteRoute` liest dafuer den frischen Sitzungsstand des Kerns
      // (`modellLesen()`), und das ist teuer. Vor dieser Auskunft steht deshalb
      // die vollstaendige, nebenwirkungsfreie Signaturpruefung (Sicherheits-
      // Review 2026-09-21): sonst loeste eine Anfrage OHNE gueltige Signatur
      // diese Arbeit aus, und ungeprueftes Eingabematerial entschiede mit,
      // welcher Prozess den Umschlag verbraucht. Die reservierende Pruefung
      // unten bleibt davon unberuehrt.
      const vielleichtPaneWrite = VIELLEICHT_PANE_WRITE.has(matched.route);
      if (vielleichtPaneWrite) options.authenticator.verify(envelope, { audience, body: rawBody });
      const fremdVerbraucht = PANE_WRITE_ROUTES.has(matched.route)
        || (vielleichtPaneWrite
          && (await options.paneWriteRoute?.(matched.route as RouteName, { params: matched.params, rawBody })) === true);
      if (fremdVerbraucht) {
        const handler = options.handlers?.[matched.route as RouteName];
        if (!handler) throw new HttpFailure(501, 'capability_unavailable', safeMessage('capability_unavailable'));
        // Der Server prueft vollstaendig, reserviert aber nicht: `wb-mobil-pruefen`
        // beansprucht denselben Umschlag gleich selbst atomar. Das Ergebnis gehoert
        // trotzdem ins Journal, sonst liefe eine Netz-Wiederholung ein zweites Mal.
        const device = mobilanfrageBelegen(options.authenticator.verify(envelope, { audience, body: rawBody }));
        let ergebnis: JournalErgebnis;
        try {
          const result = await handler({ route: matched.route as RouteName, params: matched.params, query: target.queryMap,
            body: parseJsonBody(rawBody), rawBody, device, envelope });
          ergebnis = { status: result.status ?? 200, data: result.data ?? null };
        } catch (error) {
          if (journal && !(error instanceof MobileReplayedResult)) {
            options.authenticator.journalNachtragen(device, audience, fehlerErgebnis(error));
          }
          throw error;
        }
        if (journal) options.authenticator.journalNachtragen(device, audience, ergebnis);
        erfolgSenden(request, response, envelope.request_id, ergebnis);
        return;
      }
      const device = mobilanfrageBelegen(options.authenticator.verifyAndReserve(envelope, { audience, body: rawBody }));
      try {
        if (matched.route === 'GET /events') {
          options.authenticator.consume(device, audience);
          serveEvents(request, response);
          return;
        }
        const handler = options.handlers?.[matched.route];
        if (!handler) throw new HttpFailure(501, 'capability_unavailable', safeMessage('capability_unavailable'));
        const result = await handler({ route: matched.route, params: matched.params, query: target.queryMap, body: parseJsonBody(rawBody), rawBody, device, envelope });
        const ergebnis: JournalErgebnis = { status: result.status ?? 200, data: result.data ?? null };
        // Verbrauch und Ergebnis in EINEM Zustandsschritt (Spezifikation 3.2/4.2).
        options.authenticator.consume(device, audience, journal ? ergebnis : undefined);
        erfolgSenden(request, response, envelope.request_id, ergebnis);
      } catch (error) {
        options.authenticator.fail(device, audience, journal ? fehlerErgebnis(error) : undefined);
        throw error;
      }
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      // Die zulaessige Wiederholung derselben `request_id`: das gespeicherte
      // Ergebnis, nicht `nonce_replayed` und keine zweite Ausfuehrung.
      if (error instanceof MobileReplayedResult) {
        if (istJournalFehler(error.result)) sendFailure(request, response, new HttpFailure(error.result.status, error.result.code, safeMessage(error.result.code)), requestId(envelope));
        else erfolgSenden(request, response, requestId(envelope), error.result);
        return;
      }
      if (error instanceof HttpFailure || error instanceof MobileAuthError) {
        sendFailure(request, response, error, requestId(envelope));
        return;
      }
      sendFailure(request, response, new HttpFailure(500, 'internal_error', safeMessage('internal_error')), requestId(envelope));
    }
  };

  return {
    events,
    async start(): Promise<{ port: number }> {
      if (server) throw new Error('mobile HTTP server is already started');
      server = createServer((request, response) => { void handle(request, response); });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen({ host: '127.0.0.1', port: options.port }, () => resolve());
      });
      heartbeatTimer = setInterval(() => events.publish('heartbeat'), heartbeat);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mobile HTTP server did not receive a TCP port');
      return { port: address.port };
    },
    async stop(): Promise<void> {
      const active = server;
      if (!active) return;
      server = undefined;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    },
  };
}
