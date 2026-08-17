// DER SESSION-BLOCK AUS DER REGISTRY, gelesen und nicht geraten.
//
// Die Registry ist das Erweiterungssystem (SPEC-V4 6.3): ein Mensch traegt einen
// neuen Harness ein, ohne eine Zeile Code anzufassen. Diese Datei ist die
// Gegenseite davon -- sie deutet den `session`-Block und sagt fuer jeden
// Harness, ob die Chat-Ansicht ihn zeichnen kann.
//
// DREI BEDINGUNGEN (SPEC-V4 Abschnitt 6, wortgleich uebernommen): ein
// maschinenlesbares Protokoll mit Rollen und Text, es muss WAEHREND der Sitzung
// fortgeschrieben werden, und einer laufenden Sitzung muss sich ihr Protokoll
// eindeutig zuordnen lassen. Fehlt eine davon, gibt es keine Ansicht -- und der
// Grund steht im Klartext da, statt dass ein Schalter grau wird.
//
// OHNE MESSDATUM KEIN EINTRAG (SPEC-V4 6.3 Punkt 1). Ein Block ohne
// `probe.datum` wird behandelt wie keiner: die Registry darf beschreiben, was
// jemand gemessen hat, nicht was jemand vermutet.
import type { SessionBlock, Via, Zuordnung, ZeigtNicht } from './typen';

const VIA_WERTE: Via[] = ['http-sse', 'sessionFile', 'acp', ''];
const ZUORDNUNG_WERTE: Zuordnung[] = ['cwd', 'pid', 'hook', 'serverId', ''];
const ZEIGT_NICHT_WERTE: ZeigtNicht[] = ['freigabedialog', 'kontextauslastung', 'arbeits-anzeige'];

function text(w: unknown): string {
  return typeof w === 'string' ? w : '';
}

function zahl(w: unknown): number {
  return typeof w === 'number' && Number.isFinite(w) ? w : 0;
}

function objekt(w: unknown): Record<string, unknown> | null {
  return w && typeof w === 'object' && !Array.isArray(w) ? (w as Record<string, unknown>) : null;
}

/**
 * Deutet den `session`-Block EINES Harness-Eintrags. Ist er nicht da, nicht
 * wohlgeformt oder ohne Messdatum, kommt `null` zurueck -- der Aufrufer sagt
 * dann "kein Eintrag" und behauptet nichts.
 */
export function sessionBlockLesen(harnessEintrag: unknown): SessionBlock | null {
  const h = objekt(harnessEintrag);
  if (!h) return null;
  const s = objekt(h.session);
  if (!s) return null;
  const via = text(s.via) as Via;
  if (!VIA_WERTE.includes(via)) return null;
  const probe = objekt(s.probe);
  const datum = probe ? text(probe.datum) : '';
  // Ohne Messdatum kein Eintrag. Ein Block, den niemand gemessen hat, ist eine
  // Behauptung -- und die Ansicht wuerde daran eine Quelle oeffnen, die es
  // vielleicht nie gab.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
  const zuordnung = text(s.zuordnung) as Zuordnung;
  const server = objekt(s.server);
  return {
    via,
    grund: text(s.grund),
    ort: text(s.ort),
    format: text(s.format),
    maxAgeSec: zahl(s.maxAgeSec),
    zuordnung: ZUORDNUNG_WERTE.includes(zuordnung) ? zuordnung : '',
    live: s.live === true,
    eingabe: text(s.eingabe),
    zeigtNicht: Array.isArray(s.zeigtNicht)
      ? (s.zeigtNicht.filter((w): w is ZeigtNicht => ZEIGT_NICHT_WERTE.includes(w as ZeigtNicht)))
      : [],
    server: server
      ? { bind: text(server.bind), token: text(server.token), auflage: text(server.auflage) }
      : null,
    probe: { datum, beleg: probe ? text(probe.beleg) : '' },
  };
}

/**
 * Alle Bloecke einer Registry-Datei, nach Harness-Kennung. Beide Formen der
 * Registry werden gelesen -- Liste (heute) und Objekt (aeltere Staende), genau
 * wie `harnessResume` in main.ts.
 */
