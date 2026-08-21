// Das Kontextfenster eines LOKALEN Modells -- die Stufen, aus denen ein Mensch
// waehlt, und was der Speicher dazu sagt.
//
// WARUM DAS UEBERHAUPT EINE WAHL IST. Bei einem Cloud-Modell steht das Fenster
// fest: es gehoert dem Anbieter, und niemand hier kann es aendern. Bei einem
// lokalen Modell ist es eine Abwaegung, die auf DIESER Maschine getroffen wird
// -- je groesser das Fenster, desto mehr Grafikspeicher haelt der KV-Cache
// besetzt, und desto eher scheitert der Start. Deshalb erscheint das Feld nur
// bei lokalen Modellen; bei allen anderen bliebe es ein Schalter ohne Wirkung.
//
// DIESE DATEI RECHNET NICHTS SELBST. Sie fragt `wb-kontext stufen <id> --json`
// und reicht die Antwort weiter. Das ist Absicht: der freie Speicher, der
// KV-Bedarf je Token und das native Maximum eines Modells sind Messwerte, und
// sie haben genau eine Quelle. Eine zweite Rechnung hier waere eine zweite
// Wahrheit -- und die waere spaetestens dann falsch, wenn das Werkzeug seine
// eigene korrigiert.
//
// EINE ABLEHNUNG IST EIN ERGEBNIS, KEINE LUECKE. Wo das Werkzeug fehlt oder
// nicht antwortet, steht danach im Fenster, dass die Stufen sich nicht
// ermitteln liessen -- und NICHT eine erfundene Liste. Dieselbe Regel wie bei
// `harnessStufen` in einstellungsfenster.ts: eine gescheiterte Abfrage darf nie
// als Tatsachenbehauptung in der Oberflaeche landen.
import { execFileSync } from 'node:child_process';

/** Eine waehlbare Stufe. `passt` sagt, ob der Speicher HEUTE dafuer reicht. */
export interface KontextStufe {
  tokens: number;
  label: string;
  /** Was die Stufe an Grafikspeicher braucht, Gewichte eingerechnet. */
  bedarfGib: number;
  /**
   * Reicht der freie Speicher? FALSE SPERRT NICHTS. Die Stufe bleibt waehlbar
   * und traegt ihren Hinweis -- das ist ausdrueckliche des Nutzers Vorgabe: er
   * will sehen, was der Speicher sagt, und trotzdem selbst entscheiden.
   */
  passt: boolean;
  /** Der Satz, der den Speichermangel benennt. Nur gesetzt, wenn `passt` false ist. */
  hinweis: string | null;
}

/** Die vollstaendige Antwort von `wb-kontext stufen <id> --json`. */
export interface KontextSicht {
  modell: string;
  harness: string;
  provider: string;
  modelRef: string;
  /** Was das Modell selbst hoechstens kann -- nie zu ueberschreiten. */
  nativesMaximum: number;
  freiMib: number;
  gewichteGb: number;
  kvMibProToken: number;
  parallel: number;
  /** Was vorausgewaehlt ist. */
  vorgabe: number;
  /** Was das Werkzeug empfiehlt -- die Stufe traegt dafuer ein Wort, kein Symbol. */
  empfehlung: number;
  stufen: KontextStufe[];
}

export type KontextAntwort =
  | { ok: true; sicht: KontextSicht }
  | { ok: false; fehler: string };

function zahl(v: unknown, ersatz = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : ersatz;
}

