/**
 * DAS SITZUNGSDETAIL: Kopf, Verlauf mit Neue-Nachrichten-Marke, offene
 * Rueckfrage und Freigaben, Composer (Spezifikation 7.1). Keine
 * Terminalansicht. Worker erscheinen hier nicht (alice, 18.09.): die
 * Sitzungsliste nennt nur ihre Zahl; ihre Antraege und angehaltenen Befehle
 * stehen als Karten im Chat ihres Orchestrators.
 */
import type { ApiError, Approval, ChatMessage, ChatToolCall, Prompt, SessionSummary } from '../../mobile-shared/vertrag';
import { aktionsblatt, abfrage } from './blatt';
import { Composer } from './composer';
import { ersetzen, ersetzenBeiAenderung, h, markdown, symbol } from './dom';
import {
  harnessName, leerzustand, maschinenName, navKnopf, punkt, seite, sitzungsFarbe, sitzungsMaschine,
  sitzungsText, type Ansicht, type Umgebung,
} from './teile';
import { marke as zeitmarke, relativ, uhr } from './zeit';

const NAHE_AM_ENDE = 96;
const ZEITABSTAND = 15 * 60_000;
/**
 * Kann der Server das Gespraech einer Sitzung nicht lesen (`capability_unavailable`:
 * Pane ohne laufenden Harness, keine Sitzungsdatei, Harness ohne Chatquelle), steht
 * hier dieser Hinweis statt der englischen Servermeldung, die den Grund nicht nennt.
 * ANLASS (13.10.2026, alice): „ich sehe auch keinen chat oder so".
 */
const KEIN_VERLAUF_TITEL = 'Kein Verlauf';
const KEIN_VERLAUF_TEXT = 'Für diese Sitzung gibt es hier keinen Verlauf. Die Werkbank kann ihr Gespräch gerade nicht lesen.';

/** Ein v1-Server liefert nur Text der Form `Name(Argumente)\nAusgabe`; daraus wird dieselbe Form. */
function werkzeugAusText(text: string): ChatToolCall {
  const [kopf, ...rest] = text.split('\n');
  const t = kopf.match(/^([A-Za-z][\w.-]*)\((.*)\)$/);
  return { name: t ? t[1] : 'Werkzeug', arguments_preview: t ? t[2] : kopf, output_preview: rest.join('\n') };
}

/** Werkzeugaufruf: aus dem strukturierten Feld `tool` (Vertrag 1.1), der Text nur als Rueckfall. */
function werkzeug(m: ChatMessage): HTMLElement {
  const w = m.tool ?? werkzeugAusText(m.text);
  const ausgabe = w.output_preview.trim();
  const teile = () => [h('span', { class: 'wz-name' }, w.name || 'Werkzeug'), h('span', { class: 'wz-arg' }, w.arguments_preview)];
  const quelle = m.tool ? 'feld' : 'text';
  if (!ausgabe) return h('div', { class: 'msg werkzeug ohne-ausgabe', 'data-id': m.id, 'data-quelle': quelle }, h('div', { class: 'wz-kopf' }, ...teile()));
  return h('details', { class: 'msg werkzeug', 'data-id': m.id, 'data-quelle': quelle }, h('summary', { class: 'wz-kopf' }, ...teile()), h('pre', { class: 'wz-ausgabe' }, ausgabe));
}

/**
 * Fehler einer Sitzungsaktion in Worten der Oberflaeche. Die Ablehnung wegen
 * laufender Worker sagt, was los ist und was geht; einen Ausweg mit Gewalt
 * bietet die App nicht an (Spezifikation 1). Eine Zahl nennt der Hinweis
 * nicht: `wb-session-close` zaehlt lebende Worker-Panes, und die kennt die
 * App nur mittelbar ueber den Workerzustand.
 */
function aktionsFehlerText(f: ApiError): string {
  if (f.code === 'close_rejected_workers_running') {
    return 'Nicht geschlossen: In dieser Sitzung laufen noch Worker. Die Werkbank schließt eine Sitzung erst, wenn keiner ihrer Worker mehr läuft. Warte, bis sie fertig sind, oder beende sie am Rechner.';
  }
  return f.message;
}