export function sessionBloeckeAus(registryRoh: unknown): Record<string, SessionBlock> {
  const wurzel = objekt(registryRoh);
  if (!wurzel) return {};
  const h = wurzel.harnesses;
  const eintraege: Record<string, unknown>[] = Array.isArray(h)
    ? (h as Record<string, unknown>[])
    : Object.entries((objekt(h) ?? {}) as Record<string, Record<string, unknown>>)
      .map(([k, v]) => ({ id: k, ...v }));
  const raus: Record<string, SessionBlock> = {};
  for (const e of eintraege) {
    const id = text(objekt(e)?.id);
    if (!id) continue;
    const block = sessionBlockLesen(e);
    if (block) raus[id] = block;
  }
  return raus;
}

/** Was die Ansicht ueber einen Harness sagen kann, bevor sie irgendetwas oeffnet. */
export interface Urteil {
  moeglich: boolean;
  /** Klartext, wenn es nicht geht. Leer, wenn es geht. */
  grund: string;
  via: Via;
}

/**
 * DAS URTEIL. Es faellt VOR jedem Dateizugriff, aus dem Block und dem Wunsch
 * des Menschen -- und es begruendet jedes Nein.
 *
 * `gewuenscht` kommt aus der Einstellung `chatAnsicht` je Harness (geschrieben
 * auf der Seite 'Programme und Modelle'); `leserDa` sagt, ob dieses Programm
 * fuer den genannten Formatnamen ueberhaupt einen Leser hat. Der zweite Punkt
 * ist der wichtigere: einen Namen in die Registry zu schreiben genuegt nicht,
 * und ein Nein, das erst beim Lesen auffaellt, sieht aus wie ein Fehler.
 */
export function urteil(
  block: SessionBlock | null,
  gewuenscht: boolean,
  leserDa: (format: string) => boolean,
): Urteil {
  // FRUEHER LEER, MIT ABSICHT ("kein Vorwurf an einen ausgeschalteten
  // Harness") -- das war nur richtig, solange niemand einen leeren Grund zu
  // sehen bekam. Der Griff an jedem Pane erlaubt aber jederzeit den manuellen
  // Blick, auch wenn dieser Harness gerade aus ist, und die Ansicht faellt bei
  // einem leeren Grund auf den allgemeinen Satz ueber einen fehlenden Block
  // zurueck -- eine Luege, wenn der Block da ist und nur die Einstellung
  // dagegen steht (SPEC-V4 6.3 Punkt 6: nie ein Nein ohne echten Grund).
  if (!gewuenscht) {
    return { moeglich: false, grund: 'Diese Chat-Ansicht ist fuer diesen Harness in den Einstellungen ausgeschaltet.', via: block?.via ?? '' };
  }
  if (!block) {
    return {
      moeglich: false,
      via: '',
      grund: 'Fuer diesen Harness steht kein gemessener session-Block in der Registry.',
    };
  }
  if (block.via === '') {
    return { moeglich: false, via: '', grund: block.grund || 'Dieser Harness gibt sein Gespraech nicht heraus.' };
  }
  if (!block.live) {
    return {
      moeglich: false,
      via: block.via,
      grund: 'Das Protokoll wird nicht waehrend der Sitzung fortgeschrieben — eine Ansicht, die erst am Ende erscheint, ist keine.',
    };
  }
  if (!block.zuordnung) {
    return {
      moeglich: false,
      via: block.via,
      grund: 'Einer laufenden Sitzung laesst sich ihr Protokoll nicht eindeutig zuordnen.',
    };
  }
  if (!block.ort) {
    return { moeglich: false, via: block.via, grund: 'Der session-Block nennt keinen Ort.' };
  }
  if (!leserDa(block.format)) {
    return {
      moeglich: false,
      via: block.via,
      grund: `Fuer das Format '${block.format || '(ohne Namen)'}' hat dieses Programm keinen Leser.`,
    };
  }
  return { moeglich: true, grund: '', via: block.via };
}
