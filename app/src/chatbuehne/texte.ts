// DIE TEXTE DES CHAT-FENSTERS -- alle, an einer Stelle.
//
// Dieselbe Bauart wie in den fuenf Geschwistern (app/src/chat/texte.ts,
// app/src/einstellungen/texte.ts, app/src/verbrauch/texte.ts,
// app/src/sitzung/texte.ts, app/src/erststart/texte.ts): eine Tabelle je
// Sprache, umgeschaltet ueber `setzeSprache()`. shell/tests/test-app-sprache-paritaet.sh
// findet diese Datei von selbst -- sie muss dort nirgends eingetragen werden.
//
// PLATZHALTER stehen in geschweiften Klammern und bleiben stehen, wenn der
// Wert fehlt -- ein sichtbares `{name}` ist eine Meldung, ein stilles Loch ist
// keine.

export type Sprache = 'de' | 'en';

export const DE: Record<string, string> = {
  'fenster.titel': 'Agent-Workbench — Chat',

  'eingabe.platzhalter': 'Claude fragen …',
  'eingabe.senden': 'Senden',
  'eingabe.hinweis': 'Eingabe sendet, Umschalt+Eingabe macht einen Zeilenumbruch. „/" zeigt die Befehle, „@" die Dateien.',
  'eingabe.haengtNach': 'Du hast hochgerollt — die Ansicht folgt neuen Zeilen nicht mehr. Nach unten rollen holt sie zurück.',
  'knopf.neustart': 'Frisch starten',
  'knopf.halt': 'Den laufenden Zug unterbrechen (Escape)',

  'modus.wechseln': 'Freigabemodus: {modus} — Klick schaltet zum nächsten weiter.',
  'modus.abgelehnt': 'Der Harness hat die Umschaltung abgelehnt: {grund}',

  'worker.titel': 'Worker',
  'worker.wechseln': 'Zu „{name}" wechseln — das Gespräch bleibt im Hintergrund und läuft weiter.',
  'worker.beendet': '„{name}" läuft nicht mehr. Der Pane steht noch; ein Klick zeigt, was zuletzt darin stand.',

  'vervoll.befehle': 'Befehle',
  'vervoll.dateien': 'Dateien im Projektordner',
  'vervoll.dateien.ohneGit': 'Dateien im Projektordner — ohne git gelesen, nur die .gitignore der Wurzel gilt',

  'status.modell': 'Das Modell, mit dem diese Sitzung läuft.',
  'status.kontext': 'Kontextfenster zu {prozent} % belegt — belegte Tokens des letzten Zuges gegen die Fenstergröße aus der Modell-Registry.',
  'status.kontext.ohneFenster': 'Belegte Tokens des letzten Zuges. Die Fenstergröße dieses Modells steht nicht in der Registry, deshalb kein Balken.',
  'status.5h': 'Anteil des 5-Stunden-Kontingents des Anthropic-Kontos{reset}. Dieselbe Quelle wie die Statuszeile im Terminal.',
  'status.7d': 'Anteil des 7-Tage-Kontingents des Anthropic-Kontos. Dieselbe Quelle wie die Statuszeile im Terminal.',
  'status.kosten': 'Aufgelaufene Kosten, so wie der Harness sie nennt.',

  'kopf.ordner': 'Ordner: {ordner}',
  'kopf.modus': 'Modus: {modus}',
  'kopf.tokens': '{tokens} Token',
  'kopf.kosten': '{kosten} $',

  'zustand.arbeitet': 'arbeitet',
  'zustand.wartet': 'wartet',
  'zustand.freigabe': 'wartet auf Freigabe',
  'zustand.beendet': 'beendet',
  'zustand.fehler': 'Fehler',

  'wort.denken': 'Denken',
  'wort.ein': 'EIN',
  'wort.aus': 'AUS',
  'wort.laeuft': 'läuft',
  'wort.fehler': 'Fehler',
  'wort.du': 'Du',

  'freigabe.frage': '{name} darf ausgeführt werden?',
  'freigabe.erlauben': 'Erlauben',
  'freigabe.ablehnen': 'Ablehnen',
  'freigabe.erlaubt': 'Erlaubt',
  'freigabe.abgelehnt': 'Abgelehnt',
  'freigabe.grund': 'Vom Menschen abgelehnt.',
  'freigabe.zurueckgezogen': 'Zurückgezogen',
  'freigabe.defekt': 'Ohne Kennung — diese Frage lässt sich nicht beantworten.',

  'leer.titel': 'Noch kein Gespräch',
  'leer.satz': 'Schreib unten etwas, und die Sitzung beginnt.',
};

