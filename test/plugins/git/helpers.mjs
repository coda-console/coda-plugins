import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
export const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
export async function command(cwd, args, extra = {}) {
  return (await exec('git', args, { cwd, env: { ...env, ...extra }, maxBuffer: 16 * 1024 * 1024 })).stdout.trimEnd();
}
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coda-git-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await command(dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'tracked'), 'base\n');
  await writeFile(join(dir, '.gitignore'), 'ignored\n');
  await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'base']);
  return dir;
}
export const packet = line => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line);
