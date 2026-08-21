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
//   Seit dem 21.08. zusaetzlich `repo_dir`, `repo_commit`, `repo_commit_ts`:
//   welchen Stand dieser Lauf geprueft hat. Fehlen sie (aeltere Datei), bleibt
//   alles wie bisher.
//
// UEBERHOLT IST NICHT UEBERFAELLIG -- zwei Dinge, nicht eines (21.08.).
// `ueberfaellig` misst den TAKT und rechnet gegen die UHR: der Job laeuft
// woechentlich, seit neun Tagen kam nichts, also fehlt eine Messung, ganz
// gleich was der Code macht. `ueberholt` misst die GELTUNG und rechnet gegen
// das REPO: der Lauf hat einen Baum geprueft, den es nicht mehr gibt, seine
// Aussage ist damit hinfaellig, ganz gleich wie jung sie ist. Die beiden
// fallen auseinander: ein Lauf von vorgestern ist ueberholt, wenn der Baum
// seither zwei Tage weitergewachsen ist, obwohl er noch lange nicht
// ueberfaellig waere; ein Lauf von vor zwei Wochen gegen ein unberuehrtes
// Repo ist ueberfaellig, aber inhaltlich noch gueltig. Deshalb zwei Felder --
// ein laengerer Ueberfaelligkeits-Zeitraum haette keinen der beiden Faelle
// getroffen. Fuer die Marke laufen sie am Ende auf dieselbe Aufforderung
// hinaus (gelb: lass die Suite laufen), und das ist kein Widerspruch, sondern
// zwei Wege zu derselben Luecke.
//
// `~/.local/state/wb-hygiene-status.txt`:
//   ts_epoch=... ts_iso=... parse_ok=1 exit_code=0 consistency_count=0
//   lint_undated_count=19 freshness_stale_count=1
//   Rot: NUR exit_code!=0 (die drei Einzelzahlen faerben laut Hook-Kommentar
//   ausdruecklich NICHT rot, sonst waere die Ampel praktisch jede Woche rot).
//   Ueberfaellig: aelter als 9 Tage.
const NEUN_TAGE_SEK = 9 * 86400;
/**
 * Ab welchem Abstand zwischen geprueftem Stand und heutigem HEAD ein Befund
 * als ueberholt gilt (21.08.).
 *
 * WARUM NICHT SCHON BEIM ERSTEN COMMIT: streng genommen ist der gepruefte Baum
 * weg, sobald irgendetwas committet wurde -- aber dann waere ein Rot, das die
 * Suite gerade eben gefunden hat, beim naechsten Commit farblos, und der
 * Auftrag sagt ausdruecklich das Gegenteil: ein frischer roter Befund bleibt
 * rot. Ein Tag ist die Grenze, an der aus "seitdem wurde weitergearbeitet" ein
 * anderer Baum wird. GEMESSEN in diesem Repo (git log, 16.-21.08.2026):
 * 19, 65, 17, 16, 90 und 165 Commits an den einzelnen Tagen -- ein Tag Abstand
 * sind hier also Dutzende Commits, ein paar Minuten dagegen sind einer. Der
 * Fall, der die Regel ausgeloest hat, liegt weit jenseits davon: der Lauf vom
 * 16.08. auf peer stand am 21.08. fuenf Tage hinter dem dortigen HEAD.
 */
const UEBERHOLT_AB_SEK = 86400;

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

/**
 * Der Stand des Repos auf DERSELBEN Maschine, JETZT -- die zweite Zahl des
 * Vergleichs. Sie kommt lokal aus `git` im Hauptprozess und fern aus dem
 * REPO-Abschnitt des Fernskripts (remote.ts); beide liefern dieselben drei
 * Schluessel, damit hier nur EINE Leseregel steht.
 */
export interface RepoStand {
  /** HEAD-Commit der Maschine jetzt. */
  commit: string;
  /** Zeitstempel dieses Commits (Unix-Sekunden). */
  commitTs: number;
  /** Commits, die HEAD dem geprueften Stand voraus ist; -1 = nicht ermittelt. */
  ahead: number;
}

