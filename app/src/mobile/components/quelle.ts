/**
 * DIE DATENSCHNITTSTELLE DER SICHTBAREN PWA (Bauplan Paket 9).
 *
 * Die Oberflaeche spricht ausschliesslich mit diesem Interface. Jede Methode
 * entspricht einem Endpunkt aus `mobile-shared/vertrag.ts` und liefert dessen
 * `ApiResponse`, damit die spaetere HTTP-Fassung (Pakete 2, 4 und 8) dieselbe
 * Form ohne Umbau einsetzen kann. Bis dahin liefert `attrappe/quelle.ts`
 * realistische Daten.
 *
 * Lokale Geräte- und Pushzustände bleiben clientseitig. Startoptionen kommen
 * seit Vertragsnachtrag v1.1 aus dem gemeinsamen Vertrag.
 */
import type {
  AgentAction,
  AgentActionData,
  AgentsData,
  ApiResponse,
  ApprovalsData,
  BootstrapData,
  ChatData,
  CloseSessionData,
  CreateSessionBody,
  CreateSessionData,
  DecisionBody,
  DecisionData,
  MachineId,
  NotificationsData,
  NotifyBody,
  PairingCompleteData,
  PromptAnswerBody,
  PromptAnswerData,
  PromptData,
  ResumeSessionData,
  SendKeyBody,
  SendKeyData,
  SendMessageBody,
  SendMessageData,
  StartOptionsData,
  SessionNotifyData,
  SessionsData,
  SseEvent,
} from '../../mobile-shared/vertrag';

/** Eine konfigurierte API-Origin und ob sie zuletzt geantwortet hat (Spezifikation 2.3). */
export interface MaschinenStand {
  machine: MachineId;
  /** Anzeigename, z. B. „Mac“ oder „peer“. */
  name: string;
  origin: string;
  erreichbar: boolean;
  /** Seit wann nicht erreichbar, sonst null. */
  seit: number | null;
  /** Zeitpunkt der letzten erfolgreichen Antwort. */
  zuletzt: number | null;
  server_build: string | null;
  api_version: string | null;
}

/** Lokaler Kopplungszustand aus IndexedDB (Spezifikation 4.1); kein Schluesselmaterial. */
export interface KopplungsStand {
  gekoppelt: boolean;
  geraet: string | null;
  device_id: string | null;
  seit: number | null;
}

export interface KoppelnWunsch {
  pairing_code: string;
  device_name: string;
}

/** Auswahl fuer „Neue Sitzung“, vom HTTP-Endpunkt bereits auf dessen `data` projiziert. */
export type StartOptionen = StartOptionsData;

export type PushErlaubnis = 'erteilt' | 'verweigert' | 'offen' | 'nicht_moeglich';

/** Push-Berechtigung und Registrierung; die Umsetzung gehoert zu Paket 8. */
export interface PushStand {
  erlaubnis: PushErlaubnis;
  /** Warum Push nicht moeglich ist (z. B. nicht als Home-Bildschirm-App gestartet). */
  grund: string | null;
}

export type Freigabeart = 'request' | 'guard';

/** Eine Origin, die zu einem Zwischenstand schon geantwortet hat, und die Maschine, als die sich ihr Server meldet. */
export interface Teilherkunft {
  readonly origin: string;
  readonly machine: MachineId;
}

/**
 * Lesewege ueber mehrere Origins rufen dies mit dem jeweils zusammengefuehrten
 * Stand, sobald eine Antwort dazukommt -- vor dem Ergebnis und danach, wenn
 * eine schlafende Origin wieder antwortet. Eine Quelle mit nur einer Antwort
 * ruft es nie. `geantwortet` nennt die Origins, deren Daten im Zwischenstand
 * stecken: Eintraege anderer Maschinen fehlen darin, weil diese noch nicht
 * geantwortet haben, nicht weil es sie nicht mehr gibt.
 */
export type Nachreichen<T> = (zwischenstand: ApiResponse<T>, geantwortet?: readonly Teilherkunft[]) => void;

/**
 * Antwort der Quelle, wenn der Geraetespeicher (IndexedDB) das Signieren verhindert.
 * Es ist kein Netzfehler: es ging nie eine Anfrage an einen Server.
 */
export const GERAETESPEICHER_MELDUNG = 'Der Gerätespeicher antwortet nicht. Schließe die App ganz und öffne sie neu.';

/**
 * Der Mac hat die Kopplung angenommen, das Telefon konnte den Schluessel aber nicht speichern. Der Server
 * kennt dann ein aktives Geraet, das diese App nie nutzen kann; die Meldung sagt, wie man weiterkommt.
 */
