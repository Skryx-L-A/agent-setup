// Auffrischung, die an der DATEI haengt, nicht an einer Uhr (Reste-Auftrag,
// Punkt 3). Startseite, Einstellungen und Modelle werden heute einmal
// gezeichnet -- aendert `wb-state settings set`, die Modell-Registry oder
// `wb-code`/`claude-worker` eine Sessiondatei von AUSSEN, sieht eine offene
// Seite den alten Stand weiter. Dieses Modul beobachtet genau die Dateien, aus
// denen sich Startseite und Einstellungen speisen, und meldet nur, WELCHE
// Seite betroffen ist -- ob wirklich neu gezeichnet wird, entscheidet allein
// der Renderer (`seiten-view.ts: aufDateiAendern`), der als einziger weiss, ob
// die Seite ueberhaupt offen ist und ob gerade ein Feld im Fokus steht.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { SeitenName } from './seiten';

export interface DateiWaechterOptions {
  settingsFile: string;
  modelsFile: string;
  sessionsDir: string;
  /** Buendelt mehrere Ereignisse desselben Schreibvorgangs (z. B. temp+rename). */
  debounceMs?: number;
  /** Vor einem Neuversuch nach einem NICHT-ENOENT-Fehlschlag (Befund "watcher", 22.08.). */
  retryMs?: number;
  auf: (seite: SeitenName) => void;
}

export interface DateiWaechterHandle {
  /** Aktuell aufgebaute Watcher -- kann waehrend eines Neuversuchs wachsen. */
  readonly watchers: readonly FSWatcher[];
  /** Schliesst alle aufgebauten Watcher und bricht ausstehende Neuversuche ab. */
  close(): void;
}

/** Ob ein gemeldeter Dateiname zu den beobachteten gehoert. `null` (manche Plattformen liefern keinen) zaehlt nicht. */
export function betrifft(gemeldet: string | null, gesuchte: readonly string[]): boolean {
  return gemeldet !== null && gesuchte.includes(gemeldet);
}

/**
 * Startet die Beobachtung und gibt ein Handle zurueck (fuer einen sauberen
 * `close()` beim Beenden).
 *
 * Ein fehlendes Verzeichnis (ENOENT) wirft nicht und wird NICHT wiederholt --
 * die Auffrischung faellt dann fuer diesen Teil aus, aber das Programm startet
 * trotzdem; beim naechsten Start greift derselbe Versuch erneut.
 *
 * Jeder ANDERE Fehler beim Aufbau (etwa EMFILE, wenn `fs.inotify.max_user_
 * instances` unter Last erschoepft ist -- gemessen auf peer, 22.08.: mit
 * knapp gefuelltem System-Kontingent schlaegt genau dieser `watch()`-Aufruf
 * beim Hochlauf fehl) wurde bis 22.08. genauso still verschluckt -- und dann
 * NIE wiederholt: die Seite blieb fuer die gesamte Laufzeit des Prozesses auf
 * dem alten Stand, nicht nur verzoegert. Ab hier wird ein solcher Fehler
 * geloggt und der Aufbau in `retryMs`-Abstand wiederholt, bis er gelingt oder
 * `close()` ihn abbricht -- die Bedingung ist typischerweise voruebergehend
 * (ein anderer Prozess gibt seine Instanz wieder frei).
 */
export function startDateiWaechter(opt: DateiWaechterOptions): DateiWaechterHandle {
  const debounceMs = opt.debounceMs ?? 300;
  const retryMs = opt.retryMs ?? 5000;
  const timer = new Map<SeitenName, NodeJS.Timeout>();
  const melden = (seite: SeitenName): void => {
    const bestehend = timer.get(seite);
    if (bestehend) clearTimeout(bestehend);
    timer.set(seite, setTimeout(() => {
      timer.delete(seite);
      opt.auf(seite);
    }, debounceMs));
  };

  const beobachter: FSWatcher[] = [];
  const ausstehend = new Set<NodeJS.Timeout>();
  let geschlossen = false;

  const versuchen = (ordner: string, aufDatei: (_ereignis: string, dateiname: string | null) => void): void => {
    if (geschlossen) return;
    try {
      beobachter.push(watch(ordner, aufDatei));
    } catch (fehler) {
      const code = (fehler as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // Verzeichnis fehlt (noch) -- kein Neuversuch, siehe Docblock.
      process.stderr.write(
        `Dateiwaechter fuer '${ordner}' schlug fehl (${code ?? fehler}) -- neuer Versuch in ${retryMs}ms\n`
      );
      const wiederholung = setTimeout(() => {
        ausstehend.delete(wiederholung);
        versuchen(ordner, aufDatei);
      }, retryMs);
      ausstehend.add(wiederholung);
    }
  };

  const einstellungenNamen = [basename(opt.settingsFile), basename(opt.modelsFile)];
  const einstellungenOrdner = new Set([dirname(opt.settingsFile), dirname(opt.modelsFile)]);
  for (const ordner of einstellungenOrdner) {
    versuchen(ordner, (_ereignis, dateiname) => {
      if (betrifft(dateiname, einstellungenNamen)) melden('einstellungen');
    });
  }
  versuchen(opt.sessionsDir, (_ereignis, dateiname) => {
    if (dateiname && dateiname.endsWith('.json')) melden('start');
  });

  return {
    watchers: beobachter,
    close(): void {
      geschlossen = true;
      for (const t of ausstehend) clearTimeout(t);
      ausstehend.clear();
      for (const t of timer.values()) clearTimeout(t);
      timer.clear();
      for (const w of beobachter) w.close();
      beobachter.length = 0;
    },
  };
}
