/**
 * DER COMPOSER (Spezifikation 7.1 und 7.3).
 *
 * Eine normale mehrzeilige Textarea mit der iOS-Tastatur, keine
 * Terminaltastatur. Zeilenumbruch und Senden sind getrennt: die
 * Eingabetaste der Bildschirmtastatur bricht um, gesendet wird mit dem
 * Knopf (oder Befehl-Eingabe an einer Hardwaretastatur). Nicht zugestellter
 * Text bleibt stehen und als Entwurf gespeichert. Der Sendeknopf nimmt der
 * Textarea den Fokus nicht, damit die Tastatur offen bleibt.
 *
 * Die Sondertasten stehen in einer eigenen, zurueckhaltenden Leiste ueber dem
 * Feld und bieten nur die Whitelist des Servers an.
 */
import type { AllowedSpecialKey, ApiError } from '../../mobile-shared/vertrag';
import { fokusHalten, h, neueId, symbol } from './dom';
import type { Ergebnis } from './stand';

export interface ComposerOptionen {
  platzhalter: string;
  entwurf: string;
  senden(text: string): Promise<Ergebnis<unknown>>;
  taste?(key: AllowedSpecialKey): Promise<Ergebnis<unknown>>;
}

const TASTEN_HAUPT: { key: AllowedSpecialKey; text: string; hilfe: string }[] = [
  { key: 'Escape', text: 'Esc', hilfe: 'Escape senden (unterbricht den Harness)' },
  { key: 'C-c', text: 'Strg-C', hilfe: 'Strg-C senden' },
];

const TASTEN_MEHR: { key: AllowedSpecialKey; text?: string; sym?: string; hilfe: string }[] = [
  { key: 'Up', sym: 'hoch', hilfe: 'Pfeil nach oben' },
  { key: 'Down', sym: 'runter', hilfe: 'Pfeil nach unten' },
  { key: 'Left', sym: 'links', hilfe: 'Pfeil nach links' },
  { key: 'Right', sym: 'rechts', hilfe: 'Pfeil nach rechts' },
  { key: 'Tab', text: 'Tab', hilfe: 'Tab senden' },
  { key: 'Space', text: 'Leer', hilfe: 'Leertaste senden' },
  { key: 'Enter', text: 'Enter', hilfe: 'Eingabetaste senden' },
];

function entwurfLesen(k: string): string {
  try { return localStorage.getItem(`awb-mobil-entwurf:${k}`) ?? ''; } catch { return ''; }
}
function entwurfSchreiben(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(`awb-mobil-entwurf:${k}`, v);
    else localStorage.removeItem(`awb-mobil-entwurf:${k}`);
  } catch { /* Entwurf ist Komfort */ }
}

export class Composer {
  readonly el: HTMLElement;
  readonly feld: HTMLTextAreaElement;
  private knopf: HTMLButtonElement;
  private fehlerZeile: HTMLElement;
  private status: HTMLElement;
  private gesperrt: string | null = null;
  private sendet = false;
  private tastenLeiste: HTMLElement | null = null;
  private statusUhr: number | undefined;

