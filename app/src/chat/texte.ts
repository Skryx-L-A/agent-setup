// DIE TEXTE DER CHAT-ANSICHT -- alle, an einer Stelle.
//
// Dieselbe Bauart wie in den vier Geschwistern (app/src/einstellungen/texte.ts,
// app/src/verbrauch/texte.ts, app/src/sitzung/texte.ts, app/src/erststart/texte.ts): eine
// Tabelle je Sprache, `DE` und `EN`, umgeschaltet ueber `setzeSprache()`.
//
// DIE VIER `grund.*`-SCHLUESSEL SIND MESSAUSSAGE, KEIN MARKETINGTEXT. Sie sagen, warum ein
// Harness gerade nichts zeigt -- „kein gemessener session-Block", „die Quelle liess sich nicht
// lesen: {fehler}". Die englische Fassung bleibt genauso genau: kein „not available" fuer einen
// Satz, der einen Grund benennt, kein Weglassen des `{fehler}`-Platzhalters. Die LAENGEREN
// Begruendungssaetze, die einzelne Harnesses (acp.ts, registry.ts, zuordnung.ts) direkt
// zurueckgeben, stehen NICHT hier -- sie sind Teil der Entscheidungslogik, nicht dieser
// Beschriftungstabelle, und bleiben unangetastet.
//
// DIE SCHLUESSEL:
//   rolle.<name>       die vier Sprecher einer Zeile
//   kopf.<name>        die Kopfzeile der Ansicht
//   bruecke.<name>     was vom Bildschirm kommt und nicht aus dem Protokoll
//   grund.<name>       die Saetze, mit denen ein Nein begruendet wird
//   wort.<name>        einzelne Woerter der Bedienung
//
// PLATZHALTER stehen in geschweiften Klammern und bleiben stehen, wenn der Wert
// fehlt -- ein sichtbares `{harness}` ist eine Meldung, ein stilles Loch ist
// keine.

export type Sprache = 'de' | 'en';

export const DE: Record<string, string> = {
  // Der Fenstertitel des Hauptfensters, das die Ansicht traegt -- derselbe Schluessel wie in
  // den vier Geschwistern, hier ohne Unterzeile: das Hauptfenster ist mehr als nur die
  // Chat-Ansicht.
  'fenster.titel': 'Agent-Workbench',
  'rolle.mensch': 'Du',
  'rolle.agent': 'Programm',
  'rolle.system': 'System',
  'rolle.werkzeug': 'Werkzeug',

  'kopf.titel': 'Gespräch',
  'kopf.quelle': 'Quelle: {quelle}',
  'kopf.terminal': 'Terminal zeigen',
  'kopf.gespraech': 'Gespräch zeigen',
  'kopf.hinweis': 'Die Ansicht liegt über dem Pane. Getippt wird weiterhin im Terminal.',

  'bruecke.freigabe': 'Es wartet eine Freigabe.',
  'bruecke.freigabe.herkunft': 'vom Bildschirm gelesen, im Protokoll steht sie nicht',
  'bruecke.auslastung': 'Kontext {prozent} %',
  'bruecke.auslastung.zahlen': '{tokens} von {fenster} Token',
  'bruecke.auslastung.fehlt': 'Kontextauslastung unbekannt',
  'bruecke.arbeitet': 'arbeitet',
  'bruecke.ruhig': 'wartet',

  // WOHER die Zuordnung kommt. Die drei Wege sind nicht gleich gut, und die
  // Ansicht sagt das -- ein Gespraech aus dem Rueckfall sieht sonst genauso
  // sicher aus wie eins, das der Harness selbst zugeordnet hat.
  'herkunft.hook': 'Sitzung gemeldet',
  'herkunft.hook.titel': 'Das Programm im Pane hat seine Sitzungskennung selbst gemeldet. Eindeutig.',
  'herkunft.vermerk': 'Sitzung vermerkt',
  'herkunft.vermerk.titel': 'Die Werkbank hat sich die Unterhaltung dieses Panes beim Start notiert. '
    + 'Eindeutig, solange im Pane nicht mit /clear eine neue begonnen wurde.',
  'herkunft.pid': 'Prozess gemeldet',
  'herkunft.pid.titel': 'Die Sitzung nennt die Prozesskennung dieses Panes. Eindeutig.',
  'herkunft.ordner': 'über Ordner und Zeit',
  'herkunft.ordner.titel': 'Rückfall: gewählt wurde die jüngste Sitzungsdatei dieses Arbeitsverzeichnisses. '
    + 'Laufen zwei Sitzungen im selben Ordner, zeigt die Ansicht lieber nichts, statt zu raten.',

  'grund.keinBlock': 'Für diesen Harness steht kein gemessener session-Block in der Registry.',
  'grund.aus': 'Für {harness} ist die Gesprächsansicht ausgeschaltet.',
  'grund.leer': 'Aus dieser Quelle steht noch keine Zeile.',
  'grund.nichtGelesen': 'Die Quelle ließ sich nicht lesen: {fehler}',

  'wort.laedt': 'wird gelesen …',
  'wort.gekuerzt': '[…gekürzt]',
  'wort.denken': 'Überlegung',

  // DER BILD-PLATZHALTER (chat/bildplatzhalter.ts): der Harness legt neben
  // einem eingefügten Bild einen eigenen Eintrag mit Anzeigegröße und
  // Umrechnungsfaktor an -- reine Bildschirmauswertung, kein Gesprächsbeitrag.
  // Gezeigt wird nur die Originalgröße, in diesem einen Satz.
  'bild.mass': 'Bild ({breite}×{hoehe})',
  // Die zweite gemessene Form traegt nur einen Dateipfad, keine Groesse --
  // der Pfad erscheint nie (Reviewer-Befund B3, 12.08.).
  'bild.ohneMass': 'Bild',
};

