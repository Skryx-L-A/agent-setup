/**
 * SITZUNGEN: nur Orchestratoren, gruppiert nach Maschine (Spezifikation 7.1).
 * Jede Karte nennt Name, Zustand, Harness und Modell, letzte Aktivitaet,
 * Worker, offene Entscheidungen und -- bei gespiegelten Staenden -- das
 * Datenalter.
 */
import type { SessionSummary } from '../../mobile-shared/vertrag';
import { ersetzenBeiAenderung, h } from './dom';
import type { Stand } from './stand';
import {
  abschnitt, hinweis, leerzustand, maschinenName, marke, navKnopf, punkt, seite,
  sitzungsFarbe, sitzungsMaschine, sitzungsText, type Ansicht, type Umgebung,
} from './teile';
import { alter, relativ, uhr } from './zeit';

/** Die Verbindungszeile ganz oben: offline, veraltet oder alte App-Version. */
export function verbindungsZeile(stand: Stand, jetzt = Date.now()): HTMLElement | null {
  if (stand.geraeteMeldung) {
    return hinweis('offline', stand.geraeteMeldung, { text: 'Erneut versuchen', beiKlick: () => { void stand.abgleichen(); } }, 'warnung');
  }
  if (!stand.verbunden) {
    const zuletzt = stand.abgeglichen ? `Angezeigt wird der Stand von ${uhr(stand.abgeglichen)}.` : 'Es gibt noch keinen gespeicherten Stand.';
    return hinweis('offline', `Keine Verbindung zu Mac und peer. ${zuletzt}`, { text: 'Erneut versuchen', beiKlick: () => { void stand.abgleichen(); } }, 'warnung');
  }
  if (stand.kompatibel && !stand.kompatibel.mutations_allowed) {
    return hinweis('offline', 'Der Server hat eine neuere Version. Bis zum Neuladen zeigt die App nur an.', { text: 'Neu laden', beiKlick: () => location.reload() }, 'warnung');
  }
  if (stand.veraltet(jetzt) && stand.abgeglichen) {
    return hinweis('offline', `Stand von ${uhr(stand.abgeglichen)}. Neue Daten kommen gerade nicht an.`, { text: 'Aktualisieren', beiKlick: () => { void stand.abgleichen(); } });
  }
  return null;
}

/** Alles, wovon `verbindungsZeile` abhaengt, als Text (fuer die Signatur der Listen). */
export function verbindungsSignatur(stand: Stand, jetzt = Date.now()): string {
  return [stand.verbunden, stand.geraeteMeldung ?? '', stand.abgeglichen ? uhr(stand.abgeglichen) : '', stand.kompatibel ? stand.kompatibel.mutations_allowed : '-', stand.veraltet(jetzt)].join('|');
}

function karte(u: Umgebung, s: SessionSummary, gewaehlt: boolean, veraltet: boolean): HTMLElement {
  const stand = u.stand;
  const farbe = sitzungsFarbe(s.state);
  const prompt = stand.prompts.get(s.id);
  const offen = s.open_approvals + (prompt ? 1 : 0);
  // Vertrag 1.2: Worker kommen nur als Zahl; `workers` bleibt beim Server leer.
  const worker = s.worker_count;
  const laufendeWorker = s.running_worker_count;
  const marken: HTMLElement[] = [];
  if (offen > 0) marken.push(marke(offen === 1 ? '1 Entscheidung' : `${offen} Entscheidungen`, 'will'));
  if (worker) {
    marken.push(marke(worker === 1
      ? `1 Worker${laufendeWorker ? ', läuft' : ''}`
      : `${worker} Worker${laufendeWorker ? `, ${laufendeWorker} ${laufendeWorker === 1 ? 'läuft' : 'laufen'}` : ''}`));
  }
  // v1.7: der Wartewunsch „Bescheid geben“ ist auch in der Liste sichtbar.
  if (typeof s.notify_until === 'number') marken.push(marke('Bescheid gewünscht', 'akzent'));
  if (s.source === 'mirror') marken.push(marke(`Spiegel, ${alter(s.data_age_ms)}`, 'fern'));
  const zeile = h('button', {
    class: `sitzung karte ${gewaehlt ? 'gewaehlt' : ''} ${veraltet ? 'veraltet' : ''} zustand-${farbe}`,
    type: 'button',
    'data-id': s.id,
    'aria-current': gewaehlt ? 'true' : null,
    onclick: () => u.router.oeffnen({ tab: 'sitzungen', ansicht: 'chat', id: s.id }),
  },
  h('div', { class: 'sitzung-kopf' },
    punkt(veraltet ? `${farbe} alt` : farbe),
    h('span', { class: 'sitzung-name' }, s.name),
    h('span', { class: 'sitzung-zeit' }, relativ(s.updated_at)),
  ),
  h('div', { class: 'sitzung-zeile' },
    h('span', { class: `sitzung-zustand text-${veraltet ? 'fern' : farbe}` }, veraltet ? `${sitzungsText(s.state)} (Stand alt)` : sitzungsText(s.state)),
  ),
  h('div', { class: 'sitzung-modell' },
    h('span', { class: 'harness' }, s.harness),
    h('span', { class: 'modell' }, s.model),
  ),
  marken.length ? h('div', { class: 'marken' }, ...marken) : null,
  );
  return zeile;
}

