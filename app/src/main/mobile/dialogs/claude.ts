import { createHash } from 'node:crypto';
import { validatePromptAnswerBody } from '../../../mobile-shared/validierung';
import type { JsonValue, Prompt } from '../../../mobile-shared/vertrag';
import { MobileAuthError } from '../auth/auth';
import type { MobileRouteHandlers, MobileRouteRequest } from '../http/server';
import type { MobileDialogSession } from './opencode';

/**
 * Claude Code pane adapter (Paket 6b).
 *
 * Only what was measured against the explicitly listed Claude Code versions in
 * isolated tmux servers can be answered; see the versioned measurement.json
 * files under app/test/fixtures/mobile-dialogs/. Everything else fails closed:
 *   - AskUserQuestion, one single-select question, 2..4 options
 *   - AskUserQuestion, two single-select questions with 2 options each, answered
 *     one visible step at a time (each step is its own atomic key sequence)
 *   - Bash and Edit permission dialogs with exactly Yes / <persistent> / No, and (measured
 *     2.1.296) Bash with Yes / <persistent> / Yes, and switch to auto mode / No
 * 2.1.296 was measured in the fullscreen renderer (`"tui": "fullscreen"`) and inline.
 * 2.1.299 was measured in the fullscreen renderer; every dialog drew as in 2.1.296.
 * Not offered although measurable: the free-text row "Type something.", "Chat about
 * this", multi-select, the middle permission option (it claims a persistent or
 * session-wide grant whose scope was not proven) and the auto-mode option (it changes
 * the permission mode of the whole session).
 */

export const CLAUDE_MEASURED_VERSIONS = Object.freeze(['2.1.277', '2.1.278', '2.1.296', '2.1.299'] as const);
type ClaudeMeasuredVersion = (typeof CLAUDE_MEASURED_VERSIONS)[number];
const ACCEPTED_VERSION_STRINGS = new Map<string, ClaudeMeasuredVersion>(
  CLAUDE_MEASURED_VERSIONS.flatMap((version) => [[version, version], [`${version} (Claude Code)`, version]]),
);
const MAX_PANE_BYTES = 64 * 1024;
const MAX_WINDOW_LINES = 120;
const MAX_DIALOG_TEXT = 3000;
const MAX_LABEL = 400;

export const CLAUDE_DIALOG_CAPABILITIES = Object.freeze({ 'prompt.answer.claude': true });

export type ClaudeDialogKey = 'Enter' | 'Escape' | 'Down';

export interface ClaudePaneSnapshot {
  /** Exact CLI version of the process running in the pane, as `claude --version` prints it. */
  readonly version: string;
  /** tmux pane id of the orchestrator pane, e.g. `%12`. */
  readonly pane: string;
  /** Fresh `tmux capture-pane -p` (or `-p -e`) of the visible pane; ANSI is stripped here. */
  readonly text: string;
}

export interface ClaudeKeyCall {
  readonly session: MobileDialogSession;
  readonly pane: string;
  /** Adapter-derived, taken from the measured table. Must go out in ONE `mobil-taste` call. */
  readonly keys: readonly ClaudeDialogKey[];
  readonly request: MobileRouteRequest;
}

export interface ClaudeDialogsForMobile {
  readonly localMachine: string;
  fresh(): Promise<readonly MobileDialogSession[]> | readonly MobileDialogSession[];
  /** Paket 10: freshly resolved orchestrator pane plus the CLI version of the process in it. */
  claudePane(session: MobileDialogSession): Promise<ClaudePaneSnapshot | null> | ClaudePaneSnapshot | null;
  /** Paket 10: one `wb-pane-write mobil-taste` call authorising exactly `call.keys`. */
  sendKeys(call: ClaudeKeyCall): Promise<void>;
  readonly now?: () => number;
}

type DialogKind = 'ask_single' | 'ask_step' | 'ask_review' | 'permission_bash' | 'permission_edit';

interface ParsedOption {
  readonly index: number;
  readonly label: string;
}

interface ParsedDialog {
  readonly kind: DialogKind;
  readonly tabs: readonly string[];
  readonly heading: string;
  readonly text: string;
  readonly options: readonly ParsedOption[];
  readonly selectedIndex: number;
}

