/**
 * DIE ATTRAPPEN-QUELLE: `MobileQuelle` ohne Server.
 *
 * Sie verhaelt sich wie die spaetere HTTP-Fassung, soweit die Oberflaeche es
 * sehen kann: Antworten tragen die Vertragsform samt `ApiMeta`, Mutationen
 * aendern den Stand und melden sich ueber den Ereignisstrom, Prompt-Antworten
 * scheitern mit `capability_unavailable` (Spezifikation 5.3), und ohne Netz
 * scheitert jeder Aufruf.
 *
 * Steuerung ueber die Adresse, nur in dieser Attrappe:
 *   ?attrappe=standard|alle|offline|ungekoppelt|leer
 *   &live=0     keine selbsttaetigen Ereignisse (Tests, Bildschirmfotos)
 *   &latenz=0   Antworten ohne kuenstliche Verzoegerung
 *   &ohneverlauf=<id>[,<id>]  Chat und Rueckfrage dieser Sitzungen scheitern
 *               mit `capability_unavailable` und der englischen Servermeldung
 */
import type {
  AgentAction,
  AgentActionData,
  AgentsData,
  ApiFailure,
  ApiResponse,
  ApprovalsData,
  BootstrapData,
  ChatData,
  ChatMessage,
  CloseSessionData,
  CreateSessionBody,
  CreateSessionData,
  DecisionBody,
  DecisionData,
  JsonObject,
  JsonValue,
  MobileApiErrorCode,
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
  SessionNotifyData,
  SessionsData,
  SseEvent,
  SseEventType,
} from '../../mobile-shared/vertrag';
import { MOBILE_API_VERSION } from '../../mobile-shared/vertrag';
import type {
  Freigabeart,
  KopplungsStand,
  KoppelnWunsch,
  MaschinenStand,
  MobileQuelle,
  PushStand,
  StartOptionen,
} from '../components/quelle';
import { maschineVon } from '../components/quelle';
import { erzeugen, SZENARIEN, type AttrappenWelt, type Szenario } from './daten';
import { teamEmpfaenger, teamsAusAgenten, type AgentKurz, type TeamKurz } from '../components/agents-daten';

const BUILD = '2026.09.18-6a7d3eb';

export interface AttrappenOptionen {
  szenario: Szenario;
  live: boolean;
  latenzMs: number;
  /**
   * `?verlauf=spaet`: wie der echte Kern -- eine gesendete Nachricht steht erst
   * nach einer Weile im Verlauf, und dabei kommt KEIN `chat.changed`. Bis
   * 29.09.2026 hing die Attrappe jede Nachricht sofort an und meldete sie; deshalb
   * blieb unbemerkt, dass die App nach dem Senden weder etwas zeigte noch nachlud.
   */
  verlaufSpaet: boolean;
  /**
   * `?ohneverlauf=`: wie der Kern, wenn er das Gespraech einer Sitzung nicht lesen
   * kann (Pane ohne Harness, keine Sitzungsdatei) oder fuer die Claude-Version
   * keine Dialogerkennung gemessen ist (13.10.2026, Auftrag mobil-chatanzeige).
   */
  ohneVerlauf: readonly string[];
}

export function optionenAusAdresse(suche: string): AttrappenOptionen {
  const p = new URLSearchParams(suche);
  const s = p.get('attrappe') as Szenario | null;
  return {
    szenario: s && SZENARIEN.includes(s) ? s : 'standard',
    live: p.get('live') !== '0',
    latenzMs: p.get('latenz') === '0' ? 0 : 220,
    verlaufSpaet: p.get('verlauf') === 'spaet',
    ohneVerlauf: (p.get('ohneverlauf') ?? '').split(',').filter(Boolean),
  };
}

class Netzfehler extends Error {}

