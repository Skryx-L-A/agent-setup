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
  auf: (seite: SeitenName) => void;
}

/** Ob ein gemeldeter Dateiname zu den beobachteten gehoert. `null` (manche Plattformen liefern keinen) zaehlt nicht. */
export function betrifft(gemeldet: string | null, gesuchte: readonly string[]): boolean {
  return gemeldet !== null && gesuchte.includes(gemeldet);
}

/**
 * Startet die Beobachtung und gibt die Watcher zurueck (fuer einen sauberen
 * `close()` beim Beenden). Ein fehlendes Verzeichnis wirft nicht -- die
 * Auffrischung faellt dann fuer diesen Teil aus, aber das Programm startet
 * trotzdem; beim naechsten Start greift derselbe Versuch erneut.
 */
export function startDateiWaechter(opt: DateiWaechterOptions): FSWatcher[] {
  const debounceMs = opt.debounceMs ?? 300;
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
  const einstellungenNamen = [basename(opt.settingsFile), basename(opt.modelsFile)];
  const einstellungenOrdner = new Set([dirname(opt.settingsFile), dirname(opt.modelsFile)]);
  for (const ordner of einstellungenOrdner) {
    try {
      beobachter.push(watch(ordner, (_ereignis, dateiname) => {
        if (betrifft(dateiname, einstellungenNamen)) melden('einstellungen');
      }));
    } catch {
      // Verzeichnis fehlt (noch) -- kein Absturz, siehe Docblock.
    }
  }
  try {
    beobachter.push(watch(opt.sessionsDir, (_ereignis, dateiname) => {
      if (dateiname && dateiname.endsWith('.json')) melden('start');
    }));
  } catch {
    // dito.
  }
  return beobachter;
}