/**
 * `head_commit` / `head_commit_ts` / `head_ahead` aus dem REPO-Abschnitt.
 * `null`, sobald eine der beiden Pflichtangaben fehlt -- eine halbe Angabe ist
 * keine Grundlage fuer den Vergleich, und geraten wird hier nichts.
 */
export function parseRepoStand(raw: string): RepoStand | null {
  if (!raw.trim()) return null;
  const kv = parseKeyVal(raw);
  const commit = (kv.head_commit ?? '').trim();
  // `Number('')` ist 0, nicht NaN -- ein leeres Feld waere sonst als
  // Zeitstempel 0 bzw. als "0 Commits voraus" durchgegangen und haette eine
  // Zahl behauptet, die niemand gemessen hat. Deshalb erst der Leertest.
  const tsRoh = (kv.head_commit_ts ?? '').trim();
  const commitTs = tsRoh ? Number(tsRoh) : NaN;
  if (!commit || !Number.isFinite(commitTs)) return null;
  const aheadRoh = (kv.head_ahead ?? '').trim();
  const ahead = aheadRoh ? Number(aheadRoh) : NaN;
  return { commit, commitTs, ahead: Number.isFinite(ahead) && ahead >= 0 ? ahead : -1 };
}

/**
 * Der Stand der EIGENEN Maschine, aus derselben Statusdatei heraus: wo der Baum
 * liegt, sagt sie selbst (`repo_dir`), gegen welchen Commit gezaehlt wird, auch
 * (`repo_commit`). `gitLauf` fuehrt einen git-Aufruf in diesem Verzeichnis aus
 * und liefert die getrimmte Ausgabe oder '' -- hineingereicht statt hier
 * aufgerufen, damit diese Datei rein bleibt (sie wird fuer die Tests einzeln
 * gebuendelt) und der eine Weg messbar ist, statt in main.ts nur zu existieren.
 *
 * Ergebnis ist DIESELBE Form, die das Fernskript liefert -- eine Leseregel fuer
 * beide Maschinen, nicht zwei, die auseinanderlaufen koennen.
 */
export function repoStandLokal(
  testsuiteRaw: string,
  gitLauf: (dir: string, args: string[]) => string,
): RepoStand | null {
  const kv = parseKeyVal(testsuiteRaw);
  const dir = (kv.repo_dir ?? '').trim();
  if (!dir) return null;
  const geprueft = (kv.repo_commit ?? '').trim();
  const head = gitLauf(dir, ['rev-parse', 'HEAD']);
  const headTs = gitLauf(dir, ['log', '-1', '--format=%ct']);
  const ahead = geprueft ? gitLauf(dir, ['rev-list', '--count', `${geprueft}..HEAD`]) : '';
  return parseRepoStand(`head_commit=${head}\nhead_commit_ts=${headTs}\nhead_ahead=${ahead}\n`);
}

/**
 * Ist dieser Lauf aelter als der Code, den er geprueft hat?
 *
 * Verglichen werden zwei Zahlen DERSELBEN Maschine: der Commit, den der Lauf
 * gesehen hat (aus seiner Statusdatei), gegen den Commit, auf dem der Baum
 * jetzt steht. Fehlt eine davon -- aeltere Statusdatei ohne die Felder, kein
 * git-Baum drueben --, ist die Antwort `false` und alles bleibt wie bisher.
 * Das ist die vorsichtige Richtung: ein roter Befund behaelt im Zweifel seine
 * Farbe, statt sie aus Unwissen zu verlieren.
 *
 * Die ZEIT entscheidet, nicht bloss die Ungleichheit der Commits: steht der
 * Baum auf einem AELTEREN Commit als dem geprueften (ein ausgecheckter alter
 * Zweig, ein zurueckgesetzter Kopf), ist der Befund nicht ueberholt, sondern
 * schlicht nicht mehr zuzuordnen -- auch dann bleibt es beim bisherigen
 * Verhalten. Und sie muss um mehr als `UEBERHOLT_AB_SEK` auseinanderliegen,
 * damit ein eben erst gefundenes Rot nicht vom naechsten Commit weggewischt
 * wird.
 */
