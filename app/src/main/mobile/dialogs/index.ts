import type { MobileRouteHandlers } from '../http/server';
import { MobileAuthError } from '../auth/auth';
import { createClaudeDialogHandlers, CLAUDE_DIALOG_CAPABILITIES, type ClaudeDialogsForMobile } from './claude';
import { createDialogHandlers as createOpenCodeDialogHandlers, type DialogsForMobile } from './opencode';

/**
 * The one entry point Paket 10 wires into the prompt routes. It dispatches by the harness of
 * the freshly resolved local session and lets every other harness stay closed.
 */
export const MEASURED_DIALOG_CAPABILITIES = Object.freeze({
  ...CLAUDE_DIALOG_CAPABILITIES,
  'prompt.answer.codex': false,
  'prompt.answer.opencode': true,
  'prompt.answer.pi': false,
});

export type AllDialogsForMobile = DialogsForMobile & ClaudeDialogsForMobile;

export function createDialogHandlers(source: AllDialogsForMobile): Pick<MobileRouteHandlers,
  'GET /sessions/:id/prompt' | 'POST /sessions/:id/prompt-answer'> {
  const opencode = createOpenCodeDialogHandlers(source);
  const claude = createClaudeDialogHandlers(source);

  const dispatch = (route: 'GET /sessions/:id/prompt' | 'POST /sessions/:id/prompt-answer'): NonNullable<MobileRouteHandlers[typeof route]> => async (request) => {
    const matches = (await source.fresh()).filter((session) => session.id === request.params.id);
    if (matches.length !== 1) throw new MobileAuthError('stale_target', 'session is no longer current');
    const harness = matches[0].harness;
    if (harness === 'claude') return claude[route]!(request);
    if (harness === 'opencode') return opencode[route]!(request);
    throw new MobileAuthError('capability_unavailable', 'this harness has no measured mobile dialog adapter');
  };

  return {
    'GET /sessions/:id/prompt': dispatch('GET /sessions/:id/prompt'),
    'POST /sessions/:id/prompt-answer': dispatch('POST /sessions/:id/prompt-answer'),
  };
}
