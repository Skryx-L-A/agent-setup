// Der Zustand der Oberflaeche selbst: wie breit die linke Leiste steht, wie
// sortiert wird, welche Session gewaehlt ist. Er liegt im eigenen Verzeichnis
// des Programms und NICHT bei den Zustandsdateien der Sessions -- die gehoeren
// den wb-Werkzeugen, und zwei Schreiber auf derselben Datei sind ein Fehler,
// den wir schon einmal bezahlt haben.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SortKey = 'recent' | 'folder' | 'name';

export interface UiState {
  /** Breite der linken Leiste in Pixeln. */
  sidebarWidth: number;
  /** Beendete Sessions einblenden (A12). Aus, solange nichts anderes gesagt ist. */
  showStopped: boolean;
  /** Voreinstellung der Sortierung (A11, A16). */
  sort: SortKey;
  /** Von Hand gezogene Reihenfolge. Sie schlaegt die Sortierung (A10). */
  order: string[];
  /**
   * VON HAND GEZOGENE REIHENFOLGE DER PROJEKTE (08.09.2026, Befund des Nutzers
   * an der Mac-Fassung: „Man kann die Projektordner nicht in der Reihenfolge
   * verschieben").
   *
   * Ein Ordner je Eintrag (`dir` der Sitzung, `ordner` der Chat-Sitzung) --
   * derselbe Schluessel, unter dem beide Oberflaechen ihre Projekte gruppieren.
   * `order` daneben ordnet die ZEILEN innerhalb eines Projekts; die beiden
   * Listen greifen nicht ineinander, weil `sortProjekte` nur ganze Bloecke
   * umstellt und ihre innere Folge unangetastet laesst.
   *
   * Leer heisst „niemand hat gezogen": dann bleibt die Reihenfolge genau die,
   * die aus `sort` und `order` faellt. Ein Ordner, der hier nicht steht, kommt
   * hinter alle genannten, in der bisherigen Sortierung.
   */
  projektReihenfolge: string[];
  /** Gewaehlte Session. */
  selected: string;
  /** Gewaehlter Worker-Tab der rechten Leiste. */
  workerTab: number;
  /**
   * DAS UEBERSTEUERN DER CHAT-ANSICHT JE SITZUNG (12.08., Rechtsklick auf die
   * Sitzung in der linken Leiste). Ein Eintrag je Sitzungskennung; fehlt einer,
   * gilt die Rollenvorgabe aus den Einstellungen (chat/ansichtsregel.ts).
   *
   * WARUM HIER UND NICHT IN settings.json: die Einstellungsdatei ist der
   * GETEILTE Vertrag zwischen diesem Programm und den wb-Werkzeugen -- was
   * dort steht, meinen beide Seiten gemeinsam. Eine Ansichtsvorliebe fuer
   * genau eine Sitzung meint niemand ausser diesem Fenster. Sie gehoert
   * deshalb neben `sidebarWidth`, `showStopped`, `sort`, `selected` und
   * `workerTab`: genau diese Art Zustand traegt ui.json ohnehin. Und sie faellt
   * hier von selbst wieder heraus -- eine Sitzung, die es nicht mehr gibt,
   * nimmt `sitzungenAufraeumen` beim naechsten Durchgang mit.
   */
  chatAnsichtSitzung: Record<string, boolean>;
  /**
   * WAS DIE FLAECHE JE SITZUNG ZEIGT (04.09.2026) -- 'orchestrator' oder
   * 'worker'. Fehlt ein Eintrag, gilt 'worker': das ist der Fall, in dem es
   * ueberhaupt etwas zu kacheln gibt, und die Ansicht, mit der die Oberflaeche
   * bisher immer stand.
   *
   * WARUM JE SITZUNG: alice fuehrt mehrere Projekte gleichzeitig und
   * arbeitet in dem einen am Orchestrator, im anderen an den Workern. Eine
   * globale Wahl haette bei jedem Wechsel die falsche Flaeche gezeigt. Sie
   * gehoert aus demselben Grund hierher wie `chatAnsichtSitzung` und nicht in
   * die Einstellungsdatei: sie meint niemand ausser diesem Fenster, und sie
   * faellt mit der Sitzung von selbst wieder heraus (`sitzungenAufraeumen`).
   */
  flaecheSitzung: Record<string, string>;
  /**
   * DIE BREITE DES INSPEKTORS -- und seit dem 05.09.2026 (Electron-Befund 1)
   * die EINZIGE Breite, die er hat.
   *
   * Bis dahin standen hier zwei Zahlen nebeneinander: `rightWidth` fuer einen
   * vierzig Bildpunkte schmalen Reiterstreifen und `blattBreite` fuer das
   * geoeffnete Blatt. Der Streifen ist weg -- er stand leer neben der Buehne,
   * und zu heisst jetzt null Bildpunkte. Damit gibt es nur noch eine Spalte,
   * die entweder dasteht (mit einem Blatt darin) oder nicht.
   *
   * Untergrenze 280: darunter bleibt vom Dateibaum kein lesbarer Name. Der vom
   * Menschen gezogene Wert schlaegt die Vorgabe.
   */
  blattBreite: number;
  /**
   * Ob der Umzug auf die neue Vorgabe der linken Leiste schon gelaufen ist
   * (siehe `sidebarBreiteBeimUmzug`). Er laeuft genau einmal je Installation;
   * danach ist jede Breite, auch die 48, wieder eine Wahl des Menschen.
   */
  sidebarVorgabeGehoben: boolean;
  /**
   * OB DER EDITOR EINGEKLAPPT STEHT (05.09.2026, Wort des Nutzers: „Editor auch
   * einklappbar, soll nur Platz brauchen, wenn man ihn braucht"). Eingeklappt
   * heisst: die offenen Tabs bleiben, sichtbar ist nur eine schmale Leiste mit
   * Dateiname und Aenderungspunkt, und die Panes haben ihren Platz zurueck.
   * Gemerkt wird das hier wie jede andere Ansichtswahl dieses Fensters.
   */
  editorEingeklappt: boolean;
}

