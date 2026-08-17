// Alle Beschriftungen der Verbrauchsseite an EINEM Ort.
//
// WARUM NICHT IM CODE. Zwei Tabellen, DE und EN, umgeschaltet ueber `setzeSprache()` -- wer
// uebersetzt, uebersieht sonst genau die drei Zeichenketten, die in einem `if`-Zweig stehen, und
// die Seite spricht danach zwei Sprachen. Abgefragt wird ausschliesslich ueber `t()`.
//
// WAS HIER NICHT STEHT: die Begruendungen, die `wb-budget` selbst mitliefert (der Grund einer
// Naeherung, der Grund einer Luecke, der Hinweis einer Quelle). Sie sind MESSERGEBNIS, nicht
// Beschriftung -- sie gehoeren zu der Zahl, die sie einschraenken, und wandern mit ihr. Wer die
// Seite uebersetzt, uebersetzt sie an ihrer Quelle in shell/wb-budget, nicht hier.

/** Die Sprachen dieser Seite. Beide tragen eine vollstaendige Tabelle. */
export type Sprache = 'de' | 'en';

/** Sortiert wie die Oberflaeche: Rahmen, dann Abschnitt fuer Abschnitt von oben nach unten. */
export const DE: Record<string, string> = {
  // --- Rahmen ---------------------------------------------------------------
  'fenster.titel': 'Agent-Workbench — Verbrauch',
  'kopf.titel': 'Verbrauch',
  'kopf.unterzeile': 'Alle Harnesses, die auf dieser Maschine eine lesbare Spur hinterlassen. Zeitraum, Harness und Modell lassen sich unten einschränken.',
  'laden': 'wird gelesen …',
  'fehler.titel': 'Der Verbrauch ließ sich nicht lesen',
  'leer': 'Im gewählten Zeitraum ist nichts verbucht.',
  'stand': 'Stand {0}, Zeitraum {1} bis {2}',

  // --- Zeitraum -------------------------------------------------------------
  'zeitraum.titel': 'Zeitraum',
  'zeitraum.1': 'heute',
  'zeitraum.2': '2 Tage',
  'zeitraum.7': '7 Tage',
  'zeitraum.14': '14 Tage',
  'zeitraum.30': '30 Tage',

  // --- Filter ---------------------------------------------------------------
  'filter.harness': 'Harness',
  'filter.modell': 'Modell',
  'filter.alle': 'alle',
  'filter.zuruecksetzen': 'Auswahl aufheben',
  'filter.aktiv': 'Es zählt nur, was zu allen gewählten Merkmalen zugleich passt.',

  // --- Die Summen -----------------------------------------------------------
  'summe.titel': 'Gesamt',
  'summe.gesamt': 'Verbrauch gesamt',
  // Der Vergleich beschriftet seine Zeilen ueber den FELDNAMEN (summe.<feld>). Dieser hier
  // meint dasselbe wie 'summe.gesamt', muss aber unter seinem Feldnamen auffindbar sein.
  'summe.ohne_cache_read': 'Verbrauch gesamt',
  'summe.gesamt.hinweis': 'Eingabe, Ausgabe und Cache-Schreiben zusammen. Cache-Lesen steht getrennt daneben, siehe unten.',
  'summe.input': 'Eingabe',
  'summe.output': 'Ausgabe',
  'summe.cache_write': 'Cache-Schreiben',
  'summe.cache_read': 'Cache-Lesen',
  'summe.reasoning': 'Denken',
  'summe.nachrichten': 'Nachrichten',

  // --- Cache-Lesen ----------------------------------------------------------
  'cache.titel': 'Cache-Lesen, getrennt gezeichnet',
  'cache.grund': 'Cache-Lesen ist im gewählten Zeitraum {0}-mal so groß wie alles übrige zusammen. Auf einer gemeinsamen linearen Achse bliebe vom Rest ein Strich — deshalb zwei Diagramme statt eines.',
  'cache.grund.klein': 'Cache-Lesen ist im gewählten Zeitraum {0}-mal so groß wie alles übrige. Das trägt eine gemeinsame Achse noch.',
  'cache.diagramm.ohne': 'Eingabe, Ausgabe, Cache-Schreiben',
  'cache.diagramm.nur': 'Cache-Lesen allein',

  // --- Tagesverlauf ---------------------------------------------------------
  'tage.titel': 'Verlauf je Tag',
  'tage.hinweis': 'UTC-Tagesgrenzen, dieselben wie im Bericht von wb-budget.',
  'tage.leer': 'Für diesen Zeitraum liegen keine Tageswerte vor.',

  // --- Harnesses ------------------------------------------------------------
  'harness.titel': 'Je Harness',
  'harness.spalte': 'Harness',

  // --- Modelle --------------------------------------------------------------
  'modell.titel': 'Je Modell',
  'modell.spalte': 'Modell',

  // --- Tempo ----------------------------------------------------------------
  'tempo.titel': 'Token je Sekunde, je Modell',
  'tempo.spalte': 'Token/s',
  'tempo.gemessen': 'gemessen',
  'tempo.naeherung': 'Näherung',
  'tempo.unbekannt': 'nicht messbar',
  'tempo.zeichen.naeherung': '≈',
  'tempo.warnung': 'Nur die mit {0} bezeichneten Zahlen sind eine echte Generierungsrate. Alle übrigen sind eine Wanduhr-Näherung aus Zeitstempeln: Denkzeit, Netz und Werkzeugpausen zählen mit. Der Fehler ist weder klein noch gleichbleibend.',
  'tempo.grundlage': 'gemessene Zeit: {0} s',

  // --- Kosten ---------------------------------------------------------------
  'kosten.titel': 'Geld und Kontingent',
  'kosten.zwei': 'Zwei Größen mit verschiedenen Nennern, die nie zu einer Zahl addiert werden: ein Dollarbetrag gilt nur, wo ein Anbieter pro Token abrechnet — die Abo-Zugänge zahlen stattdessen einen Anteil ihres Kontingents.',
  'kosten.usd': 'Betrag',
  'kosten.art': 'Art',
  'kosten.art.abo-aequivalent': 'API-Äquivalent',
  'kosten.art.katalogpreis': 'Listenpreis',
  'kosten.art.harness-angabe': 'vom Harness selbst gerechnet',
  'kosten.art.kein-preis': 'kein Preis bekannt',
  'kosten.nie_abgebucht': 'nie abgebucht — dieser Betrag sagt, was derselbe Verbrauch über die API gekostet hätte. Bezahlt wurde ein Abo.',
  'kosten.aiu': 'AIC (Copilots eigene Abrechnungseinheit)',
  'kosten.summe.aequivalent': 'Summe API-Äquivalent (nie abgebucht)',
  'kosten.summe.katalog': 'Summe Listenpreis',
  'kosten.ohne': 'ohne Preis',

  // --- Kontingent -----------------------------------------------------------
  'kontingent.titel': 'Kontingent je Harness',
  'kontingent.verbraucht': 'verbraucht',
  'kontingent.rest': 'übrig',
  'kontingent.zurueck': 'fällt zurück am {0}',
  'kontingent.erschoepft': 'erschöpft',
  'kontingent.keins': 'kein Kontingent',
  'kontingent.fehlt': 'Kein Kontingentstand verfügbar: {0}',
  'kontingent.werkzeug.fehlt': 'wb-kontingent liegt auf diesem Stand des Programms nicht vor.',

  // --- Limit ----------------------------------------------------------------
  'limit.titel': 'Der Weg zum Limit',
  'limit.5h': '5-Stunden-Fenster',
  'limit.7d': '7-Tage-Fenster',
  'limit.stand': 'zuletzt {0}',
  'limit.reset': 'Rücksetzpunkt',
  'limit.reset.anzahl': 'Rücksetzpunkte im Zeitraum: {0}',
  'limit.reset.naechster': 'nächster Rücksetzpunkt: {0}',
  'limit.leer': 'Für diesen Zeitraum ist kein Limit-Stand geloggt.',
  'limit.quelle': 'Aus ~/.claude/workbench/limits.jsonl, das die Statusleiste bei jedem Zeichnen fortschreibt. Es gilt für das Anthropic-Konto als Ganzes, nicht je Modell.',

  // --- Sitzungen und Worker -------------------------------------------------
  'sitzung.titel': 'Je Sitzung und Worker',
  'sitzung.spalte': 'Sitzung',
  'sitzung.worker': 'Worker',
  'sitzung.ordner': 'Ordner',
  'sitzung.zeitraum': 'von … bis',
  'sitzung.ohne_worker': '—',
  'sitzung.mehr': 'weitere {0} Sitzungen nicht gezeigt',

  // --- Vergleich ------------------------------------------------------------
  'vergleich.titel': 'Zwei Zeiträume nebeneinander',
  'vergleich.knopf': 'Mit dem Zeitraum davor vergleichen',
  'vergleich.aus': 'Vergleich schließen',
  'vergleich.jetzt': 'gewählter Zeitraum',
  'vergleich.vorher': 'der gleich lange davor',
  'vergleich.differenz': 'Unterschied',
  'vergleich.laedt': 'der frühere Zeitraum wird gelesen …',
  'vergleich.kein_vorher': 'Im früheren Zeitraum ist nichts verbucht — ein Prozentwert wäre hier eine Division durch null.',

  // --- Lücken ---------------------------------------------------------------
  'luecke.titel': 'Was hier nicht stehen kann',
  'luecke.einleitung': 'Diese Harnesses führt die Registry, aber sie hinterlassen auf dieser Maschine keine lesbare Verbrauchsspur. Sie fehlen nicht, weil nichts verbraucht wurde, sondern weil nichts zu messen ist.',
  'luecke.spalte': 'Harness',
  'luecke.grund': 'Grund',

  // --- Quellen --------------------------------------------------------------
  'quelle.titel': 'Woher die Zahlen kommen',
  'quelle.spalte': 'Quelle',
  'quelle.zustand.gelesen': 'gelesen',
  'quelle.zustand.leer': 'vorhanden, aber im Zeitraum ohne Eintrag',
  'quelle.zustand.fehlt': 'auf dieser Maschine nicht vorhanden',
  'quelle.zustand.unlesbar': 'nicht lesbar',
  'quelle.nachrichten': '{0} Nachrichten',

  // --- Zustandszeichen (keine Emojis) --------------------------------------
  'zeichen.gelesen': '●',
  'zeichen.leer': '○',
  'zeichen.fehlt': '–',
  'zeichen.unlesbar': '✕',
  'zeichen.mehr': '▲',
  'zeichen.weniger': '▼',
  'zeichen.gleich': '=',
};

