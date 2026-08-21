// A9: die Einstellungen als EIGENES Fenster ueber dem Hauptfenster.
//
// NEU GESCHNITTEN AM 11.08. NACH SPEC-V4 ABSCHNITT 3. Sieben Seiten statt
// sechs, jede kuerzer: Sitzung, Erlaubnisse, Programme und Modelle, Maschinen,
// Aufsicht und Meldungen, Aussehen, Programm. Die Worker-Seite ist ersatzlos
// weggefallen -- Wort des Nutzers: "er muss aber nur orchestrator einstellen, die
// worker nicht, die macht ja der orchestrator fuer ihn". JEDE Einstellung
// traegt weiterhin drei Ebenen: einen kurzen Namen ohne Vorwissen, eine
// gedaempfte Zeile mit der Wirkung, und ein Infozeichen mit dem Grund.
//
// DIESE DATEI SAMMELT NUR EIN, was das Fenster zeichnet. Seit dem 11.08. ist
// dabei dreierlei hinzugekommen, das die Oberflaeche selbst nicht wissen kann:
// ob ein Programm ANGEMELDET ist (gemessen am Beleg, den die Registry nennt),
// ob es eine CHAT-ANSICHT tragen kann (am `session`-Block der Registry), und
// die normalisierten neuen Einstellungen (Meldungen, Sprache, Thema, Farben).
//
// WARUM NICHT DIE UEBERNOMMENE SEITE. Bis zum 05.08. zeigte das Zahnrad
// `extension/src/settingsHtml.ts` in einem Rahmen ueber der Buehne -- die Seite
// der VS-Code-Erweiterung, importiert statt entworfen. Sie ist keine eigenes
// Fenster, sondern eine Flaeche mit Reiterzeile; sie ist EINE Seite mit
// dreizehn Ueberschriften statt mehrerer, links durchklickbarer Seiten; ihr
// fehlen der Haken fuer alte Sessions (A12) und die Standardsortierung (A16);
// und Modellwahl wie Effort-Deckel sind so gebaut, dass man sie erst nach der
// Wahl sieht.
//
// WAS GETEILT BLEIBT UND WAS NICHT. Geteilt bleibt die BEDEUTUNG der
// Einstellungen: `Settings`, `parseSettings`, `EFFORTS`, `allowedEfforts`,
// `modelSupportsEffort`, `modelsForRole`, `effectiveHarnesses` kommen weiter
// aus `extension/src/` -- es gibt also nach wie vor EINE Vorstellung davon, was
// eine Einstellung ist, welche Effort-Stufen ein Modell zulaesst und welche
// Modelle zu einer Rolle gehoeren. Eigen ist nur die DARSTELLUNG, und genau die
// musste sich aendern. Der Plan hatte sich beim ersten Mal fuer "importieren
// statt kopieren" entschieden, um Drift zu vermeiden; das Argument gilt fuer
// die Bedeutung und wird hier eingehalten, nicht fuer eine Bauform, die
// ausdruecklich eine andere sein soll.
//
// `extension/src/settingsHtml.ts` ist seit dem 11.08. eine DUENNE Seite, die
// auf dieses Fenster zeigt und das Programm oeffnet. Zwei gepflegte
// Oberflaechen fuer dieselbe Datei hiessen zwei Wahrheiten: fuenf Schluessel
// gab es nur dort, zwei Warnschwellen fuehrten auf dieselbe Wirkung wie die
// Kontextwache und verloren gegen sie. Der Grund steht im Kopf jener Datei.
import { BrowserWindow } from 'electron';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  allowedEfforts,
  effectiveHarnesses,
  effectiveModels,
  findHarness,
  findProvider,
  modelSupportsEffort,
  parseModelsRegistry,
  type ModelsRegistry,
  type RegistryModel,
  type RegistryVorhersage,
} from '../../../extension/src/models.ts';
import { type Effort } from '../../../extension/src/settings.ts';
import { claudeSettingsFile, parseHooks } from '../../../extension/src/hooksInfo.ts';
import {
  alleEinstellungen,
  askMuster,
  ausschlussMuster,
  ausschlussOrdner,
  chatAnsicht,
  chatAnsichtVorgabe,
  maschinenliste,
  MELDE_EREIGNISSE,
  MELDE_WEGE,
  meldungen,
  ollamaEndpunkt,
  sprache,
  thema,
  VORGABEN,
  zustandsfarben,
  type AskMuster,
  type MeldeEinstellung,
} from './einstellungen';
import type { ChatVorgabe } from '../chat/ansichtsregel';
import { protokollListe } from './protokolle';
import { chatQuellen, type ChatQuelle } from './chatschalter';
import type { UiState } from './uistate';

export { chatQuellen, type ChatQuelle };

/** Ein Harness, so wie die Oberflaeche ihn braucht: mit Zahl und Maschinenwahrheit. */
export interface HarnessSicht {
  id: string;
  label: string;
  /** Wie viele Modelle dieser Harness in der Registry hat. */
  modelle: number;
  /** V11: Hat sein Binary auf DIESER Maschine? */
  binaer: boolean;
}