/**
 * Die Vorgabe der ALTEN Oberflaeche. Sie steht hier als eigener Wert, weil sie
 * beim Umzug eine andere Bedeutung hat als jede andere Zahl: nicht „so breit
 * haette ich es gern", sondern „hier hat nie jemand etwas gewaehlt".
 */
export const ALTE_SIDEBAR_VORGABE = 48;

export const DEFAULT_UI: UiState = {
  /**
   * AUFGEZOGEN, NICHT EINGEKLAPPT (03.09.2026). Die Vorgabe war 48 -- die
   * schmale Fassung, in der von der Leiste nur das Plus und je Sitzung ein
   * Punkt bleibt. Beim ersten Start gibt es keine Sitzung, also blieb das Plus
   * allein stehen, und der erste Blick auf das Programm zeigte eine Leiste
   * ohne Auskunft. 232 ist die Breite, in der Projekt- und Orchestratornamen
   * ungekuerzt stehen; sie gilt nur, solange der Mensch nichts anderes gezogen
   * hat -- ein gemerkter Stand aus ui.json schlaegt sie weiterhin.
   */
  sidebarWidth: 232,
  showStopped: false,
  sort: 'recent',
  order: [],
  projektReihenfolge: [],
  selected: '',
  workerTab: 0,
  chatAnsichtSitzung: {},
  flaecheSitzung: {},
  /**
   * 360 -- breit genug fuer einen Dateibaum mit Pfadzeile und fuer eine
   * Trefferliste der Inhaltssuche mit ihrem Auszug, und schmal genug, dass
   * daneben noch ein Terminal steht. Die Untergrenze 280 und die Obergrenze
   * von 45 % der Fensterbreite stehen im Renderer, wo die Fensterbreite
   * bekannt ist (`blattBreiteJetzt`).
   */
  blattBreite: 360,
  sidebarVorgabeGehoben: false,
  editorEingeklappt: false,
};

