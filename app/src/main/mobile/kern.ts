// DER MOBILE DIENST IM KERN (Paket 10 der mobilen Werkbank, Spezifikation 2.1).
//
// Eine Stelle setzt zusammen, was die Pakete 2 bis 8 einzeln gebaut haben:
// Geraeteauthentisierung, HTTP-Server mit Ereignisring, die Adapter fuer
// Sitzungen, Chat, Freigaben, Startoptionen und Agents, das Meldungsjournal mit
// Web Push und die ausgelieferte PWA-Huelle. main.ts reicht nur die vorhandenen
// Kernfunktionen herein (modellLesen, chatStand, sessionAnlegen, ...) und haengt
// Start und Stopp an seinen Lebenslauf. Derselbe Baustein laeuft deshalb in der
// Electron-Fassung, im Kern des Mac-Mantels -- beide sind dieser Prozess -- und
// in einer reinen Node-Probe ohne Electron (app/test/mobile/kern/).
//
// WAS HIER BEWUSST NICHT GEHT:
//   * Kopplung starten und Geraete widerrufen haben KEINE Route -- weder HTTP
//     noch Steuerkanal. `koppelnStarten()`/`widerrufen()` ruft main.ts nur aus
//     dem lokalen Mensch-Weg (echter Klick + `wb-mensch`).
//   * Keine Anfrage ohne Geraetesignatur, auch nicht von 127.0.0.1; es gibt
//     keinen Schalter dafuer (der Server kennt keinen).
//   * Rueckfrage-Dialoge bleiben `capability_unavailable`, bis Paket 6 einen
//     gemessenen Adapter registriert (`mobilDialogeRegistrieren`).
import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { validateNotifyBody, validatePairingCompleteBody, validateSignedPromptAnswerBody } from '../../mobile-shared/validierung';
import type {
  AllowedSpecialKey, BootstrapData, JsonValue, MobileCapability, NotificationEventType, PaneBinding, Prompt,
  PromptOption, SessionNotifyData, SignedRequestEnvelope, SseEventType,
} from '../../mobile-shared/vertrag';
import { werkzeugTeile } from '../../chat/leser';
import { MobileAuthError, MobileAuthenticator } from './auth/auth';
import type { DeviceRecord, PairingStart } from './auth/auth';
import { createMobileHttpServer } from './http/server';
import type { MobileHttpServer, MobileRouteHandlers, MobileRouteRequest, StaticShellResponse } from './http/server';
import type { MobileEventBroker } from './events/ereignisse';
import { createSessionHandlers } from './adapters/sessions';
import type { MobileSessionRecord, SessionsForMobile } from './adapters/sessions';
import { createChatHandlers, mobilAblehnung, paneWriteFailure, paneWriteMeldung } from './adapters/chat';
import { claudeDialogBlocksInput, parseClaudeDialog } from './dialogs/claude';
import type { ClaudeDialogsForMobile, ClaudePaneSnapshot } from './dialogs/claude';
import type { MobileDialogSession } from './dialogs/opencode';
import type { ChatForMobile, MobilePaneWriteCall, MobilePaneWriteResult } from './adapters/chat';
import { createApprovalHandlers } from './adapters/approvals';
import type { ApprovalsForMobile } from './adapters/approvals';
import { createSessionOptionsHandlers, mobileTheme } from './adapters/optionen';
import type { OptionsForMobile } from './adapters/optionen';
import { createAgentsHandlers } from './adapters/agents';
import type { AufgabenQuelleForMobile } from './adapters/agents';
import { MobilePushService } from './push/service';
import type { WorkerFertigFelder } from './push/dringend';
import { replikationBauen, replikZiele } from './replikation';
import type { ReplikKonfig, Replikation } from './replikation';

/** Platzhalter in `index.html`, den der Server beim Ausliefern durch die konfigurierten Origins ersetzt. */
export const ORIGINS_PLATZHALTER = '__AWB_MOBILE_ORIGINS__';