type Parsed =
  | { readonly state: 'none' }
  | { readonly state: 'unsupported'; readonly reason: string }
  | { readonly state: 'dialog'; readonly dialog: ParsedDialog };

/**
 * Measured key sequences, written out literally per dialog kind and option count.
 * Never derived from the visible option index; the test compares this table with
 * every measurement.json.
 */
const MEASURED_KEYS: Readonly<Record<string, Readonly<Record<string, readonly ClaudeDialogKey[]>>>> = Object.freeze({
  'ask_single:2': { choice_1: ['Enter'], choice_2: ['Down', 'Enter'], abort: ['Escape'] },
  'ask_single:3': { choice_1: ['Enter'], choice_2: ['Down', 'Enter'], choice_3: ['Down', 'Down', 'Enter'], abort: ['Escape'] },
  'ask_single:4': {
    choice_1: ['Enter'],
    choice_2: ['Down', 'Enter'],
    choice_3: ['Down', 'Down', 'Enter'],
    choice_4: ['Down', 'Down', 'Down', 'Enter'],
    abort: ['Escape'],
  },
  'ask_step:2': { choice_1: ['Enter'], choice_2: ['Down', 'Enter'], abort: ['Escape'] },
  'ask_review:2': { submit: ['Enter'], cancel: ['Down', 'Enter'] },
  'permission_bash:3': { allow_once: ['Enter'], reject: ['Down', 'Down', 'Enter'], abort: ['Escape'] },
  'permission_bash:4': { allow_once: ['Enter'], reject: ['Down', 'Down', 'Down', 'Enter'], abort: ['Escape'] },
  'permission_edit:3': { allow_once: ['Enter'], reject: ['Down', 'Down', 'Enter'], abort: ['Escape'] },
});

export const CLAUDE_MEASURED_KEY_TABLE = MEASURED_KEYS;

function fail(code: 'bad_request' | 'stale_target' | 'capability_unavailable' | 'prompt_changed', message: string): never {
  throw new MobileAuthError(code, message);
}

/** A Claude dialog is on screen but not in a measured shape. GET reports it; an answer treats it as a changed prompt. */
class UnmeasuredClaudeDialog extends MobileAuthError {
  constructor(message: string) {
    super('capability_unavailable', message);
  }
}

// CSI, OSC and two-byte escape sequences.
const ANSI = /\u001b\[[0-9;?:]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const PLAIN_RULE = /^─{20,}$/;
// 2.1.29x writes the session name (`claude -n <name>`) into the rule: `────…──── Studium ─`.
// The name may contain spaces and non-ASCII characters, but no rule characters.
const NAMED_RULE = /^─{20,} [^─\s](?:[^─]*[^─\s])? ─{1,4}$/;
const RULE = { test: (line: string): boolean => PLAIN_RULE.test(line) || NAMED_RULE.test(line) };
const DASHED_RULE = /^╌{20,}$/;
const ASK_FOOTER = /^Enter to select · (?:↑\/↓|Tab\/Arrow keys) to navigate · Esc to cancel$/;
const PERMISSION_FOOTER = /^ Esc to cancel · Tab to amend$/;
const ASK_OPTION = /^(❯ |  )([1-9])\. (\S.*)$/;
const PERMISSION_OPTION = /^ (?:❯| ) ([1-9])\. (\S.*)$/;
const TAB_BAR = /^←  (.+)  ✔ Submit  →$/;
const SINGLE_TAB = /^ ☐ (\S.*)$/;
const MULTI_SELECT_LABEL = /^\[[ x✔✓]\] /;
// 2.1.296 Bash permission: third row "Yes, and switch to auto mode · auto mode handles these prompts for you"
// and a tip line above the command that points at it.
const AUTO_MODE_LABEL = 'Yes, and switch to auto mode';
const PERMISSION_TIP = /^ Tip: auto mode handles these prompts for you/;

function windowLines(text: string): string[] {
  const lines = text.replace(ANSI, '').replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-MAX_WINDOW_LINES);
}

function withoutBlank(lines: readonly string[]): string[] {
  return lines.filter((line) => line !== '');
}

