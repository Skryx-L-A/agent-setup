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
 *
 * GILT NOCH FUER JEDES FENSTER, DAS MEHRERE PANES TRAEGT: Layout 'split' (die
 * Worker sitzen unter dem Orchestrator im selben Fenster) und jede uebernommene
 * fremde Sitzung. Hat dagegen jeder gezeigte Pane sein eigenes Fenster, ordnet
 * tmux nichts mehr an, und dann gilt `gitterFrei`.
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

/**
 * Das Raster, wenn die Buehne es FREI waehlen darf (03.09.2026, Stufe A).
 *
 * Solange mehrere Worker in EINEM tmux-Fenster sassen, konnte die Buehne nur
 * die drei Formen legen, die tmux auch baut -- und `tiled` waehlt seine
 * Spaltenzahl selbst. Bei fuenf Workern stand deshalb immer einer allein und in
 * voller Breite unter den anderen vieren; eine Reihe zu fuenft oder eine
 * Aufteilung 3 plus 2 war nicht bestellbar.
 *
 * Seit jeder Worker sein eigenes Fenster mit genau EINEM Pane hat, gibt es
 * nichts mehr aufzuteilen: ein Fenster mit einem Pane hat keine Aufteilung,
 * seine Groesse IST die Panegroesse. Das Raster ist dann einfach das, was auf
 * die Flaeche passt -- so wenige Reihen wie moeglich, und die Kacheln so
 * gleichmaessig ueber sie verteilt, wie es aufgeht (siehe `kachelReihen`).
 */
export function gitterFrei(
  anzahl: number,
  perRow: number,
  perColumn: number,
): { spalten: number; zeilen: number } {
  const n = Math.max(1, Math.floor(anzahl));
  const proReihe = Math.max(1, Math.floor(perRow));
  const proSpalte = Math.max(1, Math.floor(perColumn));
  const zeilen = Math.min(proSpalte, Math.max(1, Math.ceil(n / proReihe)));
  return { spalten: Math.max(1, Math.ceil(n / zeilen)), zeilen };
}

/**
 * Wieviele Kacheln in welcher Reihe stehen.
 *
 * FREI verteilt sie so gleichmaessig, wie es aufgeht: sieben Kacheln in drei
 * Reihen sind 3, 2, 2 und nicht 3, 3, 1 -- eine letzte Reihe mit einer einzigen
 * Kachel zieht diese ueber die ganze Breite und laesst die Reihe darueber
 * gedraengt stehen. Fuenf sind 3 und 2, nicht 2, 2 und 1; genau der Fall, den
 * `tiled` nie anders bauen konnte.
 *
 * GEBUNDEN fuellt sie Reihe um Reihe mit `spalten` Kacheln auf, und die letzte
 * bekommt, was uebrig ist. Das ist die Form, die tmux baut, und sie gilt weiter,
 * solange ein Fenster mehrere Panes traegt -- eine schoenere Verteilung waere
 * dort nur eine zweite Geometrie neben der von tmux, also genau der Fehler, den
 * die ganze Rechnung vermeidet.
 *
 * DIESELBE ZAHLENREIHE BRAUCHEN BEIDE SEITEN: der Renderer legt danach seine
 * Kacheln (paneflaeche.ts, `kachelLage`), und der Hauptprozess stellt danach die
 * Fenstergroessen (main.ts, `fensterAufKachel`).
 */
export function kachelReihen(anzahl: number, spalten: number, frei: boolean): number[] {
  const n = Math.max(0, Math.floor(anzahl));
  if (n <= 0) return [];
  const s = Math.max(1, Math.floor(spalten));
  const zeilen = Math.max(1, Math.ceil(n / s));
  if (!frei) return Array.from({ length: zeilen }, (_, i) => Math.min(s, n - i * s));
  const grund = Math.floor(n / zeilen);
  const rest = n % zeilen;
  return Array.from({ length: zeilen }, (_, i) => grund + (i < rest ? 1 : 0));
}

/**
 * Die Kachel JE PANE in Zellen -- dieselbe Rechnung, die der Renderer in
 * Bildpunkten macht (paneflaeche.ts, `kachelLage`), nur in der Waehrung, die
 * tmux versteht.
 *
 * WOZU: Ein Tab, dessen Panes ueber MEHRERE tmux-Fenster liegen, hat kein
 * gemeinsames Raster mehr, an dem sich die Fenstergroesse ablesen liesse. Dann
 * ist die Kachel die einzige gemeinsame Groesse zwischen Buehne und tmux -- und
 * jedes Fenster wird so gross gestellt, dass seine eigene Aufteilung genau
 * diese Kacheln ergibt (main.ts, `fensterAufKachel`). Seit jeder Worker sein
 * eigenes Fenster hat, ist das der Normalfall und nicht die Ausnahme.
 *
 * DIE BESCHRIFTUNGSZEILE STECKT NICHT HIER DRIN (08.09.2026, nachgesehen im
 * Auftrag geometrie). Ein Fenster mit `pane-border-status` hat eine Zeile, die
 * kein Pane bekommt (tmux.ts, `randZeilen`); gezaehlt wird sie genau einmal,
 * naemlich dort, wo die Fenstergroesse geschrieben wird. Diese Rechnung bleibt
 * deshalb, wie sie ist: sie teilt die Buehne unter den Kacheln auf und weiss
 * von tmux-Optionen nichts. Ebenso die Trennlinien zwischen den Panes -- die
 * kommen in main.ts (`fensterAufKachel`) einmal dazu, nicht hier.
 *
 * IN ZELLEN ABGERUNDET, und das ist kein Verlust: `flaeche.cols` ist selbst
 * schon die abgerundete Zellenzahl der Buehne, und `floor(floor(x)/k)` ist
 * `floor(x/k)` -- die Zahl hier ist also dieselbe, die der Renderer aus den
 * Bildpunkten zieht. Was durch das Abrunden uebrig bleibt, wird dort zur Fuge
 * zwischen den Kacheln, statt als schwarzer Rand IN einer Kachel zu stehen.
 */
export function kachelZellen(
  anzahl: number,
  spalten: number,
  frei: boolean,
  flaeche: { cols: number; rows: number },
): { cols: number; rows: number }[] {
  const reihen = kachelReihen(anzahl, spalten, frei);
  if (!reihen.length) return [];
  const hoehe = Math.max(1, Math.floor(flaeche.rows / reihen.length));
  const raus: { cols: number; rows: number }[] = [];
  for (const inZeile of reihen) {
    const breite = Math.max(1, Math.floor(flaeche.cols / inZeile));
    for (let i = 0; i < inZeile; i++) raus.push({ cols: breite, rows: hoehe });
  }
  return raus;
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
  //
  // GERECHNET WIRD MIT DEM GEBUNDENEN RASTER, auch seit es die freie Kachelung
  // gibt: sie packt nie duenner als tmux, die Zahl ist also unter beiden
  // Bauweisen tragfaehig -- und `capacity` weiss nicht, in welcher der Tab
  // gleich gezeigt wird.
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
