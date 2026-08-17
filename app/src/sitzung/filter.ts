// Suche, Filter und Maschinen-Chips der Fortsetzen-Liste -- als REINE
// Funktionen aus sitzung.ts herausgezogen, aus demselben Grund wie bei
// revive.ts/ampel.ts/pfad.ts (siehe app/build.mjs): sitzung.ts selbst laedt
// beim Einlesen sofort das DOM (`document.getElementById`) und laesst sich
// darum nicht in einem nackten node-Prozess pruefen. Diese Datei tut das
// nicht -- sie kennt nur Daten, kein Fenster -- und wird darum ein zweites Mal
// als eigenes ESM-Buendel gebaut (dist/test/sitzung-filter.mjs), pruefbar ohne
// Electron und ohne einen einzigen Klick.
//
// DIESELBE BEDIENLOGIK WIE DIE MODELLWAHL (Vorbild: einstellungen.ts,
// `modellwahl`, Zeilen 546-614): eine Chip-Reihe aus den tatsaechlich
// vorkommenden Werten, "Alle N" davor, und keine Reihe, wenn es ohnehin nur
// einen Wert gibt -- ein Umschalter mit einer einzigen Stellung ist keiner.
// Das gilt hier fuer ZWEI Dimensionen (Maschine und Zustand), darum als
// generische Funktion statt zweimal derselben Schleife.

export interface Chip {
  wert: string;
  label: string;
}

/**
 * Chip-Reihe aus den Werten, die in `zeilen` WIRKLICH vorkommen -- nie aus
 * einer mitgebrachten Liste. Damit skaliert die Reihe von selbst mit jeder
 * Zahl an Maschinen oder Zustaenden, ohne dass hier eine Grenze oder ein Name
 * stuende. Leer, solange es hoechstens einen Wert gibt.
 */
export function chipsAus<T>(
  zeilen: readonly T[],
  schluessel: (z: T) => string,
  label: (schluessel: string, anzahl: number) => string,
  alleLabel: (gesamt: number) => string,
): Chip[] {
  const proSchluessel = new Map<string, number>();
  for (const z of zeilen) {
    const s = schluessel(z);
    proSchluessel.set(s, (proSchluessel.get(s) ?? 0) + 1);
  }
  if (proSchluessel.size < 2) return [];
  return [
    { wert: 'alle', label: alleLabel(zeilen.length) },
    ...[...proSchluessel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => ({ wert: s, label: label(s, n) })),
  ];
}

/** Die drei Felder, ueber die eine Zeile gefunden werden kann -- Name, Ordner, Maschine. */
export interface SuchZeile {
  name: string;
  dir: string;
  machine: string;
}

/** Ob eine Zeile zum Suchtext passt. Leerer Text (auch nur Leerzeichen) passt auf alles. */
export function zeilePasstSuche(z: SuchZeile, suche: string): boolean {
  const n = suche.trim().toLowerCase();
  if (!n) return true;
  return (
    z.name.toLowerCase().includes(n)
    || z.dir.toLowerCase().includes(n)
    || z.machine.toLowerCase().includes(n)
  );
}

/** Ob eine Zeile zum gewaehlten Maschinen-Chip passt. 'alle' passt immer. */
export function zeilePasstMaschine(z: { machine: string }, filter: string): boolean {
  return filter === 'alle' || z.machine === filter;
}

/**
 * Ob eine Zeile zum gewaehlten Zustands-Chip passt. Verglichen wird der ROHE
 * Zustand (`state`, z.B. 'running'/'stopped'), nicht das Wort auf dem Chip --
 * der Chip traegt sein Wort ueber `zustandMarke` (sitzung.ts), dieselbe
 * Uebersetzung wie an der Marke jeder Zeile. Ein neuer Zustandswert braucht
 * damit keine zweite Stelle, die ihn kennen muss.
 */
export function zeilePasstZustand(z: { state: string }, filter: string): boolean {
  return filter === 'alle' || z.state === filter;
}