export class AttrappenQuelle implements MobileQuelle {
  readonly name = 'attrappe';
  readonly client_build = BUILD;
  private welt: AttrappenWelt;
  private gekoppelt: KopplungsStand;
  private hoerer = new Set<(e: SseEvent) => void>();
  private seq = 1;
  private versuche = 5;
  private pushStand: PushStand;
  private uhr: number | undefined;
  private liveSchritt = 0;
  /** Nur fuer Tests: Lesezugriffe je Route und Sitzung, Schluessel `chat:<id>` oder `prompt:<id>`. */
  readonly abfragen: Record<string, number> = {};

  constructor(private opt: AttrappenOptionen) {
    this.welt = erzeugen(Date.now(), opt.szenario);
    this.gekoppelt = opt.szenario === 'ungekoppelt'
      ? { gekoppelt: false, geraet: null, device_id: null, seit: null }
      : { gekoppelt: true, geraet: geraetename(), device_id: 'dev-5d21', seit: Date.now() - 2 * 86_400_000 };
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
      || matchMedia('(display-mode: standalone)').matches;
    this.pushStand = standalone
      ? { erlaubnis: 'offen', grund: null }
      : { erlaubnis: 'nicht_moeglich', grund: 'Mitteilungen gibt es erst, wenn die Werkbank vom Home-Bildschirm aus läuft.' };
  }

  // --- Hilfen ---------------------------------------------------------------

  private async warte(): Promise<void> {
    if (!navigator.onLine) throw new Netzfehler('offline');
    if (this.opt.latenzMs > 0) await new Promise((r) => setTimeout(r, this.opt.latenzMs * (0.6 + Math.random() * 0.8)));
    if (!navigator.onLine) throw new Netzfehler('offline');
  }

  private erreichbar(machine: string): boolean {
    return this.welt.maschinen.some((m) => m.machine === machine && m.erreichbar);
  }

  private meta(machine = 'mac') {
    return {
      api_version: MOBILE_API_VERSION,
      server_build: BUILD,
      machine,
      authoritative: true,
      request_id: `req-${Math.random().toString(36).slice(2, 10)}`,
    };
  }

  private ok<T>(data: T, machine = 'mac'): ApiResponse<T> {
    return { ...this.meta(machine), data };
  }

  private fehler(code: MobileApiErrorCode, message: string, retryable = false, machine = 'mac'): ApiFailure {
    return { ...this.meta(machine), error: { code, message, retryable } };
  }

  /** Irgendeine API muss antworten; sonst scheitert der Aufruf wie ein Netzfehler. */
  private async irgendeine(): Promise<void> {
    await this.warte();
    if (!this.welt.maschinen.some((m) => m.erreichbar)) throw new Netzfehler('keine API erreichbar');
  }

  private melden(type: SseEventType, machine: string, ids: string[]): void {
    const e: SseEvent = {
      id: `${machine}:e7:${this.seq++}`,
      type, machine, source: 'authoritative', api_version: MOBILE_API_VERSION, server_build: BUILD, ids,
    };
    for (const h of this.hoerer) setTimeout(() => h(e), 0);
  }

  private chatVon(id: string): ChatMessage[] {
    let c = this.welt.chats.get(id);
    if (!c) { c = []; this.welt.chats.set(id, c); }
    return c;
  }

  private anhaengen(sessionId: string, role: ChatMessage['role'], text: string, melden = true): ChatMessage {
    const c = this.chatVon(sessionId);
    const [kopf, ...ausgabe] = text.split('\n');
    const treffer = kopf.match(/^([A-Za-z][\w.-]*)\((.*)\)$/);
    const m: ChatMessage = {
      id: `${sessionId}-x${Date.now()}-${c.length}`, role, text, created_at: Date.now(),
      ...(role === 'tool' ? {
        tool: { name: treffer?.[1] ?? 'Werkzeug', arguments_preview: treffer?.[2] ?? kopf, output_preview: ausgabe.join('\n').slice(0, 8_000) },
      } : {}),
    };
    c.push(m);
    const s = this.welt.sitzungen.find((x) => x.id === sessionId);
    if (s) this.welt.sitzungen = this.welt.sitzungen.map((x) => x.id === sessionId ? { ...x, updated_at: m.created_at } : x);
    if (melden) {
      this.melden('chat.changed', maschineVon(sessionId), [sessionId]);
      this.melden('session.changed', maschineVon(sessionId), [sessionId]);
    }
    return m;
  }