function tabsOf(inner: string): string[] | null {
  const tabs = inner.split(/  (?=[☐☒] )/);
  return tabs.every((tab) => /^[☐☒] \S/.test(tab)) ? tabs : null;
}

function unsupported(reason: string): Parsed {
  return { state: 'unsupported', reason };
}

function tooLong(...parts: readonly string[]): boolean {
  return parts.join('\n').length > MAX_DIALOG_TEXT;
}

interface Row {
  readonly number: number;
  readonly label: string;
  readonly cursor: boolean;
}

/**
 * Groups `row` lines with their `continuation` lines. Numbers must run 1..n, exactly one row
 * carries the cursor, and nothing else may appear (no leading or foreign lines).
 */
function optionGroups(lines: readonly string[], row: (line: string) => Row | null, continuation: RegExp): { groups: { number: number; label: string }[]; cursor: number } | null {
  const groups: { number: number; label: string; cursor: boolean }[] = [];
  for (const line of lines) {
    const parsed = row(line);
    if (parsed) {
      groups.push({ ...parsed });
    } else if (groups.length > 0 && continuation.test(line)) {
      groups[groups.length - 1].label = `${groups[groups.length - 1].label} — ${line.trim()}`;
    } else {
      return null;
    }
  }
  const cursors = groups.filter((group) => group.cursor);
  if (groups.length === 0 || cursors.length !== 1 || !groups.every((group, index) => group.number === index + 1)) return null;
  return { groups: groups.map(({ number, label }) => ({ number, label })), cursor: cursors[0].number };
}

function askRow(line: string): Row | null {
  const match = ASK_OPTION.exec(line);
  return match ? { number: Number(match[2]), label: match[3].trim(), cursor: match[1] === '❯ ' } : null;
}

function permissionRow(line: string): Row | null {
  const match = PERMISSION_OPTION.exec(line);
  return match ? { number: Number(match[1]), label: match[2].trim(), cursor: line.startsWith(' ❯') } : null;
}

function parseAskQuestion(lines: readonly string[], footerIndex: number): Parsed {
  // Region above the footer: R1, tab line, question, option rows, "Type something.", R2, "Chat about this".
  let cursor = footerIndex - 1;
  while (cursor >= 0 && lines[cursor] === '') cursor -= 1;
  const chat = /^  ([1-9])\. Chat about this$/.exec(lines[cursor] ?? '');
  if (!chat) return unsupported('the last dialog row is not "Chat about this"');
  const chatRowNumber = Number(chat[1]);
  cursor -= 1;
  while (cursor >= 0 && lines[cursor] === '') cursor -= 1;
  if (!RULE.test(lines[cursor] ?? '')) return unsupported('the rule above "Chat about this" is missing');
  const lowerRule = cursor;
  let upperRule = -1;
  for (let index = lowerRule - 1; index >= 0 && lowerRule - index <= 60; index -= 1) {
    if (RULE.test(lines[index])) {
      upperRule = index;
      break;
    }
  }
  if (upperRule < 0) return unsupported('the top rule of the dialog was not found');
  const region = withoutBlank(lines.slice(upperRule + 1, lowerRule));
  if (region.length < 4) return unsupported('the dialog region is too short');

  let tabs: string[];
  let kind: DialogKind;
  const bar = TAB_BAR.exec(region[0]);
  const single = SINGLE_TAB.exec(region[0]);
  if (bar) {
    const parsedTabs = tabsOf(bar[1]);
    if (!parsedTabs || parsedTabs.length < 2) return unsupported('a one-tab bar belongs to a multi-select dialog');
    tabs = parsedTabs;
    kind = 'ask_step';
  } else if (single) {
    tabs = [`☐ ${single[1]}`];
    kind = 'ask_single';
  } else {
    return unsupported('the tab line is not a measured form');
  }

  const rest = region.slice(1);
  const firstRow = rest.findIndex((line) => ASK_OPTION.test(line));
  if (firstRow < 1) return unsupported('no question text before the options');
  const question = rest.slice(0, firstRow).map((line) => line.trim()).join('\n');
  const rows = optionGroups(rest.slice(firstRow), askRow, /^ {3,}\S/);
  if (!rows) return unsupported('the option rows are not in the measured layout');
  if (rows.groups.length < 3) return unsupported('fewer than two user options');
  const freeText = rows.groups[rows.groups.length - 1];
  const userOptions = rows.groups.slice(0, -1);
  if (freeText.label !== 'Type something.') return unsupported('the free-text row is not "Type something."');
  if (chatRowNumber !== rows.groups.length + 1) return unsupported('"Chat about this" is not the row after the free-text row');
  if (userOptions.length > 4) return unsupported('more than four user options');
  if (userOptions.some((option) => MULTI_SELECT_LABEL.test(option.label))) return unsupported('multi-select dialogs are not measured for atomic input');
  if (rows.cursor !== 1) return unsupported('the cursor is not on the first option, which is the only measured start position');
  if (question.length === 0 || question.length > 1000 || userOptions.some((option) => option.label.length > MAX_LABEL)) return unsupported('question or option text is out of bounds');
  const optionTexts = userOptions.map((option) => `${option.number}. ${option.label}`);
  if (tooLong(tabs.join(' '), question, ...optionTexts)) return unsupported('the dialog is larger than the display limit');
  return {
    state: 'dialog',
    dialog: {
      kind,
      tabs,
      heading: tabs.join('  '),
      text: question,
      options: userOptions.map((option) => ({ index: option.number, label: option.label })),
      selectedIndex: rows.cursor,
    },
  };
}

