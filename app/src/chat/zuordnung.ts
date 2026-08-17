// WELCHES PROTOKOLL GEHOERT ZU DIESEM PANE (SPEC-V4 Abschnitt 6, dritte
// Bedingung: "ohne diese Zuordnung ist die Ansicht nicht baubar, gleich wie
// sauber das Format ist").
//
// Vier Arten, und sie sind nicht gleich gut:
//   hook      Der Harness sagt selbst, welche Sitzung in welchem Pane laeuft.
//             Die einzige Art, die bei zwei Sitzungen im selben Ordner sicher
//             ist -- und im Worker-Grid ist das der Normalfall.
//             ZWEI SCHWAECHERE WEGE STEHEN DAHINTER (12.08.), siehe unten.
//   pid       Die Sitzung nennt die Prozesskennung ihres Laufs (qwen:
//             <sessionId>.runtime.json mit pid, session_id, work_dir).
//             Ebenso eindeutig, ohne dass wir etwas installieren muessen.
//   serverId  Der Server selbst nennt seine Sitzungen samt Arbeitsverzeichnis.
//   cwd       Das Arbeitsverzeichnis, aufgeloest verglichen. Der Rueckfall --
//             und der Fall, in dem ZWEI lebende Sitzungen im selben Ordner
//             nicht auseinanderzuhalten sind.
//
// DIE REGEL BEI ZWEIFEL IST DIESELBE WIE IN DER KONTEXTWACHE: lieber nichts als
// das Gespraech eines fremden Panes. Eine falsche Zuordnung waere hier sogar
// teurer als dort -- die Wache zeigte eine falsche Zahl, die Ansicht zeigt einen
// falschen Text und laedt zum Mitlesen ein.
//
// WARUM DER HOOK-WEG SEIT DEM 12.08. ZWEI RUECKFALLSTUFEN HAT. Der Haken haengt
// die Sitzungskennung an den Pane, sobald der Harness startet -- er kann sie
// deshalb nur an Panes haengen, die NACH seiner Einrichtung gestartet wurden.
// Gemessen am 12.08. an der laufenden Maschine: von sechs lebenden Panes trugen
// genau die zwei die Kennung, die an diesem Abend entstanden waren; die vier
// Sitzungen, die seit Stunden liefen, trugen keine. Fuer sie war die Ansicht
// leer, und ein Mensch mit lauter langlaufenden Sitzungen sah das Merkmal nie.
// Ein leeres Fenster ist hier die schlechteste aller Antworten: es sieht aus
// wie ein Fehler und nennt keinen Weg. Also zwei schwaechere Wege dahinter --
// mit Beschriftung, damit der Mensch der Anzeige ansieht, wie verlaesslich sie
// ist:
//
//   vermerk   Die Werkbank hat sich die Unterhaltung dieses Panes beim Start
//             notiert (`claudeSessionId` der Sitzung bzw. des Workers in der
//             Zustandsdatei). Ebenfalls eine KENNUNG, also eindeutig -- nur
//             nicht vom Harness selbst gemeldet, sondern von aussen vermerkt:
//             ein `/clear` im Pane beginnt eine neue Unterhaltung, und ob der
//             Vermerk ihr folgt, haengt am Haken, der ihn schreibt (fuer
//             Orchestrator-Panes tut er das, siehe
//             ~/.claude/hooks/sessionstart-claude-session.sh).
//   ordner    Arbeitsverzeichnis und juengste Aenderungszeit, wie in
//             `session_load()` der Kontextwache -- nur strenger (siehe
//             `ueberOrdner` unten). Der schwaechste Weg, und seine Grenze ist
//             dieselbe wie dort: zwei lebende Sitzungen im selben Ordner sind
//             von aussen nicht auseinanderzuhalten -- dann zeigt die Ansicht
//             NICHTS und sagt genau das.
//
// GEMESSEN, warum der mittlere Weg nicht wegzulassen ist: am 12.08. liefen zwei
// Orchestrator-Sitzungen in /Users/alice/AI (Transcripte 03:59 und 03:48 Uhr).
// Der Ordnerweg allein haette beiden Panes dasselbe, juengste Gespraech gezeigt
// -- einem davon also ein fremdes. Der Vermerk trennt sie, weil er je Pane eine
// eigene Kennung nennt.
import type { Herkunft, Kandidat } from './typen';

