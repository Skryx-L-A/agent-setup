// Result files of REMOTE workers (`claude-worker --on peer …`, called SSH-<name>
// everywhere) live on the target machine, under its own
// ~/.pi-workers/results/<name>/latest.md.
//
// They are read server-side over SSH and never copied here — the same rule
// wb-result follows: results/ is a flat namespace that already collides between
// the machines, and latest.md is an ABSOLUTE symlink into the remote filesystem,
// so a naive copy would fetch a dead link.
//
// One call covers every worker of a machine, so the sidebar poll costs at most
// one short SSH round trip, not one per worker.
import { shellQuote } from './format.ts';
import { sshHostFor } from './machine.ts';
import { runSsh } from './ssh.ts';

export interface RemoteWorkerResult {
  firstLine: string;
  mtime: number;
}

/** Shorter than the state timeout: the sidebar must not hang on a slow link. */
export const RESULT_TIMEOUT_MS = 8000;

const RESULT_MARKER = '@@RES@@';

/**
 * For every name: mtime in whole seconds and the first non-empty line of
 * latest.md, base64-encoded so a headline with tabs or umlauts survives the
 * transport. Workers without a result file simply produce no line.
 */
export function remoteResultsScript(names: string[]): string {
  if (names.length === 0) {
    return 'true';
  }
  return [
    `for n in ${names.map(shellQuote).join(' ')}; do`,
    `  f="$HOME/.pi-workers/results/$n/latest.md"`,
    `  [ -s "$f" ] || continue`,
    // stat is BSD on the Mac and GNU on peer — the remote side here is always
    // Linux (peer), but the fallback keeps the script honest either way.
    `  m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)`,
    `  l=$(grep -m1 -v '^[[:space:]]*$' "$f" 2>/dev/null | sed 's/^#\\{1,\\}[[:space:]]*//' | base64 | tr -d '\\n')`,
    `  printf '${RESULT_MARKER}%s\\t%s\\t%s\\n' "$n" "$m" "$l"`,
    `done`,
  ].join('\n');
}

export function parseRemoteResults(out: string): Map<string, RemoteWorkerResult> {
  const results = new Map<string, RemoteWorkerResult>();
  for (const line of out.split('\n')) {
    if (!line.startsWith(RESULT_MARKER)) {
      continue;
    }
    const [name, mtime, firstLine] = line.slice(RESULT_MARKER.length).split('\t');
    if (!name) {
      continue;
    }
    const seconds = Number(mtime);
    let text = '';
    try {
      text = Buffer.from(firstLine ?? '', 'base64').toString('utf8').trim();
    } catch {
      text = '';
    }
    results.set(name, {
      firstLine: text,
      mtime: Number.isFinite(seconds) ? seconds * 1000 : 0,
    });
  }
  return results;
}

/**
 * Results of `names` on `machine`. Throws when that machine cannot be reached —
 * or has no SSH host at all — so the caller can say where the result lives
 * instead of claiming there is none.
 */
export async function readRemoteResults(
  names: string[],
  machine: string,
): Promise<Map<string, RemoteWorkerResult>> {
  if (names.length === 0) {
    return new Map();
  }
  const host = sshHostFor(machine);
  if (!host) {
    throw new Error(`keine SSH-Verbindung für Maschine "${machine}"`);
  }
  return parseRemoteResults(
    await runSsh(remoteResultsScript(names), {
      host,
      timeoutMs: RESULT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
    }),
  );
}