export const EN: Record<string, string> = {
  'fenster.titel': 'Agent Workbench — Chat',

  'eingabe.platzhalter': 'Ask Claude …',
  'eingabe.senden': 'Send',
  'eingabe.hinweis': 'Enter sends, Shift+Enter starts a new line. "/" lists the commands, "@" the files.',
  'eingabe.haengtNach': 'You scrolled up — the view no longer follows new lines. Scroll to the bottom to bring it back.',
  'knopf.neustart': 'Start fresh',
  'knopf.halt': 'Interrupt the running turn (Escape)',

  'modus.wechseln': 'Permission mode: {modus} — click switches to the next one.',
  'modus.abgelehnt': 'The harness refused the switch: {grund}',

  'worker.titel': 'Workers',
  'worker.wechseln': 'Switch to "{name}" — the conversation stays in the background and keeps running.',
  'worker.beendet': '"{name}" is no longer running. Its pane is still there; a click shows what was last in it.',

  'vervoll.befehle': 'Commands',
  'vervoll.dateien': 'Files in the project folder',
  'vervoll.dateien.ohneGit': 'Files in the project folder — read without git, only the root .gitignore applies',

  'status.modell': 'The model this session runs on.',
  'status.kontext': 'Context window {prozent} % used — tokens of the last turn against the window size from the model registry.',
  'status.kontext.ohneFenster': 'Tokens of the last turn. The registry has no window size for this model, so there is no bar.',
  'status.5h': "Share of the Anthropic account's 5-hour quota{reset}. Same source as the status line in the terminal.",
  'status.7d': "Share of the Anthropic account's 7-day quota. Same source as the status line in the terminal.",
  'status.kosten': 'Accrued cost, exactly as the harness reports it.',

  'kopf.ordner': 'Folder: {ordner}',
  'kopf.modus': 'Mode: {modus}',
  'kopf.tokens': '{tokens} tokens',
  'kopf.kosten': '${kosten}',

  'zustand.arbeitet': 'working',
  'zustand.wartet': 'idle',
  'zustand.freigabe': 'waiting for approval',
  'zustand.beendet': 'ended',
  'zustand.fehler': 'error',

  'wort.denken': 'Thinking',
  'wort.ein': 'IN',
  'wort.aus': 'OUT',
  'wort.laeuft': 'running',
  'wort.fehler': 'Error',
  'wort.du': 'You',

  'freigabe.frage': 'Allow {name} to run?',
  'freigabe.erlauben': 'Allow',
  'freigabe.ablehnen': 'Deny',
  'freigabe.erlaubt': 'Allowed',
  'freigabe.abgelehnt': 'Denied',
  'freigabe.grund': 'Denied by the operator.',
  'freigabe.zurueckgezogen': 'Withdrawn',
  'freigabe.defekt': 'No request id — this question cannot be answered.',

  'leer.titel': 'No conversation yet',
  'leer.satz': 'Write something below and the session starts.',
};

let tabelle = DE;

export function setzeSprache(s: string | undefined): void {
  tabelle = s === 'en' ? EN : DE;
}

export function t(schluessel: string, werte: Record<string, string | number> = {}): string {
  const roh = tabelle[schluessel] ?? DE[schluessel] ?? schluessel;
  return roh.replace(/\{(\w+)\}/g, (ganz, name: string) => {
    const w = werte[name];
    return w === undefined ? ganz : String(w);
  });
}