function parseAskReview(lines: readonly string[]): Parsed {
  const region = withoutBlank(lines);
  const count = region.length;
  if (region[count - 1] !== '  2. Cancel' || region[count - 2] !== '❯ 1. Submit answers' || region[count - 3] !== 'Ready to submit your answers?') {
    return unsupported('the review rows are not in the measured layout');
  }
  const reviewIndex = region.lastIndexOf('Review your answers', count - 4);
  if (reviewIndex < 2) return unsupported('the review heading was not found');
  const bar = TAB_BAR.exec(region[reviewIndex - 1]);
  const tabs = bar ? tabsOf(bar[1]) : null;
  if (!tabs || tabs.length < 2 || tabs.some((tab) => !tab.startsWith('☒ '))) return unsupported('the review is not complete or not in the measured layout');
  if (!RULE.test(region[reviewIndex - 2])) return unsupported('the top rule of the review was not found');
  const items: string[] = [];
  for (const line of region.slice(reviewIndex + 1, count - 3)) {
    if (/^ ● \S/.test(line)) items.push(line.trim());
    else if (items.length > 0 && /^ {3,}\S/.test(line)) items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
    else return unsupported('a review line is not in the measured layout');
  }
  if (items.length !== tabs.length || !items.every((item) => /^● .+ → .+$/.test(item))) {
    return unsupported('the review answers do not match the tabs');
  }
  const text = ['Review your answers', ...items, 'Ready to submit your answers?'].join('\n');
  if (tooLong(text)) return unsupported('the review is larger than the display limit');
  return {
    state: 'dialog',
    dialog: {
      kind: 'ask_review',
      tabs,
      heading: tabs.join('  '),
      text,
      options: [{ index: 1, label: 'Submit answers' }, { index: 2, label: 'Cancel' }],
      selectedIndex: 1,
    },
  };
}

