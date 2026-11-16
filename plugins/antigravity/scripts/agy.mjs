// The Antigravity CLI the plugin's scripts use, found as the agent's command does: ~/.local/bin/agy first (where Google's
// installer puts it; Coda's back end does not always have that directory on its PATH), then the PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function agyBinary(env = process.env) {
  const installed = join(homedir(), '.local/bin/agy');
  if (existsSync(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'agy')).find(path => existsSync(path)) ?? null;
}
// `agy --version` run once, and the first x.y.z it printed on either output (null for none): the one reading of the version,
// which the setup and the resources share.
export const asked = binary => spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
export const versionOf = ran => /(\d+)\.(\d+)\.(\d+)/.exec(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`)?.slice(1).join('.') ?? null;
// The CLI's usage report, parsed: `agy -p /usage --output-format json`, which the CLI answers itself, without a turn, the
// quota spent or a conversation left behind. Run from the temporary directory, so that no project of the CLI's is made for
// a directory of the user's, and with its update off for this run alone. Throws, with the reason in a line, for a CLI that
// fails or times out (kept well under the 30 seconds Coda gives a reading) or answers anything but a successful usage report.
export function usageReport(binary, run = spawnSync) {
  const ran = run(binary, ['-p', '/usage', '--output-format', 'json'], { encoding: 'utf8', cwd: tmpdir(), timeout: 20_000,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (ran.error?.code === 'ETIMEDOUT') throw new Error('读取超时');
  if (ran.error) throw new Error(`无法运行 Antigravity CLI：${ran.error.code ?? ran.error.message}`);
  if (ran.status !== 0) throw new Error(`Antigravity CLI 退出码 ${ran.status ?? ran.signal}：${`${ran.stderr ?? ''}`.trim().split('\n')[0]}`);
  let report;
  try { report = JSON.parse(ran.stdout); } catch { throw new Error('Antigravity CLI 的额度报告不是 JSON'); }
  if (report?.status !== 'SUCCESS' || report.command?.name !== 'usage') throw new Error(`Antigravity CLI 没有给出额度报告（${report?.status ?? '无状态'}）`);
  return report;
}
// Whether one version is older than another.
export function older(version, than) {
  const a = version.split('.').map(Number), b = than.split('.').map(Number), i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] < b[i];
}

// Whether the Antigravity CLI has a login on this machine: its credentials entry (service `gemini`, account `antigravity`)
// is in the keychain, asked for the entry alone, never its secret. macOS: `security`; Linux: the Secret Service through
// `secret-tool` (the entry's attributes are what go-keyring writes: not tried on a real machine), where the CLI's file
// fallback for a machine without one is not looked for. True or false for what the keychain answers: on Linux, no
// `secret-tool`, or one that exits 1 saying nothing (its answer for no entry) is not signed in. An error for a keychain that
// cannot be asked (macOS: any other answer than found or not found; Linux: `secret-tool` timing out, killed, failing to
// start, or failing with a message, as for a Secret Service it cannot reach, which it also exits 1 for), which fails the
// reading rather than showing a sign-out.
export function signedIn(platform = process.platform, run = spawnSync) {
  if (platform === 'darwin') {
    const ran = run('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
    // 44 is `security`'s errSecItemNotFound.
    if (ran.status === 0) return true;
    if (ran.status === 44) return false;
    throw new Error(`读不了钥匙串：${`${ran.stderr ?? ''}`.trim().split('\n')[0] || ran.error?.code || ran.signal || ran.status}`);
  }
  if (platform === 'linux') {
    const ran = run('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
    if (ran.error?.code === 'ENOENT') return false;
    if (ran.status === 0) return true;
    const said = `${ran.stderr ?? ''}`.trim().split('\n')[0];
    if (ran.status === 1 && !said && !ran.error) return false;
    throw new Error(`读不了 Secret Service：${said || ran.error?.code || ran.signal || ran.status}`);
  }
  return false;
}