function ueberholtVon(kv: Record<string, string>, repo: RepoStand | null | undefined): boolean {
  if (!repo || !repo.commit) return false;
  const geprueft = (kv.repo_commit ?? '').trim();
  const geprueftTsRoh = (kv.repo_commit_ts ?? '').trim();
  const geprueftTs = geprueftTsRoh ? Number(geprueftTsRoh) : NaN;
  if (!geprueft || !Number.isFinite(geprueftTs)) return false;
  if (geprueft === repo.commit) return false;
  return repo.commitTs - geprueftTs > UEBERHOLT_AB_SEK;
}

/** "seither 349 Commit(s)" -- oder, wenn die Zahl fehlt, ohne Zahl. */
function seither(repo: RepoStand | null | undefined): string {
  return repo && repo.ahead >= 0 ? `seither ${repo.ahead} Commit(s)` : 'seither weitere Commits';
}

export type AmpelFarbe = 'rot' | 'gelb' | 'gruen' | 'unbekannt';

export interface AmpelBefund {
  quelle: 'testsuite' | 'hygiene';
  /** Datei da, lesbar und mit den erwarteten Zahlenfeldern -- sonst 'unbekannt'. */
  vorhanden: boolean;
  /**
   * WAS DER LAUF GEFUNDEN HAT -- unveraendert die Messung selbst, nicht die
   * Farbe der Marke. Ob dieser Fund heute noch gilt, sagt `ueberholt`; die
   * Trennung ist Absicht, damit die Messung nicht unter der Bewertung
   * verschwindet (der Klick-Hinweis nennt beides).
   */
  rot: boolean;
  ueberfaellig: boolean;
  /**
   * Der Lauf ist aelter als der Code, den er geprueft hat (21.08.) -- sein
   * Befund gilt fuer einen Baum, den es nicht mehr gibt. `false`, solange sich
   * das nicht MESSEN laesst (siehe `ueberholtVon`).
   */
  ueberholt: boolean;
  ageDays: number;
  /** Ein Satz fuer den Klick-Hinweis (dieselbe Auskunft wie die Hook-Zeile). */
  text: string;
}

function unbekannterBefund(quelle: AmpelBefund['quelle']): AmpelBefund {
  return { quelle, vorhanden: false, rot: false, ueberfaellig: false, ueberholt: false, ageDays: -1, text: `${quelle === 'testsuite' ? 'Testsuite' : 'Hygiene'}: noch kein Lauf` };
}