  /** Schreibende Aufrufe gehen nur an die autoritative, erreichbare Origin (Spezifikation 4.4). */
  private schreibziel(sessionId: string): ApiFailure | null {
    const s = this.welt.sitzungen.find((x) => x.id === sessionId);
    if (!s) return this.fehler('stale_target', 'Diese Sitzung gibt es nicht mehr.');
    if (s.source !== 'authoritative' || !this.erreichbar(maschineVon(sessionId))) {
      return this.fehler('stale_target', `${maschineVon(sessionId)} ist nicht erreichbar. Nur die Maschine selbst nimmt Eingaben an.`, true);
    }
    return null;
  }

  // --- Kopplung -------------------------------------------------------------

  async kopplung(): Promise<KopplungsStand> {
    return { ...this.gekoppelt };
  }

  async koppeln(w: KoppelnWunsch): Promise<ApiResponse<PairingCompleteData>> {
    await this.warte();
    if (!this.erreichbar('mac')) throw new Netzfehler('mac nicht erreichbar');
    if (!/^\d{6}$/.test(w.pairing_code)) return this.fehler('bad_request', 'Der Code hat sechs Ziffern.');
    if (this.versuche <= 0) return this.fehler('rate_limited', 'Zu viele Versuche. Starte die Kopplung am Mac neu.');
    if (w.pairing_code === '000000') {
      this.versuche -= 1;
      return this.fehler('invalid_signature', `Der Code stimmt nicht. Noch ${this.versuche} Versuche.`);
    }
    this.gekoppelt = { gekoppelt: true, geraet: w.device_name, device_id: 'dev-5d21', seit: Date.now() };
    return this.ok({ device_id: 'dev-5d21', key_id: 'key-1', paired_at: Date.now() });
  }

  // --- Lesen ----------------------------------------------------------------

  async maschinen(): Promise<readonly MaschinenStand[]> {
    if (!navigator.onLine) {
      return this.welt.maschinen.map((m) => ({ ...m, erreichbar: false, seit: m.seit ?? Date.now() }));
    }
    const jetzt = Date.now();
    return this.welt.maschinen.map((m) => ({ ...m, zuletzt: m.erreichbar ? jetzt : m.zuletzt }));
  }

  async bootstrap(): Promise<ApiResponse<BootstrapData>> {
    await this.irgendeine();
    return this.ok({
      origins: this.welt.maschinen.map((m) => m.origin),
      capabilities: {
        'prompt.answer.claude': false,
        'prompt.answer.codex': false,
        'prompt.answer.opencode': false,
        'prompt.answer.pi': false,
        'approvals.request.decide': true,
        'approvals.guard.approve': true,
        'approvals.guard.reject': true,
        'sessions.create': true,
        'agents.human_sender': false,
        'push': this.pushStand.erlaubnis !== 'nicht_moeglich',
      },
      theme: {
        accent: '#0070e0',
        thema: 'system',
        wirksam: 'dunkel',
        akzent: '#0070e0',
        akzentText: '#3398ff',
      },
      event_epoch: 'e7',
      vapid_public_key: null,
    });
  }

  async sitzungen(): Promise<ApiResponse<SessionsData>> {
    await this.irgendeine();
    const jetzt = Date.now();
    const sessions = this.welt.sitzungen.map((s) => ({
      ...s,
      data_age_ms: s.source === 'mirror' ? jetzt - (this.welt.maschinen.find((m) => m.machine === maschineVon(s.id))?.zuletzt ?? jetzt) : s.data_age_ms,
      open_approvals: this.welt.freigaben.filter((f) => f.session_id === s.id).length,
    }));
    return this.ok({ sessions });
  }

