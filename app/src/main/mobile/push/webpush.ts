import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export interface VapidKeyMaterial {
  readonly subject: string;
  readonly public_jwk: JsonWebKey;
  readonly private_jwk: JsonWebKey;
}

export interface WebPushSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface EncryptedPush {
  readonly body: Buffer;
  readonly contentEncoding: 'aes128gcm';
}

export interface EncryptOptions {
  /** Testvektoren duerfen Salt und ephemeralen Sender-Schluessel festlegen. */
  readonly salt?: Buffer;
  readonly senderPrivateKey?: Buffer;
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${field} is not canonical base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) throw new Error(`${field} is not canonical base64url`);
  return decoded;
}

function uncompressedPublicJwk(jwk: JsonWebKey): Buffer {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('VAPID key must be an EC P-256 JWK');
  }
  const x = fromBase64url(jwk.x, 'VAPID JWK x');
  const y = fromBase64url(jwk.y, 'VAPID JWK y');
  if (x.length !== 32 || y.length !== 32) throw new Error('VAPID key has invalid P-256 coordinates');
  return Buffer.concat([Buffer.from([4]), x, y]);
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  // RFC 8291 only needs one SHA-256 block (at most 32 bytes) here.
  if (length < 1 || length > 32) throw new Error('unsupported HKDF output length');
  return createHmac('sha256', prk).update(info).update(Buffer.from([1])).digest().subarray(0, length);
}

function jwtPart(value: object): string {
  return base64url(Buffer.from(JSON.stringify(value), 'utf8'));
}

/**
 * Liest ausschliesslich den vom Integrationspaket uebergebenen Laufzeitpfad.
 * Der private Schluessel erscheint weder in Fehlern noch in Logs; der
 * Rueckgabewert bleibt bewusst nur ein interner Sender-Eingang.
 */
export function loadVapidKeyMaterial(path: string): VapidKeyMaterial {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error('VAPID key file must have mode 0600');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('VAPID key file is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('VAPID key file has invalid shape');
  const record = value as Record<string, unknown>;
  if (typeof record.subject !== 'string' || !/^(mailto:|https:)/.test(record.subject)
    || typeof record.public_jwk !== 'object' || record.public_jwk === null
    || typeof record.private_jwk !== 'object' || record.private_jwk === null) {
    throw new Error('VAPID key file has invalid shape');
  }
  const material: VapidKeyMaterial = {
    subject: record.subject,
    public_jwk: record.public_jwk as JsonWebKey,
    private_jwk: record.private_jwk as JsonWebKey,
  };
  const publicPoint = uncompressedPublicJwk(material.public_jwk);
  if (material.private_jwk.kty !== 'EC' || material.private_jwk.crv !== 'P-256' || typeof material.private_jwk.d !== 'string'
    || !publicPoint.equals(uncompressedPublicJwk(material.private_jwk))) throw new Error('VAPID private key does not match public key');
  return material;
}

export function vapidPublicKey(material: VapidKeyMaterial): string {
  return base64url(uncompressedPublicJwk(material.public_jwk));
}

/** RFC 8292 ES256 token, bound to the push-service origin for at most 12 hours. */
export function vapidAuthorization(material: VapidKeyMaterial, endpoint: string, now = Date.now()): string {
  let audience: string;
  try { audience = new URL(endpoint).origin; } catch { throw new Error('push endpoint is not a URL'); }
  const header = jwtPart({ typ: 'JWT', alg: 'ES256' });
  const payload = jwtPart({ aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: material.subject });
  const signed = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signed, 'utf8'), {
    key: createPrivateKey({ key: material.private_jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signed}.${base64url(signature)}, k=${vapidPublicKey(material)}`;
}

/** RFC 8291 aes128gcm single-record content coding. */
export function encryptWebPushPayload(plaintext: Buffer, subscription: WebPushSubscription, options: EncryptOptions = {}): EncryptedPush {
  if (plaintext.length > 3993) throw new Error('push plaintext exceeds the RFC 8291 single-record limit');
  const receiverPublic = fromBase64url(subscription.keys.p256dh, 'subscription p256dh');
  const authSecret = fromBase64url(subscription.keys.auth, 'subscription auth');
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4 || authSecret.length !== 16) {
    throw new Error('subscription encryption keys are invalid');
  }
  const salt = options.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('RFC 8291 salt must be 16 bytes');
  const sender = createECDH('prime256v1');
  if (options.senderPrivateKey) sender.setPrivateKey(options.senderPrivateKey);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey(undefined, 'uncompressed');
  const sharedSecret = sender.computeSecret(receiverPublic);
  const prkKey = createHmac('sha256', authSecret).update(sharedSecret).digest();
  const ikm = hkdfExpand(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), receiverPublic, senderPublic]), 32);
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(86);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublic.length;
  senderPublic.copy(header, 21);
  return { body: Buffer.concat([header, encrypted]), contentEncoding: 'aes128gcm' };
}
