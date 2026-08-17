// EIN KLEINER, EIGENER MARKDOWN-RENDERER FUER DIE CHAT-ANSICHT (SPEC-V4 6, 12.08.).
//
// WARUM KEINE BIBLIOTHEK: "keine neue Abhaengigkeit" gilt fuer die ganze
// Werkbank, und das Vokabular, das eine Chat-Zeile tatsaechlich braucht, ist
// klein -- fett, kursiv, Inline-Code, Fences, Ueberschriften, Listen,
// Tabellen, Blockzitate, Links als Text. Alles darueber hinaus (verschachtelte
// Listen, Fussnoten, HTML-Einsprengsel) bleibt roher Text, kein Fehler.
//
// XSS-SICHER, UND ZWAR SO: fuer jedes Textstueck erst `escapeHtml()`, DANACH
// werden Muster auf dem BEREITS ESCAPTEN Text erkannt und durch eigene, feste
// Tag-Zeichenketten ersetzt (`inline()`). Niemand darf rohen, ungeprueften
// Text an `innerHTML` uebergeben -- was in diese Funktionen hineingeht, ist
// vom Harness-Protokoll gekommen und damit nicht vertrauenswuerdig, egal wie
// harmlos ein Chatverlauf aussieht.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Die Marke, die Inline-Code waehrend `inline()` vertritt -- ein Nullbyte kommt in einem Protokolltext nie vor (siehe `kuerzen()`, chat/leser.ts, und die Vorsorge unten in `markdownZuHtml()`). */
const CODE_MARKE = '\u0000';

/**
 * INLINE-MUSTER auf bereits escaptem Text. Inline-Code wird ZUERST
 * herausgeloest und durch eine Marke ersetzt -- sonst wuerden `**`/`*` aus
 * einem Code-Stueck wie `**init**()` faelschlich als Fett gelesen, bevor der
 * Code als Ganzes wieder eingesetzt wird.
 */
function inline(escaped: string): string {
  const eingehuellt: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    eingehuellt.push(`<code>${code}</code>`);
    return `${CODE_MARKE}${eingehuellt.length - 1}${CODE_MARKE}`;
  });
  // Fett vor kursiv: sonst liest `*` aus `**wort**` bereits als Kursiv-Rand.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '<em>$1</em>');
  // Links ALS TEXT (SPEC): nur die Beschriftung bleibt stehen, kein Anker,
  // kein Ziel, das jemand versehentlich anklickt.
  //
  // DAS ZIEL DARF EINE KLAMMEREBENE ENTHALTEN (Befund B9, 12.08.). Der
  // fruehere Ausdruck endete an der ERSTEN schliessenden Klammer, und aus
  // `[Berlin](https://de.wikipedia.org/wiki/Berlin_(Begriffsklaerung))` wurde
  // `Berlin)` -- ein Wikipedia-Link mit Klammerzusatz ist der Normalfall, kein
  // Sonderfall. Sicherheitsrelevant war das nie (ein Anker entsteht ohnehin
  // nicht), es sah nur falsch aus. Tiefer als eine Ebene wird bewusst nicht
  // gegriffen: dafuer braeuchte es einen Zaehler, und ein Ziel mit
  // verschachtelten Klammern gibt es in der Praxis nicht.
  s = s.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  const marke = new RegExp(`${CODE_MARKE}(\\d+)${CODE_MARKE}`, 'g');
  return s.replace(marke, (_m, i: string) => eingehuellt[Number(i)]);
}

/** Ist diese Zeile die Trennzeile einer Tabelle (`---|:--:|--:`)? */
function istTrennzeile(zeile: string): boolean {
  const z = zeile.trim();
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(z);
}

function tabellenZellen(zeile: string): string[] {
  let z = zeile.trim();
  if (z.startsWith('|')) z = z.slice(1);
  if (z.endsWith('|')) z = z.slice(0, -1);
  return z.split('|').map((zelle) => zelle.trim());
}

/**
 * Ist `zeilen[idx]` der Kopf einer Tabelle -- eine Pipe-Zeile, direkt gefolgt
 * von der Trennzeile? EINE Funktion fuer BEIDE Stellen, die das wissen muessen
 * (der Block-Beginn und der Absatz-Abbruch, Reviewer-Befund B4) -- zwei
 * eigene Kopien sind genau die Falle, die B1 schon einmal gekostet hat.
 */
function istTabellenkopf(zeilen: string[], idx: number): boolean {
  return zeilen[idx].includes('|') && idx + 1 < zeilen.length && istTrennzeile(zeilen[idx + 1]);
}

