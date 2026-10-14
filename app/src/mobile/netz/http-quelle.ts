/**
 * DIE SIGNIERENDE HTTP-QUELLE (Paket 10; ersetzt die Attrappe im Produktivbau).
 *
 * Sie implementiert `MobileQuelle` gegen die echten Server von Mac und peer
 * (Spezifikation 2.3 und 3):
 *   - Jede API-Anfrage traegt den signierten Umschlag im Header
 *     `X-AWB-Mobile-Envelope`; der Schluessel liegt nicht exportierbar in
 *     IndexedDB (speicher.ts), die Byteformen kommen aus `mobile-shared`.
 *   - Lesen fragt BEIDE Origins parallel mit kurzer Frist. Ein direkter Stand
 *     ist autoritativ und ersetzt einen Spiegel des Mac; ergaenzt wird nichts.
 *     Wer nicht warten will, bekommt jede spaeter eintreffende Antwort ueber
 *     `nachgereicht`; eine Origin, die zuletzt schwieg, haelt niemanden auf.
 *     Das Schweigen merkt sich die Quelle zehn Minuten ueber einen Neustart
 *     der App hinaus (`merkzettel`).
 *   - Schreiben geht nur an die Origin der Maschine, der die Sitzung gehoert --
 *     `messages`/`keys` mit der Pane-Bindung aus der Sitzungsliste (Vertrag 1.2).
 *   - Der Ereignisstrom ist ein signierter `fetch()` mit eigenem SSE-Parser und
 *     `Last-Event-ID` je Origin (EventSource kann keine Signaturheader setzen).
 */
import { MOBILE_API_VERSION } from '../../mobile-shared/vertrag';
import type {
  AgentAction, AgentActionData, AgentsData, ApiFailure, ApiResponse, Approval, ApprovalsData, BootstrapData, ChatData,
  CloseSessionData, CreateSessionBody, CreateSessionData, DecisionBody, DecisionData, JsonObject, MobileApiErrorCode,
  Notification, NotificationsData, NotifyBody, PairingCompleteData, PromptAnswerBody, PromptAnswerData, PromptData, QueryParameter,
  Prompt, ResumeSessionData, SendKeyBody, SendKeyData, SendMessageBody, SendMessageData, SessionSummary, SessionsData,
  SessionNotifyData, SignedPromptAnswerBody, SignedSendKeyBody, SignedSendMessageBody, SseEvent, StartOptionsData,
} from '../../mobile-shared/vertrag';
import { validateApiResponse } from '../../mobile-shared/validierung';
import type { Freigabeart, KopplungsStand, KoppelnWunsch, MaschinenStand, MobileQuelle, Nachreichen, PushStand, StartOptionen } from '../components/quelle';
import { GERAETESPEICHER_MELDUNG, KOPPLUNG_SPEICHER_MELDUNG, geraetespeicherMarkieren, maschineVon } from '../components/quelle';
import { anfrageSignieren, anfrageziel, base64, kopplungsbeweis, schluesselpaarErzeugen } from './signieren';
import type { GeraeteSpeicher } from './speicher';

/** Die Push-Anbindung des Browsers (Service Worker, Notification); in Node fehlt sie. */
export interface PushAnbindung {
  stand(): Promise<PushStand>;
  /** Nach einer echten Beruehrung: Erlaubnis holen und die Subscription liefern. */
  abonnieren(vapidOeffentlich: string): Promise<{ stand: PushStand; subscription: JsonObject | null }>;
}

export interface HttpQuelleOptionen {
  /** Beide API-Origins aus der ausgelieferten Huelle (Konfiguration des Servers). */
  readonly origins: readonly string[];
  /** Die Installations-Origin (`location.origin`): Kopplung und bevorzugte Lesequelle. */
  readonly heimat: string;
  readonly speicher: GeraeteSpeicher;
  readonly build: string;
  readonly fetch?: typeof fetch;
  /** Nur Proben: die Adresse, unter der eine Origin im Test erreichbar ist. */
  readonly basis?: (origin: string) => string;
  /** Frist schreibender Anfragen; ohne `lesefristMs` auch die Obergrenze fuers Lesen. */
  readonly fristMs?: number;
  readonly lesefristMs?: number;
  readonly jetzt?: () => number;
  /** Nur Proben: Header, die sonst `tailscale serve` setzt (`Tailscale-User-Login`). */
  readonly probeHeader?: Readonly<Record<string, string>>;
  readonly push?: PushAnbindung;
  /**
   * Wo die Quelle sich merkt, welche Origin seit wann schweigt. Ohne Angabe
   * `localStorage` des Browsers, `null` merkt nichts ueber die Quelle hinaus.
   */
  readonly merkzettel?: Merkzettel | null;
}

/** Der Teil von `Storage`, den der Merkzettel braucht. */
export type Merkzettel = Pick<Storage, 'getItem' | 'setItem'>;

/** Schluessel des Merkzettels: je Origin `{ seit, bestaetigt }`, kein Geheimnis. */
export const SCHWEIGEN_SCHLUESSEL = 'awb-mobil-schweigt';
/**
 * So lange nach der letzten Bestaetigung gilt eine Origin beim Start als
 * schweigend; danach ist ihr Zustand unbekannt und der Abgleich wartet wieder
 * die Lesefrist ab.
 *
 * Gemerkt wird in `localStorage`, nicht in `sessionStorage`: dessen Leben haengt
 * am Browsing-Kontext, und die Home-Bildschirm-App startet nach einem
 * Prozessende mit einem neuen (Auftrag mobil-kaltstart, 09.10.2026).
 */
