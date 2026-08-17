// V14: Session nach Absturz wiederherstellen. `wb-code <ordner> --resume
// <id>` ist der von Hand zusammengesuchte Weg, der hier zum Knopf wird --
// `wb-code` selbst macht die ganze Arbeit (Session anlegen, Claude mit
// --resume starten, Zustandsdatei schreiben); diese Datei baut nur den
// Aufruf zusammen und entscheidet, ob er ueberhaupt erlaubt ist.
//
// EINZIGE Nebenwirkung im ganzen Auftrag: das hier startet wirklich etwas.
// Deshalb die harte Regel in `darfWiederherstellen` unten -- nur eine
// SessionInfo im Zustand 'stopped' (kein Pane mehr, Maschine erreichbar) darf
// ueberhaupt einen Aufruf erzeugen. main.ts prueft das ein zweites Mal gegen
// den JEWEILS AKTUELLEN Sessionstand, unmittelbar vor dem Spawnen -- ein
// Klick, der Sekunden vorher entstand, darf keine inzwischen wieder laufende
// Session anfassen.
import type { SessionInfo } from './sessions';
import { fernAufruf } from './pfad';

export interface ReviveCommand {
  bin: string;
  args: string[];
  /** Was mit der Unterhaltung passiert -- fortgesetzt oder von vorn. */
  conversation: 'resumed' | 'fresh';
  /** Ein Satz dazu, fuer den Menschen. Nie leer. */
  conversationReason: string;
}

/**
 * Der `resume`-Block eines Harness aus der Registry (~/.claude/workbench/models.json),
 * so wie er dort steht. Seit dem 2026-08-06 entscheidet ER, ob eine Session mit ihrer
 * Unterhaltung zurueckkommt -- vorher stand diese Entscheidung als `claudeSessionId`
 * fest verdrahtet hier im Code, und damit konnte genau ein Harness fortsetzen.
 * Dieselben Regeln liest shell/wb-revive fuer den Pane-Fall.
 */
export interface HarnessResume {
  /** Kennung des Harness, nur fuer die Meldung. */
  id: string;
  /** Die Flags, die das Fortsetzen ausloesen. Fehlt der Eintrag: kann nicht fortsetzen. */
  args?: string[];
  /** Was genommen wird, wenn {resumeId} nicht aufloesbar ist. */
  fallbackArgs?: string[];
  /**
   * Baut `wb-code` fuer diesen Harness eine eigene Startzeile? Steht als
   * `builtin` an jedem Harness der Registry und trifft dort genau die zwei
   * Zweige, die `shell/wb-code` selbst kennt (claude, pi); alle anderen laufen
   * ueber `wb-harness-run`. Gelesen statt geraten -- der Name des Harness
   * steht damit an keiner Verzweigung.
   */
  builtin?: boolean;
}

/**
 * Der Harness, den `wb-code` ohne `--harness` startet (shell/wb-code:142,
 * `[ -n "$HARNESS" ] || HARNESS="claude"`). Fuer ihn schickt der Knopf weder
 * `--harness` noch `--model` mit: die Wirkung soll dieselbe bleiben wie vor
 * dem 06.08., und ueber das Modell entscheidet dort weiterhin die Einstellung.
 */
const WB_CODE_VORGABE_HARNESS = 'claude';

/**
 * Traegt dieser Harness eine Unterhaltungs-Kennung? Nur dann ist die gemerkte Kennung
 * ueberhaupt etwas wert; ein Harness mit blossem `--continue` setzt fort, was zuletzt
 * lief, und braucht sie nicht.
 */
export function nimmtSitzungskennung(h: HarnessResume | undefined): boolean {
  return !!h?.args?.some((a) => a.includes('{resumeId}'));
}

