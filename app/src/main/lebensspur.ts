// Welche Sitzungen liefen noch, als dieses Programm zuletzt hingesehen hat.
//
// WARUM ES DIESE DATEI GIBT (10./11.08., gemessen). Um 23:44 riss eine
// Kernel-Panik den Rechner weg -- mit ihm den tmux-Server und dieses Programm.
// Die Zustandsdateien der vier hiesigen Sitzungen lagen unveraendert auf der
// Platte, `leseSessions` hat sie auch gelesen und richtig als 'stopped'
// gefuehrt. Nur sah alice sie nicht: `sichtbare()` blendet beendete
// Sitzungen aus (A12, `showStopped` steht in seiner ui.json auf false), und
// uebrig blieb genau eine -- Polarschern auf peer, deren tmux den Absturz
// ueberlebt hatte. Der Fortsetzen-Knopf haengt an derselben Liste, also war
// auch er weg.
//
// A12 IST NICHT FALSCH, ES IST ZU GROB. Der Filter behandelt jede beendete
// Sitzung gleich, und das sind zwei sehr verschiedene Dinge:
//
//   BEENDET     Jemand hat sie geschlossen. Das Programm hat dabei zugesehen.
//               Sie soll verschwinden -- genau dafuer ist A12 da.
//   VERLOREN    Sie lief noch, als dieses Programm zuletzt hinsah, und jetzt
//               ist sie weg, ohne dass wir das Ende gesehen haetten. Das ist
//               eine Nachricht und kein Aufraeumen.
//
// Es ist dieselbe Unterscheidung, die auf der Sitzungsebene schon einmal Geld
// gekostet hat (sessions.ts, 'unreachable' NEBEN 'stopped'): was man nicht
// gesehen hat, ist etwas anderes als das, was es nicht mehr gibt. Hier eine
// Ebene weiter -- ein Ende, das niemand gesehen hat, ist etwas anderes als
// eines, das jemand herbeigefuehrt hat.
//
// WIE ES GEMESSEN WIRD, ohne den Absturz selbst erkennen zu muessen: Dieses
// Programm sieht in jedem Takt, welche Sitzungen leben, und schreibt genau
// diese Menge hierher. Beim naechsten Start steht in der Datei, was beim
// LETZTEN Blick lief. Eine Sitzung, die dort steht, heute aber nicht mehr
// laeuft und in diesem Lauf auch nie lief, ist verloren. Ein Absturz braucht
// dafuer keinen eigenen Nachweis: er ist genau der Fall, in dem das Programm
// den letzten Stand nicht mehr fortschreiben konnte.
//
// WAS DER PREIS DAVON IST, ausdruecklich: Wer das Fenster schliesst und DANACH
// im Terminal seine Sitzungen beendet, findet sie beim naechsten Start als
// verloren gemeldet. Das ist die richtige Seite zum Irren -- die Meldung
// lautet "lief noch, als ich zuletzt hinsah", und das stimmt dann ja. Sie geht
// von selbst wieder weg, sobald die Sitzung wieder laeuft oder ihre
// Zustandsdatei geloescht ist (Sitzungsmenue).
//
// ZWEI GRENZEN DAZU, beide aus der Durchsicht vom 11.08. -- ohne sie war der
// obige Satz nach jedem gewoehnlichen Neustart falsch, und zwar fuer ALLE
// Sitzungen auf einmal statt fuer eine:
//
//   1. EIN SAUBERES ENDE LOESCHT DIE SPUR (`sauberBeendet`). Ein Neustart des
//      Rechners nimmt den tmux-Server mit; ohne diesen Schritt stuenden beim
//      naechsten Start saemtliche hiesigen Sitzungen als verloren in der
//      Spalte -- genau die Menge, die A12 verbergen soll. Der Satz stimmt dann
//      auch nicht mehr: Wer sein Fenster ordentlich zumacht, hat kein Ende
//      verpasst, er hat aufgehoert hinzusehen. Ein Absturz kommt an diese
//      Stelle nicht, und das ist der ganze Unterschied.
//      DIE KEHRSEITE, ausdruecklich: Stirbt der Rechner, WAEHREND das Fenster
//      zu ist, meldet niemand einen Verlust. Die Spur spricht nur fuer die
//      Zeit, in der dieses Programm hingesehen hat, und behauptet fuer die
//      uebrige nichts.
//   2. EINE ALTE SPUR VERFAELLT (`SPUR_VERFALL_MS`, sieben Tage). Was ausser
//      dem sauberen Ende noch bleibt -- ein hartes Abschiessen des Fensters,
//      ein Stromausfall bei geschlossenem Fenster, eine lange Pause --, ist
//      nach einer Woche keine Auskunft mehr ueber heute. Der Zeitpunkt steht
//      als `stand` in der Datei; ein Lauf schreibt ihn in jedem Takt fort, in
//      dem sich etwas aendert.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Eine Sitzung, so wie diese Datei sie braucht -- mehr wird nicht gelesen. */
export interface SpurSitzung {
  id: string;
  /**
   * Auf WELCHER Maschine sie liegt. Sie steht hier, weil "konnten wir
   * nachsehen?" je Maschine beantwortet wird und nicht fuer alle zusammen
   * (siehe `spurDurchgang`).
   */
  machine: string;
  /** Wurde ein lebender tmux-Pane fuer sie GESEHEN? */
  alive: boolean;
}

