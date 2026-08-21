// Alle Beschriftungen des geführten ersten Starts an EINEM Ort -- dieselbe Bauart wie
// app/src/einstellungen/texte.ts, app/src/verbrauch/texte.ts und app/src/sitzung/texte.ts: eine
// Tabelle je Sprache, `DE` und `EN`, abgefragt ueber `t()`. Dieses Fenster ist das erste, das ein
// fremder Mensch sieht -- die wichtigste der vier Uebersetzungen.

/** Die Sprachen dieses Fensters. Beide tragen eine vollstaendige Tabelle. */
export type Sprache = 'de' | 'en';

export const DE: Record<string, string> = {
  'fenster.titel': 'Agent-Workbench — Erste Schritte',
  'kopf.titel': 'Erste Schritte',
  'kopf.unterzeile': 'Vier kurze Fragen, jede überspringbar. Alles andere bleibt auf Vorgabe und lässt sich später in den Einstellungen ändern.',

  // --- Fortschritt ------------------------------------------------------
  'fortschritt.schritt': 'Schritt {0} von {1}',

  // --- Knöpfe -------------------------------------------------------------
  'knopf.weiter': 'Weiter',
  'knopf.ueberspringen': 'Überspringen',
  'knopf.fertig': 'Fertig',

  // --- Schritt 1: Maschine -------------------------------------------------
  'maschine.titel': 'Maschine',
  'maschine.unterzeile': 'Auf welcher Maschine sollen Worker standardmäßig laufen?',
  'maschine.nurEine': 'Auf diesem Rechner ist bisher keine weitere Maschine eingerichtet — es bleibt bei „diese Maschine". Weitere Maschinen lassen sich später über die Seite „Maschinen" hinzufügen.',
  'maschine.diese': 'diese Maschine ({0})',

  // --- Schritt 2: Harness ---------------------------------------------------
  'harness.titel': 'Harness anmelden',
  'harness.unterzeile': 'Mit welchem Programm soll der Orchestrator arbeiten? Die Anmeldung selbst läuft außerhalb dieses Fensters, im Terminal des jeweiligen Programms.',
  'harness.stand.ja': 'angemeldet',
  'harness.stand.nein': 'nicht angemeldet',
  'harness.stand.unbekannt': 'nicht prüfbar',
  'harness.zeichen.ja': '●',
  'harness.zeichen.nein': '✕',
  'harness.zeichen.unbekannt': '–',
  'harness.keine': 'Auf dieser Maschine ist kein startbares Programm gefunden. Dieser Schritt lässt sich später über die Seite „Programme und Modelle" nachholen.',

  // --- Schritt 3: Modell -----------------------------------------------------
  'modell.titel': 'Modell',
  'modell.unterzeile': 'Welches Modell soll der Orchestrator verwenden?',
  'modell.keine': 'Für das gewählte Programm ist noch kein Modell bekannt. Dieser Schritt lässt sich später über die Seite „Programme und Modelle" nachholen.',

  // --- Schritt 3, zweite Frage: das Kontextfenster ---------------------------
  // Sie steht nur da, wenn das gewählte Modell auf dieser Maschine läuft.
  'kontext.titel': 'Kontextfenster',
  'kontext.unterzeile': 'Wie viel Text dieses Modell gleichzeitig im Kopf behält. Ein größeres Fenster hält mehr Zusammenhang und belegt dauerhaft mehr Grafikspeicher. Wählbar ist jede Stufe — auch eine, für die der Speicher gerade nicht reicht; sie sagt es dann dazu.',
  'kontext.empfohlen': 'empfohlen',
  'kontext.token': '{0} Token',
  'kontext.bedarf': 'Braucht {0} GiB.',
  'kontext.wirdErmittelt': 'Die Stufen werden ermittelt …',
  'kontext.nichtErmittelt': 'Die Stufen ließen sich nicht ermitteln: {0}. Das Fenster bleibt dann bei dem, was für dieses Modell eingetragen ist; ändern lässt es sich später in den Einstellungen.',

  // --- Schritt 4: Fertig -----------------------------------------------------
  'fertig.titel': 'Fertig',
  'fertig.unterzeile': 'Das war’s — alles andere bleibt auf Vorgabe.',
  'fertig.satz.gesetzt': 'Gesetzt: {0}.',
  'fertig.satz.nichtsGesetzt': 'Es wurde nichts geändert — alles bleibt auf Vorgabe.',
  'fertig.satz.aendernWo': 'Ändern lässt sich das jederzeit über die Einstellungen, Seiten „Programme und Modelle" und „Maschinen".',
  'fertig.eintrag.maschine': 'Maschine „{0}"',
  'fertig.eintrag.harness': 'Programm „{0}"',
  'fertig.eintrag.modell': 'Modell „{0}"',
  'fertig.eintrag.kontext': 'Kontextfenster {0} Token',

  // --- Zustandszeichen (keine Emojis) --------------------------------------
  'zeichen.gewaehlt': '●',
  'zeichen.wahl': '○',
};