function nachricht(m: ChatMessage): HTMLElement {
  switch (m.role) {
    case 'human':
      return h('div', { class: 'msg mensch', 'data-id': m.id }, h('div', { class: 'blase' }, m.text));
    case 'agent': {
      const el = h('div', { class: 'msg agent', 'data-id': m.id });
      el.append(markdown(m.text));
      return el;
    }
    case 'tool':
      return werkzeug(m);
    case 'system':
      return h('div', { class: 'msg system', 'data-id': m.id }, m.text);
  }
}

export function chatAnsicht(u: Umgebung, id: string): Ansicht {
  const stand = u.stand;
  const sitzung = (): SessionSummary | undefined => stand.sitzungen?.find((s) => s.id === id);
  const unterzeile = h('div', { class: 'nav-unterzeile' });
  const mehr = navKnopf('mehr', 'Sitzungsaktionen', () => { void aktionen(); });
  const s = seite(u, { titel: sitzung()?.name ?? id.split(':')[1] ?? id, zurueck: 'Sitzungen', aktionen: [mehr], unterzeile, klasse: 'chat-ansicht' });
  s.el.dataset.composer = 'ja';

  const verlauf = h('div', { class: 'verlauf', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const offene = h('div', { class: 'offene' });
  // Gesendet, im Verlauf des Harness noch nicht gefuehrt (stand.ausstehend).
  const unterwegs = h('div', { class: 'unterwegs' });
  const pille = h('button', { class: 'neu-pille', type: 'button', hidden: true }, 'Neue Nachrichten');
  const hinweisUnten = h('div', { class: 'chat-hinweis', hidden: true });
  // v1.7: „Bescheid geben“. Gestaltet wie der Hinweis darunter, mit einem
  // kleinen Knopf; der zweite Druck nimmt den Wunsch zurueck.
  const bescheid = h('div', { class: 'chat-hinweis bescheid-zeile', hidden: true, role: 'status' });
  const composer = new Composer({
    platzhalter: 'Nachricht',
    entwurf: id,
    senden: (text) => stand.senden(id, text),
    taste: (key) => stand.taste(id, key),
  });
  s.inhalt.classList.add('chat-inhalt');
  s.inhalt.append(verlauf, unterwegs, offene);
  const dock = h('div', { class: 'chat-dock' }, pille, hinweisUnten, bescheid, composer.el);
  s.el.append(dock);

  // Je gezeichneter Nachricht ihre Knoten (Zeitmarke, falls gesetzt, und die Nachricht selbst).
  let gerendert: { id: string; zeit: number; knoten: HTMLElement[] }[] = [];
  let letzteZeit = 0;
  let trenner: HTMLElement | null = null;
  let erstesMal = true;
  let offeneSchluessel = '';

  const amEnde = (): boolean => s.inhalt.scrollHeight - s.inhalt.scrollTop - s.inhalt.clientHeight < NAHE_AM_ENDE;
  const nachUnten = (weich = false): void => {
    s.inhalt.scrollTo({ top: s.inhalt.scrollHeight, behavior: weich && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  };
  pille.addEventListener('click', () => { nachUnten(true); pille.hidden = true; });
  s.inhalt.addEventListener('scroll', () => { if (amEnde()) pille.hidden = true; }, { passive: true });
  // Oeffnet sich die Tastatur, schrumpft der Rahmen; wer am Ende war, bleibt dort.
  let warAmEnde = true;
  s.inhalt.addEventListener('scroll', () => { warAmEnde = amEnde(); }, { passive: true });
  // Waechst der Inhalt (spaeter geladene Karten, Umbruch), bleibt das Ende ebenfalls sichtbar.
  const beobachter = new ResizeObserver(() => { if (warAmEnde) nachUnten(); });
  beobachter.observe(s.inhalt);
  beobachter.observe(verlauf);
  beobachter.observe(offene);

  const zeitmarkeVor = (m: ChatMessage, vorher: number): HTMLElement | null =>
    m.created_at - vorher > ZEITABSTAND ? h('div', { class: 'zeitmarke' }, zeitmarke(m.created_at)) : null;

  /**
   * Gleicht den Verlauf an `msgs` an, ohne Gezeichnetes neu zu bauen: Was vorn
   * aus dem 200er-Fenster faellt, geht; was hinten neu oder geaendert ist,
   * wird angehaengt. Neu gebaut wird nur ohne jede Ueberlappung.
   */
  const verlaufZeichnen = (msgs: ChatMessage[]): void => {
    verlauf.querySelector('.verlauf-laedt')?.remove();
    const warUnten = amEnde();
    const start = msgs.length ? gerendert.findIndex((g) => g.id === msgs[0].id) : -1;
    let gleich = 0;
    if (start >= 0) while (start + gleich < gerendert.length && gleich < msgs.length && gerendert[start + gleich].id === msgs[gleich].id) gleich++;
    const anschluss = gleich > 0;
    if (!anschluss) {
      ersetzen(verlauf);
      delete verlauf.dataset.leer;
      gerendert = [];
      letzteZeit = 0;
      trenner = null;
    } else {
      // Hinten: was nicht mehr passt (geaenderter Text, neue Reihenfolge), geht.
      for (const g of gerendert.splice(start + gleich)) for (const k of g.knoten) k.remove();
      // Vorn: was aus dem Fenster gefallen ist. Die Hoehe darueber bleibt
      // unveraendert sichtbar, wer weiter oben liest, springt nicht.
      if (start > 0) {
        const weg = gerendert.splice(0, start);
        const hoeheVorher = verlauf.scrollHeight;
        const letzterWeg = weg[weg.length - 1].knoten[weg[weg.length - 1].knoten.length - 1];
        if (trenner && trenner.compareDocumentPosition(letzterWeg) & Node.DOCUMENT_POSITION_FOLLOWING) {
          trenner.remove();
          trenner = null;
        }
        for (const g of weg) for (const k of g.knoten) k.remove();
        // Die erste Nachricht traegt ihre Zeitmarke wie bei einem Neubau.
        const erste = gerendert[0];
        const marke = erste.knoten.length === 1 ? zeitmarkeVor(msgs[0], 0) : null;
        if (marke) {
          erste.knoten[0].before(marke);
          erste.knoten.unshift(marke);
        }
        if (!warUnten) s.inhalt.scrollTop -= hoeheVorher - verlauf.scrollHeight;
      }
      letzteZeit = gerendert[gerendert.length - 1].zeit;
    }
    const neu = msgs.slice(gerendert.length);
    if (!neu.length) return;
    const echtNeu = !erstesMal && anschluss;
    if (echtNeu && !warUnten && !trenner && neu.some((m) => m.role !== 'human')) {
      trenner = h('div', { class: 'neu-trenner', role: 'separator' }, h('span', null, 'Neu'));
      verlauf.append(trenner);
    }
    for (const m of neu) {
      const knoten = [zeitmarkeVor(m, letzteZeit), nachricht(m)].filter((k): k is HTMLElement => k !== null);
      letzteZeit = m.created_at;
      verlauf.append(...knoten);
      gerendert.push({ id: m.id, zeit: m.created_at, knoten });
    }
    if (erstesMal || warUnten || neu.some((m) => m.role === 'human')) {
      requestAnimationFrame(() => nachUnten(!erstesMal));
    } else if (echtNeu) {
      pille.hidden = false;
    }
    erstesMal = false;
  };

  const promptKarte = (p: Prompt): HTMLElement => {
    const faehig = stand.faehig(`prompt.answer.${p.harness}`);
    const knoepfe = p.options.map((o) => {
      const b = h('button', { class: `option ${o.selected ? 'vorgewaehlt' : ''}`, type: 'button', disabled: !faehig || !stand.darfSchreiben(), 'aria-describedby': faehig ? null : `grund-${id}` }, o.label);
      b.addEventListener('click', async () => {
        const r = await stand.promptAntworten(id, p.fingerprint, o.id);
        if (!r.ok) fehlerSetzen(karte, r.fehler.message);
      });
      return b;
    });
    const karte = h('section', { class: 'entscheidung karte rueckfrage', 'aria-label': 'Offene Rückfrage' },
      h('div', { class: 'entscheidung-kopf' }, punkt('will'), h('h3', null, `Rückfrage von ${harnessName(p.harness)}`)),
      h('pre', { class: 'prompt-text' }, p.text),
      h('div', { class: 'optionen' }, ...knoepfe),
      faehig ? null : h('p', { class: 'entscheidung-notiz', id: `grund-${id}` },
        `Antworten per App ist für ${harnessName(p.harness)} ${p.harness_version} noch nicht freigegeben, weil die Dialogerkennung nicht gemessen ist. Beantworte die Rückfrage am Rechner.`),
      h('p', { class: 'entscheidung-fehler', role: 'alert', hidden: true }),
    );
    return karte;
  };

  const freigabeKarte = (f: Approval): HTMLElement => {
    const guard = f.kind === 'guard';
    const [wer, ...befehl] = guard ? f.summary.split(': ') : [null];
    const darfJa = stand.darfSchreiben() && stand.faehig(guard ? 'approvals.guard.approve' : 'approvals.request.decide');
    const darfNein = stand.darfSchreiben() && stand.faehig(guard ? 'approvals.guard.reject' : 'approvals.request.decide');
    const ja = h('button', { class: 'knopf primaer', type: 'button', disabled: !darfJa }, guard ? 'Erlauben' : 'Annehmen');
    const nein = h('button', { class: 'knopf getoent', type: 'button', disabled: !darfNein }, 'Ablehnen');
    const karte = h('section', { class: 'entscheidung karte', 'data-freigabe': f.id, 'aria-label': guard ? 'Angehaltener Befehl' : 'Worker-Antrag' },
      h('div', { class: 'entscheidung-kopf' }, punkt('will'), h('h3', null, guard ? 'Angehaltener Befehl' : 'Worker-Antrag'),
        h('span', { class: 'entscheidung-zeit' }, relativ(f.created_at))),
      guard
        ? h('div', null, h('p', { class: 'entscheidung-wer' }, `${wer} möchte einmalig ausführen:`), h('pre', { class: 'befehl' }, befehl.join(': ') || f.summary))
        : h('p', { class: 'entscheidung-text' }, f.summary),
      h('div', { class: 'entscheidung-knoepfe' }, nein, ja),
      !darfJa && stand.darfSchreiben() ? h('p', { class: 'entscheidung-notiz' }, 'Annehmen per App ist noch nicht freigegeben. Ablehnen geht.') : null,
      h('p', { class: 'entscheidung-fehler', role: 'alert', hidden: true }),
    );
    ja.addEventListener('click', async () => {
      ja.disabled = nein.disabled = true;
      const r = await stand.entscheiden(f.kind, f.id, 'approve', '');
      if (!r.ok) { fehlerSetzen(karte, r.fehler.message); ja.disabled = nein.disabled = false; }
    });
    nein.addEventListener('click', async () => {
      const grund = await abfrage({ titel: guard ? 'Befehl ablehnen?' : 'Antrag ablehnen?', text: 'Die Begründung geht an den Worker.', feld: { platzhalter: 'Begründung (optional)' }, ja: 'Ablehnen', jaArt: 'zerstoerend' });
      if (grund === null) return;
      ja.disabled = nein.disabled = true;
      const r = await stand.entscheiden(f.kind, f.id, 'reject', grund);
      if (!r.ok) { fehlerSetzen(karte, r.fehler.message); ja.disabled = nein.disabled = false; }
    });
    return karte;
  };

  let aktionsFehler: { text: string; warnung: boolean } | null = null;
  const fortsetzen = async (): Promise<void> => {
    const r = await stand.fortsetzen(id);
    aktionsFehler = r.ok ? null : { text: aktionsFehlerText(r.fehler), warnung: false };
    aktualisieren();
  };
  const aktionen = async (): Promise<void> => {
    aktionsFehler = null;
    const x = sitzung();
    if (!x) return;
    const liste = [];
    if (x.state === 'stopped') liste.push({ titel: 'Fortsetzen', wert: 'fortsetzen' });
    else liste.push({ titel: 'Sitzung schließen', wert: 'schliessen', art: 'zerstoerend' as const });
    const wahl = await aktionsblatt(`${x.name} auf ${maschinenName(sitzungsMaschine(x))}`, liste);
    if (wahl === 'fortsetzen') {
      await fortsetzen();
    } else if (wahl === 'schliessen') {
      const n = x.worker_count;
      const ok = await abfrage({
        titel: 'Sitzung schließen?',
        text: n > 0
          ? `Die Sitzung wird sicher beendet, nicht gelöscht. Sie hat ${n} Worker; läuft davon noch einer, lehnt die Werkbank das Schließen ab.`
          : 'Die Sitzung wird sicher beendet, nicht gelöscht. Laufen noch Worker, lehnt die Werkbank das Schließen ab.',
        ja: 'Schließen', jaArt: 'zerstoerend',
      });
      if (ok === null) return;
      const r = await stand.schliessen(id);
      aktionsFehler = r.ok ? null : { text: aktionsFehlerText(r.fehler), warnung: r.fehler.code === 'close_rejected_workers_running' };
      aktualisieren();
    }
  };

  /**
   * Wartewunsch „Bescheid geben“ (Vertrag 1.7/1.8): das naechste „Worker fertig“
   * dieser Sitzung kommt als Push, sonst steht es nur im Tab „Meldungen“. Der
   * Knopf erscheint nur, wenn die Maschine der Sitzung den Wunsch annimmt
   * (`notify_until` vorhanden) und die Sitzung laeuft.
   */
  let bescheidFehler: string | null = null;
  let bescheidLaeuft = false;
  const bescheidUmschalten = async (): Promise<void> => {
    const x = sitzung();
    if (!x || bescheidLaeuft) return;
    const an = typeof x.notify_until !== 'number';
    bescheidLaeuft = true;
    bescheidFehler = null;
    aktualisieren();
    // Vertrag 1.8: an die Origin der Maschine der Sitzung; Stand zeigt den neuen
    // Wert sofort, der naechste Abgleich (`session.changed`) bestaetigt ihn.
    const r = await stand.bescheid(x.id, an);
    bescheidLaeuft = false;
    if (!r.ok) bescheidFehler = r.fehler.message;
    aktualisieren();
  };
  const bescheidZeichnen = (x: SessionSummary | undefined): void => {
    const sichtbar = !!x && x.notify_until !== undefined && x.source === 'authoritative'
      && (x.state === 'running' || x.state === 'attention' || typeof x.notify_until === 'number');
    bescheid.hidden = !sichtbar;
    if (!sichtbar || !x) return;
    const an = typeof x.notify_until === 'number';
    const darf = stand.beschreibbar(x) && !bescheidLaeuft;
    const text = bescheidFehler
      ?? (an ? `Push, sobald ein Worker fertig ist. Gilt bis ${uhr(x.notify_until as number)}.` : '„Worker fertig“ steht sonst nur in der App.');
    ersetzenBeiAenderung(bescheid, `${an}|${darf}|${text}`, () => [
      h('span', { class: bescheidFehler ? 'text-will' : null }, text),
      h('button', {
        class: `knopf klein ${an ? 'primaer' : 'getoent'}`, type: 'button', 'aria-pressed': an ? 'true' : 'false',
        'data-bescheid': an ? 'an' : 'aus', disabled: !darf, onclick: () => { void bescheidUmschalten(); },
      }, an ? symbol('haken', 16) : null, 'Bescheid geben'),
    ]);
  };

  const hinweisSetzen = (text: string | null, knopf?: { text: string; beiKlick: () => void }, warnung = false): void => {
    hinweisUnten.hidden = text === null;
    hinweisUnten.classList.toggle('warnung', warnung && text !== null);
    hinweisUnten.setAttribute('role', warnung ? 'alert' : 'status');
    ersetzenBeiAenderung(hinweisUnten, `${text ?? ''}|${knopf?.text ?? ''}`, () => [
      text ? h('span', null, text) : null,
      knopf ? h('button', { class: 'knopf getoent klein', type: 'button', onclick: knopf.beiKlick }, knopf.text) : null,
    ]);
  };
  const verstanden = { text: 'OK', beiKlick: () => { aktionsFehler = null; aktualisieren(); } };

  const aktualisieren = (): void => {
    const x = sitzung();
    const chat = stand.chats.get(id);
    if (x) {
      s.titelSetzen(x.name);
      const farbe = sitzungsFarbe(x.state);
      const alt = stand.veraltet() || x.source === 'mirror';
      const zeile = `${sitzungsText(x.state)}, ${maschinenName(sitzungsMaschine(x))}`;
      ersetzenBeiAenderung(unterzeile, `${farbe}|${alt}|${zeile}`, () => [punkt(alt ? `${farbe} alt` : farbe), h('span', { class: 'nav-maschine' }, zeile)]);
    } else if (stand.sitzungen) {
      ersetzenBeiAenderung(unterzeile, 'weg', () => [h('span', null, 'Nicht mehr vorhanden')]);
    }

    // Verlauf
    if (chat?.fehler && !chat.messages.length) {
      const [titel, text] = chat.fehler.code === 'capability_unavailable'
        ? [KEIN_VERLAUF_TITEL, x && stand.beschreibbar(x) && x.state !== 'stopped' ? `${KEIN_VERLAUF_TEXT} Senden geht trotzdem.` : KEIN_VERLAUF_TEXT]
        : ['Verlauf nicht verfügbar', chat.fehler.message];
      // Nur bei geaendertem Text neu bauen: der Verlauf ist eine Live-Region, jeder Neubau wuerde vorgelesen.
      if (verlauf.dataset.leer !== `${titel}|${text}`) {
        ersetzen(verlauf, leerzustand(titel, text));
        verlauf.dataset.leer = `${titel}|${text}`;
      }
      gerendert = [];
    } else if (chat) {
      verlaufZeichnen(chat.messages);
    } else {
      if (!verlauf.firstChild) verlauf.append(h('div', { class: 'verlauf-laedt', 'aria-busy': 'true', 'aria-label': 'Verlauf wird geladen' }, h('div', { class: 'skelett zeile lang' }), h('div', { class: 'skelett zeile' }), h('div', { class: 'skelett zeile kurz' })));
    }
    // Eigene Nachrichten, die der Verlauf noch nicht fuehrt: sofort sichtbar,
    // als Blase des Menschen mit dem Vermerk, dass sie unterwegs ist.
    const offenGesendet = stand.ausstehend.get(id) ?? [];
    const schluesselUnterwegs = offenGesendet.map((a) => `${a.zeit}`).join(',');
    if (unterwegs.dataset.stand !== schluesselUnterwegs) {
      unterwegs.dataset.stand = schluesselUnterwegs;
      ersetzen(unterwegs, ...offenGesendet.map((a) => h('div', { class: 'msg mensch ausstehend', 'data-unterwegs': String(a.zeit) },
        h('div', { class: 'blase' }, a.text),
        h('div', { class: 'msg-vermerk' }, 'Gesendet'))));
      if (offenGesendet.length) requestAnimationFrame(() => nachUnten(true));
    }

    // Offene Rueckfrage und Freigaben dieser Sitzung
    const p = stand.prompts.get(id) ?? null;
    const fs = stand.freigaben.filter((f) => f.session_id === id);
    // Nur neu zeichnen, wenn sich etwas geaendert hat: sonst gingen Fehlertext
    // und Knopfzustand einer laufenden Entscheidung bei jedem Takt verloren.
    const schluessel = [p?.fingerprint ?? '', ...fs.map((f) => f.id), stand.darfSchreiben(), JSON.stringify(stand.bootstrap?.capabilities ?? {})].join('|');
    if (schluessel !== offeneSchluessel) {
      offeneSchluessel = schluessel;
      const vorher = offene.childElementCount;
      ersetzen(offene, p ? promptKarte(p) : null, ...fs.map(freigabeKarte));
      if (offene.childElementCount > vorher && warAmEnde) requestAnimationFrame(() => nachUnten());
    }

    // Composer: nur an die autoritative, erreichbare Maschine schreiben
    if (!x) {
      composer.sperren('Diese Sitzung gibt es nicht mehr');
      hinweisSetzen(null);
    } else if (!stand.verbunden) {
      composer.sperren('Keine Verbindung');
      hinweisSetzen(null);
    } else if (x.source === 'mirror' || stand.maschine(sitzungsMaschine(x))?.erreichbar !== true) {
      composer.sperren(`${maschinenName(sitzungsMaschine(x))} ist nicht erreichbar`);
      hinweisSetzen(`${maschinenName(sitzungsMaschine(x))} antwortet nicht. Eingaben gehen nur direkt an diese Maschine, nie über den Spiegel.`);
    } else if (x.state === 'stopped') {
      composer.sperren('Die Sitzung ist beendet');
      hinweisSetzen(aktionsFehler?.text ?? 'Die Sitzung ist beendet.', { text: 'Fortsetzen', beiKlick: () => { void fortsetzen(); } });
    } else if (!stand.darfSchreiben()) {
      composer.sperren('Nur Anzeige bis zum Neuladen');
      hinweisSetzen(null);
    } else {
      composer.sperren(null);
      hinweisSetzen(aktionsFehler?.text ?? null, aktionsFehler ? verstanden : undefined, aktionsFehler?.warnung);
    }
    mehr.disabled = !x || !stand.beschreibbar(x);
    bescheidZeichnen(x);
  };

  void stand.chatOeffnen(id);
  aktualisieren();
  return {
    el: s.el,
    aktualisieren,
    gezeigt() {
      if (stand.chats.get(id)?.geladen && Date.now() - (stand.chats.get(id)?.geladen ?? 0) > 5_000) void stand.chatLaden(id);
    },
  };
}

function fehlerSetzen(karte: HTMLElement, text: string): void {
  const f = karte.querySelector<HTMLElement>('.entscheidung-fehler');
  if (!f) return;
  f.hidden = false;
  f.textContent = text;
}
