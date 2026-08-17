// DIE EINE REGEL, WELCHE ANSICHT EIN PANE ZEIGT (12.08.).
//
// Vor heute stand die Frage "Gespraech oder Terminalbild?" an einem einzigen
// Wahrheitswert, und drei Stellen lasen ihn. Jetzt sind es drei EBENEN, und
// genau deshalb steht die Antwort hier und nur hier -- drei Ebenen, dreimal
// nachgebaut, waeren drei Wahrheiten:
//
//   1  KANN ES     Faehigkeit, aus dem `session`-Block der Registry (mit
//                  probe.datum). Sie beschreibt den Harness, nicht den
//                  Menschen, und wird von keiner Einstellung ueberstimmt --
//                  die einzige Ebene, die auch die Sitzungs-Uebersteuerung
//                  nicht schlaegt.
//   2  WILL ICH ES Zweierlei: der Schalter je HARNESS auf der Seite "Programme
//                  und Modelle" ("fuer diesen Harness ueberhaupt erlauben"),
//                  und die Vorgabe je ROLLE auf der Seite "Aussehen"
//                  (`chatAnsichtVorgabe`, seit heute ein Block aus zwei
//                  Wahrheitswerten statt eines einzigen).
//   3  FUER DIESE SITZUNG  Das Uebersteuern per Rechtsklick. Es steht in
//                  ui.json (nicht in den geteilten Einstellungen, Begruendung
//                  im Kopf von main/uistate.ts) und gilt nur, solange es die
//                  Sitzung gibt.
//
// DIE AUFLOESUNG (12.08., geaendert: Wortlaut des Nutzers "Das soll mit
// rechtsklick auch funktionieren wenn es in den einstellungen nicht
// angeschaltet ist, dann halt nur fuer die session und nur fuer den
// orchestrator pane"): die Sitzungs-Uebersteuerung schlaegt die Rollenvorgabe
// UND den Harness-Schalter -- wer per Rechtsklick uebersteuert, bekommt die
// Ansicht fuer diese eine Sitzung, auch wenn "Programme und Modelle" sie fuer
// den Harness nicht eingeschaltet hat. Nur was der Harness laut Registry nicht
// KANN, bleibt hart: das ist keine Einstellung, die sich uebergehen liesse,
// sondern eine fehlende Quelle. Ohne Uebersteuerung gilt weiter: der
// Harness-Schalter muss an sein, sonst bleibt es zu. Ein Wunsch bleibt so oder
// so erhalten, auch wenn er gerade nicht erfuellbar ist -- `hindernis` sagt,
// woran es liegt, statt dass der Wunsch still verschwindet.
//
// Diese Datei fasst nichts an: keine Datei, kein Fenster, kein Prozess. Sie
// laeuft in `dist/test/chat-rein.mjs` (ueber chat/rein.ts) in einem nackten
// node -- shell/tests/test-app-chatrolle.sh geht alle Kombinationen durch.

/** Wer in diesem Pane sitzt. Nur diese zwei -- Subagenten haben keinen Pane. */
export type PaneRolle = 'orchestrator' | 'worker';

/** Die Vorgabe je Rolle (Einstellung `chatAnsichtVorgabe`, Seite Aussehen). */
export interface ChatVorgabe {
  orchestrator: boolean;
  worker: boolean;
}

export const KEINE_VORGABE: ChatVorgabe = { orchestrator: false, worker: false };

/** Was ein Nein verursacht hat. Leer heisst: nichts steht im Weg. */
export type Hindernis = '' | 'kann' | 'erlaubt';

export interface AnsichtsLage {
  /** Kann der Harness es laut Registry (gemessener session-Block)? */
  kann: boolean;
  /**
   * Ist die Chat-Ansicht fuer diesen Harness ueberhaupt eingeschaltet? Nur die
   * Vorgabe -- eine gesetzte Sitzungs-Uebersteuerung schlaegt dieses Feld.
   */
  erlaubt: boolean;
  rolle: PaneRolle;
  vorgabe: ChatVorgabe;
  /**
   * Das Uebersteuern DIESER Sitzung. `null` (oder gar nicht gesetzt) heisst:
   * es gibt keins, es gilt die Rollenvorgabe.
   */
  uebersteuerung?: boolean | null;
}

export interface AnsichtsUrteil {
  /** Zeigt dieser Pane das Gespraech? Die eine Antwort, die alle Aufrufer wollen. */
  offen: boolean;
  /** Was der Mensch will -- unabhaengig davon, ob es gerade geht. */
  gewuenscht: boolean;
  /** Woraus der Wunsch stammt: aus der Sitzung oder aus der Rollenvorgabe. */
  quelle: 'sitzung' | 'rolle';
  hindernis: Hindernis;
}

/** Die Auflegung selbst. Jede andere Stelle ruft sie, statt sie nachzubauen. */
export function ansichtsUrteil(l: AnsichtsLage): AnsichtsUrteil {
  const gesetzt = typeof l.uebersteuerung === 'boolean';
  const gewuenscht = gesetzt ? l.uebersteuerung === true : l.vorgabe[l.rolle] === true;
  // Nur KANN ist hart und bleibt es immer -- eine fehlende Faehigkeit ist eine
  // fehlende Quelle, keine Einstellung. Der Harness-Schalter (ERLAUBT) ist eine
  // Einstellung, und eine gesetzte Sitzungs-Uebersteuerung schlaegt ihn: `gesetzt`
  // steht deshalb VOR `l.erlaubt` in der Bedingung.
  const hindernis: Hindernis = !l.kann ? 'kann' : (!gesetzt && !l.erlaubt ? 'erlaubt' : '');
  return {
    offen: hindernis === '' && gewuenscht,
    gewuenscht,
    quelle: gesetzt ? 'sitzung' : 'rolle',
    hindernis,
  };
}

/** Die Kurzform fuer alle, die nur das Ja oder Nein brauchen. */
export function ansichtOffen(l: AnsichtsLage): boolean {
  return ansichtsUrteil(l).offen;
}

/**
 * Die Einstellung `chatAnsichtVorgabe`, aus dem gedeutet, was in der Datei
 * steht.
 *
 * EIN ALTER WAHRHEITSWERT WIRFT NICHTS UM: bis zum 12.08. war der Schluessel
 * ein einzelnes `true`/`false`, und in bestehenden Einstellungsdateien steht er
 * genau so. Er wird fuer BEIDE Rollen gleich gedeutet -- das ist, was er damals
 * bedeutet hat -- statt als "unbekannte Form" zu gelten und beide Rollen
 * stillschweigend auf Aus zu setzen.
 */
export function chatVorgabeAus(roh: unknown): ChatVorgabe {
  if (typeof roh === 'boolean') return { orchestrator: roh, worker: roh };
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return { ...KEINE_VORGABE };
  const o = roh as Record<string, unknown>;
  return { orchestrator: o.orchestrator === true, worker: o.worker === true };
}
