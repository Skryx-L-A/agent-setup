// Der geführte erste Start (SPEC-V4 3.8) -- die REGEL, als reine Funktionen ohne DOM und ohne
// Electron, aus demselben Grund wie filter.ts (sitzung/) oder rechnen.ts (verbrauch/): welcher
// Schritt als nächstes kommt, was ein Übersprungen bedeutet und dass die Einstellung
// `erststartErledigt` am Ende GENAU EINMAL geschrieben wird, ist Logik -- kein Fenster muss dafür
// entstehen. Das Fenster (erststart.ts) hält nur den Zustand und zeichnet ihn; entschieden wird
// hier.
//
// WAS DER WEG FRAGT, und mehr nicht (SPEC-V4 3.8): Maschine, Harness anmelden, Modell, fertig.
// Jeder der ersten drei Schritte kann eine Antwort abliefern -- die drei bestehenden
// Einstellungen `defaultWorkerMachine`, `orchestratorHarness`, `orchestratorModel` --, und jeder
// ist überspringbar: eine übersprungene Frage liefert keine Antwort, und die bestehende Vorgabe
// bleibt stehen. Der vierte Schritt fragt nichts mehr, er schließt ab.
//
// EXAKT EINMAL GESCHRIEBEN: `fortschritt()` ist eine reine Funktion des Zustands. Ist der Ablauf
// bereits `abgeschlossen`, liefert jeder weitere Aufruf denselben Zustand und eine LEERE Liste an
// Schreibungen zurück -- ein doppelter Klick auf "Fertig" (Netzwerk-Verzögerung, Doppelklick)
// erzeugt keinen zweiten Schreibvorgang. Das Fenster muss dafür nichts selbst merken; es ruft
// einfach `fortschritt()` erneut auf und bekommt die leere Liste.

/** Die vier Schritte, in ihrer festen Reihenfolge. */
export type SchrittName = 'maschine' | 'harness' | 'modell' | 'fertig';

export const SCHRITTE: readonly SchrittName[] = ['maschine', 'harness', 'modell', 'fertig'];

/**
 * Welche Antwort auf welchen Einstellungs-Schlüssel geht.
 *
 * VIER Schlüssel bei drei Schritten, und das ist kein Versehen: der dritte
 * Schritt kann ZWEI Antworten abliefern. Wer dort ein Modell wählt, das auf
 * dieser Maschine läuft, wählt darunter auch sein Kontextfenster -- eine Frage,
 * die es bei einem Modell aus der Cloud gar nicht gibt und die deshalb keinen
 * eigenen Schritt bekommt: sie wäre bei den meisten Wahlen eine leere Seite.
 * `kontext` ist damit der einzige Eintrag ohne gleichnamigen Schritt; er wird
 * über `mitKontext()` gesetzt und wie die anderen genau einmal geschrieben.
 */
export const SCHLUESSEL: Readonly<Record<'maschine' | 'harness' | 'modell' | 'kontext', string>> = {
  maschine: 'defaultWorkerMachine',
  harness: 'orchestratorHarness',
  modell: 'orchestratorModel',
  kontext: 'orchestratorKontext',
};

/** Der Schlüssel, der den Weg als erledigt markiert -- geschrieben genau einmal, beim Abschluss. */
export const ERLEDIGT_SCHLUESSEL = 'erststartErledigt';

/** Die Antworten. `kontext` ist eine Tokenzahl, die drei anderen sind Kennungen. */
export type AntwortName = 'maschine' | 'harness' | 'modell' | 'kontext';

export interface ErststartZustand {
  readonly index: number;
  readonly antworten: Readonly<Partial<Record<AntwortName, string | number>>>;
  readonly abgeschlossen: boolean;
}

export interface SettingsSchreibung {
  key: string;
  value: unknown;
}

/** Der Zustand vor dem ersten Schritt. */
export function anfang(): ErststartZustand {
  return { index: 0, antworten: {}, abgeschlossen: false };
}