  async chat(id: string, cursor?: string): Promise<ApiResponse<ChatData>> {
    this.abfragen[`chat:${id}`] = (this.abfragen[`chat:${id}`] ?? 0) + 1;
    await this.irgendeine();
    const s = this.welt.sitzungen.find((x) => x.id === id);
    if (!s) return this.fehler('not_found', 'Sitzung nicht gefunden.');
    if (this.opt.ohneVerlauf.includes(id)) return this.fehler('capability_unavailable', 'chat source is unavailable', false, maschineVon(id));
    if (s.source === 'mirror') {
      return this.fehler('capability_unavailable', 'Der Mac spiegelt nur den Zustand. Den Verlauf liefert peer selbst, sobald es wieder antwortet.', true);
    }
    const alle = this.chatVon(id);
    const ab = cursor ? alle.findIndex((m) => m.id === cursor) + 1 : Math.max(0, alle.length - 200);
    const messages = alle.slice(ab, ab + 200);
    return this.ok({ messages, cursor: messages.length ? messages[messages.length - 1].id : cursor ?? null }, maschineVon(id));
  }

  async prompt(id: string): Promise<ApiResponse<PromptData>> {
    this.abfragen[`prompt:${id}`] = (this.abfragen[`prompt:${id}`] ?? 0) + 1;
    await this.irgendeine();
    if (this.opt.ohneVerlauf.includes(id)) {
      return this.fehler('capability_unavailable', 'no measured mobile dialog adapter is available', false, maschineVon(id));
    }
    return this.ok({ prompt: this.welt.prompts.get(id) ?? null }, maschineVon(id));
  }

  async freigaben(): Promise<ApiResponse<ApprovalsData>> {
    await this.irgendeine();
    return this.ok({ approvals: [...this.welt.freigaben] });
  }

  async startOptionen(): Promise<StartOptionen> {
    await this.irgendeine();
    return this.welt.start;
  }

  async agents(): Promise<ApiResponse<AgentsData>> {
    await this.irgendeine();
    return this.ok(this.welt.agents);
  }

  async meldungen(): Promise<ApiResponse<NotificationsData>> {
    await this.irgendeine();
    const notifications = [...this.welt.meldungen].sort((a, b) => b.created_at - a.created_at);
    return this.ok({ notifications, cursor: null });
  }

  async push(): Promise<PushStand> {
    return { ...this.pushStand };
  }

  async pushAnfragen(): Promise<PushStand> {
    if (this.pushStand.erlaubnis === 'offen') this.pushStand = { erlaubnis: 'erteilt', grund: null };
    return { ...this.pushStand };
  }

  // --- Schreiben ------------------------------------------------------------

  async senden(id: string, body: SendMessageBody): Promise<ApiResponse<SendMessageData>> {
    await this.warte();
    const f = this.schreibziel(id);
    if (f) return f;
    // Wie der Dialogriegel des Kerns (Vertrag 1.9): bei offener Rueckfrage nimmt
    // der Nachrichtenweg nichts an. Die Meldung ist die englische des Servers;
    // die App zeigt sie nie, sondern ihren eigenen Text (stand.ts).
    if (this.welt.prompts.has(id)) {
      return this.fehler('pane_busy', 'session pane does not accept input right now', false, maschineVon(id));
    }
    if (this.opt.verlaufSpaet) {
      // Der Harness schreibt die Nachricht einen Augenblick spaeter in seinen
      // Verlauf, und der Kern meldet das nicht eigens.
      const angenommen = Date.now();
      setTimeout(() => this.anhaengen(id, 'human', body.text, false), 800);
      return this.ok({ message_id: `${id}-angenommen-${angenommen}`, accepted_at: angenommen }, maschineVon(id));
    }
    const m = this.anhaengen(id, 'human', body.text);
    setTimeout(() => this.anhaengen(id, 'agent', 'Verstanden. Ich kümmere mich darum und melde mich hier.'), this.opt.live ? 1400 : 50);
    return this.ok({ message_id: m.id, accepted_at: m.created_at }, maschineVon(id));
  }