/**
 * ENGLISCH, die Auslieferungssprache. Gleiche Schluessel, gleiche Reihenfolge wie DE --
 * Bedienoberflaeche, kein Fliesstext: kurz, in der Sprache, die englische Programme benutzen.
 * Befehle, Pfade, Dateinamen und Schluesselnamen bleiben woertlich stehen.
 */
export const EN: Record<string, string> = {
  // --- Frame ---------------------------------------------------------------
  'fenster.titel': 'Agent Workbench — Usage',
  'kopf.titel': 'Usage',
  'kopf.unterzeile': 'Every harness that leaves a readable trace on this machine. Narrow it down below by time range, harness, and model.',
  'laden': 'reading …',
  'fehler.titel': 'Usage could not be read',
  'leer': 'Nothing is booked in the chosen time range.',
  'stand': 'As of {0}, range {1} to {2}',

  // --- Time range -------------------------------------------------------------
  'zeitraum.titel': 'Range',
  'zeitraum.1': 'today',
  'zeitraum.2': '2 days',
  'zeitraum.7': '7 days',
  'zeitraum.14': '14 days',
  'zeitraum.30': '30 days',

  // --- Filter ---------------------------------------------------------------
  'filter.harness': 'Harness',
  'filter.modell': 'Model',
  'filter.alle': 'all',
  'filter.zuruecksetzen': 'Clear selection',
  'filter.aktiv': 'Only what matches every chosen trait at once counts.',

  // --- The totals -----------------------------------------------------------
  'summe.titel': 'Total',
  'summe.gesamt': 'Total usage',
  // Der Vergleich beschriftet seine Zeilen ueber den FELDNAMEN (summe.<feld>). Dieser hier
  // meint dasselbe wie 'summe.gesamt', muss aber unter seinem Feldnamen auffindbar sein.
  'summe.ohne_cache_read': 'Total usage',
  'summe.gesamt.hinweis': 'Input, output, and cache write together. Cache read stands separately next to it, see below.',
  'summe.input': 'Input',
  'summe.output': 'Output',
  'summe.cache_write': 'Cache write',
  'summe.cache_read': 'Cache read',
  'summe.reasoning': 'Reasoning',
  'summe.nachrichten': 'Messages',

  // --- Cache read ----------------------------------------------------------
  'cache.titel': 'Cache read, drawn separately',
  'cache.grund': 'In the chosen range, cache read is {0} times the size of everything else combined. On a shared linear axis the rest would flatten to a line — hence two charts instead of one.',
  'cache.grund.klein': 'In the chosen range, cache read is {0} times the size of everything else. A shared axis still carries that.',
  'cache.diagramm.ohne': 'Input, output, cache write',
  'cache.diagramm.nur': 'Cache read alone',

  // --- Daily trend ---------------------------------------------------------
  'tage.titel': 'Trend by day',
  'tage.hinweis': 'UTC day boundaries, the same ones wb-budget\'s report uses.',
  'tage.leer': 'No daily figures are available for this range.',

  // --- Harnesses ------------------------------------------------------------
  'harness.titel': 'By harness',
  'harness.spalte': 'Harness',

  // --- Models --------------------------------------------------------------
  'modell.titel': 'By model',
  'modell.spalte': 'Model',

  // --- Speed ----------------------------------------------------------------
  'tempo.titel': 'Tokens per second, by model',
  'tempo.spalte': 'Tokens/s',
  'tempo.gemessen': 'measured',
  'tempo.naeherung': 'estimate',
  'tempo.unbekannt': 'not measurable',
  'tempo.zeichen.naeherung': '≈',
  'tempo.warnung': 'Only the numbers marked {0} are a real generation rate. Every other one is a wall-clock estimate from timestamps: thinking time, network, and tool pauses count too. The error is neither small nor consistent.',
  'tempo.grundlage': 'measured time: {0} s',

  // --- Cost ---------------------------------------------------------------
  'kosten.titel': 'Money and quota',
  'kosten.zwei': 'Two figures with different denominators, never added into one number: a dollar amount only applies where a provider bills per token — subscription access instead spends a share of its quota.',
  'kosten.usd': 'Amount',
  'kosten.art': 'Kind',
  'kosten.art.abo-aequivalent': 'API equivalent',
  'kosten.art.katalogpreis': 'List price',
  'kosten.art.harness-angabe': 'computed by the harness itself',
  'kosten.art.kein-preis': 'no known price',
  'kosten.nie_abgebucht': 'never charged — this amount says what the same usage would have cost through the API. What was actually paid was a subscription.',
  'kosten.aiu': 'AIC (Copilot\'s own billing unit)',
  'kosten.summe.aequivalent': 'Total API equivalent (never charged)',
  'kosten.summe.katalog': 'Total list price',
  'kosten.ohne': 'no price',

  // --- Quota -----------------------------------------------------------
  'kontingent.titel': 'Quota by harness',
  'kontingent.verbraucht': 'used',
  'kontingent.rest': 'left',
  'kontingent.zurueck': 'resets on {0}',
  'kontingent.erschoepft': 'exhausted',
  'kontingent.keins': 'no quota',
  'kontingent.fehlt': 'No quota status available: {0}',
  'kontingent.werkzeug.fehlt': 'wb-kontingent is not present on this build of the program.',

  // --- Limit ----------------------------------------------------------------
  'limit.titel': 'The path to the limit',
  'limit.5h': '5-hour window',
  'limit.7d': '7-day window',
  'limit.stand': 'last {0}',
  'limit.reset': 'Reset point',
  'limit.reset.anzahl': 'Reset points in this range: {0}',
  'limit.reset.naechster': 'next reset point: {0}',
  'limit.leer': 'No limit status is logged for this range.',
  'limit.quelle': 'From ~/.claude/workbench/limits.jsonl, which the status bar appends to on every draw. It applies to the Anthropic account as a whole, not per model.',

  // --- Sessions and workers -------------------------------------------------
  'sitzung.titel': 'By session and worker',
  'sitzung.spalte': 'Session',
  'sitzung.worker': 'Worker',
  'sitzung.ordner': 'Folder',
  'sitzung.zeitraum': 'from … to',
  'sitzung.ohne_worker': '—',
  'sitzung.mehr': '{0} further sessions not shown',

  // --- Comparison ------------------------------------------------------------
  'vergleich.titel': 'Two ranges side by side',
  'vergleich.knopf': 'Compare with the range before',
  'vergleich.aus': 'Close comparison',
  'vergleich.jetzt': 'chosen range',
  'vergleich.vorher': 'the equally long one before it',
  'vergleich.differenz': 'Difference',
  'vergleich.laedt': 'reading the earlier range …',
  'vergleich.kein_vorher': 'Nothing is booked in the earlier range — a percentage here would be a division by zero.',

  // --- Gaps ---------------------------------------------------------------
  'luecke.titel': 'What cannot show up here',
  'luecke.einleitung': 'These harnesses are listed in the registry, but leave no readable usage trace on this machine. They are not missing because nothing was used, but because there is nothing to measure.',
  'luecke.spalte': 'Harness',
  'luecke.grund': 'Reason',

  // --- Sources --------------------------------------------------------------
  'quelle.titel': 'Where the numbers come from',
  'quelle.spalte': 'Source',
  'quelle.zustand.gelesen': 'read',
  'quelle.zustand.leer': 'present, but no entry in this range',
  'quelle.zustand.fehlt': 'not present on this machine',
  'quelle.zustand.unlesbar': 'not readable',
  'quelle.nachrichten': '{0} messages',

  // --- State marks (no emoji) --------------------------------
  'zeichen.gelesen': '●',
  'zeichen.leer': '○',
  'zeichen.fehlt': '–',
  'zeichen.unlesbar': '✕',
  'zeichen.mehr': '▲',
  'zeichen.weniger': '▼',
  'zeichen.gleich': '=',
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
 * Der Text zu einem Schluessel, mit `{0}`, `{1}` … als Platzhalter.
 *
 * Ein UNBEKANNTER Schluessel liefert den Schluessel selbst zurueck, sichtbar in eckigen
 * Klammern -- nicht die leere Zeichenkette. Eine leere Beschriftung faellt niemandem auf und
 * bleibt jahrelang stehen; `[modell.spaltee]` auf dem Bildschirm faellt beim ersten Blick auf.
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

/** Nur fuer Tests und fuer die Uebersetzung: alle Schluessel der Referenztabelle (Deutsch). */
export function alleSchluessel(): string[] {
  return Object.keys(DE);
}
