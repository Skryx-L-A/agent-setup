// Freigabe-Ansicht (V20): zwei Quellen, ein Posteingang.
//
//   Antraege            ~/.pi-workers/requests/*.json ohne zugehoerige
//                        .decision-Datei. Entschieden wird ausschliesslich
//                        ueber wb-decide -- diese Datei ruft es auf, spawnt
//                        aber selbst nie einen Worker. Das Starten bleibt beim
//                        Orchestrator (Mensch), wie die Hausordnung verlangt;
//                        wb-decide gibt dafuer den fertigen Aufruf aus, und der
//                        steht in `output`.
//   Angehaltene Worker   ~/.pi-workers/guard-blocks/*.json, geschrieben von
//                        bash-guard.py in dem Moment, in dem er einen Bash-
//                        Befehl ablehnt. Der Marker traegt die tmux-Pane-
//                        Kennung; die Zuordnung zu einem Worker kommt
//                        ausschliesslich aus dem ohnehin geladenen
//                        Sessionmodell (sessions.ts) -- nichts hier wird
//                        geraten. Eine Markerdatei, deren Pane nicht mehr
//                        lebt, ist hinfaellig und wird aufgeraeumt.
import { guardAnnahmeErlaubt, menschlicherAbsender, mobilNachweis, type Herkunftsbeleg, type MobilNachweis } from './herkunft';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { panesHinweisOderFrisch } from './sessions';
import type { SessionInfo } from './sessions';

// V17 (Schritt 9, Guard-Verlauf) haengt unten an: eine eigene Datei
// (`hooks/bash-guard.py` -> `append_block_log()`) neben dem Merker-Ordner
// oben, gruppiert hier gelesen. Beide Quellen gehoeren zur selben Ansicht
// (Freigaben), deshalb keine eigene Datei dafuer.

export interface RequestEntry {
  path: string;
  /** SHA-256 der gelesenen Dateibytes (Kennung am Handy, Review 14.10.2026, F3). */
  inhaltSha256: string;
  ts: string;
  parent: string;
  parentModel: string;
  childName: string;
  childModel: string;
  childEffort: string;
  dir: string;
  files: string[];
  task: string;
  doneCriterion: string;
  whySeparable: string;
  est: string;
}

export function readRequests(requestsDir: string): RequestEntry[] {
  if (!existsSync(requestsDir)) return [];
  let dateien: string[] = [];
  try {
    dateien = readdirSync(requestsDir);
  } catch {
    return [];
  }
  const vorhanden = new Set(dateien);
  const raus: RequestEntry[] = [];
  for (const d of dateien) {
    if (!d.endsWith('.json')) continue;
    if (vorhanden.has(`${d}.decision`)) continue;
    const pfad = join(requestsDir, d);
    try {
      const roh = readFileSync(pfad);
      const r = JSON.parse(roh.toString('utf8')) as Record<string, unknown>;
      raus.push({
        path: pfad,
        inhaltSha256: createHash('sha256').update(roh).digest('hex'),
        ts: String(r.ts ?? ''),
        parent: String(r.parent ?? ''),
        parentModel: String(r.parent_model ?? ''),
        childName: String(r.child_name ?? ''),
        childModel: String(r.child_model ?? ''),
        childEffort: String(r.child_effort ?? ''),
        dir: String(r.dir ?? ''),
        files: Array.isArray(r.files) ? (r.files as unknown[]).map(String) : [],
        task: String(r.task ?? ''),
        doneCriterion: String(r.done_criterion ?? ''),
        whySeparable: String(r.why_separable ?? ''),
        est: String(r.est ?? ''),
      });
    } catch {
      // eine Antragsdatei, die sich nicht lesen laesst, faellt aus der Liste --
      // sie bleibt liegen und im Antragsordner selbst weiter sichtbar.
    }
  }
  raus.sort((a, b) => a.ts.localeCompare(b.ts));
  return raus;
}

export interface DecideResult {
  ok: boolean;
  output: string;
}

/**
 * Ruft wb-decide auf -- entscheidet, spawnt aber nichts; das Starten bleibt
 * beim Orchestrator. wb-decide schreibt seine log.tsv-Zeile unter
 * `$HOME/.pi-workers/requests/log.tsv`, fest verdrahtet in dem Werkzeug
 * selbst. HOME wird hier deshalb IMMER so gesetzt, dass es mit dem
 * konfigurierten requestsDir uebereinstimmt (requestsDir = `$HOME/.pi-workers
 * /requests`) -- sonst wuerde ein Test, der nur AWB_REQUESTS_DIR auf ein
 * Testverzeichnis umbiegt, still gegen die ECHTE log.tsv schreiben.
 */