  async taste(id: string, _body: SendKeyBody): Promise<ApiResponse<SendKeyData>> {
    await this.warte();
    const f = this.schreibziel(id);
    if (f) return f;
    return this.ok({ accepted_at: Date.now() }, maschineVon(id));
  }

  async promptAntworten(id: string, _body: PromptAnswerBody): Promise<ApiResponse<PromptAnswerData>> {
    await this.warte();
    const p = this.welt.prompts.get(id);
    return this.fehler('capability_unavailable',
      `Für ${p?.harness ?? 'diesen Harness'} ist noch keine Dialogerkennung gemessen. Beantworte die Rückfrage am Rechner.`, false, maschineVon(id));
  }

  async entscheiden(art: Freigabeart, id: string, body: DecisionBody): Promise<ApiResponse<DecisionData>> {
    await this.warte();
    const f = this.welt.freigaben.find((x) => x.id === id && x.kind === art);
    if (!f) return this.fehler('stale_target', 'Diese Freigabe ist schon entschieden oder verschwunden.');
    this.welt.freigaben = this.welt.freigaben.filter((x) => x !== f);
    const ja = body.decision === 'approve';
    if (f.session_id) {
      const text = art === 'guard'
        ? (ja ? 'Befehl einmalig freigegeben.' : 'Befehl abgelehnt.')
        : (ja ? 'Worker-Antrag angenommen.' : 'Worker-Antrag abgelehnt.');
      this.anhaengen(f.session_id, 'system', body.reason ? `${text} Begründung: ${body.reason}` : text);
      if (!this.welt.freigaben.some((x) => x.session_id === f.session_id)) {
        this.welt.sitzungen = this.welt.sitzungen.map((s) => s.id === f.session_id ? { ...s, state: 'running' } : s);
      }
    }
    this.melden('approval.changed', 'mac', [id]);
    this.melden('session.changed', 'mac', f.session_id ? [f.session_id] : []);
    return this.ok({ decided_at: Date.now() });
  }

  async sitzungAnlegen(body: CreateSessionBody): Promise<ApiResponse<CreateSessionData>> {
    await this.warte();
    if (!this.erreichbar(body.machine)) {
      return this.fehler('stale_target', `${body.machine} ist nicht erreichbar. Eine Sitzung startet nur dort.`, true, body.machine);
    }
    if (!body.directory.startsWith('/')) return this.fehler('bad_request', 'Der Ordner muss ein absoluter Pfad sein.');
    const id = `${body.machine}:${body.name}` as const;
    if (this.welt.sitzungen.some((s) => s.id === id)) return this.fehler('bad_request', `Eine Sitzung „${body.name}“ läuft schon auf ${body.machine}.`);
    const session = {
      id, source: 'authoritative' as const, name: body.name, harness: body.harness, model: body.model,
      state: 'running' as const, updated_at: Date.now(), workers: [], worker_count: 0, running_worker_count: 0, open_approvals: 0, data_age_ms: 0,
    };
    this.welt.sitzungen = [session, ...this.welt.sitzungen];
    this.welt.chats.set(id, []);
    this.anhaengen(id, 'system', `Sitzung in ${body.directory} gestartet.`);
    return this.ok({ session }, body.machine);
  }

