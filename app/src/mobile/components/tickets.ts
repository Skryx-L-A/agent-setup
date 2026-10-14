/**
 * TICKETS einer Welt: Liste nach Stand und Detail mit den freigegebenen
 * Ticketaktionen (Spezifikation 3.1). Jede Aktion ist ein Formblatt mit den
 * Fachfeldern von Vertrag 1.1 und folgt den Regeln des Kerns (`welten.ts`):
 * angenommen wird aus der Triage mit Empfaenger, ein Pruefer wird aus „zur
 * Abnahme“ bestimmt und ist nie der Bearbeiter, zurueckgegeben wird ein
 * abgenommenes Ticket mit Bemerkung, Grenzen sind Frist und/oder Runden,
 * verworfen wird mit einem Grund aus der festen Liste des Kerns.
 * Vertrag 1.4 kommt die Abnahme durch den Menschen hinzu (des Nutzers
 * Entscheidung vom 18.09.2026): aus „zur Abnahme“ UND aus „zurueckgegeben“,
 * mit einem Grund des Kerns, einer Bemerkung (Pflicht bei „teilweise“) und der
 * bestaetigten Definition of Done, sobald die Welt eine hat. Der Kern nimmt
 * beide Staende an (`approve_ticket` in `shell/agents_data.py`: `if
 * ticket["state"] not in ("zur Abnahme", "zurückgegeben")`), und der Kern
 * dieser App laesst beide durch (`welten.ts`, Fall `ticket_abnehmen`); ein
 * zurueckgegebenes Ticket war hier bis zum 21.09.2026 trotzdem ohne Knopf und
 * damit vom Handy aus nicht abzunehmen. Eine Pruefung dagegen geht weiterhin
 * nur aus „zur Abnahme“ (`review_ticket`: „Pruefung nur aus zur Abnahme“).
 */
import type { AgentAction } from '../../mobile-shared/vertrag';
import type { TicketKurz, WeltKurz } from './agents-daten';
import { agentName, agentWahlen, auftragGeben } from './agents';
import { aktionsblatt, formblatt } from './blatt';
import { ersetzen, h, symbol } from './dom';
import { gruppe, schalterZeile, textFeld, wahlListe, zahlFeld, zeitFeld } from './formular';
import type { Stand } from './stand';
import { abschnitt, leerzustand, marke, navKnopf, punkt, seite, ticketFarbe, type Ansicht, type Umgebung } from './teile';
import { relativ } from './zeit';

/**
 * Die Gruende, die der Kern bei der Abnahme annimmt (`APPROVE_REASONS`).
 * „teilweise“ verlangt dort zusaetzlich eine Bemerkung.
 */
const ABNAHME_GRUENDE = [
  { wert: 'erledigt', text: 'Erledigt', zusatz: 'Vollständig fertig' },
  { wert: 'teilweise', text: 'Teilweise', zusatz: 'Der Rest steht in der Bemerkung' },
];

/**
 * Die Gruende, die der Kern beim Verwerfen annimmt (`DISCARD_GRUENDE`).
 * „duplikat“ verlangt dort zusaetzlich das Ticket, von dem es ein Duplikat ist;
 * Vertrag 1.6 traegt es als `duplicate_of`. Bis 1.5 fehlte das Feld, und der
 * Grund war vom Handy aus nicht waehlbar.
 */
const VERWERF_GRUENDE = [
  { wert: 'duplikat', text: 'Duplikat', zusatz: 'Eine andere Karte führt dieselbe Sache' },
  { wert: 'nicht-mehr-noetig', text: 'Nicht mehr nötig' },
  { wert: 'anderswo-erledigt', text: 'Anderswo erledigt' },
  { wert: 'nicht-reproduzierbar', text: 'Nicht reproduzierbar' },
  { wert: 'abgelehnt', text: 'Abgelehnt' },
];

