// The one place that talks to peer over SSH: short, keyless, batch-mode calls
// with a timeout (no daemon, no persistent connection). Kept separate from
// remoteState.ts so both the start page and the worker sidebar can use it
// without importing each other.
import { execFile } from 'node:child_process';
import { PEER_SSH_HOST } from './machine.ts';

export const SSH_CONNECT_TIMEOUT_S = 8;
export const SSH_TIMEOUT_MS = 15000;

/** `ssh <host> <remoteCommand>` with batch mode so it never blocks on a prompt. */
export function sshArgs(host: string, remoteCommand: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    host,
    remoteCommand,
  ];
}

export interface SshOptions {
  host?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export function runSsh(remoteCommand: string, options: SshOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      sshArgs(options.host ?? PEER_SSH_HOST, remoteCommand),
      { timeout: options.timeoutMs ?? SSH_TIMEOUT_MS, maxBuffer: options.maxBuffer ?? 32 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