/** Vorgabe des Hoechstalters, wenn der Block keins nennt: zwoelf Stunden (wie session_load). */
export const MAX_ALTER_VORGABE_SEC = 43200;

/**
 * Wie eng zwei Kandidaten beieinander liegen duerfen, bevor die Zuordnung
 * aufgibt: fuenf Minuten, dieselbe Schwelle wie in `session_load()` der
 * Kontextwache. Zwei Dateien, die beide in den letzten fuenf Minuten geschrieben
 * wurden, gehoeren beide zu etwas Lebendem.
 */
export const GLEICHZEITIG_SEC = 300;

export interface Wahl {
  /** Der gewaehlte Kandidat, oder null. */
  kandidat: Kandidat | null;
  /** Warum keiner gewaehlt wurde. Leer, wenn einer gewaehlt wurde. */
  grund: string;
  /**
   * WORAUF die Wahl beruht -- leer, solange keine getroffen ist. Die Ansicht
   * schreibt es in ihre Leiste: eine Zuordnung ueber den Haken ist sicher, eine
   * ueber Ordner und Zeit kann bei zwei Sitzungen im selben Ordner danebengreifen,
   * und wer das nicht sieht, haelt beide fuer gleich verlaesslich.
   */
  herkunft: Herkunft;
}

export type { Herkunft };

function pfadGleich(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // macOS: /var ist ein Link auf /private/var, und die Werkzeuge notieren
  // beide Schreibweisen. Aufgeloest wird NICHT hier -- das waere ein
  // Dateizugriff in einer reinen Funktion; der Aufrufer reicht beide Formen
  // durch, indem er `cwd` schon aufgeloest hineingibt. Diese Abkuerzung faengt
  // den haeufigsten Fall trotzdem ab, ohne etwas zu oeffnen.
  const ohne = (p: string): string => (p.startsWith('/private/') ? p.slice('/private'.length) : p);
  return ohne(a) === ohne(b);
}

/**
 * DIE WAHL. `jetztMs` kommt herein statt aus der Uhr -- so ist die Regel
 * pruefbar, ohne auf eine Sekunde zu warten.
 */