/**
 * ENGLISCH, die Auslieferungssprache. Gleiche Schluessel, gleiche Reihenfolge wie DE --
 * Bedienoberflaeche, kein Fliesstext: kurz, in der Sprache, die englische Programme benutzen.
 */
export const EN: Record<string, string> = {
  'fenster.titel': 'Agent Workbench — First Steps',
  'kopf.titel': 'First Steps',
  'kopf.unterzeile': 'Four short questions, each skippable. Everything else stays at its default and can be changed later in Settings.',

  // --- Progress ------------------------------------------------------
  'fortschritt.schritt': 'Step {0} of {1}',

  // --- Buttons -------------------------------------------------------------
  'knopf.weiter': 'Next',
  'knopf.ueberspringen': 'Skip',
  'knopf.fertig': 'Done',

  // --- Step 1: Machine -------------------------------------------------
  'maschine.titel': 'Machine',
  'maschine.unterzeile': 'Which machine should workers run on by default?',
  'maschine.nurEine': 'No other machine is set up on this computer yet — it stays at "this machine". Further machines can be added later on the "Machines" page.',
  'maschine.diese': 'this machine ({0})',

  // --- Step 2: Harness ---------------------------------------------------
  'harness.titel': 'Sign in a harness',
  'harness.unterzeile': 'Which program should the orchestrator work with? Signing in itself happens outside this window, in that program\'s own terminal.',
  'harness.stand.ja': 'signed in',
  'harness.stand.nein': 'not signed in',
  'harness.stand.unbekannt': 'not checkable',
  'harness.zeichen.ja': '●',
  'harness.zeichen.nein': '✕',
  'harness.zeichen.unbekannt': '–',
  'harness.keine': 'No startable program was found on this machine. This step can be caught up later on the "Programs and models" page.',

  // --- Step 3: Model -----------------------------------------------------
  'modell.titel': 'Model',
  'modell.unterzeile': 'Which model should the orchestrator use?',
  'modell.keine': 'No model is known yet for the chosen program. This step can be caught up later on the "Programs and models" page.',

  // --- Step 3, second question: the context window ---------------------------
  'kontext.titel': 'Context window',
  'kontext.unterzeile': 'How much text this model keeps in mind at once. A larger window holds more context and permanently occupies more GPU memory. Every level is selectable — including one the memory does not cover right now; it says so.',
  'kontext.empfohlen': 'recommended',
  'kontext.token': '{0} tokens',
  'kontext.bedarf': 'Needs {0} GiB.',
  'kontext.wirdErmittelt': 'Determining the levels …',
  'kontext.nichtErmittelt': 'The levels could not be determined: {0}. The window then stays at whatever is registered for this model; it can be changed later in Settings.',

  // --- Step 4: Done -----------------------------------------------------
  'fertig.titel': 'Done',
  'fertig.unterzeile': "That's it — everything else stays at its default.",
  'fertig.satz.gesetzt': 'Set: {0}.',
  'fertig.satz.nichtsGesetzt': 'Nothing was changed — everything stays at its default.',
  'fertig.satz.aendernWo': 'This can be changed at any time via Settings, on the "Programs and models" and "Machines" pages.',
  'fertig.eintrag.maschine': 'Machine "{0}"',
  'fertig.eintrag.harness': 'Program "{0}"',
  'fertig.eintrag.modell': 'Model "{0}"',
  'fertig.eintrag.kontext': 'Context window {0} tokens',

  // --- State marks (no emoji) --------------------------------
  'zeichen.gewaehlt': '●',
  'zeichen.wahl': '○',
};

/** Die Tabellen je Sprache. */
const TABELLEN: Record<Sprache, Record<string, string>> = { de: DE, en: EN };

let aktuelleSprache: Sprache = 'en';

/** Die Sprache umstellen. Ein unbekannter oder fehlender Wert faellt auf Englisch zurueck. */
export function setzeSprache(s: string | undefined): void {
  aktuelleSprache = s === 'de' ? 'de' : 'en';
}

/** Welche Sprache gerade gilt. */
export function sprache(): Sprache {
  return aktuelleSprache;
}

/**
 * Der Text zu einem Schlüssel, mit `{0}`, `{1}` … als Platzhalter.
 *
 * Ein UNBEKANNTER Schlüssel liefert den Schlüssel selbst zurück, sichtbar in eckigen Klammern --
 * nicht die leere Zeichenkette. Eine leere Beschriftung fällt niemandem auf und bleibt jahrelang
 * stehen; `[modell.titell]` auf dem Bildschirm fällt beim ersten Blick auf.
 */
export function t(schluessel: string, ...werte: (string | number)[]): string {
  const tabelle = TABELLEN[aktuelleSprache] ?? DE;
  const roh = tabelle[schluessel] ?? DE[schluessel];
  if (roh === undefined) return `[${schluessel}]`;
  return roh.replace(/\{(\d+)\}/g, (treffer, nr) => {
    const w = werte[Number(nr)];
    return w === undefined ? treffer : String(w);
  });
}

/** Nur für Tests und für die Übersetzung: alle Schlüssel der Referenztabelle (Deutsch). */
export function alleSchluessel(): string[] {
  return Object.keys(DE);
}
