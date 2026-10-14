import type { QueryParameter, RequestEnvelope } from './vertrag';

/** Der Text ist zugleich das signierte Format und seine Versionsmarke. */
export const SIGNATURE_TEXT_FORMAT = 'awb-mobile-request-v1';

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Stringvergleich nach JavaScript-UTF-16-Codeeinheiten, nicht nach Prozess-Locale. */
function canonicalStringOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Pfade werden vor der Signatur eindeutig und ohne Traversal dargestellt. */
export function canonicalPath(path: string): string {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new CanonicalizationError('path must be an absolute path without query or fragment');
  }
  if (path === '/') return path;
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new CanonicalizationError('path must not contain empty segments');
  }
  return `/${segments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new CanonicalizationError('path contains invalid percent encoding');
    }
    if (decoded === '.' || decoded === '..') {
      throw new CanonicalizationError('path traversal is not canonical');
    }
    return percentEncode(decoded);
  }).join('/')}`;
}

/**
 * Querywerte werden als Daten behandelt: Plus bleibt ein Plus, nie ein Leerraum.
 * Die Reihenfolge ist Name, dann Wert; gleiche Paare bleiben stabil geordnet.
 */
export function canonicalQuery(query: readonly QueryParameter[]): string {
  return query
    .map((parameter, index) => ({ ...parameter, index }))
    .sort((left, right) => canonicalStringOrder(left.name, right.name)
      || canonicalStringOrder(left.value, right.value) || left.index - right.index)
    .map(({ name, value }) => `${percentEncode(name)}=${percentEncode(value)}`)
    .join('&');
}

/** Die Ziel-Origin ist absichtlich vollstaendig; ein Pfad waere keine Audience. */
export function canonicalAudience(audience: string): string {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(audience)) {
    throw new CanonicalizationError('audience must be an exact https origin');
  }
  return audience.toLowerCase();
}

function requiredText(value: string, name: string): string {
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new CanonicalizationError(`${name} must be a non-empty single line`);
  }
  return value;
}

/**
 * Der getrennte, zeilenbasierte Text vermeidet JSON-Serialisierer-Differenzen.
 * Die Spezifikation nennt die gebundenen Felder, aber keine Byteform; dieser
 * v1-Text ist daher hier zentral versioniert und darf nur zusammen geändert werden.
 */
export function canonicalSignatureText(envelope: RequestEnvelope): string {
  if (!Number.isSafeInteger(envelope.counter) || envelope.counter < 0) {
    throw new CanonicalizationError('counter must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(envelope.issued_at) || envelope.issued_at < 0) {
    throw new CanonicalizationError('issued_at must be a non-negative safe integer');
  }
  if (!/^[a-f0-9]{64}$/.test(envelope.body_sha256)) {
    throw new CanonicalizationError('body_sha256 must be lowercase SHA-256 hex');
  }
  const method = requiredText(envelope.method, 'method').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new CanonicalizationError('method must be an HTTP token');
  const query = canonicalQuery(envelope.query);
  return [
    SIGNATURE_TEXT_FORMAT,
    `version:${requiredText(envelope.version, 'version')}`,
    `device_id:${requiredText(envelope.device_id, 'device_id')}`,
    `key_id:${requiredText(envelope.key_id, 'key_id')}`,
    `audience:${canonicalAudience(envelope.audience)}`,
    `method:${method}`,
    `path:${canonicalPath(envelope.path)}`,
    `query:${query}`,
    `body_sha256:${envelope.body_sha256}`,
    `nonce:${requiredText(envelope.nonce, 'nonce')}`,
    `counter:${envelope.counter}`,
    `issued_at:${envelope.issued_at}`,
    `request_id:${requiredText(envelope.request_id, 'request_id')}`,
  ].join('\n');
}

/**
 * Stabil nach Schluesseln sortiertes JSON, nur aus Daten (Paket 2). Browser und
 * Kern bilden daraus dieselben Bytes.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  throw new CanonicalizationError('pairing proof contains an unsupported value');
}

/**
 * Der Text, dessen SHA-256 `body_sha256` des Pairing-Umschlags ist
 * (`pairingProofBodySha256()` in main/mobile/auth/auth.ts). Die PWA hasht genau
 * diese UTF-8-Bytes mit WebCrypto; eine zweite Fassung gibt es nicht.
 */
export function pairingProofBodyText(completion: { public_jwk: unknown; device_name: string; pairing_code: string }): string {
  return stableJson({
    device_name: completion.device_name,
    pairing_code: completion.pairing_code,
    public_jwk: completion.public_jwk,
  });
}
