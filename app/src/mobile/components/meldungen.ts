/**
 * MELDUNGEN: das zusammengefuehrte Journal beider Origins, ungelesene
 * Eintraege, Deep Links -- und oben die dauerhaften, handlungsfaehigen Zeilen
 * fuer Mitteilungen, Geraet, Maschinen und Version (Spezifikation 7.1).
 */
import type { Notification, NotificationEventType } from '../../mobile-shared/vertrag';
import { ersetzen, ersetzenBeiAenderung, h, symbol } from './dom';
import { verbindungsSignatur, verbindungsZeile } from './sitzungen';
import { abschnitt, leerzustand, maschinenName, marke, navTextKnopf, punkt, seite, type Ansicht, type Umgebung } from './teile';
import { marke as zeitmarke, relativ, tag, uhr } from './zeit';

const TYP: Record<NotificationEventType, { titel: string; farbe: string }> = {
  'orchestrator.waiting': { titel: 'Orchestrator wartet', farbe: 'will' },
  'worker.done': { titel: 'Worker fertig', farbe: 'fertig' },
  'command.blocked': { titel: 'Wartet auf Freigabe', farbe: 'will' },
  'session.lost': { titel: 'Sitzung verloren', farbe: 'aus' },
  'worker.stalled': { titel: 'Worker hängt', farbe: 'will' },
};

function statusZeile(sym: string, titel: string, wert: string, knopf?: { text: string; beiKlick: () => void; aus?: boolean }, wohin?: () => void): HTMLElement {
  const inhalt = [
    symbol(sym, 22),
    h('span', { class: 'status-text' }, h('span', { class: 'status-titel' }, titel), h('span', { class: 'status-wert' }, wert)),
  ];
  if (wohin) {
    return h('button', { class: 'status-zeile', type: 'button', onclick: wohin }, ...inhalt, symbol('weiter', 16));
  }
  return h('div', { class: 'status-zeile' }, ...inhalt,
    knopf ? h('button', { class: 'knopf getoent klein', type: 'button', disabled: knopf.aus === true, onclick: knopf.beiKlick }, knopf.text) : null);
}

export function statusKarte(u: Umgebung): HTMLElement {
  const stand = u.stand;
  const push = stand.push;
  const pushText = !push ? 'unbekannt'
    : push.erlaubnis === 'erteilt' ? 'erlaubt'
      : push.erlaubnis === 'verweigert' ? 'in den iOS-Einstellungen abgelehnt'
        : push.erlaubnis === 'nicht_moeglich' ? (push.grund ?? 'nicht möglich') : 'noch nicht erlaubt';
  const k = stand.kopplung;
  const zeilen: HTMLElement[] = [
    statusZeile('meldungen', 'Mitteilungen', pushText, push?.erlaubnis === 'offen' ? { text: 'Erlauben', beiKlick: () => { void stand.pushAnfragen(); } } : undefined),
    statusZeile('schloss', 'Gerät', k?.gekoppelt ? `${k.geraet ?? 'Dieses Gerät'}, gekoppelt` : k ? 'nicht gekoppelt' : 'wird geprüft', undefined,
      () => u.router.oeffnen({ tab: 'meldungen', ansicht: 'geraet' })),
    ...stand.maschinen.map((m) => statusZeile(m.erreichbar ? 'haken' : 'offline', maschinenName(m.machine),
      m.erreichbar ? 'erreichbar' : `nicht erreichbar${m.seit ? ` seit ${uhr(m.seit)}` : ''}`,
      m.erreichbar ? undefined : { text: 'Erneut prüfen', beiKlick: () => { void stand.abgleichen(); } })),
  ];
  return h('div', { class: 'karte status-karte' }, ...zeilen);
}