  async fortsetzen(id: string): Promise<ApiResponse<ResumeSessionData>> {
    await this.warte();
    const s = this.welt.sitzungen.find((x) => x.id === id);
    if (!s || !this.erreichbar(maschineVon(id))) return this.fehler('stale_target', 'Die Sitzung ist nicht erreichbar.', true);
    const neu = { ...s, state: 'running' as const, updated_at: Date.now() };
    this.welt.sitzungen = this.welt.sitzungen.map((x) => x.id === id ? neu : x);
    this.anhaengen(id, 'system', 'Sitzung fortgesetzt.');
    return this.ok({ session: neu }, maschineVon(id));
  }

  async schliessen(id: string): Promise<ApiResponse<CloseSessionData>> {
    await this.warte();
    const f = this.schreibziel(id);
    if (f) return f;
    const s = this.welt.sitzungen.find((x) => x.id === id);
    const laufend = s?.workers.filter((w) => w.state === 'running' || w.state === 'blocked' || w.state === 'stalled').length ?? 0;
    if (laufend > 0) {
      return this.fehler('close_rejected_workers_running', `Schließen abgelehnt: ${laufend} Worker laufen noch. Beende sie zuerst in der Sitzung.`);
    }
    this.welt.sitzungen = this.welt.sitzungen.map((x) => x.id === id ? { ...x, state: 'stopped', updated_at: Date.now() } : x);
    this.anhaengen(id, 'system', 'Sitzung geschlossen.');
    return this.ok({ accepted_at: Date.now() }, maschineVon(id));
  }

  /** Vertrag 1.8: wie der Kern -- nur direkt gemeldete Sitzungen, setzen nur laufend. */
  async bescheid(id: string, body: NotifyBody): Promise<ApiResponse<SessionNotifyData>> {
    await this.warte();
    const s = this.welt.sitzungen.find((x) => x.id === id);
    if (!s) return this.fehler('stale_target', 'Die Sitzung gibt es nicht mehr.');
    if (s.notify_until === undefined) return this.fehler('stale_target', 'Die Maschine dieser Sitzung antwortet nicht direkt.', true, maschineVon(id));
    if (body.active && s.state !== 'running' && s.state !== 'attention') return this.fehler('stale_target', 'Die Sitzung läuft nicht mehr.', false, maschineVon(id));
    const bis = body.active ? Date.now() + 12 * 60 * 60_000 : null;
    this.welt.sitzungen = this.welt.sitzungen.map((x) => x.id === id ? { ...x, notify_until: bis } : x);
    this.melden('session.changed', maschineVon(id), [id]);
    return this.ok({ session_id: id, notify_until: bis }, maschineVon(id));
  }