/** Die Reihenfolge der Gruppen: was den Menschen braucht, zuerst. */
const REIHENFOLGE = ['braucht dich', 'zur Abnahme', 'in Prüfung', 'läuft', 'wartet', 'offen', 'triage', 'zurückgegeben', 'unterbrochen', 'abgenommen', 'verworfen'];
const ABGESCHLOSSEN = new Set(['abgenommen', 'verworfen']);

function welt(stand: Stand, id: string): WeltKurz | undefined {
  return stand.agents?.welten.find((w) => w.id === id);
}

const name = agentName;

function ticketKarte(u: Umgebung, w: WeltKurz, t: TicketKurz): HTMLElement {
  const farbe = ticketFarbe(t.stand);
  return h('button', { class: `karte ticket-karte ${ABGESCHLOSSEN.has(t.stand) ? 'abgeschlossen' : ''}`, type: 'button', 'data-ticket': t.id,
    onclick: () => u.router.oeffnen({ tab: 'agents', ansicht: 'ticket', welt: w.id, ticket: t.id }) },
  h('div', { class: 'ticket-kopf' },
    h('span', { class: 'ticket-id' }, t.id),
    t.prioritaet <= 1 ? marke(t.prioritaet_text, t.prioritaet === 0 ? 'aus' : 'will') : null,
    h('span', { class: 'ticket-zeit' }, relativ(t.geaendert)),
  ),
  h('span', { class: 'ticket-titel' }, t.titel),
  h('div', { class: 'ticket-fuss' },
    punkt(farbe === 'akzent' ? 'laeuft' : farbe),
    h('span', { class: `ticket-stand text-${farbe}` }, t.stand),
    h('span', { class: 'ticket-bearbeiter' }, name(w, t.bearbeiter)),
  ),
  );
}

