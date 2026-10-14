import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MOBILE_API_PREFIX, MOBILE_API_VERSION } from '../../../mobile-shared/vertrag';
import type { JsonObject, JsonValue, MobileApiErrorCode, RequestEnvelope, SignedRequestEnvelope } from '../../../mobile-shared/vertrag';
import { CanonicalizationError, canonicalAudience, canonicalSignatureText, pairingProofBodyText } from '../../../mobile-shared/kanonisch';
import { validateRequestEnvelope } from '../../../mobile-shared/validierung';
import { acquireMobileAuthLock, MobileStateLockError } from './schloss';

const STATE_FILE = 'auth-state.json';
const PAIRING_TTL_MS = 2 * 60 * 1000;
const REQUEST_TTL_MS = 60 * 1000;
const RESERVATION_TTL_MS = 30 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_REQUESTS_PER_DEVICE = 1024;
/**
 * Gleitfenster fuer den Anfragezaehler je Geraet und Origin, wie beim
 * IPsec-Wiederholungsschutz: Die App schickt mehrere signierte Anfragen
 * parallel, die in anderer Reihenfolge ankommen koennen. Angenommen wird ein
 * Zaehler ueber dem Hoechstwert oder einer im Fenster darunter, der noch nicht
 * gesehen wurde. Gesehen heisst: er steht in einem gespeicherten RequestRecord.
 * Beschnittene Records hinterlassen ihren hoechsten Zaehler als Untergrenze
 * (`counter_floors`), damit das Fenster nie einen vergessenen Zaehler oeffnet.
 *
 * Das Fenster ist eine Zeitspanne, keine Schrittzahl: Die App vergibt den
 * Zaehler als `max(letzter + 1, Date.now())`, er traegt also Millisekunden.
 * Angenommen wird `counter > hoechster - COUNTER_WINDOW_MS`, d. h. ein Abstand
 * zum Hoechstwert von hoechstens 59 999; ab 60 000 gilt `counter_replayed`.
 * Die Kopplung an `REQUEST_TTL_MS` ist sicher, weil das Fenster nie allein
 * entscheidet: (1) Jeder Umschlag gilt ohnehin nur 60 s um `issued_at`; ein
 * mitgeschnittener ist danach wertlos, egal wie weit sein Zaehler zurueckliegt.
 * (2) Innerhalb des Fensters verhindert „gesehen“ die zweite Annahme: Nonce,
 * `request_id` und Zaehler stehen im Record, und ist der Record beschnitten,
 * liegt sein Zaehler auf oder unter der Untergrenze. Ein breiteres Fenster
 * laesst also keinen Zaehler zweimal zu; es laesst nur echte, laenger
 * unterwegs gewesene Anfragen durch, die die Frist ohnehin noch zulaesst.
 * Die 1024 Records je Geraet und Origin decken das Fenster nur, solange
 * hoechstens 1024 Anfragen in die Verspaetung einer ueberholten fallen (bei
 * 60 s etwa 17 Anfragen/s). Darueber hebt das Beschneiden die Untergrenze ins
 * Fenster: die ueberholte Anfrage scheitert, es wird strenger, nie offener.
 */
const COUNTER_WINDOW_MS = REQUEST_TTL_MS;
/** Wie viele Ergebnisse je Geraet und Origin aufgehoben werden (Spezifikation 3.2: begrenzt). */
const MAX_JOURNAL_RESULTS = 64;
/** Groesse eines aufgehobenen Ergebnisses; was groesser ist, wird nicht journalisiert. */
const MAX_JOURNAL_BYTES = 2048;
const MAX_BODY_BYTES = 1024 * 1024;
const PAIRING_PROOF_DEVICE_ID = 'pairing';
const PAIRING_PROOF_KEY_ID = 'pairing';
export { MobileStateLockError, mobileAuthProcessStartTime } from './schloss';

export class MobileAuthError extends Error {
  constructor(readonly code: MobileApiErrorCode, message: string = code) {
    super(message);
    this.name = 'MobileAuthError';
  }
}

export interface PairingStart {
  readonly pairing_id: string;
  /** Nur fuer den lokalen Anzeigepfad; der Zustand speichert ausschliesslich den Hash. */
  readonly pairing_code: string;
  readonly expires_at: number;
}