function meldungZeile(u: Umgebung, n: Notification, gewaehlt: boolean, jetzt: number): HTMLElement {
  const t = TYP[n.type];
  const ungelesen = u.stand.ungelesen(n);
  return h('button', {
    class: `meldung ${ungelesen ? 'ungelesen' : ''} ${gewaehlt ? 'gewaehlt' : ''}`, type: 'button', 'data-id': n.id,
    'aria-current': gewaehlt ? 'true' : null,
    onclick: () => { u.stand.alsGelesen([n.id]); u.router.oeffnen({ tab: 'meldungen', ansicht: 'meldung', id: n.id }); },
  },
  h('span', { class: 'meldung-marke' }, ungelesen ? h('span', { class: 'ungelesen-punkt', role: 'img', 'aria-label': 'ungelesen' }) : null),
  h('span', { class: 'meldung-text' },
    h('span', { class: 'meldung-kopf' },
      h('span', { class: 'meldung-titel' }, t.titel),
      h('span', { class: 'meldung-zeit' }, relativ(n.created_at, jetzt))),
    h('span', { class: 'meldung-inhalt' }, n.text),
    h('span', { class: 'meldung-fuss' }, punkt(t.farbe), maschinenName(n.machine), n.source === 'mirror' ? h('span', { class: 'meldung-spiegel' }, 'gespiegelt') : null),
  ),
  );
}