function parsePermission(lines: readonly string[], footerIndex: number): Parsed {
  const above = lines.slice(0, footerIndex);
  const clean = withoutBlank(above);
  let questionIndex = -1;
  for (let index = clean.length - 1; index >= 0 && clean.length - index <= 30; index -= 1) {
    if (/^ Do you want to (?:proceed|make this edit to .+)\?$/.test(clean[index])) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return unsupported('the permission question was not found');
  const question = clean[questionIndex].trim();
  const rows = optionGroups(clean.slice(questionIndex + 1), permissionRow, /^ {4,}\S/);
  if (!rows) return unsupported('the permission rows are not in the measured layout');

  const kind: DialogKind | null = question === 'Do you want to proceed?' ? 'permission_bash' : question.startsWith('Do you want to make this edit to ') ? 'permission_edit' : null;
  if (!kind) return unsupported('unmeasured permission dialog');
  const headerText = kind === 'permission_bash' ? ' Bash command' : ' Edit file';
  let headerIndex = -1;
  for (let index = questionIndex - 1; index >= 1 && questionIndex - index <= 60; index -= 1) {
    if (clean[index] === headerText && RULE.test(clean[index - 1])) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) return unsupported('the permission header was not found');

  const count = rows.groups.length;
  const autoMode = count === 4 && kind === 'permission_bash' && rows.groups[2].label.startsWith(AUTO_MODE_LABEL);
  if (count !== 3 && !autoMode) return unsupported('only the three-option and the Bash auto-mode permission layouts are measured');
  if (rows.groups[0].label !== 'Yes' || rows.groups[count - 1].label !== 'No' || !rows.groups[1].label.startsWith('Yes, ')) {
    return unsupported('the permission options are not Yes / Yes, ... / No');
  }
  if (rows.cursor !== 1) return unsupported('the cursor is not on the first option, which is the only measured start position');
  const body = clean.slice(headerIndex, questionIndex).filter((line) => !DASHED_RULE.test(line) && !PERMISSION_TIP.test(line)).map((line) => line.trim());
  const text = [...body, question].join('\n');
  if (rows.groups.some((option) => option.label.length > MAX_LABEL) || tooLong(text)) return unsupported('the permission dialog is larger than the display limit');
  return {
    state: 'dialog',
    dialog: {
      kind,
      tabs: [],
      heading: '',
      text,
      options: rows.groups.map((option) => ({ index: option.number, label: option.label })),
      selectedIndex: rows.cursor,
    },
  };
}

function isFooterLine(line: string): boolean {
  return ASK_FOOTER.test(line) || PERMISSION_FOOTER.test(line) || /^(?:❯ |  )2\. Cancel$/.test(line)
    || /(?:^| )Esc to cancel(?: ·|$)/.test(line) || /^ ?Enter to (?:select|confirm) ·/.test(line);
}

const FOOTER_SEARCH_LINES = 8;
const INPUT_ROW = /^❯(?:[ \u00a0]|$)/;
const OPTION_ROW = /^❯\s*[0-9]+[.)]\s/;

/** Lines below the last visible input box (rule, `❯` row that is no option row, rule), or null. */
function belowInputBox(lines: readonly string[]): readonly string[] | null {
  for (let index = lines.length - 1; index >= 2; index -= 1) {
    const row = lines[index - 1];
    if (RULE.test(lines[index]) && INPUT_ROW.test(row) && !OPTION_ROW.test(row) && RULE.test(lines[index - 2])) {
      return lines.slice(index + 1);
    }
  }
  return null;
}

export function parseClaudeDialog(text: string): Parsed {
  if (text.length > MAX_PANE_BYTES) return unsupported('the pane capture is oversized');
  const all = windowLines(text);
  if (all.length === 0) return { state: 'none' };
  // The fullscreen renderer (measured 2.1.296) can draw a rule and blank rows below the dialog
  // footer. They are dropped only when a line above them is a dialog footer.
  let end = all.length - 1;
  while (end > 0 && (all[end] === '' || RULE.test(all[end]))) end -= 1;
  const lines = end < all.length - 1 && isFooterLine(all[end]) ? all.slice(0, end + 1) : all;
  const last = lines[lines.length - 1];
  const footerIndex = lines.length - 1;

  if (ASK_FOOTER.test(last)) return parseAskQuestion(lines, footerIndex);
  if (PERMISSION_FOOTER.test(last)) return parsePermission(lines, footerIndex);
  if (/^(?:❯ |  )2\. Cancel$/.test(last)) return parseAskReview(lines);
  // A dialog-looking bottom line in an unmeasured shape must not be mistaken for an idle pane.
  if (/(?:^| )Esc to cancel(?: ·|$)/.test(last) || /^ ?Enter to (?:select|confirm) ·/.test(last)) {
    return unsupported('an unmeasured Claude dialog footer is visible');
  }
  // Fail closed: a dialog footer above unknown bottom lines (rules, status lines) is still a dialog.
  // The measured idle screen ends with the input box (rule, prompt row, rule) and at most two status
  // lines; only what is below that box counts, so footer words in the answer text above it do not.
  // Without a visible box the last FOOTER_SEARCH_LINES lines are searched: footer, rule and up to six
  // further rows (review 14.10., N3: footer + rule + three status lines must not read as idle).
  const tail = all.slice(-FOOTER_SEARCH_LINES);
  const below = belowInputBox(tail) ?? tail;
  if (below.some((line) => isFooterLine(line))) {
    return unsupported('a Claude dialog footer is visible above unmeasured bottom lines');
  }
  return { state: 'none' };
}

