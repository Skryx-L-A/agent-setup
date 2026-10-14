import { readFileSync } from 'node:fs';
import { MobileAuthError, MobileAuthenticator } from './auth';
import { ALLOWED_SPECIAL_KEYS, MAX_MOBILE_KEY_SEQUENCE } from '../../../mobile-shared/vertrag';
import type { SignedRequestEnvelope } from '../../../mobile-shared/vertrag';

type Expected = {
  aktion: 'mobil-senden' | 'mobil-taste';
  maschine: string;
  socket: string;
  pane: string;
};

type CliInput = {
  umschlag: SignedRequestEnvelope;
  body_b64: string;
  erwartet: Expected;
};

function failure(code: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
  throw new Error('CLI_FAILURE_REPORTED');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInput(value: unknown): CliInput {
  if (!isObject(value) || !exactKeys(value, ['body_b64', 'erwartet', 'umschlag']) || !isObject(value.umschlag)
    || typeof value.body_b64 !== 'string' || !isObject(value.erwartet)) failure('bad_request');
  const expected = value.erwartet;
  if (!exactKeys(expected, ['aktion', 'maschine', 'pane', 'socket']) || (expected.aktion !== 'mobil-senden' && expected.aktion !== 'mobil-taste')
    || typeof expected.maschine !== 'string' || !expected.maschine || typeof expected.socket !== 'string' || !expected.socket
    || typeof expected.pane !== 'string' || !/^%(0|[1-9][0-9]*)$/.test(expected.pane)) failure('bad_request');
  return { umschlag: value.umschlag as unknown as SignedRequestEnvelope, body_b64: value.body_b64, erwartet: expected as Expected };
}

function strictBase64(value: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function bindBody(body: Buffer, expected: Expected): { text_b64?: string; tasten?: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    failure('bad_request');
  }
  if (!isObject(parsed) || parsed.aktion !== expected.aktion || parsed.maschine !== expected.maschine
    || parsed.socket !== expected.socket || parsed.pane !== expected.pane) failure('stale_target');
  if (expected.aktion === 'mobil-senden') {
    if (!exactKeys(parsed, ['aktion', 'maschine', 'pane', 'socket', 'text_b64']) || typeof parsed.text_b64 !== 'string') failure('bad_request');
    const text = strictBase64(parsed.text_b64);
    if (!text || text.length === 0) failure('bad_request');
    return { text_b64: parsed.text_b64 };
  }
  // Die Obergrenze gehoert HIERHER und nicht nur in den Aufrufer (Sicherheits-
  // Review 2026-09-21): das Pruefprogramm ist die massgebliche Pruefung, und
  // ohne sie bestaetigte es eine beliebig lange Tastenfolge -- gemessen 500
  // Tasten in einem `mobil-taste`. Dieselbe Grenze wie Vertrag und `wb-pane-write`.
  if (!exactKeys(parsed, ['aktion', 'maschine', 'pane', 'socket', 'tasten']) || !Array.isArray(parsed.tasten)
    || parsed.tasten.length === 0 || parsed.tasten.length > MAX_MOBILE_KEY_SEQUENCE
    || !parsed.tasten.every((key) => typeof key === 'string' && ALLOWED_SPECIAL_KEYS.includes(key as never))) failure('bad_request');
  return { tasten: [...parsed.tasten] as string[] };
}

export function main(): number {
  try {
    const raw = readFileSync(0, 'utf8');
    const input = parseInput(JSON.parse(raw));
    const body = strictBase64(input.body_b64);
    if (!body) failure('bad_request');
    const output = bindBody(body, input.erwartet);
    const authenticator = new MobileAuthenticator();
    const request = authenticator.verifyAndReserve(input.umschlag, { audience: input.umschlag.audience, body });
    try {
      authenticator.consume(request, input.umschlag.audience);
    } catch (error) {
      authenticator.fail(request, input.umschlag.audience);
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, geraet: request.device_id, request_id: request.request_id, aktion: input.erwartet.aktion, ...output })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof MobileAuthError) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error.code })}\n`);
      return 1;
    }
    if (error instanceof Error && error.message === 'CLI_FAILURE_REPORTED') return 1;
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'bad_request' })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