export function bewerteTestsuite(raw: string, jetztSek: number, repo?: RepoStand | null): AmpelBefund {
  if (!raw.trim()) return unbekannterBefund('testsuite');
  const kv = parseKeyVal(raw);
  const fail = Number(kv.fail);
  const ts = Number(kv.ts_epoch);
  if (!Number.isFinite(fail) || !Number.isFinite(ts)) return unbekannterBefund('testsuite');
  const ageDays = Math.floor((jetztSek - ts) / 86400);
  const ueberfaellig = jetztSek - ts > NEUN_TAGE_SEK;
  const rot = fail > 0;
  const ueberholt = ueberholtVon(kv, repo);
  // Der ueberholte rote Befund sagt zuerst, WARUM er seine Farbe verloren hat
  // -- ohne diesen Satz waere aus einer roten Marke eine gelbe geworden und
  // niemand wuesste, wohin die Meldung ist. Die Zahl der roten Suiten bleibt
  // darin stehen: sie ist ja gemessen, nur eben an altem Code.
  const text = rot && ueberholt
    ? `Testsuite: ueberholt -- die ${fail} rote(n) Suite(n) stammen vom Stand ${(kv.repo_commit ?? '').slice(0, 7)} (${ageDays} Tage her), ${seither(repo)}. Der Befund gilt nicht mehr fuer den heutigen Code; ein neuer Lauf muss ihn ersetzen.`
    : rot
      ? `Testsuite: ${fail} rote Suite(n) (${ageDays} Tage her)${kv.failed_suites ? ': ' + kv.failed_suites : ''}`
      : ueberfaellig
        ? `Testsuite: letzter Lauf ${ageDays} Tage her (ueberfaellig, Job laeuft woechentlich)`
        : ueberholt
          // Gruen und ueberholt bleibt GRUEN (Begruendung im Kopf dieser Datei
          // und in ampelFuerMaschine) -- der Satz sagt es trotzdem, damit
          // niemand die Zahl fuer eine Aussage ueber den heutigen Baum haelt.
          ? `Testsuite: gruen, ${kv.pass ?? '?'}/${kv.total ?? '?'} bestanden (${ageDays} Tage her) -- geprueft am Stand ${(kv.repo_commit ?? '').slice(0, 7)}, ${seither(repo)}.`
          : `Testsuite: gruen, ${kv.pass ?? '?'}/${kv.total ?? '?'} bestanden (${ageDays} Tage her)`;
  return { quelle: 'testsuite', vorhanden: true, rot, ueberfaellig, ueberholt, ageDays, text };
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
  // `ueberholt` bleibt hier immer `false`: `wb-hygiene` schreibt den geprueften
  // Stand nicht mit, also gibt es die zweite Zahl nicht -- und ohne Messung
  // wird hier nichts behauptet. Der Befund selbst haengt ohnehin an Regeln und
  // STATUS.md, nicht am Zustand des Codes.
  return { quelle: 'hygiene', vorhanden: true, rot, ueberfaellig, ueberholt: false, ageDays, text };
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
 *
 * ROT NUR, SOLANGE DER BEFUND GILT (21.08.). Ein roter Lauf, der einen Baum
 * geprueft hat, den es nicht mehr gibt, verliert die Farbe -- rot liest sich
 * als "jetzt kaputt", und genau das behauptet er zu Unrecht. Er verschwindet
 * dafuer NICHT: er wird gelb, dieselbe Stufe wie ein ueberfaelliger Lauf, denn
 * beide sagen dasselbe -- hier fehlt eine gueltige Messung, lass die Suite
 * laufen. Gruen zu werden waere Beschoenigung, grau ("noch nichts gemessen")
 * waere falsch, denn gemessen wurde ja.
 *
 * EIN UEBERHOLTES GRUEN BLEIBT GRUEN. Das ist die einzige unsymmetrische
 * Stelle, und sie ist gewollt: auf der Arbeitsmaschine rueckt HEAD mehrmals
 * taeglich weiter, ein Gruen wuerde also praktisch immer als ueberholt gelten
 * und die Marke staende dauerhaft auf Gelb -- ein Signal, das immer leuchtet,
 * ist keines mehr. Die beiden Faelle sind auch inhaltlich verschieden: ein
 * ueberholtes Rot behauptet einen Schaden, der laengst behoben sein kann, und
 * kostet den Menschen die Suche danach; ein ueberholtes Gruen behauptet nur,
 * dass es zuletzt in Ordnung war, und der Neun-Tage-Takt holt es ohnehin ein.
 * Der Klick-Hinweis sagt in beiden Faellen, an welchem Stand gemessen wurde.
 */
export function ampelFuerMaschine(
  machine: string,
  testsuiteRaw: string,
  hygieneRaw: string,
  jetztSek: number,
  repo?: RepoStand | null,
): AmpelStand {
  const befunde = [bewerteTestsuite(testsuiteRaw, jetztSek, repo), bewerteHygiene(hygieneRaw, jetztSek)];
  const vorhanden = befunde.filter((b) => b.vorhanden);
  let farbe: AmpelFarbe;
  if (!vorhanden.length) farbe = 'unbekannt';
  else if (vorhanden.some((b) => b.rot && !b.ueberholt)) farbe = 'rot';
  else if (vorhanden.some((b) => b.ueberfaellig || (b.rot && b.ueberholt))) farbe = 'gelb';
  else farbe = 'gruen';
  return { machine, befunde, farbe };
}