function optionIds(dialog: ParsedDialog): readonly { id: string; label: string; selected: boolean }[] {
  switch (dialog.kind) {
    case 'ask_single':
    case 'ask_step':
      return [
        ...dialog.options.map((option) => ({ id: `choice_${option.index}`, label: option.label, selected: option.index === dialog.selectedIndex })),
        { id: 'abort', label: 'Decline to answer (Esc)', selected: false },
      ];
    case 'ask_review':
      return [
        { id: 'submit', label: 'Submit answers', selected: true },
        { id: 'cancel', label: 'Cancel', selected: false },
      ];
    case 'permission_bash':
    case 'permission_edit':
      // The middle option is measurable but claims a persistent/session-wide grant and is not offered.
      return [
        { id: 'allow_once', label: 'Yes (once)', selected: true },
        { id: 'reject', label: 'No', selected: false },
        { id: 'abort', label: 'Cancel (Esc)', selected: false },
      ];
  }
}

function tableFor(dialog: ParsedDialog): Readonly<Record<string, readonly ClaudeDialogKey[]>> | null {
  if (dialog.kind === 'ask_single') return MEASURED_KEYS[`ask_single:${dialog.options.length}`] ?? null;
  if (dialog.kind === 'ask_step') return dialog.tabs.length === 2 ? MEASURED_KEYS[`ask_step:${dialog.options.length}`] ?? null : null;
  if (dialog.kind === 'ask_review') return dialog.tabs.length === 2 ? MEASURED_KEYS['ask_review:2'] : null;
  return MEASURED_KEYS[`${dialog.kind}:${dialog.options.length}`] ?? null;
}

function fingerprint(session: MobileDialogSession, snapshot: ClaudePaneSnapshot, version: ClaudeMeasuredVersion, dialog: ParsedDialog): string {
  const canonical = JSON.stringify({
    adapter: 'claude-pane',
    version,
    session: session.id,
    pane: snapshot.pane,
    kind: dialog.kind,
    heading: dialog.heading,
    text: dialog.text,
    options: dialog.options,
    selected: dialog.selectedIndex,
  });
  return `claude-${version}:${createHash('sha256').update(canonical).digest('hex')}`;
}

async function localSession(source: ClaudeDialogsForMobile, sessionId: string): Promise<MobileDialogSession> {
  const matches = (await source.fresh()).filter((session) => session.id === sessionId);
  if (matches.length !== 1) fail('stale_target', 'session is no longer current');
  const session = matches[0];
  if (session.machine !== source.localMachine) fail('capability_unavailable', 'mirrored sessions cannot expose prompts');
  if (session.harness !== 'claude') fail('capability_unavailable', 'this harness has no measured mobile dialog adapter');
  return session;
}

interface CurrentPrompt {
  readonly session: MobileDialogSession;
  readonly snapshot: ClaudePaneSnapshot;
  readonly dialog: ParsedDialog;
  readonly prompt: Prompt;
  readonly keys: Readonly<Record<string, readonly ClaudeDialogKey[]>>;
}

