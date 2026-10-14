import { createHash } from 'node:crypto';
import { validateSignedSendKeyBody, validateSignedSendMessageBody } from '../../../mobile-shared/validierung';
import type { ChatMessage, JsonValue, SignedRequestEnvelope } from '../../../mobile-shared/vertrag';
import { MobileAuthError } from '../auth/auth';
import type { MobileRouteHandlers, MobileRouteRequest } from '../http/server';
import type { ChatNachricht, ChatStand } from '../../../chat/typen';
import type { MobileSessionRecord } from './sessions';

export interface MobilePaneWriteResult {
  readonly status: number | null;
  readonly stdout: string;
  /** stderr von `wb-pane-write`; bei NICHT FREI steht dort der Grund. Nur die Kategorie daraus wird protokolliert. */
  readonly stderr?: string;
}

export interface MobilePaneWriteCall {
  readonly socketName: string;
  readonly command: 'mobil-senden' | 'mobil-taste';
  readonly pane: string;
  /** Exact stdin contract of shell/wb-pane-write: {umschlag,body_b64}. */
  readonly stdin: Buffer;
}

/**
 * Paket 10 supplies the real `anfrageFuerPane()` + `chatStand()` composition
 * from chatquelle.ts:742 and :857. A mirror intentionally has no chat source.
 */
export interface ChatForMobile {
  readonly localMachine: string;
  /** `modellLesen()` — app/src/main/main.ts:1034. */
  fresh(): Promise<readonly MobileSessionRecord[]> | readonly MobileSessionRecord[];
  /** `anfrageFuerPane()` + `chatStand()` — chatquelle.ts:742/:857. */
  chatStand(session: MobileSessionRecord): Promise<ChatStand | null>;
  /** Complete verified HTTP envelope (`MobileRouteRequest.envelope`). */
  envelope(request: MobileRouteRequest): SignedRequestEnvelope | null;
  /** Runs only `wb-pane-write -L <socket> mobil-senden|mobil-taste %<n>`. */
  paneWrite(call: MobilePaneWriteCall): Promise<MobilePaneWriteResult>;
  /** Protokollzeile des Kerns (stderr). Eine Zeile je abgelehnter Anfrage; nie Nachrichtentext. */
  readonly protokoll?: (zeile: string) => void;
  /** Socket name from config.tmuxSocket, never a browser-controlled value. */
  socketName(): string;
  /** Orchestrator pane resolved freshly from the session model. */
  orchestratorPane(session: MobileSessionRecord): string;
  /** `werkzeugTeile()` aus `chat/leser.ts`; nie aus dem Anzeigetext geparst. */
  tool(message: ChatNachricht): { readonly name: string; readonly arguments_preview: string; readonly output_preview: string } | undefined;
}

function fail(code: 'bad_request' | 'stale_target' | 'capability_unavailable' | 'internal_error', message: string): never {
  throw new MobileAuthError(code, message);
}

async function localSession(source: ChatForMobile, id: string): Promise<MobileSessionRecord> {
  const matches = (await source.fresh()).filter((session) => session.id === id);
  if (matches.length !== 1) fail('stale_target', 'session is no longer current');
  if (matches[0].machine !== source.localMachine) fail('capability_unavailable', 'mirrored sessions do not expose chat or input');
  return matches[0];
}

function role(message: ChatNachricht): ChatMessage['role'] {
  if (message.rolle === 'mensch') return 'human';
  if (message.rolle === 'werkzeug') return 'tool';
  return message.rolle;
}

/**
 * Eine ID, die dieselbe Nachricht ueber Abrufe behaelt: Zeit, Rolle und ein
 * Hash des Textes, bei Gleichstand eine laufende Nummer in Verlaufsreihenfolge.
 * Der Index im 200er-Fenster taugt nicht -- er verschiebt sich mit jeder neuen
 * Nachricht, und die Ansicht baut dann den ganzen Verlauf neu.
 */