  async agentAktion(a: AgentAction): Promise<ApiResponse<AgentActionData>> {
    await this.warte();
    const welten = ((this.welt.agents.welten as JsonObject).welten as JsonObject[]).map((w) => ({ ...w })) as Record<string, JsonValue>[];
    const iso = new Date().toISOString();
    const inWelt = (id: string) => welten.find((w) => w.id === id);
    const mitTicket = (tid: string) => welten.find((w) => (w.tickets as JsonObject[]).some((t) => t.id === tid));
    const mitFrage = (fid: string) => welten.find((w) => (w.fragen as JsonObject[]).some((f) => f.id === fid));
    const ticketStand = (tid: string, stand: string, text: string) => {
      const w = mitTicket(tid);
      if (!w) return false;
      w.tickets = (w.tickets as JsonObject[]).map((t) => t.id === tid
        ? { ...t, stand, geaendert: iso, verlauf: [...(t.verlauf as JsonObject[]), { zeit: iso, ereignis: stand, von: 'cli-operator', text }] }
        : t);
      return true;
    };
    let gefunden = true;
    switch (a.type) {
      case 'message.send': {
        const w = inWelt(a.world_id);
        if (!w || w.fern === true) return this.fehler('stale_target', 'Die Welt ist nicht erreichbar.', true);
        if (!a.recipient) return this.fehler('bad_request', 'Eine Direktnachricht braucht einen Empfänger.');
        if (a.recipient.startsWith('team:')) {
          // Wie Server und Kern: ein Team bekommt die Nachricht im Kanal, adressiert an
          // Leitung und Mitglieder. Ein unbekanntes Team lehnt der Kern im Ergebnis ab,
          // nicht als Fehler der Schnittstelle (`adressenAufloesen`).
          const t = teamIn(w, a.recipient.slice(5));
          if (!t) return this.ok(kernAbgelehnt('senden', w, `Kein Team „${a.recipient.slice(5)}“ in ${String(w.name)}.`));
          w.kanal = [...(w.kanal as JsonObject[]), { id: `c${Date.now()}`, art: 'nachricht', von: 'cli-operator', an: teamEmpfaenger(t), text: a.text, zeit: iso, ticket: null, betreff: '', von_mensch: true, markierung: null, offen_fuer_mensch: false }];
          break;
        }
        w.kanal = [...(w.kanal as JsonObject[]), { id: `c${Date.now()}`, art: 'nachricht', von: 'cli-operator', an: [a.recipient], text: a.text, zeit: iso, ticket: null, betreff: '', von_mensch: false, markierung: null, offen_fuer_mensch: false }];
        break;
      }
      case 'question.answer':
      case 'question.withdraw': {
        const w = mitFrage(a.question_id);
        if (!w) { gefunden = false; break; }
        w.fragen = (w.fragen as JsonObject[]).map((f) => f.id === a.question_id
          ? { ...f, stand: a.type === 'question.answer' ? 'beantwortet' : 'zurueckgenommen', antwort: a.type === 'question.answer' ? { text: a.answer, von: 'cli-operator', zeit: iso } : null }
          : f);
        w.zaehler = { ...(w.zaehler as JsonObject), brauchen_dich: Math.max(0, Number((w.zaehler as JsonObject).brauchen_dich) - 1) };
        break;
      }
      case 'assignment.create': {
        const w = inWelt(a.world_id);
        if (!w || w.fern === true) return this.fehler('stale_target', 'Die Welt ist nicht erreichbar.', true);
        if (!a.goal || !a.done_when) return this.fehler('bad_request', 'Aufträge brauchen Ziel und Fertig-Kriterium.');
        // Der Kern: an ein Team geht das Ticket mit `team` und ohne Einzeladressaten,
        // adressiert steht es `offen`, nur ohne Adressat in der Triage.
        const team = a.recipient?.startsWith('team:') ? a.recipient.slice(5) : null;
        if (team !== null && !teamIn(w, team)) return this.ok(kernAbgelehnt('ticket', w, `Kein Team „${team}“ in ${String(w.name)}.`));
        const nr = (w.tickets as JsonObject[]).length + 45;
        w.tickets = [{ id: `T-${nr}`, titel: a.title, ziel: a.goal, stand: a.recipient ? 'offen' : 'triage', kind: 'auftrag', prioritaet: 2, prioritaet_text: 'normal', ampel: 'grau', bearbeiter: null, adressaten: team !== null ? [] : a.recipient ? [a.recipient] : [String(w.hauptagent ?? '')], team, geaendert: iso, fertig_punkte: [{ text: a.done_when, erledigt: false }], verlauf: [{ zeit: iso, ereignis: 'angelegt', von: 'cli-operator', text: '' }], ergebnis: null }, ...(w.tickets as JsonObject[])];
        break;
      }
      case 'ticket.accept': gefunden = ticketStand(a.ticket_id, 'läuft', `Angenommen von ${a.recipient ?? 'unbekannt'}.`); break;
      case 'ticket.return': gefunden = ticketStand(a.ticket_id, 'zurückgegeben', a.reason); break;
      case 'ticket.reject': gefunden = ticketStand(a.ticket_id, 'verworfen', a.reason); break;
      case 'ticket.redirect': gefunden = ticketStand(a.ticket_id, 'offen', `Umadressiert an ${a.recipient}: ${a.reason ?? ''}`); break;
      case 'ticket.scope': gefunden = ticketStand(a.ticket_id, 'offen', `Grenzen: ${a.deadline ?? ''}${a.deadline && a.rounds ? ', ' : ''}${a.rounds ? `${a.rounds} Runden` : ''}`); break;
      case 'ticket.review': gefunden = ticketStand(a.ticket_id, 'in Prüfung', `Prüfer: ${a.reviewer ?? ''}`); break;
      case 'ticket.approve':
        gefunden = ticketStand(a.ticket_id, 'abgenommen', `Abgenommen (${a.reason})${a.note ? `: ${a.note}` : ''}`);
        break;
    }
    if (!gefunden) return this.fehler('stale_target', 'Das Ziel gibt es nicht mehr.');
    this.welt.agents = { ...this.welt.agents, welten: { ...(this.welt.agents.welten as JsonObject), welten } } as unknown as AgentsData;
    this.melden('agents.changed', 'mac', []);
    return this.ok({ ok: true });
  }

