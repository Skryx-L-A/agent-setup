// Bruecke zwischen Hauptprozess und Oberflaeche. Bewusst schmal: der Renderer
// bekommt die Ereignisse, die er zum Zeichnen braucht, und drei Wege zurueck --
// Bereitschaft melden, Eingabe schicken, Bedienung melden.
import { contextBridge, ipcRenderer } from 'electron';

export interface SessionPayload {
  session: string;
  cols: number;
  rows: number;
  sizePolicy: string;
  windows: { windowId: string; name: string; width: number; height: number; active: boolean }[];
  panes: { paneId: string; windowId: string; width: number; height: number; active: boolean }[];
  activePane: string;
  initialContent: string;
}

// Editor (Schritt 6, A3): eigener, kleiner Namensraum statt Erweiterung von
// awbBridge -- die Anfragen brauchen Antworten (invoke/handle), wo awbBridge
// bisher nur feuert und vergisst (send). Die Logik selbst steckt in
// src/main/editor.ts, hier steht nur die Bruecke.
contextBridge.exposeInMainWorld('awbEditorBridge', {
  listFiles: (root: string) => ipcRenderer.invoke('awb:editor-list-files', root),
  readFile: (root: string, rel: string) => ipcRenderer.invoke('awb:editor-read-file', root, rel),
  writeFile: (root: string, rel: string, content: string) => ipcRenderer.invoke('awb:editor-write-file', root, rel, content),
  sendSelection: (paneId: string, text: string) => ipcRenderer.invoke('awb:editor-send-selection', paneId, text),
  // V15/V18 (Schritt 9): Inhalt, Diff und Auftragskontext eines
  // Aktivitaets-Eintrags -- alle drei landen "in der Mitte", deshalb dieselbe
  // Bruecke wie die projektbezogenen Dateien oben.
  aktivitaetRead: (pfad: string) => ipcRenderer.invoke('awb:aktivitaet-read', pfad),
  aktivitaetDiff: (pfad: string) => ipcRenderer.invoke('awb:aktivitaet-diff', pfad),
  aktivitaetAuftrag: (pfad: string) => ipcRenderer.invoke('awb:aktivitaet-auftrag', pfad),
  // V16: die konfigurierte Protokoll-Liste, und eine ihrer Dateien lesen.
  protokolleList: () => ipcRenderer.invoke('awb:protokolle-list'),
  protokolleRead: (pfad: string) => ipcRenderer.invoke('awb:protokolle-read', pfad),
  // SPEC-V4 Abschnitt 6: der Gespraechsstand eines Panes. Nur lesen -- die
  // Eingabe bleibt am Pane, und dieser Weg fuehrt in keine Richtung zurueck.
  chatStand: (paneId: string) => ipcRenderer.invoke('awb:chat-stand', paneId),
  // Die Sprache der Oberflaeche -- derselbe geteilte Kanal wie bei der Verbrauchsseite
  // (main.ts, `awb:sprache`), hier fuer den Dokumenttitel und `<html lang>` des Hauptfensters.
  sprache: () => ipcRenderer.invoke('awb:sprache'),
});

