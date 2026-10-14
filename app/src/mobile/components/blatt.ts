/**
 * AKTIONSBLATT, ABFRAGE UND FORMBLATT -- die modalen Formen aus iOS.
 *
 * Ein Aktionsblatt bietet Handlungen zu einem Ding an (unten, mit
 * „Abbrechen“). Eine Abfrage fragt eine Entscheidung ab, hoechstens mit einem
 * Textfeld fuer eine Begruendung. Ein Formblatt traegt ein ganzes Formular:
 * auf dem iPhone von unten, auf dem iPad mittig, mit „Abbrechen“ links und
 * der Handlung rechts, die erst gilt, wenn das Formular vollstaendig ist.
 * Alle fangen den Fokus, schliessen mit Escape und geben den Fokus an den
 * Ausloeser zurueck.
 */
import { h } from './dom';
import { wahlListe, type Wahl } from './formular';

export interface Aktion {
  titel: string;
  art?: 'normal' | 'zerstoerend';
  wert: string;
}

function ebene(klasse: string, beschriftung: string): { hinter: HTMLDivElement; schliessen: () => void } {
  const vorher = document.activeElement as HTMLElement | null;
  const hinter = h('div', { class: `ebene ${klasse}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': beschriftung });
  const ziel = document.querySelector('.rahmen') ?? document.body;
  ziel.append(hinter);
  requestAnimationFrame(() => hinter.classList.add('sichtbar'));
  const schliessen = (): void => {
    hinter.classList.remove('sichtbar');
    hinter.classList.add('geht');
    window.setTimeout(() => hinter.remove(), 220);
    vorher?.focus?.({ preventScroll: true });
  };
  hinter.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const fokusierbar = [...hinter.querySelectorAll<HTMLElement>('button, input, textarea, select')]
      .filter((x) => !x.hasAttribute('disabled') && !x.closest('[hidden]'));
    if (!fokusierbar.length) return;
    const erst = fokusierbar[0];
    const letzt = fokusierbar[fokusierbar.length - 1];
    if (e.shiftKey && document.activeElement === erst) { e.preventDefault(); letzt.focus(); }
    else if (!e.shiftKey && document.activeElement === letzt) { e.preventDefault(); erst.focus(); }
  });
  return { hinter, schliessen };
}

export function aktionsblatt(titel: string | null, aktionen: Aktion[]): Promise<string | null> {
  return new Promise((fertig) => {
    const { hinter, schliessen } = ebene('aktionsblatt', titel ?? 'Aktionen');
    const ende = (wert: string | null) => { schliessen(); fertig(wert); };
    const gruppe = h('div', { class: 'aktionsgruppe' },
      titel ? h('div', { class: 'aktionstitel' }, titel) : null,
      ...aktionen.map((a) => h('button', { class: `aktion ${a.art === 'zerstoerend' ? 'zerstoerend' : ''}`, type: 'button', onclick: () => ende(a.wert) }, a.titel)),
    );
    const abbrechen = h('button', { class: 'aktion abbrechen', type: 'button', onclick: () => ende(null) }, 'Abbrechen');
    const blatt = h('div', { class: 'aktionsblatt-inhalt' }, gruppe, abbrechen);
    hinter.append(blatt);
    hinter.addEventListener('click', (e) => { if (e.target === hinter) ende(null); });
    hinter.addEventListener('keydown', (e) => { if (e.key === 'Escape') ende(null); });
    (gruppe.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  });
}

export interface AbfrageOptionen {
  titel: string;
  text?: string;
  feld?: { platzhalter: string; pflicht?: boolean };
  ja: string;
  jaArt?: 'normal' | 'zerstoerend';
  nein?: string;
}

/** Liefert null bei Abbruch, sonst den Feldtext (oder '' ohne Feld). */
export function abfrage(o: AbfrageOptionen): Promise<string | null> {
  return new Promise((fertig) => {
    const { hinter, schliessen } = ebene('abfrage', o.titel);
    const ende = (wert: string | null) => { schliessen(); fertig(wert); };
    const feld = o.feld ? h('textarea', { class: 'abfrage-feld', rows: 2, placeholder: o.feld.platzhalter,'aria-label': o.feld.platzhalter }) : null;
    const ja = h('button', { class: `abfrage-knopf ja ${o.jaArt === 'zerstoerend' ? 'zerstoerend' : ''}`, type: 'button' }, o.ja);
    const pruefen = () => { if (feld && o.feld?.pflicht) ja.disabled = feld.value.trim() === ''; };
    feld?.addEventListener('input', pruefen);
    pruefen();
    ja.addEventListener('click', () => ende(feld ? feld.value.trim() : ''));
    const box = h('div', { class: 'abfrage-box' },
      h('div', { class: 'abfrage-kopf' },
        h('h2', { class: 'abfrage-titel' }, o.titel),
        o.text ? h('p', { class: 'abfrage-text' }, o.text) : null,
        feld,
      ),
      h('div', { class: 'abfrage-knoepfe' },
        h('button', { class: 'abfrage-knopf', type: 'button', onclick: () => ende(null) }, o.nein ?? 'Abbrechen'),
        ja,
      ),
    );
    hinter.append(box);
    hinter.addEventListener('keydown', (e) => { if (e.key === 'Escape') ende(null); });
    (feld ?? ja).focus({ preventScroll: true });
  });
}

export interface FormblattOptionen {
  titel: string;
  /** Beschriftung der Handlung oben rechts, z. B. „Senden“. */
  ja: string;
  jaArt?: 'normal' | 'zerstoerend';
  inhalt: (HTMLElement | null)[];
  /** Ist das Formular vollstaendig? Wird nach jeder Eingabe neu gefragt. */
  gueltig(): boolean;
  /** Fuehrt die Handlung aus und liefert eine Fehlermeldung oder null bei Erfolg. */
  ausfuehren(): Promise<string | null>;
  /** Volle Hoehe (grosse Stufe) statt so hoch wie der Inhalt. */
  gross?: boolean;
}

function blattGeruest(klasse: string, titel: string, links: HTMLElement, rechts: HTMLElement | null, koerper: HTMLElement) {
  const e = ebene(`formblatt ${klasse}`, titel);
  const box = h('div', { class: 'formblatt-box' },
    h('header', { class: 'formblatt-kopf' },
      h('div', { class: 'formblatt-links' }, links),
      h('h2', { class: 'formblatt-titel' }, titel),
      h('div', { class: 'formblatt-rechts' }, rechts)),
    h('div', { class: 'formblatt-inhalt' }, koerper),
  );
  e.hinter.append(box);
  return { ...e, box };
}

/** Liefert true, wenn die Handlung ausgefuehrt wurde, false bei Abbruch. */
export function formblatt(o: FormblattOptionen): Promise<boolean> {
  return new Promise((fertig) => {
    const abbrechen = h('button', { class: 'nav-text-knopf', type: 'button' }, 'Abbrechen');
    const ja = h('button', { class: `nav-text-knopf primaer ${o.jaArt === 'zerstoerend' ? 'zerstoerend' : ''}`, type: 'button' }, o.ja);
    const fehler = h('p', { class: 'formular-fehler', role: 'alert', hidden: true });
    const form = h('form', { class: 'formular', novalidate: true }, ...o.inhalt, fehler);
    const { hinter, schliessen, box } = blattGeruest(o.gross ? 'gross' : '', o.titel, abbrechen, ja, form);
    let laeuft = false;
    const pruefen = (): void => { ja.disabled = laeuft || !o.gueltig(); };
    const ende = (wert: boolean): void => { schliessen(); fertig(wert); };
    const absenden = async (): Promise<void> => {
      pruefen();
      if (ja.disabled) return;
      laeuft = true;
      pruefen();
      box.classList.add('sendet');
      fehler.hidden = true;
      const f = await o.ausfuehren();
      laeuft = false;
      box.classList.remove('sendet');
      if (f === null) { ende(true); return; }
      fehler.hidden = false;
      fehler.textContent = f;
      fehler.scrollIntoView({ block: 'nearest' });
      pruefen();
    };
    form.addEventListener('input', pruefen);
    form.addEventListener('change', pruefen);
    form.addEventListener('submit', (e) => { e.preventDefault(); void absenden(); });
    ja.addEventListener('click', () => { void absenden(); });
    abbrechen.addEventListener('click', () => ende(false));
    hinter.addEventListener('keydown', (e) => { if (e.key === 'Escape') ende(false); });
    pruefen();
    const erstes = form.querySelector<HTMLElement>('input[type="text"], textarea');
    (erstes ?? abbrechen).focus({ preventScroll: true });
  });
}

/**
 * Eine Auswahl als Blatt: ein Tipp waehlt und schliesst, auch auf die schon
 * gewaehlte Zeile. Pfeiltasten bewegen nur die Markierung. Null bei Abbruch.
 */
export function auswahlBlatt(titel: string, optionen: Wahl[], gewaehlt: string | null, hilfe?: string): Promise<string | null> {
  return new Promise((fertig) => {
    const abbrechen = h('button', { class: 'nav-text-knopf', type: 'button' }, 'Abbrechen');
    const liste = wahlListe(titel, optionen, gewaehlt);
    const koerper = h('div', { class: 'formular' }, liste.el, hilfe ? h('p', { class: 'formular-hilfe' }, hilfe) : null);
    const { hinter, schliessen } = blattGeruest('auswahl-blatt', titel, abbrechen, null, koerper);
    let erledigt = false;
    const ende = (wert: string | null): void => {
      if (erledigt) return;
      erledigt = true;
      schliessen();
      fertig(wert);
    };
    // Ein Tipp auf die Zeile klickt ueber das Label auch das Optionsfeld; nur dieser Klick zaehlt.
    liste.el.addEventListener('click', (e) => {
      const feld = e.target;
      if (feld instanceof HTMLInputElement && feld.type === 'radio' && !feld.disabled) window.setTimeout(() => ende(feld.value), 120);
    });
    abbrechen.addEventListener('click', () => ende(null));
    hinter.addEventListener('keydown', (e) => { if (e.key === 'Escape') ende(null); });
    (koerper.querySelector<HTMLInputElement>('input:checked') ?? abbrechen).focus({ preventScroll: true });
  });
}
