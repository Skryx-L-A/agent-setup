/**
 * DER ANZEIGESTAND DER PWA.
 *
 * Er haelt die zuletzt geladenen Schnappschuesse, laedt nach Ereignissen
 * gezielt nach und weiss, wie alt jeder Stand ist. Zwei Regeln aus der
 * Spezifikation tragen ihn:
 *   - 2.3: Ist keine API erreichbar, bleibt die Huelle benutzbar, zeigt aber
 *     nichts als aktuell an.
 *   - 7.3: Ein alter gruener Punkt bleibt nie allein wegen eines
 *     eingefrorenen Timers gruen. Deshalb prueft `veraltet()` das Alter des
 *     letzten erfolgreichen Abgleichs, nicht einen Zeitgeber.
 */
import type {
  AgentAction,
  AgentActionData,
  ApiError,
  ApiResponse,
  Approval,
  ApprovalsData,
  BootstrapData,
  ChatMessage,
  CompatibilityResult,
  CreateSessionBody,
  Decision,
  Notification,
  NotificationsData,
  Prompt,
  SessionSummary,
  SessionsData,
  SseEvent,
} from '../../mobile-shared/vertrag';
import { compatibilityFor } from '../../mobile-shared/validierung';
import { MOBILE_API_VERSION } from '../../mobile-shared/vertrag';
import { agentsLesen, type AgentsAnsicht } from './agents-daten';
import type { Freigabeart, KopplungsStand, MaschinenStand, MobileQuelle, Nachreichen, PushStand, StartOptionen, Teilherkunft } from './quelle';
import { GERAETESPEICHER_MELDUNG, istGeraetespeicherStoerung, maschineVon } from './quelle';

/** Nach dieser Zeit ohne erfolgreichen Abgleich gilt ein Stand als veraltet. */
export const VERALTET_NACH_MS = 45_000;

export interface ChatStand {
  messages: ChatMessage[];
  fehler: ApiError | null;
  geladen: number;
}

/**
 * Eine gesendete Nachricht, die im Verlauf des Harness noch nicht steht. Sie
 * wird sofort gezeigt und verschwindet, sobald der Verlauf sie selbst fuehrt.
 *
 * ANLASS (29.09.2026, alice im ersten echten Test): die eigene Nachricht
 * erschien erst nach Verlassen und erneutem Oeffnen des Chats. Der Server nahm
 * sie an, aber die App lud danach nichts nach und zeigte nichts an.
 */
export interface Ausstehend {
  text: string;
  zeit: number;
}

/** So lange gilt eine Nachricht als unterwegs; danach fuehrt der Verlauf sie oder sie war nie dort. */
export const AUSSTEHEND_FRIST_MS = 90_000;
/** Nachladen nach dem Senden: der Harness schreibt seinen Verlauf einen Augenblick spaeter. */
const NACHLADEN_NACH_SENDEN_MS = [0, 1_500, 4_000];

/** Fuehrt der Verlauf die ausstehende Nachricht schon? Gleicher Text, nicht aelter als das Senden. */
export function ausstehendErledigt(a: Ausstehend, messages: readonly ChatMessage[], jetzt: number): boolean {
  if (jetzt - a.zeit > AUSSTEHEND_FRIST_MS) return true;
  const text = a.text.trim();
  // 5 s Spielraum: die Uhr des Geraets und der Zeitstempel des Harness laufen nicht gleich.
  return messages.some((m) => m.role === 'human' && m.text.trim() === text && m.created_at >= a.zeit - 5_000);
}

/** Leserouten einer Sitzung, die der Stand nach Ereignissen nachlaedt. */
export type Leseroute = 'chat' | 'prompt';

/** Wartezeiten nach `capability_unavailable`: erst 15 s, dann 60 s, danach je 5 min. */
export const ABSTAENDE_MS: readonly number[] = [15_000, 60_000, 300_000];

/**
 * Wachsender Abstand je Sitzung und Leseroute, nachdem der Server
 * `capability_unavailable` gemeldet hat. Die Uhr kommt von aussen (Tests).
 * Ein weiterer Fehlschlag, waehrend der Abstand noch laeuft (eine zweite
 * Anfrage war schon unterwegs), verlaengert ihn nicht.
 *
 * ANLASS (13.10.2026, Auftrag mobil-chatanzeige): Konnte der Server den
 * Verlauf einer Sitzung nicht lesen, fragte die App Chat und Rueckfrage trotzdem
 * bei jeder Regung des Panes nach, etwa alle 2 s; das Anfragejournal zeigte
 * hunderte gescheiterte Abfragen je Viertelstunde.
 */
