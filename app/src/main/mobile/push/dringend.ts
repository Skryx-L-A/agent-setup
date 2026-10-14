// WANN EIN „WORKER FERTIG“ DOCH ALS PUSH HINAUSGEHT.
//
// Entscheidung alice 09.10.2026 + feste Regel aus jev/mobil (09.10.2026):
// Gepusht wird nur Dringendes -- Freigabe-Anfrage, Fehler, Frage an ihn. Ein
// `worker.done` steht deshalb gewoehnlich nur in der App (`in_app`). Die
// Jev-Pruefung (jev/mobil/PLAN.md Abschnitt 2 „E1“ und Abschnitt 3
// „Gold-Regeln“, Ergebnis jev/mobil/referenz/ERGEBNIS.md) ergab: liegen die
// Signale als Felder vor, ist eine feste Regel besser als ein Modell. Diese
// Datei ist diese Regel, an EINER Stelle, ohne Modell.
//
// Sie stuft nur hoch. Die vier dringenden Arten (`PUSH_TYPES` in service.ts)
// fragen sie nie, und eine Meldung, die hier `in_app` bleibt, steht trotzdem in
// der App. Im Zweifel bleibt es still (fail-quiet): ein falscher Push kostet
// eine Unterbrechung, ein verpasster nur den Blick in den Tab „Meldungen“.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** Die Kuerzel aus jev/mobil/PLAN.md Abschnitt 3; das Journal speichert sie als `grund`. */
export type WorkerFertigGrund = 'R2' | 'R3' | 'R4' | 'R4n' | 'R5';

export interface WorkerFertigStufe {
  readonly zustellung: 'push' | 'in_app';
  readonly grund: WorkerFertigGrund;
}

/** Was die Ergebnisdatei hergibt -- nur gezaehlt, nie ihr Inhalt. */
export interface ErgebnisZaehlung {
  /** Gescheitert oder abgebrochen, nach einer der festen Marken unten. */
  readonly gescheitert: boolean;
  /** Eintraege im OPEN-Abschnitt, die sich ausdruecklich an alice richten. */
  readonly fragenAnMensch: number;
}

/** Die Felder, die der Kern beim Ausloesen von `worker.done` mitgibt. */
export interface WorkerFertigFelder {
  readonly ergebnis: ErgebnisZaehlung;
  /** Laufende Worker DERSELBEN Sitzung ohne den, der gerade fertig wurde. */
  readonly andereLaufend: number;
}

/**
 * DIE REGEL. Entscheidung alice 09.10.2026 + feste Regel aus jev/mobil
 * (09.10.2026). Reihenfolge wie in PLAN.md Abschnitt 3; die erste passende
 * Regel entscheidet.
 *
 *   R2   alice hat fuer diese Sitzung „Bescheid geben“ gedrueckt -> push
 *   R3   das Ergebnis enthaelt eine offene Frage an alice          -> push
 *   R4   gescheitert/abgebrochen, kein anderer Worker laeuft          -> push
 *   R4n  gescheitert/abgebrochen, andere Worker laufen                -> in_app
 *   R5   alles andere                                                 -> in_app
 *
 * R3b ENTFAELLT BEWUSST (Entscheidung alice 09.10.2026): Es gibt keine
 * Nachtvollmacht. Eine Frage an alice wird immer gepusht, auch nachts --
 * R3 gilt ohne Ausnahme. Damit entfaellt auch U1 aus jev/mobil (Wartewunsch
 * bei Nachtvollmacht): es gilt R2.
 *
 * Der Wartewunsch (R2) gilt bis zum ersten ausgeloesten Push, hoechstens
 * 12 Stunden (Entscheidung alice 09.10.2026; WARTEWUNSCH_MS in service.ts).
 */