  constructor(private o: ComposerOptionen) {
    const id = neueId('composer');
    this.feld = h('textarea', {
      class: 'composer-feld', id, rows: 1, placeholder: o.platzhalter, 'aria-label': o.platzhalter,
      autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'true', enterkeyhint: 'enter',
    });
    this.feld.value = entwurfLesen(o.entwurf);
    this.knopf = h('button', { class: 'composer-senden', type: 'button', 'aria-label': 'Senden', title: 'Senden' }, symbol('senden', 20));
    fokusHalten(this.knopf);
    this.knopf.addEventListener('click', () => { void this.absenden(); });
    this.feld.addEventListener('input', () => { this.wachsen(); this.pruefen(); entwurfSchreiben(o.entwurf, this.feld.value); });
    this.feld.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.absenden(); }
    });
    this.fehlerZeile = h('div', { class: 'composer-fehler', role: 'alert', hidden: true });
    this.status = h('span', { class: 'tasten-status', 'aria-live': 'polite' });
    if (o.taste) this.tastenLeiste = this.tastenBauen();
    this.el = h('div', { class: 'composer' },
      this.tastenLeiste,
      this.fehlerZeile,
      h('div', { class: 'composer-zeile' }, this.feld, this.knopf),
    );
    this.pruefen();
    requestAnimationFrame(() => this.wachsen());
  }

  private tastenBauen(): HTMLElement {
    const mehr = h('div', { class: 'tasten-mehr', hidden: true, id: neueId('tasten') });
    const umschalter = h('button', { class: 'taste umschalter', type: 'button', 'aria-expanded': 'false', 'aria-controls': mehr.id }, 'Tasten');
    umschalter.addEventListener('click', () => {
      const auf = mehr.hidden;
      mehr.hidden = !auf;
      umschalter.setAttribute('aria-expanded', String(auf));
      umschalter.classList.toggle('offen', auf);
    });
    fokusHalten(umschalter);
    const knopf = (t: { key: AllowedSpecialKey; text?: string; sym?: string; hilfe: string }): HTMLButtonElement => {
      const b = h('button', { class: `taste ${t.sym ? 'symboltaste' : ''}`, type: 'button', 'aria-label': t.hilfe, title: t.hilfe, 'data-taste': t.key },
        t.sym ? symbol(t.sym, 18) : t.text ?? t.key);
      fokusHalten(b);
      b.addEventListener('click', () => { void this.tasteSenden(t.key, t.text ?? t.hilfe); });
      return b;
    };
    for (const t of TASTEN_MEHR) mehr.append(knopf(t));
    return h('div', { class: 'tasten', role: 'toolbar', 'aria-label': 'Sondertasten' },
      h('div', { class: 'tasten-haupt' }, ...TASTEN_HAUPT.map(knopf), umschalter, this.status),
      mehr,
    );
  }

  private async tasteSenden(key: AllowedSpecialKey, text: string): Promise<void> {
    if (!this.o.taste || this.gesperrt) return;
    const r = await this.o.taste(key);
    if (r.ok) {
      this.status.textContent = `${text} gesendet`;
      window.clearTimeout(this.statusUhr);
      this.statusUhr = window.setTimeout(() => { this.status.textContent = ''; }, 1800);
      this.fehler(null);
    } else {
      this.fehler(r.fehler);
    }
  }

  private wachsen(): void {
    this.feld.style.height = 'auto';
    this.feld.style.height = `${Math.min(this.feld.scrollHeight, this.maxHoehe())}px`;
  }

  private maxHoehe(): number {
    const zeile = parseFloat(getComputedStyle(this.feld).lineHeight) || 22;
    return Math.round(zeile * 6 + 16);
  }

  private pruefen(): void {
    this.knopf.disabled = this.sendet || this.gesperrt !== null || this.feld.value.trim() === '';
  }

  private fehler(f: ApiError | null): void {
    this.fehlerZeile.hidden = f === null;
    this.fehlerZeile.textContent = f ? `Nicht zugestellt: ${f.message}` : '';
  }

  async absenden(): Promise<void> {
    const text = this.feld.value.trim();
    if (!text || this.sendet || this.gesperrt) return;
    this.sendet = true;
    this.el.classList.add('sendet');
    this.pruefen();
    const r = await this.o.senden(text);
    this.sendet = false;
    this.el.classList.remove('sendet');
    if (r.ok) {
      if (this.feld.value.trim() === text) this.feld.value = '';
      entwurfSchreiben(this.o.entwurf, this.feld.value);
      this.fehler(null);
      this.wachsen();
    } else {
      this.fehler(r.fehler);
    }
    this.pruefen();
  }

  /** Gesperrt heisst: Feld bleibt lesbar (Entwurf!), Senden und Tasten ruhen. */
  sperren(grund: string | null): void {
    if (grund === this.gesperrt) return;
    this.gesperrt = grund;
    this.el.classList.toggle('gesperrt', grund !== null);
    this.el.querySelectorAll<HTMLButtonElement>('.taste').forEach((b) => { if (!b.classList.contains('umschalter')) b.disabled = grund !== null; });
    this.feld.placeholder = grund ?? this.o.platzhalter;
    this.pruefen();
  }

  /** Der Platzhalter nennt z. B. den Empfaenger; eine Sperre hat Vorrang. */
  platzhalterSetzen(text: string): void {
    this.o.platzhalter = text;
    this.feld.setAttribute('aria-label', text);
    if (!this.gesperrt) this.feld.placeholder = text;
  }

  fokus(): void {
    this.feld.focus({ preventScroll: true });
  }
}