/** Ein Eintrag der Spur: dieselbe Sitzung, nur ohne die Frage nach dem Pane. */
export interface SpurEintrag {
  id: string;
  machine: string;
}

/**
 * Wie lange eine nicht fortgeschriebene Spur ueberhaupt noch etwas aussagt.
 * Sieben Tage: lang genug, dass ein Absturz am Freitag am Montag noch gemeldet
 * wird, kurz genug, dass eine Datei aus einer vergessenen Woche nicht als
 * Nachricht ueber heute auftaucht.
 */
export const SPUR_VERFALL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Der reine Kern, ohne Datei: aus dem letzten Stand, dem, was dieser Lauf
 * schon lebend gesehen hat, und dem aktuellen Durchgang folgt beides -- was
 * als verloren gilt und was als naechster Stand auf die Platte gehoert.
 *
 * Ausdruecklich getrennt von der Klasse darunter, damit ein Test beides ohne
 * Dateisystem messen kann: die Regel ist die Aussage, die Datei nur ihr
 * Gedaechtnis.
 *
 * `einsehbar` WIRD JE MASCHINE GEFRAGT (Durchsicht 11.08.), nicht einmal fuer
 * alle. Der Grund ist derselbe Satz, der eine Ebene hoeher schon zweimal steht
 * (sessions.ts, Kopf und `unreachable`): was man nicht sehen konnte, ist nicht
 * dasselbe wie das, was es nicht mehr gibt. Vorher hing die ganze Frage am
 * hiesigen tmux-Befund, und das ging in beide Richtungen schief:
 *
 *   Der erste Durchgang laeuft SYNCHRON beim Start, da kann keine SSH-Antwort
 *   da sein (remote.ts). Ferne Sitzungen fehlen also in `jetzt`, und wer sie
 *   dann aus der Spur streicht, kann einen fernen Verlust nie mehr melden.
 *
 *   Andersherum sammelt eine bloss stille Maschine ihre Sitzungen als
 *   verloren ein, obwohl niemand nachgesehen hat -- dieselbe Falschaussage
 *   ueber fremden Zustand, gegen die es 'unreachable' ueberhaupt gibt.
 *
 * Was von einer nicht einsehbaren Maschine kommt, wird deshalb WEDER beurteilt
 * NOCH gestrichen: es bleibt unveraendert in der Spur stehen, bis die Maschine
 * wieder antwortet.
 */
