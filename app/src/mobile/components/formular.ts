/**
 * FORMULARBAUSTEINE FUER BLAETTER: Gruppe mit Titel und Fusszeile, Textfeld,
 * Auswahlliste, Schalterzeile, Datum und Zahl -- die Bausteine eines
 * iOS-Formulars, gebaut aus denselben Flaechen wie „Neue Sitzung“.
 *
 * Jede Eingabe meldet sich ueber `input` oder `change`; das Blatt, das die
 * Bausteine traegt, prueft danach seine Gueltigkeit neu (`blatt.ts`).
 * Eingabefelder haben mindestens 16 px, sonst zoomt Safari beim Fokus.
 */
import { fokusHalten, h, neueId, symbol } from './dom';

type Kind = Node | null | undefined | false;

/** Eine Formulargruppe: Titel darueber, Inhalt als Karte, Hilfe darunter. */
export function gruppe(titel: string | null, inhalt: Kind | Kind[], hilfe?: string | null, fuer?: string): HTMLElement {
  const kinder = Array.isArray(inhalt) ? inhalt : [inhalt];
  return h('div', { class: 'formular-gruppe' },
    titel ? (fuer ? h('label', { class: 'formular-titel', for: fuer }, titel) : h('span', { class: 'formular-titel' }, titel)) : null,
    ...kinder,
    hilfe ? h('p', { class: 'formular-hilfe' }, hilfe) : null,
  );
}

export interface TextFeld {
  el: HTMLElement;
  feld: HTMLInputElement | HTMLTextAreaElement;
  wert(): string;
}

export function textFeld(o: { beschriftung: string; platzhalter: string; mehrzeilig?: boolean; wert?: string }): TextFeld {
  const id = neueId('feld');
  const gemeinsam = { id, placeholder: o.platzhalter, 'aria-label': o.beschriftung, autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'true' };
  const feld = o.mehrzeilig
    ? h('textarea', { ...gemeinsam, class: 'feld mehrzeilig', rows: 3 })
    : h('input', { ...gemeinsam, class: 'feld', type: 'text', enterkeyhint: 'next' });
  if (o.wert) feld.value = o.wert;
  if (feld instanceof HTMLTextAreaElement) {
    // Mitwachsen bis sechs Zeilen, dann scrollt das Feld selbst.
    const wachsen = (): void => {
      feld.style.height = 'auto';
      feld.style.height = `${Math.min(feld.scrollHeight + 2, 180)}px`;
    };
    feld.addEventListener('input', wachsen);
    requestAnimationFrame(wachsen);
  }
  return { el: h('div', { class: 'karte feldkarte' }, feld), feld, wert: () => feld.value.trim() };
}

export interface Wahl {
  wert: string;
  text: string;
  zusatz?: string;
  /** Bild am Anfang der Zeile, z. B. die Agentenfigur. */
  bild?: Element | null;
  aus?: boolean;
  /** Ueberschrift der Gruppe; ein Wechsel beginnt eine neue Gruppe (z. B. „Agenten“, „Teams“). */
  gruppe?: string;
}

export interface WahlListe {
  el: HTMLElement;
  wert(): string | null;
}

/**
 * Eine Auswahlliste wie in den iOS-Einstellungen: eine Zeile je Wahl, genau
 * eine gilt, die Markierung steht am Ende der Zeile.
 */