export function decideRequest(
  requestsDir: string,
  reqPath: string,
  action: 'approve' | 'reject',
  reason: string,
  wbDecideBin: string,
  // HERKUNFT (13.10.2026 Annehmen, 14.10.2026 auch Ablehnen). Ohne Beleg gilt der
  // Aufruf als Steuerkanal. Annehmen und Ablehnen gehen dann NUR mit einem echten
  // Klick in einer Oberflaeche dieses Kerns oder einem geprueften Mobilbeleg; ohne
  // Beleg gibt es hier eine Absage und KEIN wb-decide. Der Kern-Prozess hat nicht
  // selbst eine Herkunft: liegt er unter einem Orchestrator-Pane (Test oder Start aus
  // dem Pane), wuerde wb-decide ihn als Orchestrator messen. Der Hauptagent
  // entscheidet direkt mit wb-decide. Mit Beleg misst wb-decide noch einmal (wb-mensch
  // M2): dafuer traegt nur ein solcher Aufruf WB_MENSCH_QUELLE und WB_APP_PID.
  beleg: Herkunftsbeleg = { art: 'steuerkanal' },
  appPid: number = process.pid,
): DecideResult {
  const mensch = menschlicherAbsender(beleg);
  if (!mensch) {
    return {
      ok: false,
      output: (action === 'approve'
        ? 'Annehmen geht nur mit einem echten Klick in diesem Fenster.'
        : 'Ablehnen geht nur mit einem echten Klick in diesem Fenster.')
        + ' Ein Skript oder der Steuerkanal kann einen Antrag nicht entscheiden -- der'
        + ' Orchestrator entscheidet in seinem Pane mit `wb-decide`.',
    };
  }
  const home = dirname(dirname(requestsDir));
  // DER GERAETEBELEG BIS WB-DECIDE (14.10.2026): ein Mobilbeleg geht nicht mehr ueber
  // M2 (der Kern buergt), sondern traegt den signierten Umschlag samt Body zu
  // `wb-decide --mobilbeleg`, das ihn ueber `wb-mobil-pruefen` selbst prueft, an diesen
  // Antrag und diese Entscheidung bindet und verbraucht. Ohne Nachweis: keine Entscheidung.
  if (beleg.art === 'mobilgeraet') {
    const nachweis = mobilNachweis(beleg);
    if (!nachweis) {
      return { ok: false, output: 'Entscheiden per Mobilgeraet braucht den signierten Geraetebeleg; er fehlt. Nichts entschieden.' };
    }
    const m = spawnSync(wbDecideBin, ['--mobilbeleg', reqPath, action, reason], {
      encoding: 'utf8',
      input: nachweisText(nachweis),
      // Kein WB_MENSCH_QUELLE/WB_APP_PID: hier traegt der Geraetebeleg, nicht der Kern.
      env: { ...process.env, HOME: home, WB_MENSCH_QUELLE: undefined, WB_APP_PID: undefined },
      timeout: 15_000,
    });
    if (m.error || m.signal) {
      process.stderr.write(`decideRequest(${wbDecideBin} --mobilbeleg): ${m.signal ? 'nach 15000ms abgebrochen' : m.error?.message}\n`);
    }
    return { ok: m.status === 0, output: `${m.stdout ?? ''}${m.stderr ?? ''}` };
  }
  // FRIST (2026-08-20, dieselbe Fehlerklasse wie beim Beenden): ein externes
  // Werkzeug ohne `timeout` kann den Hauptprozess unbegrenzt anhalten, wenn es
  // haengt -- auch wenn `wb-decide` heute schnell ist, ist das keine Zusage
  // fuer morgen. 10s wie bei den anderen lokalen Werkzeug-Aufrufen dieses
  // Hauses (schluesselbund.ts).
  const r = spawnSync(wbDecideBin, [reqPath, action, reason], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      // `undefined` laesst Node weg: eine geerbte Angabe darf ohne Klick nicht mitreisen.
      WB_MENSCH_QUELLE: mensch ? 'oberflaeche' : undefined,
      WB_APP_PID: mensch ? String(appPid) : undefined,
    },
    timeout: 10_000,
  });
  if (r.error || r.signal) {
    process.stderr.write(`decideRequest(${wbDecideBin}): ${r.signal ? 'nach 10000ms abgebrochen' : r.error?.message}\n`);
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, output };
}

/** Der Nachweis als stdin-Zeile der Pruefstellen: `{"umschlag":{..},"body_b64":".."}`. */
function nachweisText(nachweis: MobilNachweis): string {
  return `${JSON.stringify({ umschlag: nachweis.umschlag, body_b64: nachweis.body.toString('base64') })}\n`;
}

export interface GuardBlockEntry {
  path: string;
  pane: string;
  guard: string;
  reason: string;
  command: string;
  cwd: string;
  ts: string;
  sessionId: string;
  sessionName: string;
  machine: string;
  workerName: string;
  /** Der Pane lebt, ist aber keinem @wb_role-Pane einer bekannten Session zuzuordnen. */
  unbekannterPane: boolean;
  /**
   * Die mittlere Stufe: true heisst "wartet auf eine einmalige Freigabe",
   * false heisst "endgueltig abgelehnt, hier ist nichts zu entscheiden".
   * Beides steht in DERSELBEN Rubrik der Ansicht -- ein angehaltener Worker
   * ist ein angehaltener Worker; nur die Knoepfe unterscheiden sich.
   */
  wartet: boolean;
  /** Das Muster, das angeschlagen hat (nur bei wartet). */
  muster: string;
  /** Der eine Satz, warum dieses Muster eine Frage wert ist (nur bei wartet). */
  musterGrund: string;
  /** Bindung an Befehl+Pane+Verzeichnis -- benennt die Freigabedatei. */
  schluessel: string;
}

/**
 * Eine Rueckfrage, deren Frist um ist. Sie trägt `expires_ts` (vom Hook
 * gesetzt, dieselbe Dauer wie die Freigabe, die sie beantworten wuerde); fehlt
 * das Feld bei einem wartenden Eintrag, gilt er ebenfalls als abgelaufen --
 * eine Frage ohne Ende waere genau der Dauerzustand, den diese Stufe nicht
 * haben darf. Harte Ablehnungen (`wartet` fehlt) sind davon nicht betroffen:
 * ihr Lebenszyklus haengt weiter am naechsten Befehl derselben Pane.
 */
function abgelaufeneRueckfrage(inhalt: Record<string, unknown>): boolean {
  if (inhalt.wartet !== true) return false;
  const bis = Date.parse(String(inhalt.expires_ts ?? ''));
  if (!Number.isFinite(bis)) return true;
  return Date.now() > bis;
}

/**
 * Nur die Pane-Kennungen der angehaltenen Worker, ohne Zuordnung und ohne
 * Aufraeumen. Genau das braucht sessions.ts fuer den Zustand `blocked`, und es
 * ist dieselbe Quelle wie die Freigabe-Ansicht -- keine zweite Buchfuehrung
 * ueber denselben Sachverhalt. Das Aufraeumen toter Marker bleibt bei
 * readGuardBlocks(): dort liegt der Lebenszyklus, und ein Leser, der nebenbei
 * loescht, waere an dieser Stelle eine Ueberraschung.
 */
