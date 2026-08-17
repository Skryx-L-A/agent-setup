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
  /** Gewaehlte Session. */
  selected: string;
  /** Gewaehlter Worker-Tab der rechten Leiste. */
  workerTab: number;
  /**
   * Breite der rechten Leiste in Pixeln -- stufenlos, wie links. Es gibt
   * keinen zweiten, diskreten Zustand daneben: zwei Regeln fuer dieselbe
   * Groesse haben sich gestritten, und der Griff tat deshalb nichts.
   */
  rightWidth: number;
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
}

export const DEFAULT_UI: UiState = {
  sidebarWidth: 48,
  showStopped: false,
  sort: 'recent',
  order: [],
  selected: '',
  workerTab: 0,
  rightWidth: 40,
  chatAnsichtSitzung: {},
};

/** Aus einer gelesenen Datei nur das, was wirklich ein Wahrheitswert ist. */
function nurWahrheitswerte(roh: unknown): Record<string, boolean> {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return {};
  const raus: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    if (typeof v === 'boolean') raus[k] = v;
  }
  return raus;
}

export class UiStore {
  private readonly datei: string;
  private zustand: UiState;

  constructor(stateDir: string) {
    this.datei = join(stateDir, 'ui.json');
    this.zustand = { ...DEFAULT_UI };
    try {
      const gelesen = JSON.parse(readFileSync(this.datei, 'utf8')) as Partial<UiState>;
      this.zustand = { ...DEFAULT_UI, ...gelesen };
      // Die Uebersteuerungen kommen aus einer Datei und muessen deshalb
      // gepruefte Wahrheitswerte sein: ein von Hand hineingeschriebenes
      // "true" (Zeichenkette) darf nicht als Uebersteuerung durchgehen, sonst
      // stuende in der Regel etwas anderes als ein Ja oder Nein.
      this.zustand.chatAnsichtSitzung = nurWahrheitswerte(gelesen.chatAnsichtSitzung);
    } catch {
      // Ein erster Start ohne alles muss funktionieren.
    }
    this.stateDir = stateDir;
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
    const tabelle = this.zustand.chatAnsichtSitzung;
    const weg = Object.keys(tabelle).filter((id) => !behalten.has(id));
    if (!weg.length) return false;
    const neu = { ...tabelle };
    for (const id of weg) delete neu[id];
    this.set({ chatAnsichtSitzung: neu });
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
export function sortSessions<T extends { id: string; name: string; dir: string; lastActive: string }>(
  sessions: T[],
  sort: SortKey,
  order: string[],
): T[] {
  const rang = new Map(order.map((id, i) => [id, i]));
  const nachVorgabe = [...sessions].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'folder') return a.dir.localeCompare(b.dir);
    return (b.lastActive || '').localeCompare(a.lastActive || '');
  });
  return nachVorgabe.sort((a, b) => {
    const ra = rang.has(a.id) ? rang.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rang.has(b.id) ? rang.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return 0;
  });
}