export interface MobilKonfig {
  /** `127.0.0.1:<port>`; 0 nur in Tests. */
  readonly port: number;
  /** Beide vollstaendigen API-Origins (Mac und peer), aus der Konfiguration. */
  readonly origins: readonly string[];
  /** Die Origin DIESES Hosts; sie ist die Audience jeder hier angenommenen Signatur. */
  readonly origin: string;
  /**
   * Die Tailscale-Anmeldung (`Tailscale-User-Login`), fuer die eine Kopplung
   * gilt (Spezifikation 4.1 Punkt 3). Leer = Kopplung ist abgelehnt.
   */
  readonly betreiber: string;
  /** `config.machine`: Maschine in ApiMeta, Ereignis-IDs und globalen Sitzungskennungen. */
  readonly machine: string;
  /** Buildkennung; muss der der ausgelieferten PWA gleichen, sonst bleibt die App lesend. */
  readonly serverBuild: string;
  /** Zustand der Geraeteauthentisierung; Vorgabe wie `wb-mobil-pruefen`: ~/.claude/workbench/mobile. */
  readonly authVerzeichnis?: string;
  /** Meldungsjournal und Push-Abos (0600-Datei darin). */
  readonly pushVerzeichnis: string;
  /** 0600-VAPID-Datei; leer = kein Web Push (das Journal laeuft trotzdem). */
  readonly vapidDatei: string;
  /** `dist/mobile` des Builds; leer oder fehlend = keine Huelle (nur API). */
  readonly huellenVerzeichnis: string;
  readonly heartbeatMs?: number;
  /**
   * Automatische Replikation von Geraeteregister und Origin nach Kopplung und
   * Widerruf (replikation.ts). Fehlt der Schluessel, repliziert dieser Host nicht --
   * so laeuft sie nur auf der Quelle (Mac), nie zurueck. `maschinen` ist
   * `remoteMachines` OHNE Abzug der pausierten (die Pause gilt der Anzeige, nicht
   * der Weitergabe); `pausiert` markiert nur, welche davon pausiert sind, damit
   * das Protokoll es sagt. Die Ziele kommen aus `origins` ohne die eigene.
   */
  readonly replikation?: Omit<ReplikKonfig, 'authVerzeichnis' | 'ziele' | 'protokoll'> & { readonly maschinen: readonly string[]; readonly pausiert?: readonly string[] };
}

export interface MobilKernQuellen {
  readonly sitzungen: Omit<SessionsForMobile, 'localMachine'>;
  readonly chat: Omit<ChatForMobile, 'localMachine' | 'envelope' | 'tool'>;
  readonly freigaben: ApprovalsForMobile;
  readonly optionen: OptionsForMobile;
  readonly agents: AufgabenQuelleForMobile;
  /** Protokollzeile (stderr des Kerns); nie Schluessel-, Code- oder Signaturmaterial. */
  readonly protokoll?: (zeile: string) => void;
}

export type MobilDialogRouten = Required<Pick<MobileRouteHandlers, 'GET /sessions/:id/prompt' | 'POST /sessions/:id/prompt-answer'>>;

/** Was Paket 6 je gemessenem Harness registriert. */
/**
 * Warum der Nachrichtenweg gesperrt ist oder frei war (Protokoll, nie Schirminhalt).
 * `kein-pane`: keine lokale Sitzung mit Pane; `version-leer`: laufende CLI-Version nicht gemessen;
 * `aufnahme-leer`: Pane-Aufnahme fehlgeschlagen oder leer; `dialog`/`unsupported`: Dialog
 * erkannt bzw. nicht gemessen; `fehler`: unerwarteter Fehler in der Messung (fail closed).
 */
export type MobilSperrGrund = 'kein-pane' | 'version-leer' | 'aufnahme-leer' | 'dialog' | 'unsupported' | 'fehler' | 'frei';

export interface MobilEingabeRiegel {
  readonly gesperrt: boolean;
  readonly grund: MobilSperrGrund;
  /** Pane der Sitzung, soweit gemessen; leer sonst. */
  readonly pane: string;
}

const SPERRGRUND_TEXT: Record<MobilSperrGrund, string> = {
  'kein-pane': 'Kein Pane gefunden',
  'version-leer': 'Version leer',
  'aufnahme-leer': 'Aufnahme leer (capture fehlgeschlagen)',
  dialog: 'Dialog offen',
  unsupported: 'Dialog nicht gemessen',
  fehler: 'Pruefung fehlgeschlagen',
  frei: 'frei',
};

/**
 * Die Grundermittlung des Claude-Riegels aus einer Messung: `null` = kein lokales
 * Pane, sonst die laufende CLI-Version und der Text der Pane-Aufnahme. Dieselben
 * Faelle sperren wie `claudeDialogBlocksInput` (fail closed), nur dass der Grund
 * benannt bleibt.
 */
export function claudeSperrGrund(messung: { readonly version: string; readonly text: string } | null): MobilSperrGrund {
  if (messung === null) return 'kein-pane';
  if (messung.version === '') return 'version-leer';
  if (messung.text === '') return 'aufnahme-leer';
  const zustand = parseClaudeDialog(messung.text).state;
  if (zustand === 'none') return 'frei';
  return zustand === 'unsupported' ? 'unsupported' : 'dialog';
}

/** Eine Messung als Adapter-Schnappschuss, nur wenn Version und Aufnahme gemessen sind. */
export function claudeAufnahme(messung: ClaudePaneSnapshot | null): ClaudePaneSnapshot | null {
  return messung && messung.version && messung.text ? messung : null;
}

/**
 * Der Riegel des Nachrichtenweges fuer einen Claude-Pane, mit Grund. Die Sperre selbst
 * bleibt `claudeDialogBlocksInput` (dieselben Faelle, fail closed); die Aufnahme, die sie
 * benutzt, wird nur mitgeschnitten, damit der Grund daraus folgt -- eine Messung je Anfrage.
 * `messen` liefert Version, Pane und Aufnahme der Sitzung, `null` ohne lokales Pane.
 */
