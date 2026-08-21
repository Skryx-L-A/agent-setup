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

/**
 * Das Raster, das `select-layout tiled` in tmux WIRKLICH baut.
 *
 * Es haengt allein an der ZAHL der Panes, nicht an der Fenstergroesse, und es
 * ist nicht `perRow` aus der Kapazitaetsrechnung. Genau dieser Unterschied war
 * der Fehler: die Buehne rechnete mit `min(perRow, anzahl)` Spalten und
 * `ceil(anzahl / spalten)` Reihen, tmux baute sein eigenes Raster, und beide
 * Ordnungen stimmten nur zufaellig ueberein -- bei sieben Panes verlangte die
 * Buehne zwei Spalten, tmux legte drei.
 *
 * NACHGEMESSEN am 19.08. gegen echtes tmux (eigener Socket, Fenster 134x43,
 * `select-layout tiled` fuer 1 bis 8 Panes): 1 -> 1x1, 2 -> 1x2, 3 -> 2x2,
 * 4 -> 2x2, 5 -> 2x3, 6 -> 2x3, 7 -> 3x3, 8 -> 3x3 (Spalten x Reihen). Die
 * letzte Reihe fuellt tmux dabei mit den uebrigen Panes auf die volle Breite --
 * ein leerer Platz entsteht in seinem Raster nie.
 */
export function tiledRaster(anzahl: number): { spalten: number; zeilen: number } {
  const n = Math.max(1, Math.floor(anzahl));
  let zeilen = 1;
  let spalten = 1;
  while (zeilen * spalten < n) {
    zeilen++;
    if (zeilen * spalten < n) spalten++;
  }
  return { spalten, zeilen };
}

/**
 * Das Raster, in dem `anzahl` Panes gezeigt werden -- und das tmux dazu auch
 * bauen KANN.
 *
 * Erzwingen laesst sich nur eine Spalte (`even-vertical`) und eine Reihe
 * (`even-horizontal`); alles dazwischen waehlt `tiled` selbst. Deshalb folgt
 * das Raster genau diesen drei Faellen, statt sich eine Form auszudenken, die
 * tmux hinterher nicht liefert.
 */
export function gitterFuer(
  anzahl: number,
  perRow: number,
  perColumn: number,
): { spalten: number; zeilen: number } {
  const n = Math.max(1, Math.floor(anzahl));
  if (perRow <= 1) return { spalten: 1, zeilen: n };
  if (perColumn <= 1 || n <= perRow) return { spalten: n, zeilen: 1 };
  return tiledRaster(n);
}

export function capacity(input: CapacityInput): CapacityResult {
  const perRow = Math.max(1, Math.floor(input.cols / Math.max(1, input.minCols)));
  const perColumn = Math.max(1, Math.floor(input.rows / Math.max(1, input.minRows)));
  // WIEVIELE PANES WIRKLICH IN EINEN TAB PASSEN -- nicht mehr `perRow *
  // perColumn`.
  //
  // Das Produkt beantwortet eine Frage, die niemand stellt: es gibt an, wieviele
  // Kacheln auf die Flaeche passten, WENN man sie frei legen koennte. Legen tut
  // sie aber tmux, und sein Raster ist ein anderes (siehe tiledRaster). Bei
  // perRow 2 und perColumn 4 kam so perTab 8 heraus -- fuer acht Panes baut tmux
  // aber drei Spalten, und jede davon ist schmaler als die Mindestbreite, um
  // derentwillen perRow ueberhaupt gerechnet wird. Gesucht ist deshalb die
  // groesste Zahl, deren Raster noch in perRow x perColumn passt.
  let passt = 1;
  for (let n = 1; n <= perRow * perColumn; n++) {
    const g = gitterFuer(n, perRow, perColumn);
    if (g.spalten > perRow || g.zeilen > perColumn) break;
    passt = n;
  }
  const perTab = Math.max(1, Math.min(passt, input.maxPerTab));
  return { perRow, perColumn, perTab, cappedBySetting: perTab < passt };
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
