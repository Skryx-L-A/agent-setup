/**
 * GEMEINSAME BAUTEILE: Seitengeruest mit Navigationsleiste und grossem Titel,
 * Zustandspunkt, Marken und die Zustandsabbildung der Werkbank.
 */
import type { SessionState, SessionSummary } from '../../mobile-shared/vertrag';
import { h, symbol, textSetzen } from './dom';
import { routeVon, type Route, type Router } from './router';
import type { Stand } from './stand';

export interface Umgebung {
  stand: Stand;
  router: Router;
  /** Ebene der Ansicht im Stapel ihres Tabs (0 = Wurzel). */
  tiefe: number;
}

export interface Ansicht {
  el: HTMLElement;
  aktualisieren(): void;
  /** Die Ansicht ist oben angekommen (nach Navigation oder Tabwechsel). */
  gezeigt?(): void;
  entfernen?(): void;
}

/**
 * Die Sitzungsabbildung ist die der Werkbank (renderer.ts, `farbklasse`):
 * running -> laeuft, attention -> will, unreachable -> fern, sonst aus.
 */
export function sitzungsFarbe(s: SessionState): string {
  if (s === 'running') return 'laeuft';
  if (s === 'attention') return 'will';
  if (s === 'unreachable') return 'fern';
  return 'aus';
}

export function sitzungsText(s: SessionState): string {
  return { running: 'Läuft', attention: 'Wartet auf Dich', stopped: 'Beendet', unreachable: 'Nicht erreichbar' }[s];
}

/** Ticketstaende wie in der Weltenansicht (welten-view.ts, `standFarbe`). */
export function ticketFarbe(stand: string): string {
  if (stand === 'braucht dich' || stand === 'zur Abnahme' || stand === 'in Prüfung') return 'will';
  if (stand === 'läuft') return 'laeuft';
  if (stand === 'abgenommen') return 'fertig';
  if (stand === 'verworfen' || stand === 'unterbrochen') return 'aus';
  return 'ruhig';
}

export function punkt(farbe: string, beschriftung?: string): HTMLSpanElement {
  const p = h('span', { class: `punkt ${farbe}` });
  if (beschriftung) { p.setAttribute('role', 'img'); p.setAttribute('aria-label', beschriftung); }
  else p.setAttribute('aria-hidden', 'true');
  return p;
}

export function marke(text: string, art: 'neutral' | 'will' | 'laeuft' | 'aus' | 'fern' | 'fertig' | 'akzent' = 'neutral'): HTMLSpanElement {
  return h('span', { class: `marke ${art}` }, text);
}

export function harnessName(harness: string): string {
  return ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' } as Record<string, string>)[harness] ?? harness;
}

export function maschinenName(id: string): string {
  return id === 'mac' ? 'Mac' : id;
}

export function sitzungsMaschine(s: SessionSummary): string {
  return s.id.split(':')[0];
}

export interface SeitenOptionen {
  titel: string;
  /** Grosser Titel, der beim Scrollen in die Leiste wandert (oberste Ebene). */
  gross?: boolean;
  /** Beschriftung des Zurueck-Knopfs (der Titel der Ebene darunter). */
  zurueck?: string;
  aktionen?: HTMLElement[];
  /** Zusatzzeile unter dem kleinen Titel (z. B. Zustand der Sitzung). */
  unterzeile?: HTMLElement;
  klasse?: string;
}

export interface Seite {
  el: HTMLElement;
  nav: HTMLElement;
  inhalt: HTMLElement;
  titel: HTMLElement;
  grossTitel: HTMLElement | null;
  titelSetzen(t: string): void;
}

/** Der Titel einer Ebene, wie ihn der Zurueck-Knopf der naechsten Ebene nennt (iOS). */
export function ebenenTitel(r: Route, stand: Stand): string {
  switch (r.ansicht) {
    case 'liste': return { sitzungen: 'Sitzungen', agents: 'Agents', meldungen: 'Meldungen' }[r.tab];
    case 'chat': return stand.sitzungen?.find((s) => s.id === r.id)?.name ?? 'Sitzung';
    case 'welt': return stand.agents?.welten.find((w) => w.id === r.welt)?.name ?? 'Welt';
    case 'agent': return stand.agents?.welten.find((w) => w.id === r.welt)?.agenten.find((a) => a.id === r.agent)?.name ?? 'Agent';
    case 'tickets': return 'Tickets';
    case 'ticket': return r.ticket;
    case 'frage': return 'Frage';
    case 'meldung': return 'Meldung';
    case 'geraet': return 'Gerät';
    default: return 'Zurück';
  }
}

