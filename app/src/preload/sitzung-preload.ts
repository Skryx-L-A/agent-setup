// Bruecke des Sitzungsfensters. Eigene Datei aus demselben Grund wie beim
// Einstellungsfenster: dieses Fenster braucht nichts von dem, was das
// Hauptfenster bekommt -- keine Panes, keine Terminalausgabe, keine Freigaben --,
// und eine Bruecke, die mehr anbietet als das Fenster benutzt, ist eine
// Angriffsflaeche ohne Gegenwert.
//
// Sechs Wege hinaus, mehr nicht:
//   daten()       einmal alles, was die eine Seite zeichnet
//   neu(name,machine,fernPfad,echt)
//                 die eigene Maschine: Ordner im nativen Dialog waehlen und
//                 die Sitzung starten -- ueber `wb-code`. Die Echtheit des
//                 Klicks reist mit: ohne sie gibt es keinen Dialog (main.ts,
//                 `ordnerDialog`). Eine andere Maschine (11.08.): `fernPfad`
//                 gilt statt des Dialogs, `echt` spielt dort keine Rolle --
//                 es entsteht kein Fenster des Betriebssystems.
//   fernPruefen(machine,pfad)
//                 ob `pfad` auf `machine` ein Verzeichnis ist -- der
//                 „Pruefen"-Knopf neben dem Pfadfeld einer Fernmaschine.
//   fortsetzen()  eine gestoppte Sitzung zurueckholen -- ueber `wb-code --resume`
//   beenden(id,echt)
//                 eine LAUFENDE Sitzung schliessen (11.08.) -- die
//                 Zustandsdatei bleibt, sie laesst sich danach fortsetzen.
//                 `echt` entscheidet ueber die Rueckfrage im Hauptprozess
//                 (dieselbe Funktion wie beim Loeschen im Kontextmenue).
//   bereit()      das erste Zeichnen melden, fuer den Steuerkanal
//
// Ein Weg zum ZEIGEN des Fensters gibt es hier NICHT. Sichtbar wird es
// ausschliesslich ueber den echten Klick auf das Plus im HAUPTfenster (siehe
// main/sitzungsfenster.ts, Klassendoc).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('awbSitzung', {
  daten: () => ipcRenderer.invoke('awb:sitz-daten'),
  // Die Echtheit kommt aus `isTrusted` im Fenster und wird im Hauptprozess
  // entschieden, nicht hier: diese Bruecke reicht sie nur weiter.
  neu: (name: string, machine: string, fernPfad: string, echt: boolean) =>
    ipcRenderer.invoke('awb:sitz-neu', name, machine, fernPfad, echt === true),
  // Der zweite Weg (12.08.): eine Chat-Sitzung. Kein `machine`, kein
  // `fernPfad` -- sie ist ein Prozess DIESER App und laeuft dort, wo die App
  // laeuft. Die Echtheit des Klicks reist mit, wie beim ersten Weg: ohne sie
  // gibt es keinen Ordnerdialog.
  neuChat: (name: string, echt: boolean) => ipcRenderer.invoke('awb:sitz-neu-chat', String(name), echt === true),
  fernPruefen: (machine: string, pfad: string) => ipcRenderer.invoke('awb:sitz-fern-pruefen', machine, pfad),
  fortsetzen: (id: string) => ipcRenderer.invoke('awb:sitz-fortsetzen', id),
  beenden: (id: string, echt: boolean) => ipcRenderer.invoke('awb:sitz-beenden', id, echt === true),
  onDaten: (fn: (d: unknown) => void) => ipcRenderer.on('awb:sitz-daten-neu', (_e, d) => fn(d)),
  bereit: () => ipcRenderer.send('awb:sitz-bereit'),
  // Farben durchreichen (11.08.): derselbe Kanal wie in den drei anderen
  // Fenstern (main/thema.ts) -- sitzung.ts fasst diese Bruecke nicht an, die
  // Anwendung steht als eigenes Skript in index.html.
  thema: () => ipcRenderer.invoke('awb:thema-daten'),
  onThema: (fn: (p: unknown) => void) => ipcRenderer.on('awb:thema-neu', (_e, p) => fn(p)),
});