/**
 * Ein Modell, so wie die Liste es zeigt. Der Effort-DECKEL steht mit drin --
 * das ist der Punkt, an dem die alte Seite scheiterte: dort war er erst zu
 * sehen, wenn man das Modell schon gewaehlt hatte.
 */
export interface ModellSicht {
  id: string;
  label: string;
  harness: string;
  harnessLabel: string;
  rollen: string[];
  /** Die erlaubten Stufen, aufsteigend. Leer heisst: kennt kein Effort-Flag. */
  efforts: Effort[];
  /** Kennt dieses Modell/dieser Harness ueberhaupt ein Effort-Flag? */
  effortFaehig: boolean;
  /** Groesse des Kontextfensters in Token, 0 wenn unbekannt. */
  kontext: number;
  /**
   * Laeuft dieses Modell auf DIESER Maschine, statt bei einem Anbieter?
   *
   * Gemessen an der ART DES ANBIETERS (`provider.kind === 'local'`), nicht am
   * Harness: `kontingent.art` steht am Harness und sagt etwas ueber sein
   * KONTINGENT, nicht ueber den Ort des Modells -- aider etwa traegt dort
   * 'lokal' und fuehrt trotzdem zwanzig Modelle ueber openrouter. Am Anbieter
   * gemessen stimmt es je Modell, und genau darauf kommt es an: nur bei einem
   * lokalen Modell ist die Groesse des Kontextfensters ueberhaupt eine Wahl.
   */
  lokal: boolean;
  /** V11: laeuft der Harness dieses Modells auf DIESER Maschine an? */
  startbar: boolean;
  /**
   * Der AUSGELIEFERTE Deckel aus der Registry (`maxEffort`), ohne die Setzung
   * darueber. Die Modelle-Seite braucht beide Zahlen nebeneinander, um zu
   * zeigen, was ein Mensch entschieden hat und was mitgeliefert wurde.
   */
  deckelRegistry: string;
  /**
   * Multi-Token-Vorhersage (2026-08-20): die AUSLIEFERUNG legt fest, welcher
   * Entwerfer/eingebaute Kopf zu diesem Modell gehoert -- ein Mensch liest es
   * hier nur, er stellt es nicht um (Vorgabe des Nutzers: "die Zuordnung
   * gehoert zur Auslieferung, nicht in die Oberflaeche"). Fehlt, wenn die
   * Registry-Zeile kein `vorhersage`-Feld traegt.
   */
  vorhersage?: RegistryVorhersage;
}

export interface EinstellungsDaten {
  /**
   * Die Einstellungsdatei, ROH. Bewusst nicht durch `parseSettings` -- das
   * legt seine eigenen Vorgaben unter jeden fehlenden Schluessel, und dann
   * liesse sich hier nicht mehr unterscheiden, was jemand GESETZT hat und was
   * nur die Vorgabe ist. Genau diese Unterscheidung braucht das Fenster
   * zweimal: fuer das Rueckstell-Zeichen und fuer die Liste "was bei dir
   * anders ist". Am Bild gesehen (06.08.): der Haken der Kontextwache stand
   * auf aus, weil in dieser dritten Vorgabentabelle noch die alte Antwort
   * stand.
   */
  settings: Record<string, unknown>;
  /**
   * Die Auslieferung. Sie beantwortet im Fenster zwei Fragen: welche Zeile ihr
   * Rueckstell-Zeichen traegt, und was auf der Programm-Seite unter "was bei
   * dir anders ist" steht. Ohne sie muesste die Oberflaeche die Vorgaben ein
   * drittes Mal fuehren.
   */
  vorgaben: Record<string, unknown>;
  ui: UiState;
  machine: string;
  harnesses: HarnessSicht[];
  /** Alle Modelle mit Rolle 'orchestrator'. */
  orchestratorModelle: ModellSicht[];
  /** Alle Modelle mit Rolle 'worker'. */
  workerModelle: ModellSicht[];
  /** Die Fernmaschinen (V10). Ihr Name IST der SSH-Alias. */
  maschinen: string[];
  /** Die Muster der Rueckfrage-Stufe, einzeln abschaltbar. */
  askMuster: AskMuster[];
  /** Die neun Guards mit Zustand, Rolle, Datum und Grund -- aus `wb-state guard list`. */
  guards: GuardZeile[];
  /** Die Kontextwache je Rolle, wirksam -- aus `wb-state wache get --json`. */
  wache: Record<string, WacheRolle>;
  /** Der Deckel der beiden gewaehlten Modelle -- aus `wb-state models cap --json`. */
  deckel: Record<string, DeckelSicht>;
  /** Welche Stufen jeder Harness annimmt -- aus `wb-state models effort --liste`. */
  harnessStufen: Record<string, string[]>;
  /** Die gesetzten Deckel (settings.json, effortCaps): Modell -> {cap, grund, gesetzt}. */
  effortCaps: Record<string, { cap: string; grund: string; gesetzt: string }>;
  ausschluss: { ordner: string[]; muster: string[] };
  protokolle: { label: string; path: string }[];
  pfade: { label: string; wert: string }[];
  /** Je Harness: liegt ein Beleg der Anmeldung vor? Gemessen, nie geraten. */
  anmeldung: Record<string, AnmeldeSicht>;
  /** Je Anbieter: liegt sein Zugang vor? NIE der Zugang selbst, nie sein Ort. */
  anbieter: AnbieterSicht[];
  /** Je Harness der `session`-Block der Registry (SPEC-V4 6.3). */
  chatQuellen: Record<string, ChatQuelle>;
  chatAnsicht: Record<string, boolean>;
  /** Die Vorgabe JE ROLLE (12.08.) -- Orchestrator und Worker getrennt. */
  chatAnsichtVorgabe: ChatVorgabe;
  meldungen: MeldeEinstellung;
  meldeEreignisse: string[];
  meldeWege: string[];
  ollamaEndpunkt: string;
  sprache: string;
  thema: string;
  zustandsfarben: Record<string, string>;
  /** Die Hooks aus ~/.claude/settings.json -- nur Anzeige, siehe hooksInfo.ts. */
  hooks: { name: string; ereignis: string; lehntAb: boolean }[];
}