/**
 * Darf diese Session wiederhergestellt werden? NUR wenn sie wirklich weg ist:
 * kein Pane mehr (state 'stopped'), ihre Maschine antwortet aber, und sie hat
 * ein Verzeichnis zum Hineinstarten. 'attention'/'running'/'unreachable' sind
 * ausdruecklich ausgeschlossen -- eine laufende Session bekommt hier NIE einen
 * zweiten Claude-Prozess, und gegen eine unerreichbare Maschine liesse sich
 * ohnehin nichts start en.
 *
 * NACHGEPRUEFT AM 07.08., WEIL DIE SPERRE ZU BREIT AUSSAH: bei ausgefallenem
 * tmux werden ALLE hiesigen Sitzungen 'unreachable', also sperrt der Knopf
 * auch fuer die wirklich toten -- wer in dieser Lage sitzt, kann ueber das
 * Fenster gar nichts mehr starten. Die Frage war, ob sich die beiden Faelle
 * dann noch trennen lassen. SIE LASSEN SICH NICHT, und deshalb bleibt es
 * genau so:
 *
 *   1. Es gibt keine zweite Quelle. Ob eine Sitzung lebt, steht ausschliesslich
 *      in tmux; die Zustandsdatei merkt sich Ordner, tmux-Name, Harness,
 *      Modell, Worker und Unterhaltungs-Kennung, aber KEINE Prozesskennung
 *      (nachgesehen in ~/.claude/workbench/sessions/*.json). Es gibt also
 *      nichts, wogegen sich „lebt sie noch?" ohne tmux pruefen liesse -- und
 *      ein Prozessbaum, in dem nach passenden Kommandozeilen gesucht wird,
 *      waere Raten, nicht Nachsehen.
 *   2. Selbst wenn der Knopf oeffnete, koennte er nichts starten. Er ruft
 *      `wb-code`, und `wb-code` legt seine Sitzung mit tmux an. Ohne tmux
 *      scheitert der Start -- er scheiterte nur spaeter und lauter.
 *   3. Der zweite Grund fuer 'unreachable' ist die unzerlegbare Antwort. Dann
 *      LAEUFT tmux und antwortet sogar; nur wir verstehen es nicht. Das ist
 *      der gefaehrlichste Fall von allen: die Sitzung laeuft mit hoher
 *      Wahrscheinlichkeit, und ein Start gaebe ihr einen zweiten Orchestrator.
 *   4. Bei einer Fernmaschine, die nicht antwortet, fuehrt der Start ohnehin
 *      ueber genau die SSH-Verbindung, die eben nicht zustande kam.
 *
 * In allen vier Faellen ist die Sperre entweder die vorsichtige oder die
 * einzige moegliche Wahl. Was der Mensch stattdessen bekommt, ist der GRUND:
 * das Sitzungsfenster schreibt ihn an jede Zeile (sitzungsfenster.ts,
 * `grundFuerMaschine`), und der Weg heraus fuehrt ueber das Terminal --
 * `wb-code <ordner>` tut dort dasselbe, was dieser Knopf tun wuerde, und sagt
 * dabei selbst, woran es liegt.
 */
export function darfWiederherstellen(s: Pick<SessionInfo, 'state' | 'dir'>): boolean {
  return s.state === 'stopped' && !!s.dir;
}

/**
 * WANN EINE WIEDERHERSTELLUNG AN EINER RUECKFRAGE HAENGEN BLEIBT -- die beiden
 * Grenzen, GEMESSEN am 11.08. und nicht geschaetzt.
 *
 * Der Befund: Nach der Kernel-Panik vom 10.08. wurde die Sitzung im Ordner
 * ~/AI wiederhergestellt, und der Pane blieb an „Resume from summary or full
 * session" stehen. Eine Wiederherstellung, die auf eine Antwort wartet, ist
 * keine. Die Regel dafuer steht in der CLI selbst (claude 2.1.226, Funktion
 * `JGm`, im Klartext im Programm nachgelesen):
 *
 *     let r = age(process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES, 70),
 *         n = age(process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD, 1e5),
 *         i = <Zeitstempel der letzten user/assistant-Nachricht, aelter als 1 min>;
 *     let s = (Date.now() - Date.parse(i)) / 60000;
 *     if (s < r) return null;      // zu jung -- keine Frage
 *     let a = t(e);                // geschaetzte Tokens der Unterhaltung
 *     if (a < n) return null;      // zu klein -- keine Frage
 *
 * Gefragt wird also nur, wenn BEIDES zutrifft: die letzte Nachricht ist
 * mindestens 70 Minuten alt UND die Unterhaltung traegt mindestens 100.000
 * Tokens. Nicht die Dateigroesse, und keine der beiden Grenzen allein. Beide
 * lassen sich ueber die genannten Umgebungsvariablen verschieben, und wer im
 * Pane „Don't ask me again" waehlt, schaltet die Frage dauerhaft ab.
 *
 * WAS DAS FUER DEN ABEND DES 10.08. HEISST, nachgerechnet an den Transcripten:
 * Fortgesetzt wurde 6e1c68fd (82 MB), dessen letzte echte Nachricht vom
 * 2026-08-09T08:20:00Z stammt -- beim Klick um 21:46Z also 37 Stunden alt.
 * Beide Grenzen weit ueberschritten, die Frage kam. Die Unterhaltung, die
 * eigentlich gemeint war (0c65dfdd), hatte ihre letzte Nachricht um 21:00:41Z,
 * war beim Klick 46 Minuten alt und haette die Frage NICHT ausgeloest. Die
 * richtige Kennung ist damit nicht nur die richtige Unterhaltung, sie ist im
 * Absturzfall auch die, die durchlaeuft: wer zeitnah wiederherstellt, bleibt
 * unter den 70 Minuten.
 *
 * DESHALB WIRD HIER NICHTS UMGESTELLT, SONDERN GESAGT. Die Frage abzuschalten
 * hiesse, ungefragt eine sehr grosse Unterhaltung voll zu laden -- das kostet
 * echtes Kontingent, und die CLI warnt aus genau diesem Grund. Also bleibt sie
 * stehen, und das Fenster nennt sie vorher beim Namen: wer den Knopf drueckt,
 * weiss dann, dass er den Pane noch einmal anschauen muss.
 */