contextBridge.exposeInMainWorld('awbBridge', {
  ready: () => ipcRenderer.send('awb:ready'),
  onSession: (fn: (p: SessionPayload) => void) => ipcRenderer.on('awb:session', (_e, p) => fn(p)),
  onOutput: (fn: (p: { paneId: string; data: string }) => void) => ipcRenderer.on('awb:output', (_e, d) => fn(d)),
  // Eine Ansicht kann MEHRERE Panes haben: die Aufteilung kommt mit.
  onLayout: (fn: (p: unknown) => void) => ipcRenderer.on('awb:layout', (_e, p) => fn(p)),
  onModel: (fn: (p: unknown) => void) => ipcRenderer.on('awb:model', (_e, p) => fn(p)),
  // V20: die Freigabe-Ansicht -- Antraege und angehaltene Worker.
  onFreigaben: (fn: (p: unknown) => void) => ipcRenderer.on('awb:freigaben', (_e, p) => fn(p)),
  // Schritt 7: das HTML einer uebernommenen Seite, fertig gerendert.
  onSeite: (fn: (p: unknown) => void) => ipcRenderer.on('awb:seite', (_e, p) => fn(p)),
  // Reste-Auftrag Punkt 3: die Datei hinter einer Seite hat sich von aussen
  // geaendert -- nur die Meldung, welche; ob neu gezeichnet wird, entscheidet
  // der Renderer selbst (seiten-view.ts: aufDateiAendern).
  onDateiGeaendert: (fn: (p: unknown) => void) => ipcRenderer.on('awb:datei-geaendert', (_e, p) => fn(p)),
  // Vor einer Handlung mit Nebenwirkung: was geschehen wird. Und danach: was es tat.
  onPlan: (fn: (p: unknown) => void) => ipcRenderer.on('awb:plan', (_e, p) => fn(p)),
  onPlanErgebnis: (fn: (p: unknown) => void) => ipcRenderer.on('awb:plan-ergebnis', (_e, p) => fn(p)),
  // V2: eine Ergebnisdatei ist entstanden. Kommt einzeln, sobald sie da ist.
  onErgebnis: (fn: (p: unknown) => void) => ipcRenderer.on('awb:ergebnis', (_e, p) => fn(p)),
  // 4c: Ordneransicht, Aktivitaetsliste, Inhaltssuche -- je eine Antwort auf Zuruf.
  onOrdner: (fn: (p: unknown) => void) => ipcRenderer.on('awb:ordner', (_e, p) => fn(p)),
  // Ob die Anwendung in einem Pane die Maus verfolgt -- nachgefuehrt im Takt.
  onMaus: (fn: (p: unknown) => void) => ipcRenderer.on('awb:maus', (_e, p) => fn(p)),
  onAktivitaet: (fn: (p: unknown) => void) => ipcRenderer.on('awb:aktivitaet', (_e, p) => fn(p)),
  onSuche: (fn: (p: unknown) => void) => ipcRenderer.on('awb:suche', (_e, p) => fn(p)),
  // Ob ein Steuerkanal da ist. Faellt er aus, steht das Fenster trotzdem --
  // und sagt es sichtbar, statt still ohne Verbindung dazustehen.
  onKanal: (fn: (p: { pfad: string; fehler: string | null }) => void) =>
    ipcRenderer.on('awb:kanal', (_e, p) => fn(p)),
  // Eingabe geht an einen bestimmten Pane, nicht an "den einen".
  input: (paneId: string, base64: string) => ipcRenderer.send('awb:input', { paneId, base64 }),
  bedienung: (aktion: string, wert: unknown) => ipcRenderer.send('awb:bedienung', { aktion, wert }),
  // Ein gezeichnetes Terminal steht ohne Rueckblick da. Nur der Renderer sieht
  // das (der Puffer liegt bei ihm), nur der Hauptprozess kann ihn holen.
  rueckblickFehlt: (paneId: string) => ipcRenderer.send('awb:rueckblick-fehlt', { paneId }),
  // Das Kontextmenue der Sessionleiste. `echt` kommt aus `isTrusted` und wird
  // im Hauptprozess entschieden, nicht hier: diese Bruecke reicht es weiter.
  sitzungsMenue: (id: string, echt: boolean) => ipcRenderer.send('awb:sitzung-menue', { id, echt: echt === true }),
  onUmbenennen: (fn: (p: unknown) => void) => ipcRenderer.on('awb:umbenennen', (_e, p) => fn(p)),
  // Was ein Griff im Hauptprozess ergeben hat, in einem Satz. Dieselbe Zeile,
  // die auch das Umbenennen zeigt -- ein Menuepunkt, der nicht mehr grau ist,
  // muss sagen koennen, warum er nicht durchging.
  onMeldung: (fn: (p: unknown) => void) => ipcRenderer.on('awb:meldung', (_e, p) => fn(p)),
  // Die Chat-Ansicht EINES Panes umschalten (12.08., Rechtsklick auf die
  // Sitzung). Sie wirkt sofort: der Renderer haelt je Pane eine Ansicht, die
  // sich ein- und ausblenden laesst -- kein neues Fenster, keine angefasste
  // Sitzung. Entschieden hat der Hauptprozess, hier kommt nur das Ergebnis an.
  onChatAnsicht: (fn: (p: { paneId: string; an: boolean }) => void) =>
    ipcRenderer.on('awb:chat-ansicht', (_e, p) => fn(p)),
  umbenennen: (id: string, name: string) => ipcRenderer.invoke('awb:sitzung-umbenennen', id, name),
  // Farben durchreichen (11.08.): Thema und Zustandsfarben, aus derselben
  // gemeinsamen Stelle wie in den drei anderen Fenstern (main/thema.ts).
  thema: () => ipcRenderer.invoke('awb:thema-daten'),
  onThema: (fn: (p: unknown) => void) => ipcRenderer.on('awb:thema-neu', (_e, p) => fn(p)),
  // Die System-Zwischenablage (SSH-clipfix): das Terminal zeichnet auf einen
  // Canvas, nicht in eine editierbare DOM-Flaeche -- deshalb hilft ihm weder
  // ein Menuepunkt noch die eingebaute Tastaturbehandlung von Chromium, und
  // Strg+Umschalt+C/V muss selbst lesen und schreiben. Der Weg fuehrt ueber
  // Electrons `clipboard`-Modul im Hauptprozess, nicht ueber `navigator.clipboard`
  // hier: das eine braucht keine Berechtigungsabfrage, das andere schon.
  zwischenablageLesen: (): Promise<string> => ipcRenderer.invoke('awb:zwischenablage-lesen'),
  zwischenablageSchreiben: (text: string): Promise<void> => ipcRenderer.invoke('awb:zwischenablage-schreiben', String(text)),
});

