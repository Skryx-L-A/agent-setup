// DIE TEXTE DES SITZUNGSFENSTERS -- alle, an einer Stelle.
//
// Dieselbe Bauart wie app/src/einstellungen/texte.ts und app/src/verbrauch/texte.ts: eine
// Tabelle je Sprache, abgefragt ueber die eine Funktion `t()`. Bis zum 11.08. standen die
// Beschriftungen dieses Fensters literal im Quelltext von sitzung.ts und index.html -- eine
// zweite Sprache haette einen Durchgang durch beide Dateien gebraucht.
//
// WAS HIER NICHT STEHT: die Meldungen, die der Hauptprozess ueber `awb:sitz-neu`,
// `awb:sitz-fortsetzen`, `awb:sitz-beenden` und `awb:sitz-fern-pruefen` zurueckgibt
// (main.ts). Sie sind Ergebnis einer Handlung -- „ausgeschlossen", „Abgebrochen", „gefunden" --
// und geteilt mit dem Kontextmenue der Sessionleiste; sie ziehen mit, wenn die dortige
// Sprachschicht kommt, nicht hier.
//
// PLATZHALTER stehen in geschweiften Klammern: `t('satz.x', { maschine: 'peer' })`.

/** Die Sprachen dieses Fensters. Beide tragen eine vollstaendige Tabelle. */
export type Sprache = 'de' | 'en';

/** Sortiert wie das Fenster: Kopfzeile, Fernzeile, Filter, Liste, Fusszeile. */
export const DE: Record<string, string> = {
  'fenster.titel': 'Agent-Workbench — Sitzungen',
  'kopf.titel': 'Sitzungen',
  'kopf.unterzeile':
    'Nach Projektordner gruppiert, die zuletzt benutzte oben. Jede bekannte Sitzung steht '
    + 'hier, auch die beendeten und die zweite und dritte desselben Ordners.',
  'platzhalter.name': 'Name (optional)',
  'knopf.neu': 'Neue Sitzung …',
  // Der zweite Weg (12.08.): eine Chat-Sitzung als Prozess dieser App, ohne tmux.
  'knopf.neuChat': 'Neue Chat-Sitzung …',

  'platzhalter.fernpfadVorgabe': 'Absoluter Pfad auf der gewählten Maschine …',
  'platzhalter.fernpfad': "Absoluter Pfad auf '{maschine}' …",
  'knopf.pruefen': 'Prüfen',

  'platzhalter.suche': 'Suche nach Name, Ordner oder Maschine …',

  'zustand.laeuft': 'läuft',
  'zustand.wartet': 'wartet',
  'zustand.fern': 'fern',
  'zustand.beendet': 'beendet',

  'satz.ohneOrdner': '(ohne Ordner)',
  'zeit.nieAktiv': 'nie aktiv',
  'satz.dieseMaschine': '{maschine} (diese Maschine)',
  'wort.alle': 'Alle {n}',
  'wort.sitzungenAnzahl': '{n} Sitzungen',
  'satz.keineSitzungBekannt': 'Es ist keine Sitzung bekannt.',
  'satz.waehleSitzung': 'Eine Sitzung wählen — was mit ihrer Unterhaltung geschieht, steht dann hier.',

  'satz.erstOrdnerEintragen': "Erst einen Ordner auf '{maschine}' eintragen.",
  'satz.erstPfadEintragen': 'Erst einen Pfad eintragen.',
  'satz.pruefeGerade': 'Prüfe …',
  'satz.holeZurueck': 'Hole die Sitzung zurück …',

  'knopf.beenden': 'Beenden',
  'knopf.fortsetzen': 'Fortsetzen',
};

/**
 * ENGLISCH, die Auslieferungssprache. Gleiche Schluessel, gleiche Reihenfolge wie DE.
 * Bedienoberflaeche, kein Fliesstext -- kurz, in der Sprache, die englische Programme
 * benutzen. Befehle, Pfade und Schluesselnamen bleiben woertlich stehen.
 */
export const EN: Record<string, string> = {
  'fenster.titel': 'Agent Workbench — Sessions',
  'kopf.titel': 'Sessions',
  'kopf.unterzeile':
    'Grouped by project folder, most recently used on top. Every known session is listed '
    + 'here, including the stopped ones and a second or third one in the same folder.',
  'platzhalter.name': 'Name (optional)',
  'knopf.neu': 'New Session …',
  'knopf.neuChat': 'New Chat Session …',

  'platzhalter.fernpfadVorgabe': 'Absolute path on the chosen machine …',
  'platzhalter.fernpfad': "Absolute path on '{maschine}' …",
  'knopf.pruefen': 'Check',

  'platzhalter.suche': 'Search by name, folder, or machine …',

  'zustand.laeuft': 'running',
  'zustand.wartet': 'waiting',
  'zustand.fern': 'remote',
  'zustand.beendet': 'stopped',

  'satz.ohneOrdner': '(no folder)',
  'zeit.nieAktiv': 'never active',
  'satz.dieseMaschine': '{maschine} (this machine)',
  'wort.alle': 'All {n}',
  'wort.sitzungenAnzahl': '{n} sessions',
  'satz.keineSitzungBekannt': 'No session is known.',
  'satz.waehleSitzung': 'Pick a session — what happens to its conversation shows up here.',

  'satz.erstOrdnerEintragen': "Enter a folder on '{maschine}' first.",
  'satz.erstPfadEintragen': 'Enter a path first.',
  'satz.pruefeGerade': 'Checking …',
  'satz.holeZurueck': 'Bringing the session back …',

  'knopf.beenden': 'Stop',
  'knopf.fortsetzen': 'Resume',
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
 * DIE EINE ABFRAGE. Ein fehlender Schluessel wird SICHTBAR gemeldet und nicht durch einen
 * leeren Text ersetzt.
 */
export function t(schluessel: string, werte?: Record<string, string | number>): string {
  const tabelle = TABELLEN[aktuelleSprache] ?? DE;
  const roh = tabelle[schluessel] ?? DE[schluessel];
  if (roh === undefined) return `[fehlender Text: ${schluessel}]`;
  if (!werte) return roh;
  return roh.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (ganz, name: string) => {
    const w = werte[name];
    return w === undefined ? ganz : String(w);
  });
}

/** Nur fuer Tests und fuer die Uebersetzung: alle Schluessel der Referenztabelle (Deutsch). */
export function alleSchluessel(): string[] {
  return Object.keys(DE).sort();
}
