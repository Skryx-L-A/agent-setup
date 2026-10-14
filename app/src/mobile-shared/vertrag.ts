/**
 * Gemeinsamer Vertrag der mobilen Werkbank-API.
 *
 * Dieser Ordner kennt weder Node noch Browser-APIs. Der Kern und die PWA teilen
 * deshalb dieselben Datenformen, ohne dass einer von beiden zum Laufzeit-Adapter
 * des anderen wird.
 */

/** Der signierte Wirewert bleibt v1; die kanonische Signaturform darf nicht driften. */
export const MOBILE_API_VERSION = '1';
/**
 * v1.1 bis v1.3 erweitern den Vertrag additiv, ohne den Wire-/Signaturwert v1
 * zu brechen. v1.2: Pane-Bindung der Sitzungen, Workerzaehler, signierte
 * Pane-Bodies von messages/keys und `GET /session-options` im Server.
 * v1.3: die gemessene Tastenfolge je Promptoption, der signierte
 * `mobil-taste`-Body der Promptantwort samt Fingerprint in der Query und das
 * idempotente Ergebnisjournal (Spezifikation 3.2).
 * v1.4: die Abnahme eines Tickets durch den Menschen (`ticket.approve`) mit
 * den Pflichtfeldern von `wb-ticket abnehmen` (Entscheidung des Nutzers vom
 * 18.09.2026, MOBILE-APP-ENTSCHEIDUNGEN.md).
 * v1.5: der gesperrte mobile Zustandsweg meldet `state_locked` als
 * voruebergehenden API-Konflikt.
 * v1.6: `ticket.reject` traegt die beiden restlichen Kernfelder `duplicate_of`
 * und `note`; damit ist der Grund `duplikat` vom Handy aus waehlbar.
 * v1.7: der Wartewunsch „Bescheid geben“ (Aktion `session.notify`, Feld
 * `notify_until` an autoritativen Sitzungen). Mit ihm geht das naechste
 * „Worker fertig“ dieser Sitzung als Push hinaus (Regel R2, push/dringend.ts).
 * v1.8: der Wartewunsch hat eine eigene signierte Route je Sitzung,
 * `POST /sessions/:id/notify`, und geht wie jedes Schreiben an die Origin der
 * Maschine der Sitzung (auch peer). Die Agents-Aktion `session.notify` aus
 * v1.7 entfaellt: v1.7 wurde nie ausgerollt, und Mutationen gelten ohnehin nur
 * bei gleichem Bau von App und Server (Abschnitt 10 Punkt 12), ein Rueckfall
 * fuer alte Server waere toter Code.
 * v1.9: `pane_busy` als eigener Konflikt. Der Pane einer Sitzung nimmt gerade
 * keine Eingabe an (offener Harness-Dialog, Sitzung wartet, ungesendeter Text
 * in der Eingabezeile, unlesbarer Schirm); `wb-pane-write` und der
 * Dialogriegel des Kerns melden ihn, die App zeigt dafuer einen eigenen Text.
 */
export const MOBILE_CONTRACT_VERSION = '1.9';
export const MOBILE_API_PREFIX = '/mobile/v1';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type Source = 'authoritative' | 'mirror';
export type MachineId = string;
export type GlobalSessionId = `${string}:${string}`;

export interface ApiMeta {
  api_version: string;
  server_build: string;
  machine: MachineId;
  authoritative: boolean;
  request_id: string;
}

export interface ApiSuccess<T> extends ApiMeta {
  data: T;
}

