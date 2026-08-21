// Bruecke des Erststart-Fensters (SPEC-V4 3.8). Eigene Datei aus demselben Grund wie bei den
// drei Geschwistern: dieses Fenster braucht nichts von dem, was das Hauptfenster bekommt, und
// eine Bruecke, die mehr anbietet als das Fenster benutzt, ist eine Angriffsflaeche ohne
// Gegenwert.
//
// DREI Wege hinaus, mehr nicht:
//   daten()        einmal alles, was die vier Schritte brauchen (Maschinen, Harnesses, Modelle,
//                  Anmeldestand, heutige Einstellung)
//   setzen(k,v)     EINEN Schluessel schreiben -- derselbe Weg wie im Einstellungsfenster
//                  (`plane()`/`fuehreAus()`, also `wb-state settings set`), nur ueber einen
//                  eigenen Kanal
//   bereit()       das erste Zeichnen melden, fuer den Steuerkanal
//   kontextStufen(modellId)  die waehlbaren Kontextfenster eines LOKALEN Modells,
//                  gemessen von `wb-kontext` -- derselbe Kanal, den auch das
//                  Einstellungsfenster benutzt. Er kann NICHT in `daten()`
//                  mitfahren: welches Modell gemeint ist, entscheidet sich erst
//                  im Fenster, wenn jemand im dritten Schritt geklickt hat.
//
// Es gibt hier KEINEN Weg, das Fenster zu ZEIGEN: sichtbar wird es entweder automatisch beim
// ersten echten Start oder ueber einen echten Klick im HAUPTfenster (siehe
// main/erststartfenster.ts, Klassendoc).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('awbErststart', {
  daten: () => ipcRenderer.invoke('awb:erststart-daten'),
  setzen: (key: string, value: unknown) => ipcRenderer.invoke('awb:erststart-setzen', key, value),
  bereit: () => ipcRenderer.send('awb:erststart-bereit'),
  kontextStufen: (modellId: string) => ipcRenderer.invoke('awb:kontext-stufen', modellId),
  // Farben durchreichen (11.08.): derselbe Kanal wie in den anderen Fenstern
  // (main/thema.ts).
  thema: () => ipcRenderer.invoke('awb:thema-daten'),
  onThema: (fn: (p: unknown) => void) => ipcRenderer.on('awb:thema-neu', (_e, p) => fn(p)),
});