export interface PairingStartOptions {
  readonly audience: string;
  readonly operator_identity: string;
  readonly now?: number;
}

export interface PairingCompletion {
  readonly public_jwk: JsonObject;
  readonly device_name: string;
  readonly pairing_code: string;
  readonly proof: SignedRequestEnvelope;
}

export interface PairingCompleteOptions {
  readonly audience: string;
  readonly operator_identity: string;
  readonly now?: number;
}

export interface DeviceRecord {
  readonly device_id: string;
  readonly key_id: string;
  readonly device_name: string;
  readonly public_jwk: JsonObject;
  readonly operator_identity: string;
  /** Origins werden bei der authentisierten Host-Replikation gezielt erweitert. */
  readonly audiences: readonly string[];
  readonly status: 'active' | 'revoked';
  readonly paired_at: number;
  readonly revoked_at?: number;
}

export interface AuthenticatedRequest {
  readonly device_id: string;
  readonly key_id: string;
  readonly request_id: string;
  readonly nonce: string;
  readonly counter: number;
}

/** Das gespeicherte Ergebnis einer bereits ausgefuehrten Anfrage (Spezifikation 3.2). */
export interface JournalErfolg { readonly status: number; readonly data: JsonValue | null; }
export interface JournalFehler { readonly status: number; readonly code: MobileApiErrorCode; }
export type JournalErgebnis = JournalErfolg | JournalFehler;

export function istJournalFehler(ergebnis: JournalErgebnis): ergebnis is JournalFehler {
  return (ergebnis as JournalFehler).code !== undefined;
}

/**
 * DIE WIEDERHOLUNG EINER SCHON AUSGEFUEHRTEN ANFRAGE (Spezifikation 3.2).
 * Sie wird nicht als `nonce_replayed` abgewiesen, sondern liefert das
 * gespeicherte Ergebnis -- so fuehrt ein Netzwechsel oder ein iOS-Resume
 * dieselbe Handlung nie zweimal aus. Dieselbe `request_id` mit einem anderen
 * Body bleibt `request_id_conflict`.
 */
export class MobileReplayedResult extends Error {
  constructor(readonly result: JournalErgebnis) {
    super('request was already answered');
    this.name = 'MobileReplayedResult';
  }
}

export interface VerifyRequestOptions {
  readonly audience: string;
  readonly body: Buffer;
  readonly now?: number;
}

type MutableDeviceRecord = Omit<DeviceRecord, 'status' | 'revoked_at' | 'audiences'> & {
  status: 'active' | 'revoked';
  revoked_at?: number;
  audiences: string[];
};

interface PairingRecord {
  pairing_id: string;
  code_sha256: string;
  audience: string;
  operator_identity: string;
  attempts: number;
  expires_at: number;
  status: 'active' | 'complete' | 'cancelled' | 'expired';
}

interface RequestRecord {
  request_id: string;
  nonce: string;
  counter: number;
  fingerprint: string;
  state: 'reserved' | 'consumed' | 'failed';
  reserved_at: number;
  expires_at: number;
  /** Das Ergebnisjournal: Reservierung, Zustand und Ergebnis liegen in EINEM Datensatz. */
  result?: JournalErgebnis;
}

interface State {
  version: 1;
  devices: Record<string, MutableDeviceRecord>;
  pairings: Record<string, PairingRecord>;
  requests: Record<string, RequestRecord[]>;
  counters: Record<string, number>;
  /**
   * Hoechster Zaehler, den das Beschneiden der Records je Geraet und Origin
   * vergessen hat; alles bis einschliesslich dieses Werts bleibt abgelehnt.
   * Optional, damit aeltere auth-state.json ohne Migration laden.
   */
  counter_floors?: Record<string, number>;
}

const emptyState = (): State => ({ version: 1, devices: {}, pairings: {}, requests: {}, counters: {} });

/**
 * Untergrenze der Zaehler, die als ungesehen gelten duerfen. Fehlt sie bei einem
 * Schluessel, dessen Records schon voll sind (Zustand von vor dem Gleitfenster),
 * kann dort frueher beschnitten worden sein, ohne Spur: dann gilt fail-closed der
 * bisherige Hoechstwert, also das alte streng steigende Verhalten.
 */