export function wahlListe(beschriftung: string, optionen: Wahl[], gewaehlt: string | null, bei?: (wert: string) => void): WahlListe {
  const name = neueId('wahl');
  let wert = optionen.some((o) => o.wert === gewaehlt && !o.aus) ? gewaehlt : null;
  const liste = h('div', { class: 'auswahl-liste', role: 'radiogroup', 'aria-label': beschriftung });
  let gruppe: string | undefined;
  for (const o of optionen) {
    if (o.gruppe && o.gruppe !== gruppe) liste.append(h('div', { class: 'auswahl-gruppe' }, o.gruppe));
    gruppe = o.gruppe;
    const id = neueId('wahl');
    const eingabe = h('input', { type: 'radio', name, id, value: o.wert, checked: o.wert === wert, disabled: o.aus === true });
    eingabe.addEventListener('change', () => {
      if (!eingabe.checked) return;
      wert = o.wert;
      bei?.(o.wert);
    });
    liste.append(h('label', { class: 'auswahl wahl', for: id, 'data-wert': o.wert },
      o.bild ?? null,
      h('span', { class: 'auswahl-text' },
        h('span', { class: 'auswahl-name' }, o.text),
        o.zusatz ? h('span', { class: 'auswahl-zusatz' }, o.zusatz) : null),
      eingabe,
    ));
  }
  return { el: h('div', { class: 'karte' }, liste), wert: () => wert };
}

/**
 * Eine Zeile mit Schalter; eingeschaltet zeigt sie ihren Inhalt darunter.
 * Ohne Inhalt bleibt sie eine reine Ja/Nein-Zeile wie in den iOS-Einstellungen.
 * `bei` meldet jeden Wechsel, wenn die Zeile mehr als sich selbst umschaltet.
 */
export function schalterZeile(beschriftung: string, an: boolean, inhalt?: HTMLElement | null,
  bei?: (an: boolean) => void): { el: HTMLElement; an(): boolean } {
  const id = neueId('schalter');
  const eingabe = h('input', { class: 'schalter', type: 'checkbox', role: 'switch', id, checked: an });
  const unten = inhalt ? h('div', { class: 'schalter-inhalt', hidden: !an }, inhalt) : null;
  eingabe.addEventListener('change', () => {
    if (unten) unten.hidden = !eingabe.checked;
    bei?.(eingabe.checked);
  });
  return {
    el: h('div', { class: 'karte schalter-karte' },
      h('label', { class: 'schalter-zeile', for: id }, h('span', null, beschriftung), eingabe),
      unten,
    ),
    an: () => eingabe.checked,
  };
}

/** Datum und Uhrzeit mit dem Radpicker von iOS; der Wert geht als ISO-Zeit in UTC hinaus. */
export function zeitFeld(beschriftung: string, vorschlag: Date): { el: HTMLElement; iso(): string | null } {
  const lokal = (d: Date): string => {
    const z = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
  };
  const feld = h('input', { class: 'feld zeit', type: 'datetime-local', 'aria-label': beschriftung, min: lokal(new Date()), value: lokal(vorschlag) });
  return {
    el: feld,
    iso: () => {
      const t = feld.value ? new Date(feld.value) : null;
      return t && Number.isFinite(t.getTime()) ? t.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    },
  };
}

/** Eine ganze Zahl mit Minus und Plus daneben (iOS-Stepper). */
export function zahlFeld(beschriftung: string, start: number, min: number, max: number): { el: HTMLElement; wert(): number } {
  let wert = start;
  const anzeige = h('output', { class: 'stepper-wert', 'aria-live': 'polite' }, String(wert));
  const setzen = (n: number): void => {
    wert = Math.max(min, Math.min(max, n));
    anzeige.textContent = String(wert);
    weniger.disabled = wert <= min;
    mehr.disabled = wert >= max;
    anzeige.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const weniger = h('button', { class: 'stepper-knopf', type: 'button', 'aria-label': `${beschriftung}: eins weniger`, onclick: () => setzen(wert - 1) }, symbol('minus', 20));
  const mehr = h('button', { class: 'stepper-knopf', type: 'button', 'aria-label': `${beschriftung}: eins mehr`, onclick: () => setzen(wert + 1) }, symbol('plus', 20));
  fokusHalten(weniger);
  fokusHalten(mehr);
  weniger.disabled = wert <= min;
  mehr.disabled = wert >= max;
  return {
    el: h('div', { class: 'stepper', role: 'group', 'aria-label': beschriftung }, h('span', { class: 'stepper-text' }, beschriftung), weniger, anzeige, mehr),
    wert: () => wert,
  };
}
