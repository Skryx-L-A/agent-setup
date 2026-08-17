// Die aufklappbare Flaeche (4c.2): Ordneransicht, Aktivitaetsliste und
// Freigaben teilen sich denselben Platz, immer nur eine ist offen. Jede
// Ansicht meldet sich hier einmal an; das Oeffnen einer schliesst die
// anderen -- an EINER Stelle geregelt, statt dass jede Ansicht von den
// anderen beiden weiss.
export interface Ansicht {
  name: string;
  offen(): boolean;
  oeffnen(): void;
  schliessen(): void;
}

const ansichten: Ansicht[] = [];

export function registriere(a: Ansicht): void {
  ansichten.push(a);
}

/** Knopf-Klick: schon offen -> zu; sonst diese auf, alle anderen zu. */
export function umschalten(name: string): void {
  const ziel = ansichten.find((a) => a.name === name);
  if (!ziel) return;
  if (ziel.offen()) {
    ziel.schliessen();
    return;
  }
  for (const a of ansichten) if (a !== ziel) a.schliessen();
  ziel.oeffnen();
}