function counterFloor(state: State, key: string, requests: readonly RequestRecord[]): number {
  const stored = state.counter_floors?.[key];
  if (stored !== undefined) return stored;
  return requests.length >= MAX_REQUESTS_PER_DEVICE ? (state.counters[key] ?? -1) : -1;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

function exactText(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function base64url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function assertPublicP256Jwk(value: JsonObject): void {
  if (value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string'
    || Object.prototype.hasOwnProperty.call(value, 'd')) {
    throw new MobileAuthError('invalid_envelope', 'public key must be an EC P-256 public JWK');
  }
  if (!base64url(value.x) || !base64url(value.y)) {
    throw new MobileAuthError('invalid_envelope', 'public key coordinates are malformed');
  }
}

function verifyP1363(publicJwk: JsonObject, text: string, signature: string): boolean {
  const rawSignature = base64url(signature);
  if (!rawSignature || rawSignature.length !== 64) return false;
  try {
    return verify('sha256', exactText(text), { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, rawSignature);
  } catch {
    return false;
  }
}

/**
 * Der Vertrag beschreibt keinen serialisierten Pairing-Proof. Diese ausschliesslich
 * datenhaltige Form verhindert die Signatur-Zirkularitaet (proof.signature selbst
 * kann nicht Teil ihres eigenen Bodyhashs sein) und bindet dennoch Code, Namen und JWK.
 */
export function pairingProofBodySha256(completion: Pick<PairingCompletion, 'public_jwk' | 'device_name' | 'pairing_code'>): string {
  try {
    return sha256(pairingProofBodyText(completion));
  } catch (error) {
    if (error instanceof CanonicalizationError) throw new MobileAuthError('invalid_envelope', 'pairing proof contains an unsupported value');
    throw error;
  }
}

function requestFingerprint(envelope: RequestEnvelope, body: Buffer): string {
  return sha256(`${canonicalSignatureText(envelope)}\nbody:${sha256(body)}`);
}

/** Ein Ergebnis wird nur journalisiert, solange es klein bleibt; sonst bleibt der Zustand allein stehen. */
function journalSetzen(record: RequestRecord, ergebnis?: JournalErgebnis): void {
  if (!ergebnis) return;
  let text: string;
  try {
    text = JSON.stringify(ergebnis);
  } catch {
    return;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) return;
  record.result = ergebnis;
}

function stateKey(deviceId: string, audience: string): string {
  return `${deviceId}\u0000${audience}`;
}

function nonceIs128Bit(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value) && base64url(value)?.length === 16;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export class MobileAuthenticator {
  readonly stateDirectory: string;

  constructor(stateDirectory = join(homedir(), '.claude', 'workbench', 'mobile')) {
    this.stateDirectory = stateDirectory;
  }

  startPairing(options: PairingStartOptions): PairingStart {
    const now = options.now ?? Date.now();
    const audience = this.canonicalAudienceOrThrow(options.audience);
    if (!options.operator_identity) throw new MobileAuthError('bad_request', 'operator identity is required');
    const pairingCode = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
    const pairing: PairingRecord = {
      pairing_id: randomId(),
      code_sha256: sha256(pairingCode),
      audience,
      operator_identity: options.operator_identity,
      attempts: 0,
      expires_at: now + PAIRING_TTL_MS,
      status: 'active',
    };
    this.withState((state) => {
      for (const record of Object.values(state.pairings)) {
        if (record.status === 'active' && record.operator_identity === options.operator_identity && record.audience === audience) {
          record.status = 'cancelled';
        }
      }
      state.pairings[pairing.pairing_id] = pairing;
    });
    return { pairing_id: pairing.pairing_id, pairing_code: pairingCode, expires_at: pairing.expires_at };
  }

  completePairing(completion: PairingCompletion, options: PairingCompleteOptions): DeviceRecord {
    const now = options.now ?? Date.now();
    const audience = this.canonicalAudienceOrThrow(options.audience);
    assertPublicP256Jwk(completion.public_jwk);
    if (!completion.device_name || completion.device_name.length > 128 || !/^\d{6}$/.test(completion.pairing_code)) {
      throw new MobileAuthError('bad_request', 'pairing body is malformed');
    }
    return this.withState((state) => {
      const candidates = Object.values(state.pairings).filter((pairing) => pairing.status === 'active'
        && pairing.audience === audience && pairing.operator_identity === options.operator_identity);
      for (const pairing of candidates) {
        if (pairing.expires_at < now) pairing.status = 'expired';
      }
      const active = candidates.filter((pairing) => pairing.status === 'active');
      const suppliedHash = sha256(completion.pairing_code);
      const pairing = active.find((entry) => timingSafeEqual(Buffer.from(entry.code_sha256, 'hex'), Buffer.from(suppliedHash, 'hex')));
      if (!pairing) {
        for (const entry of active) entry.attempts += 1;
        for (const entry of active) if (entry.attempts >= MAX_PAIRING_ATTEMPTS) entry.status = 'cancelled';
        throw new MobileAuthError('device_not_paired', 'pairing is unavailable');
      }
      pairing.attempts += 1;
      if (pairing.attempts > MAX_PAIRING_ATTEMPTS) {
        pairing.status = 'cancelled';
        throw new MobileAuthError('device_not_paired', 'pairing attempts exhausted');
      }
      this.verifyPairingProof(completion, audience, now);
      const device: MutableDeviceRecord = {
        device_id: randomId(),
        key_id: randomId(12),
        device_name: completion.device_name,
        public_jwk: completion.public_jwk,
        operator_identity: options.operator_identity,
        audiences: [audience],
        status: 'active',
        paired_at: now,
      };
      state.devices[device.device_id] = device;
      pairing.status = 'complete';
      return device;
    });
  }

  revokeDevice(deviceId: string, now = Date.now()): boolean {
    return this.withState((state) => {
      const device = state.devices[deviceId];
      if (!device || device.status === 'revoked') return false;
      device.status = 'revoked';
      device.revoked_at = now;
      return true;
    });
  }

  /** Der Replikationsweg darf nur eine explizit konfigurierte Origin hinzufuegen. */
  allowAudience(deviceId: string, audience: string): boolean {
    const canonical = this.canonicalAudienceOrThrow(audience);
    return this.withState((state) => {
      const device = state.devices[deviceId];
      if (!device || device.status === 'revoked' || device.audiences.includes(canonical)) return false;
      device.audiences = [...device.audiences, canonical];
      return true;
    });
  }

  devices(): readonly DeviceRecord[] {
    return this.withState((state) => Object.values(state.devices).map((device) => ({ ...device })));
  }

  verifyAndReserve(envelope: SignedRequestEnvelope, options: VerifyRequestOptions): AuthenticatedRequest {
    const checked = this.precheck(envelope, options);
    return this.withState((state) => {
      const { device, key, requests } = this.checkAgainstState(state, envelope, checked);
      const record: RequestRecord = {
        request_id: envelope.request_id,
        nonce: envelope.nonce,
        counter: envelope.counter,
        fingerprint: checked.fingerprint,
        state: 'reserved',
        reserved_at: checked.now,
        expires_at: checked.now + RESERVATION_TTL_MS,
      };
      const floor = counterFloor(state, key, requests);
      requests.push(record);
      const pruned = this.pruneRequests(requests, checked.now);
      state.requests[key] = requests;
      state.counters[key] = Math.max(state.counters[key] ?? -1, envelope.counter);
      const newFloor = pruned.reduce((highest, entry) => Math.max(highest, entry.counter), floor);
      if (newFloor >= 0 || state.counter_floors?.[key] !== undefined) {
        state.counter_floors = { ...(state.counter_floors ?? {}), [key]: newFloor };
      }
      return { device_id: device.device_id, key_id: device.key_id, request_id: envelope.request_id, nonce: envelope.nonce, counter: envelope.counter };
    });
  }

  /**
   * Dieselbe Pruefung wie `verifyAndReserve`, aber ohne zu reservieren (Paket 10).
   * Fuer Routen, deren nicht wiederholbare Handlung ein anderer Prozess mit
   * demselben Zustand atomar beansprucht: `wb-pane-write mobil-senden|mobil-taste`
   * laesst `wb-mobil-pruefen` den Umschlag selbst reservieren und verbrauchen.
   * Reservierte der Server vorher, schluege diese zweite, massgebliche Pruefung
   * immer mit `nonce_replayed` fehl. Nonce, Zaehler und Request-ID werden hier nur
   * gelesen; ein Replay scheitert trotzdem schon hier, weil der erste Aufruf sie
   * im Zustand verbraucht hat.
   */
  verify(envelope: SignedRequestEnvelope, options: VerifyRequestOptions): AuthenticatedRequest {
    const checked = this.precheck(envelope, options);
    return this.withState((state) => {
      const { device } = this.checkAgainstState(state, envelope, checked);
      return { device_id: device.device_id, key_id: device.key_id, request_id: envelope.request_id, nonce: envelope.nonce, counter: envelope.counter };
    }, false);
  }

  private precheck(envelope: SignedRequestEnvelope, options: VerifyRequestOptions): { now: number; audience: string; fingerprint: string } {
    const now = options.now ?? Date.now();
    if (options.body.length > MAX_BODY_BYTES) throw new MobileAuthError('bad_request', 'body is too large');
    this.assertEnvelope(envelope);
    const audience = this.canonicalAudienceOrThrow(options.audience);
    let envelopeAudience: string;
    try {
      envelopeAudience = canonicalAudience(envelope.audience);
    } catch {
      throw new MobileAuthError('invalid_envelope', 'audience is not canonical');
    }
    if (envelopeAudience !== audience) throw new MobileAuthError('audience_mismatch', 'audience does not match this origin');
    if (Math.abs(now - envelope.issued_at) > REQUEST_TTL_MS) throw new MobileAuthError('request_expired', 'request is outside its time window');
    if (envelope.body_sha256 !== sha256(options.body)) throw new MobileAuthError('invalid_signature', 'body does not match envelope');
    return { now, audience, fingerprint: requestFingerprint(envelope, options.body) };
  }

  private checkAgainstState(state: State, envelope: SignedRequestEnvelope, checked: { audience: string; fingerprint: string }): { device: MutableDeviceRecord; key: string; requests: RequestRecord[] } {
    const device = state.devices[envelope.device_id];
    if (!device) throw new MobileAuthError('device_not_paired', 'device is not paired');
    if (device.status === 'revoked') throw new MobileAuthError('device_revoked', 'device is revoked');
    if (device.key_id !== envelope.key_id) throw new MobileAuthError('key_not_found', 'key is not registered for this device');
    if (!device.audiences.includes(checked.audience)) throw new MobileAuthError('audience_mismatch', 'audience is not registered for this device');
    if (!verifyP1363(device.public_jwk, canonicalSignatureText(envelope), envelope.signature)) {
      throw new MobileAuthError('invalid_signature', 'signature did not verify');
    }
    const key = stateKey(device.device_id, checked.audience);
    const requests = state.requests[key] ?? [];
    const existingRequestId = requests.find((record) => record.request_id === envelope.request_id);
    if (existingRequestId) {
      if (existingRequestId.fingerprint !== checked.fingerprint) throw new MobileAuthError('request_id_conflict', 'request id was used with another request');
      // Gleiche `request_id`, gleicher Body: die zulaessige Netz-Wiederholung.
      // Steht ein Ergebnis im Journal, kommt genau dieses zurueck; sonst laeuft
      // die erste Ausfuehrung noch, und eine zweite darf nicht beginnen.
      if (existingRequestId.result) throw new MobileReplayedResult(existingRequestId.result);
      throw new MobileAuthError('nonce_replayed', 'request has already been reserved');
    }
    if (requests.some((record) => record.nonce === envelope.nonce)) throw new MobileAuthError('nonce_replayed', 'nonce has already been used');
    const lastCounter = state.counters[key] ?? -1;
    if (envelope.counter <= lastCounter) {
      // Ueberholte Anfrage: nur im Fenster, ueber der Untergrenze vergessener
      // Zaehler und nur, wenn kein gespeicherter Record diesen Zaehler traegt.
      if (envelope.counter <= lastCounter - COUNTER_WINDOW_MS) throw new MobileAuthError('counter_replayed', 'counter is below the replay window');
      if (envelope.counter <= counterFloor(state, key, requests)) throw new MobileAuthError('counter_replayed', 'counter is below the replay window');
      if (requests.some((record) => record.counter === envelope.counter)) throw new MobileAuthError('counter_replayed', 'counter has already been used');
    }
    return { device, key, requests };
  }

  /** Zustand und Ergebnis in EINEM Schritt: die Reservierung wird verbraucht und das Ergebnis journalisiert. */
  consume(request: AuthenticatedRequest, audience: string, ergebnis?: JournalErgebnis, now = Date.now()): void {
    const targetAudience = this.canonicalAudienceOrThrow(audience);
    this.withState((state) => {
      const record = state.requests[stateKey(request.device_id, targetAudience)]?.find((entry) => entry.request_id === request.request_id);
      if (!record || record.nonce !== request.nonce || record.state !== 'reserved') {
        throw new MobileAuthError('nonce_replayed', 'reservation cannot be consumed');
      }
      if (record.expires_at < now) {
        record.state = 'failed';
        throw new MobileAuthError('request_expired', 'reservation expired before use');
      }
      record.state = 'consumed';
      journalSetzen(record, ergebnis);
    });
  }

  fail(request: AuthenticatedRequest, audience: string, ergebnis?: JournalErgebnis): void {
    const targetAudience = this.canonicalAudienceOrThrow(audience);
    this.withState((state) => {
      const record = state.requests[stateKey(request.device_id, targetAudience)]?.find((entry) => entry.request_id === request.request_id);
      if (record && record.nonce === request.nonce && record.state === 'reserved') {
        record.state = 'failed';
        journalSetzen(record, ergebnis);
      }
    });
  }

  /**
   * Das Ergebnis einer Anfrage nachtragen, deren Umschlag ein ANDERER Prozess
   * reserviert und verbraucht hat (`wb-mobil-pruefen` im Zweig `mobil-senden`
   * oder `mobil-taste`, Spezifikation 4.3). Es wird nur an einen vorhandenen
   * Datensatz geheftet: fehlt er, hat das Werkzeug nichts beansprucht, also ist
   * auch nichts geschehen, und eine Wiederholung darf frisch laufen.
   */
  journalNachtragen(request: Pick<AuthenticatedRequest, 'device_id' | 'request_id' | 'nonce'>, audience: string, ergebnis: JournalErgebnis): boolean {
    const targetAudience = this.canonicalAudienceOrThrow(audience);
    return this.withState((state) => {
      const records = state.requests[stateKey(request.device_id, targetAudience)];
      const record = records?.find((entry) => entry.request_id === request.request_id && entry.nonce === request.nonce);
      if (!record || record.result) return false;
      journalSetzen(record, ergebnis);
      return record.result !== undefined;
    });
  }

  /** Das gespeicherte Ergebnis dieser Anfrage, falls es eines gibt (nur lesend). */
  journalLesen(request: Pick<AuthenticatedRequest, 'device_id' | 'request_id'>, audience: string): JournalErgebnis | null {
    const targetAudience = this.canonicalAudienceOrThrow(audience);
    return this.withState((state) => state.requests[stateKey(request.device_id, targetAudience)]
      ?.find((entry) => entry.request_id === request.request_id)?.result ?? null, false);
  }

  private verifyPairingProof(completion: PairingCompletion, audience: string, now: number): void {
    const proof = completion.proof;
    this.assertEnvelope(proof);
    let proofAudience: string;
    try {
      proofAudience = canonicalAudience(proof.audience);
    } catch {
      throw new MobileAuthError('invalid_envelope', 'pairing audience is not canonical');
    }
    if (proof.version !== MOBILE_API_VERSION || proof.device_id !== PAIRING_PROOF_DEVICE_ID || proof.key_id !== PAIRING_PROOF_KEY_ID
      || proofAudience !== audience || proof.method.toUpperCase() !== 'POST' || proof.path !== `${MOBILE_API_PREFIX}/pairings/complete`
      || proof.query.length !== 0 || proof.body_sha256 !== pairingProofBodySha256(completion)
      || Math.abs(now - proof.issued_at) > REQUEST_TTL_MS || !nonceIs128Bit(proof.nonce)
      || !verifyP1363(completion.public_jwk, canonicalSignatureText(proof), proof.signature)) {
      throw new MobileAuthError('invalid_signature', 'pairing proof did not verify');
    }
  }

  private assertEnvelope(envelope: SignedRequestEnvelope): void {
    const envelopeRecord = envelope as unknown as Record<string, unknown>;
    const expectedEnvelopeKeys = ['audience', 'body_sha256', 'counter', 'device_id', 'issued_at', 'key_id', 'method', 'nonce', 'path', 'query', 'request_id', 'signature', 'version'];
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 32 * 1024 || !exactKeys(envelopeRecord, expectedEnvelopeKeys)
      || !validateRequestEnvelope(envelope).ok || typeof envelope.signature !== 'string' || !nonceIs128Bit(envelope.nonce)
      || !envelope.query.every((entry) => exactKeys(entry as unknown as Record<string, unknown>, ['name', 'value']))) {
      throw new MobileAuthError('invalid_envelope', 'request envelope is malformed');
    }
    if (envelope.version !== MOBILE_API_VERSION) throw new MobileAuthError('unsupported_api_version', 'unsupported mobile API version');
    try {
      canonicalSignatureText(envelope);
    } catch (error) {
      if (error instanceof CanonicalizationError) throw new MobileAuthError('invalid_envelope', 'request envelope is not canonical');
      throw error;
    }
  }

  private canonicalAudienceOrThrow(audience: string): string {
    try {
      return canonicalAudience(audience);
    } catch {
      throw new MobileAuthError('invalid_envelope', 'configured audience is invalid');
    }
  }

  /** Liefert die entfernten Records, damit ihr hoechster Zaehler zur Untergrenze wird. */
  private pruneRequests(requests: RequestRecord[], now: number): RequestRecord[] {
    for (const record of requests) {
      if (record.state === 'reserved' && record.expires_at < now) record.state = 'failed';
    }
    requests.sort((left, right) => left.reserved_at - right.reserved_at);
    const pruned = requests.length > MAX_REQUESTS_PER_DEVICE ? requests.splice(0, requests.length - MAX_REQUESTS_PER_DEVICE) : [];
    // Das Journal bleibt begrenzt: nur die juengsten Eintraege behalten ihr Ergebnis.
    for (let index = 0; index < requests.length - MAX_JOURNAL_RESULTS; index += 1) delete requests[index].result;
    return pruned;
  }

  private withState<T>(operation: (state: State) => T, write = true): T {
    this.ensureDirectory();
    let lock;
    try {
      lock = acquireMobileAuthLock(this.stateDirectory, 3000);
    } catch (error) {
      if (error instanceof MobileStateLockError) throw new MobileAuthError('state_locked', error.message);
      throw error;
    }
    try {
      const state = this.readState();
      try {
        const result = operation(state);
        if (write) this.writeState(state);
        return result;
      } catch (error) {
        // Fehlversuche bei einem Pairing sind Sicherheitszustand (Versuchszähler)
        // und duerfen beim kontrollierten Fehler nicht still verloren gehen.
        if (write) this.writeState(state);
        throw error;
      }
    } finally {
      lock.release();
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.stateDirectory, 0o700);
  }

  private readState(): State {
    const path = join(this.stateDirectory, STATE_FILE);
    if (!existsSync(path)) return emptyState();
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as State;
      if (state.version !== 1 || !state.devices || !state.pairings || !state.requests || !state.counters) throw new Error('invalid state');
      if (state.counter_floors !== undefined && (typeof state.counter_floors !== 'object' || state.counter_floors === null || Array.isArray(state.counter_floors)
        || Object.values(state.counter_floors).some((floor) => typeof floor !== 'number' || !Number.isFinite(floor)))) throw new Error('invalid state');
      return state;
    } catch {
      throw new MobileAuthError('internal_error', 'mobile auth state is unreadable');
    }
  }

  private writeState(state: State): void {
    const path = join(this.stateDirectory, STATE_FILE);
    const temporary = `${path}.${process.pid}.${randomId(6)}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
      chmodSync(temporary, 0o600);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
}

export function mobileAuthStateMode(stateDirectory: string): { directory: number; state: number | undefined } {
  const statePath = join(stateDirectory, STATE_FILE);
  return {
    directory: statSync(stateDirectory).mode & 0o777,
    state: existsSync(statePath) ? statSync(statePath).mode & 0o777 : undefined,
  };
}
