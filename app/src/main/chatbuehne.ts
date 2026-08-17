// EINE CHAT-SITZUNG JE EINTRAG -- Start, Anzeige auf der Buehne, Ende.
//
// WARUM KEIN EIGENES FENSTER MEHR (Umbau 13.08., und die Vorgeschichte gehoert
// dazu, weil sie sonst niemand mehr findet):
//
// Am 12.08. bekam jede Chat-Sitzung ein eigenes BrowserWindow. Die Begruendung
// damals: die Buehne des Hauptfensters zeichnet, was tmux ihr an Lage vorgibt
// -- `zeichneLage(LayoutPayload)` rechnet jede Kachel aus `#{window_layout}` in
// Zellen um --, und eine Chat-Sitzung HAT keinen Pane und keine Zellen. Eine
// zweite, parallele Kachelquelle in einen 2700-Zeilen-Renderer einzuziehen
// haette jede Flaechen-, Raster- und Rollen-Suite mit in die Haftung genommen.
//
// alice hat nach dem ersten echten Gebrauch anders entschieden: „du hast es
// als extra fenster, ich will es aber auch hier in der workbench als
// orchestrator." Der Umbau kostet die befuerchtete Umrechnung NICHT: die
// Ansicht liegt als eigener Kasten (`#chatbuehne`) UEBER dem Kachelgitter, so
// wie die Lese-Ansicht eines Panes ueber ihrem Terminal liegt. Das Gitter
// darunter wird nicht angefasst, tmux bekommt weiter dieselben Zahlen, und die
// Buehne fuer Terminal-Sitzungen bleibt Zeile fuer Zeile dieselbe.
//
// WAS DAMIT WEGFAELLT: die Auflage „das Fenster entsteht mit show: false, und
// nur eine echte Bedienung darf show() erreichen". Es gibt kein Fenster mehr,
// das gezeigt werden koennte -- die Sitzung liegt im Hauptfenster, und ob DAS
// sichtbar ist, entscheidet allein der Mensch. Was bleibt, ist die Trennung
// dahinter: ein unechter Klick (Test, Steuerkanal) STARTET eine Sitzung nur
// (`baue`), er legt sie nicht von sich aus auf die Buehne (`zeigeAufBuehne`).
// Und dieselbe SPUR auf stderr, aus demselben Grund: wer eine Sitzung waehlt
// und nichts sieht, liest an den Zeilen mit dem Praefix `Chatbuehne:` ab, wo es
// haengt.
//
// WAS NICHT WEGFAELLT: der Prozess. Er lebt im Hauptprozess weiter, unabhaengig
// davon, welche Sitzung gerade angezeigt wird -- wer auf eine Terminal-Sitzung
// wechselt, schliesst keine Chat-Sitzung, er sieht sie nur nicht.
import type { BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';

import { Chatsitzung } from './chatsitzung';
import type { ChatEintrag, ChatRegistry } from './chatregistry';
import type { Chatwache } from './chatwache';
import { Chatwerkstatt, werkstattName, type Werkstattworker } from './chatwerkstatt';
import type { Block, Gespraech, Slashbefehl } from '../chat/sdkstrom';

/**
 * EIN SCHLAEFCHEN OHNE EREIGNISSCHLEIFE. `Atomics.wait` auf einem Puffer, auf
 * den niemand schreibt, laeuft schlicht in seine Frist -- das ist der einzige
 * Weg, in Node eine Weile zu warten, ohne dass die Schleife weiterlaeuft.
 * Gebraucht wird er genau einmal: in `beendeKinderSynchron()`, siehe dort.
 */
function schlaefchen(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * LEBT DIESER PROZESS NOCH -- und zwar wirklich?
 *
 * `process.kill(pid, 0)` genuegt hier NICHT, und das ist gemessen: Solange
 * diese App der Elternprozess ist, bleibt ein beendetes Kind als Zombie in der
 * Tabelle stehen, bis Node es einsammelt -- und einsammeln kann Node nur, wenn
 * die Ereignisschleife laeuft, die `beendeKinderSynchron()` gerade anhaelt.
 * Signal 0 meldete den Zombie deshalb als lebend, und das Herunterfahren
 * wartete jedes Mal die volle Frist ab (gemessen: 2,7 s statt 1,2 s). `ps`
 * sagt den Unterschied: Zustand `Z` heisst weg.
 */
function lebt(pid: number): boolean {
  const r = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.error) {
    // Ohne `ps` bleibt nur die gute alte Frage -- lieber einmal zu lange
    // gewartet als ein Kind uebersehen.
    try {
      process.kill(pid, 0);
      return true;
    } catch (fehler) {
      return (fehler as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  const zustand = (r.stdout ?? '').trim();
  return zustand !== '' && !zustand.startsWith('Z');
}

/**
 * WAS DIE BUEHNE BEKOMMT -- und zwar nur das Geaenderte (Befund B1, 12.08.).
 *
 * Vorher ging bei jedem Stueck, das aus stdout kam, der VOLLSTAENDIGE
 * Gespraechsstand ueber IPC. Mit `--include-partial-messages` kommt ungefaehr
 * je Token ein Stueck; ein Werkzeugergebnis von 200 KB wanderte damit je Token
 * einmal durch die Strukturkopie des Kanals. Jetzt reisen der Kopf (klein,
 * immer), die seit dem letzten Takt geaenderten Bloecke und die Reihenfolge
 * der Kennungen.
 */
export interface ChatStandNachricht {
  /**
   * ZU WELCHER SITZUNG dieser Stand gehoert. Im eigenen Fenster war das die
   * Fensterkennung; auf der gemeinsamen Buehne muss es mitreisen, sonst
   * mischte ein Stand, der waehrend eines Wechsels unterwegs war, sein
   * Gespraech in das andere.
   */
  id: string;
  /** Alles ausser den Bloecken -- klein genug, um es jedes Mal zu schicken. */
  kopf: Omit<Gespraech, 'bloecke' | 'befehle'>;
  /**
   * DIE SLASH-BEFEHLE -- NUR, WENN SIE NEU SIND (derselbe Grund wie bei den
   * Bloecken, Befund B1).
   *
   * Die gemessene Liste hat 79 Eintraege mit vollen Beschreibungssaetzen, rund
   * 16 KB. Im Kopf mitzureisen hiesse, sie bei JEDEM Stueck aus stdout ueber
   * IPC zu schicken -- also ungefaehr je Token, und das ist genau der Aufwand,
   * den der Umbau vom 12.08. beseitigt hat. Sie steht deshalb hier daneben und
   * geht nur beim vollen Abgleich und bei einer Aenderung hinaus; `undefined`
   * heisst „unveraendert", und die Ansicht behaelt, was sie hat.
   */
  befehle?: Slashbefehl[];
  /** Nur die Bloecke, die sich seit `seit` geaendert haben. */
  geaendert: Block[];
  /** Die Kennungen ALLER Bloecke, in Reihenfolge. Was fehlt, ist weg. */
  ordnung: string[];
  /** Der Takt, auf dem diese Nachricht beruht -- 0 heisst: alles neu. */
  seit: number;
  sprache: string;
  laeuft: boolean;
  /**
   * Darf der Mensch einen frischen Start angeboten bekommen? Gesetzt, wenn ein
   * Start mit `--resume` scheiterte, ohne dass je ein `init` kam (Befund B3).
   */
  neustartMoeglich: boolean;
  /** Was die Statusleiste unten zeigt -- siehe `ChatStatus`. */
  status: ChatStatus;
}

/**
 * DIE STATUSLEISTE EINER CHAT-SITZUNG (Punkt 2) -- dieselben Groessen, die die
 * Statuszeile einer TERMINAL-Sitzung zeigt, aus DENSELBEN Quellen.
 *
 * NACHGESEHEN, NICHT GERATEN (12.08.). Die Zeile unter einer Terminal-Sitzung
 * zeichnet nicht dieses Programm, sondern `~/.claude/statusline-command.sh`,
 * das die CLI bei jedem Bild aufruft. Sie zeigt: Modell (plus Effort), Ordner
 * und git-Zweig, einen Balken „belegt/Fenster", `5h NN%→hh:mm` und `7d NN%`.
 * Genau diese Groessen stehen hier -- und zwar aus den Quellen, die dieses
 * Programm ohnehin schon liest:
 *
 *   Ordner, Modell   aus dem Strom der Sitzung selbst (`init`-Ereignis)
 *   Tokens           aus dem `result`-Ereignis desselben Stroms
 *   Fenstergroesse   aus der Modell-Registry, ueber `kontextFenster()` --
 *                    dieselbe Funktion, mit der die Worker ihre Auslastung
 *                    bekommen (workerstate.ts)
 *   5h / 7d          aus dem BudgetPoller (budget.ts), der `wb-budget` liest,
 *                    das wiederum ~/.claude/workbench/limits.jsonl liest --
 *                    die Datei, die das Statusline-Skript fortschreibt. Damit
 *                    ist es dieselbe Zahl wie im Terminal, nur einen Schritt
 *                    weiter hinten abgegriffen; eine zweite Leseroutine waere
 *                    eine zweite Wahrheit.
 */
export interface ChatStatus {
  /** Der Ordner der Sitzung. */
  ordner: string;
  /** Der git-Zweig dieses Ordners, leer wenn keiner (kein Repo, kein git). */
  zweig: string;
  /** Das Modell, wie der Harness es meldet. Leer vor dem `init`. */
  modell: string;
  /** Belegte Tokens des letzten Zuges, 0 = unbekannt. */
  tokens: number;
  /** Groesse des Kontextfensters laut Registry, 0 = unbekannt. */
  fenster: number;
  /** Aufgelaufene Kosten in Dollar, -1 = unbekannt (nur, was der Harness nannte). */
  kosten: number;
  /** Anteil des 5-Stunden-Fensters in Prozent, -1 = unbekannt. */
  fuenfStunden: number;
  /** Anteil des 7-Tage-Fensters in Prozent, -1 = unbekannt. */
  siebenTage: number;
  /** Wann das Kontingent zurueckfaellt, im Klartext des Werkzeugs. Leer = unbekannt. */
  zurueck: string;
}

interface Offen {
  eintrag: ChatEintrag;
  sitzung: Chatsitzung;
  /** Welchen Takt die Buehne von DIESER Sitzung zuletzt bekommen hat (Befund B1). */
  gesendeterTakt: number;
  /** Steht ein frischer Start zur Wahl? Siehe `ChatStandNachricht.neustartMoeglich`. */
  neustartMoeglich: boolean;
  /** Wieviele Slash-Befehle die Buehne schon hat -- siehe `ChatStandNachricht.befehle`. */
  gesendeteBefehle: number;
  /** Die tmux-Session, in der die Worker dieser Sitzung landen. Leer = keine. */
  werkstatt: string;
  /**
   * Welcher Freigabemodus zuletzt ANGEFRAGT wurde -- leer, wenn nichts aussteht.
   * Er wandert erst in die Buchfuehrung, wenn der Harness ihn bestaetigt hat
   * (siehe `setzeModus`, Reviewbefund 5).
   */
  gewuenschterModus: string;
  /** Die offene Sammelrunde fuer Stand-Nachrichten -- siehe `schickeStand`. */
  standUhr?: ReturnType<typeof setTimeout>;
}

/**
 * DIE SAMMELFRIST FUER STAND-NACHRICHTEN (Bugjagd-Befund vom 15.08., behoben
 * am 16.08.).
 *
 * Der Harness schreibt je Token ein Stueck auf stdout, und jedes davon loeste
 * bis heute EINE volle Stand-Nachricht aus: die Reihenfolge ALLER Bloecke
 * (`ordnung`) und ein Filter ueber alle Bloecke (`geaendert`) -- beides waechst
 * mit der Laenge des Gespraechs, beides einmal je Token. Das ist quadratischer
 * Aufwand, und er faellt genau dann an, wenn die Sitzung ohnehin am meisten zu
 * tun hat.
 *
 * 50 ms sind schneller, als ein Mensch Bilder unterscheidet, und die
 * Nachrichten sind SAMMELND, nicht ueberspringend: was in der Frist anfiel,
 * geht mit dem naechsten Stand hinaus (`gesendeterTakt` steigt erst beim
 * wirklichen Senden). Dieselbe Bauform, mit der die Terminal-Ausgabe seit dem
 * 16.08. gebuendelt wird (main/ausgabe.ts).
 */
const STAND_TAKT_MS = 50;

/** Die beiden FREMDEN Zahlen der Statusleiste -- siehe `Chatbuehne.statusQuelle`. */
export interface ChatStatusQuelle {
  /** Die Fenstergroesse eines Modells laut Registry, 0 = unbekannt. */
  kontextFenster(modell: string): number;
  /** Anteil des 5-Stunden-Fensters in Prozent, -1 = unbekannt. */
  fuenfStunden: number;
  /** Anteil des 7-Tage-Fensters in Prozent, -1 = unbekannt. */
  siebenTage: number;
  /** Wann das Kontingent zurueckfaellt, im Klartext. Leer = unbekannt. */
  zurueck: string;
}

export class Chatbuehne {
  private readonly offen = new Map<string, Offen>();

  /** Der zuletzt gelesene git-Zweig je Ordner -- siehe `zweigVon()`. */
  private readonly zweige = new Map<string, { zweig: string; geholt: number }>();

  /** Die zuletzt gelesene Workerliste je Sitzung -- siehe `workerVon()`. */
  private readonly workerStand = new Map<string, Werkstattworker[]>();

  /** Welche Sitzung liegt auf der Buehne? Leer heisst: eine Terminal-Sitzung. */
  private gezeigt = '';

  /** Einmal synchron beendet, nicht wieder -- siehe `beendeKinderSynchron()`. */
  private kinderBeendet = false;

  /** Wer auf die Bereitschaftsmeldung der Buehne wartet (siehe `zeigeAufBuehne`). */
  private warteAufBuehne: { id: string; melden: () => void } | null = null;

  constructor(
    private readonly registry: ChatRegistry,
    /** Das Hauptfenster -- die einzige Oberflaeche, die eine Chat-Sitzung zeigt. */
    private readonly fenster: () => BrowserWindow | null,
    /** Die Sprache der Oberflaeche -- dieselbe Ableitung wie in den anderen Fenstern. */
    private readonly sprache: () => string,
    /**
     * Das Modell an die Oberflaeche schicken. Daran haengt, WAS die Buehne
     * zeigt: `chatGezeigt` reist im Modell, nicht in einem eigenen Kanal --
     * eine zweite Quelle fuer dieselbe Frage waere eine zweite Wahrheit.
     */
    private readonly melden: () => void,
    /**
     * Der Befehl, der eine Sitzung startet. Im Betrieb 'claude'; ein Testlauf
     * setzt hier einen Attrappen-Harness ein (config.chatBefehl) und prueft
     * damit die ganze Kette, ohne ein echtes Modell zu fragen.
     */
    private readonly befehl = 'claude',
    /**
     * Woher die Statusleiste ihre beiden FREMDEN Zahlen bekommt (Punkt 2): die
     * Groesse des Kontextfensters aus der Modell-Registry und den
     * Kontingentstand aus dem BudgetPoller. Als Rueckrufe, damit diese Datei
     * weder die Registry noch `wb-budget` kennt -- beides hat main.ts schon,
     * und zwei Leser derselben Datei waeren zwei Wahrheiten.
     */
    private readonly statusQuelle: () => ChatStatusQuelle = () => ({
      kontextFenster: () => 0,
      fuenfStunden: -1,
      siebenTage: -1,
      zurueck: '',
    }),
    /**
     * Die Werkstatt -- die tmux-Session, in der die Worker dieser Chat-Sitzung
     * landen (Punkt 1). Fehlt sie (kein tmux), laeuft die Sitzung wie bisher,
     * nur ohne eigenen Ort fuer ihre Worker.
     */
    private readonly werkstatt: Chatwerkstatt | null = null,
    /**
     * DIE KONTEXTWACHE (15.08., der bewusst offene Punkt vom 12.08.). Sie sieht
     * nur Sitzungen an, deren Prozess ohnehin laeuft -- sie startet keine
     * (chatwache.ts, Dateikopf). Fehlt sie, verhaelt sich die Buehne wie
     * vorher: die Sitzung laeuft, und niemand achtet auf ihren Kontext.
     */
    private readonly wache: Chatwache | null = null,
  ) {}

  /**
   * EIN TAKT DER KONTEXTWACHE. Er kommt aus dem Takt der Oberflaeche und nicht
   * aus einer eigenen Uhr: zwei Uhren im Hauptprozess waeren zwei Antworten auf
   * die Frage, wie spaet es ist -- und die Wache haengt an Fristen.
   *
   * Gereicht werden ihr ALLE offenen Eintraege, auch die ohne lebenden Prozess
   * -- die Wache schickt einer beendeten Sitzung nichts, aber sie muss von
   * deren Ende ERFAHREN: stirbt der Prozess, waehrend sie auf die Uebergabe
   * oder die Bestaetigung wartet, fiel die Sitzung bis zum 15.08. einfach aus
   * dem Takt heraus, und die Kette brach stumm ab (Reviewbefund 11). Das
   * Aussortieren macht jetzt `Chatwache.takt`, weil nur sie weiss, ob zu dieser
   * Sitzung noch etwas offen war.
   */
  wacheTakt(): void {
    if (!this.wache) return;
    if (this.offen.size === 0) return;
    const alle: [string, Chatsitzung][] = [];
    for (const [id, o] of this.offen) alle.push([id, o.sitzung]);
    this.wache.takt(alle);
  }

  /**
   * DIE WORKER EINER CHAT-SITZUNG -- gemessen an ihrer Werkstatt, nicht
   * gemerkt. Fuer eine Sitzung, deren Prozess gerade nicht laeuft, wird
   * trotzdem nachgesehen: ihre Worker koennen ihn ueberlebt haben, und dann
   * gehoeren sie weiter in die Anzeige.
   */
  workerVon(id: string, frisch = false): Werkstattworker[] {
    if (!this.werkstatt) return [];
    // NUR DIE GEZEIGTE SITZUNG FRAGT TMUX (Reviewbefund 3, 12.08.).
    //
    // GEMESSEN vor der Aenderung: ein `worker()`-Aufruf kostet im Median
    // 2,8 ms, zehn Chat-Eintraege also 25,6 ms je Takt -- 1,3 % des
    // 2000-ms-Takts. Das allein waere zu verschmerzen. Der Grund fuer die
    // Aenderung steht daneben: jeder dieser Aufrufe ist ein `spawnSync` mit
    // einer Zeitgrenze, und ein haengender tmux-Server hielt damit den
    // Hauptprozess je Takt bis zu zehnmal hintereinander auf. Jetzt fragt je
    // Takt hoechstens EINE Sitzung, und ihre Zeitgrenze steht bei 1500 ms
    // (chatwerkstatt.ts, `worker`).
    //
    // Wer nicht gezeigt wird, bekommt den zuletzt gelesenen Stand. Er ist
    // hoechstens einen Wechsel alt und wird nirgends fuer eine Entscheidung
    // benutzt -- gezeichnet wird er nur in der Leiste der GEZEIGTEN Sitzung.
    if (!frisch) return this.workerStand.get(id) ?? [];
    const o = this.offen.get(id);
    const eintrag = o?.eintrag ?? this.registry.einer(id);
    if (!eintrag) return [];
    const liste = this.werkstatt.worker(o?.werkstatt || werkstattName(id, eintrag.ordner));
    this.workerStand.set(id, liste);
    return liste;
  }

  /**
   * DIE WERKSTATT EINER SITZUNG ABRAEUMEN, deren Eintrag es nicht mehr GIBT
   * (Reviewbefund 1). Der Loeschzweig kennt den Ordner noch, wenn die
   * Buchfuehrung ihn schon nicht mehr fuehrt -- also bildet er den Namen mit
   * ihm, statt sich darauf zu verlassen, dass die Reihenfolge stimmt.
   *
   * Lebende Worker bleiben geschuetzt: das entscheidet `aufraeumen()` selbst.
   * Gibt zurueck, ob wirklich abgeraeumt wurde.
   */
  raeumeWerkstatt(id: string, ordner: string): boolean {
    if (!ordner) return false;
    return this.werkstatt?.aufraeumen(werkstattName(id, ordner)) ?? false;
  }

  /** Der tmux-Name der Werkstatt dieser Sitzung -- leer, wenn es keine gibt. */
  werkstattVon(id: string): string {
    const o = this.offen.get(id);
    if (o) return o.werkstatt;
    const eintrag = this.registry.einer(id);
    return eintrag ? werkstattName(id, eintrag.ordner) : '';
  }

  /**
   * DER git-ZWEIG EINES ORDNERS, hoechstens alle zehn Sekunden neu gefragt.
   *
   * `nachricht()` laeuft je Stueck aus stdout, also ungefaehr je Token; ein
   * `git`-Aufruf in dieser Frequenz waere derselbe Fehler wie der volle Stand
   * je Token (Befund B1). Zehn Sekunden sind kurz genug, dass ein Zweigwechsel
   * im Vorbeigehen auffaellt, und lang genug, dass die Zeile nichts kostet.
   */
  private zweigVon(ordner: string): string {
    const jetzt = Date.now();
    const alt = this.zweige.get(ordner);
    if (alt && jetzt - alt.geholt < 10_000) return alt.zweig;
    let zweig = '';
    try {
      const r = spawnSync('git', ['-C', ordner, 'branch', '--show-current'], {
        encoding: 'utf8', timeout: 2000,
      });
      if (!r.error && r.status === 0) zweig = (r.stdout ?? '').trim();
    } catch {
      // Kein git, kein Repo, kein Zweig -- die Zeile zeigt dann keinen.
    }
    this.zweige.set(ordner, { zweig, geholt: jetzt });
    return zweig;
  }

  private status(o: Offen): ChatStatus {
    const g = o.sitzung.stand();
    const quelle = this.statusQuelle();
    // Das Modell, das der Harness MELDET, schlaegt das eingestellte: eingestellt
    // ist oft nichts ("die Vorgabe des Harness"), und dann stuende hier ein
    // leeres Feld, waehrend die Sitzung laengst mit einem Modell laeuft.
    const modell = g.modell || o.eintrag.modell;
    return {
      ordner: g.ordner || o.eintrag.ordner,
      zweig: this.zweigVon(g.ordner || o.eintrag.ordner),
      modell,
      // DER BELEGTE KONTEXT, nicht die frische Ein- und Ausgabe des letzten
      // Zuges (Korrektur vom 15.08., gemessen). Hier stand `g.tokens` --
      // `input_tokens + output_tokens` aus dem `result`, also gerade OHNE den
      // Zwischenspeicher, in dem fast der ganze Kontext liegt. Gegen `fenster`
      // gerechnet stand der Balken damit dauerhaft bei null: am Mitschnitt
      // sitzung-zwei-zuege.jsonl sind es 248 gegenueber 45.022 wirklich
      // belegten Tokens. `g.kontext` ist dieselbe Rechnung, mit
      // der die Worker ihre Auslastung bekommen (workerstate.ts), und dieselbe,
      // an der die Kontextwache haengt -- EINE Zahl, eine Quelle.
      tokens: g.kontext,
      fenster: modell ? quelle.kontextFenster(modell) : 0,
      kosten: g.kosten,
      fuenfStunden: quelle.fuenfStunden,
      siebenTage: quelle.siebenTage,
      zurueck: quelle.zurueck,
    };
  }

  /** Die Kennungen der Sitzungen, deren Prozess gerade laeuft. */
  laufende(): string[] {
    return [...this.offen.entries()].filter(([, o]) => o.sitzung.istOffen()).map(([id]) => id);
  }

  /** Welche Sitzung gerade auf der Buehne liegt -- leer, wenn keine. */
  gezeigter(): string {
    return this.gezeigt;
  }

  /**
   * Der Stand fuer die Buehne. `seit` sagt, was sie schon hat -- 0 heisst
   * „alles". Danach steigt der gemerkte Takt, damit die naechste Nachricht
   * wirklich nur das Neue traegt.
   */
  stand(id: string, seit = 0): ChatStandNachricht | null {
    const o = this.offen.get(id);
    if (!o) return null;
    return this.nachricht(id, o, seit);
  }

  private nachricht(id: string, o: Offen, seit: number): ChatStandNachricht {
    const g = o.sitzung.stand();
    const { bloecke, befehle, ...kopf } = g;
    o.gesendeterTakt = g.takt;
    // Die Befehlsliste waechst nur einmal (mit der Antwort auf den Handschlag)
    // und danach nie wieder -- ihre Laenge genuegt deshalb als Merkmal.
    const befehleNeu = seit <= 0 || befehle.length !== o.gesendeteBefehle;
    if (befehleNeu) o.gesendeteBefehle = befehle.length;
    return {
      id,
      kopf,
      ...(befehleNeu ? { befehle } : {}),
      geaendert: seit <= 0 ? bloecke : bloecke.filter((b) => b.rev > seit),
      ordnung: bloecke.map((b) => b.id),
      seit,
      sprache: this.sprache(),
      laeuft: o.sitzung.istOffen(),
      neustartMoeglich: o.neustartMoeglich,
      status: this.status(o),
    };
  }

  senden(id: string, text: string): boolean {
    return this.offen.get(id)?.sitzung.sende(text) ?? false;
  }

  freigabe(id: string, anfrageId: string, erlauben: boolean): boolean {
    const o = this.offen.get(id);
    if (!o) return false;
    return o.sitzung.entscheide(anfrageId, erlauben, erlauben ? '' : 'Vom Menschen abgelehnt.');
  }

  /**
   * DEN FREIGABEMODUS UMSTELLEN (Luecke 5c). Gemerkt wird er ausserdem in der
   * Buchfuehrung: ein Neustart soll mit demselben Modus beginnen, den der
   * Mensch zuletzt gewaehlt hat, nicht wieder mit dem von vor Wochen.
   */
  setzeModus(id: string, modus: string): boolean {
    const o = this.offen.get(id);
    if (!o || !modus) return false;
    if (!o.sitzung.setzeModus(modus)) return false;
    // GEMERKT WIRD ER ERST, WENN DER HARNESS IHN BESTAETIGT HAT
    // (Reviewbefund 5, 12.08.). Hier stand der Modus sofort in chats.json --
    // `setzeModus` gibt nur zurueck, ob das Schreiben auf stdin gelang. Lehnt
    // die CLI ihn ab, zeigte die Marke weiterhin richtig den geltenden Modus,
    // aber der ABGELEHNTE stand in der Buchfuehrung und ginge beim naechsten
    // Start als `--permission-mode <abgelehnt>` an die CLI, die den Start
    // damit verweigert. Der Merkposten wird deshalb nur vorgemerkt; geschrieben
    // wird er in `aufStand`, sobald der Strom den bestaetigten Modus meldet.
    o.gewuenschterModus = modus;
    return true;
  }

  /** Einen laufenden Zug unterbrechen (Punkt 6). */
  halte(id: string): boolean {
    return this.offen.get(id)?.sitzung.halte() ?? false;
  }

  /**
   * DIE SITZUNG STARTEN -- OHNE sie auf die Buehne zu legen. Mehrfach
   * aufrufbar: eine laufende wird wiederverwendet, damit ein zweiter Klick
   * nicht einen zweiten Prozess startet.
   */
  async baue(id: string): Promise<boolean> {
    const da = this.offen.get(id);
    if (da) return true;

    const eintrag = this.registry.einer(id);
    if (!eintrag) {
      process.stderr.write(`Chatbuehne: keine Sitzung '${id}'\n`);
      return false;
    }

    // BELEGEN, BEVOR EIN PROZESS ENTSTEHT (Befund B4, 12.08.). Auf einer
    // Unterhaltung darf nur ein Schreiber laufen -- auf der ganzen Maschine,
    // nicht nur in diesem Prozess. Eine tote Belegung wird uebernommen.
    const belegung = this.registry.belegen(id);
    if (!belegung.gelungen) {
      process.stderr.write(
        `Chatbuehne: '${id}' laeuft schon in Prozess ${belegung.fremdePid} -- nicht gestartet\n`,
      );
      return false;
    }

    // Was diese Sitzung fortsetzen SOLLTE -- gemerkt, weil der Fehlstart-Fall
    // unten wissen muss, ob ueberhaupt fortgesetzt werden sollte.
    const wollteFortsetzen = eintrag.sessionId;

    // DIE WERKSTATT, BEVOR DER PROZESS ENTSTEHT (Punkt 1). Ihr Name muss in
    // der Umgebung des Prozesses stehen, sonst sucht sich `claude-worker` sein
    // Ziel selbst -- und findet eine fremde Workbench (chatwerkstatt.ts,
    // Dateikopf: dort steht die gemessene Suchreihenfolge von `pi-worker`).
    const werkstatt = this.werkstatt?.sicherstellen(id, eintrag.ordner) ?? '';

    const sitzung = new Chatsitzung(
      {
        ordner: eintrag.ordner,
        modell: eintrag.modell,
        modus: eintrag.modus,
        fortsetzen: wollteFortsetzen,
        werkstatt,
      },
      {
        aufStand: (g) => {
          // Die Unterhaltung des Harness merken, sobald sie bekannt ist --
          // ohne sie gibt es beim naechsten Start kein Fortsetzen.
          if (g.sessionId && g.sessionId !== eintrag.sessionId) {
            eintrag.sessionId = g.sessionId;
            this.registry.aendern(id, { sessionId: g.sessionId, zuletzt: new Date().toISOString() });
          }
          // DER BESTAETIGTE FREIGABEMODUS (Reviewbefund 5). `g.modus` traegt,
          // was der HARNESS meldet -- nach dem Handschlag den geltenden, nach
          // einer Umschaltung den neuen. Erst wenn er mit dem angefragten
          // uebereinstimmt, wandert er in die Buchfuehrung; eine Absage laesst
          // den alten stehen, und der naechste Start bekommt einen Modus, den
          // die CLI auch annimmt.
          const o = this.offen.get(id);
          if (o?.gewuenschterModus && g.modus === o.gewuenschterModus) {
            o.gewuenschterModus = '';
            if (eintrag.modus !== g.modus) {
              eintrag.modus = g.modus;
              this.registry.aendern(id, { modus: g.modus });
            }
          }
          this.schickeStand(id);
        },
        aufEnde: (code) => {
          const g = sitzung.stand();
          // EIN FEHLSTART AUF EINER VERSCHWUNDENEN UNTERHALTUNG (Befund B3,
          // 12.08.). Die CLI raeumt Mitschnitte nach `cleanupPeriodDays` weg,
          // in der Vorgabe nach dreissig Tagen; danach endet jeder Start mit
          // Rueckgabewert 1 und `No conversation found with session ID`.
          // Blieb die Kennung stehen, lief die Sitzung fuer immer in denselben
          // Fehler, und herausgefuehrt haette nur, wer chats.json von Hand
          // aendert. Also: Kennung leeren und einen frischen Start anbieten.
          const o = this.offen.get(id);
          if (code !== 0 && !g.initGesehen && wollteFortsetzen) {
            eintrag.sessionId = '';
            this.registry.aendern(id, { sessionId: '' });
            sitzung.melde(
              'Die fortzusetzende Unterhaltung gibt es nicht mehr. Die Kennung ist geleert -- '
              + 'ein frischer Start legt eine neue an.',
            );
            if (o) o.neustartMoeglich = true;
          }
          // SOFORT: nach dem Ende kommt nichts mehr, was eine Sammelrunde
          // noch mitnehmen koennte.
          this.schickeStand(id, true);
        },
      },
      this.befehl,
    );

    this.offen.set(id, {
      eintrag, sitzung, gesendeterTakt: 0, neustartMoeglich: false, gesendeteBefehle: 0,
      werkstatt, gewuenschterModus: '',
    });
    sitzung.starte();
    process.stderr.write(`Chatbuehne: gestartet, noch nicht gezeigt (${id})\n`);
    return true;
  }

  /**
   * DEN STAND SCHICKEN -- nur das Geaenderte (Befund B1), und nur, solange
   * diese Sitzung auch gezeigt wird. Eine Sitzung im Hintergrund laeuft
   * weiter, aber ihre Stuecke muessen nicht ueber IPC reisen: beim Wechsel
   * holt die Buehne den vollen Stand ohnehin neu (`daten(0)`).
   */
  /**
   * Einen Stand an die Buehne schicken -- gesammelt (siehe `STAND_TAKT_MS`).
   * `sofort` ist fuer die Ereignisse, nach denen nichts mehr nachkommt: das
   * Ende des Prozesses. Dort waere eine Frist eine Nachricht, die vielleicht
   * nie mehr faellt.
   */
  private schickeStand(id: string, sofort = false): void {
    const o = this.offen.get(id);
    if (!o || id !== this.gezeigt) return;
    if (sofort) {
      this.standUhrWeg(o);
      this.standJetzt(id, o);
      return;
    }
    // Laeuft schon eine Sammelrunde, ist alles gesagt: sie schickt den Stand
    // MIT dem, was bis dahin noch dazukommt.
    if (o.standUhr !== undefined) return;
    o.standUhr = setTimeout(() => {
      o.standUhr = undefined;
      // Zwischenzeitlich geschlossen oder von der Buehne genommen: dann gibt
      // es niemanden mehr, der diesen Stand braucht.
      if (this.offen.get(id) !== o || id !== this.gezeigt) return;
      this.standJetzt(id, o);
    }, STAND_TAKT_MS);
  }

  private standJetzt(id: string, o: Offen): void {
    const w = this.fenster();
    if (!w || w.isDestroyed()) return;
    w.webContents.send('awb:chat-stand-neu', this.nachricht(id, o, o.gesendeterTakt));
  }

  /** Eine offene Sammelrunde abraeumen -- sie hat keinen Empfaenger mehr. */
  private standUhrWeg(o: Offen): void {
    if (o.standUhr === undefined) return;
    clearTimeout(o.standUhr);
    o.standUhr = undefined;
  }

  /**
   * AUF DIE BUEHNE LEGEN. Startet die Sitzung, falls sie noch nicht laeuft,
   * und wartet auf die Bereitschaftsmeldung der Oberflaeche -- ohne dieses
   * Warten liefe ein Griff des Steuerkanals (tippen, lesen, fotografieren) ins
   * noch leere Feld, weil Modell-Nachricht und `executeJavaScript` zwei
   * verschiedene Wege in denselben Renderer sind und ihre Reihenfolge nicht
   * zugesagt ist.
   */
  async zeigeAufBuehne(id: string, frist = 8000): Promise<boolean> {
    if (!(await this.baue(id))) return false;
    if (this.gezeigt === id) return true;
    const o = this.offen.get(id);
    if (o) { o.gesendeterTakt = 0; o.gesendeteBefehle = 0; }
    this.gezeigt = id;
    const gemeldet = new Promise<void>((aufloesen) => {
      this.warteAufBuehne = { id, melden: aufloesen };
    });
    this.melden();
    let uhr: NodeJS.Timeout | undefined;
    await Promise.race([
      gemeldet,
      new Promise<void>((aufloesen) => {
        uhr = setTimeout(() => {
          process.stderr.write(`Chatbuehne: keine Bereitschaft nach ${frist} ms (${id})\n`);
          aufloesen();
        }, frist);
      }),
    ]).finally(() => clearTimeout(uhr));
    process.stderr.write(`Chatbuehne: auf der Buehne (${id})\n`);
    return true;
  }

  /** Die Oberflaeche hat gezeichnet. Nur die erwartete Kennung zaehlt. */
  bereitGemeldet(id: string): void {
    process.stderr.write(`Chatbuehne: bereit (${id})\n`);
    if (this.warteAufBuehne?.id !== id) return;
    this.warteAufBuehne.melden();
    this.warteAufBuehne = null;
  }

  /**
   * DER WEG DER ECHTEN BEDIENUNG. Er tut dasselbe wie `zeigeAufBuehne` und
   * hinterlaesst zusaetzlich seine Spur: ein unechter Klick (Test,
   * Steuerkanal) kommt hier nie an -- der Renderer schickt fuer ihn
   * 'chat-bauen'.
   */
  async zeigeNachEchtemKlick(id: string): Promise<void> {
    process.stderr.write(`Chatbuehne: echter Klick (${id})\n`);
    await this.zeigeAufBuehne(id);
  }

  /**
   * DIE BUEHNE FREIGEBEN -- die Sitzung laeuft weiter. Aufgerufen, sobald eine
   * Terminal-Sitzung gewaehlt wird: dann gehoert die Flaeche wieder den
   * Kacheln, und der Chat-Prozess merkt davon nichts.
   */
  verbergen(): void {
    if (!this.gezeigt) return;
    const o = this.offen.get(this.gezeigt);
    // Der gemerkte Takt gilt fuer die BUEHNE. Wird nichts mehr gezeigt, hat sie
    // nichts mehr -- der naechste Wechsel muss den vollen Stand bekommen.
    if (o) { o.gesendeterTakt = 0; o.gesendeteBefehle = 0; this.standUhrWeg(o); }
    process.stderr.write(`Chatbuehne: von der Buehne genommen (${this.gezeigt})\n`);
    this.gezeigt = '';
    this.warteAufBuehne = null;
    this.melden();
  }

  /**
   * EIN FRISCHER START (Befund B3). Beendet den alten Prozess und startet
   * einen neuen -- mit der Kennung, die dann in der Buchfuehrung steht. Nach
   * einem Fehlstart ist die leer, es entsteht also eine neue Unterhaltung.
   */
  async neustart(id: string): Promise<boolean> {
    const o = this.offen.get(id);
    if (!o) return false;
    this.standUhrWeg(o);
    await o.sitzung.beende();
    this.offen.delete(id);
    this.registry.freigeben(id);
    // Ein frischer Start ist eine neue Unterhaltung -- die Wache faengt mit ihr
    // von vorn an, statt auf die Uebergabe der alten zu warten.
    this.wache?.vergiss(id);
    if (!(await this.baue(id))) return false;
    // Die Ansicht bleibt stehen; sie bekommt den vollen Stand der NEUEN Sitzung
    // (`gesendeterTakt` ist 0), und was aus der alten noch haengt, faellt mit
    // der neuen Ordnung heraus.
    this.schickeStand(id);
    return true;
  }

  /**
   * Eine Sitzung beenden. Lag sie auf der Buehne, ist die Buehne danach frei.
   *
   * REIHENFOLGE (Bugjagd-Befund vom 15.08., behoben am 16.08.): Der Prozess
   * wird beendet, und ERST WENN ER WIRKLICH WEG IST, fallen das Schloss der
   * Buchfuehrung und die Werkstatt. Bis heute lief `beende()` unbeaufsichtigt
   * weiter (`void`), waehrend Schloss und Werkstatt schon freigegeben waren --
   * in diesem Fenster konnte ein zweiter Schreiber dieselbe Unterhaltung
   * belegen, und die Werkstatt-Session verschwand unter einem Prozess, der noch
   * lief. `neustart()` macht es seit jeher richtig (await), hier fehlte es.
   *
   * Was NICHT wartet: die Oberflaeche. Eintrag, Wache und Buehne sind sofort
   * frei, damit ein Klick nicht am Herunterfahren eines Kindprozesses haengt.
   */
  schliesse(id: string): void {
    const o = this.offen.get(id);
    if (o) {
      this.standUhrWeg(o);
      this.offen.delete(id);
    }
    // Der Merkposten der Wache geht mit: bliebe er stehen, faende ein spaeterer
    // Neustart derselben Kennung eine Wache vor, die noch auf die Uebergabe
    // eines Gespraechs wartet, das es nicht mehr gibt.
    this.wache?.vergiss(id);
    // DIE WERKSTATT AUCH OHNE OFFENEN EINTRAG (Reviewbefund 1, 12.08.).
    //
    // Bis heute kehrte diese Funktion bei fehlendem `offen`-Eintrag sofort
    // zurueck -- also genau in dem Fall, der beim Loeschen der Normalfall ist:
    // App neu gestartet, keine Chat-Sitzung laeuft, Rechtsklick auf die Zeile,
    // „Endgueltig loeschen". Der Eintrag verschwand aus chats.json, die
    // tmux-Session samt ihrem Halte-Pane (`while :; do sleep 3600; done`) blieb
    // stehen -- und ihr Name kam aus einer Kennung, die es nicht mehr gab: ueber
    // die Oberflaeche war sie danach nicht mehr erreichbar. Dass der Name
    // deterministisch ist, machte es nicht besser, es erklaerte nur, warum sie
    // den Neustart ueberhaupt ueberlebt hat.
    //
    // Der Name wird deshalb NOTFALLS selbst gebildet (`werkstattVon` faellt auf
    // `werkstattName` zurueck). Was darin laeuft, bleibt geschuetzt:
    // `aufraeumen()` sieht selbst nach und laesst eine Session mit lebenden
    // Workern stehen.
    const werkstatt = o?.werkstatt || this.werkstattVon(id);
    if (this.gezeigt === id) {
      this.gezeigt = '';
      this.warteAufBuehne = null;
    }
    this.melden();
    // Der Nachlauf: erst das Ende des Prozesses abwarten, dann Schloss und
    // Werkstatt. Gibt es keinen Prozess (Loeschen einer Sitzung, die gar nicht
    // laeuft), ist das Versprechen sofort eingeloest und die Werkstatt faellt
    // im naechsten Zug -- kein Warten, das niemandem nuetzt.
    const beendet = o ? o.sitzung.beende() : Promise.resolve();
    void beendet
      .catch((e) => {
        process.stderr.write(`Chatbuehne: Beenden von ${id} meldete einen Fehler (${(e as Error).message})\n`);
      })
      .then(() => {
        if (o) this.registry.freigeben(id);
        if (werkstatt) this.werkstatt?.aufraeumen(werkstatt);
      });
  }

  /**
   * ALLES BEENDEN -- UND WARTEN, BIS ES WIRKLICH WEG IST (Befund B5, 12.08.).
   *
   * DER SIGNALWEG, gemessen am 12.08.: Bei einem SIGTERM an die App bleibt
   * fuer `alleBeenden()` keine Zeit -- gemessen war der Prozess nach rund
   * 400 ms weg, mitten im Warten, und das Versprechen fiel nie. Auch ein
   * `exit`-Haken half nicht; er lief auf diesem Weg gar nicht mehr
   * (nachgemessen: das Kind stand danach noch als `S` in der Prozessliste).
   * Was bleibt, ist der synchrone Weg, und der hier ist es: erst allen Kindern
   * ihr SIGTERM, dann WARTEN, ohne die Ereignisschleife -- denn genau die nimmt
   * Electron uns in diesem Augenblick weg.
   */
  beendeKinderSynchron(frist = 2000): number {
    // `before-quit` UND `will-quit` fuehren hierher; das zweite Mal ist die
    // Arbeit getan, und ein zweiter Durchlauf haenge den Ausstieg nur noch
    // einmal um die Frist auf.
    if (this.kinderBeendet) return 0;
    this.kinderBeendet = true;

    for (const o of this.offen.values()) o.sitzung.signalSofort();

    const bis = Date.now() + frist;
    while (Date.now() < bis && this.lebendeKinder().length > 0) schlaefchen(50);
    const zaeh = this.lebendeKinder();
    for (const pid of zaeh) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // In der Zwischenzeit doch gegangen.
      }
    }
    if (zaeh.length > 0) {
      const hart = Date.now() + 500;
      while (Date.now() < hart && this.lebendeKinder().length > 0) schlaefchen(25);
    }

    // DIE LEEREN WERKSTAETTEN GEHEN MIT, UND ZWAR HIER (gemessen 12.08.).
    // `alleBeenden()` ist asynchron und laeuft auf dem Signalweg nicht mehr --
    // genau der Grund, aus dem es diese synchrone Fassung ueberhaupt gibt
    // (Befund B5). Ohne diese Zeilen blieben nach jedem Beenden so viele
    // tmux-Sessions stehen, wie Chat-Sitzungen offen waren; im Testlauf waren
    // es zwei. Eine Werkstatt MIT laufenden Workern bleibt auch hier stehen --
    // `aufraeumen()` sieht selbst nach.
    for (const o of this.offen.values()) {
      if (o.werkstatt) this.werkstatt?.aufraeumen(o.werkstatt);
    }
    return this.lebendeKinder().length;
  }

  private lebendeKinder(): number[] {
    const raus: number[] = [];
    for (const o of this.offen.values()) {
      const pid = o.sitzung.kindPid();
      if (pid && lebt(pid)) raus.push(pid);
    }
    return raus;
  }

  async alleBeenden(): Promise<void> {
    const arbeit: Promise<void>[] = [];
    for (const [id, o] of [...this.offen]) {
      arbeit.push(o.sitzung.beende());
      this.offen.delete(id);
      this.registry.freigeben(id);
      this.wache?.vergiss(id);
      // Leere Werkstaetten gehen mit; eine mit laufenden Workern bleibt
      // stehen, so wie eine Terminal-Sitzung dieses Programm ueberlebt.
      if (o.werkstatt) this.werkstatt?.aufraeumen(o.werkstatt);
    }
    this.gezeigt = '';
    this.warteAufBuehne = null;
    await Promise.all(arbeit);
  }
}
