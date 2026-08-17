// Wie viele Worker in einen Tab passen (A13, V8) und wer das Layout anfassen
// darf (F14).
//
// Die Zahl wird ABGELEITET und nicht gesetzt. Der Kontext-Guard erblindet unter
// 80 Spalten je Pane; ein Pane, das darunter faellt, ist auch fuer einen
// Menschen nicht mehr lesbar. Also rechnet die Flaeche aus, wie viele Panes
// hineinpassen, und die Einstellung setzt nur eine Obergrenze darueber.
//
// Zwei Worker gehoeren in EINEN Tab. Ein zweiter Tab entsteht erst, wenn die
// Mindestbreite es verlangt, nie weil eine feste Zahl erreicht ist.

export interface CapacityInput {
  /** Spalten, die dem Terminalbereich zur Verfuegung stehen. */
  cols: number;
  /** Zeilen, die dem Terminalbereich zur Verfuegung stehen. */
  rows: number;
  minCols: number;
  minRows: number;
  /** Obergrenze aus den Einstellungen. */
  maxPerTab: number;
}

export interface CapacityResult {
  /** Panes nebeneinander. */
  perRow: number;
  /** Panes uebereinander. */
  perColumn: number;
  /** Panes je Tab, Obergrenze eingerechnet. */
  perTab: number;
  /** Ob die Obergrenze aus den Einstellungen gegriffen hat. */
  cappedBySetting: boolean;
}

export function capacity(input: CapacityInput): CapacityResult {
  const perRow = Math.max(1, Math.floor(input.cols / Math.max(1, input.minCols)));
  const perColumn = Math.max(1, Math.floor(input.rows / Math.max(1, input.minRows)));
  const roh = perRow * perColumn;
  const perTab = Math.max(1, Math.min(roh, input.maxPerTab));
  return { perRow, perColumn, perTab, cappedBySetting: perTab < roh };
}

/**
 * Aufteilung der Worker auf Tabs. Subagenten sind hier bewusst nicht dabei:
 * sie belegen zwar einen Pane, aber keinen Platz in dieser Rechnung (V19).
 * Genau das Mitzaehlen hat am 04.08. aus zwei Workern zwei Tabs gemacht.
 */
export function tabsFor(workerCount: number, perTab: number): number {
  if (workerCount <= 0) return 0;
  return Math.ceil(workerCount / Math.max(1, perTab));
}

/**
 * F14, und die Regel ist nicht verhandelbar: Solange die Extension danebenlaeuft,
 * ordnet dieses Programm NUR die tmux-Fenster der Sessions, die es selbst
 * angelegt hat. Erkennbar an der Benutzer-Option am tmux-Objekt. Alle anderen
 * werden gezeichnet und nicht angefasst -- zwei Programme, die dieselben Panes
 * nach verschiedenen Vorstellungen umraeumen, zerlegen laufende Arbeit.
 */
export function mayArrange(session: { owned: boolean }): boolean {
  return session.owned === true;
}