export class Abstand {
  private eintraege = new Map<string, { stufe: number; bis: number }>();

  constructor(private readonly uhr: () => number = () => Date.now(), private readonly stufen: readonly number[] = ABSTAENDE_MS) {}

  /** Millisekunden bis zur naechsten erlaubten Anfrage; 0 heisst: jetzt fragen. */
  rest(route: Leseroute, id: string): number {
    const e = this.eintraege.get(schluessel(route, id));
    return e ? Math.max(0, e.bis - this.uhr()) : 0;
  }

  /** Die Route meldete `capability_unavailable`; gibt die neue Wartezeit zurueck. */
  fehlgeschlagen(route: Leseroute, id: string): number {
    const k = schluessel(route, id);
    const jetzt = this.uhr();
    const alt = this.eintraege.get(k);
    if (alt && alt.bis > jetzt) return alt.bis - jetzt;
    const stufe = alt ? Math.min(alt.stufe + 1, this.stufen.length - 1) : 0;
    this.eintraege.set(k, { stufe, bis: jetzt + this.stufen[stufe] });
    return this.stufen[stufe];
  }

  /** Erfolg, Senden oder Oeffnen der Ansicht; ohne Route alle Routen der Sitzung, ohne Sitzung alles. */
  zuruecksetzen(route?: Leseroute, id?: string): void {
    if (id === undefined) { this.eintraege.clear(); return; }
    for (const r of route ? [route] : (['chat', 'prompt'] as const)) this.eintraege.delete(schluessel(r, id));
  }
}

function schluessel(route: Leseroute, id: string): string {
  return `${route}\u0000${id}`;
}

export type Ergebnis<T> = { ok: true; data: T } | { ok: false; fehler: ApiError };

/** Ladewege, von denen nur der juengste Aufruf einmischen darf. */
type Ladeweg = 'abgleich' | 'liste' | 'meldungen';

const NETZFEHLER: ApiError = { code: 'internal_error', message: 'Keine Verbindung. Der Text bleibt hier, bis er zugestellt ist.', retryable: true };

/**
 * Ein Zwischenstand ersetzt nur die Eintraege der Maschinen, die darin schon
 * geantwortet haben; die anderen bleiben, bis ihre Origin antwortet oder der
 * Aufruf endet. Ohne Herkunft oder ohne vorigen Stand ersetzt er alles.
 *
 * ANLASS (09.10.2026, Auftrag mobil-flackern): antwortete beim Neuladen peer
 * vor dem Mac, verschwanden die Mac-Sitzungen fuer eine Laufzeit aus der
 * Liste, und ihre Rueckfragen wurden geloescht und neu geholt.
 */
export function teilErsetzen<X>(alt: readonly X[] | null, neu: readonly X[], geantwortet: readonly Teilherkunft[] | undefined, maschine: (x: X) => string): X[] {
  if (!alt || !geantwortet) return [...neu];
  const da = new Set(geantwortet.map((g) => g.machine));
  return [...neu.filter((x) => da.has(maschine(x))), ...alt.filter((x) => !da.has(maschine(x)))];
}

/**
 * Dasselbe fuer Freigaben, die kein Maschinenfeld tragen: Schluessel ist die
 * Origin, von der eine Freigabe kam (`herkunft`, aus der Quelle gemerkt).
 * Alles im Zwischenstand kommt von einer Origin, die geantwortet hat; von den
 * alten bleiben die der anderen Origins.
 */
export function freigabenTeilErsetzen(alt: readonly Approval[], neu: readonly Approval[], geantwortet: readonly Teilherkunft[] | undefined,
  herkunft: (id: string) => string | null): Approval[] {
  if (!geantwortet) return [...neu];
  const da = new Set(geantwortet.map((g) => g.origin));
  const ids = new Set(neu.map((f) => f.id));
  return [...neu, ...alt.filter((f) => !ids.has(f.id) && !da.has(herkunft(f.id) ?? ''))];
}