export const FORTSETZEN_FRAGE_MINUTEN = 70;
export const FORTSETZEN_FRAGE_TOKENS = 100_000;

/**
 * Wird die CLI beim Fortsetzen zurueckfragen? Beide Grenzen zugleich, wie oben.
 * Unbekannte Werte (-1/0) heissen NEIN -- eine Warnung, die auf einer nicht
 * gemessenen Zahl steht, waere schlechter als keine.
 */
export function fragtBeimFortsetzen(alterMinuten: number, tokens: number): boolean {
  return alterMinuten >= FORTSETZEN_FRAGE_MINUTEN && tokens >= FORTSETZEN_FRAGE_TOKENS;
}

/** `90` -> `1h 30m`, wie die CLI es in ihrer eigenen Frage schreibt. */
function alterInWorten(minuten: number): string {
  const m = Math.floor(minuten);
  if (m < 60) return `${m} min`;
  const stunden = Math.floor(m / 60);
  if (stunden < 24) return m % 60 === 0 ? `${stunden} h` : `${stunden} h ${m % 60} min`;
  const tage = Math.floor(stunden / 24);
  return stunden % 24 === 0 ? `${tage} d` : `${tage} d ${stunden % 24} h`;
}

/**
 * Der Satz fuer den Menschen, leer solange keine Frage zu erwarten ist. Er
 * haengt an der Vorschau des Fortsetzen-Knopfes (main.ts, `mitReviveVorschau`).
 *
 * Die beiden Zahlen sind die des Programms, nicht die der CLI: das Alter kommt
 * aus der mtime des Transcripts (fuer eine tote Sitzung schreibt niemand mehr
 * hinein, also ist das ihre letzte Bewegung), die Tokenzahl aus dem letzten
 * Nutzungseintrag -- dieselbe Rechnung wie die Kontextanzeige. Die CLI schaetzt
 * ihre Tokenzahl selbst und kann knapp daneben liegen; dicht an der Grenze kann
 * dieser Hinweis deshalb fehlen, obwohl die Frage kommt. Er verspricht darum
 * „sehr wahrscheinlich" und nicht „sicher".
 */
export function fortsetzenHinweis(alterMinuten: number, tokens: number): string {
  if (!fragtBeimFortsetzen(alterMinuten, tokens)) return '';
  return `Achtung: die Unterhaltung ist ${alterInWorten(alterMinuten)} alt und traegt `
    + `${Math.round(tokens / 1000)}k Tokens — Claude fragt beim Fortsetzen sehr wahrscheinlich `
    + 'zuerst „Resume from summary or full session". Der Pane steht dann an dieser Frage, '
    + 'bis Du sie dort beantwortest.';
}

/**
 * Baut den Aufruf, spawnt aber nichts -- main.ts fuehrt ihn aus. Lokal ist es
 * `wb-code`, fern (V10) exakt derselbe Aufruf ueber `ssh <maschine>`, weil
 * `wb-code` auf beiden Maschinen liegt (dasselbe Skript-Set, siehe
 * shell/wb-sync-setup) und dort dieselbe Zustandsdatei liest/schreibt, die
 * ohnehin schon ueber SSH abgerufen wird.
 */
