// Der Editor (Schritt 6 im Plan, A3/4c): Monaco eigenstaendig, eine Tab-Zeile
// ueber der Buehne, ein Schnelloeffner ueber Tastenkuerzel, und der eine
// Befehl, der einen Editor ueberhaupt noetig macht -- eine Auswahl an den
// Orchestrator schicken.
//
// Wie freigaben-view.ts legt dieses Modul seine gesamte Oberflaeche selbst an
// und haengt sie an vorhandene Elemente (#mitte, #buehne) -- index.html bleibt
// unveraendert. renderer.ts bekommt nur den einen Aufruf `initEditorView()`.
import './editor-view.css';
// Monaco kommt seit dem 16.08. ERST BEIM ERSTEN EDITOR-TAB, nicht mehr beim
// Fensterstart. Gemessen wurde der Unterschied kopflos, je fuenf Laeufe: das
// Laden des Renderer-Dokuments bis zur Bereitschaftsmeldung dauerte mit
// eingebautem Monaco 177 ms und ohne 102 ms, der Renderer-Prozess belegte
// 277 MB statt 237 MB -- bezahlt bei JEDEM Start, auch wenn nie ein Editor-Tab
// aufgeht. Der Import unten ist deshalb NUR ein Typ-Import (er erzeugt keinen
// Code); den Laufzeit-Teil holt `monacoLaden()` per dynamischem import().
//
// Derselbe relative Pfad wie in monaco-bootstrap.ts, aus demselben Grund
// (siehe dort): package.json-"exports" und tsc's `moduleResolution: node`
// wollen unterschiedliche Schreibweisen, ein relativer Pfad passt beiden.
import type * as monaco from '../../node_modules/monaco-editor/esm/vs/editor/editor.api.js';

/** Was `import('./monaco-bootstrap')` zurueckgibt: die Monaco-API, um ihre Registrierungen ergaenzt. */
type MonacoModul = typeof import('./monaco-bootstrap');

interface FileEntry { rel: string }
interface EditorBridgeResult<T> { ok: true; value: T }
interface EditorBridgeError { ok: false; error: string }
type EditorResult<T> = EditorBridgeResult<T> | EditorBridgeError;

interface ModelLite {
  sessions: { id: string; dir: string; orchestratorPane: string }[];
  selected: string;
}

export interface ProtokollEintrag { label: string; path: string; exists: boolean; size: number; mtimeMs: number }

/**
 * Eigener Namensraum `awbEditorBridge` statt einer Erweiterung des
 * bestehenden `window.awbBridge` (renderer.ts) -- zwei `interface Window`-
 * Erweiterungen mit demselben Feldnamen muessten sonst exakt gleich sein,
 * sonst bricht der Typecheck. `onModel` kommt trotzdem von der bestehenden
 * Bruecke, aber ungetypt geholt (siehe modellBeobachten unten), damit
 * renderer.ts von hier aus nicht angefasst werden muss.
 *
 * V15/V18/V16 (Schritt 9) haengen hier mit an -- Aktivitaet und Protokolle
 * landen ebenfalls "in der Mitte" (demselben Ort wie eine Projektdatei), und
 * DIESE Erweiterung ist die einzige erlaubte Stelle fuer den Typ von
 * `window.awbEditorBridge`: eine zweite, abweichende Deklaration in
 * aktivitaet-view.ts oder protokolle-view.ts wuerde denselben Konflikt
 * ausloesen, den der Absatz oben beschreibt. Jene Module rufen die Bruecke
 * deshalb nur auf, deklarieren sie aber nicht neu.
 */
interface EditorBridge {
  listFiles(root: string): Promise<EditorResult<FileEntry[]>>;
  readFile(root: string, rel: string): Promise<EditorResult<{ abs: string; content: string }>>;
  writeFile(root: string, rel: string, content: string): Promise<EditorResult<{ bytes: number }>>;
  sendSelection(paneId: string, text: string): Promise<EditorResult<{ sent: boolean }>>;
  aktivitaetRead(pfad: string): Promise<EditorResult<{ typ: string; wer: string; content: string }>>;
  aktivitaetDiff(pfad: string): Promise<EditorResult<{ original: string; modified: string }>>;
  aktivitaetAuftrag(pfad: string): Promise<EditorResult<{ auftrag: string; ergebnis: string }>>;
  protokolleList(): Promise<EditorResult<ProtokollEintrag[]>>;
  protokolleRead(pfad: string): Promise<EditorResult<string>>;
  // SPEC-V4 Abschnitt 6: der Gespraechsstand eines Panes. Er steht hier und
  // nicht in einer zweiten Deklaration -- aus dem Grund, der im Absatz darueber
  // steht. Der Typ der Nutzlast bleibt lose (`unknown`), damit der Renderer die
  // Begriffe der Chat-Ansicht nicht ein zweites Mal fuehren muss; wer sie
  // braucht, holt sie aus app/src/chat/typen.ts.
  chatStand(paneId: string): Promise<EditorResult<unknown>>;
  /** Die Sprache der Oberflaeche (SPEC-V4 Abschnitt 4) -- 'de' oder 'en'. */
  sprache(): Promise<string>;
}