export function ticketListe(u: Umgebung, weltId: string): Ansicht {
  const plus = navKnopf('plus', 'Neuer Auftrag', () => { void auftragGeben(u, weltId); });
  const s = seite(u, { titel: 'Tickets', zurueck: welt(u.stand, weltId)?.name ?? 'Welt', aktionen: [plus], klasse: 'liste-ansicht' });
  const koerper = h('div', { class: 'listen-koerper' });
  s.inhalt.append(koerper);
  const aktualisieren = (): void => {
    const w = welt(u.stand, weltId);
    plus.disabled = !w || !u.stand.darfSchreiben() || (w.fern && !w.verbindung.ok);
    if (!w) { ersetzen(koerper, leerzustand('Welt nicht gefunden', 'Diese Welt ist nicht mehr im Stand.')); return; }
    s.titelSetzen(`Tickets ${w.name}`);
    if (!w.tickets.length) { ersetzen(koerper, leerzustand('Keine Tickets', 'Gib der Welt über das Plus oben einen Auftrag.')); return; }
    const gruppen = REIHENFOLGE.map((st) => ({ st, liste: w.tickets.filter((t) => t.stand === st) })).filter((g) => g.liste.length);
    const rest = w.tickets.filter((t) => !REIHENFOLGE.includes(t.stand));
    if (rest.length) gruppen.push({ st: 'sonstige', liste: rest });
    ersetzen(koerper, ...gruppen.map((g) => h('div', { class: 'gruppe' },
      abschnitt(g.st.charAt(0).toUpperCase() + g.st.slice(1), String(g.liste.length)),
      h('div', { class: 'karten' }, ...g.liste.map((t) => ticketKarte(u, w, t))))));
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

export function ticketAnsicht(u: Umgebung, weltId: string, ticketId: string): Ansicht {
  const stand = u.stand;
  const mehr = navKnopf('mehr', 'Ticketaktionen', () => { void weitere(); });
  const s = seite(u, { titel: ticketId, zurueck: 'Tickets', aktionen: [mehr], klasse: 'detail-ansicht' });
  const koerper = h('div', { class: 'detail-koerper' });
  s.inhalt.append(koerper);

  const jetzt = (): { w: WeltKurz; t: TicketKurz } | null => {
    const w = welt(stand, weltId);
    const t = w?.tickets.find((x) => x.id === ticketId);
    return w && t ? { w, t } : null;
  };
  const ausfuehren = async (a: AgentAction): Promise<string | null> => {
    const r = await stand.agentAktion(a);
    return r.ok ? null : r.fehler.message;
  };

  /** Triage: annehmen und an einen Agenten geben. */
  const annehmen = async (w: WeltKurz, t: TicketKurz): Promise<void> => {
    const vorschlag = t.adressaten.find((a) => w.agenten.some((x) => x.id === a)) ?? null;
    const an = wahlListe('Empfänger', agentWahlen(w), vorschlag);
    await formblatt({
      titel: 'Ticket annehmen', ja: 'Annehmen',
      inhalt: [gruppe('Empfänger', an.el, `„${t.titel}“ verlässt die Triage und geht an den gewählten Agenten.`)],
      gueltig: () => an.wert() !== null,
      ausfuehren: () => ausfuehren({ type: 'ticket.accept', ticket_id: t.id, recipient: an.wert() ?? '' }),
    });
  };

  /** Zur Abnahme: einen Pruefer bestimmen, nie den Bearbeiter selbst. */
  const pruefen = async (w: WeltKurz, t: TicketKurz): Promise<void> => {
    const pruefer = wahlListe('Prüfer', agentWahlen(w, (a) => a.id === t.bearbeiter ? { aus: true, zusatz: 'Hat das Ticket bearbeitet' } : null), null);
    await formblatt({
      titel: 'Prüfer bestimmen', ja: 'Bestimmen',
      inhalt: [gruppe('Prüfer', pruefer.el, 'Wer ein Ticket bearbeitet hat, prüft es nicht selbst.')],
      gueltig: () => pruefer.wert() !== null,
      ausfuehren: () => ausfuehren({ type: 'ticket.review', ticket_id: t.id, reviewer: pruefer.wert() ?? '' }),
    });
  };

  /**
   * Zur Abnahme: das Ergebnis endgueltig abnehmen. Die Felder sind die des
   * Kerns (`wb-ticket abnehmen`): Grund, Bemerkung -- Pflicht bei „teilweise“ --
   * und, sobald die Welt eine Definition of Done hat, deren Bestaetigung.
   */
  const abnehmen = async (w: WeltKurz, t: TicketKurz): Promise<void> => {
    const grund = wahlListe('Grund', ABNAHME_GRUENDE, 'erledigt');
    const bemerkung = textFeld({ beschriftung: 'Bemerkung', platzhalter: 'Was gilt als abgenommen?', mehrzeilig: true });
    const punkte = w.dod.map((text) => h('li', null,
      h('span', { class: 'haken-feld', role: 'img', 'aria-label': 'offen' }),
      h('span', null, text)));
    const dod = w.dod.length
      ? schalterZeile('Geprüft', false, null, (an) => {
        // Der Haken folgt dem Schalter: was bestaetigt wird, ist auch zu sehen.
        for (const li of punkte) {
          li.classList.toggle('erledigt', an);
          const feld = li.firstElementChild as HTMLElement;
          ersetzen(feld, an ? symbol('haken', 16) : null);
          feld.setAttribute('aria-label', an ? 'geprüft' : 'offen');
        }
      })
      : null;
    await formblatt({
      titel: 'Ticket abnehmen', ja: 'Abnehmen', gross: w.dod.length > 0,
      inhalt: [
        gruppe('Grund', grund.el,
          `Die Abnahme ist endgültig: „${t.titel}“ gilt danach als erledigt und abhängige Tickets als erfüllt. Zurückholen geht nur mit einer Rückgabe.`),
        gruppe('Bemerkung', bemerkung.el,
          'Sie steht im Verlauf der Abnahme. Bei „Teilweise“ ist sie Pflicht: sie hält fest, was offen bleibt.', bemerkung.feld.id),
        dod ? gruppe('Definition of Done', [h('ul', { class: 'karte punkte-liste' }, ...punkte), dod.el],
          `Die Welt ${w.name} nimmt ein Ticket erst ab, wenn Du diese Punkte bestätigst.`) : null,
      ],
      gueltig: () => grund.wert() !== null && (grund.wert() !== 'teilweise' || !!bemerkung.wert()) && (!dod || dod.an()),
      ausfuehren: () => ausfuehren({
        type: 'ticket.approve', ticket_id: t.id, reason: grund.wert() === 'teilweise' ? 'teilweise' : 'erledigt',
        ...(bemerkung.wert() ? { note: bemerkung.wert() } : {}),
        ...(dod ? { dod_confirmed: true } : {}),
      }),
    });
  };

  /** Abgenommen: mit einer Bemerkung, was fehlt, zurueckgeben. */
  const zurueckgeben = async (w: WeltKurz, t: TicketKurz): Promise<void> => {
    const bemerkung = textFeld({ beschriftung: 'Was fehlt noch?', platzhalter: 'Was fehlt noch?', mehrzeilig: true });
    await formblatt({
      titel: 'Zurückgeben', ja: 'Zurückgeben',
      inhalt: [gruppe('Bemerkung', bemerkung.el, `Das Ticket geht mit Deiner Bemerkung an ${name(w, t.bearbeiter)} zurück.`, bemerkung.feld.id)],
      gueltig: () => !!bemerkung.wert(),
      ausfuehren: () => ausfuehren({ type: 'ticket.return', ticket_id: t.id, reason: bemerkung.wert() }),
    });
  };

  const umadressieren = async (w: WeltKurz, t: TicketKurz): Promise<void> => {
    const an = wahlListe('Empfänger', agentWahlen(w, (a) => a.id === t.bearbeiter ? { zusatz: 'Bearbeitet es gerade' } : null), null);
    const grund = textFeld({ beschriftung: 'Grund', platzhalter: 'Warum geht es an jemand anderen?', mehrzeilig: true });
    await formblatt({
      titel: 'Empfänger', ja: 'Umadressieren', gross: true,
      inhalt: [gruppe(null, an.el, `Neuer Empfänger für „${t.titel}“.`), gruppe('Grund', grund.el, 'Der Grund steht im Verlauf des Tickets.', grund.feld.id)],
      gueltig: () => an.wert() !== null && !!grund.wert(),
      ausfuehren: () => ausfuehren({ type: 'ticket.redirect', ticket_id: t.id, recipient: an.wert() ?? '', reason: grund.wert() }),
    });
  };

  const grenzen = async (_w: WeltKurz, t: TicketKurz): Promise<void> => {
    const morgen = new Date(Date.now() + 24 * 3_600_000);
    morgen.setMinutes(0, 0, 0);
    const zeit = zeitFeld('Frist', morgen);
    const runden = zahlFeld('Höchstens', 3, 1, 99);
    const frist = schalterZeile('Frist', true, zeit.el);
    const mitRunden = schalterZeile('Runden', false, runden.el);
    await formblatt({
      titel: 'Grenzen setzen', ja: 'Setzen',
      inhalt: [gruppe(null, [frist.el, mitRunden.el], 'Mindestens eine Grenze. Ist das Ticket an seine Grenze gestoßen, läuft es mit den neuen Grenzen weiter.')],
      gueltig: () => (frist.an() && zeit.iso() !== null) || mitRunden.an(),
      ausfuehren: () => ausfuehren({
        type: 'ticket.scope', ticket_id: t.id,
        ...(frist.an() && zeit.iso() ? { deadline: zeit.iso() ?? '' } : {}),
        ...(mitRunden.an() ? { rounds: runden.wert() } : {}),
      }),
    });
  };

  const verwerfen = async (w: WeltKurz, t: TicketKurz): Promise<void> => {
    // Der Kern nimmt das Duplikat nur als Kennung eines Tickets DERSELBEN Welt
    // an; deshalb eine Auswahl statt eines Textfelds, und das Ticket selbst
    // steht nicht darin. Gibt es kein anderes, faellt der Grund weg -- sonst
    // stuende eine Wahl da, die der Kern in jedem Fall ablehnte.
    const andere = w.tickets.filter((x) => x.id !== t.id)
      .map((x) => ({ wert: x.id, text: `${x.id}, ${x.titel}`, zusatz: x.stand }));
    const gruende = andere.length ? VERWERF_GRUENDE : VERWERF_GRUENDE.filter((g) => g.wert !== 'duplikat');
    const duplikat = wahlListe('Duplikat von', andere, null);
    const bemerkung = textFeld({ beschriftung: 'Bemerkung', platzhalter: 'Warum wird es verworfen?', mehrzeilig: true });
    const duplikatGruppe = gruppe('Duplikat von', duplikat.el,
      'Das Ticket, das dieselbe Sache führt. Es bleibt offen, dieses hier wird geschlossen.');
    const grund = wahlListe('Grund', gruende, null, (wert) => { duplikatGruppe.hidden = wert !== 'duplikat'; });
    duplikatGruppe.hidden = true;
    await formblatt({
      titel: 'Ticket verwerfen', ja: 'Verwerfen', jaArt: 'zerstoerend',
      inhalt: [
        gruppe('Grund', grund.el, `„${t.titel}“ wird geschlossen, nicht gelöscht. Ein verworfenes Ticket erfüllt keine Abhängigkeit.`),
        duplikatGruppe,
        gruppe('Bemerkung', bemerkung.el, 'Sie steht im Verlauf und ist freiwillig.', bemerkung.feld.id),
      ],
      gueltig: () => grund.wert() !== null && (grund.wert() !== 'duplikat' || duplikat.wert() !== null),
      ausfuehren: () => ausfuehren({
        type: 'ticket.reject', ticket_id: t.id, reason: grund.wert() ?? '',
        ...(grund.wert() === 'duplikat' && duplikat.wert() ? { duplicate_of: duplikat.wert() ?? '' } : {}),
        ...(bemerkung.wert() ? { note: bemerkung.wert() } : {}),
      }),
    });
  };

  const weitere = async (): Promise<void> => {
    const x = jetzt();
    if (!x) return;
    const wahl = await aktionsblatt(`${x.t.id}, ${x.t.titel}`, [
      { titel: 'Umadressieren', wert: 'umadressieren' },
      { titel: 'Grenzen setzen', wert: 'grenzen' },
      { titel: 'Verwerfen', wert: 'verwerfen', art: 'zerstoerend' },
    ]);
    const y = jetzt();
    if (!y) return;
    if (wahl === 'umadressieren') await umadressieren(y.w, y.t);
    else if (wahl === 'grenzen') await grenzen(y.w, y.t);
    else if (wahl === 'verwerfen') await verwerfen(y.w, y.t);
  };

  interface Handlung { text: string; art: 'primaer' | 'getoent'; tun: (w: WeltKurz, t: TicketKurz) => Promise<void> }

  /**
   * Die Handlungen, die der Stand des Tickets gerade vom Menschen erwartet.
   * Bei „zur Abnahme“ stehen zwei nebeneinander: selbst abnehmen oder erst
   * einen Agenten pruefen lassen. Beides bleibt erreichbar. Ein
   * zurueckgegebenes Ticket kann der Mensch ebenfalls abnehmen -- der Kern
   * laesst genau diese zwei Staende zu --, eine Pruefung dort aber nicht.
   */
  const handlung = (t: TicketKurz): Handlung[] => {
    if (t.stand === 'triage') return [{ text: 'Annehmen', art: 'primaer', tun: annehmen }];
    if (t.stand === 'zur Abnahme') {
      return [{ text: 'Abnehmen', art: 'primaer', tun: abnehmen }, { text: 'Prüfer bestimmen', art: 'getoent', tun: pruefen }];
    }
    if (t.stand === 'zurückgegeben') return [{ text: 'Abnehmen', art: 'primaer', tun: abnehmen }];
    if (t.stand === 'abgenommen') return [{ text: 'Zurückgeben', art: 'getoent', tun: zurueckgeben }];
    if (t.stand === 'braucht dich') return [{ text: 'Grenzen setzen', art: 'getoent', tun: grenzen }];
    return [];
  };

  const aktualisieren = (): void => {
    const x = jetzt();
    if (!x) { ersetzen(koerper, leerzustand('Ticket nicht gefunden', 'Es ist nicht mehr im Stand der Welt.')); mehr.disabled = true; return; }
    const { w, t } = x;
    const farbe = ticketFarbe(t.stand);
    const gesperrt = !stand.darfSchreiben() || (w.fern && !w.verbindung.ok);
    mehr.disabled = gesperrt || ABGESCHLOSSEN.has(t.stand);
    const handlungen = handlung(t);
    ersetzen(koerper,
      h('div', { class: 'ticket-buehne' },
        h('span', { class: 'ticket-id' }, `${t.id}, ${t.kind || 'ticket'}`),
        h('h1', { class: 'ticket-gross' }, t.titel),
        h('div', { class: 'marken' }, marke(t.stand, farbe as 'will'), marke(`Priorität ${t.prioritaet_text}`), t.ampel === 'rot' ? marke('Frist überschritten', 'aus') : null),
      ),
      handlungen.length ? h('div', { class: 'entscheidung-knoepfe' }, ...handlungen.map((eine) =>
        h('button', { class: `knopf ${eine.art}`, type: 'button', disabled: gesperrt, 'data-handlung': eine.text, onclick: () => { void eine.tun(w, t); } }, eine.text))) : null,
      h('dl', { class: 'karte eigenschaften' },
        h('div', null, h('dt', null, 'Ziel'), h('dd', null, t.ziel || 'ohne Ziel')),
        h('div', null, h('dt', null, t.bearbeiter ? 'Bearbeitet von' : 'Adressiert an'), h('dd', null, t.bearbeiter ? name(w, t.bearbeiter) : t.adressaten.map((a) => name(w, a)).join(', ') || 'niemand')),
        h('div', null, h('dt', null, 'Geändert'), h('dd', null, relativ(t.geaendert))),
      ),
      t.ergebnis ? abschnitt('Ergebnis', name(w, t.ergebnis.von)) : null,
      t.ergebnis ? h('div', { class: 'karte text-karte' }, h('p', null, t.ergebnis.text)) : null,
      // Wer abgenommen hat, steht sonst nur im Verlauf. Ein zurueckgegebenes
      // Ticket traegt ebenfalls eine Abnahme, aber ohne Grund -- dann ist die
      // Bemerkung das, was offen blieb.
      t.abnahme ? abschnitt('Abnahme', relativ(t.abnahme.zeit)) : null,
      t.abnahme ? h('dl', { class: 'karte eigenschaften abnahme-karte' },
        h('div', null, h('dt', null, 'Von'), h('dd', null, name(w, t.abnahme.von))),
        t.abnahme.grund ? h('div', null, h('dt', null, 'Grund'), h('dd', null, t.abnahme.grund)) : null,
        t.abnahme.bemerkung ? h('div', null, h('dt', null, 'Bemerkung'), h('dd', null, t.abnahme.bemerkung)) : null,
      ) : null,
      t.fertig_punkte.length ? abschnitt('Fertig, wenn', `${t.fertig_punkte.filter((p) => p.erledigt).length} von ${t.fertig_punkte.length}`) : null,
      t.fertig_punkte.length ? h('ul', { class: 'karte punkte-liste' }, ...t.fertig_punkte.map((p) => h('li', { class: p.erledigt ? 'erledigt' : '' },
        h('span', { class: 'haken-feld', role: 'img', 'aria-label': p.erledigt ? 'erledigt' : 'offen' }, p.erledigt ? symbol('haken', 16) : null), h('span', null, p.text)))) : null,
      t.verlauf.length ? abschnitt('Verlauf') : null,
      t.verlauf.length ? h('ol', { class: 'karte verlauf-liste' }, ...[...t.verlauf].reverse().map((v) => h('li', null,
        h('span', { class: 'verlauf-was' }, `${v.ereignis}, ${name(w, v.von)}`),
        v.text ? h('span', { class: 'verlauf-text' }, v.text) : null,
        h('span', { class: 'verlauf-zeit' }, relativ(v.zeit))))) : null,
    );
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}