export function blockiertePanes(dir: string): Set<string> {
  const raus = new Set<string>();
  if (!existsSync(dir)) return raus;
  let dateien: string[] = [];
  try {
    dateien = readdirSync(dir).filter((d) => d.endsWith('.json'));
  } catch {
    return raus;
  }
  for (const datei of dateien) {
    try {
      const inhalt = JSON.parse(readFileSync(join(dir, datei), 'utf8')) as Record<string, unknown>;
      const pane = String(inhalt.pane ?? '');
      // Eine abgelaufene Rueckfrage haelt niemanden mehr auf: der Worker
      // koennte den Befehl laengst wiederholen und bekaeme eine neue Frage.
      // Sie darf den Worker deshalb auch nicht weiter als `blocked` fuehren.
      if (abgelaufeneRueckfrage(inhalt)) continue;
      if (pane) raus.add(pane);
    } catch {
      // Eine unlesbare Markerdatei sagt nichts -- sie steht trotzdem noch da
      // und faellt in der Freigabe-Ansicht auf.
    }
  }
  return raus;
}

/**
 * Die Panes, die tmux gerade kennt -- oder `null`, wenn tmux NICHTS GESAGT hat.
 *
 * Die Unterscheidung ist der ganze Punkt (Befund 2 der Bugjagd, 15.08.).
 * Vorher kam aus einem fehlgeschlagenen `list-panes -a` eine LEERE Menge
 * zurueck, und der Aufrufer las daraus „keiner dieser Panes lebt noch": ein
 * einziger haengender oder gerade neu startender tmux-Server loeschte damit
 * saemtliche Freigabe- und Guard-Marken auf einmal. Nachgestellt in der Nacht zum 16.08. mit
 * einem `tmux`, das mit 1 endet: eine Marke fuer einen lebenden Worker-Pane
 * hinein, null Eintraege heraus, Datei weg.
 *
 * Ein Fehlschlag heisst jetzt „unbekannt", und Unbekanntes loescht nichts.
 *
 * EIN FETCH STATT ZWEIER, WENN MOEGLICH (2026-09-03, Audit "gleiche
 * Pane-Liste mehrfach im selben Takt"): bis heute fragte diese Funktion
 * `#{pane_id}` in einem EIGENEN `tmux list-panes -a`-Aufruf ab -- im selben
 * 2000-ms-Takt (main.ts), in dem `sessions.ts` (`readSessions`/
 * `leseSessions`) dieselbe Vollserver-Auflistung bereits fuer sich selbst
 * holt, nur in voller Breite (`PANE_LIST_FORMAT`, wovon `#{pane_id}` eine
 * echte Teilmenge ist). `panesHinweisOderFrisch()` in sessions.ts gibt genau
 * diesen schon geholten, noch unbenutzten Fetch heraus, WENN main.ts's Takt
 * kurz zuvor ueber `modellLesen()` einen hinterlassen hat -- sonst fragt es
 * selbst frisch nach, mit demselben `tmuxAntwort()`-Mechanismus wie fuer die
 * Sitzungsliste. Warum kein blosses Zeitfenster/keine blosse Cache-Frische
 * reicht (die Antwort auf zwei Testfaelle mit demselben Socket, aber
 * ABSICHTLICH unterschiedlichem tmux-Verhalten, kurz hintereinander): siehe
 * die ausfuehrliche Erklaerung dort.
 *
 * `tmuxDa`/`fehler` kommen aus `tmuxAntwort()`, DERSELBEN Stelle, die
 * sessions.ts fuer die Sitzungsliste laengst benutzt: sie erkennt "kein
 * Server laeuft" als GUELTIGE leere Antwort (keine Panes, sicher, nicht bloss
 * vermutet) statt als Fehlschlag -- eine Nuance, die der fruehere eigene
 * spawnSync-Aufruf hier nicht kannte und jeden nicht-Null-Exitcode
 * gleichermassen als "unbekannt" behandelte. Das AENDERT NICHTS an der
 * Kernzusage von oben (ein echter Fehlschlag -- haengendes oder nicht
 * ausfuehrbares tmux -- bleibt `null`, und Unbekanntes loescht weiterhin
 * nichts): es ordnet nur den einen Fall, in dem tmux mit Sicherheit "keine
 * Sitzung, also keine Panes" sagt, korrekt als bekannt-leer statt als
 * unbekannt ein -- exakt wie sessions.ts es fuer denselben Befund an der
 * Sitzungsliste schon immer tut.
 */
function alleTmuxPanes(tmuxSocket: string): Set<string> | null {
  const { tmuxDa, panes, fehler } = panesHinweisOderFrisch(tmuxSocket);
  if (!tmuxDa) {
    process.stderr.write(`alleTmuxPanes: ${fehler || 'tmux hat nicht geantwortet'} -- gilt als unbekannt.\n`);
    return null;
  }
  return new Set(panes.map((p) => p.paneId));
}

interface PaneZuordnung {
  sessionId: string;
  sessionName: string;
  machine: string;
  worker: string;
}

function lebendePanes(sessions: SessionInfo[]): Map<string, PaneZuordnung> {
  const karte = new Map<string, PaneZuordnung>();
  for (const s of sessions) {
    if (s.orchestratorPane) {
      karte.set(s.orchestratorPane, { sessionId: s.id, sessionName: s.name, machine: s.machine, worker: 'Orchestrator' });
    }
    for (const w of s.workers) {
      if (w.paneId) karte.set(w.paneId, { sessionId: s.id, sessionName: s.name, machine: s.machine, worker: w.name });
    }
  }
  return karte;
}

/**
 * Angehaltene Worker. Eine Markerdatei gilt nur, solange ihr Pane tatsaechlich
 * noch existiert -- stirbt der Pane, ist die Blockade mit ihm hinfaellig, und
 * die Datei wird geloescht statt still weiter zu haengen. Lebt der Pane, aber
 * gehoert zu keiner bekannten Session (kein @wb_role), wird der Eintrag
 * trotzdem gezeigt statt verworfen: eine reale Blockade auf einem realen Pane
 * ist ein Signal, auch wenn die Zuordnung zu einem Worker fehlt.
 */