/** Aus der rohen JSON-Antwort eine Sicht machen. Fehlende Felder werden nicht geraten. */
export function deuteKontext(roh: unknown): KontextAntwort {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    return { ok: false, fehler: 'Die Antwort war kein Objekt.' };
  }
  const d = roh as Record<string, unknown>;
  if (!Array.isArray(d.stufen)) {
    return { ok: false, fehler: 'Die Antwort enthaelt keine Stufenliste.' };
  }
  const stufen: KontextStufe[] = [];
  for (const e of d.stufen as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const s = e as Record<string, unknown>;
    const tokens = zahl(s.tokens);
    if (tokens <= 0) continue;
    stufen.push({
      tokens,
      label: String(s.label ?? `${Math.round(tokens / 1024)}k`),
      bedarfGib: zahl(s.bedarfGib),
      // Nur ein ausdrueckliches `false` heisst "reicht nicht". Ein fehlendes
      // Feld als Mangel zu lesen haenge an jede Stufe einen Warnsatz, den
      // niemand gemessen hat.
      passt: s.passt !== false,
      hinweis: typeof s.hinweis === 'string' && s.hinweis.trim() ? s.hinweis.trim() : null,
    });
  }
  if (stufen.length === 0) return { ok: false, fehler: 'Die Stufenliste war leer.' };
  return {
    ok: true,
    sicht: {
      modell: String(d.modell ?? ''),
      harness: String(d.harness ?? ''),
      provider: String(d.provider ?? ''),
      modelRef: String(d.modelRef ?? ''),
      nativesMaximum: zahl(d.nativesMaximum),
      freiMib: zahl(d.freiMib),
      gewichteGb: zahl(d.gewichteGb),
      kvMibProToken: zahl(d.kvMibProToken),
      parallel: zahl(d.parallel, 1),
      vorgabe: zahl(d.vorgabe),
      empfehlung: zahl(d.empfehlung),
      stufen,
    },
  };
}

/**
 * Die Stufen EINES Modells erfragen. Synchron und mit Zeitgrenze, wie die
 * uebrigen Werkzeugaufrufe dieses Fensters -- der Aufruf misst den freien
 * Speicher und ist damit nicht zwischenspeicherbar ueber die Zeit; wer ihn
 * ruft, will den Stand von jetzt.
 */