/**
 * ENGLISCH, die Auslieferungssprache. Gleiche Schluessel, gleiche Reihenfolge wie DE --
 * Bedienoberflaeche, kein Fliesstext: kurz, in der Sprache, die englische Programme benutzen.
 */
export const EN: Record<string, string> = {
  'fenster.titel': 'Agent Workbench',
  'rolle.mensch': 'You',
  'rolle.agent': 'Program',
  'rolle.system': 'System',
  'rolle.werkzeug': 'Tool',

  'kopf.titel': 'Conversation',
  'kopf.quelle': 'Source: {quelle}',
  'kopf.terminal': 'Show terminal',
  'kopf.gespraech': 'Show conversation',
  'kopf.hinweis': 'This view sits over the pane. Typing still happens in the terminal.',

  'bruecke.freigabe': 'An approval is waiting.',
  'bruecke.freigabe.herkunft': 'read off the screen, not in the transcript',
  'bruecke.auslastung': 'Context {prozent}%',
  'bruecke.auslastung.zahlen': '{tokens} of {fenster} tokens',
  'bruecke.auslastung.fehlt': 'Context usage unknown',
  'bruecke.arbeitet': 'working',
  'bruecke.ruhig': 'waiting',

  'herkunft.hook': 'session reported',
  'herkunft.hook.titel': 'The program in this pane reported its own session id. Unambiguous.',
  'herkunft.vermerk': 'session on record',
  'herkunft.vermerk.titel': 'The workbench noted this pane’s conversation when it started. '
    + 'Unambiguous unless /clear started a new one in the pane.',
  'herkunft.pid': 'process reported',
  'herkunft.pid.titel': 'The session names this pane’s process id. Unambiguous.',
  'herkunft.ordner': 'by folder and time',
  'herkunft.ordner.titel': 'Fallback: the newest session file of this working directory was chosen. '
    + 'With two sessions in one folder the view shows nothing rather than guess.',

  'grund.keinBlock': 'No measured session block is registered for this harness.',
  'grund.aus': 'The conversation view is switched off for {harness}.',
  'grund.leer': 'No line has come from this source yet.',
  'grund.nichtGelesen': 'The source could not be read: {fehler}',

  'wort.laedt': 'reading …',
  'wort.gekuerzt': '[…shortened]',
  'wort.denken': 'Reasoning',

  'bild.mass': 'Image ({breite}×{hoehe})',
  'bild.ohneMass': 'Image',
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

/** Die eine Abfrage. Ein fehlender Schluessel wird SICHTBAR gemeldet. */
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

/** Alle Schluessel der Auslieferungssprache -- fuer Pruefungen und die Uebersetzung. */
export function alleSchluessel(): string[] {
  return Object.keys(DE).sort();
}
