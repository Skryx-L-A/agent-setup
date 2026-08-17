// DIE BUCHFUEHRUNG DER CHAT-SITZUNGEN -- was eine Chat-Sitzung ueberleben
// laesst, wenn die App neu startet.
//
// WARUM EINE EIGENE DATEI UND NICHT sessions.ts. Das Sessionmodell dort liest
// tmux und die Zustandsdateien von `wb-code`; eine Chat-Sitzung hat weder ein
// tmux-Fenster noch einen Pane, und ihr Leben endet mit dem Prozess, den DIESE
// App gestartet hat. Beides in ein Modell zu zwingen hiesse, an jeder
// Verzweigung dort die Frage „gibt es hier ueberhaupt einen Pane?"
// nachzutragen -- die getrennten Welten aus Entscheidung des Nutzers enden
// nicht an der Oberflaeche.
//
// GEMERKT WIRD NUR, WAS DAS FORTSETZEN BRAUCHT: wo sie lief, womit, und welche
// Unterhaltung des Harness dazugehoert. Der Verlauf selbst wird NICHT hier
// gefuehrt -- den fuehrt der Harness, und beim Fortsetzen spielt er ihn
// selbst wieder ein. Zwei Buchfuehrungen ueber dieselbe Unterhaltung waeren
// genau die Stelle, an der beide auseinander laufen.
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

export interface ChatEintrag {
  /** Unsere Kennung, stabil ueber Neustarts. */
  id: string;
  /** Der Name in der Leiste. */
  name: string;
  /** Der Projektordner. */
  ordner: string;
  /** Das Modell, leer = Vorgabe des Harness. */
  modell: string;
  /** Der Freigabemodus, leer = Vorgabe der CLI. */
  modus: string;
  /**
   * Die Unterhaltung des Harness. Leer, solange die Sitzung noch nie
   * gelaufen ist -- erst das init-Ereignis nennt sie.
   */
  sessionId: string;
  /** Wann zuletzt etwas passiert ist, ISO-8601. */
  zuletzt: string;
}

/** Ein Name aus einem Ordnerpfad, so wie ihn die Leiste zeigen soll. */
export function nameAusOrdner(ordner: string): string {
  const b = basename(ordner.replace(/\/+$/, ''));
  return b || ordner || 'Chat';
}

/**
 * Eine neue Kennung. Zeit plus Zufall: die Zeit macht sie lesbar sortierbar,
 * der Zufall verhindert eine Kollision, wenn zwei in derselben Millisekunde
 * entstehen.
 */
export function neueId(jetzt: number, zufall: number): string {
  const z = Math.floor(zufall * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `chat-${jetzt.toString(36)}-${z}`;
}

/**
 * Die Liste aus einer gelesenen Datei -- unbrauchbare Eintraege fallen
 * einzeln weg, nicht die ganze Datei. Eine kaputte Zeile soll nicht alle
 * anderen Sitzungen unsichtbar machen.
 */
export function ausJson(roh: unknown): ChatEintrag[] {
  if (!roh || typeof roh !== 'object') return [];
  const liste = (roh as { chats?: unknown }).chats;
  if (!Array.isArray(liste)) return [];
  const raus: ChatEintrag[] = [];
  for (const e of liste) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.ordner !== 'string' || !o.ordner) continue;
    raus.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name ? o.name : nameAusOrdner(o.ordner),
      ordner: o.ordner,
      modell: typeof o.modell === 'string' ? o.modell : '',
      modus: typeof o.modus === 'string' ? o.modus : '',
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
      zuletzt: typeof o.zuletzt === 'string' ? o.zuletzt : '',
    });
  }
  // Zuletzt aktiv zuerst -- dieselbe Vorgabe wie in der Sessionleiste.
  return raus.sort((a, b) => (b.zuletzt || '').localeCompare(a.zuletzt || ''));
}

/**
 * DIE DATEI. Geschrieben wird ueber eine Nebendatei und `rename`, damit ein
 * Absturz mitten im Schreiben keine halbe Datei hinterlaesst -- dieselbe
 * Vorsicht wie bei ui.json (uistate.ts).
 */
