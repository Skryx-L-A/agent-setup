import { ALLOWED_SPECIAL_KEYS, MAX_MOBILE_KEY_SEQUENCE, MOBILE_API_VERSION, MOBILE_ERROR_CODES, TICKET_APPROVE_REASONS } from './vertrag';
import type {
  AgentAction, ApiFailure, ApiResponse, ApiSuccess, CompatibilityResult, ContractVersion, JsonObject,
  JsonValue, MobileApiErrorCode, NotifyBody, PairingCompleteBody, PaneBinding, RequestEnvelope, SendKeyBody, SendMessageBody,
  SignedPromptAnswerBody, SignedSendKeyBody, SignedSendMessageBody, TicketApproveReason,
} from './vertrag';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string): ValidationResult<string> {
  return typeof value === 'string' && value.length > 0
    ? { ok: true, value }
    : { ok: false, error: `${name} must be a non-empty string` };
}

function jsonObject(value: unknown, name: string): ValidationResult<JsonObject> {
  return object(value) ? { ok: true, value: value as JsonObject } : { ok: false, error: `${name} must be an object` };
}

export function validateRequestEnvelope(value: unknown): ValidationResult<RequestEnvelope> {
  if (!object(value)) return { ok: false, error: 'envelope must be an object' };
  const fields = ['version', 'device_id', 'key_id', 'audience', 'method', 'path', 'body_sha256', 'nonce', 'request_id'] as const;
  for (const field of fields) {
    if (!text(value[field], field).ok) return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (!Array.isArray(value.query) || !value.query.every((item) => object(item)
    && typeof item.name === 'string' && typeof item.value === 'string')) {
    return { ok: false, error: 'query must be an array of name/value pairs' };
  }
  if (!Number.isSafeInteger(value.counter) || (value.counter as number) < 0) {
    return { ok: false, error: 'counter must be a non-negative safe integer' };
  }
  if (!Number.isSafeInteger(value.issued_at) || (value.issued_at as number) < 0) {
    return { ok: false, error: 'issued_at must be a non-negative safe integer' };
  }
  return { ok: true, value: value as unknown as RequestEnvelope };
}

export function validatePairingCompleteBody(value: unknown): ValidationResult<PairingCompleteBody> {
  if (!object(value)) return { ok: false, error: 'pairing body must be an object' };
  const publicJwk = jsonObject(value.public_jwk, 'public_jwk');
  const deviceName = text(value.device_name, 'device_name');
  const pairingCode = text(value.pairing_code, 'pairing_code');
  if (!publicJwk.ok) return publicJwk;
  if (!deviceName.ok) return deviceName;
  if (!pairingCode.ok || !/^\d{6}$/.test(pairingCode.value)) {
    return { ok: false, error: 'pairing_code must be six digits' };
  }
  if (!object(value.proof) || typeof value.proof.signature !== 'string') {
    return { ok: false, error: 'proof must contain a signature' };
  }
  const envelope = validateRequestEnvelope(value.proof);
  if (!envelope.ok) return envelope;
  return { ok: true, value: value as unknown as PairingCompleteBody };
}

export function validateSendMessageBody(value: unknown): ValidationResult<SendMessageBody> {
  if (!object(value) || typeof value.text !== 'string' || value.text.length === 0) {
    return { ok: false, error: 'text must be a non-empty string' };
  }
  return { ok: true, value: { text: value.text } };
}

export function validateSendKeyBody(value: unknown): ValidationResult<SendKeyBody> {
  if (!object(value) || !ALLOWED_SPECIAL_KEYS.includes(value.key as SendKeyBody['key'])) {
    return { ok: false, error: 'key is not in the mobile key whitelist' };
  }
  return { ok: true, value: { key: value.key as SendKeyBody['key'] } };
}

/** Tmux-Pane-Kennung wie `wb-pane-write` sie annimmt: `%0`, `%12`, … */
export const PANE_ID_PATTERN = /^%(0|[1-9][0-9]*)$/;
/** Dieselbe Obergrenze wie `wb-pane-write mobil-senden` (512 KiB Text). */
export const MAX_MOBILE_TEXT_BYTES = 512 * 1024;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function binding(value: Record<string, unknown>): ValidationResult<PaneBinding> {
  if (typeof value.maschine !== 'string' || !/^[^\s/]{1,255}$/.test(value.maschine)) return { ok: false, error: 'maschine must be a host name part' };
  if (typeof value.socket !== 'string' || !value.socket.startsWith('/') || /[\r\n\0]/.test(value.socket)) {
    return { ok: false, error: 'socket must be the literal tmux socket_path' };
  }
  if (typeof value.pane !== 'string' || !PANE_ID_PATTERN.test(value.pane)) return { ok: false, error: 'pane must be a tmux pane id' };
  return { ok: true, value: { maschine: value.maschine, socket: value.socket, pane: value.pane } };
}

/** Standard-Base64 mit Auffuellung, genau so, wie Paket 2 und 3 es streng lesen. */
export function strictBase64Pattern(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && value.length > 0;
}

/** v1.2: der Body von `POST /sessions/:id/messages`, exakt die Nahtstelle von `mobil-senden`. */
export function validateSignedSendMessageBody(value: unknown): ValidationResult<SignedSendMessageBody> {
  if (!object(value) || !exactKeys(value, ['aktion', 'maschine', 'pane', 'socket', 'text_b64']) || value.aktion !== 'mobil-senden') {
    return { ok: false, error: 'message body must be {aktion:"mobil-senden",maschine,socket,pane,text_b64}' };
  }
  const bound = binding(value);
  if (!bound.ok) return bound;
  if (typeof value.text_b64 !== 'string' || !strictBase64Pattern(value.text_b64)
    || value.text_b64.length > Math.ceil(MAX_MOBILE_TEXT_BYTES / 3) * 4) {
    return { ok: false, error: 'text_b64 must be strict base64 of at most 512 KiB' };
  }
  return { ok: true, value: { aktion: 'mobil-senden', ...bound.value, text_b64: value.text_b64 } };
}

/** v1.2: der Body von `POST /sessions/:id/keys`; genau eine erlaubte Sondertaste. */
export function validateSignedSendKeyBody(value: unknown): ValidationResult<SignedSendKeyBody> {
  if (!object(value) || !exactKeys(value, ['aktion', 'maschine', 'pane', 'socket', 'tasten']) || value.aktion !== 'mobil-taste') {
    return { ok: false, error: 'key body must be {aktion:"mobil-taste",maschine,socket,pane,tasten}' };
  }
  const bound = binding(value);
  if (!bound.ok) return bound;
  if (!Array.isArray(value.tasten) || value.tasten.length !== 1
    || !ALLOWED_SPECIAL_KEYS.includes(value.tasten[0] as SendKeyBody['key'])) {
    return { ok: false, error: 'tasten must hold exactly one whitelisted key' };
  }
  return { ok: true, value: { aktion: 'mobil-taste', ...bound.value, tasten: [value.tasten[0] as SendKeyBody['key']] } };
}

/**
 * v1.3: der signierte Body einer Promptantwort ueber Pane-Tasten. Er hat exakt
 * die Schluessel, die `wb-mobil-pruefen` fuer `mobil-taste` verlangt; hier steht
 * nur die Folge statt einer einzelnen Taste (1 bis 64, alle aus der Whitelist).
 */
export function validateSignedPromptAnswerBody(value: unknown): ValidationResult<SignedPromptAnswerBody> {
  if (!object(value) || !exactKeys(value, ['aktion', 'maschine', 'pane', 'socket', 'tasten']) || value.aktion !== 'mobil-taste') {
    return { ok: false, error: 'prompt answer body must be {aktion:"mobil-taste",maschine,socket,pane,tasten}' };
  }
  const bound = binding(value);
  if (!bound.ok) return bound;
  if (!Array.isArray(value.tasten) || value.tasten.length < 1 || value.tasten.length > MAX_MOBILE_KEY_SEQUENCE
    || !value.tasten.every((key) => ALLOWED_SPECIAL_KEYS.includes(key as SendKeyBody['key']))) {
    return { ok: false, error: `tasten must hold 1 to ${MAX_MOBILE_KEY_SEQUENCE} whitelisted keys` };
  }
  return { ok: true, value: { aktion: 'mobil-taste', ...bound.value, tasten: [...value.tasten] as SendKeyBody['key'][] } };
}

export function validatePromptAnswerBody(value: unknown): ValidationResult<{ fingerprint: string; option_id: string; text?: string }> {
  if (!object(value) || !text(value.fingerprint, 'fingerprint').ok || !text(value.option_id, 'option_id').ok) {
    return { ok: false, error: 'fingerprint and option_id must be non-empty strings' };
  }
  if (value.text !== undefined && typeof value.text !== 'string') return { ok: false, error: 'text must be a string when present' };
  return { ok: true, value: value as { fingerprint: string; option_id: string; text?: string } };
}

export function validateDecisionBody(value: unknown): ValidationResult<{ decision: 'approve' | 'reject'; reason: string }> {
  if (!object(value) || (value.decision !== 'approve' && value.decision !== 'reject') || typeof value.reason !== 'string') {
    return { ok: false, error: 'decision must be approve/reject and reason must be a string' };
  }
  return { ok: true, value: { decision: value.decision, reason: value.reason } };
}

export function validateCreateSessionBody(value: unknown): ValidationResult<{ directory: string; name: string; machine: string; harness: string; model: string }> {
  if (!object(value)) return { ok: false, error: 'session body must be an object' };
  const fields = ['directory', 'name', 'machine', 'harness', 'model'] as const;
  for (const field of fields) if (!text(value[field], field).ok) return { ok: false, error: `${field} must be a non-empty string` };
  if (!(value.directory as string).startsWith('/')) return { ok: false, error: 'directory must be an absolute path' };
  return { ok: true, value: value as { directory: string; name: string; machine: string; harness: string; model: string } };
}

export function validatePushSubscriptionBody(value: unknown): ValidationResult<{ subscription: JsonObject }> {
  if (!object(value)) return { ok: false, error: 'push body must be an object' };
  const subscription = jsonObject(value.subscription, 'subscription');
  return subscription.ok ? { ok: true, value: { subscription: subscription.value } } : subscription;
}

/** v1.8: genau ein Schluessel `active`, ein Wahrheitswert. */
export function validateNotifyBody(value: unknown): ValidationResult<NotifyBody> {
  if (!object(value) || typeof value.active !== 'boolean' || Object.keys(value).length !== 1) {
    return { ok: false, error: 'notify body must be exactly { active: boolean }' };
  }
  return { ok: true, value: { active: value.active } };
}

const AGENT_ACTION_TYPES = new Set<AgentAction['type']>([
  'message.send', 'question.answer', 'question.withdraw', 'assignment.create',
  'ticket.accept', 'ticket.redirect', 'ticket.scope', 'ticket.review', 'ticket.reject', 'ticket.return',
  'ticket.approve',
]);

export function validateAgentAction(value: unknown): ValidationResult<AgentAction> {
  if (!object(value) || typeof value.type !== 'string' || !AGENT_ACTION_TYPES.has(value.type as AgentAction['type'])) {
    return { ok: false, error: 'unknown agents action' };
  }
  const required = (...fields: string[]): ValidationResult<AgentAction> | null => {
    for (const field of fields) if (!text(value[field], field).ok) return { ok: false, error: `${field} must be a non-empty string` };
    return null;
  };
  let error: ValidationResult<AgentAction> | null = null;
  switch (value.type) {
    case 'message.send': error = required('world_id', 'text', 'recipient'); break;
    case 'question.answer': error = required('question_id', 'answer'); break;
    case 'question.withdraw': error = required('question_id'); break;
    case 'assignment.create': error = required('world_id', 'title', 'goal', 'done_when'); break;
    case 'ticket.accept': error = required('ticket_id', 'recipient'); break;
    case 'ticket.redirect': error = required('ticket_id', 'recipient', 'reason'); break;
    case 'ticket.scope': {
      error = required('ticket_id');
      if (!error && value.deadline === undefined && value.rounds === undefined) return { ok: false, error: 'ticket.scope needs deadline or rounds' };
      if (!error && value.deadline !== undefined && !text(value.deadline, 'deadline').ok) return { ok: false, error: 'deadline must be a non-empty string' };
      if (!error && value.rounds !== undefined && (!Number.isInteger(value.rounds) || (value.rounds as number) < 1)) return { ok: false, error: 'rounds must be a positive integer' };
      break;
    }
    case 'ticket.review': error = required('ticket_id', 'reviewer'); break;
    case 'ticket.reject': {
      error = required('ticket_id', 'reason');
      if (error) break;
      if (value.duplicate_of !== undefined && !text(value.duplicate_of, 'duplicate_of').ok) {
        return { ok: false, error: 'duplicate_of must be a non-empty string when present' };
      }
      // Der Kern lehnt „duplikat“ ohne das andere Ticket ab; ohne diese Zusage
      // liefe die Rueckfrage erst im Werkzeug auf, nach der Bestaetigung.
      if (value.reason === 'duplikat' && !text(value.duplicate_of, 'duplicate_of').ok) {
        return { ok: false, error: 'duplicate_of must be a non-empty string when reason is duplikat' };
      }
      if (value.note !== undefined && typeof value.note !== 'string') return { ok: false, error: 'note must be a string when present' };
      break;
    }
    case 'ticket.return': error = required('ticket_id', 'reason'); break;
    case 'ticket.approve': {
      error = required('ticket_id');
      if (error) break;
      if (!TICKET_APPROVE_REASONS.includes(value.reason as TicketApproveReason)) {
        return { ok: false, error: `reason must be one of ${TICKET_APPROVE_REASONS.join(', ')}` };
      }
      if (value.note !== undefined && typeof value.note !== 'string') return { ok: false, error: 'note must be a string when present' };
      // Der Kern verlangt bei „teilweise“ eine Bemerkung; ohne sie faende die
      // Abnahme im Werkzeug statt, nicht hier -- und sie ist endgueltig.
      if (value.reason === 'teilweise' && !text(value.note, 'note').ok) {
        return { ok: false, error: 'note must be a non-empty string when reason is teilweise' };
      }
      if (value.dod_confirmed !== undefined && typeof value.dod_confirmed !== 'boolean') {
        return { ok: false, error: 'dod_confirmed must be a boolean when present' };
      }
      break;
    }
  }
  if (error) return error;
  // Der Kern validiert Ticketstatus, Adressaten und die restliche Fachgrammatik
  // erneut; hier werden nur die geschlossene Aktionsmenge und die v1.1-Felder
  // vor dem Adapter erzwungen.
  return { ok: true, value: value as AgentAction };
}

export function validateApiResponse(value: unknown): ValidationResult<ApiResponse<JsonValue>> {
  if (!object(value)) return { ok: false, error: 'response must be an object' };
  const meta = ['api_version', 'server_build', 'machine', 'request_id'] as const;
  for (const field of meta) if (typeof value[field] !== 'string') return { ok: false, error: `${field} must be a string` };
  if (typeof value.authoritative !== 'boolean') return { ok: false, error: 'authoritative must be boolean' };
  const hasData = Object.prototype.hasOwnProperty.call(value, 'data');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasData === hasError) return { ok: false, error: 'response must contain exactly data or error' };
  if (hasError && (!object(value.error) || !MOBILE_ERROR_CODES.includes(value.error.code as MobileApiErrorCode)
    || typeof value.error.message !== 'string' || typeof value.error.retryable !== 'boolean')) {
    return { ok: false, error: 'error is malformed' };
  }
  return { ok: true, value: value as unknown as ApiSuccess<JsonValue> | ApiFailure };
}

/** Versionsregeln aus Abschnitt 10 Punkt 12. */
export function compatibilityFor(client: ContractVersion, server: ContractVersion): CompatibilityResult {
  if (client.api_version === server.api_version && client.build === server.build) {
    return { decision: 'compatible', mutations_allowed: true, reason: 'API version and build match' };
  }
  return {
    decision: 'read_only_update_required',
    mutations_allowed: false,
    reason: `client API/build ${client.api_version}/${client.build} does not match server ${server.api_version}/${server.build}`,
  };
}

export function currentCompatibility(server: ContractVersion, currentBuild: string): CompatibilityResult {
  return compatibilityFor({ api_version: MOBILE_API_VERSION, build: currentBuild }, server);
}