function tabelleHtml(kopf: string[], zeilen: string[][]): string {
  const th = kopf.map((z) => `<th>${inline(escapeHtml(z))}</th>`).join('');
  const rumpf = zeilen
    .map((z) => `<tr>${z.map((zelle) => `<td>${inline(escapeHtml(zelle))}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="md-tabelle"><thead><tr>${th}</tr></thead><tbody>${rumpf}</tbody></table>`;
}

const LISTENZEILE = /^\s*([-*+]|\d+\.)\s+(.*)$/;

/**
 * DER BLOCK-ZERTEILER: geht Zeile fuer Zeile durch und erkennt sieben Formen.
 * Kein Nachbau eines vollen CommonMark-Parsers -- keine Verschachtelung, keine
 * Ausnahmefaelle fuer eingerueckten Code. Was nicht erkannt wird, faellt in den
 * Absatz-Zweig und wird trotzdem escaped und inline-verarbeitet gezeigt.
 */
function bloecke(text: string): string {
  const zeilen = text.split('\n');
  const raus: string[] = [];
  let i = 0;
  while (i < zeilen.length) {
    const zeile = zeilen[i];
    if (!zeile.trim()) {
      i++;
      continue;
    }

    // Reviewer-Befund B1 (12.08.): der Zaun MUSS jede Zeile treffen, die mit
    // ```` ``` ```` beginnt -- unabhaengig davon, was danach im Info-String
    // steht (```` ```js title="a" ````, ```` ```ts twoslash ````, ein Leer-
    // zeichen genuegt). Der Absatz-Zweig unten bricht bei GENAU demselben
    // Muster ab; klaffen die beiden auseinander, faellt eine Zaunzeile mit
    // Leerzeichen im Info-String durch beide Zweige, die Absatz-Schleife
    // erhoeht `i` dann nie mehr, und `bloecke()` haengt sich endlos auf.
    const fence = zeile.match(/^\s{0,3}```(.*)$/);
    if (fence) {
      const inhalt: string[] = [];
      i++;
      while (i < zeilen.length && !/^\s{0,3}```\s*$/.test(zeilen[i])) {
        inhalt.push(zeilen[i]);
        i++;
      }
      i++; // die schliessenden ``` -- oder das Dateiende, ohne Schaden.
      raus.push(`<pre class="md-code"><code>${escapeHtml(inhalt.join('\n'))}</code></pre>`);
      continue;
    }

    const ueberschrift = zeile.match(/^(#{1,6})\s+(.*)$/);
    if (ueberschrift) {
      const ebene = ueberschrift[1].length;
      raus.push(`<h${ebene} class="md-h">${inline(escapeHtml(ueberschrift[2].trim()))}</h${ebene}>`);
      i++;
      continue;
    }

    if (istTabellenkopf(zeilen, i)) {
      const kopf = tabellenZellen(zeile);
      i += 2;
      const datenzeilen: string[][] = [];
      while (i < zeilen.length && zeilen[i].trim() && zeilen[i].includes('|')) {
        datenzeilen.push(tabellenZellen(zeilen[i]));
        i++;
      }
      raus.push(tabelleHtml(kopf, datenzeilen));
      continue;
    }

    if (/^>\s?/.test(zeile)) {
      const inhalt: string[] = [];
      while (i < zeilen.length && /^>\s?/.test(zeilen[i])) {
        inhalt.push(inline(escapeHtml(zeilen[i].replace(/^>\s?/, ''))));
        i++;
      }
      raus.push(`<blockquote class="md-zitat">${inhalt.join('<br>')}</blockquote>`);
      continue;
    }

    const listenstart = zeile.match(LISTENZEILE);
    if (listenstart) {
      const geordnet = /^\d+\.$/.test(listenstart[1]);
      const punkte: string[] = [];
      while (i < zeilen.length) {
        const m = zeilen[i].match(LISTENZEILE);
        if (!m || /^\d+\.$/.test(m[1]) !== geordnet) break;
        punkte.push(`<li>${inline(escapeHtml(m[2]))}</li>`);
        i++;
      }
      const tag = geordnet ? 'ol' : 'ul';
      raus.push(`<${tag} class="md-liste">${punkte.join('')}</${tag}>`);
      continue;
    }

    const absatz: string[] = [];
    while (
      i < zeilen.length
      && zeilen[i].trim()
      && !/^\s{0,3}```/.test(zeilen[i])
      && !/^#{1,6}\s/.test(zeilen[i])
      && !/^>\s?/.test(zeilen[i])
      && !LISTENZEILE.test(zeilen[i])
      // Reviewer-Befund B4 (12.08.): ohne diese Zeile verschluckte der Absatz
      // eine Tabelle, die direkt (ohne Leerzeile) auf Text folgt -- die Pipes
      // liefen als roher Text mit durch, statt eine eigene Tabelle zu eroeffnen.
      && !istTabellenkopf(zeilen, i)
    ) {
      absatz.push(zeilen[i]);
      i++;
    }
    raus.push(`<p class="md-p">${inline(escapeHtml(absatz.join('\n')))}</p>`);
  }
  return raus.join('');
}

/**
 * DIE EINE ABFRAGE. Nullbytes fliegen vorsorglich raus (dieselbe Vorsicht wie
 * `kuerzen()` in chat/leser.ts, das sie im Regelfall schon entfernt hat) --
 * sie sind sonst die Marke, die `inline()` fuer herausgeloesten Code benutzt.
 */
export function markdownZuHtml(text: string): string {
  return bloecke(text.replace(/\u0000/g, ''));
}
