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

  // Der dritte Weg (19.08.): eine Wahl, die nur für diese eine Sitzung gilt.
  'knopf.neuWahl': 'Modell für diese Sitzung wählen …',
  'knopf.neuWahlZu': 'Wahl schließen',
  'knopf.neuWahlStart': 'Mit dieser Wahl starten …',
  'wahl.titel': 'Nur für diese Sitzung',
  'wahl.unterzeile':
    'Vorbelegt ist überall, was in den Einstellungen steht — wer nur eine Sache anders will, '
    + 'ändert eine Sache. Die Einstellungsdatei bleibt dabei unberührt; die Wahl endet mit dieser Sitzung.',
  'wahl.harness': 'Programm',
  'wahl.modell': 'Modell',
  'wahl.effort': 'Wie tief die Sitzung denkt',
  'wahl.kontext': 'Kontextfenster',
  'wahl.platzhalterSuche': 'Nach Name oder Kennung filtern …',
  'wahl.keinModell': 'Für dieses Programm ist kein Modell mit der Rolle „Orchestrator" bekannt.',
  'wahl.keinTreffer': 'Kein Modell passt zu dieser Suche.',
  'wahl.keineStufen': 'Dieses Programm kennt keine Denkstufen — es wird keine mitgegeben.',
  'wahl.kontextNurLokal':
    'Nur bei einem Modell, das hier auf der Maschine läuft — bei einem Modell aus der Cloud '
    + 'gehört diese Zahl dem Anbieter.',
  'wahl.kontextWirdErmittelt': 'Die Stufen werden ermittelt …',
  'wahl.kontextNichtErmittelt':
    'Die Stufen ließen sich nicht ermitteln: {grund}. Es geht dann kein Kontextfenster mit, '
    + 'und es gilt, was für dieses Modell eingetragen ist.',
  'wahl.kontextEmpfohlen': 'empfohlen',
  'wahl.kontextToken': '{tokens} Token',
  'wahl.kontextBedarf': 'Braucht {bedarf} GiB.',
  'wahl.nichtStartbar': 'Programm fehlt auf dieser Maschine',
  'wahl.flaggenLeer': 'Ohne eigene Angabe — es gilt, was in den Einstellungen steht.',
  'wahl.laedt': 'Hole, was zur Wahl steht …',
  'wahl.ladefehler': 'Was zur Wahl steht, ließ sich nicht holen: {grund}',

  'platzhalter.fernpfadVorgabe': 'Absoluter Pfad auf der gewählten Maschine …',
  'platzhalter.fernpfad': "Absoluter Pfad auf '{maschine}' …",
  'knopf.pruefen': 'Prüfen',

  'platzhalter.suche': 'Suche nach Name, Ordner oder Maschine …',

  'zustand.laeuft': 'läuft',
  'zustand.wartet': 'wartet',
  'zustand.fern': 'fern',
  'zustand.beendet': 'beendet',
  'zustand.startet': 'startet…',
  'zustand.startFehler': 'Start gescheitert',

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

  'knopf.neuWahl': 'Pick a model for this session …',
  'knopf.neuWahlZu': 'Close the picker',
  'knopf.neuWahlStart': 'Start with this choice …',
  'wahl.titel': 'For this session only',
  'wahl.unterzeile':
    'Everything is prefilled from Settings — change one thing if only one thing should differ. '
    + 'The settings file stays untouched; the choice ends with this session.',
  'wahl.harness': 'Program',
  'wahl.modell': 'Model',
  'wahl.effort': 'How deep the session thinks',
  'wahl.kontext': 'Context window',
  'wahl.platzhalterSuche': 'Filter by name or id …',
  'wahl.keinModell': 'No model with the role "orchestrator" is known for this program.',
  'wahl.keinTreffer': 'No model matches this search.',
  'wahl.keineStufen': 'This program knows no thinking levels — none will be passed.',
  'wahl.kontextNurLokal':
    'Only for a model that runs here on this machine — for a model in the cloud that number '
    + 'belongs to the provider.',
  'wahl.kontextWirdErmittelt': 'Determining the levels …',
  'wahl.kontextNichtErmittelt':
    'The levels could not be determined: {grund}. No context window will be passed, and '
    + 'whatever is registered for this model applies.',
  'wahl.kontextEmpfohlen': 'recommended',
  'wahl.kontextToken': '{tokens} tokens',
  'wahl.kontextBedarf': 'Needs {bedarf} GiB.',
  'wahl.nichtStartbar': 'Program missing on this machine',
  'wahl.flaggenLeer': 'Nothing of its own — whatever is in Settings applies.',
  'wahl.laedt': 'Fetching what there is to choose from …',
  'wahl.ladefehler': 'What there is to choose from could not be fetched: {grund}',

  'platzhalter.fernpfadVorgabe': 'Absolute path on the chosen machine …',
  'platzhalter.fernpfad': "Absolute path on '{maschine}' …",
  'knopf.pruefen': 'Check',

  'platzhalter.suche': 'Search by name, folder, or machine …',

  'zustand.laeuft': 'running',
  'zustand.wartet': 'waiting',
  'zustand.fern': 'remote',
  'zustand.beendet': 'stopped',
  'zustand.startet': 'starting…',
  'zustand.startFehler': 'start failed',

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
