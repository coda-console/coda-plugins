// The cross-review step of the pull request's workflow (plugins/review/scripts/review.mjs) asked for by hand with no pull
// request named: it takes the one the GitHub plugin's github-reported-pr finds, and when that cannot say, says why.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../plugins/review/scripts/review.mjs', import.meta.url));

test('naming no pull request, the review takes the one the session opened last, and says why when that cannot be found', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), summary = join(root, 'summary.md');
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // GitHub has no such pull request: what gh is asked shows which one the review went for.
  stub('gh', 'echo "no pull request $3" >&2; exit 1');
  const review = () => {
    writeFileSync(summary, '');
    const done = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PR: '',
      REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }), SESSION: JSON.stringify({ agent: 'codex' }), GITHUB_STEP_SUMMARY: summary } });
    return { code: done.status, said: done.stderr.trim().split('\n').at(-1), summary: readFileSync(summary, 'utf8').trim() };
  };
  stub('github-reported-pr', 'echo https://github.com/acme/app/pull/4');
  assert.deepEqual(review(), { code: 1, said: '读不到 PR https://github.com/acme/app/pull/4：no pull request https://github.com/acme/app/pull/4',
    summary: '交叉评审没有进行：读不到 PR https://github.com/acme/app/pull/4：no pull request https://github.com/acme/app/pull/4' });
  // It could not look: what it said, not that there is none.
  stub('github-reported-pr', 'echo "github-reported-pr：当前目录没有 origin 远端，不知道是哪个仓库" >&2; exit 17');
  assert.deepEqual([review().code, review().said], [1, '没有指明要评审的 PR，也没查到会话最近开的 PR：github-reported-pr：当前目录没有 origin 远端，不知道是哪个仓库']);
  stub('github-reported-pr', 'exit 17');
  assert.equal(review().said, '没有指明要评审的 PR，也没查到会话最近开的 PR：github-reported-pr 以 17 退出');
  // It looked and found nothing.
  stub('github-reported-pr', 'exit 0');
  assert.equal(review().said, '没有指明要评审的 PR，github-reported-pr 也没有给出');
  // There is none to ask: the GitHub plugin is off in the project.
  rmSync(join(bin, 'github-reported-pr'));
  assert.equal(review().said, '没有指明要评审的 PR，也没能查会话最近开的 PR：没有 GitHub 插件的 github-reported-pr（项目里停用了 GitHub 插件时要填 PR）');
});

test('the session that opened the pull request is given the rules the reviewer was given, word for word', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), work = join(root, 'work'), outputs = join(root, 'outputs'), prompt = join(root, 'prompt.md');
  mkdirSync(bin); mkdirSync(join(work, '.coda'), { recursive: true });
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub('gh', 'exit 0');
  // The reviewer keeps what it was asked and finds one blocking problem.
  stub('coda-agent', `while [ "$1" != --prompt-file ]; do shift; done; cp "$2" ${JSON.stringify(prompt)}
printf '%s\\n' '\`\`\`review' '{"findings":[{"severity":"P1","title":"t"}]}' '\`\`\`'`);
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args],
    { cwd: work, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  writeFileSync(join(work, '.coda/review.md'), '项目准则：只跑相关测试。');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(work, 'a'), 'x'); git('add', '.'); git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(outputs, '');
  const done = spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root,
    RUNNER_TEMP: root, GITHUB_OUTPUT: outputs, REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }), PRINCIPLES: '["tests"]', BLOCKING: 'P2',
    PULL_REQUEST: JSON.stringify({ number: 1, html_url: 'https://github.com/acme/app/pull/1', head: { sha: head, ref: 'f' }, base: { sha: base, ref: 'main' } }) } });
  assert.equal(done.status, 0, done.stderr);
  const rules = /^rules<<EOF_rules\n([\s\S]*?)\nEOF_rules$/m.exec(readFileSync(outputs, 'utf8'))?.[1];
  assert.ok(readFileSync(prompt, 'utf8').includes(`\n${rules}\n`), 'the reviewer is given the same rules');
  for (const part of ['项目准则：只跑相关测试。', '只报可操作的发现', '**测试**', 'P3 低优']) assert.ok(rules.includes(part), part);
  assert.doesNotMatch(rules, /<!--|\{\{/);
});