export function kontextStufen(bin: string, modellId: string): KontextAntwort {
  if (!modellId) return { ok: false, fehler: 'Kein Modell angegeben.' };
  let text = '';
  try {
    text = execFileSync(bin, ['stufen', modellId, '--json'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Der Wortlaut des Werkzeugs, nicht eine eigene Deutung: ein fehlendes
    // `wb-kontext` liest sich anders als eine abgelehnte Modell-Kennung, und
    // der Unterschied ist genau das, was im Fenster stehen muss.
    const f = e as { stderr?: Buffer | string; message?: string };
    const stderr = typeof f.stderr === 'string' ? f.stderr : f.stderr?.toString() ?? '';
    const kurz = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
    return { ok: false, fehler: kurz || f.message || 'Der Aufruf schlug fehl.' };
  }
  try {
    return deuteKontext(JSON.parse(text) as unknown);
  } catch {
    return { ok: false, fehler: 'Die Antwort war kein gueltiges JSON.' };
  }
}

// --- Kennt das installierte `wb-code` den Schalter `--kontext`? -------------
//
// WARUM GEFRAGT WIRD, STATT ES ANZUNEHMEN. Der Schalter entsteht in einer
// ANDEREN Spur (Auftrag B) und liegt in `~/.local/bin/wb-code`, nicht in
// dieser Anwendung. Ein `wb-code`, das ihn nicht kennt, beendet sich mit
// "unbekannte Option '--kontext'" und Exit 1 -- jede neue Sitzung dieses Weges
// scheiterte dann an einem Schalter statt an etwas Wirklichem.
//
// WIE GEFRAGT WIRD, und warum das nichts startet: dieselbe Wand, an der schon
// `revive.ts` seine Flags gemessen hat -- ein Verzeichnis, das es nicht gibt.
// `wb-code` liest erst seine Schalter und prueft DANACH das Verzeichnis
// (shell/wb-code, Zeile 88 gegen 92). Also:
//
//   kennt es den Schalter nicht  ->  "unbekannte Option '--kontext'", Exit 1,
//                                    das Verzeichnis wird nie erreicht
//   kennt es ihn                 ->  "kein Verzeichnis: <pfad>", Exit 1
//
// Beide Wege enden vor jeder Wirkung: kein tmux-Fenster, kein Modellstart,
// nicht einmal der Hintergrundlauf von `wb-state models discover` (der steht
// hinter der Verzeichnispruefung). Gemessen am 19.08. gegen beide Faelle.
//
// IM ZWEIFEL NEIN. Antwortet der Aufruf gar nicht, laeuft er in die Zeitgrenze
// oder steht in seiner Ausgabe etwas Drittes, gilt der Schalter als unbekannt:
// eine Sitzung ohne das gewaehlte Fenster ist ein kleiner Verlust, eine
// Sitzung, die gar nicht erst anlaeuft, ein grosser.
const kontextFlagMerker = new Map<string, boolean>();

/**
 * Die Argumente der Probe. Sie stehen HIER und nicht beim Aufrufer, weil der
 * Aufrufer sie bei einer Fernmaschine mitten in den ssh-Aufruf einbauen muss --
 * und dabei nicht raten soll, wie die Wand heisst. `/nonexistent` gibt es auf
 * keiner der beiden Maschinen und es laesst sich nichts damit anfassen.
 */
export const KONTEXT_PROBE_ARGS: readonly string[] = ['--kontext', 'auto', '/nonexistent/wb-code-kontext-probe'];

/**
 * `argv` ist der VOLLSTAENDIGE Aufruf einschliesslich `KONTEXT_PROBE_ARGS` --
 * oertlich `[wbCodeBin, ...KONTEXT_PROBE_ARGS]`, fern der ssh-Aufruf, in den
 * `fernAufruf` die Probe schon eingebaut hat.
 *
 * WARUM NICHT (bin, vorArgs) UND HIER ANGEHAENGT: `fernAufruf` faltet den
 * fernen Befehl zu EINER gequoteten Zeichenkette am Ende der ssh-Argumentliste
 * zusammen (pfad.ts). Etwas daran anzuhaengen landet also NEBEN dieser Zeile
 * statt darin; dass ssh die restlichen Operanden mit Leerzeichen verbindet und
 * es dadurch zufaellig doch funktioniert, ist keine Zusage, auf die man bauen
 * sollte -- und die Quotierung entfiele. Deshalb baut der Aufrufer den ganzen
 * Aufruf, und diese Funktion fuehrt nur aus.
 *
 * Der Merker haengt am ganzen Aufruf: das oertliche `wb-code` und das auf einer
 * Fernmaschine sind zwei verschiedene Programme.
 */
export function wbCodeKenntKontext(argv: readonly string[]): boolean {
  const [bin, ...args] = argv;
  if (!bin) return false;
  const schluessel = argv.join(' ');
  const gemerkt = kontextFlagMerker.get(schluessel);
  if (gemerkt !== undefined) return gemerkt;
  let ausgabe = '';
  try {
    ausgabe = execFileSync(bin, args, {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const f = e as { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof f.stderr === 'string' ? f.stderr : f.stderr?.toString() ?? '';
    const stdout = typeof f.stdout === 'string' ? f.stdout : f.stdout?.toString() ?? '';
    ausgabe = `${stderr}\n${stdout}`;
  }
  // Nur die eine Antwort zaehlt als Ja: dass es bis zur Verzeichnispruefung
  // gekommen ist. Alles andere -- auch ein stilles Nichts -- ist ein Nein.
  const kennt = /kein Verzeichnis/.test(ausgabe) && !/unbekannte Option/.test(ausgabe);
  kontextFlagMerker.set(schluessel, kennt);
  return kennt;
}

/** Nur fuer Tests: die gemerkte Antwort vergessen. */
export function kontextFlagMerkerLeeren(): void {
  kontextFlagMerker.clear();
}
