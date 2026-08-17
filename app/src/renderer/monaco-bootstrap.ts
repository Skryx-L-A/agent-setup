// Bindet Monaco EIGENSTAENDIG ein (E2 im Plan): Editor-Kern, reine
// Monarch-Hervorhebung fuer alle Basissprachen, und die Kernfunktionen
// Hervorhebung/Suche/Ersetzen/mehrere Cursor.
//
// Bewusst NICHT importiert: die vier arbeiterbasierten Sprachdienste unter
// monaco-editor/esm/vs/languages/features/{css,html,json,typescript} --
// jeder davon startet einen Web Worker und liefert Fehlerdiagnose,
// Vervollstaendigung und Sprachserver-Funktionen. A3 verlangt "Datei
// oeffnen, lesen, aendern", ausdruecklich keinen Sprachserver und keine
// Fehlerdiagnose im Editor. Ohne diesen Import entsteht nie ein Worker --
// geprueft per grep ueber monaco-editor/esm nach "new Worker(" und
// "createWebWorker": beides steckt ausschliesslich in den vier
// ausgelassenen Dateien und in generischer Infrastruktur, die nur AUF
// ANFRAGE dieser vier laeuft.
//
// Alle Pfade unten sind RELATIV in node_modules hinein, nicht ueber den
// Paketnamen: monaco-editor's package.json-"exports" bildet jeden
// Unterpfad ohne eigene .js-Endung blind auf ".js" ab (gemessen: einer
// .css-Datei wurde so ein zweites ".js" angehaengt, unauffindbar), und
// `tsc` mit `moduleResolution: node` versteht "exports" ueberhaupt nicht
// und braucht den vollen Plattenpfad. Ein relativer Pfad ist der eine Weg,
// den Node-Resolution UND esbuild gleich verstehen -- ES-Modul-Importe
// nehmen ohnehin nur ein Zeichenkettenliteral, keine zusammengesetzte
// Konstante.
import '../../node_modules/monaco-editor/esm/vs/editor/editor.api.js';
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';

// Reine Monarch-Tokenizer fuer alle Basissprachen (kein Worker, kein Provider).
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/register.all.js';

// Editor-Kern: das Widget selbst und die Grundbefehle (Cursor, Auswahl).
import '../../node_modules/monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js';
import '../../node_modules/monaco-editor/esm/vs/editor/browser/coreCommands.js';

// Zwischenablage, Kontextmenue (traegt auch unseren eigenen Menuepunkt).
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';

// Suche und Ersetzen (A3/4c: "Suche, Ersetzen").
import '../../node_modules/monaco-editor/esm/vs/features/find/register.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';

// Mehrere Cursor (A3/4c) und die Operationen, auf denen sie aufbauen.
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/caretOperations/browser/transpose.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';

// Sprung zur Zeile (A3/4c) ueber die eingebaute Schnellzugriff-Leiste.
import '../../node_modules/monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import '../../node_modules/monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import '../../node_modules/monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';

// Uebliche Bearbeitungshilfen, keine davon braucht einen Sprachdienst.
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/fontZoom/browser/fontZoom.js';
import '../../node_modules/monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';

// Seit dem 16.08. ist diese Datei zugleich das NACHGELADENE Stueck: Sie wird
// nicht mehr vom Renderer mitgebuendelt, sondern liegt als eigene ESM-Datei
// neben ihm (build.mjs) und kommt erst beim ersten Editor-Tab
// (editor-view.ts, `monacoLaden`). Damit ein Aufrufer nach dem Nachladen die
// API in der Hand hat, gibt diese Datei sie weiter -- ein zweiter Import von
// `editor.api.js` in editor-view.ts wuerde Monaco sonst doch wieder in das
// Renderer-Buendel ziehen und den ganzen Umbau aufheben.
export * from '../../node_modules/monaco-editor/esm/vs/editor/editor.api.js';
