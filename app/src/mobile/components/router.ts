/**
 * NAVIGATION MIT DER HISTORY API (Spezifikation 7.1).
 *
 * Jeder Tab hat einen eigenen Stapel. Im Browser-Verlauf steht immer genau der
 * Stapel des sichtbaren Tabs: Wurzel, dann jede Detailebene als eigener
 * Eintrag. Zurueck (Knopf, Browser, Wischen) geht deshalb aus dem Detail zur
 * Liste und wechselt nie still den Tab. Ein Tabwechsel spult den Verlauf auf
 * die Wurzel zurueck und legt den gemerkten Stapel des neuen Tabs auf.
 *
 * Adressen sind Hash-Routen (`#/sitzungen/mac:werkbank`). Sie funktionieren
 * unter jeder Basisadresse und brauchen keinen Server-Rueckfall. Die
 * Deep-Links aus Spezifikation 6 oeffnet der Service Worker (Paket 8) in
 * dieser Form: `./#/sitzungen/<global-id>`, `./#/agents/-/frage/<id>`,
 * `./#/meldungen/<event-id>`; der Stapel darunter entsteht hier (`stapelFuer`).
 */

export type Tab = 'sitzungen' | 'agents' | 'meldungen';
export const TABS: readonly Tab[] = ['sitzungen', 'agents', 'meldungen'];

export type Route =
  | { tab: 'sitzungen'; ansicht: 'liste' }
  | { tab: 'sitzungen'; ansicht: 'chat'; id: string }
  | { tab: 'sitzungen'; ansicht: 'neu' }
  | { tab: 'agents'; ansicht: 'liste' }
  | { tab: 'agents'; ansicht: 'welt'; welt: string }
  | { tab: 'agents'; ansicht: 'agent'; welt: string; agent: string }
  | { tab: 'agents'; ansicht: 'tickets'; welt: string }
  | { tab: 'agents'; ansicht: 'ticket'; welt: string; ticket: string }
  | { tab: 'agents'; ansicht: 'frage'; welt: string; frage: string }
  | { tab: 'meldungen'; ansicht: 'liste' }
  | { tab: 'meldungen'; ansicht: 'meldung'; id: string }
  | { tab: 'meldungen'; ansicht: 'geraet' }
  | { tab: 'meldungen'; ansicht: 'koppeln' };

const enc = encodeURIComponent;

export function hashVon(r: Route): string {
  switch (r.ansicht) {
    case 'liste': return `#/${r.tab}`;
    case 'chat': return `#/sitzungen/${enc(r.id)}`;
    case 'neu': return '#/sitzungen/neu';
    case 'welt': return `#/agents/${enc(r.welt)}`;
    case 'agent': return `#/agents/${enc(r.welt)}/agent/${enc(r.agent)}`;
    case 'tickets': return `#/agents/${enc(r.welt)}/tickets`;
    case 'ticket': return `#/agents/${enc(r.welt)}/ticket/${enc(r.ticket)}`;
    case 'frage': return `#/agents/${enc(r.welt)}/frage/${enc(r.frage)}`;
    case 'meldung': return `#/meldungen/${enc(r.id)}`;
    case 'geraet': return '#/meldungen/geraet';
    case 'koppeln': return '#/meldungen/koppeln';
  }
}

export function routeVon(hash: string): Route {
  const teile = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((t) => {
    try { return decodeURIComponent(t); } catch { return t; }
  });
  const [tab, a, b, c] = teile;
  if (tab === 'agents') {
    if (!a) return { tab, ansicht: 'liste' };
    if (b === 'agent' && c) return { tab, ansicht: 'agent', welt: a, agent: c };
    if (b === 'tickets') return { tab, ansicht: 'tickets', welt: a };
    if (b === 'ticket' && c) return { tab, ansicht: 'ticket', welt: a, ticket: c };
    if (b === 'frage' && c) return { tab, ansicht: 'frage', welt: a, frage: c };
    return { tab, ansicht: 'welt', welt: a };
  }
  if (tab === 'meldungen') {
    if (!a) return { tab, ansicht: 'liste' };
    if (a === 'geraet') return { tab, ansicht: 'geraet' };
    if (a === 'koppeln') return { tab, ansicht: 'koppeln' };
    return { tab, ansicht: 'meldung', id: a };
  }
  if (tab === 'sitzungen' && a) {
    if (a === 'neu') return { tab, ansicht: 'neu' };
    return { tab, ansicht: 'chat', id: a };
  }
  return { tab: 'sitzungen', ansicht: 'liste' };
}

/** Der Stapel, den eine Route beim direkten Aufruf bekommt: jede Elternebene davor. */
export function stapelFuer(r: Route): string[] {
  const wurzel = `#/${r.tab}`;
  switch (r.ansicht) {
    case 'liste': return [wurzel];
    case 'frage':
      // `-` heisst: Welt unbekannt (Deep Link aus einer Push-Meldung); die Frage liegt direkt ueber der Liste.
      if (r.welt === '-') return [wurzel, hashVon(r)];
      return [wurzel, hashVon({ tab: 'agents', ansicht: 'welt', welt: r.welt }), hashVon(r)];
    case 'agent':
    case 'tickets':
      return [wurzel, hashVon({ tab: 'agents', ansicht: 'welt', welt: r.welt }), hashVon(r)];
    case 'ticket':
      return [wurzel, hashVon({ tab: 'agents', ansicht: 'welt', welt: r.welt }), hashVon({ tab: 'agents', ansicht: 'tickets', welt: r.welt }), hashVon(r)];
    case 'koppeln':
      return [wurzel, '#/meldungen/geraet', hashVon(r)];
    default:
      return [wurzel, hashVon(r)];
  }
}