/**
 * DIE GEMERKTE LEISTENBREITE AUS DER ALTEN OBERFLAECHE (03.09.2026).
 *
 * Beim sichtbaren Start der neuen Oberflaeche mit vorhandenen Daten stand die
 * linke Leiste eingeklappt, obwohl die Vorgabe seit dem dritten Durchgang 232
 * ist: in ui.json stand noch die 48 der ALTEN Vorgabe, und ein gemerkter Wert
 * schlaegt die Vorgabe. Beim Ausrollen traefe das jede bestehende
 * Installation -- der erste Blick auf das neue Programm waere derselbe leere
 * Streifen, gegen den die neue Vorgabe gerade gesetzt wurde.
 *
 * Ein Merkmal, ob ein Mensch die Leiste je gezogen hat, gibt es nicht; die
 * alte Fassung hat nur die Zahl geschrieben. Also gilt genau die alte Vorgabe
 * als „nie gezogen" und wird einmalig auf die neue gehoben. Jede andere Zahl
 * bleibt unberuehrt -- wer 300 gezogen hat, hat 300 gemeint.
 *
 * EINMALIG, und das ist der Grund fuer `sidebarVorgabeGehoben`: nach dem Umzug
 * ist die 48 wieder eine ganz gewoehnliche Wahl. Wer die Leiste danach
 * absichtlich schmal zieht, behaelt sie schmal, auch ueber einen Neustart.
 */
export function sidebarBreiteBeimUmzug(gemerkt: number | undefined, schonGehoben: boolean): number {
  if (schonGehoben) return gemerkt ?? DEFAULT_UI.sidebarWidth;
  if (gemerkt === undefined) return DEFAULT_UI.sidebarWidth;
  return gemerkt === ALTE_SIDEBAR_VORGABE ? DEFAULT_UI.sidebarWidth : gemerkt;
}

/** Aus einer gelesenen Datei nur das, was wirklich ein Wahrheitswert ist. */
function nurWahrheitswerte(roh: unknown): Record<string, boolean> {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return {};
  const raus: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    if (typeof v === 'boolean') raus[k] = v;
  }
  return raus;
}

/**
 * Dasselbe fuer die Flaechenwahl: aus einer gelesenen Datei kommt nur durch,
 * was wirklich eine der beiden Ansichten benennt. Ein von Hand
 * hineingeschriebenes Wort darf nicht als dritte Ansicht durchgehen.
 */
function nurFlaechen(roh: unknown): Record<string, string> {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return {};
  const raus: Record<string, string> = {};
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    if (v === 'orchestrator' || v === 'worker') raus[k] = v;
  }
  return raus;
}

export class UiStore {
  private readonly datei: string;
  private zustand: UiState;

  constructor(stateDir: string) {
    this.datei = join(stateDir, 'ui.json');
    this.zustand = { ...DEFAULT_UI };
    let gemerkteBreite: number | undefined;
    try {
      const gelesen = JSON.parse(readFileSync(this.datei, 'utf8')) as Partial<UiState>;
      this.zustand = { ...DEFAULT_UI, ...gelesen };
      // Die Uebersteuerungen kommen aus einer Datei und muessen deshalb
      // gepruefte Wahrheitswerte sein: ein von Hand hineingeschriebenes
      // "true" (Zeichenkette) darf nicht als Uebersteuerung durchgehen, sonst
      // stuende in der Regel etwas anderes als ein Ja oder Nein.
      this.zustand.chatAnsichtSitzung = nurWahrheitswerte(gelesen.chatAnsichtSitzung);
      this.zustand.flaecheSitzung = nurFlaechen(gelesen.flaecheSitzung);
      if (typeof gelesen.sidebarWidth === 'number') gemerkteBreite = gelesen.sidebarWidth;
      if (typeof gelesen.blattBreite !== 'number' || !Number.isFinite(gelesen.blattBreite)) {
        this.zustand.blattBreite = DEFAULT_UI.blattBreite;
      }
      // Aus einer Datei kommt nur ein echter Wahrheitswert durch -- eine
      // Zeichenkette "true" darf den Editor nicht einklappen.
      this.zustand.editorEingeklappt = gelesen.editorEingeklappt === true;
      // Aus einer Datei kommt nur eine echte Liste von Ordnern durch: eine
      // von Hand hineingeschriebene Zeichenkette darf die Gruppierung nicht
      // sortieren wollen.
      this.zustand.projektReihenfolge = Array.isArray(gelesen.projektReihenfolge)
        ? gelesen.projektReihenfolge.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      // Ein erster Start ohne alles muss funktionieren.
    }
    this.stateDir = stateDir;
    // DER UMZUG, genau einmal (siehe `sidebarBreiteBeimUmzug`). Geschrieben
    // wird dabei auch dann, wenn die Breite gleich bleibt: erst der vermerkte
    // Umzug macht die 48 danach wieder zu einer gewoehnlichen Wahl.
    if (!this.zustand.sidebarVorgabeGehoben) {
      this.zustand.sidebarWidth = sidebarBreiteBeimUmzug(gemerkteBreite, false);
      this.zustand.sidebarVorgabeGehoben = true;
      this.speichern();
    }
  }