  // --- Ereignisstrom ----------------------------------------------------------

  abonnieren(bei: (e: SseEvent) => void): () => void {
    this.hoerer.add(bei);
    if (this.opt.live && this.uhr === undefined) this.uhr = window.setInterval(() => this.lebenszeichen(), 9_000);
    return () => {
      this.hoerer.delete(bei);
      if (!this.hoerer.size && this.uhr !== undefined) { clearInterval(this.uhr); this.uhr = undefined; }
    };
  }

  /** Der laufende Orchestrator in demo arbeitet sichtbar weiter. */
  private lebenszeichen(): void {
    if (!navigator.onLine || !this.erreichbar('mac')) return;
    const schritte: [ChatMessage['role'], string][] = [
      ['tool', 'Shell(python -m backtest --variante brake-b --positionsgroesse 0.5)\nLade 612 Handelstage …'],
      ['tool', 'Shell(python -m gates --lauf brake-b-halb)\n6 von 6 Gates bestanden'],
      ['agent', 'Mit halbierter Positionsgröße bestehen alle sechs Gates. Rendite p. a. 6,1 %, Max. Drawdown −7,4 %. Soll ich die Variante in den Papierhandel geben?'],
    ];
    const s = schritte[this.liveSchritt++];
    if (!s) { if (this.uhr !== undefined) clearInterval(this.uhr); return; }
    this.anhaengen('mac:demo', s[0], s[1]);
  }

  // --- Nur fuer Tests: ein Ereignis von aussen ausloesen ----------------------

  testNachricht(sessionId: string, role: ChatMessage['role'], text: string): void {
    this.anhaengen(sessionId, role, text);
  }

  /** Ein Ereignis ohne Inhalt, wie der Kern es bei jeder Regung eines Panes meldet. */
  testEreignis(type: SseEventType, ids: string[]): void {
    this.melden(type, ids[0] ? maschineVon(ids[0]) : 'mac', ids);
  }
}

/** Ein Team der Welt wie im Stand des Kerns; fehlt `teams`, aus dem Feld `team` der Agenten. */
function teamIn(w: Record<string, JsonValue>, name: string): TeamKurz | undefined {
  const teams = Array.isArray(w.teams) ? w.teams as unknown as TeamKurz[] : teamsAusAgenten(w.agenten as unknown as AgentKurz[]);
  return teams.find((t) => t.name === name);
}

/**
 * Eine fachliche Ablehnung des Kerns: der Server reicht sie als Ergebnis mit
 * `ok: false` durch (`adapters/agents.ts`), nicht als Fehler der Schnittstelle.
 */
function kernAbgelehnt(handlung: string, w: Record<string, JsonValue>, meldung: string): AgentActionData {
  return { result: { ok: false, handlung: `welt:${handlung}`, id: String(w.id), meldung } };
}

function geraetename(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad Air';
  if (/iPhone/.test(ua)) return 'iPhone XS';
  return 'Browser';
}

export { Netzfehler };
