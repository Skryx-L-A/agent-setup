/**
 * KLEINE DOM-HILFEN. Text geht immer ueber `textContent`; der einzige Weg zu
 * `innerHTML` ist `markdown()`, und der laeuft durch den XSS-sicheren
 * Renderer aus `chat/markdown.ts` (Spezifikation 4.4: kein ungefiltertes HTML
 * aus Chats).
 */
import { markdownZuHtml } from '../../chat/markdown';

type Kind = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...kinder: Kind[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
      else if (k === 'class') el.className = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  anhaengen(el, kinder);
  return el;
}

export function anhaengen(el: Element, kinder: Kind[]): void {
  for (const k of kinder) {
    if (k === null || k === undefined || k === false) continue;
    el.append(typeof k === 'string' ? document.createTextNode(k) : k);
  }
}

export function leeren(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

export function ersetzen(el: Element, ...kinder: Kind[]): void {
  leeren(el);
  anhaengen(el, kinder);
}

const signaturen = new WeakMap<Element, string>();

/**
 * Wie `ersetzen`, aber nur, wenn sich die Signatur der angezeigten Daten
 * geaendert hat. Sonst bleiben die Knoten stehen: keine Arbeit im Takt und
 * kein Knopf, der unter dem Finger ausgetauscht wird.
 */
export function ersetzenBeiAenderung(el: Element, signatur: string, bauen: () => Kind[]): boolean {
  if (signaturen.get(el) === signatur) return false;
  signaturen.set(el, signatur);
  ersetzen(el, ...bauen());
  return true;
}

/** `textContent` nur setzen, wenn der Text anders ist (sonst entstuende ein neuer Textknoten). */
export function textSetzen(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function markdown(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'md';
  el.innerHTML = markdownZuHtml(text);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Die Symbole der Oberflaeche: nur funktionale Zeichen, in der Strichstaerke
 * der SF Symbols „regular“. Kein Symbol steht ohne Beschriftung oder
 * `aria-label` an seinem Knopf.
 */
const PFADE: Record<string, string> = {
  sitzungen: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16h0A1.5 1.5 0 0 1 4 14.5z M8 8h8 M8 11.5h5',
  agents: 'M7 8.5h10A2.5 2.5 0 0 1 19.5 11v6a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 17v-6A2.5 2.5 0 0 1 7 8.5z M12 8.5V5.5 M12 4h.01 M9.5 13.2v1.3 M14.5 13.2v1.3 M2.5 13v2.5 M21.5 13v2.5',
  meldungen: 'M12 3.5c-3.3 0-5.5 2.5-5.5 5.6v3.6L5 15.5v1h14v-1l-1.5-2.8V9.1c0-3.1-2.2-5.6-5.5-5.6z M9.8 19a2.3 2.3 0 0 0 4.4 0',
  zurueck: 'M15 4.5 7.5 12l7.5 7.5',
  weiter: 'M9 4.5 16.5 12 9 19.5',
  senden: 'M12 19V5.5 M6 11l6-6 6 6',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  mehr: 'M5.5 12h.01 M12 12h.01 M18.5 12h.01',
  hoch: 'M6 14.5 12 8.5l6 6',
  runter: 'M6 9.5l6 6 6-6',
  links: 'M14.5 6 8.5 12l6 6',
  rechts: 'M9.5 6l6 6-6 6',
  offline: 'M3 3l18 18 M8.5 16.5a5 5 0 0 1 7 0 M5.5 13.2a9.5 9.5 0 0 1 4.3-2.3 M14.3 10.9a9.5 9.5 0 0 1 4.2 2.3 M2.5 9.8a14 14 0 0 1 4.4-2.9 M11 5.6a14 14 0 0 1 10.5 4.2 M12 19.5h.01',
  haken: 'M5 12.5l4.5 4.5L19 7.5',
  kreuz: 'M6.5 6.5l11 11 M17.5 6.5l-11 11',
  tickets: 'M5 5.5h14v4a2.5 2.5 0 0 0 0 5v4H5v-4a2.5 2.5 0 0 0 0-5z M10 8.5v7',
  kanal: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-5 4z',
  schloss: 'M7 11V8a5 5 0 0 1 10 0v3 M5.5 11h13v9h-13z',
};

export function symbol(name: keyof typeof PFADE | string, groesse = 22): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(groesse));
  svg.setAttribute('height', String(groesse));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `symbol symbol-${name}`);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', PFADE[name] ?? '');
  svg.append(p);
  return svg;
}

/** Ein Knopf, der Fokus nicht vom Eingabefeld nimmt (die Tastatur bleibt offen). */
export function fokusHalten(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

let zaehler = 0;
export function neueId(praefix: string): string {
  zaehler += 1;
  return `${praefix}-${zaehler}`;
}