/** One fresh capture, exact version, anchored parse. `null` means no dialog is showing. */
async function currentPrompt(source: ClaudeDialogsForMobile, sessionId: string): Promise<CurrentPrompt | null> {
  const session = await localSession(source, sessionId);
  const snapshot = await source.claudePane(session);
  if (!snapshot || !/^%[0-9]+$/.test(snapshot.pane)) fail('capability_unavailable', 'the Claude pane is unavailable');
  const version = ACCEPTED_VERSION_STRINGS.get(snapshot.version);
  if (!version) {
    const shownVersion = snapshot.version === '' ? '(unknown)' : snapshot.version;
    fail('capability_unavailable', `Claude Code version ${shownVersion} is not measured; measured versions: ${CLAUDE_MEASURED_VERSIONS.join(', ')}`);
  }
  const parsed = parseClaudeDialog(snapshot.text);
  if (parsed.state === 'none') return null;
  if (parsed.state === 'unsupported') throw new UnmeasuredClaudeDialog(`this Claude dialog is not measured: ${parsed.reason}`);
  const keys = tableFor(parsed.dialog);
  if (!keys) throw new UnmeasuredClaudeDialog('this Claude dialog layout is not measured');
  const options = optionIds(parsed.dialog);
  if (!options.every((option) => keys[option.id] !== undefined)) throw new UnmeasuredClaudeDialog('this Claude dialog offers an option without a measured key sequence');
  return {
    session,
    snapshot,
    dialog: parsed.dialog,
    keys,
    prompt: {
      fingerprint: fingerprint(session, snapshot, version, parsed.dialog),
      harness: 'claude',
      harness_version: version,
      text: [parsed.dialog.heading, parsed.dialog.text].filter((part) => part !== '').join('\n'),
      selection: 'single',
      options,
    },
  };
}

/**
 * True while any recognised or unrecognised Claude dialog is showing. Measured: a pasted
 * message plus Enter while a dialog is open answers the dialog with its first option.
 * Paket 10 must refuse `POST /sessions/:id/messages` for a Claude pane while this is true.
 *
 * FAIL CLOSED, und das ist hier tragend (Sicherheits-Review 2026-09-21): ohne
 * lesbare Aufnahme ist NICHT bekannt, ob gerade ein Dialog offen steht. Der
 * Kern liefert genau dann keine (`mobilClaudePane()` gibt `null`, wenn
 * `capture-pane` oder die Versionsmessung scheitert oder in ihre Frist laeuft),
 * und eine eingefuegte Nachricht beantwortet einen offenen Dialog gemessen mit
 * Option 1 -- bei einer Bash- oder Edit-Berechtigung also mit „Yes". Ein
 * Fehlerpfad darf diese Sperre deshalb nicht oeffnen; die Sitzung selbst
 * (Spiegel, anderer Harness, verschwunden) faellt schon in `localSession` auf.
 */
export async function claudeDialogBlocksInput(source: ClaudeDialogsForMobile, sessionId: string): Promise<boolean> {
  const session = await localSession(source, sessionId);
  const snapshot = await source.claudePane(session);
  if (!snapshot || snapshot.text === '') return true;
  return parseClaudeDialog(snapshot.text).state !== 'none';
}

export function createClaudeDialogHandlers(source: ClaudeDialogsForMobile): Pick<MobileRouteHandlers,
  'GET /sessions/:id/prompt' | 'POST /sessions/:id/prompt-answer'> {
  return {
    'GET /sessions/:id/prompt': async (route) => {
      const current = await currentPrompt(source, route.params.id);
      return { data: { prompt: current?.prompt ?? null } as unknown as JsonValue };
    },
    'POST /sessions/:id/prompt-answer': async (route) => {
      const body = validatePromptAnswerBody(route.body);
      if (!body.ok) fail('bad_request', body.error);
      if (body.value.text !== undefined) fail('bad_request', 'Claude dialog answers do not accept text; send a normal message after declining');

      // A new capture, not the earlier GET result: version, dialog and fingerprint are
      // re-checked immediately before the keys go out.
      let current: CurrentPrompt | null;
      try {
        current = await currentPrompt(source, route.params.id);
      } catch (error) {
        if (error instanceof UnmeasuredClaudeDialog) fail('prompt_changed', 'the Claude dialog changed before it could be answered');
        throw error;
      }
      if (!current || current.prompt.fingerprint !== body.value.fingerprint) {
        fail('prompt_changed', 'the Claude dialog changed before it could be answered');
      }
      if (!current.prompt.options.some((option) => option.id === body.value.option_id)) {
        fail('bad_request', 'option_id is not available for this measured Claude dialog');
      }
      const keys = current.keys[body.value.option_id];
      if (!keys) fail('bad_request', 'option_id has no measured key sequence');
      await source.sendKeys({ session: current.session, pane: current.snapshot.pane, keys, request: route });
      return { data: { accepted_at: (source.now ?? Date.now)() } as unknown as JsonValue };
    },
  };
}
