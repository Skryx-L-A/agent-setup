// DER VORSCHLAG FUER EINEN NEUEN AGENTEN (14.09.2026, Plan Fassung 28,
// Abschnitt 9 und Bauschritt 5; Auftrag agentsui Nr. 3).
//
// Aus einer Beschreibung in Alltagssprache entwirft ein Modell das Profil und
// die persoenliche Anweisungsdatei. Der Entwurf ist nur ein Vorschlag: er steht
// danach im Formular, der Mensch aendert ihn, und erst „Anlegen" schreibt ueber
// die Datenbibliothek (welten.ts, `agent anlegen`). Diese Datei schreibt keine
// Weltdatei und startet keinen Agenten.
//
// DER HARNESS-WEG. Derselbe Befehl wie die Chat-Sitzung (`claude`, Test:
// AWB_ENTWURF_CLAUDE), aber als einzelner kopfloser Zug: `--print`, keine
// Werkzeuge (`--tools ""`), keine MCP-Server, keine Einstellungsquellen, keine
// Slash-Befehle, keine gespeicherte Sitzung. Das Arbeitsverzeichnis ist ein
// frischer leerer Ordner, nie die Welt; das Modell bekommt nur, was im Prompt
// steht (Weltname, Teams, belegte Kennungen, Modellliste, Figurenkatalog).
// Codex (`codex exec`) hat keinen Schalter ohne Werkzeuge; dort gilt die
// schreibgeschuetzte Sandbox im selben leeren Ordner.
//
// DIE MODELLWAHL. `sonnet5:high` ist die Vorgabe, `codex-gpt-5-6-terra:high`
// die zweite Wahl. Kennung, Harness und Modellname kommen aus
// `wb-state models get`, der Deckel der Denkstufe aus `wb-state models cap`;
// liegt die gewuenschte Stufe darueber, gilt der Deckel. Fable nie.
//
// DIE FIGUR. Modelle ohne Bildfaehigkeit bekommen eine feste Anleitung, die
// eine Figur aus dem Katalog von Agentenfigur.swift benennt: Art und Farbe,
// keine Neugestaltung.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ENTWURF_MODELLE = ['sonnet5:high', 'codex-gpt-5-6-terra:high'] as const;
export const ENTWURF_FELDER = ['id', 'stage', 'team', 'specialty', 'model', 'effort', 'fallback_model', 'fallback_effort',
  'machine', 'tools', 'bash', 'skills', 'context_limit', 'figure', 'instructions', 'template'] as const;
export const AGENT_WERKZEUGE = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
export const FIGUR_ARTEN = ['roboter', 'tier', 'linse'];
export const FIGUR_FARBEN = ['entwicklung', 'recherche', 'pruefung', 'gestaltung'];
const STUFEN = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface EntwurfOptionen {
  claude: string;
  codex: string;
  wbState: string;
  /** HOME des Harness-Prozesses (Anmeldung); leer = HOME des Kerns. */
  home: string;
  fristMs: number;
}

export function entwurfOptionenAusUmgebung(env: NodeJS.ProcessEnv, home: string): EntwurfOptionen {
  return {
    claude: env.AWB_ENTWURF_CLAUDE ?? env.AWB_CHAT_CMD ?? 'claude',
    codex: env.AWB_ENTWURF_CODEX ?? 'codex',
    wbState: env.AWB_WB_STATE ?? join(home, '.local', 'bin', 'wb-state'),
    home: env.AWB_ENTWURF_HOME ?? '',
    fristMs: Number(env.AWB_ENTWURF_FRIST_MS ?? 240_000),
  };
}

export interface ModellZeile { kennung: string; harness: string; aufgabe: string }

/** Die Zeilen aus `wb-state models table` (Markdown): Kennung, Harness, Aufgabe; Fable nie, jede Kennung einmal. */
export function modelleAusTabelle(text: string): ModellZeile[] {
  const zeilen = new Map<string, ModellZeile>();
  for (const zeile of text.split('\n')) {
    const m = zeile.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (!m || /fable/i.test(m[2])) continue;
    const alt = zeilen.get(m[2]);
    if (alt) {
      if (!alt.aufgabe.split(' / ').includes(m[1])) alt.aufgabe = `${alt.aufgabe} / ${m[1]}`;
      continue;
    }
    zeilen.set(m[2], { kennung: m[2], harness: m[3], aufgabe: m[1] });
  }
  return [...zeilen.values()];
}

export interface ModellWahl { wahl: string; kennung: string; harness: string; ref: string; stufe: string; deckel: string; hinweis: string }