export function readGuardBlocks(dir: string, sessions: SessionInfo[], tmuxSocket: string): GuardBlockEntry[] {
  if (!existsSync(dir)) return [];
  let dateien: string[] = [];
  try {
    dateien = readdirSync(dir).filter((d) => d.endsWith('.json'));
  } catch {
    return [];
  }
  const panes = lebendePanes(sessions);
  const lebend = alleTmuxPanes(tmuxSocket);
  const raus: GuardBlockEntry[] = [];
  for (const datei of dateien) {
    const pfad = join(dir, datei);
    let inhalt: Record<string, unknown>;
    try {
      inhalt = JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pane = String(inhalt.pane ?? '');
    // Ein Pane gilt als tot, wenn tmux ihn NICHT NENNT -- nicht schon dann,
    // wenn tmux nichts sagt (`lebend === null`). Die Frist einer Rueckfrage
    // laeuft unabhaengig davon ab: sie steht in der Marke selbst.
    const totLautTmux = lebend !== null && !lebend.has(pane);
    if (!pane || totLautTmux || abgelaufeneRueckfrage(inhalt)) {
      // Der Pane lebt nicht mehr -- die Blockade ist mit ihm hinfaellig. Oder
      // eine Rueckfrage ist verfallen: sie ueberlebt den naechsten Befehl
      // ihrer Pane, aber nicht ihre eigene Frist. Ohne diese Zeile bliebe eine
      // unbeantwortete Frage stehen, bis der Pane stirbt -- der Hook raeumt
      // sie nur auf, wenn dieselbe Pane ueberhaupt noch einmal etwas tut.
      try {
        unlinkSync(pfad);
      } catch {
        // kein Verlust, wenn die Datei schon weg ist
      }
      continue;
    }
    const treffer = panes.get(pane);
    raus.push({
      path: pfad,
      pane,
      guard: String(inhalt.guard ?? ''),
      reason: String(inhalt.reason ?? ''),
      command: String(inhalt.command ?? ''),
      cwd: String(inhalt.cwd ?? ''),
      ts: String(inhalt.ts ?? ''),
      sessionId: treffer?.sessionId ?? '',
      sessionName: treffer?.sessionName ?? '',
      machine: treffer?.machine ?? '',
      workerName: treffer?.worker ?? '',
      unbekannterPane: !treffer,
      wartet: inhalt.wartet === true,
      muster: String(inhalt.muster ?? ''),
      musterGrund: String(inhalt.musterGrund ?? ''),
      schluessel: String(inhalt.schluessel ?? ''),
    });
  }
  raus.sort((a, b) => a.ts.localeCompare(b.ts));
  return raus;
}

export interface GuardLogGruppe {
  guard: string;
  reason: string;
  anzahl: number;
  ersteMs: number;
  letzteMs: number;
  /** Der Befehl der JUENGSTEN Ablehnung dieser Gruppe -- ein Beispiel, keine vollstaendige Liste. */
  letzterBefehl: string;
}

/**
 * Der Verlauf ALLER Ablehnungen, gruppiert nach (guard, reason) -- das ist
 * der Nutzen (Plan V17): sichtbar machen, welche Muster WIEDERHOLT anschlagen,
 * nicht nur der Momentanwert des laufenden Blocks (den liefert
 * `readGuardBlocks()` oben). Eine Datei, die es noch nicht gibt, heisst
 * "noch keine Ablehnung" -- kein Fehler, wie ueberall sonst in diesem Haus.
 * Nur die letzten `limitZeilen` werden gelesen -- die Datei waechst nur an,
 * und ein Verlauf ueber Monate soll ein Programm nicht komplett einlesen.
 */
export function readGuardLog(pfad: string, limitZeilen = 5000, jetztMs: number = Date.now()): GuardLogGruppe[] {
  let stand: Stats;
  try {
    stand = statSync(pfad);
  } catch {
    return [];
  }
  // NUR DER AKTUELLE MONAT (Entscheidung alice, 09.10.2026): aeltere Monate liegen als
  // guard-blocks.YYYY-MM.log.gz neben der Datei (hooks/lib/guard_log.py). Eine Datei, die
  // noch Eintraege eines aelteren Monats traegt (die Rotation geschieht beim naechsten
  // Schreiben), zeigt sie trotzdem nicht. Zeilen ohne lesbaren Zeitstempel bleiben.
  const jetzt = new Date(jetztMs);
  const monatAb = Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), 1);
  // ZWISCHENSPEICHER (09.10.2026, Auftrag perf-kern): der Kern rief das im 2-s-Takt und las die
  // ganze Datei (2,3 MB) jedes Mal neu. Unveraendert (mtime, Groesse), gleiches Limit und gleicher
  // Monat heisst: gleiches Ergebnis.
  const hit = guardLogZwischenspeicher.get(pfad);
  if (hit && hit.mtimeMs === stand.mtimeMs && hit.size === stand.size
      && hit.limit === limitZeilen && hit.monatAb === monatAb) {
    return hit.gruppen;
  }
  let roh = '';
  try {
    roh = readFileSync(pfad, 'utf8');
  } catch {
    return [];
  }
  const gruppen = gruppiereGuardLog(roh, limitZeilen, monatAb);
  guardLogZwischenspeicher.set(pfad, { mtimeMs: stand.mtimeMs, size: stand.size, limit: limitZeilen, monatAb, gruppen });
  return gruppen;
}

const guardLogZwischenspeicher = new Map<string, {
  mtimeMs: number; size: number; limit: number; monatAb: number; gruppen: GuardLogGruppe[];
}>();