declare global {
  interface Window {
    awbEditorBridge: EditorBridge;
  }
}

/** Dieselbe Modell-Nachricht wie renderer.ts liest -- ohne dessen Typ zu duplizieren. */
function modellBeobachten(fn: (p: unknown) => void): void {
  (window as unknown as { awbBridge: { onModel: (f: (p: unknown) => void) => void } }).awbBridge.onModel(fn);
}

/**
 * Vier Kacheln teilen sich diese eine Tab-Zeile (Schritt 9, V15/V18/V16):
 *   'file'      Projektdatei, editierbar -- der urspruengliche Fall.
 *   'absolute'  Beliebiger Inhalt schreibgeschuetzt (Ergebnisdatei ausserhalb
 *               des Projektordners, Protokoll-Datei) -- derselbe geteilte
 *               Standalone-Editor wie 'file', nur mit readOnly:true.
 *   'diff'      Zwei Fassungen nebeneinander (Monacos eigener
 *               `createDiffEditor`, ein eigener Zeilenvergleich waere
 *               doppelte Arbeit) -- der zweite Klick auf eine Aenderung.
 *   'auftrag'   Auftragstext und Ergebnis nebeneinander, schlichter Text statt
 *               Monaco (die beiden sind keine Fassungen DERSELBEN Datei, ein
 *               Diff daraus waere nur Rauschen) -- der zweite Klick auf ein
 *               Ergebnis.
 * Nicht jedes Feld gilt fuer jede Art; welche, steht bei den Feldern selbst.
 */
type TabKind = 'file' | 'absolute' | 'diff' | 'auftrag';

interface OpenTab {
  kind: TabKind;
  /** Dedup-/Wiederfinden-Schluessel INNERHALB der jeweiligen Art (openXyzTab() macht ihn art-eindeutig). */
  key: string;
  label: string;
  /** 'file'/'absolute': der Pfad, den 'Speichern' bzw. eine Kopfzeile zeigt. Sonst leer. */
  abs: string;
  /** 'file'/'absolute'. */
  model: monaco.editor.ITextModel | null;
  /** 'diff'. */
  original: monaco.editor.ITextModel | null;
  /** 'diff'. */
  modified: monaco.editor.ITextModel | null;
  /** 'auftrag'. */
  auftragText: string;
  /** 'auftrag'. */
  ergebnisText: string;
  viewState: monaco.editor.ICodeEditorViewState | monaco.editor.IDiffEditorViewState | null;
  /** Nur 'file' kann schmutzig werden -- alles andere ist schreibgeschuetzt. */
  dirty: boolean;
  readOnly: boolean;
}

let projectRoot = '';
let orchestratorPane = '';
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
/** Monaco, sobald es geladen ist -- vorher `null`. Jede Laufzeit-Nutzung geht ueber diese Variable. */
let monacoModul: MonacoModul | null = null;
/** Der laufende Ladevorgang, damit zwei gleichzeitige Oeffnen-Wege ihn sich teilen statt ihn zweimal zu starten. */
let monacoLauf: Promise<MonacoModul> | null = null;
const tabs: OpenTab[] = [];
/** -1 heisst: der Terminal-Tab ist gewaehlt, kein Dateitab. */
let activeIndex = -1;
/** Fortlaufend, fuer eindeutige Monaco-URIs bei 'absolute'/'diff' -- diese Modelle werden nie wiederverwendet, jeder Aufruf legt ein frisches an. */
let viewSeq = 0;

let tabRow: HTMLDivElement;
let editorHost: HTMLDivElement;
let monacoMount: HTMLDivElement;
let diffHost: HTMLDivElement;
let diffMonacoMount: HTMLDivElement;
let auftragHost: HTMLDivElement;
let auftragAuftragEl: HTMLPreElement;
let auftragErgebnisEl: HTMLPreElement;
let notizEl: HTMLDivElement;
let buehneEl: HTMLElement | null = null;
let notizUhr: ReturnType<typeof setTimeout> | undefined;

