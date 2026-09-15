// PFADE IM CHAT, ANKLICKBAR (Auftrag chatdatei, 05.09.2026; Wortlaut des Nutzers:
// „Ich will eine datei die im chat mit einem agent auftaucht im chat anklicken
// koennen und diese wird dann geoeffnet.").
//
// ZWEI HAELFTEN, BEIDE REIN. `pfadKandidaten()` liest aus dem ROHEN Text einer
// Nachricht heraus, was wie ein Pfad aussieht -- absolut, mit Tilde, relativ,
// mit Zeilenangabe, in Backticks oder nackt im Satz. Ob es den Pfad wirklich
// gibt, weiss nur der Hauptprozess (main/chatpfade.ts, `fs.stat` gegen das
// Arbeitsverzeichnis der Sitzung und gegen `~`); die Antwort kommt als Liste
// von Treffern zurueck, und `pfadeMarkieren()` macht daraus anklickbare
// Stellen im BEREITS GEZEICHNETEN DOM.
//
// WARUM NACH DEM ZEICHNEN UND NICHT IM MARKDOWN-RENDERER. chat/markdown.ts
// escaped erst und setzt dann Muster ein -- ein Pfad, der dort als Zeichenkette
// in das HTML geriete, waere die eine Stelle, an der ein Agent Markup
// einschleusen koennte, und zwar genau in dem Feld, das alice anklickt
// (siehe `freigabenmarkup`, 05.09.). Hier wird deshalb nie eine Zeichenkette
// gebaut: die Textknoten werden zerschnitten, und der Pfad landet als
// `textContent` in einem `<span>`, der Zielpfad als `data-pfad`-Attribut. Ein
// `<img onerror>` im Dateinamen bleibt damit Wortlaut, weil er nie durch
// `innerHTML` laeuft.
//
// NICHT ANGEFASST wird ein Codeblock (`<pre>`): darin stehen Befehle, und ein
// Pfad mitten in einem Befehl ist kein Link, sondern ein Argument. Inline-Code
// (`<code>` in Backticks) dagegen ist der haeufigste Ort fuer einen Pfad und
// wird mitgenommen.

/** Ein Pfad, den der Hauptprozess wirklich gefunden hat. */
export interface PfadTreffer {
  /** Der Wortlaut im Text, mit dem er wiedergefunden wird -- samt Zeilenangabe. */
  kandidat: string;
  /** Der aufgeloeste, absolute Pfad ohne Zeilenangabe. */
  abs: string;
  art: 'datei' | 'ordner';
  /** 0 heisst: keine Zeilenangabe. */
  zeile: number;
  spalte: number;
}

/** Was eine Ansicht braucht, um Pfade pruefen und oeffnen zu lassen -- die Bruecke bleibt draussen. */
export interface PfadHaken {
  pruefen(kandidaten: string[]): Promise<PfadTreffer[]>;
  oeffnen(treffer: PfadTreffer): void;
}

/** Mehr Kandidaten je Nachricht werden nicht geprueft -- ein `stat` je Kandidat, und eine Nachricht mit tausend Pfaden ist ein Protokolldump, kein Gespraech. */
export const HOECHSTZAHL_KANDIDATEN = 200;

/** Ein Namensteil: Buchstaben, Ziffern und die Zeichen, die in Dateinamen ueblich sind -- auch ein fuehrender Punkt (`.pi-workers`, `.env`). Kein Leerzeichen, keine Anfuehrungszeichen, keine Klammern, keine spitzen Klammern. */
const TEIL = '[\\p{L}\\p{N}_.@+%=\\-]+';

/**
 * DAS MUSTER, in dieser Reihenfolge:
 *   1. absolut oder mit Tilde: `/a/b`, `~/a/b`, `~` allein zaehlt nicht;
 *   2. relativ mit mindestens einem Schraegstrich: `shell/tests/run-all.sh`,
 *      `./x`, `../x`. Der letzte Namensteil steht als `(?:TEIL)?` da, NICHT als
 *      `TEIL?` -- letzteres haengt das Fragezeichen an das `+` von TEIL und
 *      macht daraus ein LAZY `+?`, das genau ein Zeichen nimmt: `./bin/bauen`
 *      wurde damit zu `./bin/b` und war deshalb nie anklickbar (gemessen
 *      06.09.2026 beim Uebertragen nach Swift, mac/Sources/WerkbankProtokoll/
 *      Pfadlinks.swift, wo derselbe Fehler entstanden waere);
 *   3. ein nackter Dateiname mit Endung: `renderer.ts`, `README.md` -- damit
 *      `renderer.ts:1689` gefunden wird. Dass `example.com` oder `Node.js`
 *      auch hineinfallen, ist gewollt billig: der Hauptprozess sieht nach,
 *      und was es nicht gibt, bleibt Text.
 * Dahinter optional `:Zeile` oder `:Zeile:Spalte`.
 *
 * Der Lookbehind haelt eine URL draussen: in `https://a.de/x` steht vor dem
 * ersten `/` ein Doppelpunkt, vor dem zweiten ein Schraegstrich, und `a.de/x`
 * beginnt hinter einem Schraegstrich. Ein npm-Name wie `@scope/paket` faellt
 * dagegen SEHR WOHL herein (gemessen 06.09.2026; hier stand bis dahin das
 * Gegenteil): das `@` steht am Anfang und ist selbst ein erlaubtes Zeichen.
 * Das ist dieselbe gewollte Billigkeit wie bei Punkt 3 -- der Hauptprozess
 * sieht nach, und was es nicht gibt, bleibt Text.
 */