function gruppiereGuardLog(roh: string, limitZeilen: number, monatAb: number): GuardLogGruppe[] {
  const zeilen = roh.split('\n').filter((z) => z.trim()).slice(-limitZeilen);
  const gruppen = new Map<string, GuardLogGruppe>();
  for (const zeile of zeilen) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(zeile) as Record<string, unknown>;
    } catch {
      continue; // eine halb geschriebene Zeile (Absturz mitten im Anhaengen) faellt aus, nicht die ganze Datei
    }
    const guard = String(obj.guard ?? '');
    const reason = String(obj.reason ?? '');
    if (!guard || !reason) continue;
    const schluessel = `${guard} ${reason}`;
    const zeit = Date.parse(String(obj.ts ?? ''));
    const ms = Number.isFinite(zeit) ? zeit : 0;
    if (ms && ms < monatAb) continue;
    const bestehend = gruppen.get(schluessel);
    if (!bestehend) {
      gruppen.set(schluessel, { guard, reason, anzahl: 1, ersteMs: ms, letzteMs: ms, letzterBefehl: String(obj.command ?? '') });
      continue;
    }
    bestehend.anzahl += 1;
    if (ms >= bestehend.letzteMs) {
      bestehend.letzteMs = ms;
      bestehend.letzterBefehl = String(obj.command ?? '');
    }
    if (ms && (!bestehend.ersteMs || ms < bestehend.ersteMs)) bestehend.ersteMs = ms;
  }
  return [...gruppen.values()].sort((a, b) => b.letzteMs - a.letzteMs);
}

// ---------------------------------------------------------------------------
// Die mittlere Stufe: eine EINMALIGE Freigabe erteilen oder verweigern.
//
// Erteilen heisst hier ausschliesslich: eine Datei hinlegen, die der Hook beim
// naechsten Versuch DESSELBEN Befehls findet, verbraucht und loescht. Dieses
// Programm fuehrt nichts aus und schickt nichts in die Pane -- der Worker
// wiederholt den Befehl selbst, wie es in seinem Ablehnungstext steht.
//
// Gebunden wird an Befehl im Wortlaut + Pane + Arbeitsverzeichnis; der
// Schluessel ist derselbe SHA-256 wie in hooks/lib/ask_muster.py, und der
// Inhalt traegt die drei Werte noch einmal im Klartext, weil der Hook sie
// beim Einloesen erneut vergleicht. Ein Treffer auf den Dateinamen allein
// soll nie genuegen.
// ---------------------------------------------------------------------------

/** Derselbe Schluessel wie ask_muster.schluessel() -- Befehl, Pane, Verzeichnis, durch NUL getrennt. */
export function freigabeSchluessel(pane: string, cwd: string, command: string): string {
  return createHash('sha256').update(`${pane}\0${cwd}\0${command}`, 'utf8').digest('hex');
}

function zeitstempel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Haengt eine Zeile an denselben Verlauf, in dem jede Ablehnung steht. Die
 * Datei gehoert dem Hook (er legt sie an und schreibt sonst allein hinein);
 * hier kommt genau das dazu, was der Hook NICHT wissen kann: dass ein Mensch
 * entschieden hat, und mit welcher Begruendung. Ohne diese Zeile bliebe eine
 * erteilte Freigabe, die nie eingeloest wurde, unsichtbar.
 */
function verlaufAnhaengen(logFile: string, guard: string, reason: string, eintrag: GuardBlockEntry): void {
  const zeile = JSON.stringify({
    ts: zeitstempel(Date.now()),
    guard,
    reason,
    command: eintrag.command.slice(0, 2000),
    cwd: eintrag.cwd,
    session_id: eintrag.sessionId,
    pane: eintrag.pane,
  });
  try {
    if (verlaufUeberHelfer(logFile, zeile)) return;
    const d = dirname(logFile);
    if (d) mkdirSync(d, { recursive: true });
    appendFileSync(logFile, `${zeile}\n`);
  } catch {
    // Ein nicht schreibbarer Verlauf haelt die Entscheidung nicht auf; die
    // Freigabedatei selbst ist der wirksame Teil.
  }
}

/**
 * DIE SPERRE DES VERLAUFS (09.10.2026, Auftrag perf-aufgaben). `guard-blocks.log` rotiert monatlich
 * (hooks/lib/guard_log.py); die Schreiber halten dabei `flock` auf `<log>.lock`, damit keine Zeile in
 * eine Datei faellt, die gerade umbenannt und gelesen wird. Node hat kein `flock` -- und eine eigene
 * Sperrdatei mit anderem Protokoll sperrte den Python-Schreiber nicht aus. Deshalb schreibt der Kern
 * ueber denselben Weg wie der Hook: ein kleiner Python-Aufruf (`guard_log.py anhaengen`), die Zeile
 * auf stdin. Der Kern schreibt hier selten (ein Klick), ein Start kostet etwa 30 ms.
 * Nie eine Zeile verlieren: fehlt die Datei oder scheitert der Aufruf, schreibt der Aufrufer
 * die Zeile wie bisher selbst (dann deckt nur die Gnadenfrist der Rotation, 0,2 s).
 */
function verlaufUeberHelfer(logFile: string, zeile: string): boolean {
  const helfer = guardLogHelfer();
  if (!helfer) return false;
  const l = spawnSync(process.env.AWB_PYTHON ?? 'python3', ['-I', helfer, 'anhaengen', '--log', logFile],
    { input: zeile, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'ignore', 'ignore'] });
  return l.status === 0;
}

/** `guard_log.py`: AWB_GUARD_LOG_PY, sonst neben diesem Programm im Repo (hooks/lib), sonst die ausgerollte Kopie. */
export function guardLogHelfer(): string | null {
  const kandidaten = [
    process.env.AWB_GUARD_LOG_PY ?? '',
    typeof __dirname === 'string' ? resolve(__dirname, '..', '..', '..', 'hooks', 'lib', 'guard_log.py') : '',
    join(homedir(), '.claude', 'hooks', 'lib', 'guard_log.py'),
  ];
  return kandidaten.find((k) => k && existsSync(k)) ?? null;
}

export interface FreigabeErgebnis {
  ok: boolean;
  output: string;
}