/** Ob ein Programm angemeldet ist. Drei Antworten, und die dritte ist ehrlich. */
export interface AnmeldeSicht {
  stand: 'ja' | 'nein' | 'unbekannt';
  grund: string;
}

/** Ein Anbieter mit der Frage, ob sein Zugang vorliegt. */
export interface AnbieterSicht {
  id: string;
  label: string;
  art: 'schluessel' | 'abo' | 'lokal';
  stand: 'ja' | 'nein' | 'unbekannt';
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * V11 -- dieselbe Pruefung, die `wb-state` vor einem Spawn anwendet und die
 * `seiten.ts` fuer die uebernommene Seite tut. Sie steht hier ein zweites Mal
 * NICHT als zweite Idee davon, sondern als derselbe Wortlaut; wandert die alte
 * Seite eines Tages, bleibt genau diese Fassung uebrig.
 */
export function harnessBinaerVorhanden(command: string): boolean {
  const expanded = expandHome(command || '');
  if (!expanded) return false;
  if (expanded.includes('/')) {
    try {
      accessSync(expanded, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync('which', [expanded], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function lies(pfad: string): string | undefined {
  try {
    return readFileSync(pfad, 'utf8');
  } catch {
    return undefined;
  }
}

function modellSicht(
  m: RegistryModel,
  registry: ModelsRegistry,
  binaer: Record<string, boolean>,
): ModellSicht {
  const h = findHarness(registry, m.harness);
  const anbieter = findProvider(registry, m.provider);
  const faehig = modelSupportsEffort(m, h, anbieter);
  return {
    id: m.id,
    label: m.label,
    harness: m.harness,
    harnessLabel: h?.label ?? m.harness,
    rollen: [...(m.roles ?? [])],
    efforts: faehig ? allowedEfforts(m) : [],
    effortFaehig: faehig,
    kontext: m.contextWindow ?? 0,
    lokal: anbieter?.kind === 'local',
    startbar: binaer[m.harness] !== false,
    deckelRegistry: m.maxEffort ?? '',
    vorhersage: m.vorhersage,
  };
}

export interface DatenQuellen {
  settingsFile: string;
  /** Die Programm-Konfiguration -- die zweite der beiden Dateien, nur zum Anzeigen. */
  configFile: string;
  modelsFile: string;
  machine: string;
  stateDir: string;
  controlSocket: string;
  /** Aufruf fuer `wb-state`. Die Wache, die Guards und die Deckel kommen von dort. */
  wbStateBin: string;
}

/** Die Kontextwache fuer EINE Rolle, so wie `wb-state wache get --json` sie meldet. */
export interface WacheRolle {
  an: boolean;
  mahnenAb: number;
  /** Aus heisst: sie mahnt weiter, tippt aber kein /compact mehr. */
  eingreifen: boolean;
  /** Nur beim Orchestrator -- nur seine Sitzung kompaktiert die Wache selbst. */
  notbremseAb?: number;
  grund?: string;
}

/** Eine Zeile aus `wb-state guard list`. */
export interface GuardZeile {
  id: string;
  an: boolean;
  rolle: string;
  seit: string;
  grund: string;
}

/** Der Deckel eines Modells, so wie `wb-state models cap <id> --json` ihn meldet. */
export interface DeckelSicht {
  model: string;
  cap: string;
  /** 'einstellung' (ein Mensch hat gesetzt), 'registry' (Auslieferung) oder '-'. */
  quelle: string;
  grund: string;
  registry: string;
  /** Die Stufen, die der HARNESS dieses Modells annimmt. Leer = kennt keine. */
  efforts: string[];
}

/**
 * DER LESEWEG FUER ALLES, WAS DEN WERKZEUGEN GEHOERT.
 *
 * Wache, Guards und Deckel liegen zwar in derselben Einstellungsdatei wie der
 * Rest, aber ihre WIRKSAME Sicht entsteht erst aus Vorgabe, Setzung und
 * Registry zusammen -- und diese Rechnung steht in `wb-state`. Sie hier ein
 * zweites Mal zu schreiben hiesse, zwei Antworten auf dieselbe Frage zu haben,
 * und die zweite wäre irgendwann die falsche. Also wird gefragt, nicht
 * nachgebaut. Ein Aufruf kostet gemessen 40 bis 50 ms.
 *
 * Ein Fehlschlag ist kein Grund, das Fenster leer zu lassen: er liefert die
 * Vorgabe und eine leere Liste, und die Seite sagt dann nichts Falsches.
 */
function werkzeug(bin: string, args: string[]): { ok: boolean; text: string } {
  try {
    const text = execFileSync(bin, args, {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, text };
  } catch {
    return { ok: false, text: '' };
  }
}

const WACHE_VORGABE: Record<string, WacheRolle> = {
  orchestrator: { an: true, mahnenAb: 75, eingreifen: true, notbremseAb: 80 },
  worker: { an: true, mahnenAb: 80, eingreifen: true },
};

/**
 * `vorabText` ist der Ausweg fuer einen Aufrufer, der die Antwort schon hat --
 * die Kontextwache der Chat-Sitzungen holt sie asynchron, weil sie im Takt der
 * Oberflaeche laeuft und 40 ms synchron dort 40 ms Stillstand des ganzen
 * Fensters waeren (chatwache.ts, `WacheOptionen.regel`). Die AUSWERTUNG bleibt
 * damit an dieser einen Stelle: zwei Leser derselben Antwort waeren zwei
 * Wahrheiten ueber die Vorgaben.
 */
export function wacheLesen(bin: string, vorabText?: string): Record<string, WacheRolle> {
  const roh = (vorabText ?? werkzeug(bin, ['wache', 'get', '--json']).text).trim();
  const raus: Record<string, WacheRolle> = {
    orchestrator: { ...WACHE_VORGABE.orchestrator },
    worker: { ...WACHE_VORGABE.worker },
  };
  if (!roh) return raus;
  try {
    const d = JSON.parse(roh) as Record<string, Record<string, unknown>>;
    for (const rolle of ['orchestrator', 'worker']) {
      const e = d[rolle];
      if (!e || typeof e !== 'object') continue;
      const ziel = raus[rolle];
      if (typeof e.an === 'boolean') ziel.an = e.an;
      if (typeof e.mahnenAb === 'number') ziel.mahnenAb = e.mahnenAb;
      if (typeof e.eingreifen === 'boolean') ziel.eingreifen = e.eingreifen;
      if (typeof e.notbremseAb === 'number') ziel.notbremseAb = e.notbremseAb;
      if (typeof e.grund === 'string') ziel.grund = e.grund;
    }
  } catch {
    // Eine unlesbare Antwort heisst "Vorgabe", nie "Fenster kaputt".
  }
  return raus;
}

export function guardsLesen(bin: string): GuardZeile[] {
  const roh = werkzeug(bin, ['guard', 'list']).text;
  const raus: GuardZeile[] = [];
  for (const zeile of roh.split('\n')) {
    if (!zeile.trim()) continue;
    const [id, zustand, rolle, seit, ...rest] = zeile.split('\t');
    if (!id) continue;
    raus.push({
      id,
      an: zustand !== 'aus',
      rolle: rolle || 'alle',
      seit: seit && seit !== '-' ? seit : '',
      grund: rest.join('\t'),
    });
  }
  return raus;
}

export function deckelLesen(bin: string, modellId: string): DeckelSicht | undefined {
  if (!modellId) return undefined;
  const roh = werkzeug(bin, ['models', 'cap', modellId, '--json']).text.trim();
  if (!roh) return undefined;
  try {
    const d = JSON.parse(roh) as Record<string, unknown>;
    return {
      model: String(d.model ?? modellId),
      cap: String(d.cap ?? ''),
      quelle: String(d.quelle ?? '-'),
      grund: String(d.grund ?? ''),
      registry: String(d.registry ?? ''),
      efforts: Array.isArray(d.efforts) ? (d.efforts as unknown[]).map(String) : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Die Stufen JE HARNESS, einmal je Harness erfragt statt einmal je Modell --
 * die Liste haengt seit dem 06.08. am Harness und nicht mehr am einzelnen
 * Modell. Gemerkt wird sie, solange die Registry unveraendert bleibt: sonst
 * kostete jedes Neuzeichnen sechs Aufrufe.
 *
 * GEFRAGT WIRD DER HARNESS, NICHT EIN VERTRETER. Der erste Anlauf schickte
 * irgendein Modell dieses Harness in die Frage -- und traf fuer `pi` den
 * eingebauten Alias `ornith`, den die Registry nicht kennt. Die Antwort war
 * eine Fehlermeldung, die Seite schrieb ehrlich "nicht ermittelt", und die
 * Auskunft war trotzdem falsch: `wb-state models effort <irgendwas> --harness
 * pi --liste` beantwortet dieselbe Frage seit jeher (gemessen 06.08.:
 * low medium high xhigh max). Ein Modellname, den es nicht geben kann, macht
 * die Frage eindeutig -- sonst verengte ein registriertes Modell die Antwort
 * auf SEINE Stufen, und die Spalte behauptet etwas ueber das PROGRAMM.
 */
const KEIN_MODELL = '__harness__';
const stufenMerker = new Map<string, { stand: string; stufen: string[] }>();

export function harnessStufen(
  bin: string,
  modelsFile: string,
  harnesses: string[],
): Record<string, string[]> {
  let stand = '';
  try {
    const s = statSync(modelsFile);
    stand = `${s.mtimeMs}:${s.size}`;
  } catch {
    stand = 'ohne';
  }
  const raus: Record<string, string[]> = {};
  for (const harness of harnesses) {
    const alt = stufenMerker.get(harness);
    if (alt && alt.stand === stand) {
      raus[harness] = alt.stufen;
      continue;
    }
    // Eine Antwort, die es nicht gibt, ist etwas anderes als "kennt keine
    // Stufen" -- am Bild gesehen (06.08.): eine gescheiterte Abfrage stand als
    // Tatsachenbehauptung in der Tabelle. Scheitert der Aufruf, bleibt der
    // Eintrag WEG, und die Seite sagt "nicht ermittelt".
    const antwort = werkzeug(bin, ['models', 'effort', KEIN_MODELL, '--harness', harness, '--liste']);
    if (!antwort.ok) continue;
    const stufen = antwort.text.trim().split(/\s+/).filter(Boolean);
    stufenMerker.set(harness, { stand, stufen });
    raus[harness] = stufen;
  }
  return raus;
}

/** Nur fuer Tests: die gemerkten Stufenlisten vergessen. */
export function stufenMerkerLeeren(): void {
  stufenMerker.clear();
}

// --- Anmeldung, Zugang, Chat-Quelle ----------------------------------------
//
// DREI ANTWORTEN, NICHT ZWEI. Die Modelle-Seite sagte bis zum 11.08. nur, ob
// ein Programm STARTBAR ist -- ob es auch angemeldet ist, merkte man erst am
// gescheiterten Start. Jetzt wird der Beleg geprueft, den die Registry selbst
// fuer den Anbieter nennt (`loginCheckPath`, `apiKeyEnv`). Wo kein Beleg
// hinterlegt ist, lautet die Antwort "nicht pruefbar" und NICHT "nicht
// angemeldet": eine geratene Verneinung schickt einen Menschen auf die Suche
// nach einem Fehler, den es nicht gibt.
//
// WAS HIER NIE PASSIERT: der Wert eines Zugangs wird nicht gelesen, nicht
// gezeigt und nicht protokolliert, und der ORT eines Belegs verlaesst diese
// Datei nicht. Gemeldet wird ausschliesslich "liegt vor" oder "liegt nicht
// vor" -- wo etwas liegt, ist selbst eine Auskunft ueber Geheimnisse.

function belegVorhanden(pfad: string): boolean {
  try {
    accessSync(expandHome(pfad), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type Zugang = { art: 'schluessel' | 'abo' | 'lokal'; stand: 'ja' | 'nein' | 'unbekannt' };

function zugangEines(
  p: { kind?: string; apiKeyEnv?: string; loginCheckPath?: string } | undefined,
  env: NodeJS.ProcessEnv,
): Zugang {
  if (!p) return { art: 'abo', stand: 'unbekannt' };
  if (p.kind === 'local') return { art: 'lokal', stand: 'ja' };
  if (p.loginCheckPath) {
    return { art: 'abo', stand: belegVorhanden(p.loginCheckPath) ? 'ja' : 'nein' };
  }
  if (p.apiKeyEnv) {
    // Nur die ANWESENHEIT der Variablen, nie ihr Inhalt.
    return { art: 'schluessel', stand: (env[p.apiKeyEnv] ?? '').length > 0 ? 'ja' : 'nein' };
  }
  return { art: 'abo', stand: 'unbekannt' };
}

export function anbieterSicht(
  registry: ModelsRegistry,
  env: NodeJS.ProcessEnv = process.env,
): AnbieterSicht[] {
  return (registry.providers ?? []).map((p) => {
    const z = zugangEines(p, env);
    return { id: p.id, label: p.label ?? p.id, art: z.art, stand: z.stand };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Je Harness: liegt fuer mindestens einen seiner Anbieter ein Beleg vor?
 *
 * Ein Harness kann Modelle mehrerer Anbieter fahren (aider etwa openrouter und
 * openai). Ein einziger vorhandener Zugang genuegt, um zu starten -- deshalb
 * gewinnt "ja" ueber "nein", und "nein" ueber "nicht pruefbar".
 */
export function anmeldungSicht(
  registry: ModelsRegistry,
  modelle: RegistryModel[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, AnmeldeSicht> {
  const proHarness = new Map<string, Set<string>>();
  for (const m of modelle) {
    if (!proHarness.has(m.harness)) proHarness.set(m.harness, new Set());
    if (m.provider) proHarness.get(m.harness)?.add(m.provider);
  }
  const raus: Record<string, AnmeldeSicht> = {};
  for (const h of effectiveHarnesses(registry)) {
    const anbieterIds = [...(proHarness.get(h.id) ?? [])];
    let stand: AnmeldeSicht['stand'] = 'unbekannt';
    let lokal = false;
    for (const pid of anbieterIds) {
      const z = zugangEines(findProvider(registry, pid), env);
      if (z.art === 'lokal') lokal = true;
      if (z.stand === 'ja') { stand = 'ja'; break; }
      if (z.stand === 'nein') stand = 'nein';
    }
    raus[h.id] = {
      stand,
      grund: anbieterIds.length === 0
        ? 'Für dieses Programm ist kein Anbieter eingetragen.'
        : lokal && stand === 'ja'
          ? 'Läuft lokal — es gibt nichts, wobei man sich anmelden müsste.'
          : stand === 'ja'
            ? 'Der Beleg der Anmeldung liegt vor.'
            : stand === 'nein'
              ? 'Es liegt kein Beleg vor — ein Start würde an der Anmeldung scheitern.'
              : 'Für diesen Anbieter ist kein Beleg hinterlegt, an dem sich das prüfen ließe.',
    };
  }
  return raus;
}

/**
 * Alles, was das Fenster zeichnet, in EINEM Zug gelesen. Kein zweiter Vorrat
 * und keine Buchfuehrung: Was hier steht, steht so in den Dateien, die auch
 * `wb-state` liest.
 */
export function einstellungsDaten(q: DatenQuellen, ui: UiState): EinstellungsDaten {
  const settings = alleEinstellungen(q.settingsFile);
  const registryRaw = lies(q.modelsFile);
  const registry = parseModelsRegistry(registryRaw);

  const harnessListe = effectiveHarnesses(registry);
  const binaer: Record<string, boolean> = {};
  for (const h of harnessListe) binaer[h.id] = harnessBinaerVorhanden(h.command ?? '');

  // `effectiveModels`, NICHT `registry.models`: Die fuenf Claude-Kennungen und
  // die pi-Aliase sind EINGEBAUT und stehen in keiner Datei -- gemessen am
  // 05.08. fuehrt models.json 81 Eintraege, wirksam sind 89. Der erste Anlauf
  // las die Datei roh und liess damit ausgerechnet Claude aus der Modellwahl
  // verschwinden (am Bild gesehen: die Filterzeile hatte keinen Claude-Chip,
  // obwohl der Orchestrator auf claude-opus-5 steht).
  const alle = effectiveModels(registry).filter((m) => m.enabled !== false);
  const proHarness = new Map<string, number>();
  for (const m of alle) proHarness.set(m.harness, (proHarness.get(m.harness) ?? 0) + 1);

  const harnesses: HarnessSicht[] = harnessListe.map((h) => ({
    id: h.id,
    label: h.label,
    modelle: proHarness.get(h.id) ?? 0,
    binaer: binaer[h.id] === true,
  }));

  const sicht = (rolle: 'orchestrator' | 'worker'): ModellSicht[] => alle
    .filter((m) => (m.roles ?? []).includes(rolle))
    .map((m) => modellSicht(m, registry, binaer))
    .sort((a, b) => a.harness.localeCompare(b.harness) || a.label.localeCompare(b.label));

  // Die zwei Modelle, deren Deckel wirklich jemand ansieht: das der Sitzung
  // und das der Worker. Fuer alle 86 einen eigenen Aufruf abzusetzen waere ein
  // halbe Minute Wartezeit fuer eine Tabelle, die niemand Zeile fuer Zeile liest.
  const gewaehlteModelle = [String(settings.orchestratorModel ?? ''), String(settings.workerModel ?? '')]
    .filter((id, i, alle) => id && alle.indexOf(id) === i);
  const deckel: Record<string, DeckelSicht> = {};
  for (const id of gewaehlteModelle) {
    const d = deckelLesen(q.wbStateBin, id);
    if (d) deckel[id] = d;
  }
  // Gefragt wird je Harness, und zwar der Harness selbst -- siehe
  // `harnessStufen`. Die Liste kommt aus der Harness-Uebersicht, damit auch
  // einer dabei ist, der (noch) kein Modell hat.
  const harnessIds = harnesses.map((h) => h.id);
  const capsRoh = alleEinstellungen(q.settingsFile).effortCaps;
  const effortCaps: Record<string, { cap: string; grund: string; gesetzt: string }> = {};
  if (capsRoh && typeof capsRoh === 'object' && !Array.isArray(capsRoh)) {
    for (const [id, e] of Object.entries(capsRoh as Record<string, unknown>)) {
      if (!e || typeof e !== 'object') continue;
      const o = e as Record<string, unknown>;
      effortCaps[id] = {
        cap: String(o.cap ?? ''),
        grund: String(o.grund ?? ''),
        gesetzt: String(o.gesetzt ?? ''),
      };
    }
  }

  return {
    settings,
    vorgaben: { ...VORGABEN },
    ui,
    machine: q.machine,
    harnesses,
    orchestratorModelle: sicht('orchestrator'),
    workerModelle: sicht('worker'),
    maschinen: maschinenliste(q.settingsFile),
    askMuster: askMuster(q.settingsFile),
    guards: guardsLesen(q.wbStateBin),
    wache: wacheLesen(q.wbStateBin),
    deckel,
    harnessStufen: harnessStufen(q.wbStateBin, q.modelsFile, harnessIds),
    effortCaps,
    ausschluss: { ordner: ausschlussOrdner(q.settingsFile), muster: ausschlussMuster(q.settingsFile) },
    anmeldung: anmeldungSicht(registry, alle),
    anbieter: anbieterSicht(registry),
    chatQuellen: chatQuellen(registryRaw),
    chatAnsicht: chatAnsicht(q.settingsFile),
    chatAnsichtVorgabe: chatAnsichtVorgabe(q.settingsFile),
    meldungen: meldungen(q.settingsFile),
    meldeEreignisse: [...MELDE_EREIGNISSE],
    meldeWege: [...MELDE_WEGE],
    ollamaEndpunkt: ollamaEndpunkt(q.settingsFile),
    sprache: sprache(q.settingsFile),
    thema: thema(q.settingsFile),
    zustandsfarben: zustandsfarben(q.settingsFile),
    // Nur Anzeige, und bewusst so: ein Hook zurueckzuschreiben hiesse, eine
    // fremde Datei mit fuenf weiteren Abschnitten fehlerfrei zu erhalten.
    hooks: parseHooks(lies(claudeSettingsFile())).map((h) => ({
      name: h.command.split('/').pop() ?? h.command,
      ereignis: h.matcher ? `${h.event} · ${h.matcher}` : h.event,
      lehntAb: h.isDenyHook,
    })),
    protokolle: protokollListe(q.settingsFile).map((p) => ({ label: p.label, path: p.path })),
    pfade: [
      { label: 'Einstellungen (geteilt)', wert: q.settingsFile },
      { label: 'Programm-Konfiguration', wert: q.configFile },
      { label: 'Modell-Registry', wert: q.modelsFile },
      { label: 'Oberflächen-Zustand', wert: join(q.stateDir, 'ui.json') },
      { label: 'Steuersocket', wert: q.controlSocket },
    ],
  };
}

// --- Das Fenster -----------------------------------------------------------

/**
 * DIE AUFLAGE AUS DIESEM HAUS, und wie sie hier eingehalten wird.
 *
 * Das Hauptfenster geht nur mit `--show` sichtbar auf; in `main.ts` gibt es
 * genau EINEN `show()`-Aufruf, an der Befehlszeile haengend. Das
 * Einstellungsfenster ist der erste Fall, in dem ein Fenster auf einen KLICK
 * hin erscheinen soll -- der Geist der Regel bleibt: es geht auf, weil ein
 * MENSCH geklickt hat, nie weil ein Test oder ein Agent es anfordert.
 *
 * Durchgesetzt wird das an der ECHTHEIT des Klicks, nicht an einem Namen:
 *
 *   1. Das Fenster entsteht IMMER mit `show: false` (`baue()` unten). Wer es
 *      nur zeichnen oder fotografieren will -- Steuerkanal, Testsuite --,
 *      bekommt genau diesen Weg und nichts weiter; `capturePage()` arbeitet auf
 *      einem nie gezeigten Fenster (dieselbe Grundlage wie shot.ts).
 *   2. `zeige()` ist die EINZIGE Stelle mit `show()`, und sie haengt an einem
 *      IPC-Kanal, den der Renderer nur dann bedient, wenn das Klick-Ereignis
 *      `isTrusted === true` traegt (siehe renderer.ts). Ein `el.click()` aus
 *      `executeJavaScript` -- der Weg JEDES Tests und jedes Steuerbefehls,
 *      `awb-ctl klick einstellungen` eingeschlossen -- erzeugt ein Ereignis mit
 *      `isTrusted === false` und landet deshalb in 1., nicht in 2.
 *   3. Der Steuerkanal hat KEINEN Befehl, der `zeige()` erreicht. Er kann das
 *      Fenster bauen, lesen und fotografieren; sichtbar machen kann er es
 *      nicht.
 *
 * Geprueft wird Punkt 2 in shell/tests/test-app-einstellungen.sh: nach
 * `awb-ctl klick einstellungen` steht das Fenster und ist zu lesen, und
 * `sichtbar` ist false.
 *
 * WORAN MAN ERKENNT, DASS DER show()-ZWEIG ANKOMMT. Kein Test erreicht ihn --
 * ihn zu pruefen hiesse, ein Fenster auf den Bildschirm eines Menschen zu
 * bringen. Deshalb hinterlaesst er eine SPUR: beide Wege schreiben je eine
 * Zeile mit dem Praefix `Einstellungsfenster:` auf stderr des Hauptprozesses
 * (im Terminal, in dem die Anwendung gestartet wurde, sonst in ihrer
 * Protokolldatei). Wer auf das Zahnrad drueckt und kein Fenster sieht, liest
 * dort ab, wo es haengt:
 *
 *   gar keine Zeile           Der Klick kam nie im Hauptprozess an -- zu suchen
 *                             im Renderer (renderer.ts, der Zuhoerer am
 *                             Zahnrad) oder in der Bruecke, nicht hier.
 *   NUR "gebaut, noch nicht   Der Klick kam an, aber als UNECHTES Ereignis
 *   gezeigt"                  (`isTrusted === false`). Dann ruft etwas den
 *                             Knopf programmatisch statt eines Menschen.
 *   "echter Klick, show()"    Der Zweig ist gelaufen. Steht am Ende trotzdem
 *   ... "sichtbar=false"      `sichtbar=false`, liegt es nicht mehr an der
 *                             Verdrahtung, sondern am Fenster selbst
 *                             (Eltern-Beziehung, Bildschirm, Fenstermanager).
 *
 * Ein echter Klick schreibt alle drei Zeilen in dieser Reihenfolge -- gebaut
 * wird vor dem Zeigen. Beim zweiten Klick auf ein stehendes Fenster faellt die
 * mittlere weg, weil nichts neu gebaut wird.
 */
export class Einstellungsfenster {
  private fenster: BrowserWindow | null = null;
  private bereit: Promise<void> | null = null;

  constructor(private readonly eltern: () => BrowserWindow | null) {}

  /** Das Fenster, wenn es existiert -- fuer Foto und Auskunft. */
  aktuell(): BrowserWindow | null {
    return this.fenster && !this.fenster.isDestroyed() ? this.fenster : null;
  }

  /**
   * Bauen und laden, OHNE zu zeigen. Mehrfach aufrufbar: ein bereits stehendes
   * Fenster wird wiederverwendet, damit ein zweiter Klick nicht ein zweites
   * Fenster aufmacht.
   */
  async baue(): Promise<BrowserWindow> {
    const da = this.aktuell();
    if (da && this.bereit) {
      await this.bereit;
      return da;
    }
    const eltern = this.eltern();
    const w = new BrowserWindow({
      width: 1020,
      height: 700,
      // Die Mindestgroesse stammt aus der Vorlage (another service-Kontrollzentrum:
      // 680x520) und ist hier groesser, weil die Modell-Liste eine zweite
      // Spalte neben der Seitenliste braucht.
      minWidth: 820,
      minHeight: 560,
      useContentSize: true,
      // Immer. Sichtbar wird es nur ueber zeige(), siehe Klassendoc.
      show: false,
      // "ein extra Fenster ueber dem anderen": Kind des Hauptfensters, damit es
      // darueber bleibt und mit ihm verschwindet -- aber NICHT modal. Modal
      // spraeche das Hauptfenster tot, und dann koennte man waehrend des
      // Einstellens nicht mehr auf das Terminal sehen, um das es geht.
      parent: eltern ?? undefined,
      modal: false,
      title: 'Agent-Workbench — Einstellungen',
      backgroundColor: '#101216',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'einstellungen-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
    });
    w.setContentSize(1020, 700);
    // Zu ist zu: geschlossen wird es weggeraeumt, der naechste Klick baut neu.
    // Ein verstecktes Fenster stehen zu lassen hiesse, seinen Zustand zwischen
    // zwei Sitzungen mitzuschleppen, ohne dass jemand ihn sieht.
    w.on('closed', () => {
      this.fenster = null;
      this.bereit = null;
    });
    this.fenster = w;
    this.bereit = w.loadFile(join(__dirname, '..', 'einstellungen', 'index.html'));
    await this.bereit;
    // Die Spur (siehe Klassendoc), an EINER Stelle, damit ein spaeterer Weg
    // hierher sie nicht umgehen kann. Der Wortlaut stimmt in BEIDEN Lagen: als
    // einzige Zeile (Skript-Klick, es bleibt dabei) und als mittlere Zeile
    // eines echten Klicks, wo gleich darauf gezeigt wird. "unsichtbar" haette
    // im zweiten Fall das Falsche behauptet.
    process.stderr.write('Einstellungsfenster: gebaut, noch nicht gezeigt\n');
    return w;
  }

  /**
   * DER EINZIGE show()-AUFRUF fuer dieses Fenster. Erreichbar ausschliesslich
   * ueber den IPC-Kanal, den der Renderer nur bei `isTrusted === true` bedient.
   */
  async zeigeNachEchtemKlick(): Promise<void> {
    process.stderr.write('Einstellungsfenster: echter Klick, show()\n');
    const w = await this.baue();
    if (w.isVisible()) w.focus();
    else w.show();
    // NACH dem Aufruf gelesen, nicht vorher angenommen -- genau der
    // Unterschied, an dem man eine gescheiterte Anzeige von einer nicht
    // angekommenen Nachricht unterscheidet.
    process.stderr.write(`Einstellungsfenster: sichtbar=${w.isVisible()}\n`);
  }

  schliesse(): void {
    this.aktuell()?.close();
  }
}