export async function claudeEingabeRiegel(
  quelle: ClaudeDialogsForMobile,
  messen: (sitzung: MobileDialogSession) => ClaudePaneSnapshot | null,
  sessionId: string,
): Promise<MobilEingabeRiegel> {
  const gemessen: { messung?: ClaudePaneSnapshot | null } = {};
  try {
    const gesperrt = await claudeDialogBlocksInput({
      ...quelle,
      claudePane: (sitzung) => {
        const messung = messen(sitzung);
        gemessen.messung = messung;
        return claudeAufnahme(messung);
      },
    }, sessionId);
    if (gemessen.messung === undefined) return { gesperrt: true, grund: 'fehler', pane: '' };
    return { gesperrt, grund: claudeSperrGrund(gemessen.messung), pane: gemessen.messung?.pane ?? '' };
  } catch {
    // Fail closed (Sicherheits-Review 2026-09-21, Befund H1, zweiter Fehlerpfad):
    // Spiegel, anderer Harness und verschwundene Sitzung beantwortet
    // `claudeDialogBlocksInput` selbst mit `false`, ohne zu werfen. Was HIER ankommt,
    // ist ein unerwarteter Fehler (etwa ein gescheitertes `spawnSync`) -- und dann ist
    // unbekannt, ob gerade ein Dialog offen steht. Gemessen in Paket 6b: eine Nachricht
    // bei offenem Dialog beantwortet ihn mit Option 1, bei einer Berechtigungsfrage also
    // mit „Yes". Unbekannt heisst deshalb gesperrt; der Nachrichtenweg meldet
    // `pane_busy`, und die Sondertasten bleiben der Weg, den Dialog zu schliessen.
    return { gesperrt: true, grund: 'fehler', pane: '' };
  }
}

export interface MobilDialogAdapter {
  readonly faehigkeiten: readonly Extract<MobileCapability, `prompt.answer.${string}`>[];
  readonly handlers: MobilDialogRouten;
  /**
   * Die Harnesses, deren Antwort als signierter `mobil-taste`-Umschlag in den
   * Pane geht (Claude). Nur fuer sie traegt `GET …/prompt` die Tastenfolge je
   * Option, und nur bei ihnen verbraucht `wb-mobil-pruefen` den Umschlag.
   */
  readonly tastenHarnesse?: readonly string[];
  /**
   * DIESELBEN Routen auf EINER eingefrorenen Pane-Aufnahme, mit einem `sendKeys`,
   * das nur aufzeichnet. Damit fuellt der Kern `PromptOption.keys`, ohne eine
   * Taste zu senden und ohne die Tabelle des Adapters nachzubauen: die Folge
   * kommt aus dem Adapter selbst, aus derselben Aufnahme wie der Fingerprint.
   */
  readonly probeRouten?: (aufzeichnen: (tasten: readonly AllowedSpecialKey[]) => void) => MobilDialogRouten;
  /**
   * Gemessen (Paket 6b): eine eingefuegte Nachricht bei offenem Claude-Dialog
   * beantwortet den Dialog mit Option 1. Solange das hier wahr ist, nimmt
   * `POST /sessions/:id/messages` fuer diese Sitzung keinen Text an. Der Riegel
   * nennt zusaetzlich den Grund, damit das Protokoll sagt, warum er zugemacht hat.
   */
  readonly eingabeGesperrt?: (sessionId: string) => Promise<MobilEingabeRiegel> | MobilEingabeRiegel;
}

/**
 * DIE REGISTRIERUNGSSTELLE FUER PAKET 6 (Harnessdialoge). Bis hier ein gemessener
 * Adapter steht, bleiben `GET /sessions/:id/prompt` und `POST …/prompt-answer`
 * `capability_unavailable`, und `prompt.answer.*` ist in `GET /bootstrap` false.
 * Die Stelle gehoert dem Modul, nicht einem Dienst: der Server kann ueber den
 * Schalter `mobileServer` beendet und neu gebaut werden, ein registrierter
 * Adapter gilt fuer jeden. Paket 6 ruft sie einmal beim Kernstart (main.ts).
 */
let dialogAdapter: MobilDialogAdapter | null = null;
const dialogHoerer = new Set<() => void>();
export function mobilDialogeRegistrieren(adapter: MobilDialogAdapter | null): void {
  dialogAdapter = adapter;
  for (const h of dialogHoerer) h();
}

export interface GeraetKurz {
  readonly device_id: string;
  readonly device_name: string;
  readonly status: DeviceRecord['status'];
  readonly paired_at: number;
  readonly revoked_at: number | null;
  readonly audiences: readonly string[];
}