  private readonly stateDir: string;

  get(): UiState {
    return { ...this.zustand };
  }

  set(teil: Partial<UiState>): UiState {
    this.zustand = { ...this.zustand, ...teil };
    this.speichern();
    return this.get();
  }

  /**
   * Was fuer DIESE Sitzung gesetzt ist. `null` heisst: nichts gesetzt, es gilt
   * die Rollenvorgabe -- und genau diesen Unterschied braucht die Regel, ein
   * `false` ist eine Aussage und keine Abwesenheit.
   */
  chatUebersteuerung(sitzung: string): boolean | null {
    const w = this.zustand.chatAnsichtSitzung[sitzung];
    return typeof w === 'boolean' ? w : null;
  }

  /**
   * Was die Flaeche dieser Sitzung zeigt. Alles ausser 'orchestrator' heisst
   * 'worker' -- die Vorgabe ist die Ansicht, in der es etwas zu kacheln gibt.
   */
  flaecheSetzen(sitzung: string, modus: string): void {
    if (!sitzung) return;
    const tabelle = { ...this.zustand.flaecheSitzung };
    tabelle[sitzung] = modus === 'orchestrator' ? 'orchestrator' : 'worker';
    this.set({ flaecheSitzung: tabelle });
  }

  /** Setzen oder (mit `null`) wieder der Rollenvorgabe ueberlassen. */
  chatUebersteuerungSetzen(sitzung: string, wert: boolean | null): void {
    if (!sitzung) return;
    const tabelle = { ...this.zustand.chatAnsichtSitzung };
    if (wert === null) delete tabelle[sitzung];
    else tabelle[sitzung] = wert;
    this.set({ chatAnsichtSitzung: tabelle });
  }

  /**
   * Sitzungen, die es nicht mehr gibt, fallen heraus. Geschrieben wird nur,
   * wenn wirklich etwas wegfaellt -- diese Aufraeumrunde laeuft im Takt des
   * Sessionmodells, und eine Datei je Takt neu zu schreiben waere Unfug.
   */
  sitzungenAufraeumen(bekannt: readonly string[]): boolean {
    const behalten = new Set(bekannt);
    // BEIDE Tabellen je Sitzung, in einem Durchgang: kaeme eine dritte dazu und
    // stuende nicht hier, wuechse sie mit jeder je gestarteten Sitzung weiter.
    const wegChat = Object.keys(this.zustand.chatAnsichtSitzung).filter((id) => !behalten.has(id));
    const wegFlaeche = Object.keys(this.zustand.flaecheSitzung).filter((id) => !behalten.has(id));
    if (!wegChat.length && !wegFlaeche.length) return false;
    const chat = { ...this.zustand.chatAnsichtSitzung };
    for (const id of wegChat) delete chat[id];
    const flaeche = { ...this.zustand.flaecheSitzung };
    for (const id of wegFlaeche) delete flaeche[id];
    this.set({ chatAnsichtSitzung: chat, flaecheSitzung: flaeche });
    return true;
  }

  private speichern(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.datei}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.zustand, null, 2));
      renameSync(tmp, this.datei);
    } catch {
      // Ein nicht schreibbarer Zustand darf die Oberflaeche nicht anhalten.
    }
  }
}

/**
 * Reihenfolge der Sessions. Von Hand gezogen schlaegt jede Sortierung; was
 * nicht in der Handreihenfolge steht, kommt danach nach der Voreinstellung.
 */