/**
 * `sonnet5:high` -> Registry-Eintrag und Deckel. `eintrag` ist die Ausgabe von
 * `wb-state models get <alias>`, `deckel` die von `wb-state models cap <id> --json`.
 */
export function modellWaehlen(wahl: string, eintrag: unknown, deckel: unknown): ModellWahl | { fehler: string } {
  if (!(ENTWURF_MODELLE as readonly string[]).includes(wahl)) return { fehler: `Für Vorschläge gibt es nur ${ENTWURF_MODELLE.join(' oder ')}.` };
  const e = (eintrag ?? {}) as { id?: unknown; harness?: unknown; modelRef?: unknown };
  const d = (deckel ?? {}) as { cap?: unknown };
  const kennung = typeof e.id === 'string' ? e.id : '';
  const harness = typeof e.harness === 'string' ? e.harness : '';
  const ref = typeof e.modelRef === 'string' ? e.modelRef : kennung;
  if (!kennung || !harness) return { fehler: `Modell ${wahl} ist in der Registry nicht zu finden (wb-state models get).` };
  if (/fable/i.test(kennung) || /fable/i.test(ref)) return { fehler: 'Fable ist für Agents verboten.' };
  if (harness !== 'claude' && harness !== 'codex') return { fehler: `Harness ${harness} ist für Vorschläge nicht verdrahtet.` };
  const gewuenscht = wahl.split(':')[1] ?? 'high';
  const cap = typeof d.cap === 'string' && STUFEN.includes(d.cap) ? d.cap : '';
  if (!cap) return { fehler: `Kein Deckel für ${kennung} (wb-state models cap).` };
  const ueber = STUFEN.indexOf(gewuenscht) > STUFEN.indexOf(cap);
  return {
    wahl, kennung, harness, ref, stufe: ueber ? cap : gewuenscht, deckel: cap,
    hinweis: ueber ? `Denkstufe ${gewuenscht} liegt über dem Deckel ${cap}; der Vorschlag läuft mit ${cap}.` : '',
  };
}

export interface EntwurfWelt {
  name: string; hauptagent: string | null; teams: { name: string; leiter: string | null }[]; agenten: string[];
  /** Auftrag agentsform: die Maschine eines neuen Agenten in dieser Welt (Traegermaschine); ohne Angabe peer. */
  maschine?: string;
}

/** Die feste Anleitung fuer die Figur -- auch fuer ein Modell ohne Bildfaehigkeit eindeutig abzuarbeiten. */
export const FIGUR_ANLEITUNG = [
  'Figur: Du zeichnest nichts. Du wählst genau eine Figur aus dem Katalog und gibst sie als "figure": {"family": ..., "color": ...} zurück.',
  'Arten (family): "roboter" = Maschinenwesen mit Bildschirmgesicht; "tier" = Wesen mit Ohren; "linse" = eigene Figur für Reviewer und Prüfer, die Arbeit anderer gegenlesen.',
  'Farben (color): "entwicklung" = Blau; "recherche" = Petrol; "pruefung" = Orange; "gestaltung" = Magenta.',
  'Regeln in dieser Reihenfolge: 1. Liest der Agent fremde Arbeit gegen (Review, Abnahmeprüfung), family "linse", color "pruefung".',
  '2. Heißt das Team recherche oder gestaltung, family "tier" und color wie das Team. 3. Heißt das Team entwicklung oder pruefung, family "roboter" und color wie das Team.',
  '4. Sonst: Recherche, Quellen, Texte, Dokumente, Gestaltung, Bilder -> family "tier"; Code, Tests, Build, Betrieb -> family "roboter"; color nach dem Schwerpunkt: Code und Betrieb "entwicklung", Recherche und Quellen "recherche", Tests und Prüfung "pruefung", Texte, Dokumente und Gestaltung "gestaltung".',
  'Nie "kern" (nur der Hauptagent), nie eine andere Art oder Farbe.',
].join('\n');

