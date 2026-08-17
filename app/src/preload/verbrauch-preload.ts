// Bruecke der Verbrauchsseite. Eigene Datei aus demselben Grund wie bei den beiden anderen
// Fenstern: dieses Fenster braucht nichts von dem, was das Hauptfenster bekommt -- keine Panes,
// keine Terminalausgabe, keine Freigaben --, und eine Bruecke, die mehr anbietet als das Fenster
// benutzt, ist eine Angriffsflaeche ohne Gegenwert.
//
// DREI Wege hinaus, mehr nicht:
//   daten(frage)  einen Verbrauchsbericht holen (`wb-budget --json`, im Hauptprozess)
//   sprache()     die Sprache der Oberflaeche (derselbe Kanal wie beim Einstellungsfenster)
//   bereit()      das erste Zeichnen melden, fuer den Steuerkanal
//
// Es gibt hier KEINEN Weg, der etwas veraendert -- die Seite liest, sie stellt nichts ein. Und
// keinen Weg, das Fenster zu ZEIGEN: sichtbar wird es ausschliesslich ueber den echten Klick auf
// die Token-Anzeige im HAUPTfenster (siehe main/verbrauchsfenster.ts, Klassendoc).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('awbVerbrauch', {
  daten: (frage: unknown) => ipcRenderer.invoke('awb:verbrauch-daten', frage),
  sprache: () => ipcRenderer.invoke('awb:sprache'),
  bereit: () => ipcRenderer.send('awb:verbrauch-bereit'),
  // Farben durchreichen (11.08.): derselbe Kanal wie in den anderen Fenstern
  // (main/thema.ts).
  thema: () => ipcRenderer.invoke('awb:thema-daten'),
  onThema: (fn: (p: unknown) => void) => ipcRenderer.on('awb:thema-neu', (_e, p) => fn(p)),
});