export function workerFertigEinstufen(wartewunsch: boolean, felder: WorkerFertigFelder | null): WorkerFertigStufe {
  if (wartewunsch) return { zustellung: 'push', grund: 'R2' };
  if (!felder) return { zustellung: 'in_app', grund: 'R5' };
  if (felder.ergebnis.fragenAnMensch > 0) return { zustellung: 'push', grund: 'R3' };
  if (felder.ergebnis.gescheitert) {
    return felder.andereLaufend === 0 ? { zustellung: 'push', grund: 'R4' } : { zustellung: 'in_app', grund: 'R4n' };
  }
  return { zustellung: 'in_app', grund: 'R5' };
}

// --- Zaehlung der Ergebnisdatei ------------------------------------------------
//
// Das Format ist das Protokoll der Werkbank (pi-worker): eine Markdown-Datei
// mit den Abschnitten WHAT, HOW-verified und OPEN (als `##` oder `#`). Das DONE
// steht im Chat des Workers, nicht in der Datei -- ein fehlendes DONE ist aus
// der Datei deshalb nicht ablesbar und zaehlt hier nicht.

/** Groessere Dateien werden nicht gelesen: dann gilt „nichts gezaehlt“. */
const HOECHSTENS_BYTES = 512 * 1024;

const NICHTS: ErgebnisZaehlung = { gescheitert: false, fragenAnMensch: 0 };

/**
 * Feste Marken fuer „gescheitert oder abgebrochen“:
 *   * die Fehlschlagdateien von pi-worker (`<ts>.zustellung-fehlgeschlagen.md`,
 *     `<ts>.modell-abweichung.md`) samt ihrer ersten Ueberschrift;
 *   * eine Zeile `Status: abgebrochen|gescheitert|fehlgeschlagen …` im Kopf;
 *   * ein WHAT, dessen erste Zeile mit genau diesen Woertern beginnt.
 */
const FEHLSCHLAG_DATEI = /\.(zustellung-fehlgeschlagen|modell-abweichung)\.md$/;
const FEHLSCHLAG_KOPF = /^#\s+(Zustellung an "[^"\n]*" fehlgeschlagen|Worker "[^"\n]*" lief mit falschem Modell)/m;
const FEHLWORT = '(abgebrochen|gescheitert|fehlgeschlagen|aborted|failed)';
const STATUS_ZEILE = new RegExp(`^\\s*(\\*\\*)?Status:?(\\*\\*)?:?\\s*(\\*\\*)?${FEHLWORT}\\b`, 'i');
const WHAT_ANFANG = new RegExp(`^(\\*\\*)?(${FEHLWORT}|kein Ergebnis)\\b`, 'i');

/**
 * Ein OPEN-Eintrag richtet sich an alice, wenn er MIT einer dieser Marken
 * beginnt (nach Aufzaehlungszeichen, Nummer und Fettdruck). Eine Marke mitten
 * im Satz („… nach Betreiberentscheidung entfernen“) zaehlt nicht.
 */
const AN_MENSCH = new RegExp([
  'betreiber-?entscheidung',
  'entscheidung\\s+(f(ü|ue)r|von|an)\\s+(alice|den\\s+menschen|den\\s+betreiber)',
  'frage\\s+(an|f(ü|ue)r)\\s+(alice|den\\s+menschen|den\\s+betreiber)',
  'alice\\s+(muss|soll|entscheidet|bitte)',
  'operator\\s+decision',
  '(decision|question)\\s+for\\s+(alice|the\\s+operator|the\\s+human)',
].map((m) => `(${m})`).join('|'), 'i');

/** Ausdruecklich keine offene Frage, oder ausdruecklich nicht dringend. */
const VERNEINT = /\b(keine?|kein(e|en)?\s+weitere|nicht\s+dringend|keine\s+eile|no\s+open|none|not\s+urgent)\b/i;

/** Ein Adressat neben alice („alice/Hauptagent“) ist nicht ausdruecklich er: unklar, zaehlt nicht. */
const GETEILT = /(alice|mensch(en)?|betreiber)\s*(\/|oder|or)\s*(hauptagent|orchestrator|agent)|(hauptagent|orchestrator)\s*(\/|oder|or)\s*(alice|mensch|betreiber)/i;

