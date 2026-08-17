// V2: Die Ergebnisdatei ist das Protokoll, also meldet sie sich selbst.
//
// GEMELDET WIRD EIN UEBERGANG, KEINE DATEIAENDERUNG: Der Auftrag, der zuletzt
// vergeben wurde, hat seine Datei zum ERSTEN MAL mit Inhalt gefuellt. Nicht
// "eine Datei hat sich geaendert", nicht "im Ordner liegt etwas Neues".
//
// Diese Formulierung ist keine Feinheit -- sie ist die Antwort auf drei
// Vorfaelle vom 04./05.08., die alle dieselbe Wurzel haben: der Worker-NAME und
// der DATEIZEITSTEMPEL wurden fuer die Identitaet eines Ergebnisses gehalten.
//
//   1. NICHT gemeldet, obwohl fertig. Der Kontext-Guard merkte sich unter dem
//      Worker-Namen, dass er gemeldet hat. Wer einen Pane wiederverwendet (die
//      empfohlene Arbeitsweise: gleicher Name, gleicher Kontext, naechste
//      Aufgabe), bekam ab der zweiten Aufgabe nie wieder eine Meldung. Vier
//      Fertigmeldungen sind so verlorengegangen.
//   2. Gemeldet, obwohl nichts geschehen war. Ein Waechter wartete mit dem
//      Muster `<ordner>/2*.md` und meldete Sekunden nach dem Spawn "fertig" --
//      im Ordner lag noch das Ergebnis eines Workers, der am Vortag denselben
//      Namen getragen hatte.
//   3. Gemeldet, obwohl der Worker mitten in der naechsten Aufgabe steckte.
//      Der Guard haengt seine Meldung an den ZEITSTEMPEL der Ergebnisdatei; der
//      Worker hatte seine alte Datei nachtraeglich noch einmal angefasst.
//      Derselbe Auftrag, dieselbe Datei, nur ein spaeterer Schreibvorgang -- und
//      die Meldung forderte dazu auf, einen arbeitenden Worker zu schliessen.
//      EINE BERUEHRTE DATEI IST KEIN ABSCHLUSS.
//
// Woran der laufende Auftrag zu erkennen ist -- zwei Quellen, die zweite ist die
// bessere:
//
//   auftraege.tsv   Das AUFTRAGSBUCH. `pi-worker` haengt bei JEDER Aufgabe eine
//                   Zeile an (Zeitpunkt, Ergebnisdatei, Pane, Harness, Modell),
//                   auch wenn ein bestehender Pane wiederverwendet wird. Der
//                   letzte Eintrag IST der laufende Auftrag, und sein Zeitpunkt
//                   sagt, ab wann eine gefuellte Ergebnisdatei zu ihm gehoeren
//                   kann. Damit ist "fertig" eine Eigenschaft des Auftrags und
//                   keine Vermutung ueber eine Datei.
//   latest.md       Der Symlink. Rueckfallebene fuer Worker, die vor dem
//                   Auftragsbuch gestartet sind, und fuer alles, was pi-worker
//                   nicht selbst geschrieben hat.
//
// In beiden Faellen gilt: Das ZIEL ist die Kennung des laufenden Auftrags, und
// der Uebergang leer -> gefuellt ist sein Abschluss. Ein neues Ziel heisst neuer
// Auftrag, auch bei gleichem Namen und gleichem Pane.
//
// Zwei Randfaelle, die ausdruecklich NORMAL sind und keinen Fehler ausloesen:
// der Ordner existiert noch gar nicht, und `latest.md` zeigt auf eine Datei,
// die es noch nicht gibt. Beides heisst "noch nichts", nicht "kaputt". (Der
// Waechter aus Vorfall 2 brach in zsh mit `no matches found` ab, sobald der
// Ordner leer war -- ein Signal, das beim Normalfall einen Fehler wirft, ist
// eine Falle.)
import { statSync, readlinkSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface Ergebnis {
  /** Der Worker, dessen Ergebnis das ist. */
  name: string;
  /** Die Datei SELBST, aufgeloest -- nicht der Symlink. Das ist die Kennung. */
  path: string;
  mtimeMs: number;
  size: number;
}

/** Der laufende Auftrag eines Workers, so weit die Dateien ihn kennen. */
interface Auftrag {
  /** Das Ziel von latest.md: die Datei DIESES Auftrags. */
  ziel: string;
  /** Ob der Uebergang leer -> gefuellt fuer diesen Auftrag schon gemeldet ist. */
  gemeldet: boolean;
}

export interface WaechterOptions {
  resultsDir: string;
  /** Startzeitpunkt in Millisekunden. Aelteres gilt als nicht miterlebt. */
  startedAt: number;
  /**
   * Karenz vor dem Start: ein Ergebnis, das hoechstens so lange VOR dem Start
   * fertig wurde, wird beim ersten Sehen trotzdem gemeldet. Dieselbe
   * Ueberlegung wie im Kontext-Guard -- ein Ergebnis, das kurz vor einem
   * Neustart eintraf, soll nicht verschwinden; lieber eine Meldung zuviel als
   * ein verlorenes Ergebnis. Alles Aeltere haben wir nicht miterlebt und
   * melden es nicht nach.
   */
  graceMs?: number;
}

export const GRACE_MS_DEFAULT = 600_000;

/**
 * Der letzte Eintrag im Auftragsbuch, oder null, wenn es keins gibt (Worker von
 * vor dieser Aenderung, oder eine Aufgabe, die an pi-worker vorbei gesendet
 * wurde). Gelesen wird nur die letzte nicht auskommentierte Zeile -- das Buch
 * waechst, es wird nie umgeschrieben.
 */
export function letzterAuftrag(
  resultsDir: string,
  name: string,
): { ts: number; ziel: string; pane: string } | null {
  const buch = join(resultsDir, name, 'auftraege.tsv');
  let roh = '';
  try {
    roh = readFileSync(buch, 'utf8');
  } catch {
    return null;
  }
  const zeilen = roh.split('\n').filter((z) => z.trim() && !z.startsWith('#'));
  const letzte = zeilen[zeilen.length - 1];
  if (!letzte) return null;
  const [ts, ziel, pane] = letzte.split('\t');
  const zeit = Date.parse(ts ?? '');
  if (!ziel || !Number.isFinite(zeit)) return null;
  return { ts: zeit, ziel, pane: pane ?? '' };
}

/**
 * Der laufende Auftrag eines Workers: welche Datei gemeint ist und ob sie schon
 * Inhalt hat. Null, wenn fuer diesen Namen noch gar nichts vergeben ist.
 *
 * `seit` ist der Zeitpunkt, ab dem dieser Auftrag laeuft -- 0, wenn es kein
 * Auftragsbuch gibt und nur der Symlink Auskunft gibt.
 */
export function auftragsStand(
  resultsDir: string,
  name: string,
): { ziel: string; gefuellt: boolean; mtimeMs: number; size: number; seit: number } | null {
  const buch = letzterAuftrag(resultsDir, name);
  if (buch) {
    try {
      const st = statSync(buch.ziel);
      // Eine Datei, die es schon VOR diesem Auftrag gab, kann ihn nicht
      // abschliessen. Ein Spielraum von zwei Sekunden faengt ab, dass
      // Buchzeitpunkt und Dateizeitpunkt aus zwei verschiedenen Uhren kommen
      // (das Buch schreibt auf die Sekunde genau, die Datei auf Millisekunden).
      const gefuellt = st.isFile() && st.size > 0 && st.mtimeMs >= buch.ts - 2000;
      return { ziel: buch.ziel, gefuellt, mtimeMs: st.mtimeMs, size: st.size, seit: buch.ts };
    } catch {
      // Der Auftrag steht im Buch, die Datei kommt noch -- der Normalfall
      // zwischen Vergabe und Fertigwerden.
      return { ziel: buch.ziel, gefuellt: false, mtimeMs: 0, size: 0, seit: buch.ts };
    }
  }

  const link = join(resultsDir, name, 'latest.md');
  let ziel = link;
  try {
    const roh = readlinkSync(link);
    ziel = isAbsolute(roh) ? roh : resolve(dirname(link), roh);
  } catch {
    // Kein Symlink: entweder eine gewoehnliche Datei (dann ist sie selbst die
    // Kennung) oder gar nichts.
    if (!existsSync(link)) return null;
  }
  try {
    const st = statSync(ziel);
    if (!st.isFile()) return { ziel, gefuellt: false, mtimeMs: 0, size: 0, seit: 0 };
    return { ziel, gefuellt: st.size > 0, mtimeMs: st.mtimeMs, size: st.size, seit: 0 };
  } catch {
    // Der Symlink steht, die Datei kommt noch -- genau der Zustand zwischen
    // Spawn und Fertigwerden.
    return { ziel, gefuellt: false, mtimeMs: 0, size: 0, seit: 0 };
  }
}

/**
 * Meldet den Abschluss eines Auftrags genau einmal -- und den Abschluss des
 * NAECHSTEN Auftrags desselben Workers wieder.
 */
export class ErgebnisWaechter {
  private auftraege = new Map<string, Auftrag>();
  private readonly opt: Required<WaechterOptions>;

  constructor(opt: WaechterOptions) {
    this.opt = { graceMs: GRACE_MS_DEFAULT, ...opt };
  }

  /**
   * Einen Durchgang ueber die genannten Worker. Zurueck kommt, was seit dem
   * letzten Durchgang FERTIG GEWORDEN ist.
   */
  durchgang(namen: string[]): Ergebnis[] {
    const neu: Ergebnis[] = [];
    for (const name of namen) {
      if (!name) continue;
      const stand = auftragsStand(this.opt.resultsDir, name);
      if (!stand) continue;

      let bekannt = this.auftraege.get(name);
      if (!bekannt) {
        // ERSTES SEHEN dieses Workers. Nur hier ist eine bereits gefuellte
        // Datei mehrdeutig: sie kann ein Ergebnis von eben sein oder der
        // Altbestand eines frueheren Workers gleichen Namens (Vorfall 2).
        // Entschieden wird nach dem Alter -- was in die Karenz faellt, gilt als
        // eben erst fertig geworden, alles Aeltere als nicht miterlebt.
        const inKarenz = stand.mtimeMs >= this.opt.startedAt - this.opt.graceMs;
        bekannt = { ziel: stand.ziel, gemeldet: stand.gefuellt && !inKarenz };
        this.auftraege.set(name, bekannt);
      } else if (bekannt.ziel !== stand.ziel) {
        // ZIELWECHSEL: ein neuer Auftrag im selben Pane, unter demselben Namen.
        // Hier ist nichts mehrdeutig -- der Pfad ist ein anderer als der, den
        // wir schon gemeldet haben, also kann es weder Altbestand (Vorfall 2)
        // noch ein zweiter Schreibvorgang auf dieselbe Datei sein (Vorfall 3).
        // Steht die neue Datei schon gefuellt da, ist sie fertig geworden,
        // waehrend wir zwischen zwei Takten waren: dann wird sie gemeldet, denn
        // ein verschlucktes Ergebnis ist der teuerste der drei Fehler.
        bekannt = { ziel: stand.ziel, gemeldet: false };
        this.auftraege.set(name, bekannt);
      }

      // Ab hier ist `bekannt` der laufende Auftrag. Gemeldet wird genau der
      // Uebergang leer -> gefuellt, und zwar einmal. Ein spaeterer
      // Schreibvorgang auf dieselbe Datei ist KEIN zweiter Abschluss
      // (Vorfall 3): derselbe Auftrag wird nicht zweimal fertig.
      if (bekannt.gemeldet || !stand.gefuellt) continue;
      bekannt.gemeldet = true;
      neu.push({ name, path: stand.ziel, mtimeMs: stand.mtimeMs, size: stand.size });
    }
    return neu;
  }

  /** Nur fuer Tests und Diagnose: welchen Auftrag der Waechter je Worker fuehrt. */
  stand(): Record<string, { ziel: string; gemeldet: boolean }> {
    return Object.fromEntries([...this.auftraege].map(([k, v]) => [k, { ...v }]));
  }
}

/**
 * Der Ergebnisstand eines Workers fuer die ANZEIGE -- null, solange die Datei
 * des laufenden Auftrags leer ist. Ob ein Worker deshalb "fertig" heissen darf,
 * entscheidet NICHT diese Datei: das haelt sessions.ts gegen den laufenden
 * Pane. Ein Worker, der arbeitet, ist nicht fertig, egal was im Ordner liegt.
 */
export function ergebnisStand(resultsDir: string, name: string): Ergebnis | null {
  const stand = auftragsStand(resultsDir, name);
  if (!stand || !stand.gefuellt) return null;
  return { name, path: stand.ziel, mtimeMs: stand.mtimeMs, size: stand.size };
}