export interface ApiFailure extends ApiMeta {
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Fehlerklassen sind absichtlich ohne kryptographische Details. */
export type MobileErrorCode =
  | 'bad_request'
  | 'unsupported_api_version'
  | 'unauthorized_origin'
  | 'device_not_paired'
  | 'device_revoked'
  | 'key_not_found'
  | 'invalid_signature'
  | 'invalid_envelope'
  | 'audience_mismatch'
  | 'request_expired'
  | 'nonce_replayed'
  | 'counter_replayed'
  | 'request_id_conflict'
  | 'stale_target'
  | 'capability_unavailable'
  | 'prompt_changed'
  /** Der Pane nimmt gerade nichts an; es wurde nichts getippt (Vertrag 1.9). */
  | 'pane_busy'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error';

/** Vertragscodes, die erst ein Adapter erzeugt; Paket 4 reicht sie spaeter als HTTP-Status durch. */
export type MobileApiErrorCode = MobileErrorCode | 'close_rejected_workers_running' | 'state_locked';

export const MOBILE_ERROR_CODES: readonly MobileApiErrorCode[] = [
  'bad_request', 'unsupported_api_version', 'unauthorized_origin', 'device_not_paired',
  'device_revoked', 'key_not_found', 'invalid_signature', 'invalid_envelope', 'audience_mismatch',
  'request_expired', 'nonce_replayed', 'counter_replayed', 'request_id_conflict', 'stale_target',
  'capability_unavailable', 'prompt_changed', 'pane_busy', 'close_rejected_workers_running', 'not_found', 'rate_limited', 'internal_error',
];

/**
 * API-only codes stay out of MOBILE_ERROR_CODES: that list is mirrored
 * literally by shell/wb-pane-write (contract drift promise 9a), while this
 * code can only originate in the mobile auth/API server.
 */
export const MOBILE_API_ERROR_CODES: readonly MobileApiErrorCode[] = [
  ...MOBILE_ERROR_CODES, 'state_locked',
];

export interface ApiError {
  code: MobileApiErrorCode;
  message: string;
  retryable: boolean;
}

export interface RequestEnvelope {
  version: string;
  device_id: string;
  key_id: string;
  audience: string;
  method: string;
  path: string;
  query: readonly QueryParameter[];
  body_sha256: string;
  nonce: string;
  counter: number;
  issued_at: number;
  request_id: string;
}

export interface SignedRequestEnvelope extends RequestEnvelope {
  /** Base64url-kodierte DER-unabhaengige ECDSA-Signatur. */
  signature: string;
}

export interface QueryParameter {
  name: string;
  value: string;
}

export type SessionState = 'running' | 'attention' | 'stopped' | 'unreachable';
export type WorkerState = 'running' | 'blocked' | 'stalled' | 'done' | 'unknown';
export type PromptSelectionKind = 'single' | 'multi' | 'text';
export type Decision = 'approve' | 'reject';

export interface WorkerSummary {
  id: string;
  name: string;
  state: WorkerState;
  updated_at: number;
}

/**
 * v1.2: Das Ziel, an das `wb-pane-write mobil-senden|mobil-taste` schreibt. Das
 * Werkzeug ermittelt dieselben drei Werte selbst und vergleicht sie mit dem
 * signierten Body; ein umgebogenes Ziel macht die Signatur wertlos.
 */
export interface PaneBinding {
  /** Erster Namensteil des Rechnernamens, Gross-/Kleinschreibung unveraendert (config.ts `machine`-Vorgabe). */
  maschine: string;
  /** Woertlich `#{socket_path}` des tmux-Servers der Sitzung. */
  socket: string;
  /** Orchestrator-Pane `%<n>`. */
  pane: string;
}

export interface SessionSummary {
  id: GlobalSessionId;
  source: Source;
  name: string;
  harness: string;
  model: string;
  state: SessionState;
  updated_at: number;
  /**
   * V1-Kompatibilitaetsfeld. Seit v1.2 bleibt es leer: Worker verlassen den Kern
   * nur als Zahl (`worker_count`, `running_worker_count`).
   */
  workers: readonly WorkerSummary[];
  /** v1.2: Zahl der Worker dieser Sitzung. */
  worker_count: number;
  /** v1.2: davon im Zustand `running`. */
  running_worker_count: number;
  open_approvals: number;
  data_age_ms: number;
  /** v1.2: nur autoritative, laufende Sitzungen mit Orchestrator-Pane; sonst fehlt das Feld. */
  binding?: PaneBinding;
  /**
   * v1.7/v1.8: Wartewunsch „Bescheid geben“. Eine Zahl: gilt bis zu diesem Zeitpunkt
   * (oder bis zum ersten ausgeloesten Push). `null`: keiner gesetzt. Fehlt das
   * Feld, kann diese Origin den Wunsch nicht annehmen (Spiegel, alter Server).
   */
  notify_until?: number | null;
}

export interface ChatMessage {
  id: string;
  role: 'human' | 'agent' | 'system' | 'tool';
  /**
   * V1-Kompatibilitaetsfeld. V1.1-Server liefern bei `role: 'tool'` zusaetzlich
   * `tool`; neue Leser verwenden dessen strukturierte Teile statt diesen Text
   * zu parsen. Das Feld bleibt, damit ein v1-Client weiterhin nur lesen kann.
   */
  text: string;
  created_at: number;
  tool?: ChatToolCall;
}

/** Die von Paket 5 aus `chat/leser.ts` abbildbare Werkzeugzeile. */
export interface ChatToolCall {
  name: string;
  /** Kurze, bereits fuer die Anzeige begrenzte Argumentdarstellung. */
  arguments_preview: string;
  /** Bereits gekuerzte Ausgabe; kein Rohtranscript. */
  output_preview: string;
}

export interface PromptOption {
  id: string;
  label: string;
  selected: boolean;
  /**
   * v1.3: die GEMESSENE Tastenfolge dieser Option, wie der Harnessadapter sie
   * aus seiner Fixture liest (Spezifikation 5.2 Punkt 4) -- nie aus dem
   * sichtbaren Index abgeleitet. Sie steht hier, damit die App genau den Body
   * signieren kann, den `wb-mobil-pruefen` fuer `mobil-taste` verlangt; der
   * Server prueft die Folge vor dem Senden erneut gegen seine eigene Tabelle.
   * Fehlt sie, beantwortet dieser Harness ohne Pane-Tasten (OpenCode: HTTP).
   */
  keys?: readonly AllowedSpecialKey[];
}

export interface Prompt {
  fingerprint: string;
  harness: string;
  harness_version: string;
  text: string;
  selection: PromptSelectionKind;
  options: readonly PromptOption[];
}

export interface Approval {
  id: string;
  kind: 'request' | 'guard';
  source: Source;
  session_id: GlobalSessionId | null;
  summary: string;
  created_at: number;
}

export interface ThemePayload extends JsonObject {
  /** `themaPayload()` aus dem Kern, ohne eine zweite Farbberechnung. */
  thema: string;
  wirksam: string;
  akzent: string;
  akzentText: string;
  /** V1-Lesekompatibilitaet; v1.1-Clients verwenden `akzent`. */
  accent: string;
}

/** Die Namen sind Teil des Vertrags, keine offenen, vom Client erfundenen Strings. */
export type MobileCapability =
  | 'prompt.answer.claude'
  | 'prompt.answer.codex'
  | 'prompt.answer.opencode'
  | 'prompt.answer.pi'
  | 'approvals.request.decide'
  | 'approvals.guard.approve'
  | 'approvals.guard.reject'
  | 'sessions.create'
  | 'agents.human_sender'
  | 'push';

export interface BootstrapData {
  origins: readonly string[];
  capabilities: Readonly<Record<MobileCapability, boolean> & Record<string, boolean | undefined>>;
  theme: ThemePayload;
  event_epoch: string;
  vapid_public_key: string | null;
}

export interface PairingCompleteBody {
  public_jwk: JsonObject;
  device_name: string;
  pairing_code: string;
  proof: SignedRequestEnvelope;
}

export interface PairingCompleteData {
  device_id: string;
  key_id: string;
  paired_at: number;
}

export interface SessionsData { sessions: readonly SessionSummary[]; }
export interface ChatData { messages: readonly ChatMessage[]; cursor: string | null; }
/** Die Absicht der Oberflaeche; die HTTP-Quelle macht daraus `SignedSendMessageBody`. */
export interface SendMessageBody { text: string; }
/**
 * v1.2: der signierte Body von `POST /sessions/:id/messages`. Er ist exakt die
 * Nahtstelle von `wb-pane-write mobil-senden` (Paket 3): Aktion, Bindung und
 * der Text als Base64 von UTF-8, keine weiteren Schluessel.
 */
export interface SignedSendMessageBody extends PaneBinding { aktion: 'mobil-senden'; text_b64: string; }
export interface SendMessageData { message_id: string; accepted_at: number; }
/** Die Absicht der Oberflaeche; die HTTP-Quelle macht daraus `SignedSendKeyBody`. */
export interface SendKeyBody { key: AllowedSpecialKey; }
/** v1.2: der signierte Body von `POST /sessions/:id/keys`; genau eine Taste der Whitelist. */
export interface SignedSendKeyBody extends PaneBinding { aktion: 'mobil-taste'; tasten: [AllowedSpecialKey]; }
export interface SendKeyData { accepted_at: number; }
export interface PromptData { prompt: Prompt | null; }
/** Die Absicht der Oberflaeche; die HTTP-Quelle macht daraus Query plus signierten Body. */
export interface PromptAnswerBody { fingerprint: string; option_id: string; text?: string; }
/**
 * v1.3: Fingerprint und Options-ID der Antwort stehen in der SIGNIERTEN Query
 * (der Umschlag bindet Methode, Pfad und sortierte Queryparameter), weil der
 * Body dem Pruefprogramm gehoert.
 */
export interface PromptAnswerQuery { fingerprint: string; option_id: string; text?: string; }
/**
 * v1.3: der signierte Body von `POST /sessions/:id/prompt-answer` fuer einen
 * Harness, der mit Pane-Tasten antwortet. Er ist exakt die Nahtstelle von
 * `wb-pane-write mobil-taste` (Paket 3), nur mit der vollen gemessenen Folge
 * statt einer einzelnen Taste. Ein Harness mit eigenem Antwortweg (OpenCode)
 * sendet stattdessen einen leeren Body.
 */
export interface SignedPromptAnswerBody extends PaneBinding { aktion: 'mobil-taste'; tasten: readonly AllowedSpecialKey[]; }
export interface PromptAnswerData { accepted_at: number; }
export interface ApprovalsData { approvals: readonly Approval[]; }
export interface DecisionBody { decision: Decision; reason: string; }
export interface DecisionData { decided_at: number; }
export interface CreateSessionBody {
  directory: string;
  name: string;
  machine: MachineId;
  harness: string;
  model: string;
}
export interface CreateSessionData { session: SessionSummary; }
export interface ResumeSessionData { session: SessionSummary; }
export interface CloseSessionData { accepted_at: number; }

/** Auswahlwerte fuer den mobilen Startdialog. Paket 5 projiziert sie aus `awb:sitz-wahl-daten`. */
export interface StartModelOption extends JsonObject { id: string; name: string; }
export interface StartHarnessOption extends JsonObject { id: string; name: string; modelle: StartModelOption[]; }
export interface StartMachineOption extends JsonObject { id: MachineId; name: string; erreichbar: boolean; }
export interface StartOptionsData extends JsonObject {
  /** Absolutpfade, die der Kern als Vorschlaege kennt; die Endpruefung bleibt `sessionAnlegen()`. */
  ordner: string[];
  maschinen: StartMachineOption[];
  harnesses: StartHarnessOption[];
}

/** Der Teil der Welten-Nutzlast, den die PWA heute tolerant liest. */
export interface AgentsMessageData extends JsonObject {
  id: string; von: string; text: string; zeit: string | number; von_mensch: boolean;
}
export interface AgentsWorldData extends JsonObject {
  id: string; name: string; maschine: string; fern: boolean;
  verbindung: JsonObject; hauptagent: string | null;
  agenten: JsonObject[]; tickets: JsonObject[]; fragen: JsonObject[];
  kanal: AgentsMessageData[]; zaehler: JsonObject;
}
export interface AgentsWeltenData extends JsonObject { welten: AgentsWorldData[]; }
/**
 * `GET /agents` ist die vorhandene `AufgabenNutzlast`: deren verschachteltes
 * `welten` bleibt absichtlich in Kernform. Ein eventuelles
 * `mensch_absender` bleibt ein untypisiertes Zusatzfeld des offenen Objekts,
 * bis WeltenQuelle den Herkunftsbeleg selbst auswertet.
 */
export interface AgentsData extends JsonObject {
  welten: AgentsWeltenData;
}

/**
 * Die Abnahmegruende des Kerns (`APPROVE_REASONS` in `shell/agents_data.py`).
 * `teilweise` verlangt dort zusaetzlich eine Bemerkung.
 */
export type TicketApproveReason = 'erledigt' | 'teilweise';

export const TICKET_APPROVE_REASONS: readonly TicketApproveReason[] = ['erledigt', 'teilweise'];

export type AgentAction =
  /** Eine Direktnachricht geht immer an genau einen Agenten. */
  | { type: 'message.send'; world_id: string; text: string; recipient?: string }
  | { type: 'question.answer'; question_id: string; answer: string }
  /** Der verifizierte Mobilaufruf nimmt die Frage zurueck; kein Clientfeld darf einen anderen Absender behaupten. */
  | { type: 'question.withdraw'; question_id: string; reason?: string }
  /** Ziel und Fertig-Kriterium sind getrennt; ohne Empfaenger bleibt die vom Kern vorgesehene Triage moeglich. */
  | { type: 'assignment.create'; world_id: string; title: string; goal?: string; done_when?: string; recipient?: string; /** @deprecated V1-Freitext, wird von v1.1-Servern nicht mehr ausgefuehrt. */ body?: string }
  | { type: 'ticket.accept'; ticket_id: string; recipient?: string }
  | { type: 'ticket.redirect'; ticket_id: string; recipient: string; reason?: string }
  | { type: 'ticket.scope'; ticket_id: string; deadline?: string; rounds?: number; /** @deprecated Kein Kernfeld; v1.1 verwendet Frist/Runden. */ scope?: string }
  | { type: 'ticket.review'; ticket_id: string; reviewer?: string; /** @deprecated Kein Kernfeld; v1.1 verwendet Prüfer. */ verdict?: string }
  /**
   * v1.6: Verwerfen mit den beiden restlichen Kernfeldern. `duplicate_of` ist
   * beim Grund `duplikat` Pflicht -- der Kern verlangt das Ticket, von dem es
   * ein Duplikat ist, und prueft, dass es in derselben Welt liegt --, sonst
   * optional; `note` ist die Bemerkung, die im Verlauf steht. Bis v1.5 fehlten
   * beide Felder, weshalb der Grund `duplikat` vom Handy aus nicht waehlbar war.
   */
  | { type: 'ticket.reject'; ticket_id: string; reason: string; duplicate_of?: string; note?: string }
  | { type: 'ticket.return'; ticket_id: string; reason: string }
  /**
   * v1.4: Die endgueltige Abnahme durch den Menschen. Die Felder sind genau
   * die von `wb-ticket abnehmen`: Grund (Pflicht), Bemerkung (Pflicht bei
   * `teilweise`) und die Bestaetigung der Definition of Done, die der Kern
   * verlangt, sobald die Welt eine hat.
   */
  | { type: 'ticket.approve'; ticket_id: string; reason: TicketApproveReason; note?: string; dod_confirmed?: boolean };

export interface AgentActionData extends JsonObject {}

/**
 * v1.8: der Body von `POST /sessions/:id/notify`. `active: true` setzt den
 * Wartewunsch „Bescheid geben“ (bis zum ersten ausgeloesten Push, hoechstens
 * 12 Stunden), `false` nimmt ihn zurueck.
 */
export interface NotifyBody { active: boolean; }
/** Antwort auf `POST /sessions/:id/notify`: bis wann der Wunsch gilt (null = keiner). */
export interface SessionNotifyData extends JsonObject { session_id: string; notify_until: number | null; }

export type NotificationEventType =
  | 'orchestrator.waiting'
  | 'worker.done'
  | 'command.blocked'
  | 'session.lost'
  | 'worker.stalled';

export interface Notification {
  id: string;
  type: NotificationEventType;
  source: Source;
  machine: MachineId;
  target_id: string;
  created_at: number;
  text: string;
}

export interface NotificationsData { notifications: readonly Notification[]; cursor: string | null; }
export interface PushSubscriptionBody { subscription: JsonObject; }
export interface PushSubscriptionData { subscription_id: string; }

export type SseEventType =
  | 'session.changed'
  | 'chat.changed'
  | 'prompt.changed'
  | 'approval.changed'
  | 'agents.changed'
  | 'notification.changed'
  | 'capability.changed'
  | 'server.reset'
  | 'heartbeat';

export interface SseEvent {
  id: `${string}:${string}:${string}`;
  type: SseEventType;
  machine: MachineId;
  source: Source;
  api_version: string;
  server_build: string;
  ids: readonly string[];
}

export type AllowedSpecialKey =
  | 'Enter' | 'Escape' | 'C-c' | 'Tab' | 'Space' | 'Up' | 'Down' | 'Left' | 'Right';

export const ALLOWED_SPECIAL_KEYS: readonly AllowedSpecialKey[] = [
  'Enter', 'Escape', 'C-c', 'Tab', 'Space', 'Up', 'Down', 'Left', 'Right',
];

/** Dieselbe Obergrenze, die `wb-pane-write` fuer eine `mobil-taste`-Folge zulaesst. */
export const MAX_MOBILE_KEY_SEQUENCE = 64;

/** Alle Endpunkte aus Abschnitt 3.1, einschließlich des SSE-Stroms aus 3.2. */
export interface MobileEndpoints {
  'POST /pairings/complete': { body: PairingCompleteBody; data: PairingCompleteData };
  'GET /bootstrap': { body: never; data: BootstrapData };
  'GET /sessions': { body: never; data: SessionsData };
  'GET /sessions/:id/chat': { query: { cursor?: string }; body: never; data: ChatData };
  'POST /sessions/:id/messages': { body: SignedSendMessageBody; data: SendMessageData };
  'POST /sessions/:id/keys': { body: SignedSendKeyBody; data: SendKeyData };
  'GET /sessions/:id/prompt': { body: never; data: PromptData };
  'POST /sessions/:id/prompt-answer': { query: PromptAnswerQuery; body: SignedPromptAnswerBody | never; data: PromptAnswerData };
  'GET /approvals': { body: never; data: ApprovalsData };
  'POST /approvals/requests/:id/decision': { body: DecisionBody; data: DecisionData };
  'POST /approvals/guards/:id/decision': { body: DecisionBody; data: DecisionData };
  'POST /sessions': { body: CreateSessionBody; data: CreateSessionData };
  'POST /sessions/:id/resume': { body: never; data: ResumeSessionData };
  'POST /sessions/:id/close': { body: never; data: CloseSessionData };
  'POST /sessions/:id/notify': { body: NotifyBody; data: SessionNotifyData };
  'GET /session-options': { body: never; data: StartOptionsData };
  'GET /agents': { body: never; data: AgentsData };
  'POST /agents/actions': { body: AgentAction; data: AgentActionData };
  'GET /notifications': { query: { cursor?: string }; body: never; data: NotificationsData };
  'PUT /push/subscription': { body: PushSubscriptionBody; data: PushSubscriptionData };
  'DELETE /push/subscription/:id': { body: never; data: undefined };
  'GET /events': { body: never; event: SseEvent };
}

export type EndpointName = keyof MobileEndpoints;

/**
 * Abschnitt 10 Punkt 12: Nur exakt gemeinsam ausgerollte API- und
 * Buildkennungen duerfen mutieren. Sonst bleibt die Anzeige lesend nutzbar.
 */
export type CompatibilityDecision = 'compatible' | 'read_only_update_required';

export interface CompatibilityResult {
  decision: CompatibilityDecision;
  mutations_allowed: boolean;
  reason: string;
}

export interface ContractVersion {
  api_version: string;
  build: string;
}