export interface MobilDienst {
  readonly events: MobileEventBroker;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  /** NUR aus dem lokalen Mensch-Weg in main.ts. Der Code verlaesst den Kern nur zur Anzeige am Mac. */
  koppelnStarten(): PairingStart;
  geraete(): readonly GeraetKurz[];
  /** NUR aus dem lokalen Mensch-Weg in main.ts. */
  widerrufen(deviceId: string): boolean;
  /** Takt des Kerns: meldet geaenderte Sitzungen und Chats als Ereignis. */
  sitzungenGesehen(sitzungen: readonly MobileSessionRecord[]): void;
  /** Takt des Kerns: die Schluessel der offenen Antraege und wartenden Guards. */
  freigabenGesehen(schluessel: readonly string[]): void;
  agentsGeaendert(): void;
  /**
   * Die fuenf Push-Ausloeser (Spezifikation 6), an die Kernwaechter gebunden.
   * `worker` nur bei `worker.done`: die gezaehlten Felder fuer push/dringend.ts.
   */
  melden(typ: NotificationEventType, zielId: string, zustand: string, worker?: WorkerFertigFelder): void;
}

const INHALTSARTEN: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * Nur Dateien, die beim Start im Build-Ordner lagen -- kein Pfad aus der Anfrage
 * erreicht das Dateisystem. Gelesen wird der INHALT beim Start, nicht erst bei
 * der Anfrage: der Kern liefert genau den Bau aus, mit dem er gestartet ist.
 * ANLASS (09.10.2026, „schwarzer Bildschirm“ am iPhone): gemerkt waren nur die
 * Pfade. Nach einem `npm run build` ohne App-Neustart lieferte der Kern die
 * NEUE index.html, deren app.<hash>.js er nicht kannte (404) -- die App blieb
 * schwarz, bis die Werkbank.app neu startete.
 */
function huelleLesen(verzeichnis: string): Map<string, Buffer> {
  const dateien = new Map<string, Buffer>();
  if (!verzeichnis) return dateien;
  const gehen = (ordner: string): void => {
    let eintraege: string[];
    try {
      eintraege = readdirSync(ordner);
    } catch {
      return;
    }
    for (const name of eintraege) {
      const pfad = join(ordner, name);
      const art = lstatSync(pfad);
      if (art.isSymbolicLink()) continue;
      if (art.isDirectory()) gehen(pfad);
      else if (art.isFile() && INHALTSARTEN[extname(name)]) dateien.set(`/${relative(verzeichnis, pfad).split(sep).join('/')}`, readFileSync(pfad));
    }
  };
  gehen(verzeichnis);
  return dateien;
}

/**
 * Der Weg zu `wb-pane-write -L <socket> mobil-senden|mobil-taste %<n>`: der
 * Umschlag geht nur ueber stdin, nichts steht in argv ausser Socket, Befehl und
 * Pane. Frist 30 s (Paket 3: 10 s stdin, 15 s Pruefprogramm, dazu tmux).
 */
