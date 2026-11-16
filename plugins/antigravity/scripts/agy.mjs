// The Antigravity CLI the plugin's scripts use, found as the agent's command does: ~/.local/bin/agy first (where Google's
// installer puts it; Coda's back end does not always have that directory on its PATH), then the PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function agyBinary(env = process.env) {
  const installed = join(homedir(), '.local/bin/agy');
  if (existsSync(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'agy')).find(path => existsSync(path)) ?? null;
}
// The first x.y.z a version command prints; whether one is older than another.
export const versionIn = text => /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')?.slice(1).join('.') ?? null;
export function older(version, than) {
  const a = version.split('.').map(Number), b = than.split('.').map(Number), i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] < b[i];
}

// Whether the Antigravity CLI has a login on this machine: its credentials entry (service `gemini`, account `antigravity`)
// is in the keychain, asked for the entry alone, never its secret. macOS: `security`; Linux: the Secret Service through
// `secret-tool` (the entry's attributes are what go-keyring writes: not tried on a real machine), where its file
// fallback for a machine without one is not looked for. True, false, or an error for a keychain that cannot be asked.
export function signedIn(platform = process.platform, run = spawnSync) {
  if (platform === 'darwin') {
    const ran = run('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
    // 44 is `security`'s errSecItemNotFound.
    if (ran.status === 0) return true;
    if (ran.status === 44) return false;
    throw new Error(`读不了钥匙串：${`${ran.stderr ?? ''}`.trim().split('\n')[0] || ran.error?.code || ran.status}`);
  }
  if (platform === 'linux') {
    const ran = run('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], { stdio: 'ignore', timeout: 10_000 });
    return ran.status === 0;
  }
  return false;
}
