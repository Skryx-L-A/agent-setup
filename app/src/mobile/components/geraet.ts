/**
 * GERAET, VIEWPORT UND THEMA.
 *
 * visualViewport (Spezifikation 7.3): Waehrend die Bildschirmtastatur offen
 * ist, schrumpft auf iOS nur der sichtbare Ausschnitt. Der Rahmen der App
 * folgt deshalb `visualViewport.height` und `offsetTop` ueber zwei
 * CSS-Variablen, und der Composer sitzt am unteren Rand dieses Rahmens --
 * ohne geratene Tastaturhoehe.
 *
 * Dynamic Type: Auf iOS liefert `font: -apple-system-body` die vom Menschen
 * eingestellte Textgroesse. Die App uebernimmt sie als Wurzelschrift, begrenzt
 * auf 200 Prozent (HIG, Accessibility). Auf Desktop-WebKit liefert derselbe
 * Stil 13 Punkt (macOS-Grundschrift); dort bleiben es 17 px wie auf dem iPhone
 * in der Vorgabegroesse.
 */
import type { ThemePayload } from '../../mobile-shared/vertrag';
import { figurenFarbenNeu } from '../../renderer/agentenfigur';

export function istStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
    || matchMedia('(display-mode: standalone)').matches;
}

export function istIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Vorschlag fuer den Geraetenamen bei der Kopplung. */
export function geraetName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  return 'Browser';
}

export function schriftAnpassen(): void {
  const root = document.documentElement;
  let groesse = 17;
  if (istIos()) {
    const probe = document.createElement('span');
    probe.style.font = '-apple-system-body';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.textContent = 'M';
    document.body.append(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    if (Number.isFinite(px) && px >= 14) groesse = Math.min(px, 34);
  }
  root.style.setProperty('--grundschrift', `${groesse}px`);
}

/** Tastatur gilt als offen, wenn der sichtbare Ausschnitt deutlich kleiner ist als das Fenster. */
const TASTATUR_SCHWELLE = 120;

export function viewportAnbinden(): () => void {
  const root = document.documentElement;
  const setzen = (): void => {
    const vv = window.visualViewport;
    const hoehe = vv ? vv.height : window.innerHeight;
    const oben = vv ? vv.offsetTop : 0;
    root.style.setProperty('--vv-hoehe', `${Math.round(hoehe)}px`);
    root.style.setProperty('--vv-oben', `${Math.round(oben)}px`);
    const offen = window.innerHeight - hoehe > TASTATUR_SCHWELLE;
    root.classList.toggle('tastatur-offen', offen);
    // Safari scrollt beim Fokus gern das Layout-Viewport; der Rahmen folgt
    // `offsetTop`, das Dokument selbst bleibt oben.
    if (window.scrollY !== 0 && !offen) window.scrollTo(0, 0);
  };
  setzen();
  const vv = window.visualViewport;
  vv?.addEventListener('resize', setzen);
  vv?.addEventListener('scroll', setzen);
  window.addEventListener('resize', setzen);
  return setzen;
}

/** Breite ab der Sitzungen, Agents und Meldungen zweispaltig werden (iPad; Split View faellt zurueck). */
export const ZWEISPALTIG_AB = 700;

export function layoutVon(breite: number): 'stapel' | 'geteilt' {
  return breite >= ZWEISPALTIG_AB ? 'geteilt' : 'stapel';
}

let letztesThema: ThemePayload | null = null;

/**
 * Die Werkbankfarben kommen aus `tokens.css` (erzeugt aus `main/thema.ts`,
 * derselbe Rollensatz wie in allen Fenstern). Hier wird nur entschieden,
 * welches der beiden Themen gilt, und der Systemakzent aus dem Bootstrap
 * uebernommen (Spezifikation 7.4). Folgt das Werkbankthema dem System, gilt
 * das Erscheinungsbild dieses Geraets, nicht das des Mac.
 */
export function themaAnwenden(payload: ThemePayload | null = letztesThema): void {
  letztesThema = payload;
  const root = document.documentElement;
  const gesetzt = typeof payload?.thema === 'string' ? payload.thema : 'system';
  const systemDunkel = matchMedia('(prefers-color-scheme: dark)').matches;
  const dunkel = gesetzt === 'dunkel' ? true : gesetzt === 'hell' ? false : systemDunkel;
  const thema = dunkel ? 'dunkel' : 'hell';
  const vorher = root.dataset.thema;
  root.dataset.thema = thema;
  // Der Akzent aus dem Bootstrap ist gegen das Thema des Mac kontrastangepasst;
  // er gilt nur, wenn beide Themen gleich sind. Sonst bleibt die Vorgabe aus tokens.css.
  const wirksam = typeof payload?.wirksam === 'string' ? payload.wirksam : null;
  if (payload && wirksam === thema && typeof payload.akzent === 'string') {
    root.style.setProperty('--akzent', payload.akzent);
    if (typeof payload.akzentText === 'string') root.style.setProperty('--akzent-text', payload.akzentText);
  } else {
    root.style.removeProperty('--akzent');
    root.style.removeProperty('--akzent-text');
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--fenster').trim() || meta.content;
  if (vorher !== thema) figurenFarbenNeu();
}

export function themaBeobachten(): void {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themaAnwenden());
}