function zurueckText(u: Umgebung, vorgabe?: string): string {
  const vorher = u.router.stapel[u.router.tab][u.tiefe - 1];
  return vorher ? ebenenTitel(routeVon(vorher), u.stand) : vorgabe ?? 'Zurück';
}

export function seite(u: Umgebung, o: SeitenOptionen): Seite {
  const titel = h('div', { class: 'nav-titel', 'aria-hidden': o.gross ? 'true' : null }, o.titel);
  const mitte = h('div', { class: 'nav-mitte' }, titel, o.unterzeile ?? null);
  const zurueckBeschriftung = u.tiefe > 0 ? zurueckText(u, o.zurueck) : '';
  const zurueck = u.tiefe > 0
    ? h('button', { class: 'nav-zurueck', type: 'button', 'aria-label': `Zurück zu ${zurueckBeschriftung}`, onclick: () => u.router.zurueck() },
      symbol('zurueck', 24), h('span', { class: 'nav-zurueck-text' }, zurueckBeschriftung))
    : h('span', { class: 'nav-platz' });
  const nav = h('header', { class: 'navleiste' },
    h('div', { class: 'nav-links' }, zurueck),
    mitte,
    h('div', { class: 'nav-rechts' }, ...(o.aktionen ?? [])),
  );
  const grossTitel = o.gross ? h('h1', { class: 'gross-titel' }, o.titel) : null;
  const inhalt = h('div', { class: 'inhalt' }, grossTitel);
  const el = h('section', { class: `ansicht ${o.klasse ?? ''} ${o.gross ? 'mit-grossem-titel' : 'kleiner-titel'}`, 'data-tiefe': u.tiefe, 'aria-label': o.titel }, nav, inhalt);
  if (grossTitel) {
    // Der grosse Titel laeuft beim Scrollen in die Leiste ein (iOS).
    const beobachter = new IntersectionObserver(([e]) => {
      el.classList.toggle('titel-eingeklappt', !e.isIntersecting);
    }, { root: inhalt, threshold: 0, rootMargin: '-8px 0px 0px 0px' });
    beobachter.observe(grossTitel);
  } else {
    inhalt.addEventListener('scroll', () => el.classList.toggle('gescrollt', inhalt.scrollTop > 2), { passive: true });
  }
  return {
    el, nav, inhalt, titel, grossTitel,
    titelSetzen(t: string) {
      textSetzen(titel, t);
      if (grossTitel) textSetzen(grossTitel, t);
      if (el.getAttribute('aria-label') !== t) el.setAttribute('aria-label', t);
    },
  };
}

export function navKnopf(sym: string, beschriftung: string, beiKlick: () => void): HTMLButtonElement {
  return h('button', { class: 'nav-knopf', type: 'button', 'aria-label': beschriftung, title: beschriftung, onclick: beiKlick }, symbol(sym, 24));
}

export function navTextKnopf(text: string, beiKlick: () => void, primaer = false): HTMLButtonElement {
  return h('button', { class: `nav-text-knopf ${primaer ? 'primaer' : ''}`, type: 'button', onclick: beiKlick }, text);
}

/** Abschnittskopf ueber einer Kartengruppe. */
export function abschnitt(titel: string, zusatz?: HTMLElement | string | null): HTMLElement {
  return h('div', { class: 'abschnitt-kopf' }, h('h2', { class: 'abschnitt-titel' }, titel), zusatz ? h('span', { class: 'abschnitt-zusatz' }, zusatz) : null);
}

/** Eine dauerhafte, handlungsfaehige Hinweiszeile (statt eines verschwindenden Toasts). */
export function hinweis(sym: string, text: string, knopf?: { text: string; beiKlick: () => void }, art: 'neutral' | 'warnung' = 'neutral'): HTMLElement {
  return h('div', { class: `hinweis ${art}`, role: 'status' },
    symbol(sym, 20),
    h('span', { class: 'hinweis-text' }, text),
    knopf ? h('button', { class: 'hinweis-knopf', type: 'button', onclick: knopf.beiKlick }, knopf.text) : null,
  );
}

export function leerzustand(titel: string, text: string, knopf?: { text: string; beiKlick: () => void }): HTMLElement {
  return h('div', { class: 'leer' },
    h('h2', { class: 'leer-titel' }, titel),
    h('p', { class: 'leer-text' }, text),
    knopf ? h('button', { class: 'knopf getoent', type: 'button', onclick: knopf.beiKlick }, knopf.text) : null,
  );
}