/**
 * Annehmen -- und zwar NICHT mehr, indem dieses Programm die Freigabedatei
 * selbst schreibt.
 *
 * BEFUND (Durchsicht 2026-08-07, gemessen): Eine Freigabe war eine gewoehnliche
 * JSON-Datei in einem Verzeichnis, in das jeder Agent schreiben darf -- ein
 * angehaltenes `sudo` lief nach einem selbst geschriebenen Zettel durch. Seitdem
 * zaehlt eine Freigabe nur mit einem HERKUNFTSNACHWEIS: wer sie erteilt hat,
 * GEMESSEN, plus Signatur ueber die gebundenen Werte (hooks/lib/ask_muster.py).
 *
 * Dieses Programm schreibt den Nachweis nicht selbst, es LAESST ihn messen: es
 * ruft `wb-freigabe`, und zwar auf demselben Weg, auf dem `wb-state` das Merkmal
 * eines Menschen bekommt (siehe befehle.ts, "DER MENSCHEN-NACHWEIS"). Zwei
 * Bedingungen, beide noetig:
 *
 *   1. `mensch` -- der Klick traegt `isTrusted` (im Fenster geprueft, nicht hier
 *      behauptet). Der Steuerkanal kann jeden Knopf dieses Fensters druecken;
 *      ohne diese Bedingung koennte ein Skript sich selbst freigeben, und genau
 *      das ist der Fall, gegen den die ganze Stufe gebaut ist.
 *   2. `wb-mensch` im gerufenen Prozess -- die genannte PID muss ein echter Ahne
 *      sein und wie dieses Programm heissen (M2). Ein Agent kann die Variablen
 *      setzen; unter den Hauptprozess haengen kann er sich nicht.
 *
 * Dass eine gueltige Freigabe an genau EINER Stelle entsteht, ist der Kern:
 * darum wandert auch der Verlaufseintrag (`muster-freigabe`) mit ins Werkzeug.
 * Hier bleibt nur das Ablehnen, denn das braucht keinen Nachweis.
 */
export function freigabeErteilen(
  eintrag: GuardBlockEntry,
  reason: string,
  ttlSekunden: number,
  umgebung: {
    bin: string;
    grantsDir: string;
    blocksDir: string;
    logFile: string;
    appPid: number;
  },
  // Paket 10: der typisierte Herkunftsbeleg (herkunft.ts). Das Boolean bleibt als
  // bisherige Form gleichbedeutend mit einem Klick in der Oberflaeche (`true` =
  // isTrusted), damit kein Aufrufer seine Bedeutung aendert.
  mensch: boolean | Herkunftsbeleg,
): FreigabeErgebnis {
  if (!eintrag.wartet) return { ok: false, output: 'Dieser Eintrag wartet nicht auf eine Freigabe.' };
  const beleg: Herkunftsbeleg = typeof mensch === 'boolean' ? { art: 'oberflaeche', echt: mensch } : mensch;
  const ttl = Math.max(1, Math.min(900, Math.floor(ttlSekunden)));
  const schluessel = freigabeSchluessel(eintrag.pane, eintrag.cwd, eintrag.command);
  if (beleg.art === 'mobilgeraet') {
    // DER GERAETEBELEG BIS WB-FREIGABE (14.10.2026, Entscheidung des Nutzers „Annahme am
    // Handy und Guard angleichen: ja"). Die Geraetesignatur ist im Kern geprueft; das
    // genuegt nicht. `wb-freigabe --mobilbeleg` laesst den Umschlag ueber
    // `wb-mobil-pruefen` selbst pruefen, an genau diesen Schluessel binden und
    // verbrauchen -- derselbe Weg wie beim Antrag (`wb-decide --mobilbeleg`).
    const nachweis = mobilNachweis(beleg);
    if (!nachweis) {
      ablehnungVermerken(umgebung.logFile, eintrag, beleg);
      return { ok: false, output: 'Annehmen per Mobilgeraet braucht den signierten Geraetebeleg; er fehlt. Nichts erteilt.' };
    }
    const m = spawnSync(
      umgebung.bin,
      ['erteilen', '--ttl', String(ttl), '--schluessel', schluessel, '--grund', reason, '--mobilbeleg', eintrag.pane],
      {
        encoding: 'utf8',
        input: nachweisText(nachweis),
        env: {
          ...process.env,
          AWB_GUARD_GRANTS_DIR: umgebung.grantsDir,
          AWB_GUARD_BLOCKS_DIR: umgebung.blocksDir,
          AWB_GUARD_LOG: umgebung.logFile,
          // Kein M2: hier traegt der Geraetebeleg, nicht der Kern als Ahne.
          WB_MENSCH_QUELLE: undefined,
          WB_APP_PID: undefined,
        },
        timeout: 15_000,
      },
    );
    const ausgabe = `${m.stdout ?? ''}${m.stderr ?? ''}`.trim();
    if (m.error || m.status !== 0) {
      // 77: wb-freigabe hat die Absage selbst in den Verlauf geschrieben (ohne Werte).
      if (m.error || m.status !== 77) {
        verlaufAnhaengen(umgebung.logFile, 'muster-freigabe-fehlgeschlagen',
          `Freigeben per Mobilgeraet gescheitert (${m.error ? 'nicht aufrufbar' : `Code ${m.status}`}).`,
          { ...eintrag, command: '', cwd: '' });
      }
      return { ok: false, output: m.error ? `\`${umgebung.bin}\` liess sich nicht aufrufen: ${m.error.message}` : (ausgabe || `\`${umgebung.bin}\` endete mit Code ${m.status}.`) };
    }
    return { ok: true, output: ausgabe || `Freigegeben fuer einen Durchlauf, gueltig ${Math.round(ttl / 60)} Min.` };
  }
  // Die Begruendung ist FREIWILLIG (19.08.): sie stand hier als Pflicht, obwohl
  // sie nie das war, was eine Freigabe traegt -- das ist die gemessene Herkunft
  // drei Zeilen weiter. Ein Satz Text hat nie jemanden aufgehalten, der ihn
  // hinschreiben wollte.
  if (!guardAnnahmeErlaubt(beleg)) {
    ablehnungVermerken(umgebung.logFile, eintrag, beleg);
    return {
      ok: false,
      output: 'Freigeben geht nur mit einem echten Klick in diesem Fenster. '
        + 'Ein Skript oder der Steuerkanal kann eine angehaltene Rueckfrage nicht selbst '
        + 'beantworten -- am Terminal geht es mit `wb-freigabe erteilen '
        + `${eintrag.pane} "<grund>"\`.`,
    };
  }
  const r = spawnSync(
    umgebung.bin,
    // Die Begruendung geht als SCHALTER hinaus, nicht als Stellungsargument
    // (19.08.). Sie darf jetzt leer sein, und ein leeres Stellungsargument ist
    // die Art Argument, die beim naechsten Umbau still an die falsche Stelle
    // rutscht -- dann laese `wb-freigabe` den Pane als Grund oder umgekehrt.
    // `--grund` benennt, was es traegt; der Pane bleibt das einzige, was
    // hinten steht.
    ['erteilen', '--ttl', String(ttl), '--schluessel', schluessel, '--grund', reason, eintrag.pane],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AWB_GUARD_GRANTS_DIR: umgebung.grantsDir,
        AWB_GUARD_BLOCKS_DIR: umgebung.blocksDir,
        AWB_GUARD_LOG: umgebung.logFile,
        WB_MENSCH_QUELLE: 'oberflaeche',
        WB_APP_PID: String(umgebung.appPid),
      },
      // FRIST (2026-08-20, dieselbe Fehlerklasse wie beim Beenden): ein
      // haengendes `wb-freigabe erteilen` haette sonst den Hauptprozess
      // unbegrenzt angehalten. Ein Zeitablauf landet ganz von selbst im
      // bestehenden Fehlerzweig unten (`r.error`) und damit im Verlauf.
      timeout: 10_000,
    },
  );
  const ausgabe = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error || r.status !== 0) {
    const text = r.error
      ? `\`${umgebung.bin}\` liess sich nicht aufrufen: ${r.error.message}`
      : (ausgabe || `\`${umgebung.bin}\` endete mit Code ${r.status}.`);
    // Ein gescheiterter Versuch gehoert in den Verlauf, den dieselbe Ansicht
    // zeigt. Sonst drueckt jemand den Knopf, es passiert nichts, und nirgends
    // steht warum -- genau der Fall, in dem man den Fehler bei sich sucht.
    verlaufAnhaengen(umgebung.logFile, 'muster-freigabe-fehlgeschlagen', text, eintrag);
    return { ok: false, output: text };
  }
  // Den Marker raeumt `wb-freigabe` selbst weg -- es ist die Stelle, die weiss,
  // ob wirklich etwas erteilt wurde.
  return { ok: true, output: ausgabe || `Freigegeben fuer einen Durchlauf, gueltig ${Math.round(ttl / 60)} Min.` };
}

