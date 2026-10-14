/**
 * DAS SIGNIEREN DER PWA (Paket 10, Spezifikation 4.1 und 4.2).
 *
 * Nur WebCrypto, kein Node und kein DOM: dieselbe Datei laeuft im Browser und
 * in der Node-Probe (`globalThis.crypto.subtle`). Der private Schluessel wird
 * mit `extractable: false` erzeugt und nie exportiert; exportiert wird nur der
 * oeffentliche Teil als JWK fuer die Kopplung.
 *
 * Die Byteformen kommen ausschliesslich aus `mobile-shared`:
 *   - Signaturtext `awb-mobile-request-v1` (kanonisch.ts),
 *   - Kopplungsbeweis `pairingProofBodyText()` -- sein SHA-256 ist genau
 *     `pairingProofBodySha256()` des Kerns (Paket 2).
 */
import { canonicalPath, canonicalQuery, canonicalSignatureText, pairingProofBodyText } from '../../mobile-shared/kanonisch';
import { MOBILE_API_PREFIX, MOBILE_API_VERSION } from '../../mobile-shared/vertrag';
import type { JsonObject, QueryParameter, RequestEnvelope, SignedRequestEnvelope } from '../../mobile-shared/vertrag';

const ALGORITHMUS = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto ist nicht verfügbar (nur über HTTPS oder localhost).');
  return s;
}

function base64url(bytes: Uint8Array): string {
  let binaer = '';
  for (const b of bytes) binaer += String.fromCharCode(b);
  return btoa(binaer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Standard-Base64 mit Auffuellung (so liest `wb-mobil-pruefen` `text_b64`). */
export function base64(bytes: Uint8Array): string {
  let binaer = '';
  for (const b of bytes) binaer += String.fromCharCode(b);
  return btoa(binaer);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function zufall(bytes: number): string {
  const puffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(puffer);
  return base64url(puffer);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Eine eigene Kopie: subtle.digest verlangt einen BufferSource ohne fremden Offset.
  return hex(await subtle().digest('SHA-256', new Uint8Array(bytes)));
}

/** Ein neues Geraeteschluesselpaar; der private Teil ist nicht exportierbar. */
export async function schluesselpaarErzeugen(): Promise<{ privat: CryptoKey; oeffentlichJwk: JsonObject }> {
  const paar = await subtle().generateKey(ALGORITHMUS, false, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await subtle().exportKey('jwk', paar.publicKey);
  // Nur die Felder eines oeffentlichen P-256-Schluessels; `key_ops`/`ext` sind Browserbeiwerk.
  const oeffentlichJwk: JsonObject = { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) };
  return { privat: paar.privateKey, oeffentlichJwk };
}

export async function signieren(privat: CryptoKey, umschlag: RequestEnvelope): Promise<SignedRequestEnvelope> {
  const signatur = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privat, new TextEncoder().encode(canonicalSignatureText(umschlag)));
  return { ...umschlag, signature: base64url(new Uint8Array(signatur)) };
}

export interface Anfrageziel {
  /** Kanonischer Pfad; er steht so in der URL UND im Umschlag. */
  readonly pfad: string;
  readonly query: readonly QueryParameter[];
  /** Querystring ohne `?`, leer wenn keine Parameter. */
  readonly querytext: string;
}

/** Baut Pfad und Query so, dass der Server exakt dieselbe kanonische Form wiederfindet. */
export function anfrageziel(pfadUnterApi: string, query: readonly QueryParameter[] = []): Anfrageziel {
  const pfad = canonicalPath(`${MOBILE_API_PREFIX}${pfadUnterApi}`);
  return { pfad, query, querytext: canonicalQuery(query) };
}

export interface Geraeteschluessel {
  readonly device_id: string;
  readonly key_id: string;
  readonly privat: CryptoKey;
}

/** Ein signierter Umschlag fuer genau diese Anfrage an genau diese Origin. */
export async function anfrageSignieren(schluessel: Geraeteschluessel, felder: {
  audience: string; method: string; ziel: Anfrageziel; body: Uint8Array; counter: number; jetzt: number;
}): Promise<SignedRequestEnvelope> {
  return signieren(schluessel.privat, {
    version: MOBILE_API_VERSION,
    device_id: schluessel.device_id,
    key_id: schluessel.key_id,
    audience: felder.audience,
    method: felder.method,
    path: felder.ziel.pfad,
    query: [...felder.ziel.query],
    body_sha256: await sha256Hex(felder.body),
    nonce: zufall(16),
    counter: felder.counter,
    issued_at: felder.jetzt,
    request_id: `r-${zufall(16)}`,
  });
}

/** Der Kopplungsbeweis (Paket 2): signiert mit dem NEUEN Schluessel, gebunden an JWK, Name und Code. */
export async function kopplungsbeweis(privat: CryptoKey, felder: {
  audience: string; public_jwk: JsonObject; device_name: string; pairing_code: string; jetzt: number;
}): Promise<SignedRequestEnvelope> {
  const text = pairingProofBodyText({ public_jwk: felder.public_jwk, device_name: felder.device_name, pairing_code: felder.pairing_code });
  return signieren(privat, {
    version: MOBILE_API_VERSION,
    device_id: 'pairing',
    key_id: 'pairing',
    audience: felder.audience,
    method: 'POST',
    path: `${MOBILE_API_PREFIX}/pairings/complete`,
    query: [],
    body_sha256: await sha256Hex(new TextEncoder().encode(text)),
    nonce: zufall(16),
    counter: 0,
    issued_at: felder.jetzt,
    request_id: `pair-${zufall(16)}`,
  });
}
