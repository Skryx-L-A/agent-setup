// V12: die Pruef-Ampel. Testlauf (`wb-testsuite-run`) und Hygiene (`wb-hygiene`)
// schreiben seit dem 04.08. maschinenlesbare Statusdateien unter
// `~/.local/state/`, und zwei SessionStart-Hooks lesen sie schon -- dieselbe
// Regel wird hier noch einmal angewandt, NICHT neu erfunden, damit die Ampel
// nie etwas anderes sagt als der Hook beim naechsten Sessionstart.
//
// `~/.local/state/wb-testsuite-status.txt`:
//   ts_epoch=... ts_iso=... parse_ok=1 exit_code=0 pass=38 fail=0 skip=0
//   total=38 failed_suites=
//   Rot: fail>0. Ueberfaellig: aelter als 9 Tage (Job laeuft woechentlich).
//
// `~/.local/state/wb-hygiene-status.txt`:
//   ts_epoch=... ts_iso=... parse_ok=1 exit_code=0 consistency_count=0
//   lint_undated_count=19 freshness_stale_count=1
//   Rot: NUR exit_code!=0 (die drei Einzelzahlen faerben laut Hook-Kommentar
//   ausdruecklich NICHT rot, sonst waere die Ampel praktisch jede Woche rot).
//   Ueberfaellig: aelter als 9 Tage.
const NEUN_TAGE_SEK = 9 * 86400;

function parseKeyVal(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zeile of raw.split('\n')) {
    if (!zeile || zeile.startsWith('#')) continue;
    const i = zeile.indexOf('=');
    if (i < 0) continue;
    out[zeile.slice(0, i)] = zeile.slice(i + 1);
  }
  return out;
}

export type AmpelFarbe = 'rot' | 'gelb' | 'gruen' | 'unbekannt';

export interface AmpelBefund {
  quelle: 'testsuite' | 'hygiene';
  /** Datei da, lesbar und mit den erwarteten Zahlenfeldern -- sonst 'unbekannt'. */
  vorhanden: boolean;
  rot: boolean;
  ueberfaellig: boolean;
  ageDays: number;
  /** Ein Satz fuer den Klick-Hinweis (dieselbe Auskunft wie die Hook-Zeile). */
  text: string;
}

function unbekannterBefund(quelle: AmpelBefund['quelle']): AmpelBefund {
  return { quelle, vorhanden: false, rot: false, ueberfaellig: false, ageDays: -1, text: `${quelle === 'testsuite' ? 'Testsuite' : 'Hygiene'}: noch kein Lauf` };
}

export function bewerteTestsuite(raw: string, jetztSek: number): AmpelBefund {
  if (!raw.trim()) return unbekannterBefund('testsuite');
  const kv = parseKeyVal(raw);
  const fail = Number(kv.fail);
  const ts = Number(kv.ts_epoch);
  if (!Number.isFinite(fail) || !Number.isFinite(ts)) return unbekannterBefund('testsuite');
  const ageDays = Math.floor((jetztSek - ts) / 86400);
  const ueberfaellig = jetztSek - ts > NEUN_TAGE_SEK;
  const rot = fail > 0;
  const text = rot
    ? `Testsuite: ${fail} rote Suite(n) (${ageDays} Tage her)${kv.failed_suites ? ': ' + kv.failed_suites : ''}`
    : ueberfaellig
      ? `Testsuite: letzter Lauf ${ageDays} Tage her (ueberfaellig, Job laeuft woechentlich)`
      : `Testsuite: gruen, ${kv.pass ?? '?'}/${kv.total ?? '?'} bestanden (${ageDays} Tage her)`;
  return { quelle: 'testsuite', vorhanden: true, rot, ueberfaellig, ageDays, text };
}

export function bewerteHygiene(raw: string, jetztSek: number): AmpelBefund {
  if (!raw.trim()) return unbekannterBefund('hygiene');
  const kv = parseKeyVal(raw);
  const code = Number(kv.exit_code);
  const ts = Number(kv.ts_epoch);
  if (!Number.isFinite(code) || !Number.isFinite(ts)) return unbekannterBefund('hygiene');
  const ageDays = Math.floor((jetztSek - ts) / 86400);
  const ueberfaellig = jetztSek - ts > NEUN_TAGE_SEK;
  const rot = code !== 0;
  const text = rot
    ? `Hygiene: rot -- Widersprueche ${kv.consistency_count ?? '?'}, undatierte Regeln ${kv.lint_undated_count ?? '?'}, veraltete STATUS.md ${kv.freshness_stale_count ?? '?'} (${ageDays} Tage her)`
    : ueberfaellig
      ? `Hygiene: letzter Lauf ${ageDays} Tage her (ueberfaellig, Job laeuft woechentlich)`
      : `Hygiene: gruen (${ageDays} Tage her)`;
  return { quelle: 'hygiene', vorhanden: true, rot, ueberfaellig, ageDays, text };
}

export interface AmpelStand {
  machine: string;
  befunde: AmpelBefund[];
  farbe: AmpelFarbe;
}

/**
 * Rot schlaegt Gelb schlaegt Gruen -- dieselbe Rangfolge wie die Tab-Farbe der
 * rechten Leiste (renderer.ts): eine Aufforderung geht nie unter, nur weil
 * daneben etwas Ruhigeres steht. 'unbekannt', wenn beide Quellen noch nie
 * gelaufen sind -- eine Maschine ganz ohne Statusdatei ist kein Befund,
 * sondern schlicht: noch nichts gemessen.
 */
export function ampelFuerMaschine(machine: string, testsuiteRaw: string, hygieneRaw: string, jetztSek: number): AmpelStand {
  const befunde = [bewerteTestsuite(testsuiteRaw, jetztSek), bewerteHygiene(hygieneRaw, jetztSek)];
  const vorhanden = befunde.filter((b) => b.vorhanden);
  let farbe: AmpelFarbe;
  if (!vorhanden.length) farbe = 'unbekannt';
  else if (vorhanden.some((b) => b.rot)) farbe = 'rot';
  else if (vorhanden.some((b) => b.ueberfaellig)) farbe = 'gelb';
  else farbe = 'gruen';
  return { machine, befunde, farbe };
}