/**
 * EINE ABGEWIESENE ANNAHME STEHT IM VERLAUF (13.10.2026). Bis dahin kehrte
 * `freigabeErteilen` ohne Nachweis vor jedem Verlaufseintrag zurueck, und der
 * Text erreichte nur die Buehne (`melde()`): ein Versuch, ueber den Steuerkanal
 * freizugeben, hinterliess keine Spur. Die Zeile nennt nur die Herkunftsart --
 * keinen Befehl, kein Verzeichnis, keine Begruendung des Aufrufers, denn genau
 * dieser Aufrufer ist hier nicht vertrauenswuerdig; Pane und Sitzung genuegen
 * zur Zuordnung.
 */
function ablehnungVermerken(logFile: string, eintrag: GuardBlockEntry, beleg: Herkunftsbeleg): void {
  const art = beleg.art === 'oberflaeche' ? 'Oberflaeche ohne echten Klick' : beleg.art;
  verlaufAnhaengen(
    logFile,
    'muster-freigabe-fehlgeschlagen',
    `Freigeben abgewiesen: kein echter Klick (Herkunft: ${art}).`,
    { ...eintrag, command: '', cwd: '' },
  );
}

/**
 * Ablehnen: keine Freigabedatei, nur der Marker weg und eine Zeile im Verlauf.
 * Der Worker sieht dieselbe Ablehnung wie vorher, sobald er es erneut
 * versucht -- er bekommt also keine neue Auskunft, aber die Ansicht bleibt
 * sauber und die Entscheidung ist nachlesbar.
 */
export function freigabeVerweigern(
  logFile: string,
  eintrag: GuardBlockEntry,
  reason: string,
): FreigabeErgebnis {
  if (!eintrag.wartet) return { ok: false, output: 'Dieser Eintrag wartet nicht auf eine Freigabe.' };
  // Freiwillig wie beim Erteilen (19.08.). Fehlt sie, sagt die Verlaufszeile das
  // ausdruecklich -- sonst endete sie mit einem Doppelpunkt ins Leere, und
  // niemand saehe spaeter, ob der Grund fehlte oder verlorenging.
  const grund = reason.trim();
  verlaufAnhaengen(
    logFile,
    'muster-abgelehnt',
    grund
      ? `Freigabe verweigert (${eintrag.muster}): ${grund}`
      : `Freigabe verweigert (${eintrag.muster}), ohne Begruendung.`,
    eintrag,
  );
  try {
    unlinkSync(eintrag.path);
  } catch {
    // schon weg
  }
  return { ok: true, output: 'Abgelehnt -- der Befehl bleibt angehalten.' };
}

/**
 * NUR BEI AENDERUNG SENDEN (09.10.2026, Auftrag werkbank-cpu). `awb:freigaben`
 * ging im 2-s-Takt hinaus, auch ohne Aenderung, und traegt den gruppierten
 * Verlauf (`guardLog`) mit: gemessen 1,21 MB JSON bei 788 Gruppen. Der
 * Mac-Mantel las das alle zwei Sekunden ein und hing im Leerlauf bei ~60 % CPU.
 * Beide Empfaenger verwarfen eine gleiche Nutzlast ohnehin (freigaben-view.ts,
 * KernVerbindung.swift). `vergessen()` gehoert an jede Stelle, an der ein neuer
 * Empfaenger dazukommt: der naechste Takt schickt ihm dann den vollen Stand --
 * so spaet, wie er ihn vorher auch bekam.
 */