export function paneWriteUeber(bin: string, fristMs = 30_000): (call: MobilePaneWriteCall) => Promise<MobilePaneWriteResult> {
  return (call) => new Promise((resolve) => {
    const argv = [...(call.socketName ? ['-L', call.socketName] : []), call.command, call.pane];
    const kind = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let fertig = false;
    const ende = (status: number | null): void => {
      if (fertig) return;
      fertig = true;
      clearTimeout(uhr);
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const uhr = setTimeout(() => {
      kind.kill('SIGKILL');
      ende(null);
    }, fristMs);
    kind.stdout.setEncoding('utf8');
    kind.stdout.on('data', (teil: string) => { if (stdout.length < 4096) stdout += teil; });
    kind.stderr.setEncoding('utf8');
    kind.stderr.on('data', (teil: string) => { if (stderr.length < 4096) stderr += teil; });
    kind.once('error', () => ende(null));
    kind.once('close', (code) => ende(code));
    kind.stdin.once('error', () => { /* ein frueh beendetes Werkzeug schliesst stdin; sein Exit zaehlt */ });
    kind.stdin.end(call.stdin);
  });
}

/**
 * DER SIGNIERTE WEG EINER KNOPFANTWORT (Spezifikation 4.3, Entscheidung vom
 * 2026-09-21). Die App signiert genau den Body, den `wb-mobil-pruefen` fuer
 * `mobil-taste` verlangt -- die vom Adapter abgeleitete Tastenfolge samt
 * Bindung --, und Fingerprint und Options-ID stehen in der ebenfalls signierten
 * Query. Hier wird vor dem Senden geprueft, dass der signierte Body genau die
 * Folge traegt, die der Adapter aus seiner Fixture gelesen hat, und genau auf
 * den JETZIGEN Orchestrator-Pane zeigt. Erst dann laeuft der eine Aufruf, der
 * den Umschlag verbraucht.
 */
export interface MobilTastenAuftrag {
  readonly envelope: SignedRequestEnvelope | undefined;
  readonly rawBody: Buffer;
  /** Maschine, Socketpfad und Pane, wie der Kern sie JETZT aufloest. */
  readonly bindung: PaneBinding;
  /** Die Folge aus der Tabelle des Adapters -- nie die aus dem Body. */
  readonly tasten: readonly string[];
  readonly socketName: string;
  readonly paneWrite: (call: MobilePaneWriteCall) => Promise<MobilePaneWriteResult>;
  /** Protokoll und Sitzungskennung fuer die Zeile je abgelehnter Anfrage; ohne sie bleibt der Weg stumm. */
  readonly protokoll?: (zeile: string) => void;
  readonly sitzung?: string;
}

export async function mobilTastenSenden(auftrag: MobilTastenAuftrag): Promise<void> {
  const sitzung = auftrag.sitzung ?? '?';
  if (!auftrag.envelope) throw new MobileAuthError('capability_unavailable', 'the HTTP handler did not retain the signed mobile envelope');
  let roh: unknown;
  try {
    roh = JSON.parse(auftrag.rawBody.toString('utf8'));
  } catch {
    throw new MobileAuthError('bad_request', 'the prompt answer body is not the signed mobil-taste body');
  }
  const body = validateSignedPromptAnswerBody(roh);
  if (!body.ok) throw new MobileAuthError('bad_request', body.error);
  if (body.value.maschine !== auftrag.bindung.maschine || body.value.socket !== auftrag.bindung.socket
    || body.value.pane !== auftrag.bindung.pane) {
    mobilAblehnung(auftrag.protokoll, sitzung, auftrag.bindung.pane, 'stale_target', 'Bindung nicht am jetzigen Orchestrator-Pane');
    throw new MobileAuthError('stale_target', 'the signed pane binding does not match the current orchestrator pane');
  }
  if (body.value.tasten.length !== auftrag.tasten.length
    || body.value.tasten.some((taste, index) => taste !== auftrag.tasten[index])) {
    throw new MobileAuthError('bad_request', 'the signed key sequence is not the measured sequence of this option');
  }
  const result = await auftrag.paneWrite({
    socketName: auftrag.socketName,
    command: 'mobil-taste',
    pane: auftrag.bindung.pane,
    stdin: Buffer.from(JSON.stringify({ umschlag: auftrag.envelope, body_b64: auftrag.rawBody.toString('base64') }), 'utf8'),
  });
  if (result.status !== 0) paneWriteFailure(result, paneWriteMeldung(auftrag.protokoll, sitzung, auftrag.bindung.pane));
}

/** Fingerprint und Options-ID der Antwort stehen in der signierten Query (Vertrag 1.3). */
function promptAntwortKoerper(request: MobileRouteRequest): MobileRouteRequest {
  const einer = (name: string): string | undefined => {
    const werte = request.query[name];
    if (werte === undefined) return undefined;
    if (werte.length !== 1) throw new MobileAuthError('bad_request', `${name} must appear exactly once`);
    return werte[0];
  };
  const fingerprint = einer('fingerprint');
  const option_id = einer('option_id');
  const text = einer('text');
  if (!fingerprint || !option_id) throw new MobileAuthError('bad_request', 'fingerprint and option_id must be signed query parameters');
  return { ...request, body: { fingerprint, option_id, ...(text === undefined ? {} : { text }) } };
}

/**
 * `PromptOption.keys` fuellen, ohne eine Taste zu senden: dieselben Adapterrouten
 * auf einer eingefrorenen Aufnahme, mit einem aufzeichnenden `sendKeys`. Fuer
 * einen Harness ohne Pane-Tasten (OpenCode) bleibt die Antwort unveraendert.
 */
async function promptMitTasten(adapter: MobilDialogAdapter, request: MobileRouteRequest): Promise<{ data: JsonValue }> {
  const mitschrift: { tasten: readonly AllowedSpecialKey[] | null } = { tasten: null };
  const probe = adapter.probeRouten!((tasten) => { mitschrift.tasten = tasten; });
  const antwort = await probe['GET /sessions/:id/prompt'](request);
  const prompt = (antwort.data as unknown as { prompt: Prompt | null } | undefined)?.prompt ?? null;
  if (!prompt || !(adapter.tastenHarnesse ?? []).includes(prompt.harness)) return { data: antwort.data as JsonValue };
  const optionen: PromptOption[] = [];
  for (const option of prompt.options) {
    mitschrift.tasten = null;
    try {
      await probe['POST /sessions/:id/prompt-answer']({
        ...request, route: 'POST /sessions/:id/prompt-answer', body: { fingerprint: prompt.fingerprint, option_id: option.id },
      });
    } catch {
      // Eine Option ohne gemessene Folge bleibt ohne Tasten; die App bietet sie dann nicht an.
      mitschrift.tasten = null;
    }
    optionen.push(mitschrift.tasten ? { ...option, keys: mitschrift.tasten } : option);
  }
  return { data: { prompt: { ...prompt, options: optionen } } as unknown as JsonValue };
}

function fingerabdruck(s: MobileSessionRecord, wartewunsch: number | null): { sitzung: string; chat: string } {
  const laufend = s.workers.filter((w) => w.state === 'running').length;
  return {
    // Der Wartewunsch gehoert dazu: verbraucht ihn ein Push oder laeuft er ab,
    // erfaehrt die App es mit dem naechsten Takt.
    sitzung: [s.state, s.lastActive, s.workers.length, laufend, s.pendingApprovals, s.binding?.pane ?? '', s.name, wartewunsch ?? ''].join('\u0000'),
    // ANLASS (29.09.2026, alice im ersten echten Test): die eigene Nachricht
    // und die Antwort erschienen erst nach Verlassen und erneutem Oeffnen des
    // Chats. `lastActive` stammt aus der Sitzungsdatei und aendert sich
    // waehrend einer Antwort nicht; die Regung des Orchestrator-Panes schon --
    // bei jedem Harness, weil jeder dort schreibt.
    chat: [s.lastActive, s.chatRegung ?? ''].join('\u0000'),
  };
}

export function mobilDienstBauen(konfig: MobilKonfig, quellen: MobilKernQuellen): MobilDienst {
  const protokoll = quellen.protokoll ?? ((): void => undefined);
  const authenticator = new MobileAuthenticator(konfig.authVerzeichnis);
  const replik: Replikation | null = konfig.replikation ? replikationBauen({
    ...konfig.replikation,
    authVerzeichnis: konfig.authVerzeichnis ?? join(homedir(), '.claude', 'workbench', 'mobile'),
    ziele: replikZiele(konfig.origins, konfig.origin, konfig.replikation.maschinen, konfig.replikation.pausiert),
    protokoll,
  }) : null;
  let push: MobilePushService | null = null;
  let server: MobileHttpServer | null = null;
  let huelle = new Map<string, Buffer>();
  const gesehen = new Map<string, { sitzung: string; chat: string }>();
  let freigabenStand = '';

  const faehigkeiten = (): BootstrapData['capabilities'] => {
    const gemessen = new Set<MobileCapability>(dialogAdapter?.faehigkeiten ?? []);
    return {
      'prompt.answer.claude': gemessen.has('prompt.answer.claude'),
      'prompt.answer.codex': gemessen.has('prompt.answer.codex'),
      'prompt.answer.opencode': gemessen.has('prompt.answer.opencode'),
      'prompt.answer.pi': gemessen.has('prompt.answer.pi'),
      'approvals.request.decide': true,
      // Der Geraetebeleg reicht nicht bis wb-freigabe (herkunft.ts): Annehmen bleibt am Rechner.
      'approvals.guard.approve': false,
      'approvals.guard.reject': true,
      'sessions.create': true,
      // WeltenQuelle nimmt den gepruefte Geraetebeleg als menschlichen Absender an (herkunft.ts).
      'agents.human_sender': true,
      push: push?.publicKey() != null,
    };
  };

  const chat = createChatHandlers({
    ...quellen.chat,
    localMachine: konfig.machine,
    envelope: (request) => request.envelope ?? null,
    tool: (nachricht) => {
      const teile = werkzeugTeile(nachricht);
      return teile ? { name: teile.name, arguments_preview: teile.argumente, output_preview: teile.ausgabe } : undefined;
    },
  });

  /**
   * Wartewunsch „Bescheid geben“ (v1.8: Route `POST /sessions/:id/notify`, die
   * App schickt sie an die Origin der Maschine der Sitzung). Nur fuer eine
   * aktuelle Sitzung DIESER Maschine; setzen nur, solange sie laeuft
   * (zuruecknehmen geht immer). Die App erfaehrt den neuen Stand ueber
   * `session.changed`.
   */
  const wartewunsch = {
    setzen: async (sessionId: string, an: boolean): Promise<number | null> => {
      if (!push) throw new MobileAuthError('capability_unavailable', 'mobile service is not started');
      const treffer = (await quellen.sitzungen.fresh()).filter((sitzung) => sitzung.id === sessionId);
      if (treffer.length !== 1) throw new MobileAuthError('stale_target', 'session is no longer current');
      if (treffer[0].machine !== konfig.machine) {
        throw new MobileAuthError('capability_unavailable', 'a notify request is only accepted by the machine of the session');
      }
      if (an && treffer[0].state !== 'running' && treffer[0].state !== 'attention') {
        throw new MobileAuthError('stale_target', 'a notify request needs a running session');
      }
      const bis = push.wartewunschSetzen(sessionId, an);
      veroeffentlichen('session.changed', [sessionId]);
      return bis;
    },
  };

  const handlers: MobileRouteHandlers = {
    ...createSessionHandlers({
      ...quellen.sitzungen, localMachine: konfig.machine, notifyUntil: (id) => push?.wartewunschBis(id) ?? null,
    }),
    ...chat,
    // Gemessen (Paket 6b): eine eingefuegte Nachricht bei offenem Claude-Dialog
    // beantwortet den Dialog mit Option 1 -- deshalb nimmt der Nachrichtenweg
    // waehrenddessen nichts an. Sondertasten bleiben erlaubt: sie sind genau der
    // Weg, einen Dialog von Hand zu schliessen. Der Riegel meldet `pane_busy`
    // (Vertrag 1.9) wie `wb-pane-write` bei belegtem Pane: derselbe Sachverhalt,
    // ein Text in der App.
    'POST /sessions/:id/messages': async (request) => {
      if (dialogAdapter?.eingabeGesperrt) {
        const riegel = await dialogAdapter.eingabeGesperrt(request.params.id);
        if (riegel.gesperrt) {
          mobilAblehnung(protokoll, request.params.id, riegel.pane, 'pane_busy', `Kern-Dialogriegel – ${SPERRGRUND_TEXT[riegel.grund]}`);
          throw new MobileAuthError('pane_busy', 'a harness dialog is open; answer it or decline it before sending a message');
        }
      }
      return chat['POST /sessions/:id/messages']!(request);
    },
    'GET /sessions/:id/prompt': (request) => {
      if (!dialogAdapter) return chat['GET /sessions/:id/prompt']!(request);
      if (!dialogAdapter.probeRouten) return dialogAdapter.handlers['GET /sessions/:id/prompt'](request);
      return promptMitTasten(dialogAdapter, request);
    },
    'POST /sessions/:id/prompt-answer': (request) => (dialogAdapter
      ? dialogAdapter.handlers['POST /sessions/:id/prompt-answer'](promptAntwortKoerper(request))
      : chat['POST /sessions/:id/prompt-answer']!(request)),
    ...createApprovalHandlers(quellen.freigaben),
    ...createSessionOptionsHandlers(quellen.optionen),
    ...createAgentsHandlers(quellen.agents),
    'POST /sessions/:id/notify': async (request) => {
      // Signatur und Geraet prueft der Server vor jedem Handler; ohne Geraet kein Wunsch.
      if (!request.device) throw new MobileAuthError('capability_unavailable', 'a verified mobile device is required for a notify request');
      const body = validateNotifyBody(request.body);
      if (!body.ok) throw new MobileAuthError('bad_request', body.error);
      const bis = await wartewunsch.setzen(request.params.id, body.value.active);
      return { data: { session_id: request.params.id, notify_until: bis } satisfies SessionNotifyData as unknown as JsonValue };
    },
    'GET /bootstrap': async () => ({
      data: {
        origins: [...konfig.origins],
        capabilities: faehigkeiten(),
        theme: await mobileTheme(quellen.optionen),
        event_epoch: server?.events.eventEpoch ?? '',
        vapid_public_key: push?.publicKey() ?? null,
      } as unknown as JsonValue,
    }),
    'POST /pairings/complete': (request: MobileRouteRequest) => {
      const body = validatePairingCompleteBody(request.body);
      if (!body.ok) throw new MobileAuthError('bad_request', body.error);
      // Der Code gilt nur fuer die beim Start festgelegte Tailscale-Identitaet.
      // Ein Header ist kein Menschenbeleg (4.2) -- er ist hier eine zusaetzliche
      // Schranke; tragend bleiben lokaler Start, Code, Frist und Schluesselbesitz.
      if (!konfig.betreiber || request.identity !== konfig.betreiber) {
        throw new MobileAuthError('device_not_paired', 'pairing is unavailable');
      }
      const geraet = authenticator.completePairing(body.value, { audience: konfig.origin, operator_identity: konfig.betreiber });
      protokoll(`Mobilgeraet gekoppelt: ${geraet.device_name} (${geraet.device_id})`);
      // Ohne Replikation lehnt peer das neue Geraet ab; der Lauf blockiert die Antwort nicht.
      replik?.ausloesen(`Kopplung ${geraet.device_id}`);
      return { data: { device_id: geraet.device_id, key_id: geraet.key_id, paired_at: geraet.paired_at } };
    },
  };

  const statisch = (pfad: string): StaticShellResponse | undefined => {
    const schluessel = pfad === '/' ? '/index.html' : pfad;
    const inhalt = huelle.get(schluessel);
    if (!inhalt) return undefined;
    const art = INHALTSARTEN[extname(schluessel)] ?? 'application/octet-stream';
    if (extname(schluessel) !== '.html') return { body: inhalt, contentType: art };
    return { body: inhalt.toString('utf8').split(ORIGINS_PLATZHALTER).join(konfig.origins.join(' ')), contentType: art };
  };

  const pushAufbauen = (): void => {
    try {
      push = new MobilePushService({
        machine: konfig.machine,
        stateDirectory: konfig.pushVerzeichnis,
        vapidKeyPath: konfig.vapidDatei,
        events: { publish: (typ, ids, quelle) => (server as MobileHttpServer).events.publish(typ, ids, quelle) },
      });
    } catch (fehler) {
      // Eine unbrauchbare VAPID-Datei nimmt nur Web Push weg, nicht den Dienst.
      protokoll(`Mobile Push aus: ${(fehler as Error).message}`);
      push = new MobilePushService({
        machine: konfig.machine, stateDirectory: konfig.pushVerzeichnis, vapidKeyPath: '',
        events: { publish: (typ, ids, quelle) => (server as MobileHttpServer).events.publish(typ, ids, quelle) },
      });
    }
    Object.assign(handlers, push.handlers());
  };

  const veroeffentlichen = (typ: SseEventType, ids: readonly string[]): void => {
    server?.events.publish(typ, ids);
  };
  // Ein spaeter registrierter Dialogadapter aendert die Faehigkeiten: die App laedt neu.
  const faehigkeitGeaendert = (): void => veroeffentlichen('capability.changed', []);

  return {
    get events(): MobileEventBroker {
      if (!server) throw new Error('mobile service is not started');
      return server.events;
    },
    async start(): Promise<{ port: number }> {
      if (server) throw new Error('mobile service is already started');
      huelle = huelleLesen(konfig.huellenVerzeichnis);
      server = createMobileHttpServer({
        port: konfig.port,
        origins: konfig.origins,
        audience: konfig.origin,
        authenticator,
        server_build: konfig.serverBuild,
        machine: konfig.machine,
        authoritative: true,
        handlers,
        // Die Promptantwort eines Pane-Harness traegt den `mobil-taste`-Umschlag,
        // den `wb-mobil-pruefen` selbst atomar beansprucht; der Server reserviert
        // ihn deshalb nicht. Ein Harness mit eigenem Antwortweg (OpenCode) laeuft
        // den gewoehnlichen Weg mit Reservierung.
        paneWriteRoute: async (_route, anfrage) => {
          const harnesse = dialogAdapter?.tastenHarnesse ?? [];
          if (!harnesse.length) return false;
          const treffer = (await quellen.sitzungen.fresh()).filter((sitzung) => sitzung.id === anfrage.params.id);
          return treffer.length === 1 && harnesse.includes(treffer[0].harness);
        },
        staticShell: statisch,
        ...(konfig.heartbeatMs ? { heartbeatIntervalMs: konfig.heartbeatMs } : {}),
      });
      pushAufbauen();
      try {
        const r = await server.start();
        dialogHoerer.add(faehigkeitGeaendert);
        replik?.starten();
        return r;
      } catch (fehler) {
        server = null;
        throw fehler;
      }
    },
    async stop(): Promise<void> {
      dialogHoerer.delete(faehigkeitGeaendert);
      replik?.stoppen();
      const laufend = server;
      server = null;
      if (laufend) await laufend.stop();
    },
    koppelnStarten(): PairingStart {
      if (!konfig.betreiber) throw new MobileAuthError('bad_request', 'no operator identity is configured for pairing');
      const start = authenticator.startPairing({ audience: konfig.origin, operator_identity: konfig.betreiber });
      protokoll('Kopplung am Mac gestartet (Code nur in der Anzeige).');
      return start;
    },
    geraete(): readonly GeraetKurz[] {
      return authenticator.devices().map((g) => ({
        device_id: g.device_id, device_name: g.device_name, status: g.status, paired_at: g.paired_at,
        revoked_at: g.revoked_at ?? null, audiences: [...g.audiences],
      }));
    },
    widerrufen(deviceId: string): boolean {
      const ok = authenticator.revokeDevice(deviceId);
      if (ok) {
        protokoll(`Mobilgeraet widerrufen: ${deviceId}`);
        // Sicherheitsrelevant: bis der Lauf geprueft ist, nimmt peer das Geraet noch an.
        replik?.ausloesen(`Widerruf ${deviceId}`);
      }
      return ok;
    },
    sitzungenGesehen(sitzungen: readonly MobileSessionRecord[]): void {
      if (!server) return;
      const geaendert: string[] = [];
      const chats: string[] = [];
      const jetzt = new Set<string>();
      const wuensche = push?.wartewuensche() ?? {};
      for (const s of sitzungen) {
        jetzt.add(s.id);
        const neu = fingerabdruck(s, wuensche[s.id] ?? null);
        const alt = gesehen.get(s.id);
        if (!alt || alt.sitzung !== neu.sitzung) geaendert.push(s.id);
        if (alt && alt.chat !== neu.chat) chats.push(s.id);
        gesehen.set(s.id, neu);
      }
      for (const id of [...gesehen.keys()]) {
        if (!jetzt.has(id)) {
          gesehen.delete(id);
          geaendert.push(id);
        }
      }
      if (geaendert.length) veroeffentlichen('session.changed', geaendert);
      if (chats.length) veroeffentlichen('chat.changed', chats);
    },
    freigabenGesehen(schluessel: readonly string[]): void {
      const stand = [...schluessel].sort().join('\u0000');
      if (stand === freigabenStand) return;
      freigabenStand = stand;
      veroeffentlichen('approval.changed', []);
    },
    agentsGeaendert(): void {
      veroeffentlichen('agents.changed', []);
    },
    melden(typ: NotificationEventType, zielId: string, zustand: string, worker?: WorkerFertigFelder): void {
      if (!server || !push) return;
      // Die Event-ID kommt aus dem vorhandenen Ereignisstrom (Paket 8: „nicht aus Chatinhalt erzeugt").
      const sseTyp: SseEventType = typ === 'command.blocked' ? 'approval.changed' : 'session.changed';
      const ereignis = server.events.publish(sseTyp, [zielId]);
      void push.publish({
        event_id: ereignis.id, type: typ, authoritative_machine: konfig.machine, target_id: zielId, state_fingerprint: zustand,
        ...(typ === 'worker.done' && worker ? { worker } : {}),
      }).catch((fehler: unknown) => protokoll(`Mobile Meldung ${typ} nicht zugestellt: ${(fehler as Error).message}`));
    },
  };
}