const MUSTER = new RegExp(
  '(?<![\\p{L}\\p{N}_/.~:@\\-])('
  + `(?:~?/(?:${TEIL}/)*${TEIL}/?)`
  + `|(?:\\.{1,2}/(?:${TEIL}/)*(?:${TEIL})?/?)`
  + `|(?:${TEIL}(?:/${TEIL})+/?)`
  + '|(?:[\\p{L}\\p{N}_.@+%=\\-]+\\.[A-Za-z0-9]{1,8})'
  + ')(?::(\\d{1,7})(?::(\\d{1,5}))?)?',
  'gu',
);

/** Satzzeichen, die am Ende eines Kandidaten noch zum Satz gehoeren, nicht zum Pfad. */
const SATZENDE = /[.,;:!?'"`)\]}>]+$/u;

/** Ein Kandidat, zerlegt: der Pfadteil und die optionale Zeilenangabe. */
export interface PfadKandidat {
  wortlaut: string;
  pfad: string;
  zeile: number;
  spalte: number;
}

/** Zerlegt einen Wortlaut wie `a/b.ts:12:4` in Pfad, Zeile und Spalte. */
export function kandidatZerlegen(wortlaut: string): PfadKandidat {
  const m = /^(.*?)(?::(\d{1,7})(?::(\d{1,5}))?)?$/u.exec(wortlaut);
  if (!m) return { wortlaut, pfad: wortlaut, zeile: 0, spalte: 0 };
  return { wortlaut, pfad: m[1], zeile: m[2] ? Number(m[2]) : 0, spalte: m[3] ? Number(m[3]) : 0 };
}

/**
 * Alle Stellen in `text`, die wie ein Pfad aussehen, in der Reihenfolge ihres
 * Auftretens -- jede genau einmal, hoechstens `HOECHSTZAHL_KANDIDATEN`.
 * Rein: kein Dateisystem, kein DOM.
 */
export function pfadKandidaten(text: string): string[] {
  const raus: string[] = [];
  const gesehen = new Set<string>();
  for (const stelle of stellen(text)) {
    if (gesehen.has(stelle.wortlaut)) continue;
    gesehen.add(stelle.wortlaut);
    raus.push(stelle.wortlaut);
    if (raus.length >= HOECHSTZAHL_KANDIDATEN) break;
  }
  return raus;
}

interface Stelle { von: number; bis: number; wortlaut: string }

/** Die Fundstellen mit ihrer Lage im Text -- fuer `pfadKandidaten` und fuer das Zerschneiden der Textknoten. */
function stellen(text: string): Stelle[] {
  const raus: Stelle[] = [];
  MUSTER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MUSTER.exec(text)) !== null) {
    let pfad = m[1];
    const zeile = m[2] ?? '';
    const spalte = m[3] ?? '';
    // Ein Punkt am Satzende gehoert zum Satz. `renderer.ts.` -> `renderer.ts`.
    // Nur wenn keine Zeilenangabe folgt: bei `x.ts:12.` steht der Punkt hinter
    // der Zahl und wird vom Muster ohnehin nicht mitgenommen.
    if (!zeile) pfad = pfad.replace(SATZENDE, '');
    if (!pfad || pfad === '/' || pfad === '~/' || pfad === './' || pfad === '../') continue;
    // Ein nackter Name mit Endung, der wie eine Versionsnummer aussieht (`v2.0`,
    // `1.5`), ist kein Pfad.
    if (!pfad.includes('/') && /^\d/.test(pfad) && /^[\d.]+$/.test(pfad)) continue;
    const wortlaut = pfad + (zeile ? `:${zeile}` : '') + (zeile && spalte ? `:${spalte}` : '');
    raus.push({ von: m.index, bis: m.index + wortlaut.length, wortlaut });
  }
  return raus;
}