export const KOPPLUNG_SPEICHER_MELDUNG = 'Die Kopplung ist am Mac angekommen, aber dieses Gerät konnte seinen Schlüssel nicht speichern. Schließe die App ganz, öffne sie neu und kopple noch einmal. Den überzähligen Eintrag kannst du in der Werkbank widerrufen.';

/**
 * Kennung einer Speicherstoerung an einer Fehlerantwort. Sie entsteht nur im Client (die Quelle
 * setzt sie), kommt nie vom Server und ist ein Symbol: JSON und die Vertragsvalidierung (die nur
 * Textschluessel kennen) sehen sie nicht, ein Objekt-Spread behaelt sie. Kein neuer Vertragscode.
 */
export const GERAETESPEICHER_KENNUNG: unique symbol = Symbol('awb.geraetespeicher');

export function geraetespeicherMarkieren<T extends object>(antwort: T): T {
  return Object.assign(antwort, { [GERAETESPEICHER_KENNUNG]: true });
}

export function istGeraetespeicherStoerung(antwort: object): boolean {
  return (antwort as Record<symbol, unknown>)[GERAETESPEICHER_KENNUNG] === true;
}

export interface MobileQuelle {
  /** Kurzname fuer Diagnose und Versionszeile. */
  readonly name: string;
  readonly client_build: string;

  kopplung(): Promise<KopplungsStand>;
  koppeln(wunsch: KoppelnWunsch): Promise<ApiResponse<PairingCompleteData>>;

  maschinen(): Promise<readonly MaschinenStand[]>;
  bootstrap(): Promise<ApiResponse<BootstrapData>>;

  sitzungen(nachgereicht?: Nachreichen<SessionsData>): Promise<ApiResponse<SessionsData>>;
  chat(sessionId: string, cursor?: string): Promise<ApiResponse<ChatData>>;
  senden(sessionId: string, body: SendMessageBody): Promise<ApiResponse<SendMessageData>>;
  taste(sessionId: string, body: SendKeyBody): Promise<ApiResponse<SendKeyData>>;
  prompt(sessionId: string): Promise<ApiResponse<PromptData>>;
  promptAntworten(sessionId: string, body: PromptAnswerBody): Promise<ApiResponse<PromptAnswerData>>;

  freigaben(nachgereicht?: Nachreichen<ApprovalsData>): Promise<ApiResponse<ApprovalsData>>;
  entscheiden(art: Freigabeart, id: string, body: DecisionBody): Promise<ApiResponse<DecisionData>>;

  startOptionen(): Promise<StartOptionen>;
  sitzungAnlegen(body: CreateSessionBody): Promise<ApiResponse<CreateSessionData>>;
  fortsetzen(sessionId: string): Promise<ApiResponse<ResumeSessionData>>;
  schliessen(sessionId: string): Promise<ApiResponse<CloseSessionData>>;
  /** Vertrag 1.8: Wartewunsch „Bescheid geben“ (`POST /sessions/:id/notify`) an die Origin der Sitzung. */
  bescheid(sessionId: string, body: NotifyBody): Promise<ApiResponse<SessionNotifyData>>;

  agents(): Promise<ApiResponse<AgentsData>>;
  agentAktion(aktion: AgentAction): Promise<ApiResponse<AgentActionData>>;

  meldungen(cursor?: string, nachgereicht?: Nachreichen<NotificationsData>): Promise<ApiResponse<NotificationsData>>;
  push(): Promise<PushStand>;
  pushAnfragen(): Promise<PushStand>;

  /** Ereignisstrom (Spezifikation 3.2). Rueckgabe beendet das Abo. */
  abonnieren(bei: (ereignis: SseEvent) => void): () => void;
  /**
   * Wie `abonnieren`, aber der Strom einer Origin startet erst, sobald sie nach
   * dem Aufruf geantwortet hat, spaetestens mit `spaetestens`. Optional: ohne
   * diese Methode abonniert der Stand wie bisher am Ende des Abgleichs.
   */
  abonnierenAb?(bei: (ereignis: SseEvent) => void, spaetestens: Promise<void>): () => void;
  /**
   * Die Origin, von der eine Freigabe zuletzt kam (Freigaben tragen kein
   * Maschinenfeld). Optional: ohne sie ersetzt jeder Zwischenstand der
   * Freigaben die ganze Liste.
   */
  freigabeHerkunft?(id: string): string | null;
}

/** Die Maschine aus einer globalen Sitzungskennung `{machine}:{session-id}`. */
export function maschineVon(globalId: string): MachineId {
  const i = globalId.indexOf(':');
  return i > 0 ? globalId.slice(0, i) : globalId;
}