export function meldungsListe(u: Umgebung): Ansicht {
  const alle = navTextKnopf('Alle gelesen', () => u.stand.alsGelesen((u.stand.meldungen ?? []).map((n) => n.id)));
  const s = seite(u, { titel: 'Meldungen', gross: true, aktionen: [alle], klasse: 'liste-ansicht' });
  const koerper = h('div', { class: 'listen-koerper' });
  s.inhalt.append(koerper);
  const aktualisieren = (): void => {
    const stand = u.stand;
    const jetzt = Date.now();
    const oben = u.router.stapel.meldungen;
    const gewaehlt = oben.length > 1 ? decodeURIComponent(oben[1].replace('#/meldungen/', '')) : null;
    const liste = stand.meldungen;
    alle.disabled = !liste?.some((n) => stand.ungelesen(n));
    // Neu gebaut wird nur, wenn sich etwas Angezeigtes geaendert hat. Die
    // Tagesueberschrift haengt nur am Tagesanfang, die relative Zeit geht als
    // fertiger Text ein.
    const heute = new Date(jetzt).setHours(0, 0, 0, 0);
    const push = stand.push;
    const k = stand.kopplung;
    const signatur = JSON.stringify([
      verbindungsSignatur(stand, jetzt), stand.verbunden, gewaehlt, heute,
      push ? [push.erlaubnis, push.grund ?? ''] : null, k ? [k.gekoppelt, k.geraet ?? ''] : null,
      stand.maschinen.map((m) => [m.machine, m.erreichbar, m.seit ? uhr(m.seit) : '']),
      stand.quelle.client_build, !!stand.bootstrap, stand.quelle.name,
      liste?.map((n) => [n.id, n.type, n.text, n.machine, n.source, n.created_at, stand.ungelesen(n), relativ(n.created_at, jetzt)]) ?? null,
    ]);
    ersetzenBeiAenderung(koerper, signatur, () => {
      const teile: (HTMLElement | null)[] = [verbindungsZeile(stand, jetzt), statusKarte(u)];
      if (!liste) {
        teile.push(stand.verbunden ? h('div', { class: 'platzhalter-karten', 'aria-busy': 'true' }, h('div', { class: 'karte skelett' })) : null);
      } else if (!liste.length) {
        teile.push(leerzustand('Keine Meldungen', 'Hier landen fertige Worker, angehaltene Befehle und verlorene Sitzungen.'));
      } else {
        const tage = new Map<string, Notification[]>();
        for (const n of liste) {
          const t = tag(n.created_at, jetzt);
          tage.set(t, [...(tage.get(t) ?? []), n]);
        }
        for (const [t, ns] of tage) {
          teile.push(h('div', { class: 'gruppe' }, abschnitt(t),
            h('div', { class: 'karte meldungen-karte' }, ...ns.map((n) => meldungZeile(u, n, n.id === gewaehlt, jetzt)))));
        }
      }
      teile.push(h('p', { class: 'versions-zeile' }, `App ${stand.quelle.client_build}, API ${stand.bootstrap ? 'v1' : 'unbekannt'}${stand.quelle.name === 'attrappe' ? ', Attrappen-Daten' : ''}`));
      return teile;
    });
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

export function meldungAnsicht(u: Umgebung, id: string): Ansicht {
  const s = seite(u, { titel: 'Meldung', zurueck: 'Meldungen', klasse: 'detail-ansicht' });
  const koerper = h('div', { class: 'detail-koerper' });
  s.inhalt.append(koerper);
  const aktualisieren = (): void => {
    const stand = u.stand;
    const n = stand.meldungen?.find((x) => x.id === id);
    if (!n) { ersetzen(koerper, leerzustand('Meldung nicht gefunden', 'Das Journal hält nur die letzten Einträge.')); return; }
    if (stand.ungelesen(n)) queueMicrotask(() => stand.alsGelesen([n.id]));
    const t = TYP[n.type];
    const sitzung = stand.sitzungen?.find((x) => x.id === n.target_id);
    s.titelSetzen(t.titel);
    ersetzen(koerper,
      h('div', { class: 'meldung-buehne' },
        marke(t.titel, t.farbe as 'will'),
        h('h1', { class: 'meldung-gross' }, n.text),
        h('p', { class: 'meldung-wann' }, `${zeitmarke(n.created_at)}, ${maschinenName(n.machine)}${n.source === 'mirror' ? ', vom Mac gespiegelt' : ''}`),
      ),
      sitzung ? h('button', {
        class: 'karte weiter-zeile', type: 'button',
        onclick: () => u.router.oeffnen({ tab: 'sitzungen', ansicht: 'chat', id: sitzung.id }),
      }, h('span', { class: 'weiter-text' }, h('span', { class: 'weiter-titel' }, `Sitzung ${sitzung.name} öffnen`), h('span', { class: 'weiter-sub' }, 'wechselt zum Tab Sitzungen')), symbol('weiter', 16)) : null,
      h('p', { class: 'formular-notiz' }, 'Mitteilungen auf dem Sperrbildschirm enthalten keinen Chat, keinen Befehl und keinen Pfad. Die Einzelheiten lädt die App erst nach dem Öffnen.'),
    );
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

export function geraetAnsicht(u: Umgebung): Ansicht {
  const s = seite(u, { titel: 'Gerät', zurueck: 'Meldungen', klasse: 'detail-ansicht' });
  const koerper = h('div', { class: 'detail-koerper' });
  s.inhalt.append(koerper);
  const aktualisieren = (): void => {
    const k = u.stand.kopplung;
    ersetzen(koerper,
      h('dl', { class: 'karte eigenschaften' },
        h('div', null, h('dt', null, 'Name'), h('dd', null, k?.geraet ?? 'unbekannt')),
        h('div', null, h('dt', null, 'Gekoppelt'), h('dd', null, k?.seit ? `${zeitmarke(k.seit)}` : 'nein')),
        h('div', null, h('dt', null, 'Geräte-ID'), h('dd', { class: 'mono' }, k?.device_id ?? 'keine')),
      ),
      h('p', { class: 'formular-notiz' }, 'Der Schlüssel dieses Geräts liegt nur hier und lässt sich nicht exportieren. Widerrufen wird am Mac in den Werkbank-Einstellungen; danach lehnen Mac und peer jede Anfrage dieses Geräts ab.'),
      h('button', { class: 'knopf getoent', type: 'button', onclick: () => u.router.oeffnen({ tab: 'meldungen', ansicht: 'koppeln' }) }, 'Neu koppeln'),
    );
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}
