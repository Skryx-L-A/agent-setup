/**
 * AGENTS: Welten, Agenten mit ihren Figuren, offene Fragen, der Kanal einer
 * Welt, Auftraege und Tickets (Spezifikation 7.1). Jede Handlung ist eine
 * getypte `AgentAction` mit den Fachfeldern von Vertrag 1.1; freie
 * Shellzeilen gibt es nicht. Eine Nachricht geht an genau einen Empfaenger:
 * im Agentendetail an den Agenten, im Kanal an den gewaehlten Agenten oder
 * ein ganzes Team (`team:<name>`, Leitung und Mitglieder wie in der Werkbank.app).
 *
 * Die Figuren sind dieselben wie in der Werkbank (`renderer/agentenfigur.ts`):
 * gleiche Rolle und gleicher Name ergeben dieselbe Figur mit Gesicht und
 * Ausdruck; der Zustand steuert Augen, Bewegung und Zeichen.
 */
import { figur, figurZustandVon } from '../../renderer/agentenfigur';
import type { AgentKurz, AgentNachricht, FrageKurz, TeamKurz, WeltKurz } from './agents-daten';
import { offeneFragen, teamEmpfaenger } from './agents-daten';
import { abfrage, auswahlBlatt, formblatt } from './blatt';
import { Composer } from './composer';
import { ersetzen, h, symbol } from './dom';
import { gruppe, textFeld, wahlListe, type Wahl } from './formular';
import type { Stand } from './stand';
import { verbindungsZeile } from './sitzungen';
import {
  abschnitt, hinweis, leerzustand, maschinenName, marke, navKnopf, punkt, seite, ticketFarbe,
  type Ansicht, type Umgebung,
} from './teile';
import { relativ, uhr } from './zeit';

const FIGUREN = new Map<string, HTMLCanvasElement>();

/**
 * Eine Figur je Agent, Groesse und Platz wiederverwenden, sonst faengt sie bei
 * jedem Zeichnen neu zu blinzeln an. Der Platz trennt Figuren, die zugleich
 * sichtbar sind (jede Kanalnachricht, die Auswahlliste eines Blatts).
 */
export function agentFigur(a: AgentKurz, groesse: number, platz = ''): HTMLCanvasElement {
  const schluessel = `${a.id}:${groesse}:${platz}`;
  const zustand = figurZustandVon(a.figur_zustand);
  const art = a.figur.art === 'roboter' || a.figur.art === 'tier' ? a.figur.art : undefined;
  const c = figur({
    rolle: a.figur.rolle, stufe: a.stufe === 'teamleiter' ? 'teamleiter' : 'mitglied', name: a.name,
    team: a.team ?? undefined, art, groesse, zustand, titel: `${a.name}, ${a.zustand_text || 'ruhig'}`,
  }, FIGUREN.get(schluessel));
  FIGUREN.set(schluessel, c);
  return c;
}

function agentFarbe(a: AgentKurz): string {
  if (a.zustand === 'braucht_dich') return 'will';
  if (a.zustand === 'arbeitet') return 'laeuft';
  if (a.zustand === 'hat_ergebnis') return 'akzent';
  if (a.zustand === 'gestoppt' || a.zustand === 'archiviert') return 'fern';
  return 'neutral';
}

function weltFinden(stand: Stand, id: string): WeltKurz | undefined {
  return stand.agents?.welten.find((w) => w.id === id);
}

function absenderHinweis(stand: Stand): HTMLElement | null {
  if (stand.agents?.mensch_absender || stand.faehig('agents.human_sender')) return null;
  return h('p', { class: 'absender-notiz' }, 'Die App handelt hier als cli-operator, bis der Kern den Mobilbeleg als Mensch anerkennt.');
}