/** Die Klasse der anklickbaren Stelle -- werkbank.css kennt sie, uiState() zaehlt sie. */
export const PFAD_KLASSE = 'chat-pfad';

/**
 * Macht aus jeder Fundstelle eines Treffers in den Textknoten unter `wurzel`
 * ein `<span class="chat-pfad">`. Gibt zurueck, wieviele Stellen entstanden
 * sind. Codebloecke (`<pre>`) und bereits markierte Stellen bleiben aus.
 *
 * KEIN innerHTML: der Textknoten wird mit `splitText` zerschnitten, der Pfad
 * wandert als `textContent` in den span, das Ziel als `dataset.pfad`.
 */
export function pfadeMarkieren(wurzel: HTMLElement, treffer: PfadTreffer[]): number {
  if (!treffer.length) return 0;
  const nachWortlaut = new Map(treffer.map((t) => [t.kandidat, t]));
  const doc = wurzel.ownerDocument;
  const laeufer = doc.createTreeWalker(wurzel, 4 /* NodeFilter.SHOW_TEXT */);
  const knoten: Text[] = [];
  let n: Node | null;
  while ((n = laeufer.nextNode()) !== null) {
    const el = n.parentElement;
    if (!el || el.closest('pre') || el.closest(`.${PFAD_KLASSE}`)) continue;
    knoten.push(n as Text);
  }
  let zahl = 0;
  for (const text of knoten) {
    const inhalt = text.data;
    const funde = stellen(inhalt).filter((s) => nachWortlaut.has(s.wortlaut));
    if (!funde.length) continue;
    let rest = text;
    let versatz = 0;
    for (const f of funde) {
      const t = nachWortlaut.get(f.wortlaut) as PfadTreffer;
      const mitte = rest.splitText(f.von - versatz);
      const danach = mitte.splitText(f.wortlaut.length);
      const span = doc.createElement('span');
      span.className = PFAD_KLASSE;
      span.textContent = f.wortlaut;
      span.dataset.pfad = t.abs;
      span.dataset.art = t.art;
      if (t.zeile) span.dataset.zeile = String(t.zeile);
      if (t.spalte) span.dataset.spalte = String(t.spalte);
      span.title = t.zeile ? `${t.abs}:${t.zeile}${t.spalte ? `:${t.spalte}` : ''}` : t.abs;
      mitte.replaceWith(span);
      rest = danach;
      versatz = f.bis;
      zahl += 1;
    }
  }
  return zahl;
}

/** Der Treffer hinter einer markierten Stelle -- fuer den Klick. */
export function trefferAusElement(el: HTMLElement): PfadTreffer | null {
  const abs = el.dataset.pfad ?? '';
  if (!abs) return null;
  return {
    kandidat: el.textContent ?? '',
    abs,
    art: el.dataset.art === 'ordner' ? 'ordner' : 'datei',
    zeile: Number(el.dataset.zeile ?? 0) || 0,
    spalte: Number(el.dataset.spalte ?? 0) || 0,
  };
}

/**
 * DER GANZE WEG fuer ein gezeichnetes Feld: Kandidaten aus dem Rohtext, ein
 * Ruf an den Hauptprozess (EINER je Nachricht, nicht einer je Pfad), dann die
 * Markierung. Laeuft asynchron nach dem Zeichnen; ein Feld, das inzwischen
 * aus dem DOM gefallen ist, wird nicht mehr angefasst.
 */
export async function pfadeVerlinken(feld: HTMLElement, rohtext: string, haken: PfadHaken): Promise<number> {
  const kandidaten = pfadKandidaten(rohtext);
  if (!kandidaten.length) return 0;
  let treffer: PfadTreffer[];
  try {
    treffer = await haken.pruefen(kandidaten);
  } catch {
    return 0;
  }
  if (!feld.isConnected) return 0;
  return pfadeMarkieren(feld, treffer);
}

/**
 * EIN Klick-Behandler je Verlauf, nicht einer je Stelle: die Stellen entstehen
 * nach dem Zeichnen und werden beim Neuzeichnen ersetzt, ein Behandler am
 * Verlauf ueberlebt das alles.
 */
export function pfadKlickAnbinden(verlauf: HTMLElement, haken: PfadHaken): void {
  verlauf.addEventListener('click', (ev) => {
    const ziel = (ev.target as HTMLElement | null)?.closest?.(`.${PFAD_KLASSE}`) as HTMLElement | null;
    if (!ziel || !verlauf.contains(ziel)) return;
    const t = trefferAusElement(ziel);
    if (!t) return;
    ev.preventDefault();
    ev.stopPropagation();
    haken.oeffnen(t);
  });
}
