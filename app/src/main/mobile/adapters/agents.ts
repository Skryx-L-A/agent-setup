import { validateAgentAction } from '../../../mobile-shared/validierung';
import type { AgentAction, JsonObject } from '../../../mobile-shared/vertrag';
import { MobileAuthError } from '../auth/auth';
import type { MobileRouteHandlers, MobileRouteRequest } from '../http/server';
import type { AufgabenNutzlast } from '../../aufgaben';
import type { WeltenHandlungsErgebnis } from '../../welten';
import { mobilBeleg, type Herkunft, type Herkunftsbeleg } from '../../herkunft';

/**
 * Der HTTP-Transport setzt `device` erst nach erfolgreicher Pruefung der
 * `awb-mobile-request-v1`-Signatur und registriert es als Beleg (herkunft.ts).
 * Paket 10: WeltenQuelle nimmt den typisierten Mobilbeleg an; ob er als
 * menschlicher Absender zaehlt, entscheidet `menschlicherAbsender()` dort --
 * dieser Adapter behauptet nichts selbst.
 */
export interface AgentsActionOptions {
  readonly bestaetigt: true;
}

/** Die schmale, testbare Schnittstelle zur vorhandenen AufgabenQuelle. */
export interface AufgabenQuelleForMobile {
  aktuell(): AufgabenNutzlast;
  frisch?(): Promise<AufgabenNutzlast>;
  ausfuehren(befehl: string, herkunft: Herkunft | Herkunftsbeleg, opt?: unknown): Promise<WeltenHandlungsErgebnis>;
}

interface ResolvedAction {
  readonly befehl: string;
}

function unavailable(message: string): never {
  throw new MobileAuthError('capability_unavailable', message);
}

function badRequest(message: string): never {
  throw new MobileAuthError('bad_request', message);
}

function originFor(request: MobileRouteRequest): Herkunftsbeleg {
  if (!request.device) unavailable('a verified mobile device is required for agents actions');
  return mobilBeleg(request.device);
}

function worldById(snapshot: AufgabenNutzlast, id: unknown): string {
  if (typeof id !== 'string' || !id) badRequest('world_id must be a non-empty string');
  const matches = snapshot.welten.welten.filter((world) => world.id === id);
  if (matches.length !== 1) throw new MobileAuthError('stale_target', 'world is no longer current');
  return matches[0].pfad;
}

function worldForQuestion(snapshot: AufgabenNutzlast, questionId: unknown): string {
  if (typeof questionId !== 'string' || !questionId) badRequest('question_id must be a non-empty string');
  const matches = snapshot.welten.welten.filter((world) => world.fragen.some((question) => question.id === questionId));
  if (matches.length !== 1) throw new MobileAuthError('stale_target', 'question is no longer current');
  return matches[0].pfad;
}

function worldForTicket(snapshot: AufgabenNutzlast, ticketId: unknown): string {
  if (typeof ticketId !== 'string' || !ticketId) badRequest('ticket_id must be a non-empty string');
  const matches = snapshot.welten.welten.filter((world) => world.tickets.some((ticket) => ticket.id === ticketId));
  if (matches.length !== 1) throw new MobileAuthError('stale_target', 'ticket is no longer current');
  return matches[0].pfad;
}

function worldCommand(handlung: string, daten: JsonObject): ResolvedAction {
  return { befehl: `welt:${handlung} ${JSON.stringify(daten)}` };
}

function requiredText(value: string | undefined, name: string): string {
  if (!value) badRequest(`${name} must be a non-empty string`);
  return value;
}

/**
 * Uebersetzt ausschliesslich die geschlossene Vertragsmenge in den vorhandenen
 * `welt:`-Befehl. Die WeltenQuelle prueft anschliessend Ticketstatus,
 * Empfaenger, Fristen und alle weiteren Fachregeln selbst.
 */