export const SCHWEIGEN_GILT_MS = 10 * 60_000;

type Schweigen = Record<string, { seit: number; bestaetigt: number }>;

function browserZettel(): Merkzettel | null {
  try {
    return typeof document !== 'undefined' && typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

class Netzfehler extends Error {}
class SpeicherStoerung extends Error {}

/** Frist schreibender Anfragen: der Server fuehrt die Handlung aus, auch wenn es dauert. */
export const SCHREIBFRIST_MS = 8_000;
/**
 * Frist lesender Anfragen. Nicht kuerzer: ueber das Relay braucht die erste
 * peer-Anfrage 3 bis 4 RTT, bei 600 ms also 1,8 bis 2,4 s; eine kuerzere Frist
 * meldete ein langsames, waches peer als tot (Messbericht mobil-perf, 09.10.2026).
 */
export const LESEFRIST_MS = 4_000;

type Antwort<T> = { origin: string; a: ApiResponse<T> };
type GuteAntwort<T> = { origin: string; a: Exclude<ApiResponse<T>, ApiFailure> };

interface OriginStand {
  readonly origin: string;
  machine: string | null;
  erreichbar: boolean;
  seit: number | null;
  zuletzt: number | null;
  server_build: string | null;
  api_version: string | null;
}

function hostTeil(origin: string): string {
  try {
    return new URL(origin).hostname.split('.')[0] || origin;
  } catch {
    return origin;
  }
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function istFehler<T>(a: ApiResponse<T>): a is ApiFailure {
  return 'error' in a;
}

export class HttpQuelle implements MobileQuelle {
  readonly name = 'http';
  readonly client_build: string;
  private readonly holen: typeof fetch;
  private readonly frist: number;
  private readonly lesefrist: number;
  private readonly jetzt: () => number;
  private readonly stand: OriginStand[];
  /** Letzte zusammengefuehrte Sitzungsliste: Quelle der Pane-Bindung fuer Schreibzugriffe. */
  private sitzungsStand = new Map<string, SessionSummary>();
  /** Die zuletzt gelesene Rueckfrage je Sitzung: Quelle der gemessenen Tastenfolge der Antwort. */
  private promptStand = new Map<string, Prompt>();
  private freigabeOrigin = new Map<string, string>();
  private agentsOrigin: string | null = null;
  private letzterBootstrap: BootstrapData | null = null;
  /** Je Leseweg die Nummer des juengsten Aufrufs: aeltere Nachzuegler aendern nichts mehr. */
  private lesungen = new Map<string, number>();
  private readonly zettel: Merkzettel | null;
  /** Origins mit Eintrag im Merkzettel: nur dann kostet eine Antwort einen Schreibzugriff. */
  private imZettel = new Set<string>();
  /** Wer wissen will, wann eine Origin antwortet (fruehes Ereignisabo). */
  private antwortHoerer = new Set<(origin: string) => void>();

  constructor(private readonly opt: HttpQuelleOptionen) {
    this.client_build = opt.build;
    this.holen = opt.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.frist = opt.fristMs ?? SCHREIBFRIST_MS;
    this.lesefrist = opt.lesefristMs ?? Math.min(LESEFRIST_MS, this.frist);
    this.jetzt = opt.jetzt ?? Date.now;
    const reihe = [opt.heimat, ...opt.origins.filter((o) => o !== opt.heimat)];
    this.stand = reihe.map((origin) => ({
      origin, machine: null, erreichbar: true, seit: null, zuletzt: null, server_build: null, api_version: null,
    }));
    this.zettel = opt.merkzettel === undefined ? browserZettel() : opt.merkzettel;
    // Kaltstart: eine Origin, die vor kurzem schwieg, haelt den ersten Abgleich nicht auf.
    const jetzt = this.jetzt();
    const gemerkt = this.schweigenLesen();
    this.imZettel = new Set(Object.keys(gemerkt));
    for (const s of this.stand) {
      const e = gemerkt[s.origin];
      if (e && jetzt - e.bestaetigt >= 0 && jetzt - e.bestaetigt <= SCHWEIGEN_GILT_MS) {
        s.erreichbar = false;
        s.seit = e.seit;
      }
    }
  }

  private schweigenLesen(): Schweigen {
    const aus: Schweigen = {};
    try {
      const roh: unknown = JSON.parse(this.zettel?.getItem(SCHWEIGEN_SCHLUESSEL) ?? '{}');
      if (!roh || typeof roh !== 'object') return aus;
      for (const [origin, e] of Object.entries(roh as Record<string, unknown>)) {
        const { seit, bestaetigt } = (e ?? {}) as { seit?: unknown; bestaetigt?: unknown };
        if (Number.isFinite(seit) && Number.isFinite(bestaetigt)) aus[origin] = { seit: seit as number, bestaetigt: bestaetigt as number };
      }
    } catch { /* ohne lesbaren Zettel ist nichts gemerkt */ }
    return aus;
  }

  /** Antwort loescht den Eintrag, Schweigen setzt ihn (mit `seit` und dem Zeitpunkt dieser Bestaetigung). */
  private schweigenMerken(s: OriginStand): void {
    if (!this.zettel || (s.erreichbar && !this.imZettel.has(s.origin))) return;
    const gemerkt = this.schweigenLesen();
    if (s.erreichbar) {
      delete gemerkt[s.origin];
      this.imZettel.delete(s.origin);
    } else {
      gemerkt[s.origin] = { seit: s.seit ?? this.jetzt(), bestaetigt: this.jetzt() };
      this.imZettel.add(s.origin);
    }
    try {
      this.zettel.setItem(SCHWEIGEN_SCHLUESSEL, JSON.stringify(gemerkt));
    } catch { /* voller oder gesperrter Speicher: dann wie ohne Zettel */ }
  }

  // --- Transport --------------------------------------------------------------

  private basis(origin: string): string {
    return this.opt.basis ? this.opt.basis(origin) : origin;
  }

  /**
   * Antwort oder Schweigen einer Origin festhalten. `beginn` ist der Start der
   * gescheiterten Anfrage: hat die Origin seitdem geantwortet, war sie nur
   * damals still, und die juengere Antwort gilt.
   */
  private markieren(origin: string, ok: boolean, meta?: { machine: string; server_build: string; api_version: string }, beginn?: number): void {
    const s = this.stand.find((x) => x.origin === origin);
    if (!s) return;
    if (!ok && beginn !== undefined && s.zuletzt !== null && s.zuletzt >= beginn) return;
    if (ok) {
      s.erreichbar = true;
      s.seit = null;
      s.zuletzt = this.jetzt();
      if (meta) {
        s.machine = meta.machine;
        s.server_build = meta.server_build;
        s.api_version = meta.api_version;
      }
    } else if (s.erreichbar) {
      s.erreichbar = false;
      s.seit = this.jetzt();
    }
    this.schweigenMerken(s);
    if (ok) for (const h of [...this.antwortHoerer]) h(origin);
  }

  private fehler<T>(code: MobileApiErrorCode, message: string, origin = this.opt.heimat, retryable = false): ApiResponse<T> {
    const s = this.stand.find((x) => x.origin === origin);
    return {
      api_version: MOBILE_API_VERSION, server_build: s?.server_build ?? '', machine: s?.machine ?? hostTeil(origin),
      authoritative: true, request_id: '', error: { code, message, retryable },
    };
  }

  private async signaturHeader(origin: string, method: string, pfad: ReturnType<typeof anfrageziel>, body: Uint8Array): Promise<string | null> {
    const g = await this.opt.speicher.laden();
    if (!g) return null;
    const jetzt = this.jetzt();
    const counter = await this.opt.speicher.naechsterZaehler(origin, jetzt);
    return JSON.stringify(await anfrageSignieren(g, { audience: origin, method, ziel: pfad, body, counter, jetzt }));
  }

  /** Eine Anfrage an genau eine Origin. Netz- und Formfehler werfen, Vertragsfehler kommen als ApiFailure zurueck. */
  private async rufen<T>(origin: string, method: string, pfadUnterApi: string, optionen: {
    query?: readonly QueryParameter[]; body?: unknown; signiert?: boolean;
  } = {}): Promise<ApiResponse<T>> {
    const ziel = anfrageziel(pfadUnterApi, optionen.query ?? []);
    const body: Uint8Array<ArrayBuffer> = optionen.body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(optionen.body));
    const header: Record<string, string> = { Accept: 'application/json', ...(this.opt.probeHeader ?? {}) };
    if (optionen.body !== undefined) header['Content-Type'] = 'application/json';
    if (optionen.signiert !== false) {
      let umschlag: string | null;
      try {
        umschlag = await this.signaturHeader(origin, method, ziel, body);
      } catch {
        // Der Speicher des Geraets versagt: es ging nie eine Anfrage hinaus, die Origin ist nicht „unerreichbar".
        // retryable: ein frischer Versuch (nach Wiederholung oder Neustart der App) kann gelingen; die Meldung raet genau das.
        // Die UI wertet `retryable` nirgends zu einer selbstlaufenden Wiederholung aus.
        return geraetespeicherMarkieren(this.fehler<T>('internal_error', GERAETESPEICHER_MELDUNG, origin, true));
      }
      if (!umschlag) return this.fehler('device_not_paired', 'Dieses Gerät ist nicht gekoppelt.', origin);
      header['X-AWB-Mobile-Envelope'] = umschlag;
    }
    const url = `${this.basis(origin)}${ziel.pfad}${ziel.querytext ? `?${ziel.querytext}` : ''}`;
    // EINE Wiederholung nach Netzfehler, und zwar mit DEMSELBEN Umschlag
    // (Spezifikation 3.2): das Ergebnisjournal des Servers liefert dann das
    // gespeicherte Ergebnis, statt die Handlung ein zweites Mal auszufuehren.
    // Ein neuer Umschlag waere eine zweite Nachricht im Pane. Gelesen wird
    // ohnehin idempotent, deshalb zaehlt die Wiederholung nur fuer Schreibwege.
    const wiederholen = method !== 'GET' && optionen.signiert !== false;
    try {
      return await this.einmalRufen<T>(origin, url, method, header, body);
    } catch (fehler) {
      if (!wiederholen || !(fehler instanceof Netzfehler)) throw fehler;
      return this.einmalRufen<T>(origin, url, method, header, body);
    }
  }

  private async einmalRufen<T>(origin: string, url: string, method: string, header: Record<string, string>, body: Uint8Array<ArrayBuffer>): Promise<ApiResponse<T>> {
    const abbruch = new AbortController();
    const beginn = this.jetzt();
    const uhr = setTimeout(() => abbruch.abort(), method === 'GET' ? this.lesefrist : this.frist);
    let antwort: Response;
    let text: string;
    try {
      antwort = await this.holen(url, {
        method, headers: header, body: body.length ? body : undefined, cache: 'no-store', credentials: 'omit', signal: abbruch.signal,
      });
      text = await antwort.text();
    } catch {
      this.markieren(origin, false, undefined, beginn);
      throw new Netzfehler(`${origin} antwortet nicht`);
    } finally {
      clearTimeout(uhr);
    }
    if (antwort.status === 204 && !text) {
      this.markieren(origin, true);
      const s = this.stand.find((x) => x.origin === origin);
      return { api_version: s?.api_version ?? MOBILE_API_VERSION, server_build: s?.server_build ?? '', machine: s?.machine ?? '',
        authoritative: true, request_id: '', data: undefined as T };
    }
    let wert: unknown;
    try {
      wert = JSON.parse(text);
    } catch {
      this.markieren(origin, false);
      throw new Netzfehler(`${origin} antwortet nicht im Vertrag`);
    }
    const geprueft = validateApiResponse(wert);
    if (!geprueft.ok) {
      this.markieren(origin, false);
      throw new Netzfehler(`${origin}: ${geprueft.error}`);
    }
    const a = wert as ApiResponse<T>;
    this.markieren(origin, true, { machine: a.machine, server_build: a.server_build, api_version: a.api_version });
    return a;
  }

  /**
   * Alle Origins parallel; Netzfehler zaehlen als „nicht erreichbar", nicht als Abbruch.
   *
   * Das Ergebnis wartet nur auf die Origins, die zuletzt geantwortet haben. Eine
   * Origin, die zuletzt schwieg, wird trotzdem gefragt, aber nicht abgewartet --
   * es sei denn, keine andere antwortet. Jede Aenderung danach und jede Antwort
   * vor dem Ergebnis meldet `bei` mit allen bisherigen Antworten in fester
   * Reihenfolge (Heimat zuerst); so taucht eine aufgewachte Origin von selbst auf.
   */
  private alle<T>(method: string, pfad: string, bei?: (da: Antwort<T>[]) => void): Promise<Antwort<T>[]> {
    const wach = this.stand.map((s) => s.erreichbar);
    const da: (Antwort<T> | null | undefined)[] = this.stand.map(() => undefined);
    const liste = (): Antwort<T>[] => da.filter((x): x is Antwort<T> => !!x);
    return new Promise((fertig, fehlschlag) => {
      let erledigt = false;
      const pruefen = (): void => {
        if (erledigt) {
          bei?.(liste());
          return;
        }
        const offen = da.map((x, i) => (x === undefined ? i : -1)).filter((i) => i >= 0);
        const wachOffen = offen.some((i) => wach[i]);
        if (!wachOffen && (liste().length > 0 || offen.length === 0)) {
          erledigt = true;
          if (liste().length) fertig(liste());
          else fehlschlag(new Netzfehler('keine API erreichbar'));
        } else if (liste().length) {
          bei?.(liste());
        }
      };
      this.stand.forEach((s, i) => {
        this.rufen<T>(s.origin, method, pfad)
          .then((a) => { da[i] = { origin: s.origin, a }; }, () => { da[i] = null; })
          .then(pruefen);
      });
    });
  }

  /** Nummer eines neuen Aufrufs dieses Lesewegs; `aktuell(nr)` sagt, ob er noch der juengste ist. */
  private lesung(weg: string): () => boolean {
    const nr = (this.lesungen.get(weg) ?? 0) + 1;
    this.lesungen.set(weg, nr);
    return () => this.lesungen.get(weg) === nr;
  }

  /** Die erste erreichbare Origin: Heimat, dann die anderen; wer zuletzt schwieg, kommt zuletzt. */
  private async erste<T>(method: string, pfad: string, optionen: { body?: unknown } = {}): Promise<{ origin: string; a: ApiResponse<T> }> {
    let letzter: unknown = null;
    for (const s of [...this.stand.filter((x) => x.erreichbar), ...this.stand.filter((x) => !x.erreichbar)]) {
      try {
        return { origin: s.origin, a: await this.rufen<T>(s.origin, method, pfad, optionen) };
      } catch (fehler) {
        letzter = fehler;
      }
    }
    throw letzter ?? new Netzfehler('keine API erreichbar');
  }

  /** Die Origin, deren Server sich zuletzt als diese Maschine gemeldet hat. */
  private originVon(machine: string): string | null {
    return this.stand.find((s) => s.machine === machine)?.origin ?? null;
  }

  private schreibOrigin(sessionId: string): string | null {
    return this.originVon(maschineVon(sessionId));
  }

  // --- Kopplung ---------------------------------------------------------------

  async kopplung(): Promise<KopplungsStand> {
    const g = await this.opt.speicher.laden();
    return g
      ? { gekoppelt: true, geraet: g.device_name, device_id: g.device_id, seit: g.paired_at }
      : { gekoppelt: false, geraet: null, device_id: null, seit: null };
  }

  async koppeln(w: KoppelnWunsch): Promise<ApiResponse<PairingCompleteData>> {
    // Erst den Geraetespeicher pruefen: schweigt er, geht kein Schluessel an den Server, und die Kopplung
    // bleibt ohne Server-Eintrag. Die Meldung ist dieselbe wie bei jedem anderen Speicherausfall.
    try {
      await this.opt.speicher.pruefen();
    } catch {
      return geraetespeicherMarkieren(this.fehler<PairingCompleteData>('internal_error', GERAETESPEICHER_MELDUNG, this.opt.heimat, true));
    }
    const { privat, oeffentlichJwk } = await schluesselpaarErzeugen();
    const proof = await kopplungsbeweis(privat, {
      audience: this.opt.heimat, public_jwk: oeffentlichJwk, device_name: w.device_name, pairing_code: w.pairing_code, jetzt: this.jetzt(),
    });
    const a = await this.rufen<PairingCompleteData>(this.opt.heimat, 'POST', '/pairings/complete', {
      signiert: false, body: { public_jwk: oeffentlichJwk, device_name: w.device_name, pairing_code: w.pairing_code, proof },
    });
    if (istFehler(a)) return a;
    try {
      await this.opt.speicher.speichern({
        device_id: a.data.device_id, key_id: a.data.key_id, device_name: w.device_name, paired_at: a.data.paired_at, privat,
      });
    } catch {
      // Der Server hat gekoppelt: das ist keine Netzstoerung, also keine Mac-Meldung. Ohne gespeicherten
      // Schluessel gilt dieses Geraet als nicht gekoppelt; die Meldung sagt, dass neu gekoppelt werden muss.
      return this.fehler<PairingCompleteData>('internal_error', KOPPLUNG_SPEICHER_MELDUNG, this.opt.heimat, false);
    }
    return a;
  }

  // --- Lesen --------------------------------------------------------------------

  async maschinen(): Promise<readonly MaschinenStand[]> {
    return this.stand.map((s) => ({
      machine: s.machine ?? hostTeil(s.origin), name: s.machine ?? hostTeil(s.origin), origin: s.origin, erreichbar: s.erreichbar,
      seit: s.seit, zuletzt: s.zuletzt, server_build: s.server_build, api_version: s.api_version,
    }));
  }

  async bootstrap(): Promise<ApiResponse<BootstrapData>> {
    const { a } = await this.erste<BootstrapData>('GET', '/bootstrap');
    if (!istFehler(a)) this.letzterBootstrap = a.data;
    return a;
  }

  /**
   * Antworten aller Origins lesen und zusammenfuehren; Nachzuegler gehen an
   * `nachgereicht`. `mischen` merkt sich Bindungen nur, wenn `gilt`: ein
   * aelterer Aufruf ueberschreibt nie den Stand eines juengeren. `teil` sagt,
   * dass es ein Zwischenstand ist: dann ersetzen die Bindungen nur die der
   * Origins, die schon geantwortet haben (wie der Stand die Liste).
   */
  private async gemischt<T>(weg: string, pfad: string, mischen: (gut: GuteAntwort<T>[], gilt: boolean, teil: boolean) => T, nachgereicht?: Nachreichen<T>): Promise<ApiResponse<T>> {
    const aktuell = this.lesung(weg);
    const zusammen = (antworten: Antwort<T>[], teil: boolean): ApiResponse<T> => {
      const gut = antworten.filter((x) => !istFehler(x.a)) as GuteAntwort<T>[];
      if (!gut.length) return antworten[0].a;
      const kopf = gut.find((x) => x.origin === this.opt.heimat) ?? gut[0];
      return { ...kopf.a, data: mischen(gut, aktuell(), teil) };
    };
    const antworten = await this.alle<T>('GET', pfad, (da) => {
      if (!aktuell()) return;
      const gut = da.filter((x) => !istFehler(x.a)) as GuteAntwort<T>[];
      nachgereicht?.(zusammen(da, true), gut.map((x) => ({ origin: x.origin, machine: x.a.machine })));
    });
    return zusammen(antworten, false);
  }

  async sitzungen(nachgereicht?: Nachreichen<SessionsData>): Promise<ApiResponse<SessionsData>> {
    return this.gemischt<SessionsData>('sitzungen', '/sessions', (gut, gilt, teil) => {
      const zusammen = new Map<string, SessionSummary>();
      for (const { a } of gut) {
        for (const s of a.data.sessions) {
          const alt = zusammen.get(s.id);
          // Direkt schlaegt Spiegel; ein Spiegel ergaenzt nie fehlende Felder.
          if (!alt || (alt.source === 'mirror' && s.source === 'authoritative')) zusammen.set(s.id, s);
        }
      }
      if (gilt) {
        // Ein Zwischenstand nimmt den Mac-Sitzungen nicht die Bindung, solange der Mac noch nicht geantwortet hat.
        const da = new Set(gut.map((x) => x.a.machine));
        const bleibt = teil ? [...this.sitzungsStand].filter(([id]) => !da.has(maschineVon(id)) && !zusammen.has(id)) : [];
        this.sitzungsStand = new Map([...zusammen, ...bleibt]);
      }
      return { sessions: [...zusammen.values()] };
    }, nachgereicht);
  }

  async chat(sessionId: string, cursor?: string): Promise<ApiResponse<ChatData>> {
    const origin = this.schreibOrigin(sessionId) ?? this.opt.heimat;
    return this.rufen<ChatData>(origin, 'GET', `/sessions/${encodeURIComponent(sessionId)}/chat`, {
      query: cursor ? [{ name: 'cursor', value: cursor }] : [],
    });
  }

  async prompt(sessionId: string): Promise<ApiResponse<PromptData>> {
    const origin = this.schreibOrigin(sessionId) ?? this.opt.heimat;
    const a = await this.rufen<PromptData>(origin, 'GET', `/sessions/${encodeURIComponent(sessionId)}/prompt`);
    if (istFehler(a)) this.promptStand.delete(sessionId);
    else if (a.data.prompt) this.promptStand.set(sessionId, a.data.prompt);
    else this.promptStand.delete(sessionId);
    return a;
  }

  async freigaben(nachgereicht?: Nachreichen<ApprovalsData>): Promise<ApiResponse<ApprovalsData>> {
    return this.gemischt<ApprovalsData>('freigaben', '/approvals', (gut, gilt, teil) => {
      const liste: Approval[] = [];
      const herkunft = new Map<string, string>();
      for (const { origin, a } of gut) {
        for (const f of a.data.approvals) {
          if (herkunft.has(f.id)) continue;
          herkunft.set(f.id, origin);
          liste.push(f);
        }
      }
      if (gilt) {
        // Wie die Liste im Stand: Freigaben noch stiller Origins bleiben entscheidbar, bis sie antworten oder der Aufruf endet.
        const da = new Set(gut.map((x) => x.origin));
        const bleibt = teil ? [...this.freigabeOrigin].filter(([id, o]) => !da.has(o) && !herkunft.has(id)) : [];
        this.freigabeOrigin = new Map([...herkunft, ...bleibt]);
      }
      return { approvals: liste };
    }, nachgereicht);
  }

  freigabeHerkunft(id: string): string | null {
    return this.freigabeOrigin.get(id) ?? null;
  }

  async startOptionen(): Promise<StartOptionen> {
    const { a } = await this.erste<StartOptionsData>('GET', '/session-options');
    if (istFehler(a)) throw new Netzfehler(a.error.message);
    return a.data;
  }

  async agents(): Promise<ApiResponse<AgentsData>> {
    const { origin, a } = await this.erste<AgentsData>('GET', '/agents');
    if (!istFehler(a)) this.agentsOrigin = origin;
    return a;
  }

  async meldungen(_cursor?: string, nachgereicht?: Nachreichen<NotificationsData>): Promise<ApiResponse<NotificationsData>> {
    return this.gemischt<NotificationsData>('meldungen', '/notifications', (gut) => {
      const nachId = new Map<string, Notification>();
      for (const { a } of gut) for (const n of a.data.notifications) if (!nachId.has(n.id)) nachId.set(n.id, n);
      return { notifications: [...nachId.values()].sort((l, r) => r.created_at - l.created_at), cursor: null };
    }, nachgereicht);
  }

  // --- Schreiben ------------------------------------------------------------------

  private bindungFuer(sessionId: string): { origin: string; s: SessionSummary } | ApiResponse<never> {
    const s = this.sitzungsStand.get(sessionId);
    const origin = this.schreibOrigin(sessionId);
    if (!s || !origin || s.source !== 'authoritative' || !s.binding) {
      return this.fehler('stale_target', 'Diese Sitzung nimmt gerade keine Eingabe an. Die Liste wird neu geladen.');
    }
    return { origin, s };
  }

  async senden(sessionId: string, body: SendMessageBody): Promise<ApiResponse<SendMessageData>> {
    const ziel = this.bindungFuer(sessionId);
    if ('api_version' in ziel) return ziel;
    const b = ziel.s.binding!;
    const signiert: SignedSendMessageBody = {
      aktion: 'mobil-senden', maschine: b.maschine, socket: b.socket, pane: b.pane, text_b64: base64(utf8(body.text)),
    };
    return this.rufen<SendMessageData>(ziel.origin, 'POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { body: signiert });
  }

  async taste(sessionId: string, body: SendKeyBody): Promise<ApiResponse<SendKeyData>> {
    const ziel = this.bindungFuer(sessionId);
    if ('api_version' in ziel) return ziel;
    const b = ziel.s.binding!;
    const signiert: SignedSendKeyBody = { aktion: 'mobil-taste', maschine: b.maschine, socket: b.socket, pane: b.pane, tasten: [body.key] };
    return this.rufen<SendKeyData>(ziel.origin, 'POST', `/sessions/${encodeURIComponent(sessionId)}/keys`, { body: signiert });
  }

  /**
   * Die Knopfantwort (Vertrag 1.3): Fingerprint und Options-ID stehen in der
   * signierten Query, der Body ist -- wo der Harness mit Pane-Tasten antwortet --
   * exakt der `mobil-taste`-Body, den `wb-mobil-pruefen` verlangt, mit der
   * gemessenen Folge aus der zuletzt gelesenen Rueckfrage. Ohne diese Rueckfrage
   * wird nichts gesendet; der Server prueft den Fingerprint danach noch einmal.
   */
  async promptAntworten(sessionId: string, body: PromptAnswerBody): Promise<ApiResponse<PromptAnswerData>> {
    const origin = this.schreibOrigin(sessionId);
    if (!origin) return this.fehler('stale_target', 'Die Maschine dieser Sitzung antwortet nicht.');
    const gelesen = this.promptStand.get(sessionId);
    if (!gelesen || gelesen.fingerprint !== body.fingerprint) {
      return this.fehler('prompt_changed', 'Die Rückfrage hat sich geändert. Sie wird neu geladen.', origin);
    }
    const query: QueryParameter[] = [{ name: 'fingerprint', value: body.fingerprint }, { name: 'option_id', value: body.option_id }];
    if (body.text !== undefined) query.push({ name: 'text', value: body.text });
    const pfad = `/sessions/${encodeURIComponent(sessionId)}/prompt-answer`;
    const tasten = gelesen.options.find((o) => o.id === body.option_id)?.keys;
    if (!tasten?.length) return this.rufen<PromptAnswerData>(origin, 'POST', pfad, { query });
    const bindung = this.sitzungsStand.get(sessionId)?.binding;
    if (!bindung) return this.fehler('stale_target', 'Diese Sitzung nimmt gerade keine Eingabe an. Die Liste wird neu geladen.', origin);
    const signiert: SignedPromptAnswerBody = {
      aktion: 'mobil-taste', maschine: bindung.maschine, socket: bindung.socket, pane: bindung.pane, tasten,
    };
    return this.rufen<PromptAnswerData>(origin, 'POST', pfad, { query, body: signiert });
  }

  async entscheiden(art: Freigabeart, id: string, body: DecisionBody): Promise<ApiResponse<DecisionData>> {
    const origin = this.freigabeOrigin.get(id);
    if (!origin) return this.fehler('stale_target', 'Diese Freigabe ist schon entschieden oder verschwunden.');
    return this.rufen<DecisionData>(origin, 'POST', `/approvals/${art === 'request' ? 'requests' : 'guards'}/${encodeURIComponent(id)}/decision`, { body });
  }

  async sitzungAnlegen(body: CreateSessionBody): Promise<ApiResponse<CreateSessionData>> {
    const origin = this.originVon(body.machine);
    if (!origin) return this.fehler('stale_target', `${body.machine} antwortet nicht. Eine Sitzung startet nur dort.`);
    return this.rufen<CreateSessionData>(origin, 'POST', '/sessions', { body });
  }

  async fortsetzen(sessionId: string): Promise<ApiResponse<ResumeSessionData>> {
    const origin = this.schreibOrigin(sessionId);
    if (!origin) return this.fehler('stale_target', 'Die Maschine dieser Sitzung antwortet nicht.');
    return this.rufen<ResumeSessionData>(origin, 'POST', `/sessions/${encodeURIComponent(sessionId)}/resume`);
  }

  async schliessen(sessionId: string): Promise<ApiResponse<CloseSessionData>> {
    const origin = this.schreibOrigin(sessionId);
    if (!origin) return this.fehler('stale_target', 'Die Maschine dieser Sitzung antwortet nicht.');
    return this.rufen<CloseSessionData>(origin, 'POST', `/sessions/${encodeURIComponent(sessionId)}/close`);
  }

  /**
   * Vertrag 1.8: Wartewunsch „Bescheid geben“ an die Origin der Maschine der
   * Sitzung -- wie jedes Schreiben nie ueber einen Spiegel. Eine Pane-Bindung
   * braucht er nicht, nur eine direkt gemeldete Sitzung.
   */
  async bescheid(sessionId: string, body: NotifyBody): Promise<ApiResponse<SessionNotifyData>> {
    const s = this.sitzungsStand.get(sessionId);
    const origin = this.schreibOrigin(sessionId);
    if (!s || !origin || s.source !== 'authoritative') {
      return this.fehler('stale_target', 'Die Maschine dieser Sitzung antwortet nicht direkt. Die Liste wird neu geladen.');
    }
    return this.rufen<SessionNotifyData>(origin, 'POST', `/sessions/${encodeURIComponent(sessionId)}/notify`, { body: { active: body.active } });
  }

  async agentAktion(aktion: AgentAction): Promise<ApiResponse<AgentActionData>> {
    const origin = this.agentsOrigin ?? this.opt.heimat;
    return this.rufen<AgentActionData>(origin, 'POST', '/agents/actions', { body: aktion });
  }

  // --- Push ---------------------------------------------------------------------

  async push(): Promise<PushStand> {
    return this.opt.push ? this.opt.push.stand() : { erlaubnis: 'nicht_moeglich', grund: 'Mitteilungen gibt es nur in der installierten App.' };
  }

  /** Registriert dieselbe Subscription signiert bei beiden Hosts (Spezifikation 6). */
  async pushAnfragen(): Promise<PushStand> {
    if (!this.opt.push) return this.push();
    // Den Schluessel frisch holen, wenn der gemerkte Bootstrap keinen traegt.
    // ANLASS (29.09.2026, erster Test am iPhone): der Server hatte den Schluessel,
    // die App meldete trotzdem „keinen Push-Schluessel“ -- sie stuetzte sich allein
    // auf die zuletzt gemerkte Bootstrap-Antwort, und die fehlte oder war aelter
    // als das Einrichten von Push. Eine Frage an den Server kostet hier nichts;
    // der Mensch hat gerade eben auf „Erlauben“ getippt.
    let schluessel = this.letzterBootstrap?.vapid_public_key ?? null;
    if (!schluessel) {
      try {
        const b = await this.bootstrap();
        schluessel = istFehler(b) ? null : b.data.vapid_public_key;
        if (istFehler(b)) return { erlaubnis: 'nicht_moeglich', grund: `Der Server antwortet nicht wie erwartet (${b.error.message}). Später erneut versuchen.` };
      } catch {
        return { erlaubnis: 'nicht_moeglich', grund: 'Der Mac antwortet gerade nicht. Später erneut versuchen.' };
      }
    }
    if (!schluessel) return { erlaubnis: 'nicht_moeglich', grund: 'Der Server hat keinen Push-Schlüssel eingerichtet.' };
    const { stand, subscription } = await this.opt.push.abonnieren(schluessel);
    if (!subscription) return stand;
    for (const s of this.stand) {
      try {
        const a = await this.rufen<{ subscription_id: string }>(s.origin, 'PUT', '/push/subscription', { body: { subscription } });
        if (!istFehler(a)) await this.opt.speicher.pushAboSetzen(s.origin, a.data.subscription_id);
      } catch {
        // Eine schlafende Maschine bekommt das Abo beim naechsten Mal.
      }
    }
    return stand;
  }

  // --- Ereignisstrom ----------------------------------------------------------------

  abonnieren(bei: (ereignis: SseEvent) => void): () => void {
    return this.stroeme(bei, null);
  }

  /**
   * Der Strom einer Origin startet, sobald sie nach diesem Aufruf antwortet,
   * spaetestens mit `spaetestens` (dem Ende des Abgleichs). So kommen Ereignisse
   * der wachen Maschine, waehrend der Abgleich noch auf die andere wartet.
   */
  abonnierenAb(bei: (ereignis: SseEvent) => void, spaetestens: Promise<void>): () => void {
    return this.stroeme(bei, spaetestens);
  }

  private stroeme(bei: (ereignis: SseEvent) => void, spaetestens: Promise<void> | null): () => void {
    const abbrueche: AbortController[] = [];
    const hoerer: ((origin: string) => void)[] = [];
    let aktiv = true;
    for (const s of this.stand) {
      const abbruch = new AbortController();
      abbrueche.push(abbruch);
      const los = (): void => { void this.strom(s.origin, bei, abbruch.signal, () => aktiv); };
      if (!spaetestens) {
        los();
        continue;
      }
      let gestartet = false;
      const einmal = (): void => {
        this.antwortHoerer.delete(h);
        if (gestartet || !aktiv) return;
        gestartet = true;
        los();
      };
      const h = (origin: string): void => { if (origin === s.origin) einmal(); };
      hoerer.push(h);
      this.antwortHoerer.add(h);
      void spaetestens.then(einmal, einmal);
    }
    return () => {
      aktiv = false;
      for (const h of hoerer) this.antwortHoerer.delete(h);
      for (const a of abbrueche) a.abort();
    };
  }

  /** Ein Strom je Origin mit Wiederaufnahme; endet nur mit dem Abo. */
  private async strom(origin: string, bei: (e: SseEvent) => void, signal: AbortSignal, aktiv: () => boolean): Promise<void> {
    let letzteId = '';
    let pause = 1_000;
    while (aktiv() && !signal.aborted) {
      try {
        const ziel = anfrageziel('/events');
        let umschlag: string | null;
        try {
          umschlag = await this.signaturHeader(origin, 'GET', ziel, new Uint8Array());
        } catch {
          // Geraetespeicher kaputt: nicht als Netzfehler der Origin werten, spaeter erneut versuchen.
          throw new SpeicherStoerung();
        }
        if (!umschlag) return;
        const antwort = await this.holen(`${this.basis(origin)}${ziel.pfad}`, {
          method: 'GET', cache: 'no-store', credentials: 'omit', signal,
          headers: { Accept: 'text/event-stream', 'X-AWB-Mobile-Envelope': umschlag, ...(letzteId ? { 'Last-Event-ID': letzteId } : {}) },
        });
        if (!antwort.ok || !antwort.body) throw new Netzfehler(`SSE ${antwort.status}`);
        this.markieren(origin, true);
        pause = 1_000;
        await sseLesen(antwort.body, (e) => {
          if (e.id) letzteId = e.id;
          bei(e);
        });
      } catch (fehler) {
        if (signal.aborted || !aktiv()) return;
        if (!(fehler instanceof SpeicherStoerung)) this.markieren(origin, false);
      }
      await new Promise<void>((weiter) => {
        const uhr = setTimeout(weiter, pause);
        signal.addEventListener('abort', () => { clearTimeout(uhr); weiter(); }, { once: true });
      });
      pause = Math.min(pause * 2, 30_000);
    }
  }
}

/** Ein kleiner SSE-Parser: `id`, `event`, `data`; ein Leerzeile schliesst das Ereignis ab. */
export async function sseLesen(koerper: ReadableStream<Uint8Array>, bei: (e: SseEvent) => void): Promise<void> {
  const leser = koerper.getReader();
  const dekoder = new TextDecoder();
  let puffer = '';
  let daten: string[] = [];
  const abschliessen = (): void => {
    if (!daten.length) return;
    try {
      const e = JSON.parse(daten.join('\n')) as SseEvent;
      if (e && typeof e.id === 'string' && typeof e.type === 'string') bei(e);
    } catch {
      // Ein unlesbares Ereignis wird uebergangen; der naechste Abgleich holt den Stand.
    }
    daten = [];
  };
  for (;;) {
    const { value, done } = await leser.read();
    if (done) break;
    puffer += dekoder.decode(value, { stream: true });
    let umbruch: number;
    while ((umbruch = puffer.indexOf('\n')) >= 0) {
      const zeile = puffer.slice(0, umbruch).replace(/\r$/, '');
      puffer = puffer.slice(umbruch + 1);
      if (zeile === '') abschliessen();
      else if (zeile.startsWith('data:')) daten.push(zeile.slice(5).replace(/^ /, ''));
    }
  }
  abschliessen();
}
