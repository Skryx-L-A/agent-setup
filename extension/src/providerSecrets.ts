// Provider API keys (SPEC-V3 A.1, G.2). This is the one write path the extension
// owns end-to-end instead of going through `wb-state`: a key must never cross a
// process boundary as a CLI argument (visible in `ps`), so it can't go through
// wb-state's normal --json-over-stdin call the way models/harnesses/providers do.
//
// Two writes, both without the key ever touching argv:
//   - macOS Keychain, for spawns on THIS machine: `security -i` reads a whole
//     command SCRIPT from stdin ("security add-generic-password -w …" typed as
//     if interactively) — the secret sits in the script text on stdin, never in
//     the child process's argv.
//   - ~/.secrets-sync/api-keys/<provider>, mode 600, for peer: Syncthing carries
//     the file across, peer has no Keychain.
//
// The UI is only ever allowed to ask "is a key on file, and since when" — never
// the value, not even masked. That question is answered by stat()-ing the
// secrets-sync file; its content is never read back here.
import { execFile } from 'node:child_process';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeCliError } from './modelsCli.ts';
import type { Provider } from './models.ts';
import { expandHome } from './settings.ts';

export function keychainService(providerId: string): string {
  return `wb-${providerId}`;
}

export function secretsSyncDir(home: string = homedir()): string {
  return join(home, '.secrets-sync', 'api-keys');
}

export function secretsSyncFile(providerId: string, home: string = homedir()): string {
  return join(secretsSyncDir(home), providerId);
}

/**
 * Trims the key and rejects anything that could break the single-line Keychain
 * script or is obviously not a key (empty, or carrying a line break).
 */
export function sanitizeApiKey(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || /[\r\n]/.test(value)) {
    return undefined;
  }
  return value;
}

/** Double-quotes a value for `security -i`'s command parser. */
function quoteForSecurity(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One `security -i` command line. `-U` updates an existing item instead of
 * failing on a second save of the same provider. The secret is embedded in this
 * SCRIPT TEXT (fed over stdin), never passed as a `security` CLI argument.
 */
export function keychainAddScript(service: string, account: string, secret: string): string {
  return `add-generic-password -a ${quoteForSecurity(account)} -s ${quoteForSecurity(service)}`
    + ` -w ${quoteForSecurity(secret)} -U\n`;
}

export interface ProviderKeyStatus {
  present: boolean;
  /** ISO timestamp the key was last (re)written — the secrets-sync file's mtime. */
  setAt?: string;
  /**
   * False only for a `subscription` provider with no `loginCheckPath`
   * configured — nothing was actually checked (SPEC-V3 D, item 4: "Statusanzeige,
   * ob eine Anmeldung erkennbar ist"). `present` is then meaningless and the UI
   * must show an honest "nicht automatisch prüfbar" instead of "fehlt". Omitted
   * (implicitly true) everywhere else — every `cloud` check and every
   * `subscription` check WITH a configured path is a real check.
   */
  checked?: boolean;
}

/**
 * Presence only, `security find-generic-password` WITHOUT `-w` — same call as
 * `wb-state secret_present()`, never reads the value and never triggers a
 * Keychain access prompt. Missing `security` (not macOS) resolves to false,
 * same as `wb-state`'s `shutil.which("security")` guard.
 */
function keychainHasSecret(service: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service], { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Mirrors `wb-state secret_present()` / `wb-harness-run secret_value()`'s
 * lookup order (SPEC-V3 A.1): Keychain -> secrets-sync file -> env var. Only
 * the file source carries a date (its mtime); Keychain/env presence is
 * reported without one (the UI already renders that as "unbekanntem Datum").
 * Still never reads a key's content, only whether one is on file.
 *
 * `subscription` providers (codex/agy: login via account, not a key — SPEC-V3
 * H0) take a DIFFERENT check: presence of `loginCheckPath`, a file whose
 * existence indicates a completed login (e.g. `~/.codex/auth.json`). Without
 * that field nothing is checked — see ProviderKeyStatus.checked.
 */
export async function providerKeyStatus(
  provider: Pick<Provider, 'id' | 'keychainService' | 'apiKeyEnv' | 'kind' | 'loginCheckPath'>,
): Promise<ProviderKeyStatus> {
  if (provider.kind === 'subscription') {
    if (!provider.loginCheckPath) {
      return { present: false, checked: false };
    }
    try {
      const info = await stat(expandHome(provider.loginCheckPath));
      return { present: true, setAt: info.mtime.toISOString() };
    } catch {
      return { present: false };
    }
  }
  if (provider.keychainService && (await keychainHasSecret(provider.keychainService))) {
    return { present: true };
  }
  try {
    const info = await stat(secretsSyncFile(provider.id));
    return { present: true, setAt: info.mtime.toISOString() };
  } catch {
    // fall through to the env-var check
  }
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return { present: true };
  }
  return { present: false };
}

export async function writeSecretsSyncFile(providerId: string, secret: string): Promise<void> {
  const file = secretsSyncFile(providerId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, secret + '\n', { mode: 0o600 });
  // writeFile's mode is masked by umask — chmod explicitly so the file is 600
  // regardless of the shell that spawned this extension host.
  await chmod(file, 0o600);
}

interface ExecError {
  code?: string;
  stderr?: string;
  stdout?: string;
  message?: string;
}

function runSecurityScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'security',
      ['-i'],
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stderr, stdout }));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(script);
  });
}

async function writeKeychain(providerId: string, secret: string): Promise<{ ok: boolean; message: string }> {
  try {
    await runSecurityScript(keychainAddScript(keychainService(providerId), providerId, secret));
    return { ok: true, message: 'Keychain aktualisiert.' };
  } catch (error) {
    return { ok: false, message: describeCliError(error as ExecError, 'security nicht gefunden (nur auf macOS verfügbar).') };
  }
}

export interface SaveKeyResult {
  ok: boolean;
  message: string;
}

/**
 * Writes the key to both destinations. The secrets-sync file is the one the UI
 * later checks (providerKeyStatus), so a failure there is reported as the
 * overall failure; a Keychain failure is still surfaced, but does not hide a
 * successful file write — peer would otherwise never see the key at all.
 */
export async function saveProviderKey(providerId: string, rawSecret: string): Promise<SaveKeyResult> {
  const secret = sanitizeApiKey(rawSecret);
  if (!secret) {
    return { ok: false, message: 'Ungültiger Key (leer oder mit Zeilenumbruch).' };
  }
  const keychain = await writeKeychain(providerId, secret);
  try {
    await writeSecretsSyncFile(providerId, secret);
  } catch (error) {
    return { ok: false, message: `Datei-Ablage fehlgeschlagen (${(error as Error).message}).` };
  }
  return keychain.ok
    ? { ok: true, message: `Key hinterlegt (Keychain + ${secretsSyncFile(providerId)}).` }
    : { ok: true, message: `Key in ${secretsSyncFile(providerId)} hinterlegt, Keychain fehlgeschlagen: ${keychain.message}` };
}
