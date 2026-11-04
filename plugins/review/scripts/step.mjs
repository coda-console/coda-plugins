// What the scripts of the pull request's workflow share (../.coda/workflows/pull-request.bpmn): reading the values the
// process gives them, writing their outputs and summary, and asking GitHub where the pull request is based.
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// A value the process gave as JSON (an object, or a step's outputs); none or unreadable is the fallback.
export const json = (name, fallback = null) => { try { return JSON.parse(process.env[name] || 'null') ?? fallback; } catch { return fallback; } };
export const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF_${name}\n${value ?? ''}\nEOF_${name}\n`);
};
export const summary = text => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); };

// The pull request at `url` as GitHub has it based now: its base branch and its repository's default branch (`main`), and
// its number; asked a few times a few seconds apart. `error` says why when it cannot be read.
export async function baseOf(url, targetBranch = '') {
  const at = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url ?? '');
  if (!at) return { error: `不是 GitHub 上的 PR：${url}` };
  let error = '';
  for (let i = 1; i <= 3; i++) {
    if (i > 1) await delay(3000);
    const done = spawnSync('gh', ['api', `repos/${at[1]}/pulls/${at[2]}`, '--jq', '{base: .base.ref, main: .base.repo.default_branch}'], { encoding: 'utf8' });
    let read = null;
    try { read = done.status === 0 ? JSON.parse(done.stdout) : null; } catch {}
    if (read?.base && read?.main) return { base: read.base, main: read.main, target: targetBranch.trim() || read.main, number: at[2] };
    error = (done.stderr || '').trim().split('\n').at(-1) || '没有读到';
  }
  return { error: `读不到 PR 的 base：${error}` };
}