function resolveAction(snapshot: AufgabenNutzlast, action: AgentAction): ResolvedAction {
  switch (action.type) {
    /**
     * An einen Agenten geht die Nachricht als Einzelchat (`direkt`). An ein
     * Team (`team:<name>`) geht sie in den Kanal der Welt wie im Adressfeld der
     * Werkbank.app: als Direktchat legte der Kern einen Gruppenchat aller
     * Mitglieder an, den weder Kanal noch Einzelchat zeigen. Ob es das Team
     * gibt, prueft der Kern (`adressenAufloesen`).
     */
    case 'message.send': {
      const recipient = requiredText(action.recipient, 'recipient');
      return worldCommand('senden', {
        welt: worldById(snapshot, action.world_id), an: [recipient], ...(recipient.startsWith('team:') ? {} : { direkt: true }), text: action.text,
      });
    }
    case 'question.answer':
      return worldCommand('antworten', { welt: worldForQuestion(snapshot, action.question_id), frage: action.question_id, text: action.answer });
    case 'question.withdraw':
      return worldCommand('zuruecknehmen', {
        welt: worldForQuestion(snapshot, action.question_id), frage: action.question_id, ...(action.reason ? { grund: action.reason } : {}),
      });
    case 'assignment.create':
      return worldCommand('ticket', {
        welt: worldById(snapshot, action.world_id), titel: action.title,
        ziel: requiredText(action.goal, 'goal'), fertig: requiredText(action.done_when, 'done_when'),
        ...(action.recipient ? { an: [action.recipient] } : {}),
      });
    case 'ticket.accept':
      return worldCommand('ticket_annehmen', {
        welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id, an: [requiredText(action.recipient, 'recipient')],
      });
    case 'ticket.redirect':
      return worldCommand('ticket_umadressieren', {
        welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id, an: [action.recipient], grund: requiredText(action.reason, 'reason'),
      });
    case 'ticket.scope':
      return worldCommand('ticket_grenzen', {
        welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id,
        ...(action.deadline ? { frist: action.deadline } : {}), ...(action.rounds !== undefined ? { runden: action.rounds } : {}),
      });
    case 'ticket.review':
      return worldCommand('ticket_pruefen', {
        welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id, pruefer: requiredText(action.reviewer, 'reviewer'),
      });
    /**
     * v1.6: Verwerfen mit Bemerkung und, beim Grund `duplikat`, dem Ticket, von
     * dem es ein Duplikat ist. Dass dieses Ticket in derselben Welt liegt und
     * dass der Grund zur festen Liste gehoert, prueft der Kern; hier wird
     * nichts davon nachgebaut.
     */
    case 'ticket.reject':
      return worldCommand('ticket_verwerfen', {
        welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id, grund: action.reason,
        ...(action.duplicate_of ? { duplikat_von: action.duplicate_of } : {}),
        ...(action.note ? { bemerkung: action.note } : {}),
      });
    case 'ticket.return':
      return worldCommand('zurueckgeben', { welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id, bemerkung: action.reason });
    /**
     * v1.4: die Abnahme. Die Felder sind die des Kerns (`wb-ticket abnehmen`
     * ueber `welt:ticket_abnehmen`): Grund, Bemerkung und die Bestaetigung der
     * Definition of Done. Stand, Abnahmerecht und die Bemerkungspflicht bei
     * `teilweise` prueft der Kern selbst; hier wird nichts davon nachgebaut.
     */
    case 'ticket.approve':
      return worldCommand('ticket_abnehmen', {
        welt: worldForTicket(snapshot, action.ticket_id), ticket: action.ticket_id, grund: action.reason,
        ...(action.note ? { bemerkung: action.note } : {}),
        ...(action.dod_confirmed ? { dod_geprueft: true } : {}),
      });
  }
}

async function fresh(source: AufgabenQuelleForMobile): Promise<AufgabenNutzlast> {
  if (!source.frisch) unavailable('the agents source cannot provide a fresh snapshot');
  return source.frisch();
}

function asJson(value: unknown): JsonObject {
  return value as JsonObject;
}

/**
 * Paket 10 haengt dieses Objekt an den vorhandenen Mobile-HTTP-Server. Es
 * erzeugt weder einen zweiten Server noch eine zweite Signaturpruefung.
 */
export function createAgentsHandlers(source: AufgabenQuelleForMobile): Pick<MobileRouteHandlers, 'GET /agents' | 'POST /agents/actions'> {
  return {
    'GET /agents': () => ({ data: asJson(source.aktuell()) }),
    'POST /agents/actions': async (request) => {
      const checked = validateAgentAction(request.body);
      if (!checked.ok) badRequest(checked.error);
      const proof = originFor(request);
      const command = resolveAction(await fresh(source), checked.value);
      const result = await source.ausfuehren(command.befehl, proof, { bestaetigt: true } satisfies AgentsActionOptions);
      return { data: asJson({ result: result as unknown as JsonObject }) };
    },
  };
}