/**
 * Fehlercodes, deren Servermeldung (englisch) die App nie zeigt, in Worten der
 * Oberflaeche. Die einzige Stelle fuer diese Abbildung: jede Schreibantwort
 * laeuft durch `auswerten`, ob Nachricht, Taste, Rueckfrage oder Sitzungsaktion.
 *
 * ANLASS (09.10.2026, Auftrag mobil-pane-busy): `wb-pane-write` tippt nichts
 * mehr in einen Pane, der nicht frei ist, und der Kern sperrt Nachrichten bei
 * offenem Dialog. Beides meldet `pane_busy` (Vertrag 1.9); vorher sah das
 * Telefon nur einen englischen, nichtssagenden Fehler.
 */
export const FEHLER_IN_WORTEN: Readonly<Partial<Record<ApiError['code'], string>>> = {
  pane_busy: 'Die Sitzung nimmt gerade keine Eingabe an. Ein Dialog wartet auf Antwort, oder in ihrem Eingabefeld steht noch Text. Antworte zuerst dort, dann sende noch einmal.',
};

export function fehlerInWorten(f: ApiError): ApiError {
  const text = FEHLER_IN_WORTEN[f.code];
  return text ? { ...f, message: text } : f;
}

function auswerten<T>(a: ApiResponse<T>): Ergebnis<T> {
  return 'error' in a ? { ok: false, fehler: fehlerInWorten(a.error) } : { ok: true, data: a.data };
}

/**
 * Die Ablehnung des Kerns in einer Agents-Antwort. Der Server antwortet auch
 * dann mit Erfolg, wenn der Kern die Handlung ablehnt: der Adapter reicht das
 * `WeltenHandlungsErgebnis` aus `main/welten.ts` unveraendert als
 * `data.result` weiter, also `ok`, `handlung`, `id`, `meldung` und bei einer
 * Rueckfrage `rueckfrage` (die Meldung heisst dann nur „Rückfrage“). Bei
 * `ok: false` wird daraus ein Fehler mit dem Text des Kerns, wie bei einem
 * HTTP-Fehler.
 *
 * ANLASS (09.10.2026): Ein unbekanntes Team, ein schon vergebenes Ticket oder
 * ein fehlendes Abnahmerecht meldete die App als Erfolg; die Meldung des Kerns
 * sah niemand.
 */
export function kernAblehnung(data: AgentActionData): ApiError | null {
  const r = data.result;
  if (r === null || typeof r !== 'object' || Array.isArray(r) || r.ok !== false) return null;
  const meldung = typeof r.meldung === 'string' ? r.meldung.trim() : '';
  const rueckfrage = typeof r.rueckfrage === 'string' ? r.rueckfrage.trim() : '';
  const text = rueckfrage && (!meldung || meldung === 'Rückfrage') ? rueckfrage : meldung;
  return { code: 'bad_request', message: text || 'Der Kern hat die Handlung abgelehnt.', retryable: false };
}