export function kandidatWaehlen(
  kandidaten: Kandidat[],
  art: 'cwd' | 'pid' | 'hook' | 'serverId' | '',
  ziel: { cwd: string; pid: number; sitzungsId: string; vermerkteId?: string },
  jetztMs: number,
  maxAlterSec: number,
): Wahl {
  if (!art) {
    return { kandidat: null, grund: 'Fuer diesen Harness ist keine Zuordnung eingetragen.', herkunft: '' };
  }
  const maxAlter = (maxAlterSec > 0 ? maxAlterSec : MAX_ALTER_VORGABE_SEC) * 1000;
  const frisch = kandidaten.filter((k) => jetztMs - k.mtimeMs <= maxAlter);
  if (!frisch.length) {
    return {
      kandidat: null,
      grund: 'Keine Sitzungsdatei, die jung genug waere, um zu diesem Pane zu gehoeren.',
      herkunft: '',
    };
  }

  /**
   * Der Ordnerweg -- der schwaechste, mit seiner Grenze als Absage.
   *
   * `streng` unterscheidet die BEIDEN Aufrufer, und der Unterschied ist am
   * 12.08. an einem echten Fenster gemessen worden:
   *
   *   false  Die eingetragene Zuordnung 'cwd' (aider, crush, …). Es gilt
   *          weiter die Schwelle aus `session_load()` der Kontextwache: nur
   *          eine zweite Datei aus denselben fuenf Minuten macht die Wahl
   *          mehrdeutig. So ist es gemessen und ausgeliefert, und eine laengst
   *          kalte Nachbardatei soll die Ansicht nicht dauerhaft sperren.
   *   true   Der RUECKFALL des Hook-Weges. Dort genuegt die Fuenf-Minuten-Regel
   *          nachweislich nicht: zwei echte claude-Sitzungen im selben Ordner,
   *          acht Minuten zwischen ihren letzten Zeilen, und die Ansicht des
   *          ERSTEN Panes zeigte das Gespraech des zweiten -- der Fall, den
   *          diese Datei ausdruecklich verhindern soll. Ein Pane, das gerade
   *          auf seine Worker wartet, schreibt minutenlang nichts und ist
   *          trotzdem lebendig; „still" heisst hier nicht „vorbei". Deshalb
   *          gilt beim Rueckfall die Frist, mit der die Ansicht ohnehin
   *          rechnet: ist eine ZWEITE Datei jung genug, um ueberhaupt zu einem
   *          lebenden Pane zu gehoeren, dann koennte sie es auch sein -- und
   *          dann wird nicht gewaehlt.
   */
  const ueberOrdner = (streng: boolean): Wahl => {
    const treffer = frisch.filter((k) => pfadGleich(k.cwd, ziel.cwd));
    if (!treffer.length) {
      return { kandidat: null, grund: 'Keine Sitzung nennt das Arbeitsverzeichnis dieses Panes.', herkunft: '' };
    }
    treffer.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const zweiteZaehlt = treffer.length > 1
      && (streng || jetztMs - treffer[1].mtimeMs < GLEICHZEITIG_SEC * 1000);
    if (zweiteZaehlt) {
      return {
        kandidat: null,
        grund: 'Zwei lebende Sitzungen in diesem Ordner — welche zu diesem Pane gehoert, ist von aussen nicht zu entscheiden.',
        herkunft: '',
      };
    }
    return { kandidat: treffer[0], grund: '', herkunft: 'ordner' };
  };

  if (art === 'hook') {
    // Der Hook hat die Sitzungskennung schon in den Dateinamen gelegt; der
    // Aufrufer gibt sie als `sitzungsId` herein.
    if (ziel.sitzungsId) {
      const treffer = frisch.filter((k) => k.pfad.includes(ziel.sitzungsId));
      if (!treffer.length) {
        // KEIN RUECKFALL: der Harness hat eine Kennung genannt, und zu ihr
        // liegt nichts. Ein anderes Gespraech ist dann nicht das gesuchte,
        // sondern ein fremdes.
        return { kandidat: null, grund: `Zur gemeldeten Sitzung ${ziel.sitzungsId} liegt keine Datei.`, herkunft: '' };
      }
      return { kandidat: treffer.sort((a, b) => b.mtimeMs - a.mtimeMs)[0], grund: '', herkunft: 'hook' };
    }
    // Der Hook hat nichts gemeldet -- der Normalfall bei jedem Pane, der vor
    // seiner Einrichtung gestartet wurde. Zwei schwaechere Wege statt einer
    // leeren Ansicht (siehe den Kopf dieser Datei).
    if (ziel.vermerkteId) {
      const treffer = frisch.filter((k) => k.pfad.includes(ziel.vermerkteId as string));
      if (treffer.length) {
        return { kandidat: treffer.sort((a, b) => b.mtimeMs - a.mtimeMs)[0], grund: '', herkunft: 'vermerk' };
      }
      // Der Vermerk zeigt ins Leere (kalte oder geloeschte Datei): weiter zum
      // Ordnerweg statt aufgeben -- er ist schwaecher, aber er ist einer.
    }
    const w = ueberOrdner(true);
    if (!w.kandidat && !ziel.vermerkteId) {
      // Der Satz nennt beides: dass die Kennung fehlt UND was stattdessen
      // versucht wurde. Ein Grund, der nur die halbe Suche nennt, schickt den
      // Menschen an die falsche Stelle.
      return { ...w, grund: `Der Harness hat seine Sitzungskennung nicht gemeldet. ${w.grund}` };
    }
    return w;
  }

  if (art === 'pid') {
    if (!ziel.pid) return { kandidat: null, grund: 'Die Prozesskennung des Panes ist unbekannt.', herkunft: '' };
    const treffer = frisch.filter((k) => k.pid === ziel.pid);
    if (!treffer.length) {
      return {
        kandidat: null,
        grund: 'Keine laufende Sitzung nennt die Prozesskennung dieses Panes.',
        herkunft: '',
      };
    }
    return { kandidat: treffer.sort((a, b) => b.mtimeMs - a.mtimeMs)[0], grund: '', herkunft: 'pid' };
  }

  // cwd und serverId teilen sich die Regel: beide vergleichen das
  // Arbeitsverzeichnis, das die Quelle selbst notiert hat.
  return ueberOrdner(false);
}