export function spurDurchgang(
  vorlauf: SpurEintrag[],
  schonGesehen: Iterable<string>,
  jetzt: SpurSitzung[],
  einsehbar: (machine: string) => boolean,
): { verlorene: string[]; naechsterStand: SpurEintrag[] } {
  const beurteilbar = jetzt.filter((s) => einsehbar(s.machine));
  const bekannt = new Set(beurteilbar.map((s) => s.id));
  const lebend = beurteilbar.filter((s) => s.alive).map((s) => ({ id: s.id, machine: s.machine }));
  const gesehen = new Set([...schonGesehen, ...lebend.map((s) => s.id)]);
  // Verloren bleibt verloren, bis die Sitzung wieder laeuft oder ihre
  // Zustandsdatei verschwindet -- sonst waere die Nachricht nach einem
  // einzigen Takt wieder fort, und gerade nach einem Absturz sitzt niemand
  // im selben Moment davor.
  const offen = vorlauf.filter((e) => einsehbar(e.machine) && bekannt.has(e.id) && !gesehen.has(e.id));
  // Und was gerade nicht zu beurteilen war, reist unveraendert mit -- siehe
  // oben. Es taucht in `verlorene` NICHT auf: eine Luecke ist keine Nachricht.
  const unklar = vorlauf.filter((e) => !einsehbar(e.machine));
  // Auf die Platte geht, was JETZT lebt, plus die noch offenen Verluste. Ohne
  // die zweite Haelfte waere die Nachricht nach dem ersten Start nach dem
  // Absturz verbraucht: dort lebt keine der verlorenen Sitzungen mehr, der
  // Stand waere leer, und ein zweiter Start wuesste von nichts mehr.
  const stand = new Map<string, SpurEintrag>();
  for (const e of [...lebend, ...offen, ...unklar]) stand.set(e.id, e);
  return {
    verlorene: offen.map((e) => e.id),
    naechsterStand: [...stand.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Das Gedaechtnis dazu. Es liegt im eigenen Verzeichnis des Programms und NICHT
 * bei den Zustandsdateien der Sessions -- die gehoeren den wb-Werkzeugen, und
 * zwei Schreiber auf derselben Datei sind ein Fehler, den dieses Haus schon
 * einmal bezahlt hat (siehe uistate.ts).
 */
export class LebensSpur {
  private readonly datei: string;
  private readonly stateDir: string;
  /** Was beim letzten Blick des VORIGEN Laufs lief. */
  private vorlauf: SpurEintrag[] = [];
  /** Was dieser Lauf schon einmal lebend gesehen hat. */
  private readonly gesehen = new Set<string>();
  /** Der zuletzt geschriebene Stand -- damit nicht in jedem Takt geschrieben wird. */
  private geschrieben = '';

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.datei = join(stateDir, 'lebensspur.json');
    try {
      const roh = JSON.parse(readFileSync(this.datei, 'utf8')) as { sitzungen?: unknown; stand?: unknown };
      // Zu alt ist so gut wie nicht da (siehe SPUR_VERFALL_MS oben). Eine Datei
      // ohne `stand` stammt aus einer Fassung vor dieser Grenze und wird wie
      // eine frische behandelt -- verfallen kann nur, was einen Zeitpunkt hat.
      const stand = typeof roh.stand === 'string' ? Date.parse(roh.stand) : NaN;
      const verfallen = Number.isFinite(stand) && Date.now() - stand > SPUR_VERFALL_MS;
      if (Array.isArray(roh.sitzungen) && !verfallen) {
        this.vorlauf = roh.sitzungen
          .map((e) => (typeof e === 'string'
            ? { id: e, machine: '' }
            : { id: String((e as SpurEintrag)?.id ?? ''), machine: String((e as SpurEintrag)?.machine ?? '') }))
          .filter((e) => !!e.id);
      }
      this.geschrieben = JSON.stringify(this.vorlauf);
    } catch {
      // Ein erster Start ohne alles muss funktionieren -- dann ist nichts
      // verloren, weil noch nie jemand hingesehen hat.
    }
  }

  /**
   * Die KANDIDATEN: Sitzungen, die beim letzten Blick liefen und in diesem Lauf
   * noch nie. Ob daraus eine Meldung wird, entscheidet die Liste selbst -- den
   * Merker traegt nur, wer dort auch wirklich 'stopped' ist (sessions.ts). Was
   * hier von einer stillen Maschine mitreist, faellt dort also von allein
   * heraus, weil ihre Sitzungen 'unreachable' heissen und nicht 'stopped'.
   */
  verlorene(): string[] {
    return this.vorlauf.filter((e) => !this.gesehen.has(e.id)).map((e) => e.id);
  }

  /**
   * Ein Durchgang. `einsehbar` ist die Bedingung, unter der die Beobachtung
   * ueberhaupt etwas wert ist: war tmux nicht auszufuehren oder unzerlegbar,
   * ist `alive` fuer JEDE Sitzung false, und ein Fortschreiben wuerde genau die
   * Auskunft loeschen, fuer die es diese Datei gibt. Sie wird JE MASCHINE
   * gestellt (Durchsicht 11.08.) -- warum, steht bei `spurDurchgang`.
   */
  durchgang(jetzt: SpurSitzung[], einsehbar: (machine: string) => boolean): string[] {
    const { verlorene, naechsterStand } = spurDurchgang(this.vorlauf, this.gesehen, jetzt, einsehbar);
    for (const s of jetzt) if (s.alive && einsehbar(s.machine)) this.gesehen.add(s.id);
    this.vorlauf = naechsterStand;
    const stand = JSON.stringify(naechsterStand);
    if (stand !== this.geschrieben) {
      this.geschrieben = stand;
      this.speichern(naechsterStand);
    }
    return verlorene;
  }

  /**
   * Das Fenster geht ordentlich zu: ab hier sieht niemand mehr hin, also gibt
   * es auch nichts mehr zu bezeugen. Die Begruendung steht oben im Kopf unter
   * Punkt 1; sie ist der Unterschied zwischen einem Neustart und einem
   * Absturz. Synchron, weil auf dem Beenden-Weg keine Zeit fuer Asynchrones
   * bleibt (derselbe Grund wie bei `zustandZurueckSync` in main.ts).
   */
  sauberBeendet(): void {
    this.vorlauf = [];
    this.geschrieben = JSON.stringify([]);
    this.speichern([]);
  }

  private speichern(sitzungen: SpurEintrag[]): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.datei}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ stand: new Date().toISOString(), sitzungen }, null, 2));
      renameSync(tmp, this.datei);
    } catch {
      // Ein nicht schreibbarer Zustand darf die Oberflaeche nicht anhalten.
    }
  }
}