/**
 * LEBENDES VOR TOTEM, BEI „ZULETZT AKTIV" (05.09.2026, Kleinigkeit 2).
 *
 * `lastActive` ist der Zeitpunkt der letzten BERUEHRUNG (`wb-state touch`),
 * nicht der letzten Regung im Pane. Eine Sitzung, die vor fuenf Minuten
 * beendet wurde, traegt damit eine neuere Zahl als eine, die seit gestern
 * durchlaeuft -- und stand deshalb ueber ihr, samt ihrer ganzen
 * Projektgruppe. Gemessen am Belegbild: die gestoppte Gruppe „anlass" stand
 * ueber allen laufenden.
 *
 * „Zuletzt aktiv" soll heissen: das, woran gerade gearbeitet wird, zuerst.
 * Also entscheidet zuerst, ob eine Sitzung ueberhaupt noch laeuft, und erst
 * dann die Zahl. Die beiden anderen Sortierungen (Name, Ordner) bleiben
 * unberuehrt -- sie ordnen nach etwas, das mit dem Zustand nichts zu tun hat.
 *
 * Eine Sitzung OHNE `state` (die Chat-Sitzungen in der Leiste) gilt als
 * lebend: sie hat keinen Pane, der sterben koennte.
 */
export function sortSessions<T extends {
  id: string; name: string; dir: string; lastActive: string; state?: string;
}>(
  sessions: T[],
  sort: SortKey,
  order: string[],
): T[] {
  const rang = new Map(order.map((id, i) => [id, i]));
  const tot = (s: T): number => (s.state === 'stopped' ? 1 : 0);
  const nachVorgabe = [...sessions].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'folder') return a.dir.localeCompare(b.dir);
    if (tot(a) !== tot(b)) return tot(a) - tot(b);
    return (b.lastActive || '').localeCompare(a.lastActive || '');
  });
  return nachVorgabe.sort((a, b) => {
    const ra = rang.has(a.id) ? rang.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rang.has(b.id) ? rang.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return 0;
  });
}

/**
 * DIE PROJEKTE IN DER VON HAND GEZOGENEN REIHENFOLGE (08.09.2026).
 *
 * Die Leiste ist eine flache Liste, gruppiert wird erst beim Zeichnen: ein
 * Projekt steht dort, wo seine erste Zeile steht. Wer also die Projekte
 * umstellen will, muss die flache Liste so umbauen, dass die Gruppierung sie
 * nicht wieder einebnet -- die Zeilen eines Projekts stehen danach
 * VOLLSTAENDIG hintereinander. Genau das tut diese Funktion, und aus
 * demselben Grund tut es `flacheReihenfolge` im Renderer beim Ziehen.
 *
 * Die innere Folge eines Projekts bleibt, wie sie war: hier werden Bloecke
 * getauscht, keine Zeilen. Was `projektReihenfolge` nicht nennt, haengt hinten
 * an -- in der Folge, in der es vorher stand.
 *
 * Ohne Handreihenfolge bleibt die Liste unangetastet. Das ist wichtig: bis
 * jemand ein Projekt gezogen hat, soll die Leiste genau so stehen wie bisher.
 */
export function sortProjekte<T extends { dir: string }>(
  zeilen: T[],
  projektReihenfolge: readonly string[],
): T[] {
  if (projektReihenfolge.length === 0) return zeilen;
  const bloecke = new Map<string, T[]>();
  for (const z of zeilen) {
    const block = bloecke.get(z.dir);
    if (block) block.push(z);
    else bloecke.set(z.dir, [z]);
  }
  const rang = new Map(projektReihenfolge.map((dir, i) => [dir, i]));
  const ordner = [...bloecke.keys()];
  const stelle = new Map(ordner.map((dir, i) => [dir, i]));
  ordner.sort((a, b) => {
    const ra = rang.has(a) ? rang.get(a)! : Number.MAX_SAFE_INTEGER;
    const rb = rang.has(b) ? rang.get(b)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    // Unbekannte Projekte behalten ihre bisherige Folge.
    return stelle.get(a)! - stelle.get(b)!;
  });
  return ordner.flatMap((dir) => bloecke.get(dir)!);
}