export function chatMessageIds(paneId: string, nachrichten: readonly ChatNachricht[]): string[] {
  const gesehen = new Map<string, number>();
  return nachrichten.map((message) => {
    const hash = createHash('sha256').update(`${message.rolle}\0${message.text}`).digest('hex').slice(0, 16);
    const basis = `${paneId}:${message.zeit}:${hash}`;
    const n = gesehen.get(basis) ?? 0;
    gesehen.set(basis, n + 1);
    return n ? `${basis}:${n}` : basis;
  });
}

function messages(stand: ChatStand, source: ChatForMobile): ChatMessage[] {
  const ids = chatMessageIds(stand.paneId, stand.nachrichten);
  return stand.nachrichten.map((message, index) => {
    const mapped: ChatMessage = {
      id: ids[index],
      role: role(message),
      text: message.text,
      created_at: message.zeit,
    };
    // Paket 10: `chat/leser.ts` reicht die Werkzeugteile als `werkzeug` mit;
    // die Bruecke gibt sie hier her. Fehlen sie, bleibt nur der v1-Text.
    if (mapped.role === 'tool') {
      const structured = source.tool(message);
      if (structured) mapped.tool = structured;
    }
    return mapped;
  });
}

function stdin(envelope: SignedRequestEnvelope, body: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ umschlag: envelope, body_b64: body.toString('base64') }), 'utf8');
}

/**
 * Eine Protokollzeile je abgelehnter Anfrage: `<Code> fuer Sitzung <id> (Pane <p>): <Grund>`.
 * Der Grund ist eine feste Kategorie, nie Nachrichtentext oder Pane-Inhalt (Datenschutz).
 */
export function mobilAblehnung(protokoll: ((zeile: string) => void) | undefined, sitzung: string, pane: string, code: string, grund: string): void {
  protokoll?.(`${code} fuer Sitzung ${sitzung} (Pane ${pane || 'keiner'}): ${grund}`);
}

/** Der Meldeweg, den `paneWriteFailure` bei Exit 77 benutzt; ohne Protokoll gibt es keinen. */
export function paneWriteMeldung(protokoll: ((zeile: string) => void) | undefined, sitzung: string, pane: string): ((code: string, grund: string) => void) | undefined {
  if (!protokoll) return undefined;
  return (code, grund) => mobilAblehnung(protokoll, sitzung, pane, code, `wb-pane-write – ${grund}`);
}

/**
 * Die Kategorie des Grundes aus dem stderr von `wb-pane-write`
 * (`wb-pane-write: NICHT FREI — <aktion> auf Pane <p>: <grund>. Nichts getippt.`):
 * nur das vor dem ersten Doppelpunkt des Grundes. Was danach steht, kann Pane-Text
 * tragen und bleibt draussen.
 */
export function paneWriteKategorie(stderr: string | undefined): string {
  const zeile = (stderr ?? '').split('\n').find((z) => z.includes('NICHT FREI'));
  const treffer = zeile ? /auf Pane \S+?: (.+?)\. Nichts getippt\.$/.exec(zeile.trim()) : null;
  const kategorie = treffer ? treffer[1].split(':')[0].trim() : '';
  return kategorie !== '' ? kategorie.slice(0, 80) : 'unbekannter Grund';
}

/**
 * Der Exitcode von `wb-pane-write` als Vertragsfehler -- dieselbe Lesart fuer Nachricht, Taste und Promptantwort.
 * Bei Exit 77 meldet `melde` den Vertragscode und die Kategorie des Grundes, bevor der Fehler fliegt.
 */
export function paneWriteFailure(result: MobilePaneWriteResult, melde?: (code: string, grund: string) => void): never {
  if (result.status === 77) {
    let code: string | undefined;
    try {
      const value = JSON.parse(result.stdout) as { ok?: unknown; code?: unknown };
      if (value.ok === false && typeof value.code === 'string') code = value.code;
    } catch {
      code = undefined;
    }
    if (code === undefined) fail('internal_error', 'wb-pane-write rejected with an invalid error response');
    melde?.(code, paneWriteKategorie(result.stderr));
    throw new MobileAuthError(code as never, `wb-pane-write rejected mobile action: ${code}`);
  }
  if (result.status === 2) fail('bad_request', 'wb-pane-write rejected mobile input');
  if (result.status === 1) fail('internal_error', 'wb-pane-write could not complete the verified action');
  fail('internal_error', 'wb-pane-write returned an unexpected exit status');
}