export function reviveCommand(
  s: Pick<SessionInfo, 'dir' | 'machine' | 'claudeSessionId' | 'sessionKey' | 'name' | 'harness' | 'model'>,
  localMachine: string,
  wbCodeBin: string,
  harness?: HarnessResume,
): ReviveCommand {
  const args = [s.dir];

  // Der Knopf ruft `wb-code`, nicht die CLI des Harness. Deshalb wird der
  // `resume`-Block der Registry hier UEBERSETZT statt weitergereicht: er sagt,
  // OB eine Unterhaltung zurueckkommt, und `wb-code` weiss, WIE. Gemessen am
  // 06.08. gegen die Argumentpruefung von `wb-code` (nicht existierendes
  // Verzeichnis als Wand, es startet dabei nichts):
  //
  //   --resume <id>                 angenommen  (nur im claude-Zweig, Zeile 149/166)
  //   --harness <id> --model <id>   angenommen
  //   --continue                    "unbekannte Option '--continue'", exit 1
  //   resume --last                 "unbekannte Option '--last'",     exit 1
  //   --restore-chat-history        "unbekannte Option ...",          exit 1
  //
  // Ein durchgereichter Fortsetzen-Block haette also fuer JEDEN Harness ausser
  // claude eine Zeile ergeben, die gar nichts startet. Die Flags der Registry
  // gehoeren dem Pane-Weg (shell/wb-revive), der die Startzeile der CLI selbst
  // baut; hier gehoert die Entscheidung wb-code.
  let conversation: ReviveCommand['conversation'] = 'fresh';
  let conversationReason: string;

  // Harness und Modell so mitgeben, wie die Session sie gefuehrt hat -- sonst
  // brachte `wb-code` sie als claude zurueck, ganz gleich womit sie lief. Fuer
  // den Vorgabe-Harness bleibt die Zeile unveraendert (siehe Konstante oben).
  const eigenerHarness = !!s.harness && s.harness !== WB_CODE_VORGABE_HARNESS;
  const harnessFlags = (): void => {
    if (!eigenerHarness) return;
    args.push('--harness', s.harness);
    if (s.model) args.push('--model', s.model);
  };

  if (harness === undefined) {
    // Ohne `harness` bleibt alles wie vor dem 2026-08-06: die gemerkte Kennung
    // wird angehaengt, wenn es eine gibt.
    if (s.claudeSessionId) {
      args.push('--resume', s.claudeSessionId);
      conversation = 'resumed';
      conversationReason = 'Unterhaltung wird fortgesetzt.';
    } else {
      conversationReason = 'Keine Unterhaltung gemerkt — die Session faengt neu an.';
    }
  } else if (!harness.args || harness.args.length === 0) {
    harnessFlags();
    conversationReason = `Harness '${harness.id}' kann nicht fortsetzen — die Session faengt neu an.`;
  } else if (!harness.builtin) {
    // Registry-Weg: der Pane baut seine Startzeile ueber `wb-harness-run` neu,
    // und dorthin reicht `wb-code` kein Fortsetzen-Flag durch. Gesagt statt
    // vorgetaeuscht -- derselbe Befund wie im Pane-Weg (test-harness-wiederbelebung.sh).
    // Diese Verzweigung steht VOR der Kennungsfrage: ein registrierter Harness
    // mit `{resumeId}` bekaeme sonst ein `--resume`, und das nimmt `wb-code`
    // ausserhalb des claude-Zweigs nicht an (gemessen, Zeile 166).
    harnessFlags();
    conversationReason =
      `Harness '${harness.id}' startet ueber wb-harness-run; dorthin reicht wb-code kein ` +
      'Fortsetzen-Flag durch — die Session faengt neu an.';
  } else if (nimmtSitzungskennung(harness) && !eigenerHarness) {
    // Der Vorgabe-Harness, und sein Block verlangt eine Kennung: genau der Fall,
    // fuer den `wb-code --resume <id>` gebaut ist.
    if (s.claudeSessionId) {
      args.push('--resume', s.claudeSessionId);
      conversation = 'resumed';
      conversationReason = 'Unterhaltung wird fortgesetzt.';
    } else {
      // `fallbackArgs` (`--continue`) hilft hier NICHT: `wb-code` lehnt das Flag
      // ab, und sein eigener Ersatzweg (`recorded_conversation`) liest genau die
      // Kennung, die hier schon fehlt -- dieselbe Zustandsdatei, dasselbe Feld.
      conversationReason = 'Keine Unterhaltung gemerkt — die Session faengt neu an.';
    }
  } else {
    // Eingebauter Zweig, der ohne Kennung fortsetzt: `wb-code` haengt das Flag
    // selbst an (pi bekommt `--continue`, sobald ein Sitzungsordner liegt). Von
    // aussen nimmt es dafuer keins an -- deshalb geht hier nur `--harness`/`--model` mit.
    harnessFlags();
    conversation = 'resumed';
    conversationReason =
      `Harness '${harness.id}' nimmt die zuletzt aktive Unterhaltung dieses Ordners selbst wieder auf.`;
  }

  if (s.name) args.push('--name', s.name);
  if (s.sessionKey) args.push('--key', s.sessionKey);
  if (s.machine === localMachine) return { bin: wbCodeBin, args, conversation, conversationReason };
  // EIN Weg auf die andere Maschine, fuer alle vier Griffe (09.08.). Die Zeile
  // stand bis heute hier von Hand zusammengesetzt, ohne Kodierung und ohne
  // Zeitgrenze -- warum beides dazugehoert, steht bei `fernAufruf` in pfad.ts.
  const [bin, ...rest] = fernAufruf(s.machine, ['wb-code', ...args]);
  return { bin, args: rest, conversation, conversationReason };
}
