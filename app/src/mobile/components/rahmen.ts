/**
 * DER RAHMEN: Tab-Leiste unten, je Tab eine Buehne mit dem Stapel seiner
 * Ansichten, iPhone-Stapel oder iPad-Zweispalte, Kopplungssperre.
 *
 * Jeder Tab behaelt seine Ansichten (samt Scrollstand), solange sie in seinem
 * Stapel liegen. Im Stapel-Layout ist nur die oberste sichtbar; die darunter
 * bleiben mit `visibility: hidden` erhalten, damit Zurueck an derselben
 * Stelle landet. Im geteilten Layout steht links immer die Wurzel des Tabs,
 * rechts die oberste Detailebene oder ein Platzhalter.
 *
 * Zurueck-Wischen: Im Safari-Tab gehoert die Geste dem System. Eine vom
 * Home-Bildschirm gestartete Web-App hat unter iOS keine eigene
 * Zurueck-Geste; nur dort legt der Rahmen einen schmalen Streifen an die
 * linke Kante jeder Detailebene, der die Geste nachbildet. Er ruft am Ende
 * `history.back()` auf -- dieselbe Navigation wie der Zurueck-Knopf.
 */
import { agentAnsicht, agentsListe, frageAnsicht, weltAnsicht } from './agents';
import { chatAnsicht } from './chat';
import { h, symbol, textSetzen } from './dom';
import { istStandalone, layoutVon } from './geraet';
import { kopplungsAnsicht } from './kopplung';
import { geraetAnsicht, meldungAnsicht, meldungsListe } from './meldungen';
import { neueSitzung } from './neue-sitzung';
import { routeVon, TABS, type Richtung, type Route, type Router, type Tab } from './router';
import { sitzungsListe } from './sitzungen';
import type { Stand } from './stand';
import { ebenenTitel, type Ansicht, type Umgebung } from './teile';
import { ticketAnsicht, ticketListe } from './tickets';

interface Eintrag { hash: string; ansicht: Ansicht }

const TAB_TEXT: Record<Tab, { titel: string; sym: string; leer: string }> = {
  sitzungen: { titel: 'Sitzungen', sym: 'sitzungen', leer: 'Wähle links eine Sitzung, um ihren Verlauf zu sehen.' },
  agents: { titel: 'Agents', sym: 'agents', leer: 'Wähle links einen Agenten, den Kanal einer Welt oder ihre Tickets.' },
  meldungen: { titel: 'Meldungen', sym: 'meldungen', leer: 'Wähle links eine Meldung.' },
};

function bauen(r: Route, u: Umgebung): Ansicht {
  switch (r.ansicht) {
    case 'liste':
      return r.tab === 'sitzungen' ? sitzungsListe(u) : r.tab === 'agents' ? agentsListe(u) : meldungsListe(u);
    case 'chat': return chatAnsicht(u, r.id);
    case 'neu': return neueSitzung(u);
    case 'welt': return weltAnsicht(u, r.welt);
    case 'agent': return agentAnsicht(u, r.welt, r.agent);
    case 'tickets': return ticketListe(u, r.welt);
    case 'ticket': return ticketAnsicht(u, r.welt, r.ticket);
    case 'frage': return frageAnsicht(u, r.welt, r.frage);
    case 'meldung': return meldungAnsicht(u, r.id);
    case 'geraet': return geraetAnsicht(u);
    case 'koppeln': return kopplungsAnsicht(u, true);
  }
}