async function write(source: ChatForMobile, request: MobileRouteRequest, command: MobilePaneWriteCall['command'], boundPane: string): Promise<void> {
  const session = await localSession(source, request.params.id);
  const pane = source.orchestratorPane(session);
  if (!/^%[0-9]+$/.test(pane)) {
    mobilAblehnung(source.protokoll, request.params.id, pane, 'stale_target', 'kein Orchestrator-Pane mehr');
    fail('stale_target', 'session no longer has an orchestrator pane');
  }
  // Die Bindung im signierten Body muss auf den JETZIGEN Orchestrator zeigen.
  // `wb-pane-write` prueft Maschine, Socket und Pane selbst noch einmal; hier
  // faellt ein veraltetes Ziel nur frueher und ohne Verbrauch auf.
  if (boundPane !== pane) {
    mobilAblehnung(source.protokoll, request.params.id, pane, 'stale_target', 'Bindung nicht am jetzigen Orchestrator-Pane');
    fail('stale_target', 'signed pane binding does not match the current orchestrator pane');
  }
  const envelope = source.envelope(request);
  if (!envelope) fail('capability_unavailable', 'the HTTP handler did not retain the signed mobile envelope');
  const result = await source.paneWrite({ socketName: source.socketName(), command, pane, stdin: stdin(envelope, request.rawBody) });
  if (result.status !== 0) paneWriteFailure(result, paneWriteMeldung(source.protokoll, request.params.id, pane));
}

export function createChatHandlers(source: ChatForMobile): Pick<MobileRouteHandlers,
  'GET /sessions/:id/chat' | 'POST /sessions/:id/messages' | 'POST /sessions/:id/keys' | 'GET /sessions/:id/prompt' | 'POST /sessions/:id/prompt-answer'> {
  return {
    'GET /sessions/:id/chat': async (request) => {
      const session = await localSession(source, request.params.id);
      const stand = await source.chatStand(session);
      if (!stand || !stand.moeglich) fail('capability_unavailable', stand?.grund || 'chat source is unavailable');
      const cursorText = request.query.cursor?.[0] ?? '0';
      if (!/^(0|[1-9][0-9]*)$/.test(cursorText)) fail('bad_request', 'cursor must be an unsigned decimal offset');
      const cursor = Number(cursorText);
      const all = messages(stand, source);
      if (!Number.isSafeInteger(cursor) || cursor > all.length) fail('stale_target', 'chat cursor is no longer current');
      return { data: { messages: all.slice(cursor, cursor + 200), cursor: String(all.length) } as unknown as JsonValue };
    },
    'POST /sessions/:id/messages': async (request) => {
      const body = validateSignedSendMessageBody(request.body);
      if (!body.ok) fail('bad_request', body.error);
      await write(source, request, 'mobil-senden', body.value.pane);
      return { data: { message_id: request.device?.request_id ?? '', accepted_at: Date.now() } as unknown as JsonValue };
    },
    'POST /sessions/:id/keys': async (request) => {
      const body = validateSignedSendKeyBody(request.body);
      if (!body.ok) fail('bad_request', body.error);
      await write(source, request, 'mobil-taste', body.value.pane);
      return { data: { accepted_at: Date.now() } as unknown as JsonValue };
    },
    // Paket 6 owns measured dialog fixtures. These routes remain visibly closed.
    'GET /sessions/:id/prompt': () => fail('capability_unavailable', 'no measured mobile dialog adapter is available'),
    'POST /sessions/:id/prompt-answer': () => fail('capability_unavailable', 'no measured mobile dialog adapter is available'),
  };
}