interface Eintrag { tab: Tab; tiefe: number }

export type Richtung = 'vor' | 'zurueck' | 'tab' | 'ersetzt';

export class Router {
  tab: Tab = 'sitzungen';
  readonly stapel: Record<Tab, string[]> = { sitzungen: ['#/sitzungen'], agents: ['#/agents'], meldungen: ['#/meldungen'] };
  private wartend: (() => void) | null = null;
  private hoerer = new Set<(r: Richtung) => void>();

  constructor() {
    window.addEventListener('popstate', (e) => this.zurueckGesprungen(e.state as Eintrag | null));
  }

  bei(fn: (r: Richtung) => void): void {
    this.hoerer.add(fn);
  }

  private melden(r: Richtung): void {
    for (const h of this.hoerer) h(r);
  }

  get aktuell(): Route {
    const s = this.stapel[this.tab];
    return routeVon(s[s.length - 1]);
  }

  get tiefe(): number {
    return this.stapel[this.tab].length - 1;
  }

  /** Beim Start: die Adresse lesen und den Verlauf als Stapel aufbauen. */
  starten(): void {
    const ziel = routeVon(location.hash || '#/sitzungen');
    this.tab = ziel.tab;
    const st = stapelFuer(ziel);
    this.stapel[this.tab] = st;
    history.replaceState({ tab: this.tab, tiefe: 0 } satisfies Eintrag, '', st[0]);
    for (let i = 1; i < st.length; i++) history.pushState({ tab: this.tab, tiefe: i } satisfies Eintrag, '', st[i]);
    this.melden('ersetzt');
  }

  oeffnen(r: Route): void {
    const hash = hashVon(r);
    if (r.tab !== this.tab) {
      void this.tabWechseln(r.tab).then(() => this.oeffnen(r));
      return;
    }
    const s = this.stapel[this.tab];
    if (s[s.length - 1] === hash) return;
    s.push(hash);
    history.pushState({ tab: this.tab, tiefe: s.length - 1 } satisfies Eintrag, '', hash);
    this.melden('vor');
  }

  /** Die oberste Ebene ersetzen (z. B. „Neue Sitzung“ durch die neue Sitzung). */
  ersetzen(r: Route): void {
    const s = this.stapel[this.tab];
    const hash = hashVon(r);
    s[s.length - 1] = hash;
    history.replaceState({ tab: this.tab, tiefe: s.length - 1 } satisfies Eintrag, '', hash);
    this.melden('ersetzt');
  }

  zurueck(): void {
    if (this.tiefe > 0) history.back();
  }

  /**
   * Tab wechseln. Ist der Tab schon sichtbar, geht es zur Wurzel zurueck (wie
   * ein zweiter Tipp auf die Tab-Leiste in iOS).
   */
  async tabWechseln(ziel: Tab): Promise<void> {
    const alt = this.tab;
    const gemerkt = [...this.stapel[alt]];
    const t = this.tiefe;
    if (t > 0) await this.springen(-t);
    if (ziel === alt) {
      this.melden('zurueck');
      return;
    }
    // Der alte Tab behaelt seinen Stapel fuer die Rueckkehr (wie in iOS).
    this.stapel[alt] = gemerkt;
    this.tab = ziel;
    const s = this.stapel[ziel];
    history.replaceState({ tab: ziel, tiefe: 0 } satisfies Eintrag, '', s[0]);
    for (let i = 1; i < s.length; i++) history.pushState({ tab: ziel, tiefe: i } satisfies Eintrag, '', s[i]);
    this.melden('tab');
  }

  private springen(n: number): Promise<void> {
    return new Promise((fertig) => {
      this.wartend = fertig;
      history.go(n);
    });
  }

  private zurueckGesprungen(e: Eintrag | null): void {
    const s = this.stapel[this.tab];
    if (this.wartend) {
      const f = this.wartend;
      this.wartend = null;
      s.length = Math.max(1, (e?.tiefe ?? 0) + 1);
      f();
      return;
    }
    if (!e || e.tab !== this.tab) {
      // Ein fremder oder alter Eintrag (z. B. nach Neuladen): die Adresse gilt.
      const r = routeVon(location.hash);
      this.tab = r.tab;
      this.stapel[r.tab] = stapelFuer(r);
      history.replaceState({ tab: r.tab, tiefe: this.stapel[r.tab].length - 1 } satisfies Eintrag, '', location.hash);
      this.melden('ersetzt');
      return;
    }
    const vorher = s.length - 1;
    if (e.tiefe < vorher) {
      s.length = e.tiefe + 1;
      s[e.tiefe] = location.hash;
      this.melden('zurueck');
    } else {
      s[e.tiefe] = location.hash;
      s.length = e.tiefe + 1;
      this.melden('vor');
    }
  }
}