/** Der Name des Schritts, der jetzt dran ist. Nach dem Abschluss bleibt es 'fertig'. */
export function schrittName(z: ErststartZustand): SchrittName {
  return SCHRITTE[Math.min(z.index, SCHRITTE.length - 1)];
}

/** Ist der letzte Schritt (die Zusammenfassung) erreicht? */
export function istLetzterSchritt(z: ErststartZustand): boolean {
  return schrittName(z) === 'fertig';
}

export function istAbgeschlossen(z: ErststartZustand): boolean {
  return z.abgeschlossen;
}

interface Ergebnis {
  zustand: ErststartZustand;
  /** Was jetzt WIRKLICH geschrieben werden soll -- leer, außer beim Abschluss. */
  schreibungen: SettingsSchreibung[];
}

/**
 * Die eine Stelle, an der ein Schritt endet -- mit oder ohne Antwort. `antwort` fehlt beim
 * Überspringen; dann bleibt die bestehende Einstellung unangetastet, weil `SCHLUESSEL[name]`
 * gar nicht erst in die Liste der Schreibungen kommt.
 */
function fortschritt(z: ErststartZustand, antwort: string | undefined): Ergebnis {
  // Nach dem Abschluss ist jeder weitere Aufruf ein Nichts-Tun -- siehe Kopfkommentar.
  if (z.abgeschlossen) return { zustand: z, schreibungen: [] };

  const name = schrittName(z);
  if (name === 'fertig') {
    const schreibungen: SettingsSchreibung[] = [];
    for (const schritt of Object.keys(SCHLUESSEL) as AntwortName[]) {
      const wert = z.antworten[schritt];
      if (wert !== undefined) schreibungen.push({ key: SCHLUESSEL[schritt], value: wert });
    }
    schreibungen.push({ key: ERLEDIGT_SCHLUESSEL, value: true });
    return { zustand: { ...z, abgeschlossen: true }, schreibungen };
  }

  const antworten = antwort !== undefined ? { ...z.antworten, [name]: antwort } : z.antworten;
  return { zustand: { index: z.index + 1, antworten, abgeschlossen: false }, schreibungen: [] };
}

/** Eine Antwort für den aktuellen Schritt setzen und weitergehen. Auf 'fertig': abschließen. */
export function weiter(z: ErststartZustand, antwort: string): Ergebnis {
  return fortschritt(z, antwort);
}

/** Den aktuellen Schritt OHNE Antwort überspringen. Auf 'fertig': ebenfalls abschließen. */
export function ueberspringen(z: ErststartZustand): Ergebnis {
  return fortschritt(z, undefined);
}

/**
 * Das gewählte Kontextfenster festhalten -- die zweite Antwort des dritten
 * Schritts. Sie hat keinen eigenen Schritt (siehe SCHLUESSEL), deshalb einen
 * eigenen Setzer statt `weiter()`.
 *
 * `0` LÖSCHT die Antwort wieder. Das ist der Fall "erst ein lokales Modell
 * gewählt, dann doch eines aus der Cloud": ohne dieses Zurücknehmen bliebe eine
 * Tokenzahl in der Liste stehen und würde am Ende geschrieben, obwohl das
 * gewählte Modell gar kein Fenster zur Wahl stellt.
 */
export function mitKontext(z: ErststartZustand, tokens: number): ErststartZustand {
  if (z.abgeschlossen) return z;
  const antworten = { ...z.antworten };
  if (tokens > 0) antworten.kontext = tokens;
  else delete antworten.kontext;
  return { ...z, antworten };
}

/**
 * Soll sich das Erststart-Fenster von selbst zeigen? Reine Umkehrung des gespeicherten Standes --
 * eigens benannt, damit main.ts nicht `!erststartErledigt(...)` an zwei Stellen unterschiedlich
 * liest.
 */
export function sollErststartZeigen(erledigt: boolean): boolean {
  return erledigt !== true;
}
