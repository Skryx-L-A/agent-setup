// The machine dimension: a workbench session runs either on this Mac (local,
// unchanged V1 behaviour) or fully remote on Peer via Remote-SSH. Pure helpers
// only — no vscode, no child_process — so the routing logic stays unit-testable.

export type Machine = 'mac' | 'peer';

export const MACHINES: readonly Machine[] = ['mac', 'peer'];

export const MACHINE_LABEL: Record<Machine, string> = {
  mac: 'Diese Maschine (Mac)',
  peer: 'Peer (Linux-PC)',
};

/** ssh host alias (~/.ssh/config), keyless via Tailscale-SSH — see CLAUDE.md. */
export const PEER_SSH_HOST = 'peer';

/**
 * SSH host for a machine name out of a state file, or undefined when there is
 * none to reach: 'mac' is where the extension host itself runs (Design C), and
 * an unknown name must not be turned into a host guess.
 */
export function sshHostFor(machine: string): string | undefined {
  return machine === 'peer' ? PEER_SSH_HOST : undefined;
}

/** Remote-SSH authority VSCode uses for `vscode-remote://ssh-remote+peer<path>`. */
export const PEER_REMOTE_AUTHORITY = 'ssh-remote+peer';

/** globalState key persisting the last chosen machine across windows/restarts. */
export const MACHINE_STATE_KEY = 'claudeWorkbench.machine';

export function isMachine(value: unknown): value is Machine {
  return value === 'mac' || value === 'peer';
}

export function otherMachine(machine: Machine): Machine {
  return machine === 'mac' ? 'peer' : 'mac';
}

export interface RemoteUriParts {
  scheme: 'vscode-remote';
  authority: string;
  path: string;
}

/**
 * Parts of the Remote-SSH URI that opens an peer folder fully remote. The path
 * must be the absolute path ON peer (e.g. /home/alice/AI/foo); VSCode reloads
 * the window into the remote extension host, where Explorer, editor and terminal
 * all operate on real peer files.
 */
export function peerRemoteUri(absPeerPath: string): RemoteUriParts {
  return { scheme: 'vscode-remote', authority: PEER_REMOTE_AUTHORITY, path: absPeerPath };
}