/** Die Agenten einer Welt als Auswahl, mit Figur und Aufgabe. */
export function agentWahlen(w: WeltKurz, anders?: (a: AgentKurz) => Partial<Wahl> | null): Wahl[] {
  return w.agenten.map((a) => ({
    wert: a.id,
    text: a.name,
    zusatz: a.stufe === 'hauptagent' ? 'Hauptagent' : a.spezialgebiet || a.zustand_text,
    bild: agentFigur(a, 30, 'wahl'),
    ...(anders?.(a) ?? {}),
  }));
}

/** „Team Entwicklung“: der Teamname mit grossem Anfang, wie `WeltenWorte.team` der Werkbank.app. */
export function teamName(name: string): string {
  return `Team ${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

/** Die Teams einer Welt als eigene Gruppe der Auswahl; der Wert ist die Kernadresse `team:<name>`. */
export function teamWahlen(w: WeltKurz): Wahl[] {
  return w.teams.map((t) => {
    const zahl = teamEmpfaenger(t).length;
    const leitung = t.leiter ? `, Leitung ${agentName(w, t.leiter)}` : '';
    return {
      wert: `team:${t.name}`,
      text: teamName(t.name),
      zusatz: `${zahl} ${zahl === 1 ? 'Mitglied' : 'Mitglieder'}${leitung}`,
      bild: h('span', { class: 'wahl-symbol' }, symbol('agents', 18)),
      gruppe: 'Teams',
    };
  });
}

/** Agenten und, falls die Welt welche hat, Teams als zwei benannte Gruppen. */
function empfaengerWahlen(w: WeltKurz): Wahl[] {
  if (!w.teams.length) return agentWahlen(w);
  return [...agentWahlen(w).map((o) => ({ ...o, gruppe: 'Agenten' })), ...teamWahlen(w)];
}

export function agentName(w: WeltKurz, id: string | null): string {
  if (!id) return 'niemand';
  if (id.startsWith('team:')) return teamName(id.slice(5));
  return w.agenten.find((a) => a.id === id)?.name ?? id;
}

/** Ein Auftrag an die Welt: Titel, Ziel, Fertig-Kriterium und wahlweise ein Empfaenger. */
export async function auftragGeben(u: Umgebung, weltId: string): Promise<boolean> {
  const w = weltFinden(u.stand, weltId);
  if (!w) return false;
  const titel = textFeld({ beschriftung: 'Titel', platzhalter: 'Kurz, was zu tun ist' });
  const ziel = textFeld({ beschriftung: 'Ziel', platzhalter: 'Was soll am Ende erreicht sein?', mehrzeilig: true });
  const fertig = textFeld({ beschriftung: 'Fertig, wenn', platzhalter: 'Woran erkennt man, dass es fertig ist?', mehrzeilig: true });
  const haupt = w.hauptagent ? agentName(w, w.hauptagent) : null;
  const optionen: Wahl[] = [
    ...(haupt ? [{ wert: '', text: 'Triage', zusatz: `${haupt} entscheidet, wer ihn bekommt`, bild: h('span', { class: 'wahl-symbol' }, symbol('tickets', 18)) }] : []),
    ...empfaengerWahlen(w),
  ];
  const an = wahlListe('Empfänger', optionen, haupt ? '' : null);
  return formblatt({
    titel: 'Neuer Auftrag',
    ja: 'Anlegen',
    gross: true,
    inhalt: [
      gruppe('Titel', titel.el, null, titel.feld.id),
      gruppe('Ziel', ziel.el, null, ziel.feld.id),
      gruppe('Fertig, wenn', fertig.el, null, fertig.feld.id),
      gruppe('Empfänger', an.el, haupt
        ? `Ohne Empfänger landet der Auftrag in der Triage von ${w.name}.`
        : `${w.name} hat keinen Hauptagenten; der Auftrag braucht einen Empfänger.`),
      absenderHinweis(u.stand),
    ],
    gueltig: () => !!titel.wert() && !!ziel.wert() && !!fertig.wert() && an.wert() !== null && u.stand.darfSchreiben(),
    ausfuehren: async () => {
      const empfaenger = an.wert();
      const r = await u.stand.agentAktion({
        type: 'assignment.create', world_id: weltId, title: titel.wert(), goal: ziel.wert(), done_when: fertig.wert(),
        ...(empfaenger ? { recipient: empfaenger } : {}),
      });
      return r.ok ? null : r.fehler.message;
    },
  });
}

export function frageKarte(u: Umgebung, w: WeltKurz, f: FrageKurz, kompakt: boolean): HTMLElement {
  const stand = u.stand;
  const fragesteller = w.agenten.find((a) => a.id === f.von);
  const gesperrt = !stand.darfSchreiben() || w.fern;
  const fehler = h('p', { class: 'entscheidung-fehler', role: 'alert', hidden: true });
  const antworten = async (antwort: string): Promise<void> => {
    const r = await stand.agentAktion({ type: 'question.answer', question_id: f.id, answer: antwort });
    if (!r.ok) { fehler.hidden = false; fehler.textContent = r.fehler.message; }
  };
  const karte = h('section', { class: 'entscheidung karte frage', 'aria-label': `Frage von ${fragesteller?.name ?? f.von}` },
    h('div', { class: 'frage-kopf' },
      fragesteller ? agentFigur(fragesteller, 40) : punkt('will'),
      h('div', { class: 'frage-wer' },
        h('span', { class: 'frage-name' }, fragesteller?.name ?? f.von),
        h('span', { class: 'frage-meta' }, `${w.name}${f.ticket ? `, ${f.ticket}` : ''}, ${relativ(f.gestellt)}`),
      ),
    ),
    h('p', { class: 'frage-text' }, f.text),
    h('div', { class: 'optionen' }, ...f.optionen.map((o) => h('button', {
      class: `option ${o === f.empfehlung ? 'empfohlen' : ''}`, type: 'button', disabled: gesperrt,
      onclick: () => { void antworten(o); },
    }, h('span', null, o), o === f.empfehlung ? h('span', { class: 'empfehlung' }, 'Empfehlung') : null))),
    kompakt ? null : h('button', {
      class: 'knopf getoent', type: 'button', disabled: gesperrt,
      onclick: async () => {
        const text = await abfrage({ titel: 'Eigene Antwort', feld: { platzhalter: 'Antwort', pflicht: true }, ja: 'Antworten' });
        if (text) await antworten(text);
      },
    }, 'Eigene Antwort'),
    fehler,
  );
  if (kompakt) {
    karte.classList.add('kompakt');
    karte.append(h('button', { class: 'text-knopf', type: 'button', onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'frage', welt: w.id, frage: f.id }) }, 'Frage öffnen'));
  }
  return karte;
}

function agentZeile(u: Umgebung, w: WeltKurz, a: AgentKurz): HTMLElement {
  return h('button', { class: 'agent-zeile', type: 'button', onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'agent', welt: w.id, agent: a.id }) },
    agentFigur(a, 44),
    h('span', { class: 'agent-text' },
      h('span', { class: 'agent-name' }, a.name, a.stufe === 'hauptagent' ? h('span', { class: 'agent-rolle' }, 'Hauptagent') : null),
      h('span', { class: `agent-zustand text-${agentFarbe(a)}` }, a.zustand_text || 'Ruhig'),
    ),
    a.postfach_offen ? marke(String(a.postfach_offen), 'akzent') : null,
    symbol('weiter', 16),
  );
}

export function agentsListe(u: Umgebung): Ansicht {
  const s = seite(u, { titel: 'Agents', gross: true, klasse: 'liste-ansicht' });
  const koerper = h('div', { class: 'listen-koerper' });
  s.inhalt.append(koerper);
  const aktualisieren = (): void => {
    const stand = u.stand;
    const teile: (HTMLElement | null)[] = [verbindungsZeile(stand)];
    const ag = stand.agents;
    if (!ag) {
      teile.push(stand.verbunden
        ? h('div', { class: 'platzhalter-karten', 'aria-busy': 'true' }, h('div', { class: 'karte skelett gross' }), h('div', { class: 'karte skelett gross' }))
        : leerzustand('Noch nichts geladen', 'Die Welten erscheinen, sobald Mac oder peer antwortet.'));
      ersetzen(koerper, ...teile);
      return;
    }
    const fragen = ag.welten.flatMap((w) => offeneFragen(w).map((f) => ({ w, f })));
    if (fragen.length) {
      teile.push(h('div', { class: 'gruppe' }, abschnitt('Brauchen Dich', String(fragen.length)),
        h('div', { class: 'karten' }, ...fragen.map(({ w, f }) => frageKarte(u, w, f, true)))));
    }
    for (const w of ag.welten) {
      const offen = w.tickets.filter((t) => !['abgenommen', 'verworfen'].includes(t.stand)).length;
      teile.push(h('div', { class: 'gruppe', 'data-welt': w.id },
        abschnitt(w.name, w.fern && !w.verbindung.ok
          ? h('span', { class: 'maschine-status aus' }, `${maschinenName(w.maschine)} nicht erreichbar${w.verbindung.seit ? ` seit ${uhr(w.verbindung.seit)}` : ''}`)
          : maschinenName(w.maschine)),
        h('div', { class: `karte welt-karte ${w.fern && !w.verbindung.ok ? 'veraltet' : ''}` },
          ...w.agenten.map((a) => agentZeile(u, w, a)),
          h('div', { class: 'welt-fuss' },
            h('button', { class: 'fuss-knopf', type: 'button', onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'welt', welt: w.id }) },
              symbol('kanal', 20), h('span', null, 'Kanal'), w.kanal.length ? h('span', { class: 'fuss-zahl' }, String(w.kanal.length)) : null),
            h('button', { class: 'fuss-knopf', type: 'button', onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'tickets', welt: w.id }) },
              symbol('tickets', 20), h('span', null, 'Tickets'), h('span', { class: 'fuss-zahl' }, `${offen} offen`)),
          ),
        ),
      ));
    }
    ersetzen(koerper, ...teile);
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

function kanalNachricht(w: WeltKurz, n: AgentNachricht): HTMLElement {
  const a = w.agenten.find((x) => x.id === n.von);
  if (n.von_mensch) return h('div', { class: 'msg mensch' }, h('div', { class: 'blase' }, n.text));
  return h('div', { class: 'msg kanal' },
    a ? agentFigur(a, 32, n.id) : h('span', { class: 'kanal-platz' }),
    h('div', { class: 'kanal-blase' },
      h('div', { class: 'kanal-kopf' }, h('span', { class: 'kanal-von' }, a?.name ?? n.von), h('span', { class: 'kanal-zeit' }, uhr(n.zeit))),
      h('div', { class: 'kanal-text' }, n.text),
    ),
  );
}

/** Wer eine Kanalnachricht bekommt: ein Agent oder ein ganzes Team. */
interface Empfaenger {
  wert: string;
  name: string;
  agent: AgentKurz | null;
  team: TeamKurz | null;
}

/** Die Zeile ueber dem Composer, die den Empfaenger zeigt und waehlen laesst. */
function empfaengerZeile(bei: () => void): { el: HTMLElement; setzen(e: Empfaenger | null, aus: boolean): void } {
  const inhalt = h('span', { class: 'empfaenger-name' });
  const knopf = h('button', { class: 'empfaenger-knopf', type: 'button', onclick: bei });
  const el = h('div', { class: 'empfaenger-zeile' }, h('span', { class: 'empfaenger-an', 'aria-hidden': 'true' }, 'An'), knopf);
  return {
    el,
    setzen(e, aus) {
      const bild = e?.agent ? agentFigur(e.agent, 22, 'empfaenger') : e?.team ? symbol('agents', 18) : null;
      ersetzen(knopf, bild, inhalt, symbol('runter', 14));
      inhalt.textContent = e?.name ?? 'Empfänger wählen';
      knopf.setAttribute('aria-label', `Empfänger: ${e?.name ?? 'keiner'}. Ändern`);
      knopf.disabled = aus;
    },
  };
}

/** Der Kanal einer Welt: Verlauf, Auftrag anlegen, Nachricht an einen gewaehlten Agenten. */
export function weltAnsicht(u: Umgebung, weltId: string): Ansicht {
  const stand = u.stand;
  const auftrag = navKnopf('plus', 'Neuer Auftrag', () => {
    void auftragGeben(u, weltId).then((ok) => { if (ok) u.router.oeffnen({ tab: 'agents', ansicht: 'tickets', welt: weltId }); });
  });
  const s = seite(u, { titel: weltFinden(stand, weltId)?.name ?? weltId, zurueck: 'Agents', aktionen: [auftrag], klasse: 'chat-ansicht kanal-ansicht' });
  s.el.dataset.composer = 'ja';
  const unterzeile = h('div', { class: 'nav-unterzeile' });
  s.nav.querySelector('.nav-mitte')?.append(unterzeile);
  const verlauf = h('div', { class: 'verlauf', role: 'log', 'aria-live': 'polite' });
  s.inhalt.classList.add('chat-inhalt');
  s.inhalt.append(verlauf);
  // Ohne eigene Wahl geht die Nachricht an den Hauptagenten der Welt.
  let empfaenger: string | null = null;
  const aktuellerEmpfaenger = (w: WeltKurz | undefined): Empfaenger | null => {
    const team = empfaenger?.startsWith('team:') ? w?.teams.find((t) => `team:${t.name}` === empfaenger) : undefined;
    if (team) return { wert: `team:${team.name}`, name: teamName(team.name), agent: null, team };
    const a = w?.agenten.find((x) => x.id === empfaenger) ?? w?.agenten.find((x) => x.id === w.hauptagent) ?? w?.agenten[0];
    return a ? { wert: a.id, name: a.name, agent: a, team: null } : null;
  };
  const composer = new Composer({
    platzhalter: 'Nachricht',
    entwurf: `welt:${weltId}`,
    senden: async (text) => {
      const an = aktuellerEmpfaenger(weltFinden(stand, weltId));
      if (!an) return { ok: false, fehler: { code: 'bad_request', message: 'Wähle zuerst einen Empfänger.', retryable: false } };
      return stand.agentAktion({ type: 'message.send', world_id: weltId, recipient: an.wert, text });
    },
  });
  const zeile = empfaengerZeile(() => {
    const w = weltFinden(stand, weltId);
    if (!w) return;
    void auswahlBlatt('Empfänger', empfaengerWahlen(w), aktuellerEmpfaenger(w)?.wert ?? null, w.teams.length
      ? 'An einen Agenten geht die Nachricht direkt. An ein Team geht sie in den Kanal, an Leitung und alle Mitglieder.'
      : 'Die Nachricht geht direkt an diesen Agenten.').then((wahl) => {
      if (wahl === null) return;
      empfaenger = wahl;
      aktualisieren();
      composer.fokus();
    });
  });
  const notiz = h('div', { class: 'chat-hinweis' });
  s.el.append(h('div', { class: 'chat-dock' }, notiz, zeile.el, composer.el));
  let anzahl = -1;

  const aktualisieren = (): void => {
    const w = weltFinden(stand, weltId);
    if (!w) { ersetzen(verlauf, leerzustand('Welt nicht gefunden', 'Diese Welt ist nicht mehr im Stand.')); return; }
    s.titelSetzen(w.name);
    ersetzen(unterzeile, h('span', null, `Kanal, ${maschinenName(w.maschine)}`));
    if (w.kanal.length !== anzahl) {
      anzahl = w.kanal.length;
      ersetzen(verlauf, ...(w.kanal.length ? w.kanal.map((n) => kanalNachricht(w, n)) : [leerzustand('Noch still', 'Im Kanal dieser Welt wurde noch nichts geschrieben.')]));
      requestAnimationFrame(() => s.inhalt.scrollTo({ top: s.inhalt.scrollHeight }));
    }
    const gesperrt = w.fern && !w.verbindung.ok
      ? `${maschinenName(w.maschine)} ist nicht erreichbar`
      : !stand.darfSchreiben() ? 'Keine Verbindung' : null;
    const an = aktuellerEmpfaenger(w);
    composer.sperren(gesperrt);
    composer.platzhalterSetzen(an ? `Nachricht an ${an.name}` : 'Nachricht');
    zeile.setzen(an, gesperrt !== null);
    auftrag.disabled = gesperrt !== null;
    ersetzen(notiz, absenderHinweis(stand));
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

/** Ein Agent: Figur, Eigenschaften, seine Tickets und der Direktchat mit ihm. */
export function agentAnsicht(u: Umgebung, weltId: string, agentId: string): Ansicht {
  const stand = u.stand;
  const s = seite(u, { titel: agentId, zurueck: weltFinden(stand, weltId)?.name ?? 'Welt', klasse: 'detail-ansicht agent-ansicht' });
  s.el.dataset.composer = 'ja';
  const koerper = h('div', { class: 'detail-koerper' });
  s.inhalt.append(koerper);
  const status = h('span', { 'aria-live': 'polite' });
  const notiz = h('div', { class: 'chat-hinweis' });
  let statusUhr: number | undefined;
  const composer = new Composer({
    platzhalter: 'Nachricht',
    entwurf: `agent:${weltId}:${agentId}`,
    senden: async (text) => {
      const r = await stand.agentAktion({ type: 'message.send', world_id: weltId, recipient: agentId, text });
      if (r.ok) {
        const name = weltFinden(stand, weltId)?.agenten.find((a) => a.id === agentId)?.name ?? agentId;
        status.textContent = `An ${name} gesendet.`;
        window.clearTimeout(statusUhr);
        statusUhr = window.setTimeout(() => { status.textContent = ''; aktualisieren(); }, 4_000);
        aktualisieren();
        requestAnimationFrame(() => s.inhalt.scrollTo({ top: s.inhalt.scrollHeight }));
      }
      return r;
    },
  });
  s.el.append(h('div', { class: 'chat-dock' }, notiz, composer.el));

  const aktualisieren = (): void => {
    const w = weltFinden(stand, weltId);
    const a = w?.agenten.find((x) => x.id === agentId);
    if (!w || !a) {
      ersetzen(koerper, leerzustand('Agent nicht gefunden', 'Dieser Agent ist nicht mehr im Stand der Welt.'));
      composer.sperren('Diesen Agenten gibt es nicht mehr');
      return;
    }
    s.titelSetzen(a.name);
    const tickets = w.tickets.filter((t) => t.bearbeiter === a.id);
    ersetzen(koerper,
      h('div', { class: 'agent-buehne' },
        agentFigur(a, 112),
        h('h1', { class: 'agent-titel' }, a.name),
        h('p', { class: 'agent-untertitel' }, a.stufe === 'hauptagent' ? `Hauptagent von ${w.name}` : `${a.spezialgebiet}${a.team ? `, Team ${a.team}` : ''}`),
        marke(a.zustand_text || 'Ruhig', agentFarbe(a) as 'will' | 'laeuft' | 'akzent' | 'fern' | 'neutral'),
      ),
      h('dl', { class: 'karte eigenschaften' },
        h('div', null, h('dt', null, 'Modell'), h('dd', { class: 'mono' }, a.modell)),
        h('div', null, h('dt', null, 'Maschine'), h('dd', null, maschinenName(a.maschine))),
        a.ticket ? h('div', null, h('dt', null, 'Arbeitet an'), h('dd', null, h('button', { class: 'text-knopf', type: 'button', onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'ticket', welt: w.id, ticket: a.ticket ?? '' }) }, a.ticket))) : null,
        h('div', null, h('dt', null, 'Postfach'), h('dd', null, a.postfach_offen ? `${a.postfach_offen} ungelesen` : 'leer')),
      ),
      tickets.length ? abschnitt('Tickets') : null,
      tickets.length ? h('div', { class: 'karten' }, ...tickets.map((t) => h('button', { class: 'karte ticket-zeile', type: 'button', onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'ticket', welt: w.id, ticket: t.id }) },
        h('span', { class: 'ticket-id' }, t.id), h('span', { class: 'ticket-titel' }, t.titel), marke(t.stand, ticketFarbe(t.stand) as 'will')))) : null,
      abschnitt('Gespräch'),
      a.einzelchat.length
        ? h('div', { class: 'karte gespraech' }, ...a.einzelchat.map((n) => h('div', { class: `gespraech-zeile ${n.von_mensch ? 'von-mensch' : ''}` },
          h('span', { class: 'gespraech-von' }, n.von_mensch ? 'Du' : a.name),
          h('p', { class: 'gespraech-text' }, n.text),
          h('span', { class: 'gespraech-zeit' }, relativ(n.zeit)))))
        : h('p', { class: 'formular-notiz' }, `Noch kein Gespräch. Was Du unten schreibst, geht direkt an ${a.name}.`),
    );
    const gesperrt = w.fern && !w.verbindung.ok
      ? `${maschinenName(w.maschine)} ist nicht erreichbar`
      : !stand.darfSchreiben() ? 'Keine Verbindung' : null;
    composer.sperren(gesperrt);
    composer.platzhalterSetzen(`Nachricht an ${a.name}`);
    ersetzen(notiz, status.textContent ? status : null, status.textContent ? null : absenderHinweis(stand));
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

export function frageAnsicht(u: Umgebung, weltId: string, frageId: string): Ansicht {
  const stand = u.stand;
  const s = seite(u, { titel: 'Frage', zurueck: weltId === '-' ? 'Agents' : weltFinden(stand, weltId)?.name ?? 'Welt', klasse: 'detail-ansicht' });
  const koerper = h('div', { class: 'detail-koerper' });
  s.inhalt.append(koerper);
  const fehler = h('p', { class: 'entscheidung-fehler', role: 'alert', hidden: true });
  const zuruecknehmen = async (w: WeltKurz, f: FrageKurz): Promise<void> => {
    const grund = await abfrage({
      titel: 'Frage zurücknehmen?',
      text: `Die Frage von ${agentName(w, f.von)} steht danach nicht mehr offen und bekommt keine Antwort.`,
      feld: { platzhalter: 'Grund (optional)' },
      ja: 'Zurücknehmen', jaArt: 'zerstoerend',
    });
    if (grund === null) return;
    const r = await stand.agentAktion({ type: 'question.withdraw', question_id: f.id, ...(grund ? { reason: grund } : {}) });
    fehler.hidden = r.ok;
    if (!r.ok) fehler.textContent = r.fehler.message;
  };
  const aktualisieren = (): void => {
    const w = weltId === '-' ? stand.agents?.welten.find((x) => x.fragen.some((f) => f.id === frageId)) : weltFinden(stand, weltId);
    const f = w?.fragen.find((x) => x.id === frageId);
    if (!w || !f) { ersetzen(koerper, leerzustand('Frage nicht gefunden', 'Sie wurde vielleicht schon beantwortet.')); return; }
    if (f.stand !== 'offen') {
      ersetzen(koerper, h('div', { class: 'karte erledigt' }, h('p', { class: 'frage-text' }, f.text), hinweis('haken', f.stand === 'beantwortet' ? 'Beantwortet.' : 'Zurückgenommen.')));
      return;
    }
    const gesperrt = !stand.darfSchreiben() || (w.fern && !w.verbindung.ok);
    ersetzen(koerper, frageKarte(u, w, f, false),
      h('button', { class: 'text-knopf zerstoerend frage-zuruecknehmen', type: 'button', disabled: gesperrt, onclick: () => { void zuruecknehmen(w, f); } }, 'Frage zurücknehmen'),
      fehler, absenderHinweis(stand));
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}