function abschnitt(text: string, name: RegExp): string | null {
  const zeilen = text.split('\n');
  const start = zeilen.findIndex((z) => /^#{1,3}\s/.test(z) && name.test(z.replace(/^#{1,3}\s+/, '')));
  if (start < 0) return null;
  const ebene = (zeilen[start].match(/^#+/) ?? ['##'])[0].length;
  const rest: string[] = [];
  for (const z of zeilen.slice(start + 1)) {
    const m = z.match(/^(#+)\s/);
    if (m && m[1].length <= ebene) break;
    rest.push(z);
  }
  return rest.join('\n');
}

/** Eintraege eines Abschnitts: Listenpunkte, sonst Absaetze; Fortsetzungszeilen gehoeren dazu. */
function eintraege(abschnittText: string): string[] {
  const liste: string[] = [];
  let aktuell: string | null = null;
  for (const roh of abschnittText.split('\n')) {
    const z = roh.trimEnd();
    if (!z.trim()) {
      if (aktuell !== null) liste.push(aktuell);
      aktuell = null;
      continue;
    }
    const istPunkt = /^\s{0,3}([-*+]|\d+[.)])\s+/.test(z);
    if (istPunkt || aktuell === null) {
      if (aktuell !== null) liste.push(aktuell);
      aktuell = z;
    } else {
      aktuell += ` ${z.trim()}`;
    }
  }
  if (aktuell !== null) liste.push(aktuell);
  return liste;
}

function anMensch(eintrag: string): boolean {
  const kopf = eintrag.replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(/^[*_]+/, '').trimStart();
  const m = kopf.match(AN_MENSCH);
  if (!m || m.index !== 0) return false;
  // Gelesen wird nur der Kopf des Eintrags bis zum ersten Doppelpunkt (oder die
  // ersten 80 Zeichen): dort stehen Adressat und Verneinung, danach die Frage.
  const doppelpunkt = kopf.indexOf(':');
  const vorspann = kopf.slice(0, doppelpunkt >= 0 && doppelpunkt < 120 ? doppelpunkt + 1 : 80);
  if (VERNEINT.test(vorspann) || GETEILT.test(vorspann)) return false;
  return true;
}

/** Zaehlt den Text einer Ergebnisdatei. `pfad` dient nur der Dateinamen-Marke. */
export function ergebnisZaehlen(text: string, pfad = ''): ErgebnisZaehlung {
  const kopf = text.split('\n').slice(0, 15);
  const what = abschnitt(text, /^WHAT\b/i);
  const whatErste = (what ?? '').split('\n').map((z) => z.trim()).find((z) => z) ?? '';
  const inlineWhat = text.match(/^WHAT:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const gescheitert = FEHLSCHLAG_DATEI.test(basename(pfad))
    || FEHLSCHLAG_KOPF.test(text)
    || kopf.some((z) => STATUS_ZEILE.test(z))
    || WHAT_ANFANG.test(whatErste)
    || WHAT_ANFANG.test(inlineWhat);
  const offen = abschnitt(text, /^OPEN\b/i);
  const fragenAnMensch = offen === null ? 0 : eintraege(offen).filter(anMensch).length;
  return { gescheitert, fragenAnMensch };
}

/**
 * Liest die Ergebnisdatei einmal, begrenzt, und gibt nur die Zaehlung zurueck.
 * Jeder Lesefehler heisst „nichts gezaehlt“ -- dann bleibt es bei `in_app`.
 */
export function ergebnisDateiZaehlen(pfad: string): ErgebnisZaehlung {
  try {
    const st = statSync(pfad);
    if (!st.isFile() || st.size > HOECHSTENS_BYTES) return NICHTS;
    return ergebnisZaehlen(readFileSync(pfad, 'utf8'), pfad);
  } catch {
    return NICHTS;
  }
}