export class Stand {
  kopplung: KopplungsStand | null = null;
  bootstrap: BootstrapData | null = null;
  kompatibel: CompatibilityResult | null = null;
  maschinen: readonly MaschinenStand[] = [];
  sitzungen: SessionSummary[] | null = null;
  freigaben: Approval[] = [];
  /** Je angezeigter Freigabe die Origin, von der sie kam. */
  private freigabenOrigin = new Map<string, string>();
  prompts = new Map<string, Prompt | null>();
  chats = new Map<string, ChatStand>();
  /** Je Sitzung die gesendeten, im Verlauf noch nicht gefuehrten Nachrichten. */
  ausstehend = new Map<string, Ausstehend[]>();
  agents: AgentsAnsicht | null = null;
  meldungen: Notification[] | null = null;
  push: PushStand | null = null;
  startOptionen: StartOptionen | null = null;
  /** Zeitpunkt der letzten frischen Antwort eines laufenden Abgleichs oder seines Endes. */
  abgeglichen = 0;
  /** Antwortet gerade irgendeine API? */
  verbunden = true;
  /** Der Gerätespeicher verhindert das Signieren: dann ging nie eine Anfrage hinaus (kein Netzproblem). */
  geraeteMeldung: string | null = null;
  laedt = false;
  private gelesen = new Set<string>();
  private hoerer = new Set<() => void>();
  private geplant = false;
  private abo: (() => void) | null = null;
  private gesehen = new Set<string>();
  private runden = new Map<Ladeweg, number>();
  /** Die Rueckfragen der aktuellen Liste: je Sitzung hoechstens eine Anfrage. */
  private promptLaeufe = new Map<string, Promise<void>>();
  /** Je Sitzung und Route der Abstand nach `capability_unavailable`. */
  readonly abstand: Abstand;
  /** Waehrend eines Abstands erbetene Abfragen: je Route und Sitzung eine, am Ende des Abstands. */
  private nachholen = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly quelle: MobileQuelle, uhr: () => number = () => Date.now()) {
    this.abstand = new Abstand(uhr);
    try {
      const roh = localStorage.getItem('awb-mobil-gelesen');
      if (roh) for (const id of JSON.parse(roh) as string[]) this.gelesen.add(id);
    } catch { /* ohne Speicher gilt alles als ungelesen */ }
  }

  bei(fn: () => void): () => void {
    this.hoerer.add(fn);
    return () => this.hoerer.delete(fn);
  }

  /** Aenderungen werden gebuendelt: eine Zeichnung je Mikroaufgabe. */
  melden(): void {
    if (this.geplant) return;
    this.geplant = true;
    queueMicrotask(() => {
      this.geplant = false;
      for (const h of this.hoerer) h();
    });
  }

  veraltet(jetzt = Date.now()): boolean {
    return !this.verbunden || jetzt - this.abgeglichen > VERALTET_NACH_MS;
  }

  darfSchreiben(): boolean {
    return this.verbunden && (this.kompatibel?.mutations_allowed ?? true);
  }

  faehig(name: string): boolean {
    return this.bootstrap?.capabilities[name] === true;
  }

  maschine(id: string): MaschinenStand | undefined {
    return this.maschinen.find((m) => m.machine === id);
  }

  /** Eine Sitzung ist beschreibbar, wenn ihre eigene Maschine direkt antwortet. */
  beschreibbar(s: SessionSummary): boolean {
    const m = this.maschine(s.id.split(':')[0]);
    return this.darfSchreiben() && s.source === 'authoritative' && m?.erreichbar === true;
  }

  // --- Laden ------------------------------------------------------------------

  async start(): Promise<void> {
    // Schweigt der Geraetespeicher, bleibt die Kopplung UNBEKANNT (`kopplung` null): nie als
    // „nicht gekoppelt" zeigen, das verleitet zum Neukoppeln. Der naechste Abgleich fragt erneut.
    await this.kopplungLesen();
    try { this.push = await this.quelle.push(); } catch { /* Mitteilungen sind Komfort; der Speicher meldet sich ueber die Kopplung */ }
    this.melden();
    if (this.kopplung?.gekoppelt) await this.abgleichen();
  }

  /** Liest die Kopplung; null, wenn der Geraetespeicher nicht antwortet (dann Geraetemeldung statt Stand). */
  private async kopplungLesen(): Promise<KopplungsStand | null> {
    try {
      const k = await this.quelle.kopplung();
      this.kopplung = k;
      this.geraeteMeldung = null;
      return k;
    } catch {
      this.geraeteMeldung = GERAETESPEICHER_MELDUNG;
      this.verbunden = false;
      this.melden();
      return null;
    }
  }

  /**
   * Vollstaendiger Abgleich. Laeuft beim Start, nach `visibilitychange`,
   * `pageshow`, `online` und nach `server.reset`. Das Ereignisabo wird dabei
   * verworfen und neu aufgebaut (Spezifikation 7.3).
   *
   * Die Liste wartet nicht auf die langsamste Origin: jede Antwort wird
   * eingemischt, sobald sie da ist (die Quelle haelt „direkt schlaegt
   * Spiegel“ ein), und die Rueckfragen kommen danach. Teilstaende erst nach
   * dem Bootstrap, denn bis dahin ist offen, ob diese App schreiben darf.
   *
   * Kann die Quelle es, steht das Ereignisabo je Origin, sobald diese
   * geantwortet hat, und nicht erst am Ende (spaetestens dann). Nur der
   * juengste Abgleich haelt ein Abo; scheitert er ganz, gibt es keins.
   *
   * Er faengt neu an: jeder Abstand nach `capability_unavailable` faellt
   * (auch nach `server.reset`), die Rueckfragen dieser Liste werden wieder gefragt.
   */
  async abgleichen(): Promise<void> {
    this.abstandAufheben();
    if (!this.kopplung) {
      // Kopplung noch unbekannt (Speicher schwieg beim Start): erst sie erneut lesen.
      const k = await this.kopplungLesen();
      if (!k) return;
      this.melden();
      if (!k.gekoppelt) return;
    }
    this.abo?.();
    this.abo = null;
    this.laedt = true;
    this.melden();
    const abgleich = this.neueRunde('abgleich');
    const liste = this.neueRunde('liste');
    const meldungen = this.neueRunde('meldungen');
    let ende = (): void => {};
    const fertig = new Promise<void>((weiter) => { ende = weiter; });
    if (this.quelle.abonnierenAb) this.abo = this.quelle.abonnierenAb((e) => { void this.ereignis(e); }, fertig);
    this.maschinen = await this.quelle.maschinen();
    try {
      const boot = this.quelle.bootstrap().then((b) => {
        if (abgleich()) this.geraeteMeldung = 'error' in b && istGeraetespeicherStoerung(b) ? GERAETESPEICHER_MELDUNG : null;
        if (abgleich() && !('error' in b)) {
          this.bootstrap = b.data;
          this.kompatibel = compatibilityFor(
            { api_version: MOBILE_API_VERSION, build: this.quelle.client_build },
            { api_version: b.api_version, build: b.server_build },
          );
        }
        return b;
      });
      const bereit = boot.then(() => undefined, () => undefined);
      const sitz = this.einmischer(liste, (d: SessionsData, g) => this.sitzungenSetzen(d, g), bereit);
      const frei = this.einmischer(liste, (d: ApprovalsData, g) => this.freigabenSetzen(d, g), bereit);
      const meld = this.einmischer(meldungen, (d: NotificationsData, g) => this.meldungenSetzen(d, g), bereit);
      const [, s, f, m, ag] = await Promise.all([
        boot,
        this.quelle.sitzungen(sitz.nach),
        this.quelle.freigaben(frei.nach),
        this.quelle.meldungen(undefined, meld.nach),
        this.quelle.agents(),
      ]);
      sitz.ende(s);
      frei.ende(f);
      meld.ende(m);
      if (abgleich()) {
        if (!('error' in ag)) this.agents = agentsLesen(ag.data);
        this.verbunden = !this.geraeteMeldung;
        if (!this.geraeteMeldung) this.abgeglichen = Date.now();
        this.abo ??= this.quelle.abonnieren((e) => { void this.ereignis(e); });
      }
    } catch {
      if (abgleich()) {
        this.verbunden = false;
        this.trennen();
      }
    } finally {
      ende();
      if (abgleich()) this.laedt = false;
      this.maschinen = await this.quelle.maschinen();
      this.melden();
    }
  }

  trennen(): void {
    this.abo?.();
    this.abo = null;
  }

  /** Neuer Aufruf eines Ladewegs; die Rueckgabe sagt, ob er noch der juengste ist. */
  private neueRunde(weg: Ladeweg): () => boolean {
    const nr = (this.runden.get(weg) ?? 0) + 1;
    this.runden.set(weg, nr);
    if (weg === 'liste') this.promptLaeufe = new Map();
    return () => this.runden.get(weg) === nr;
  }

  /**
   * Teilstaende eines Lesewegs aus der Quelle, eingemischt, solange der Aufruf
   * der juengste ist. Wartet ein Teilstand noch auf `bereit`, zaehlt nur der
   * neueste; `ende` setzt das Ergebnis und verwirft aeltere wartende. Waehrend
   * eines Abgleichs zaehlt jede frische Antwort als Verbindung; eine spaeter
   * aufgewachte Origin aendert nur die Daten.
   */
  private einmischer<T>(gilt: () => boolean, setzen: (data: T, geantwortet?: readonly Teilherkunft[]) => void, bereit: Promise<void> = Promise.resolve()): {
    nach: Nachreichen<T>; ende(a: ApiResponse<T>): void;
  } {
    let nr = 0;
    return {
      nach: (a, geantwortet) => {
        const meiner = ++nr;
        void bereit.then(() => {
          if (meiner !== nr || !gilt()) return;
          if (!('error' in a)) {
            setzen(a.data, geantwortet);
            if (this.laedt) {
              this.verbunden = true;
              this.abgeglichen = Date.now();
            }
          }
          void this.maschinenLesen();
        });
      },
      ende: (a) => {
        nr += 1;
        if (gilt() && !('error' in a)) setzen(a.data);
      },
    };
  }

  private async maschinenLesen(): Promise<void> {
    this.maschinen = await this.quelle.maschinen();
    this.melden();
  }

  private sitzungenSetzen(d: SessionsData, geantwortet?: readonly Teilherkunft[]): void {
    const gespiegelt = new Set((this.sitzungen ?? []).filter((s) => s.source === 'mirror').map((s) => s.id));
    this.sitzungen = teilErsetzen(this.sitzungen, d.sessions, geantwortet, (s) => maschineVon(s.id));
    // Antwortet die Maschine einer gespiegelten Sitzung wieder direkt, faellt ihr Abstand; ein
    // Verlauf, den der Spiegel nicht lesen konnte, wird sofort neu geholt (Nachtrag 1 mobil-chatanzeige).
    for (const s of this.sitzungen) {
      if (s.source !== 'authoritative' || !gespiegelt.has(s.id)) continue;
      this.abstandAufheben(undefined, s.id);
      if (this.chats.get(s.id)?.fehler?.code === 'capability_unavailable') void this.chatLaden(s.id);
    }
    void this.promptsLaden();
  }

  /**
   * Die Herkunft jeder angezeigten Freigabe merkt sich der Stand selbst: die
   * Quelle kennt nach einem spaeteren Zwischenstand nur noch die Freigaben,
   * die es dort noch gibt.
   */
  private freigabenSetzen(d: ApprovalsData, geantwortet?: readonly Teilherkunft[]): void {
    const quelle = this.quelle.freigabeHerkunft?.bind(this.quelle);
    const alt = this.freigabenOrigin;
    this.freigaben = quelle ? freigabenTeilErsetzen(this.freigaben, d.approvals, geantwortet, (id) => alt.get(id) ?? null) : [...d.approvals];
    this.freigabenOrigin = new Map(this.freigaben.map((f) => [f.id, quelle?.(f.id) ?? alt.get(f.id) ?? ''] as const));
  }

  private meldungenSetzen(d: NotificationsData, geantwortet?: readonly Teilherkunft[]): void {
    this.meldungen = teilErsetzen(this.meldungen, d.notifications, geantwortet, (n) => n.machine)
      .sort((l, r) => r.created_at - l.created_at);
  }

  /**
   * Rueckfragen der wartenden direkten Sitzungen, ohne die Liste aufzuhalten.
   * Je Liste wird jede Rueckfrage einmal geholt und einzeln eingetragen; bis
   * dahin bleibt die vorige stehen.
   */
  private promptsLaden(): Promise<void> {
    const ziele = (this.sitzungen ?? []).filter((s) => s.state === 'attention' && s.source === 'authoritative');
    const ids = new Set<string>(ziele.map((s) => s.id));
    for (const id of [...this.prompts.keys()]) if (!ids.has(id)) this.prompts.delete(id);
    const laeufe = this.promptLaeufe;
    return Promise.all(ziele.map((s) => {
      let lauf = laeufe.get(s.id);
      if (!lauf) {
        if (this.gebremst('prompt', s.id, () => { void this.promptsLaden(); })) return undefined;
        lauf = this.quelle.prompt(s.id).then((a) => {
          this.abstandMerken('prompt', s.id, a);
          const gilt = laeufe === this.promptLaeufe
            && (this.sitzungen ?? []).some((x) => x.id === s.id && x.state === 'attention' && x.source === 'authoritative');
          if (!gilt) return;
          this.prompts.set(s.id, 'error' in a ? null : a.data.prompt);
          this.melden();
        }, () => { laeufe.delete(s.id); });
        laeufe.set(s.id, lauf);
      }
      return lauf;
    })).then(() => undefined);
  }

  /**
   * Laeuft fuer die Route noch ein Abstand, wird nicht gefragt, sondern die
   * Abfrage einmal fuer sein Ende vorgemerkt: ein neuer Verlauf erscheint
   * hoechstens um den Abstand spaeter.
   */
  private gebremst(route: Leseroute, id: string, laden: () => void): boolean {
    const rest = this.abstand.rest(route, id);
    if (rest <= 0) return false;
    const k = schluessel(route, id);
    if (!this.nachholen.has(k)) this.nachholen.set(k, setTimeout(() => { this.nachholen.delete(k); laden(); }, rest));
    return true;
  }

  /** Nur `capability_unavailable` bremst; Erfolg setzt zurueck, andere Fehler aendern nichts. */
  private abstandMerken(route: Leseroute, id: string, a: ApiResponse<unknown>): void {
    if (!('error' in a)) this.abstandAufheben(route, id);
    else if (a.error.code === 'capability_unavailable') this.abstand.fehlgeschlagen(route, id);
  }

  /** Abstand und vorgemerkte Abfrage aufheben; ohne Route beide Routen der Sitzung, ohne Sitzung alle. */
  private abstandAufheben(route?: Leseroute, id?: string): void {
    this.abstand.zuruecksetzen(route, id);
    for (const [k, uhr] of this.nachholen) {
      if (id === undefined || (route ? k === schluessel(route, id) : k.endsWith(`\u0000${id}`))) {
        clearTimeout(uhr);
        this.nachholen.delete(k);
      }
    }
  }

  /** Die Chatansicht oeffnet sich: ohne Abstand sofort laden. */
  chatOeffnen(id: string): Promise<void> {
    this.abstandAufheben(undefined, id);
    return this.chatLaden(id);
  }

  async chatLaden(id: string): Promise<void> {
    if (this.gebremst('chat', id, () => { void this.chatLaden(id); })) return;
    try {
      const a = await this.quelle.chat(id);
      this.abstandMerken('chat', id, a);
      const alt = this.chats.get(id);
      if ('error' in a) {
        this.chats.set(id, { messages: alt?.messages ?? [], fehler: a.error, geladen: Date.now() });
      } else {
        this.chats.set(id, { messages: [...a.data.messages], fehler: null, geladen: Date.now() });
        const offen = (this.ausstehend.get(id) ?? []).filter((x) => !ausstehendErledigt(x, a.data.messages, Date.now()));
        if (offen.length) this.ausstehend.set(id, offen);
        else this.ausstehend.delete(id);
      }
    } catch {
      this.verbunden = false;
    }
    this.melden();
  }

  private async sitzungenLaden(): Promise<void> {
    const liste = this.neueRunde('liste');
    const sitz = this.einmischer(liste, (d: SessionsData, g) => this.sitzungenSetzen(d, g));
    const frei = this.einmischer(liste, (d: ApprovalsData, g) => this.freigabenSetzen(d, g));
    const [s, f] = await Promise.all([this.quelle.sitzungen(sitz.nach), this.quelle.freigaben(frei.nach)]);
    sitz.ende(s);
    frei.ende(f);
    if (liste()) this.abgeglichen = Date.now();
  }

  /** Ereignisse tragen nur IDs; der Stand laedt gezielt nach (Spezifikation 3.2). */
  async ereignis(e: SseEvent): Promise<void> {
    if (this.gesehen.has(e.id)) return;
    this.gesehen.add(e.id);
    try {
      switch (e.type) {
        case 'session.changed':
        case 'approval.changed':
        case 'prompt.changed':
          await this.sitzungenLaden();
          break;
        case 'chat.changed':
          for (const id of e.ids) if (this.chats.has(id)) await this.chatLaden(id);
          break;
        case 'agents.changed': {
          const a = await this.quelle.agents();
          if (!('error' in a)) this.agents = agentsLesen(a.data);
          break;
        }
        case 'notification.changed': {
          const meld = this.einmischer(this.neueRunde('meldungen'), (d: NotificationsData, g) => this.meldungenSetzen(d, g));
          meld.ende(await this.quelle.meldungen(undefined, meld.nach));
          break;
        }
        case 'server.reset':
        case 'capability.changed':
          await this.abgleichen();
          return;
        case 'heartbeat':
          this.abgeglichen = Date.now();
          break;
      }
    } catch {
      this.verbunden = false;
    }
    this.melden();
  }

  // --- Schreiben ----------------------------------------------------------------

  private async schreiben<T>(f: () => Promise<ApiResponse<T>>): Promise<Ergebnis<T>> {
    if (!this.darfSchreiben()) {
      if (this.geraeteMeldung) return { ok: false, fehler: { code: 'internal_error', message: this.geraeteMeldung, retryable: true } };
      return { ok: false, fehler: this.verbunden
        ? { code: 'unsupported_api_version', message: 'Die App ist älter als der Server. Lade neu, bevor Du etwas änderst.', retryable: false }
        : NETZFEHLER };
    }
    try {
      return auswerten(await f());
    } catch {
      this.verbunden = false;
      this.melden();
      return { ok: false, fehler: NETZFEHLER };
    }
  }

  async senden(id: string, text: string) {
    const r = await this.schreiben(() => this.quelle.senden(id, { text }));
    if (r.ok) {
      this.ausstehend.set(id, [...(this.ausstehend.get(id) ?? []), { text, zeit: Date.now() }]);
      this.abstandAufheben(undefined, id);
      this.melden();
      // Nicht auf das naechste Ereignis warten: der Harness schreibt die
      // Nachricht einen Augenblick spaeter in seinen Verlauf.
      for (const warten of NACHLADEN_NACH_SENDEN_MS) {
        setTimeout(() => { if (this.ausstehend.has(id)) void this.chatLaden(id); }, warten);
      }
    }
    return r;
  }

  taste(id: string, key: import('../../mobile-shared/vertrag').AllowedSpecialKey) {
    return this.schreiben(() => this.quelle.taste(id, { key }));
  }

  promptAntworten(id: string, fingerprint: string, option_id: string) {
    return this.schreiben(() => this.quelle.promptAntworten(id, { fingerprint, option_id }));
  }

  async entscheiden(art: Freigabeart, id: string, decision: Decision, reason: string) {
    const r = await this.schreiben(() => this.quelle.entscheiden(art, id, { decision, reason }));
    if (r.ok) this.freigaben = this.freigaben.filter((f) => f.id !== id);
    this.melden();
    return r;
  }

  async anlegen(body: CreateSessionBody) {
    const r = await this.schreiben(() => this.quelle.sitzungAnlegen(body));
    if (r.ok) this.sitzungen = [r.data.session, ...(this.sitzungen ?? []).filter((s) => s.id !== r.data.session.id)];
    this.melden();
    return r;
  }

  async fortsetzen(id: string) {
    const r = await this.schreiben(() => this.quelle.fortsetzen(id));
    if (r.ok) this.sitzungen = (this.sitzungen ?? []).map((s) => s.id === id ? r.data.session : s);
    this.melden();
    return r;
  }

  schliessen(id: string) {
    return this.schreiben(() => this.quelle.schliessen(id));
  }

  /** Vertrag 1.8: „Bescheid geben“ setzen oder zuruecknehmen; zeigt den neuen Stand sofort. */
  async bescheid(id: string, active: boolean) {
    const r = await this.schreiben(() => this.quelle.bescheid(id, { active }));
    if (r.ok) {
      const s = this.sitzungen?.find((x) => x.id === id);
      if (s) s.notify_until = r.data.notify_until;
    }
    this.melden();
    return r;
  }

  async agentAktion(a: AgentAction): Promise<Ergebnis<AgentActionData>> {
    const antwort = await this.schreiben(() => this.quelle.agentAktion(a));
    const abgelehnt = antwort.ok ? kernAblehnung(antwort.data) : null;
    const r: Ergebnis<AgentActionData> = abgelehnt ? { ok: false, fehler: abgelehnt } : antwort;
    if (r.ok) {
      const neu = await this.quelle.agents().catch(() => null);
      if (neu && !('error' in neu)) this.agents = agentsLesen(neu.data);
    }
    this.melden();
    return r;
  }

  async optionenLaden(): Promise<StartOptionen | null> {
    try {
      this.startOptionen = await this.quelle.startOptionen();
    } catch {
      this.verbunden = false;
    }
    this.melden();
    return this.startOptionen;
  }

  async pushAnfragen(): Promise<void> {
    this.push = await this.quelle.pushAnfragen();
    this.melden();
  }

  async koppeln(code: string, geraet: string) {
    try {
      const r = auswerten(await this.quelle.koppeln({ pairing_code: code, device_name: geraet }));
      if (r.ok) {
        // Gekoppelt ist am Server; schweigt jetzt der Geraetespeicher, meldet das kopplungLesen selbst.
        await this.kopplungLesen();
        this.melden();
        void this.abgleichen();
      }
      return r;
    } catch {
      return { ok: false as const, fehler: { code: 'internal_error' as const, message: 'Der Mac antwortet nicht. Prüfe, ob er wach und im Tailnet ist.', retryable: true } };
    }
  }

  // --- Gelesen-Stand der Meldungen (nur auf diesem Geraet) --------------------

  ungelesen(n: Notification): boolean {
    return !this.gelesen.has(n.id);
  }

  alsGelesen(ids: string[]): void {
    for (const id of ids) this.gelesen.add(id);
    try { localStorage.setItem('awb-mobil-gelesen', JSON.stringify([...this.gelesen].slice(-500))); } catch { /* nur Komfort */ }
    this.melden();
  }
}