function bewegungAus(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function nachAnimation(el: HTMLElement, klasse: string, fertig?: () => void): void {
  if (bewegungAus()) { fertig?.(); return; }
  el.classList.add(klasse);
  let erledigt = false;
  const ende = (): void => {
    if (erledigt) return;
    erledigt = true;
    el.classList.remove(klasse);
    fertig?.();
  };
  el.addEventListener('animationend', ende, { once: true });
  window.setTimeout(ende, 500);
}

export class Rahmen {
  readonly el: HTMLElement;
  private buehnen = {} as Record<Tab, HTMLElement>;
  private eintraege: Record<Tab, Eintrag[]> = { sitzungen: [], agents: [], meldungen: [] };
  private knoepfe = {} as Record<Tab, HTMLButtonElement>;
  private zahlen = {} as Record<Tab, HTMLSpanElement>;
  private tableiste: HTMLElement;
  private kopplung: Ansicht | null = null;
  private ohneAnimation = false;

  constructor(private stand: Stand, private router: Router) {
    this.tableiste = h('nav', { class: 'tableiste', 'aria-label': 'Bereiche' });
    for (const t of TABS) {
      const zahl = h('span', { class: 'tab-zahl', hidden: true });
      const knopf = h('button', { class: 'tab', type: 'button', 'data-tab': t, onclick: () => { void this.router.tabWechseln(t); } },
        h('span', { class: 'tab-symbol' }, symbol(TAB_TEXT[t].sym, 28)),
        h('span', { class: 'tab-text' }, TAB_TEXT[t].titel),
        zahl);
      this.knoepfe[t] = knopf;
      this.zahlen[t] = zahl;
      this.tableiste.append(knopf);
      this.buehnen[t] = h('main', { class: 'buehne', 'data-tab': t, 'aria-label': TAB_TEXT[t].titel },
        h('div', { class: 'platzhalter-detail' }, h('p', null, TAB_TEXT[t].leer)));
    }
    this.el = h('div', { class: 'rahmen', 'data-layout': layoutVon(window.innerWidth) },
      ...TABS.map((t) => this.buehnen[t]), this.tableiste);
    router.bei((r) => this.abgleichen(r));
    stand.bei(() => this.aktualisieren());
    new ResizeObserver(() => this.layoutPruefen()).observe(this.el);
  }

  private umgebung(tiefe: number): Umgebung {
    return { stand: this.stand, router: this.router, tiefe };
  }

  private layoutPruefen(): void {
    const neu = layoutVon(this.el.clientWidth || window.innerWidth);
    if (this.el.dataset.layout !== neu) {
      this.el.dataset.layout = neu;
      this.klassenSetzen(this.router.tab);
    }
  }

  /** Die Buehnen an den Stapel des Routers angleichen. */
  abgleichen(richtung: Richtung): void {
    const tab = this.router.tab;
    const soll = this.router.stapel[tab];
    const ist = this.eintraege[tab];
    let gleich = 0;
    while (gleich < soll.length && gleich < ist.length && soll[gleich] === ist[gleich].hash) gleich++;
    const weg = ist.splice(gleich);
    const buehne = this.buehnen[tab];
    const neu: Eintrag[] = [];
    for (let i = gleich; i < soll.length; i++) {
      const ansicht = bauen(routeVon(soll[i]), this.umgebung(i));
      ansicht.el.dataset.tiefe = String(i);
      if (i > 0 && istStandalone() && !ansicht.el.classList.contains('blatt-ansicht')) this.wischkante(ansicht.el);
      buehne.append(ansicht.el);
      const e = { hash: soll[i], ansicht };
      ist.push(e);
      neu.push(e);
    }
    const animieren = !this.ohneAnimation && (richtung === 'vor' || richtung === 'zurueck');
    this.ohneAnimation = false;
    for (const e of weg) {
      e.ansicht.entfernen?.();
      const blatt = e.ansicht.el.classList.contains('blatt-ansicht');
      if (animieren && richtung === 'zurueck' && (this.el.dataset.layout === 'stapel' || blatt || Number(e.ansicht.el.dataset.tiefe) > 0)) {
        e.ansicht.el.classList.add('geht');
        nachAnimation(e.ansicht.el, blatt ? 'blatt-aus' : 'ausfahren', () => e.ansicht.el.remove());
      } else {
        e.ansicht.el.remove();
      }
    }
    for (const t of TABS) {
      this.buehnen[t].hidden = t !== tab;
      this.knoepfe[t].classList.toggle('aktiv', t === tab);
      if (t === tab) this.knoepfe[t].setAttribute('aria-current', 'page');
      else this.knoepfe[t].removeAttribute('aria-current');
    }
    this.klassenSetzen(tab);
    const oben = ist[ist.length - 1];
    if (animieren && richtung === 'vor' && neu.length) {
      const blatt = oben.ansicht.el.classList.contains('blatt-ansicht');
      if (this.el.dataset.layout === 'stapel' || blatt || ist.length > 2) nachAnimation(oben.ansicht.el, blatt ? 'blatt-ein' : 'einfahren');
      const darunter = ist[ist.length - 2];
      if (darunter && !blatt && this.el.dataset.layout === 'stapel') nachAnimation(darunter.ansicht.el, 'wegschieben');
    } else if (animieren && richtung === 'zurueck' && this.el.dataset.layout === 'stapel' && !weg.some((e) => e.ansicht.el.classList.contains('blatt-ansicht'))) {
      nachAnimation(oben.ansicht.el, 'hervorkommen');
    }
    this.aktualisieren();
    oben.ansicht.gezeigt?.();
  }

  /** Sichtbarkeit und Rolle jeder Ansicht im Stapel des Tabs. */
  private klassenSetzen(tab: Tab): void {
    const ist = this.eintraege[tab];
    const obenIndex = ist.length - 1;
    const obenIstBlatt = ist[obenIndex]?.ansicht.el.classList.contains('blatt-ansicht') ?? false;
    ist.forEach((e, i) => {
      const el = e.ansicht.el;
      el.classList.toggle('wurzel', i === 0);
      el.classList.toggle('oben', i === obenIndex);
      el.classList.toggle('unten', i !== obenIndex);
      el.classList.toggle('unter-blatt', obenIstBlatt && i === obenIndex - 1);
      el.classList.toggle('detail-oben', i > 0 && (i === obenIndex || (obenIstBlatt && i === obenIndex - 1)));
      const verdeckt = i !== obenIndex && !(obenIstBlatt && i === obenIndex - 1) && !(this.el.dataset.layout === 'geteilt' && i === 0);
      el.inert = verdeckt || (obenIstBlatt && i !== obenIndex);
      el.setAttribute('aria-hidden', verdeckt ? 'true' : 'false');
    });
    const buehne = this.buehnen[tab];
    const detailTiefe = ist.filter((e, i) => i > 0 && !e.ansicht.el.classList.contains('blatt-ansicht')).length;
    buehne.dataset.detail = detailTiefe > 0 ? 'ja' : 'nein';
    buehne.dataset.blatt = obenIstBlatt ? 'ja' : 'nein';
    const top = ist[obenIndex]?.ansicht.el;
    const composerOben = !!top && top.dataset.composer === 'ja';
    this.el.dataset.composerOben = composerOben ? 'ja' : 'nein';
  }

  private zahlenSetzen(): void {
    const s = this.stand;
    const warten = (s.sitzungen ?? []).filter((x) => x.state === 'attention').length;
    const fragen = (s.agents?.welten ?? []).reduce((n, w) => n + w.fragen.filter((f) => f.stand === 'offen').length, 0);
    const ungelesen = (s.meldungen ?? []).filter((n) => s.ungelesen(n)).length;
    const werte: Record<Tab, number> = { sitzungen: warten, agents: fragen, meldungen: ungelesen };
    for (const t of TABS) {
      const z = this.zahlen[t];
      z.hidden = werte[t] === 0;
      textSetzen(z, String(werte[t]));
      const beschriftung = werte[t] ? `${TAB_TEXT[t].titel}, ${werte[t]} ${t === 'meldungen' ? 'ungelesen' : 'warten auf Dich'}` : TAB_TEXT[t].titel;
      if (this.knoepfe[t].getAttribute('aria-label') !== beschriftung) this.knoepfe[t].setAttribute('aria-label', beschriftung);
    }
  }

  aktualisieren(): void {
    const gekoppelt = this.stand.kopplung?.gekoppelt;
    if (this.stand.kopplung && !gekoppelt) {
      if (!this.kopplung) {
        this.kopplung = kopplungsAnsicht(this.umgebung(0), false);
        this.el.append(this.kopplung.el);
      }
      this.el.dataset.gesperrt = 'ja';
      return;
    }
    if (this.kopplung) {
      this.kopplung.el.remove();
      this.kopplung = null;
    }
    this.el.dataset.gesperrt = gekoppelt ? 'nein' : 'laedt';
    const liste = this.eintraege[this.router.tab];
    liste.forEach((e, i) => {
      e.ansicht.aktualisieren();
      // Der Zurueck-Knopf nennt die Ebene darunter, sobald ihr Name bekannt ist.
      const text = e.ansicht.el.querySelector('.nav-zurueck-text');
      if (i > 0 && text) {
        const t = ebenenTitel(routeVon(liste[i - 1].hash), this.stand);
        textSetzen(text, t);
        if (text.parentElement?.getAttribute('aria-label') !== `Zurück zu ${t}`) text.parentElement?.setAttribute('aria-label', `Zurück zu ${t}`);
      }
    });
    this.zahlenSetzen();
  }

  /**
   * Die nachgebildete Zurueck-Geste fuer die Home-Bildschirm-App. Pointer
   * Events auf einem eigenen Streifen mit `touch-action: none`, damit Safari
   * die Bewegung nicht als Scrollen uebernimmt; nur im Stapel-Layout aktiv.
   */
  private wischkante(ansicht: HTMLElement): void {
    const kante = h('div', { class: 'wischkante', 'aria-hidden': 'true' });
    ansicht.append(kante);
    let start: { x: number; t: number; id: number } | null = null;
    let dx = 0;
    const darunter = (): HTMLElement | null => {
      const liste = this.eintraege[this.router.tab];
      const i = liste.findIndex((e) => e.ansicht.el === ansicht);
      return i > 0 ? liste[i - 1].ansicht.el : null;
    };
    const setzen = (x: number): void => {
      const breite = ansicht.clientWidth || 1;
      ansicht.style.transform = `translateX(${x}px)`;
      const d = darunter();
      if (d) {
        d.style.transform = `translateX(${-0.3 * (breite - x)}px)`;
        d.style.visibility = 'visible';
      }
    };
    const zuruecksetzen = (): void => {
      ansicht.style.transform = '';
      ansicht.style.transition = '';
      const d = darunter();
      if (d) { d.style.transform = ''; d.style.visibility = ''; d.style.transition = ''; }
    };
    kante.addEventListener('pointerdown', (e) => {
      if (this.el.dataset.layout !== 'stapel' || !ansicht.classList.contains('oben')) return;
      start = { x: e.clientX, t: performance.now(), id: e.pointerId };
      dx = 0;
      try { kante.setPointerCapture(e.pointerId); } catch { /* ohne Capture folgt die Geste nur auf dem Streifen */ }
    });
    kante.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      dx = Math.max(0, e.clientX - start.x);
      setzen(dx);
    });
    const ende = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      const breite = ansicht.clientWidth || 1;
      const tempo = dx / Math.max(1, performance.now() - start.t);
      start = null;
      const zurueck = dx > breite * 0.35 || (dx > 40 && tempo > 0.5);
      const d = darunter();
      const uebergang = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)';
      ansicht.style.transition = uebergang;
      if (d) d.style.transition = uebergang;
      if (zurueck) {
        ansicht.style.transform = `translateX(${breite}px)`;
        if (d) d.style.transform = 'translateX(0)';
        window.setTimeout(() => {
          this.ohneAnimation = true;
          zuruecksetzen();
          ansicht.style.visibility = 'hidden';
          this.router.zurueck();
        }, 220);
      } else {
        ansicht.style.transform = 'translateX(0)';
        if (d) d.style.transform = 'translateX(-30%)';
        window.setTimeout(zuruecksetzen, 230);
      }
    };
    kante.addEventListener('pointerup', ende);
    kante.addEventListener('pointercancel', ende);
  }
}