export function entwurfPrompt(beschreibung: string, welt: EntwurfWelt, vorgaben: Record<string, unknown>, modelle: ModellZeile[]): string {
  const teams = welt.teams.length ? welt.teams.map((t) => `${t.name}${t.leiter ? ` (Leiter ${t.leiter})` : ''}`).join(', ') : 'noch keine';
  const liste = modelle.slice(0, 60).map((m) => `${m.kennung} (${m.harness}; ${m.aufgabe})`).join('\n');
  const gesetzt = Object.entries(vorgaben).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
  return [
    'Entwirf das Profil eines neuen Agenten für die Agents-Welt einer Werkbank. Antworte NUR mit einem JSON-Objekt, ohne Erklärung davor oder danach.',
    '',
    `Welt: „${welt.name}“. Hauptagent: ${welt.hauptagent ?? 'noch keiner'}. Teams: ${teams}. Belegte Kennungen: ${welt.agenten.join(', ') || 'keine'}.`,
    '',
    'Beschreibung des Menschen:',
    beschreibung.trim(),
    '',
    gesetzt.length ? `Vom Menschen schon festgelegt (übernimm diese Werte unverändert): ${JSON.stringify(Object.fromEntries(gesetzt))}` : 'Der Mensch hat nichts außer der Beschreibung festgelegt.',
    '',
    'Felder des JSON-Objekts (keine anderen):',
    ...feldRegeln('die Beschreibung', welt.maschine),
    '',
    FIGUR_ANLEITUNG,
    '',
    'Modellliste (Kennung, Harness, Aufgabe):',
    liste,
  ].join('\n');
}

/** Die Regeln je Feld, gemeinsam fuer Vorschlag und Gespraech (agentengespraech.ts); `quelle` nennt, woraus der Entwurf kommt. */
export function feldRegeln(quelle: string, maschine = 'peer'): string[] {
  return [
    '- "id": Kennung aus Kleinbuchstaben, Ziffern und Bindestrich, höchstens 40 Zeichen, nicht belegt.',
    `- "stage": "mitglied" oder "teamleiter" ("hauptagent" nur, wenn die Welt keinen hat und ${quelle} ihn verlangt).`,
    '- "team": Name eines bestehenden Teams oder ein neuer kurzer Teamname in Kleinbuchstaben; Pflicht für teamleiter.',
    '- "specialty": das Spezialgebiet in genau einem deutschen Satz, der mit einem Verb beginnt, ohne Pronomen (z. B. "Prüft Änderungen …", nie "Er prüft …").',
    '- "model" und "fallback_model": Kennungen aus der Modellliste unten, mit Denkstufe als Suffix, z. B. "sonnet5:high". Lokal, wo es reicht; Claude oder Codex für schwere Arbeit. Nie Fable.',
    `- "machine": "${maschine || 'peer'}" als Vorgabe (die Trägermaschine der Welt); "mac" nur, wenn die Arbeit am Mac sein muss.`,
    `- "tools": Liste aus ${AGENT_WERKZEUGE.join(', ')}; so wenig wie möglich. Wer nur liest, bekommt kein Write und kein Edit.`,
    '- "bash": nur wenn "Bash" in tools steht: eng gefasste Befehlsmuster wie "git status" oder "npm test". Nie git push, rm -rf, kill, Mail-Versand oder wb-state.',
    '- "skills": Liste von Skillnamen in Kleinbuchstaben, eher leer als geraten.',
    '- "context_limit": ein Satz ohne Pronomen, was der Agent nicht erfahren soll (z. B. "Keine Zugangsdaten und keine Produktionsdaten.").',
    '- "figure": siehe Figur-Anleitung.',
    '- "instructions": die persönliche Anweisungsdatei als Markdown, auf Deutsch, beginnend mit "# <id> – Anweisungen", in der Du-Form an den Agenten, mit den Abschnitten "## Rolle", "## Arbeitsweise", "## Grenzen" und "## Meldewege". Mitglieder melden an ihren Teamleiter, Teamleiter an den Hauptagenten; nur der Hauptagent fragt den Menschen. Kein Eingriff außerhalb der Welt. Nenne andere Agenten nur mit Stufe und Kennung („Teamleiter ada“), ohne Pronomen und ohne aus dem Namen ein Geschlecht abzuleiten.',
  ];
}

export const ENTWURF_SYSTEM = 'Du entwirfst Profile für Agenten. Du antwortest ausschließlich mit einem einzigen gültigen JSON-Objekt.';

/**
 * Die Befehlszeile des einzelnen Zuges. `ausgabe` ist die Datei fuer die letzte Codex-Nachricht.
 * `system` ist der Systemprompt fuer Claude; Codex hat keinen Schalter dafuer, dort steht alles im Prompt.
 */
export function harnessAufruf(m: ModellWahl, opt: EntwurfOptionen, ausgabe: string, system = ENTWURF_SYSTEM): { bin: string; args: string[] } {
  if (m.harness === 'codex') {
    return {
      bin: opt.codex,
      args: ['exec', '--model', m.ref, '-c', `model_reasoning_effort="${m.stufe}"`, '--sandbox', 'read-only',
        '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-last-message', ausgabe, '-'],
    };
  }
  return {
    bin: opt.claude,
    args: ['--print', '--model', m.ref, '--effort', m.stufe, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json',
      '--system-prompt', system],
  };
}