function notiz(text: string): void {
  if (notizUhr !== undefined) clearTimeout(notizUhr);
  notizEl.textContent = text;
  notizEl.classList.toggle('sichtbar', !!text);
  if (text) {
    notizUhr = setTimeout(() => {
      notizEl.classList.remove('sichtbar');
      notizEl.textContent = '';
    }, 4000);
  }
}

function basename(rel: string): string {
  const teile = rel.split('/');
  return teile[teile.length - 1] || rel;
}

function zeichneTabs(): void {
  tabRow.replaceChildren();
  if (!tabs.length) return; // 4c: keine Datei offen -> keine Tab-Zeile.

  const terminal = document.createElement('button');
  terminal.type = 'button';
  terminal.className = `ed-tab${activeIndex === -1 ? ' gewaehlt' : ''}`;
  const tLabel = document.createElement('span');
  tLabel.textContent = 'Terminal';
  terminal.appendChild(tLabel);
  terminal.addEventListener('click', () => activateTab(-1));
  tabRow.appendChild(terminal);

  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ed-tab${i === activeIndex ? ' gewaehlt' : ''}`;
    btn.title = t.abs || t.label;
    const label = document.createElement('span');
    label.textContent = (t.dirty ? '● ' : '') + t.label;
    btn.appendChild(label);
    const schliessen = document.createElement('span');
    schliessen.className = 'ed-tab-x';
    schliessen.textContent = '×';
    schliessen.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(i);
    });
    btn.appendChild(schliessen);
    btn.addEventListener('click', () => activateTab(i));
    tabRow.appendChild(btn);
  });
}

/**
 * Holt Monaco nach -- Programmteil und Stil, beide erst jetzt.
 *
 * Das Buendel liegt als eigene Datei neben dem Renderer (build.mjs baut
 * `monaco-bootstrap.ts` ein zweites Mal als ESM-Stueck, und der Renderer-Bau
 * laesst genau diesen Import aussen vor). Der Stil kommt ueber ein
 * `<link>`-Element statt ueber renderer.css: Monacos CSS haengt an Monacos
 * JS-Modulen, wandert also mit ihnen in das nachgeladene Stueck.
 *
 * Zweimaliges Rufen laedt einmal: der erste Aufruf merkt sich sein
 * Versprechen, jeder weitere wartet darauf.
 */
function monacoLaden(): Promise<MonacoModul> {
  if (monacoModul) return Promise.resolve(monacoModul);
  if (monacoLauf) return monacoLauf;
  monacoLauf = Promise.all([monacoStilLaden(), import('./monaco-bootstrap')])
    .then(([, m]) => {
      monacoModul = m;
      return m;
    })
    .catch((e) => {
      // Ein gescheiterter Ladevorgang darf sich nicht festsetzen: die naechste
      // Anfrage soll es erneut versuchen duerfen statt auf ewig dieselbe
      // Ablehnung zu bekommen.
      monacoLauf = null;
      throw e;
    });
  return monacoLauf;
}

/** Monacos Stilblatt nachladen. Ein Fehlschlag haelt den Editor nicht auf -- schmucklos ist besser als gar nicht. */
function monacoStilLaden(): Promise<void> {
  return new Promise<void>((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'monaco-bootstrap.css';
    link.addEventListener('load', () => resolve());
    link.addEventListener('error', () => resolve());
    document.head.appendChild(link);
  });
}

/** Monaco im Zugriff -- oder eine lesbare Ablehnung statt eines Zugriffs auf `null`. */
function monacoJetzt(): MonacoModul {
  if (!monacoModul) throw new Error('Monaco ist noch nicht geladen (monacoLaden() gehoert davor)');
  return monacoModul;
}

function ensureEditor(): monaco.editor.IStandaloneCodeEditor {
  if (editor) return editor;
  const mo = monacoJetzt();
  editor = mo.editor.create(monacoMount, {
    automaticLayout: false,
    theme: 'vs-dark',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    minimap: { enabled: false },
  });
  editor.addAction({
    id: 'awb.sendSelectionToOrchestrator',
    label: 'An Orchestrator senden',
    contextMenuGroupId: 'awb',
    contextMenuOrder: 1,
    keybindings: [mo.KeyMod.CtrlCmd | mo.KeyMod.Shift | mo.KeyCode.Enter],
    run: () => {
      void sendSelection();
    },
  });
  editor.addAction({
    id: 'awb.saveFile',
    label: 'Datei speichern',
    keybindings: [mo.KeyMod.CtrlCmd | mo.KeyCode.KeyS],
    run: () => {
      void saveActive();
    },
  });
  editor.onDidChangeModelContent(() => {
    const t = tabs[activeIndex];
    if (t && t.kind === 'file' && !t.dirty) {
      t.dirty = true;
      zeichneTabs();
    }
  });
  return editor;
}

/** Dieselbe Bauart wie ensureEditor(): EIN geteilter Diff-Editor, die Modelle wechseln, nicht die Instanz. */
function ensureDiffEditor(): monaco.editor.IStandaloneDiffEditor {
  if (diffEditor) return diffEditor;
  diffEditor = monacoJetzt().editor.createDiffEditor(diffMonacoMount, {
    automaticLayout: false,
    theme: 'vs-dark',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    readOnly: true,
    renderSideBySide: true,
  });
  return diffEditor;
}

function activateTab(index: number): void {
  const vorher = tabs[activeIndex];
  if (activeIndex >= 0 && vorher) {
    if ((vorher.kind === 'file' || vorher.kind === 'absolute') && editor) vorher.viewState = editor.saveViewState();
    else if (vorher.kind === 'diff' && diffEditor) vorher.viewState = diffEditor.saveViewState();
  }
  activeIndex = index;
  if (index === -1) {
    editorHost.hidden = true;
    diffHost.hidden = true;
    auftragHost.style.display = 'none';
    if (buehneEl) buehneEl.style.display = '';
    zeichneTabs();
    return;
  }
  const t = tabs[index];
  if (buehneEl) buehneEl.style.display = 'none';
  editorHost.hidden = t.kind !== 'file' && t.kind !== 'absolute';
  diffHost.hidden = t.kind !== 'diff';
  auftragHost.style.display = t.kind === 'auftrag' ? 'flex' : 'none';

  if (t.kind === 'file' || t.kind === 'absolute') {
    const ed = ensureEditor();
    ed.updateOptions({ readOnly: t.readOnly });
    ed.setModel(t.model);
    if (t.viewState) ed.restoreViewState(t.viewState as monaco.editor.ICodeEditorViewState);
    ed.layout();
    ed.focus();
  } else if (t.kind === 'diff') {
    const ed = ensureDiffEditor();
    ed.setModel({ original: t.original!, modified: t.modified! });
    if (t.viewState) ed.restoreViewState(t.viewState as monaco.editor.IDiffEditorViewState);
    ed.layout();
  } else {
    auftragAuftragEl.textContent = t.auftragText || '(kein aufgezeichneter Auftragstext)';
    auftragErgebnisEl.textContent = t.ergebnisText;
  }
  zeichneTabs();
}

function closeTab(index: number): void {
  const t = tabs[index];
  if (!t) return;
  t.model?.dispose();
  t.original?.dispose();
  t.modified?.dispose();
  tabs.splice(index, 1);
  if (activeIndex === index) {
    activateTab(tabs.length ? Math.min(index, tabs.length - 1) : -1);
  } else if (activeIndex > index) {
    activeIndex -= 1;
    zeichneTabs();
  } else {
    zeichneTabs();
  }
}

async function openFile(rel: string): Promise<boolean> {
  if (!projectRoot) {
    notiz('keine Session gewaehlt -- kein Projektordner');
    return false;
  }
  const bestehend = tabs.findIndex((t) => t.kind === 'file' && t.key === rel);
  if (bestehend >= 0) {
    activateTab(bestehend);
    return true;
  }
  // Sofortige Rueckmeldung, BEVOR die Antwort da ist (Befund 9, 15.08.): ohne
  // sie wirkt die App bei einer langsamen IPC-Antwort eingefroren -- kein
  // Unterschied zwischen "arbeitet" und "haengt".
  notiz(`lädt: ${rel}`);
  const [res, mo] = await Promise.all([window.awbEditorBridge.readFile(projectRoot, rel), monacoLaden()]);
  if (!res.ok) {
    notiz(res.error);
    return false;
  }
  const uri = mo.Uri.file(res.value.abs);
  const model = mo.editor.getModel(uri) ?? mo.editor.createModel(res.value.content, undefined, uri);
  tabs.push({
    kind: 'file', key: rel, label: basename(rel), abs: res.value.abs, model,
    original: null, modified: null, auftragText: '', ergebnisText: '',
    viewState: null, dirty: false, readOnly: false,
  });
  activateTab(tabs.length - 1);
  notiz(`geöffnet: ${rel}`);
  return true;
}

/**
 * Ein schreibgeschuetzter Inhalt "in der Mitte" -- der erste Klick auf einen
 * Aktivitaets- oder Protokoll-Eintrag (V15/V16/V18). `key` ist innerhalb
 * dieser Art eindeutig (der Aufrufer waehlt ihn, meist der Pfad selbst); ein
 * zweiter Aufruf mit demselben `key` aktiviert nur den bestehenden Tab, statt
 * einen zweiten anzulegen.
 */
export async function openAbsoluteTab(key: string, label: string, abs: string, content: string): Promise<void> {
  const bestehend = tabs.findIndex((t) => t.kind === 'absolute' && t.key === key);
  if (bestehend >= 0) {
    activateTab(bestehend);
    return;
  }
  const mo = await monacoLaden();
  const uri = mo.Uri.from({ scheme: 'awb-view', path: `/${viewSeq++}` });
  const model = mo.editor.createModel(content, undefined, uri);
  tabs.push({
    kind: 'absolute', key, label, abs, model,
    original: null, modified: null, auftragText: '', ergebnisText: '',
    viewState: null, dirty: false, readOnly: true,
  });
  activateTab(tabs.length - 1);
}

/** Der zweite Klick auf eine Aenderung (V15): zwei Fassungen, Monacos eigener Diff-Editor stellt sie dar. */
export async function openDiffTab(key: string, label: string, original: string, modified: string): Promise<void> {
  const bestehend = tabs.findIndex((t) => t.kind === 'diff' && t.key === key);
  if (bestehend >= 0) {
    activateTab(bestehend);
    return;
  }
  const mo = await monacoLaden();
  const origModel = mo.editor.createModel(original, undefined, mo.Uri.from({ scheme: 'awb-view', path: `/${viewSeq++}` }));
  const modModel = mo.editor.createModel(modified, undefined, mo.Uri.from({ scheme: 'awb-view', path: `/${viewSeq++}` }));
  tabs.push({
    kind: 'diff', key, label, abs: '', model: null,
    original: origModel, modified: modModel, auftragText: '', ergebnisText: '',
    viewState: null, dirty: false, readOnly: true,
  });
  activateTab(tabs.length - 1);
}

/** Der zweite Klick auf ein Ergebnis (V18): Auftrag und Ergebnis nebeneinander, schlichter Text. */
export function openAuftragTab(key: string, label: string, auftragText: string, ergebnisText: string): void {
  const bestehend = tabs.findIndex((t) => t.kind === 'auftrag' && t.key === key);
  if (bestehend >= 0) {
    activateTab(bestehend);
    return;
  }
  tabs.push({
    kind: 'auftrag', key, label, abs: '', model: null,
    original: null, modified: null, auftragText, ergebnisText,
    viewState: null, dirty: false, readOnly: true,
  });
  activateTab(tabs.length - 1);
}

async function saveActive(): Promise<boolean> {
  const t = tabs[activeIndex];
  if (!t || t.kind !== 'file') {
    notiz('kein Datei-Tab gewaehlt');
    return false;
  }
  const content = t.model!.getValue();
  // Dieselbe sofortige Rueckmeldung wie in openFile() -- siehe dort (Befund 9).
  notiz(`lädt: ${t.key}`);
  const res = await window.awbEditorBridge.writeFile(projectRoot, t.key, content);
  if (!res.ok) {
    notiz(`Speichern fehlgeschlagen: ${res.error}`);
    return false;
  }
  t.dirty = false;
  zeichneTabs();
  notiz(`gespeichert: ${t.key}`);
  return true;
}

/**
 * Der eine Befehl, der den Editor ueberhaupt rechtfertigt (4c): die
 * markierte Auswahl, mitsamt Datei und Zeilennummern, landet im Eingabefeld
 * des Orchestrator-Panes -- ohne dass jemand kopiert. Gilt fuer 'file' UND
 * 'absolute' (beide teilen sich den einen Standalone-Editor); 'diff' und
 * 'auftrag' haben keine Auswahl in DIESEM Sinn und bleiben aussen vor.
 */
async function sendSelection(): Promise<boolean> {
  const t = tabs[activeIndex];
  if (!t || (t.kind !== 'file' && t.kind !== 'absolute') || !editor) {
    notiz('kein Datei-Tab gewaehlt');
    return false;
  }
  const sel = editor.getSelection();
  if (!sel || sel.isEmpty()) {
    notiz('keine Auswahl markiert');
    return false;
  }
  if (!orchestratorPane) {
    notiz('kein Orchestrator-Pane fuer diese Session bekannt');
    return false;
  }
  const text = t.model!.getValueInRange(sel);
  const zeilen = sel.startLineNumber === sel.endLineNumber
    ? `${sel.startLineNumber}`
    : `${sel.startLineNumber}-${sel.endLineNumber}`;
  // 'file': t.key ist der projektrelative Pfad (kurz, lesbar, wie vor Schritt 9).
  // 'absolute': dort gibt es keine Projektwurzel, also der volle Pfad (t.abs).
  const pfadAnzeige = t.kind === 'file' ? t.key : t.abs;
  const nachricht = `${pfadAnzeige}:${zeilen}\n${text}`;
  const res = await window.awbEditorBridge.sendSelection(orchestratorPane, nachricht);
  if (!res.ok) {
    notiz(`Senden fehlgeschlagen: ${res.error}`);
    return false;
  }
  notiz('Auswahl an den Orchestrator geschickt');
  return true;
}

// --- Schnelloeffner (4c.1/4c): eine Datei ueber ihren Namen finden --------

let qoPanel: HTMLDivElement | null = null;
let qoInput: HTMLInputElement | null = null;
let qoList: HTMLDivElement | null = null;
let qoMatches: FileEntry[] = [];
let qoSelected = 0;
let alleDateien: FileEntry[] = [];
/** Die offene Entprellung der Eingabe (siehe filterSpaeter). */
let qoFilterUhr: ReturnType<typeof setTimeout> | undefined;
/** Wie oft die Liste seit dem Fensterstart wirklich neu gebaut wurde -- die Zahl, an der die Entprellung messbar ist. */
let qoFilterLaeufe = 0;

/**
 * Entprellte Eingabe (Befund 9, 15.08.): Der Schnelloeffner filterte je
 * TASTENDRUCK die ganze Dateiliste und baute die Trefferliste neu. Bei einem
 * grossen Projektordner ist das je Anschlag ein voller Durchgang durch alle
 * Pfade plus 50 neue DOM-Knoten. Jetzt gewinnt die letzte Taste innerhalb von
 * 60 ms: wer tippt, sieht die Liste einmal am Ende der Tastenfolge.
 *
 * Wer den Stand SOFORT braucht (Eingabetaste, Pfeiltasten), ruft
 * `filterJetzt()` -- eine offene Entprellung darf nie zwischen Tippen und
 * Auswaehlen stehen.
 */
function filterSpaeter(query: string): void {
  if (qoFilterUhr !== undefined) clearTimeout(qoFilterUhr);
  qoFilterUhr = setTimeout(() => {
    qoFilterUhr = undefined;
    filterQuickOpen(query);
  }, 60);
}

/** Eine offene Entprellung sofort einloesen; ohne offene Entprellung passiert nichts. */
function filterJetzt(): void {
  if (qoFilterUhr === undefined) return;
  clearTimeout(qoFilterUhr);
  qoFilterUhr = undefined;
  filterQuickOpen(qoInput?.value ?? '');
}

/**
 * Unscharfe Suche: alle Zeichen der Anfrage muessen der Reihe nach im
 * Zielpfad vorkommen. Je frueher der erste Treffer und je weniger Luecken
 * dazwischen, desto kleiner die Zahl -- sortiert wird aufsteigend.
 */
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return target.length;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let luecke = 0;
  let ersterTreffer = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return null;
    if (ersterTreffer < 0) ersterTreffer = idx;
    luecke += idx - ti;
    ti = idx + 1;
  }
  return ersterTreffer * 1000 + luecke * 10 + target.length;
}

function ensureQuickOpen(): void {
  if (qoPanel) return;
  qoPanel = document.createElement('div');
  qoPanel.id = 'ed-qo';
  qoPanel.className = 'ed-qo';
  qoPanel.innerHTML = `
    <div class="ed-qo-box">
      <input type="text" class="ed-qo-input" placeholder="Datei ueber ihren Namen finden…" />
      <div class="ed-qo-list"></div>
    </div>`;
  document.body.appendChild(qoPanel);
  qoInput = qoPanel.querySelector('.ed-qo-input');
  qoList = qoPanel.querySelector('.ed-qo-list');
  qoInput!.addEventListener('input', () => filterSpaeter(qoInput!.value));
  qoInput!.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuickOpen();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      filterJetzt();
      qoSelected = Math.min(qoSelected + 1, qoMatches.length - 1);
      renderQoList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      filterJetzt();
      qoSelected = Math.max(qoSelected - 1, 0);
      renderQoList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filterJetzt();
      void chooseQuickOpen();
    }
  });
  qoPanel.addEventListener('mousedown', (e) => {
    if (e.target === qoPanel) closeQuickOpen();
  });
}

async function openQuickOpen(): Promise<void> {
  if (!projectRoot) {
    notiz('keine Session gewaehlt -- kein Projektordner');
    return;
  }
  ensureQuickOpen();
  const res = await window.awbEditorBridge.listFiles(projectRoot);
  alleDateien = res.ok ? res.value : [];
  qoPanel!.classList.add('offen');
  qoInput!.value = '';
  qoInput!.focus();
  filterQuickOpen('');
}

function closeQuickOpen(): void {
  if (qoFilterUhr !== undefined) {
    clearTimeout(qoFilterUhr);
    qoFilterUhr = undefined;
  }
  qoPanel?.classList.remove('offen');
  editor?.focus();
}

function filterQuickOpen(query: string): void {
  qoFilterLaeufe += 1;
  const q = query.trim();
  qoMatches = alleDateien
    .map((f) => ({ f, s: fuzzyScore(q, f.rel) }))
    .filter((x): x is { f: FileEntry; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s)
    .slice(0, 50)
    .map((x) => x.f);
  qoSelected = 0;
  renderQoList();
}

function renderQoList(): void {
  if (!qoList) return;
  qoList.replaceChildren();
  if (!qoMatches.length) {
    const leer = document.createElement('div');
    leer.className = 'ed-qo-leer';
    leer.textContent = 'kein Treffer';
    qoList.appendChild(leer);
    return;
  }
  qoMatches.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = `ed-qo-item${i === qoSelected ? ' gewaehlt' : ''}`;
    el.textContent = f.rel;
    el.addEventListener('click', () => {
      qoSelected = i;
      void chooseQuickOpen();
    });
    qoList!.appendChild(el);
  });
}

async function chooseQuickOpen(): Promise<boolean> {
  const f = qoMatches[qoSelected];
  if (!f) return false;
  closeQuickOpen();
  return openFile(f.rel);
}

function istOffen(): boolean {
  return !!qoPanel?.classList.contains('offen');
}

function globalKeydown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return;
  if (e.key.toLowerCase() === 'p' && !e.shiftKey) {
    e.preventDefault();
    void openQuickOpen();
  }
}

export function initEditorView(): void {
  const mitte = document.getElementById('mitte');
  buehneEl = document.getElementById('buehne');
  if (!mitte || !buehneEl) return;

  tabRow = document.createElement('div');
  tabRow.id = 'ed-tabs';
  tabRow.className = 'ed-tabs';
  mitte.insertBefore(tabRow, buehneEl);

  editorHost = document.createElement('div');
  editorHost.id = 'ed-host';
  editorHost.className = 'ed-host';
  editorHost.hidden = true;
  monacoMount = document.createElement('div');
  monacoMount.className = 'ed-monaco-mount';
  editorHost.appendChild(monacoMount);
  notizEl = document.createElement('div');
  notizEl.className = 'ed-notiz';
  editorHost.appendChild(notizEl);
  mitte.appendChild(editorHost);

  diffHost = document.createElement('div');
  diffHost.id = 'ed-diff-host';
  diffHost.className = 'ed-host';
  diffHost.hidden = true;
  diffMonacoMount = document.createElement('div');
  diffMonacoMount.className = 'ed-monaco-mount';
  diffHost.appendChild(diffMonacoMount);
  mitte.appendChild(diffHost);

  auftragHost = document.createElement('div');
  auftragHost.id = 'ed-auftrag-host';
  auftragHost.className = 'ed-auftrag-host';
  auftragHost.style.display = 'none';
  auftragHost.innerHTML = `
    <div class="ed-auftrag-spalte">
      <div class="ed-auftrag-kopf">Auftrag</div>
      <pre class="ed-auftrag-text"></pre>
    </div>
    <div class="ed-auftrag-spalte">
      <div class="ed-auftrag-kopf">Ergebnis</div>
      <pre class="ed-auftrag-text"></pre>
    </div>`;
  const auftragSpalten = auftragHost.querySelectorAll('.ed-auftrag-text');
  auftragAuftragEl = auftragSpalten[0] as HTMLPreElement;
  auftragErgebnisEl = auftragSpalten[1] as HTMLPreElement;
  mitte.appendChild(auftragHost);

  zeichneTabs();

  modellBeobachten((p) => {
    const m = p as ModelLite;
    const s = m.sessions.find((x) => x.id === m.selected);
    projectRoot = s?.dir ?? '';
    orchestratorPane = s?.orchestratorPane ?? '';
  });

  window.addEventListener('resize', () => {
    const t = tabs[activeIndex];
    if (!t) return;
    if (t.kind === 'file' || t.kind === 'absolute') editor?.layout();
    else if (t.kind === 'diff') diffEditor?.layout();
  });

  document.addEventListener('keydown', globalKeydown);

  // Testhaken (E3 im Plan: derselbe Steuersocket, ueber den auch main.ts
  // faehrt) -- eigener Namensraum, damit renderer.ts und sein window.__awb
  // unangetastet bleiben.
  (window as unknown as { __awbEditor: unknown }).__awbEditor = {
    state(): unknown {
      return {
        activeIndex,
        projectRoot,
        orchestratorPane,
        tabs: tabs.map((t) => ({ key: t.key, kind: t.kind, dirty: t.dirty })),
        quickOpenOffen: istOffen(),
        quickOpenMatches: qoMatches.map((f) => f.rel),
        // Ist Monaco schon geladen? Vor dem ersten Editor-Tab lautet die
        // Antwort `false` -- genau das ist die Zusage hinter dem
        // nachgeladenen Buendel (siehe monacoLaden).
        monacoGeladen: !!monacoModul,
        // Wie oft die Trefferliste des Schnelloeffners wirklich neu gebaut
        // wurde -- daran misst der Test die Entprellung.
        qoFilterLaeufe,
        // Fuer den Test: welche der vier Kacheln zeigt die Mitte gerade?
        editorSichtbar: !editorHost.hidden,
        diffSichtbar: !diffHost.hidden,
        auftragSichtbar: auftragHost.style.display !== 'none',
        buehneSichtbar: buehneEl?.style.display !== 'none',
        tabZeileSichtbar: tabRow.children.length > 0,
      };
    },
    openFile: (rel: string) => openFile(rel),
    // V15/V16/V18 (Schritt 9), fuer den Belegtest ohne einen echten
    // Aktivitaets- oder Protokoll-Eintrag herstellen zu muessen: dieselben
    // drei Funktionen, die aktivitaet-view.ts und protokolle-view.ts rufen.
    openAbsoluteTab: async (arg: { key: string; label: string; abs: string; content: string }): Promise<boolean> => {
      await openAbsoluteTab(arg.key, arg.label, arg.abs, arg.content);
      return true;
    },
    openDiffTab: async (arg: { key: string; label: string; original: string; modified: string }): Promise<boolean> => {
      await openDiffTab(arg.key, arg.label, arg.original, arg.modified);
      return true;
    },
    openAuftragTab: (arg: { key: string; label: string; auftrag: string; ergebnis: string }): boolean => {
      openAuftragTab(arg.key, arg.label, arg.auftrag, arg.ergebnis);
      return true;
    },
    activateTab: (index: number): boolean => {
      activateTab(index);
      return true;
    },
    setValue: (arg: { key?: string; text: string }): boolean => {
      const t = arg.key ? tabs.find((x) => x.key === arg.key) : tabs[activeIndex];
      if (!t || !t.model) return false;
      t.model.setValue(arg.text);
      return true;
    },
    selectLines: (arg: { start: number; end: number }): boolean => {
      const t = tabs[activeIndex];
      if (!editor || !t || !t.model) return false;
      const endCol = t.model.getLineMaxColumn(arg.end);
      editor.setSelection(new (monacoJetzt().Selection)(arg.start, 1, arg.end, endCol));
      return true;
    },
    save: () => saveActive(),
    sendSelection: () => sendSelection(),
    quickOpen: async (query: string): Promise<string[]> => {
      await openQuickOpen();
      filterQuickOpen(query);
      qoInput!.value = query;
      return qoMatches.map((f) => f.rel);
    },
    // Die Entprellung des Suchfeldes, in EINEM Zug messbar: mehrere
    // Tastendruecke nacheinander, dann der Blick auf den Zaehler sofort und
    // noch einmal, nachdem die Frist abgelaufen ist. Der Weg geht ueber das
    // echte 'input'-Ereignis des Feldes -- geprueft wird die Verdrahtung, nicht
    // eine Nachstellung.
    quickOpenTippen: async (arg: { texte: string[] }): Promise<{ vorher: number; sofort: number; nachher: number }> => {
      const vorher = qoFilterLaeufe;
      for (const text of arg.texte) {
        qoInput!.value = text;
        qoInput!.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const sofort = qoFilterLaeufe;
      await new Promise((r) => setTimeout(r, 200));
      return { vorher, sofort, nachher: qoFilterLaeufe };
    },
    quickOpenChoose: async (): Promise<boolean> => {
      if (!qoMatches.length) return false;
      await chooseQuickOpen();
      return true;
    },
    quickOpenClose: () => closeQuickOpen(),
  };
}