// DIE CHAT-SITZUNG AUF DER BUEHNE (13.08.). Bis zum 12.08. lag diese Bruecke in
// einer eigenen Datei (preload/chat-preload.ts) fuer ein eigenes Fenster; seit
// die Sitzung im Hauptfenster liegt, gibt es dieses Fenster nicht mehr, und die
// Bruecke zieht hierher. Sie bleibt ein EIGENER Namensraum und keine Erweiterung
// von `awbBridge`: was die Chat-Sitzung braucht, hat mit Panes und Terminals
// nichts zu tun, und eine Bruecke, die alles kann, sagt niemandem mehr, wer
// woran haengt.
//
// Fuenf Wege hinaus und einer herein, mehr nicht:
//   daten(seit)                 den Stand ab einem Takt -- 0 heisst „alles"
//   senden(text)                eine Nachricht des Menschen an die Sitzung
//   freigabe(anfrageId, ja)     die Antwort auf eine wartende Freigabefrage
//   neustart()                  nach einem Fehlstart frisch beginnen
//   bereit(id)                  das erste Zeichnen melden, fuer den Steuerkanal
//   onStand(fn)                 jeder neue Stand der Sitzung, nur das Geaenderte
//
// WELCHE Sitzung bedient wird, sagt diese Bruecke NICHT: das entscheidet der
// Hauptprozess an der Sitzung, die gerade auf der Buehne liegt (main.ts,
// `chatIdVon`). Waere die Kennung ein Argument, koennte die Oberflaeche eine
// Sitzung bedienen, die niemand sieht.
contextBridge.exposeInMainWorld('awbChat', {
  // `seit` sagt, welchen Takt die Buehne schon hat -- 0 heisst „alles"
  // (Befund B1). Ohne diese Zahl ginge bei jedem Token der volle Stand hinaus.
  daten: (seit: number) => ipcRenderer.invoke('awb:chat-daten', Number(seit) || 0),
  senden: (text: string) => ipcRenderer.invoke('awb:chat-senden', String(text)),
  freigabe: (anfrageId: string, erlauben: boolean) =>
    ipcRenderer.invoke('awb:chat-freigabe', String(anfrageId), erlauben === true),
  // Frisch starten nach einem Fehlstart auf einer verschwundenen
  // Unterhaltung (Befund B3).
  neustart: () => ipcRenderer.invoke('awb:chat-neustart'),
  // Den Freigabemodus zur Laufzeit umstellen (Luecke 5c) und einen laufenden
  // Zug unterbrechen (Punkt 6) -- beides gemessen am echten Protokoll, siehe
  // main/chatsitzung.ts.
  modus: (modus: string) => ipcRenderer.invoke('awb:chat-modus', String(modus)),
  halt: () => ipcRenderer.invoke('awb:chat-halt'),
  // Die Dateiliste fuer das `@` im Eingabefeld. Einmal je Sitzung geholt und
  // im Fenster gefiltert -- die Liste eines grossen Repos gehoert nicht bei
  // jedem Tastendruck durch den Kanal.
  dateien: () => ipcRenderer.invoke('awb:chat-dateien'),
  onStand: (fn: (s: unknown) => void) => ipcRenderer.on('awb:chat-stand-neu', (_e, s) => fn(s)),
  // Die Kennung reist MIT: auf sie wartet der Hauptprozess, und eine Meldung
  // aus einem ueberholten Wechsel darf das Warten nicht beenden.
  bereit: (id: string) => ipcRenderer.send('awb:chat-bereit', String(id)),
});
