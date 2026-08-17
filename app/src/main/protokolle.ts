// Ein Ort fuer die Protokolle (V16, Schritt 9 im Plan): Guard-Log,
// Hygiene-Bericht, Testlauf-Bericht, SESSION-STATE.md -- vier Pfade, die man
// heute einzeln kennen muss. Eine Liste, ein Klick oeffnet die Datei; mehr
// nicht, das ist bewusst der billigste der vier Punkte.
//
// Die Liste selbst steht in den EINSTELLUNGEN (`logPaths`), aus demselben
// Grund wie die Ausschlussliste des Ordnerbaums (4c.2/A9): sichtbar und
// aenderbar, nicht im Code versteckt. Geaendert wird ueber
// `wb-state settings set logPaths '[{"label":"…","path":"…"}, …]'` -- derselbe
// EINE Schreibweg, den auch die Ausschlussliste benutzt.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { alleEinstellungen, VORGABE_PROTOKOLLE } from './einstellungen';

export interface ProtokollVorgabe {
  label: string;
  path: string;
}

/**
 * Die Vorgabe wohnt seit dem 06.08. bei den uebrigen Vorgaben (`VORGABEN` in
 * einstellungen.ts) und wird hier nur weitergereicht -- sonst stuende sie ein
 * drittes Mal da, und die Liste "was bei dir anders ist" haette zu `logPaths`
 * nichts sagen koennen. Zweite Stelle bleibt `shell/wb-state` (DEFAULTS); wer
 * sie aendert, aendert beide.
 */
export { VORGABE_PROTOKOLLE } from './einstellungen';

const MAX_LESE_BYTES = 5 * 1024 * 1024;

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function konfigurierteListe(settingsFile?: string): ProtokollVorgabe[] {
  const wert = alleEinstellungen(settingsFile).logPaths;
  if (
    Array.isArray(wert)
    && wert.every((x) => x && typeof x === 'object' && typeof (x as Record<string, unknown>).label === 'string' && typeof (x as Record<string, unknown>).path === 'string')
  ) {
    return wert as ProtokollVorgabe[];
  }
  return [...VORGABE_PROTOKOLLE];
}

export interface ProtokollEintrag {
  label: string;
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
}

/** Die konfigurierte Liste, mit Dateistand -- fuer die Anzeige, ob eine Datei ueberhaupt schon existiert. */
export function protokollListe(settingsFile?: string): ProtokollEintrag[] {
  return konfigurierteListe(settingsFile).map((v) => {
    const abs = expandHome(v.path);
    try {
      const st = statSync(abs);
      return { label: v.label, path: abs, exists: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { label: v.label, path: abs, exists: false, size: 0, mtimeMs: 0 };
    }
  });
}

/**
 * Nur ein Pfad aus der KONFIGURIERTEN Liste darf gelesen werden -- kein
 * freier Zugriff auf einen beliebigen Pfad, den der Renderer nennt (dieselbe
 * Zurueckhaltung wie beim Editor: geprueft wird serverseitig, nicht dem
 * Renderer geglaubt).
 */
export function protokollLesen(pfad: string, settingsFile?: string): string {
  const erlaubt = protokollListe(settingsFile).some((p) => p.path === pfad);
  if (!erlaubt) throw new Error(`Pfad steht nicht in der Protokoll-Liste: ${pfad}`);
  const st = statSync(pfad);
  if (!st.isFile()) throw new Error(`keine Datei: ${pfad}`);
  if (st.size > MAX_LESE_BYTES) {
    throw new Error(`Datei zu gross (${Math.round(st.size / 1024)} KB, Grenze ${Math.round(MAX_LESE_BYTES / 1024)} KB): ${pfad}`);
  }
  const buf = readFileSync(pfad);
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) throw new Error(`keine Textdatei (Binaerinhalt erkannt): ${pfad}`);
  return buf.toString('utf8');
}
