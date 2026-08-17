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
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mitMaschinenLocale } from './pfad';
import type { SessionInfo } from './sessions';

// V17 (Schritt 9, Guard-Verlauf) haengt unten an: eine eigene Datei
// (`hooks/bash-guard.py` -> `append_block_log()`) neben dem Merker-Ordner
// oben, gruppiert hier gelesen. Beide Quellen gehoeren zur selben Ansicht
// (Freigaben), deshalb keine eigene Datei dafuer.

export interface RequestEntry {
  path: string;
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
      const r = JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
      raus.push({
        path: pfad,
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
): DecideResult {
  const home = dirname(dirname(requestsDir));
  const r = spawnSync(wbDecideBin, [reqPath, action, reason], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, output };
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
 */
function alleTmuxPanes(tmuxSocket: string): Set<string> | null {
  const basis = tmuxSocket ? ['-L', tmuxSocket] : [];
  // Kodierung mitgeben -- dieselbe Regel wie in sessions.ts und tmux.ts, siehe
  // den Kopf von pfad.ts. Ein einzelnes Feld je Zeile ist von der fehlenden
  // Zeichenklasse nicht betroffen; die Regel gilt trotzdem einheitlich.
  const r = spawnSync('tmux', [...basis, 'list-panes', '-a', '-F', '#{pane_id}'], {
    encoding: 'utf8',
    env: mitMaschinenLocale(),
  });
  // `r.error` faengt den Fall, in dem tmux gar nicht erst startet; `status`
  // ungleich 0 den, in dem es abbricht. Beides ist keine Auskunft ueber Panes.
  if (r.error || r.status !== 0) return null;
  return new Set((r.stdout || '').split('\n').filter(Boolean));
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
export function readGuardLog(pfad: string, limitZeilen = 5000): GuardLogGruppe[] {
  let roh = '';
  try {
    roh = readFileSync(pfad, 'utf8');
  } catch {
    return [];
  }
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
  try {
    const d = dirname(logFile);
    if (d) mkdirSync(d, { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({
      ts: zeitstempel(Date.now()),
      guard,
      reason,
      command: eintrag.command.slice(0, 2000),
      cwd: eintrag.cwd,
      session_id: eintrag.sessionId,
      pane: eintrag.pane,
    })}\n`);
  } catch {
    // Ein nicht schreibbarer Verlauf haelt die Entscheidung nicht auf; die
    // Freigabedatei selbst ist der wirksame Teil.
  }
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
  mensch: boolean,
): FreigabeErgebnis {
  if (!eintrag.wartet) return { ok: false, output: 'Dieser Eintrag wartet nicht auf eine Freigabe.' };
  if (!reason.trim()) return { ok: false, output: 'Begruendung fehlt -- ein Satz genuegt.' };
  if (!mensch) {
    return {
      ok: false,
      output: 'Freigeben geht nur mit einem echten Klick in diesem Fenster. '
        + 'Ein Skript oder der Steuerkanal kann eine angehaltene Rueckfrage nicht selbst '
        + 'beantworten -- am Terminal geht es mit `wb-freigabe erteilen '
        + `${eintrag.pane} "<grund>"\`.`,
    };
  }
  const ttl = Math.max(1, Math.min(900, Math.floor(ttlSekunden)));
  const schluessel = freigabeSchluessel(eintrag.pane, eintrag.cwd, eintrag.command);
  const r = spawnSync(
    umgebung.bin,
    ['erteilen', '--ttl', String(ttl), '--schluessel', schluessel, eintrag.pane, reason],
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
  if (!reason.trim()) return { ok: false, output: 'Begruendung fehlt -- ein Satz genuegt.' };
  verlaufAnhaengen(logFile, 'muster-abgelehnt', `Freigabe verweigert (${eintrag.muster}): ${reason}`, eintrag);
  try {
    unlinkSync(eintrag.path);
  } catch {
    // schon weg
  }
  return { ok: true, output: 'Abgelehnt -- der Befehl bleibt angehalten.' };
}
