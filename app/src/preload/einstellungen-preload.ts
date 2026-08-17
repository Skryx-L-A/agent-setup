// Bruecke des Einstellungsfensters. Eigene Datei statt einer Erweiterung von
// preload.ts: Dieses Fenster braucht NICHTS von dem, was das Hauptfenster
// bekommt -- keine Panes, keine Terminalausgabe, keine Freigaben --, und eine
// Bruecke, die mehr anbietet als das Fenster benutzt, ist eine Angriffsflaeche
// ohne Gegenwert.
//
// Fuenf Wege hinaus, mehr nicht -- und der Neuschnitt vom 11.08. (sieben
// Seiten statt sechs, SPEC-V4 Abschnitt 3) hat KEINEN sechsten gebraucht. Das
// ist kein Zufall, sondern die Probe auf den Schnitt: was neu dazukam --
// Anmeldestatus je Programm, die Chat-Faehigkeit aus der Registry, die Adresse
// des lokalen Modell-Servers, die Meldungen, Sprache, Thema und Farben -- ist
// entweder eine AUSKUNFT (dann faehrt sie in `daten()` mit) oder eine
// EINSTELLUNG (dann faehrt sie durch `setzen()`). Ein eigener Kanal je Seite
// waere eine Angriffsflaeche je Seite.
//
//   daten()            einmal alles, was die Seiten zeichnen
//   setzen()           eine Einstellung schreiben -- ueber `wb-state settings set`
//   werkzeug()         Guard, Wache, Deckel -- ueber die eigenen wb-state-Befehle,
//                      die Grund und Menschen-Nachweis verlangen; der zweite
//                      Parameter sagt, ob ein ECHTER Klick dahintersteht
//   ui()               showStopped/sort, die im Zustand der Oberflaeche liegen
//   maschinePruefen()  `ssh <alias> true`, nur auf Knopfdruck der Maschinen-Seite
//
// Ein Weg zum ZEIGEN des Fensters gibt es hier NICHT. Sichtbar wird es
// ausschliesslich ueber den echten Klick im HAUPTfenster (siehe
// main/einstellungsfenster.ts, Klassendoc).
//
// SECHSTER UND SIEBTER WEG (11.08.), und beide bewusst SCHMAL statt allgemein:
//
//   schluesselStatus()  je Anbieter-ID: liegt ein Schluessel im Schluesselbund
//                       vor? Nie der Wert -- siehe main/schluesselbund.ts.
//   schluesselSetzen()  einen Wert fuer EINEN Anbieter ablegen. Die Antwort ist
//                       ausschliesslich `{ok}`; der Wert geht nur HIN.
//   erststartZeigen()   dieselben zwei Faelle wie beim Zahnrad im Hauptfenster
//                       (renderer.ts): `isTrusted` entscheidet 'erststart-zeigen'
//                       gegen 'erststart-bauen'. Bewusst KEIN allgemeiner
//                       `bedienung()`-Durchreicher -- der wuerde diesem Fenster
//                       jede Handlung des Hauptfensters oeffnen, und "eine
//                       Bruecke, die mehr anbietet als das Fenster benutzt, ist
//                       eine Angriffsflaeche ohne Gegenwert" gilt auch hier.
//
// ACHTER WEG (12.08.): meldungTesten() -- der Knopf 'Test senden' auf der
// Seite Aufsicht und Meldungen. Er sendet eine ECHTE Probe (siehe
// main/melden.ts, meldenTesten()) und bekommt je Weg zurueck, was passiert
// ist; kein Parameter geht mit, denn Wege und Adresse liest der Hauptprozess
// selbst aus derselben Einstellungsdatei, die auch die Seite fuellt.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('awbEinstellungen', {
  daten: () => ipcRenderer.invoke('awb:ein-daten'),
  setzen: (key: string, value: unknown) => ipcRenderer.invoke('awb:ein-setzen', key, value),
  ui: (key: string, value: unknown) => ipcRenderer.invoke('awb:ein-ui', key, value),
  // Die Echtheit des Klicks reist mit. Sie kommt aus `isTrusted` und wird im
  // Hauptprozess entschieden, nicht hier: diese Bruecke reicht sie nur weiter.
  werkzeug: (nachricht: Record<string, unknown>, echt: boolean) =>
    ipcRenderer.invoke('awb:ein-werkzeug', nachricht, echt === true),
  maschinePruefen: (name: string) => ipcRenderer.invoke('awb:ein-maschine-pruefen', name),
  onDaten: (fn: (d: unknown) => void) => ipcRenderer.on('awb:ein-daten-neu', (_e, d) => fn(d)),
  bereit: () => ipcRenderer.send('awb:ein-bereit'),
  schluesselStatus: () => ipcRenderer.invoke('awb:ein-schluessel-status'),
  schluesselSetzen: (providerId: string, wert: string) =>
    ipcRenderer.invoke('awb:ein-schluessel-setzen', providerId, wert),
  meldungTesten: () => ipcRenderer.invoke('awb:ein-meldung-testen'),
  erststartZeigen: (echt: boolean) =>
    ipcRenderer.send('awb:bedienung', { aktion: echt ? 'erststart-zeigen' : 'erststart-bauen', wert: null }),
});