/** Der Text der Antwort: bei Claude das Feld `result` der JSON-Ausgabe, bei Codex die letzte Nachricht. */
export function antwortText(harness: string, stdout: string, letzteNachricht: string): { text: string; fehler: string; kosten: number | null } {
  if (harness === 'codex') return { text: letzteNachricht, fehler: letzteNachricht.trim() ? '' : 'Codex lieferte keine Nachricht.', kosten: null };
  try {
    const j = JSON.parse(stdout) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown };
    if (j.is_error === true) return { text: '', fehler: `Das Modell meldete einen Fehler: ${String(j.result ?? '').slice(0, 200)}`, kosten: null };
    return { text: typeof j.result === 'string' ? j.result : '', fehler: '', kosten: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null };
  } catch {
    return { text: '', fehler: `Die Ausgabe des Harness ist kein JSON: ${stdout.trim().slice(0, 160)}`, kosten: null };
  }
}

const kennungAus = (v: string): string => v.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * Das JSON-Objekt aus dem Text des Modells, auf die Felder der Positivliste
 * und ihre Typen gebracht. Was der Mensch vorgegeben hat, gilt vor dem Modell.
 * Die eigentliche Pruefung (Hausliste, Fable, Stufen) macht danach die Bibliothek.
 */
export function entwurfAusText(text: string, vorgaben: Record<string, unknown>, belegt: string[]): { entwurf: Record<string, unknown> } | { fehler: string } {
  const ohneZaun = text.replace(/```(?:json)?/g, '');
  const a = ohneZaun.indexOf('{');
  const b = ohneZaun.lastIndexOf('}');
  if (a < 0 || b <= a) return { fehler: 'Das Modell lieferte kein JSON-Objekt.' };
  let roh: unknown;
  try {
    roh = JSON.parse(ohneZaun.slice(a, b + 1));
  } catch {
    return { fehler: 'Das JSON des Modells ist nicht lesbar.' };
  }
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return { fehler: 'Das Modell lieferte kein JSON-Objekt.' };
  const entwurf = felderAusObjekt(roh as Record<string, unknown>);
  entwurf.id = freieKennungAus(typeof entwurf.id === 'string' ? entwurf.id : '', belegt);
  for (const [k, v] of Object.entries(vorgaben)) {
    if (!gesetzterWert(k, v)) continue;
    entwurf[k] = v;
  }
  return { entwurf };
}

/** Ob ein Wert der Vorgaben zaehlt: ein Feld der Positivliste, nicht leer. */
export function gesetzterWert(k: string, v: unknown): boolean {
  return (ENTWURF_FELDER as readonly string[]).includes(k) && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
}

/** Eine Kennung aus beliebigem Text, abgewandelt, wenn sie belegt ist; leer wird `agent`. */
export function freieKennungAus(roh: string, belegt: string[]): string {
  let id = kennungAus(roh) || 'agent';
  if (belegt.includes(id)) {
    let n = 2;
    while (belegt.includes(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  return id;
}

/**
 * Die Felder eines Modell-Objekts auf Positivliste und Typen gebracht; nur, was
 * darin steht (ein Teilstand im Gespraech bleibt ein Teilstand). `id` bleibt roh.
 */
export function felderAusObjekt(r: Record<string, unknown>): Record<string, unknown> {
  const text1 = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string).trim() : undefined);
  const liste = (k: string): string[] | undefined => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : undefined);
  const entwurf: Record<string, unknown> = {};
  const id = text1('id');
  if (id) entwurf.id = id;
  for (const k of ['stage', 'team', 'specialty', 'model', 'effort', 'fallback_model', 'fallback_effort', 'machine', 'context_limit']) {
    const v = text1(k);
    if (v) entwurf[k] = v;
  }
  const anweisungen = text1('instructions');
  if (anweisungen) entwurf.instructions = `${anweisungen}\n`;
  for (const k of ['tools', 'bash', 'skills']) {
    const v = liste(k);
    if (v) entwurf[k] = v;
  }
  const f = r.figure as { family?: unknown; color?: unknown } | undefined;
  if (f && typeof f === 'object') {
    entwurf.figure = {
      family: FIGUR_ARTEN.includes(String(f.family)) ? String(f.family) : 'roboter',
      color: FIGUR_FARBEN.includes(String(f.color)) ? String(f.color) : 'entwicklung',
    };
  }
  return entwurf;
}

const laufendeGruppen = new Set<number>();

/** Beendet laufende Vorschlags-Zuege (Kernende). */
export function entwurfAbraeumen(): void {
  for (const pid of laufendeGruppen) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // schon weg
    }
  }
  laufendeGruppen.clear();
}

export interface HarnessLauf { code: number | null; out: string; err: string; fehler: string }

/** Ein Zug mit Prompt auf stdin, eigener Prozessgruppe und Frist. */
export function harnessLaufen(bin: string, args: string[], eingabe: string, ordner: string, env: NodeJS.ProcessEnv, fristMs: number): Promise<HarnessLauf> {
  return new Promise((fertig) => {
    let out = '';
    let err = '';
    let erledigt = false;
    let kind: ReturnType<typeof spawn> | undefined;
    const ende = (code: number | null, fehler: string) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(uhr);
      if (kind?.pid) laufendeGruppen.delete(kind.pid);
      fertig({ code, out, err, fehler });
    };
    const uhr = setTimeout(() => {
      if (kind?.pid) {
        try {
          process.kill(-kind.pid, 'SIGKILL');
        } catch {
          // schon weg
        }
      }
      ende(null, `Das Modell brauchte länger als ${Math.round(fristMs / 1000)} s.`);
    }, fristMs);
    try {
      kind = spawn(bin, args, { cwd: ordner, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env });
    } catch (e) {
      ende(null, (e as Error).message);
      return;
    }
    if (kind.pid) laufendeGruppen.add(kind.pid);
    kind.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    kind.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    kind.on('error', (e) => ende(null, e.message));
    kind.on('close', (code) => ende(code, ''));
    kind.stdin?.on('error', () => undefined);
    kind.stdin?.end(eingabe);
  });
}

/** Die Umgebung des Zuges: ohne Marken der laufenden Werkbank und der aufrufenden Agenten-Shell. */
export function harnessUmgebung(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const rest: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AWB_|WB_|TMUX|PI_AGENT)/.test(k)) continue;
    rest[k] = v;
  }
  if (home) rest.HOME = home;
  return rest;
}

export interface VorschlagErgebnis {
  ok: boolean;
  meldung: string;
  entwurf?: Record<string, unknown>;
  aufruf: { modell: string; kennung: string; harness: string; stufe: string; bin: string; args: string[]; ordner: string; trocken: boolean } | null;
  kosten?: number | null;
  dauer_ms?: number;
}

/** Ein leerer Ordner fuer den Zug; wird danach geloescht. */
export function leererOrdner(): string {
  return mkdtempSync(join(tmpdir(), 'wb-agentenentwurf-'));
}

export async function vorschlagLaufen(m: ModellWahl, prompt: string, opt: EntwurfOptionen, trocken: boolean,
  laeufer: typeof harnessLaufen = harnessLaufen, system = ENTWURF_SYSTEM): Promise<{ text: string; fehler: string; aufruf: NonNullable<VorschlagErgebnis['aufruf']>; kosten: number | null; dauer: number }> {
  const ordner = leererOrdner();
  const ausgabe = join(ordner, '.letzte-nachricht.txt');
  const { bin, args } = harnessAufruf(m, opt, ausgabe, system);
  const aufruf = { modell: m.wahl, kennung: m.kennung, harness: m.harness, stufe: m.stufe, bin, args, ordner, trocken };
  try {
    if (trocken) return { text: '', fehler: '', aufruf, kosten: null, dauer: 0 };
    const start = Date.now();
    const l = await laeufer(bin, args, prompt, ordner, harnessUmgebung(process.env, opt.home), opt.fristMs);
    const dauer = Date.now() - start;
    if (l.fehler) return { text: '', fehler: l.fehler, aufruf, kosten: null, dauer };
    if (l.code !== 0) {
      const zeile = (l.err.trim().split('\n').filter(Boolean).pop() ?? l.out.trim().slice(0, 200)) || `Exit ${l.code}`;
      return { text: '', fehler: `Der Harness endete mit ${l.code}: ${zeile.slice(0, 240)}`, aufruf, kosten: null, dauer };
    }
    let letzte = '';
    if (m.harness === 'codex') {
      try {
        letzte = readFileSync(ausgabe, 'utf8');
      } catch {
        letzte = '';
      }
    }
    const t = antwortText(m.harness, l.out, letzte);
    return { text: t.text, fehler: t.fehler, aufruf, kosten: t.kosten, dauer };
  } finally {
    rmSync(ordner, { recursive: true, force: true });
  }
}