export function sitzungsListe(u: Umgebung): Ansicht {
  const plus = navKnopf('plus', 'Neue Sitzung', () => u.router.oeffnen({ tab: 'sitzungen', ansicht: 'neu' }));
  const s = seite(u, { titel: 'Sitzungen', gross: true, aktionen: [plus], klasse: 'liste-ansicht' });
  const koerper = h('div', { class: 'listen-koerper' });
  s.inhalt.append(koerper);

  const aktualisieren = (): void => {
    const stand = u.stand;
    const jetzt = Date.now();
    const oben = u.router.stapel.sitzungen;
    const gewaehlt = oben.length > 1 ? decodeURIComponent(oben[1].replace('#/sitzungen/', '')) : null;
    plus.disabled = !stand.darfSchreiben();
    const veraltet = stand.veraltet(jetzt);
    const maschinen = [...stand.maschinen.map((m) => m.machine)];
    for (const x of stand.sitzungen ?? []) if (!maschinen.includes(sitzungsMaschine(x))) maschinen.push(sitzungsMaschine(x));
    const gruppen = maschinen.map((mid) => ({
      mid,
      m: stand.maschine(mid),
      liste: (stand.sitzungen ?? []).filter((x) => sitzungsMaschine(x) === mid)
        .sort((a, b) => rang(a) - rang(b) || b.updated_at - a.updated_at),
    })).filter((g) => g.liste.length);
    // Neu gebaut wird nur, wenn sich etwas Angezeigtes geaendert hat; relative
    // Zeiten gehen als fertiger Text ein, so faellt auch ihr Wechsel auf.
    const signatur = JSON.stringify([
      verbindungsSignatur(stand, jetzt), stand.verbunden, stand.darfSchreiben(), stand.sitzungen === null, gewaehlt, veraltet,
      gruppen.map(({ mid, m, liste }) => [mid, m ? [m.erreichbar, m.seit ? uhr(m.seit) : ''] : null, liste.map((x) => [
        x.id, x.name, x.state, x.source, x.harness, x.model, x.open_approvals, !!stand.prompts.get(x.id), x.worker_count,
        x.running_worker_count, x.source === 'mirror' ? alter(x.data_age_ms) : '', relativ(x.updated_at, jetzt), x.notify_until ?? null,
      ])]),
    ]);
    ersetzenBeiAenderung(koerper, signatur, () => {
      const teile: (HTMLElement | null)[] = [verbindungsZeile(stand, jetzt)];
      if (stand.sitzungen === null) {
        teile.push(stand.verbunden
          ? h('div', { class: 'platzhalter-karten', 'aria-busy': 'true', 'aria-label': 'Sitzungen werden geladen' }, h('div', { class: 'karte skelett' }), h('div', { class: 'karte skelett' }), h('div', { class: 'karte skelett' }))
          : leerzustand('Noch nichts geladen', 'Sobald Mac oder peer antwortet, erscheinen hier die Orchestratoren.'));
        return teile;
      }
      if (stand.sitzungen.length === 0) {
        teile.push(leerzustand('Keine Sitzungen', 'Auf Mac und peer läuft gerade kein Orchestrator.', stand.darfSchreiben()
          ? { text: 'Neue Sitzung', beiKlick: () => u.router.oeffnen({ tab: 'sitzungen', ansicht: 'neu' }) }
          : undefined));
        return teile;
      }
      for (const { mid, m, liste } of gruppen) {
        const zusatz = m && !m.erreichbar
          ? h('span', { class: 'maschine-status aus' }, m.seit ? `nicht erreichbar seit ${uhr(m.seit)}` : 'nicht erreichbar')
          : null;
        teile.push(h('div', { class: 'gruppe', 'data-maschine': mid },
          abschnitt(maschinenName(mid), zusatz),
          m && !m.erreichbar && liste.some((x) => x.source === 'mirror')
            ? h('p', { class: 'gruppe-notiz' }, `Letzter Stand, gespiegelt vom Mac. Chat und Eingaben gehen nur direkt an ${maschinenName(mid)}.`)
            : null,
          h('div', { class: 'karten' }, ...liste.map((x) => karte(u, x, x.id === gewaehlt, veraltet || x.source === 'mirror'))),
        ));
      }
      return teile;
    });
  };
  aktualisieren();
  return { el: s.el, aktualisieren };
}

/** Wartende zuerst, dann laufende, dann der Rest. */
function rang(s: SessionSummary): number {
  return { attention: 0, running: 1, unreachable: 2, stopped: 3 }[s.state];
}