export class NurBeiAenderung {
  private zuletzt: string | null = null;
  private seitMs = 0;

  /**
   * @param form  Bildet den Wert auf die Form ab, die verglichen wird (siehe
   *              `modellVergleichsform`). Ohne Angabe wird der Wert selbst verglichen.
   * @param auffrischenMs  Hoechstens so lange bleibt ein gleicher Wert ungesendet; danach geht
   *              er trotzdem hinaus. Ohne Angabe: nie. Das Netz unter jedem Vergleich, der
   *              ein Feld absichtlich ausnimmt -- eine Anzeige kann so hoechstens diese Zeit
   *              veraltet sein, nie einfrieren.
   */
  constructor(private readonly form?: (wert: unknown) => unknown, private readonly auffrischenMs = 0,
    private readonly jetzt: () => number = Date.now) {}

  private text(wert: unknown): string {
    return JSON.stringify(this.form ? this.form(wert) : wert);
  }

  /** true, wenn sich `wert` gegenueber dem zuletzt gemeldeten geaendert hat (und merkt ihn). */
  geaendert(wert: unknown): boolean {
    const text = this.text(wert);
    const jetzt = this.jetzt();
    if (text === this.zuletzt && !(this.auffrischenMs > 0 && jetzt - this.seitMs >= this.auffrischenMs)) return false;
    this.zuletzt = text;
    this.seitMs = jetzt;
    return true;
  }

  /** `wert` ging ausserhalb des Filters hinaus (erzwungenes Senden): der Empfaenger hat ihn. */
  merken(wert: unknown): void {
    this.zuletzt = this.text(wert);
    this.seitMs = this.jetzt();
  }

  vergessen(): void {
    this.zuletzt = null;
  }
}

/**
 * Die Vergleichsform von `awb:model` (09.10.2026, Auftrag perf-kern). Gemessen im Leerlauf:
 * 192 KB je Nachricht alle 2 s, und von Takt zu Takt aendern sich nur Felder, die allein
 * die Zeit weiterzaehlt -- ein roher Vergleich faende jedes Mal einen Unterschied.
 *   * `maschinen[].alter` (Sekunden seit der letzten Antwort) zaehlt als die Stufe, die die
 *     Empfaenger zeigen: -1 | "gerade eben" (<60 s) | auf Minuten gerundet
 *     (fuss-status.ts `alterKurz`, Modell.swift `alterText`).
 *   * `workers[].idleSeconds` wird nur bei `state==='stalled'` angezeigt (renderer.ts
 *     `zustandText`, Modell.swift `dauerKurz`) und zaehlt dort als Sekunden (<60) oder
 *     abgerundete Minuten; sonst faellt es aus dem Vergleich.
 *   * `workers[].contextTokens` zaehlt als die gezeigte Stufe (k-gerundet, ab 1 Mio. M mit einer Stelle);
 *     `contextPercent` bleibt exakt.
 *   * `sessions[].revive.reason` traegt das Alter der Unterhaltung („ist 12 min alt und traegt“, revive.ts
 *     `fortsetzenHinweis`); die Zahl wandert jede Minute und bleibt aussen vor -- ob der Hinweis da ist,
 *     zaehlt weiter. Die Zahl kommt mit der naechsten Auffrischung (hoechstens 30 s spaeter).
 *   * `workers[].cpu` (ps-Mittel, driftet jeden Takt) zeigt kein Empfaenger an: ausgenommen.
 * Alles andere -- auch eine Stufe, die kippt -- ist eine Aenderung und geht hinaus.
 */
export function modellVergleichsform(m: unknown): unknown {
  if (!m || typeof m !== 'object') return m;
  const o = m as Record<string, unknown>;
  const stufe = (alter: unknown) => (typeof alter !== 'number' || alter < 0 ? -1 : alter < 60 ? 0 : Math.round(alter / 60));
  // Die Tokenzahl, wie die Empfaenger sie zeigen (renderer.ts / Modell.swift): roh bis 999, dann auf k
  // gerundet, ab einer Million eine Nachkommastelle in M. Ein wachsendes Transcript aendert sie sonst
  // bei jeder Zeile.
  const tokenStufe = (t: unknown) => (typeof t !== 'number' || t <= 0 ? 0
    : t < 1000 ? t : t < 1_000_000 ? `${Math.round(t / 1000)}k` : `${(t / 1_000_000).toFixed(1)}M`);
  const arbeiter = (w: Record<string, unknown>) => {
    const { cpu: _cpu, idleSeconds, ...rest } = w;
    const r = 'contextTokens' in rest ? { ...rest, contextTokens: tokenStufe(rest.contextTokens) } : rest;
    if (w.state !== 'stalled' || typeof idleSeconds !== 'number') return r;
    return { ...r, idleSeconds: idleSeconds < 0 ? -1 : idleSeconds < 60 ? idleSeconds : `m${Math.floor(idleSeconds / 60)}` };
  };
  return {
    ...o,
    maschinen: Array.isArray(o.maschinen)
      ? o.maschinen.map((x: Record<string, unknown>) => ({ ...x, alter: stufe(x.alter) }))
      : o.maschinen,
    sessions: Array.isArray(o.sessions)
      ? o.sessions.map((s: Record<string, unknown>) => {
        const mitWorkern = Array.isArray(s.workers)
          ? { ...s, workers: s.workers.map((w: Record<string, unknown>) => arbeiter(w)) }
          : s;
        const rev = s.revive as Record<string, unknown> | undefined;
        return rev && typeof rev.reason === 'string'
          ? { ...mitWorkern, revive: { ...rev, reason: rev.reason.replace(/ist .{1,20}? alt und traegt/, 'ist # alt und traegt') } }
          : mitWorkern;
      })
      : o.sessions,
  };
}