export class ChatRegistry {
  private readonly datei: string;

  /** Die Belegungen -- eine Datei je Chat, siehe `belegen()`. */
  private readonly schloesser: string;

  /** Welche Kennungen DIESER Prozess belegt hat. */
  private readonly eigene = new Set<string>();

  constructor(private readonly stateDir: string) {
    this.datei = join(stateDir, 'chats.json');
    this.schloesser = join(stateDir, 'chats.belegt');
  }

  /** Immer frisch von der Platte -- siehe `mitDatei()`. */
  private lies(): ChatEintrag[] {
    try {
      if (!existsSync(this.datei)) return [];
      return ausJson(JSON.parse(readFileSync(this.datei, 'utf8')));
    } catch {
      // Unlesbar heisst leer, nicht kaputt: die App startet, die Liste ist
      // eben leer, und der naechste Schreibvorgang legt sie neu an.
      return [];
    }
  }

  /**
   * LESEN, AENDERN, SCHREIBEN -- IN EINEM ZUG (Befund B4, 12.08.).
   *
   * Vorher las diese Klasse die Datei EINMAL im Konstruktor und schrieb danach
   * immer ihren Speicherstand. Zwei App-Instanzen loeschten sich damit
   * gegenseitig die Sitzungen: gemessen legte A an, B legte an, A legte an --
   * und die Sitzung von B war weg, ohne Meldung. Wer schreibt, muss vorher
   * nachsehen, was inzwischen dasteht.
   *
   * Die Nebendatei traegt die Prozesskennung im Namen. Hiess sie fest
   * `chats.json.neu`, mischten sich die Inhalte zweier gleichzeitig
   * schreibender Instanzen, bevor `rename` daraus die gueltige Datei machte.
   */
  private mitDatei<T>(aendern: (liste: ChatEintrag[]) => { liste: ChatEintrag[]; wert: T }): T {
    const { liste, wert } = aendern(this.lies());
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const neben = `${this.datei}.${process.pid}.neu`;
      writeFileSync(neben, `${JSON.stringify({ chats: liste }, null, 2)}\n`, 'utf8');
      renameSync(neben, this.datei);
    } catch (fehler) {
      // Nicht schreibbar: die laufende Sitzung bleibt benutzbar, nur das
      // Merken faellt aus. Ein Absturz waere hier die schlechtere Antwort --
      // ABER SCHWEIGEN AUCH (Befund 9 der Bugjagd, 15.08.). Nachgestellt auf
      // einem Verzeichnis ohne Schreibrecht: `anlegen()` gab seinen Eintrag
      // zurueck, die Liste blieb leer, und nirgends stand ein Wort darueber.
      // Wer nach dem Neustart seine Sitzungen sucht, soll wenigstens im
      // Protokoll finden, wohin sie gegangen sind.
      process.stderr.write(
        `Chatregistry: '${this.datei}' liess sich nicht schreiben `
        + `(${(fehler as Error).message}) -- diese Aenderung ueberlebt den Neustart nicht\n`,
      );
    }
    return wert;
  }

  alle(): ChatEintrag[] {
    return this.lies();
  }

  einer(id: string): ChatEintrag | null {
    return this.lies().find((e) => e.id === id) ?? null;
  }

  anlegen(e: ChatEintrag): ChatEintrag {
    return this.mitDatei((liste) => ({
      liste: [e, ...liste.filter((x) => x.id !== e.id)],
      wert: e,
    }));
  }

  /** Nur die Felder aendern, die genannt sind -- der Rest bleibt stehen. */
  aendern(id: string, teil: Partial<ChatEintrag>): ChatEintrag | null {
    return this.mitDatei((liste) => {
      const i = liste.findIndex((e) => e.id === id);
      if (i < 0) return { liste, wert: null };
      liste[i] = { ...liste[i], ...teil };
      return { liste, wert: liste[i] };
    });
  }

  loeschen(id: string): boolean {
    return this.mitDatei((liste) => {
      const gefiltert = liste.filter((e) => e.id !== id);
      return { liste: gefiltert, wert: gefiltert.length !== liste.length };
    });
  }

  // --- Belegung ----------------------------------------------------------------

  private schlossPfad(id: string): string {
    // Der Dateiname wird aus der Kennung gebaut; sie stammt aus `neueId` und
    // besteht nur aus Kleinbuchstaben, Ziffern und Bindestrichen. Alles andere
    // wird trotzdem ersetzt -- ein Pfadtrenner in einem Dateinamen ist genau
    // die Sorte Ueberraschung, die man nicht einmal riskiert.
    return join(this.schloesser, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.pid`);
  }

  /** Laeuft dieser Prozess noch? Signal 0 fragt, ohne etwas zu schicken. */
  private lebt(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (fehler) {
      // EPERM heisst: es gibt ihn, er gehoert nur jemand anderem.
      return (fehler as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /**
   * EINE KENNUNG BELEGEN -- die Zusage „ein Schreiber je Sitzung" auf der
   * MASCHINE, nicht nur im Prozess (Befund B4, 12.08.).
   *
   * Der Klassenkopf von chatsitzung.ts nennt genau das als Bedingung dafuer,
   * dass das Protokoll heil bleibt. Sie galt bisher innerhalb einer
   * App-Instanz; eine zweite konnte dieselbe Unterhaltung oeffnen und ein
   * zweites `claude --resume` darauf starten.
   *
   * Eine tote Belegung wird uebernommen: nach einem Absturz soll niemand eine
   * Datei von Hand loeschen muessen, um seine Sitzung wieder zu oeffnen.
   */
  belegen(id: string): { gelungen: boolean; fremdePid: number; ungesichert?: boolean } {
    const pfad = this.schlossPfad(id);
    try {
      mkdirSync(this.schloesser, { recursive: true });
      if (existsSync(pfad)) {
        const pid = Number.parseInt(readFileSync(pfad, 'utf8').trim(), 10);
        if (pid !== process.pid && this.lebt(pid)) return { gelungen: false, fremdePid: pid };
      }
      writeFileSync(pfad, `${process.pid}\n`, 'utf8');
      this.eigene.add(id);
      return { gelungen: true, fremdePid: 0 };
    } catch (fehler) {
      // UNBEKANNT IST NICHT FREI (Befund 5 der Bugjagd, 15.08., nachgebessert
      // 17.08.): der erste Versuch dieser Antwort (Befund 9, 15.08.) meldete
      // trotz der Ausnahme weiter `gelungen: true` und haengte nur ein
      // `ungesichert`-Flag daneben, das der einzige Aufrufer (chatbuehne.ts)
      // nie las -- die Sitzung startete also weiter ungeschuetzt, nur mit
      // einer zusaetzlichen, folgenlosen Zeile im Protokoll. Ohne
      // schreibbares Verzeichnis lässt sich aber gerade NICHT feststellen, ob
      // schon ein anderer Prozess schreibt: das ist dieselbe Lage wie ein
      // Speicherstand, der sich nicht messen laesst, und die heisst nirgends
      // in diesem Haus „frei". Verweigert wird deshalb wie bei einer echten
      // fremden Belegung -- `ungesichert` bleibt daneben stehen, damit ein
      // Aufrufer, der es liest, den Grund von einer echten fremden PID
      // unterscheiden kann.
      process.stderr.write(
        `Chatregistry: die Belegung fuer '${id}' liess sich nicht schreiben `
        + `(${(fehler as Error).message}) -- die Sitzung startet deshalb nicht\n`,
      );
      return { gelungen: false, fremdePid: 0, ungesichert: true };
    }
  }

  /** Eine Belegung zurueckgeben. Fremde Belegungen bleiben unangetastet. */
  freigeben(id: string): void {
    if (!this.eigene.has(id)) return;
    this.eigene.delete(id);
    try {
      rmSync(this.schlossPfad(id), { force: true });
    } catch {
      // Weg ist weg -- eine nicht loeschbare Belegung wird beim naechsten
      // Versuch als tot erkannt und uebernommen.
    }
  }

  /** Alle eigenen Belegungen zurueckgeben -- beim Herunterfahren. */
  alleFreigeben(): void {
    for (const id of [...this.eigene]) this.freigeben(id);
  }
}
