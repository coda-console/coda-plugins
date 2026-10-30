// The cross-review step and the PR identity used before that step starts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/review/scripts/review.mjs', import.meta.url));

test('GitHub-returned PR URLs share the event key without deriving repository identity from origin', () => {
  const source = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');
  const expression = /coda:key='=([^']+)'/.exec(source)?.[1];
  assert.ok(expression);
  const key = (pr, event = {}, repository = 'Owner/Repo') => evaluate(expression, { inputs: { pr }, github: { event, repository } }).value;
  const expected = 'https://github.com/owner/repo/pull/402';
  for (const pr of [expected, 'https://GitHub.com/OWNER/Repo/pull/402']) assert.equal(key(pr), expected, pr);
  assert.equal(key('', { number: 402, pull_request: { html_url: expected } }), expected);
  assert.equal(key(expected, {}, 'Old/Repository'), expected);
  assert.notEqual(key('https://github.com/owner/repo/pull/403'), expected);
  assert.notEqual(key('https://github.com/other/repo/pull/402'), expected);
  for (const pr of ['', '402', '00402', 'main', `${expected}/`, `${expected}?tab=checks#comment`,
    'https://other.example/owner/repo/pull/402', 'https://github.com/owner/repo/issues/402'])
    assert.equal(key(pr), null, pr);
});

test('manual review uses the explicit PR and rejects a missing one', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), summary = join(root, 'summary.md');
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // GitHub has no such pull request: what gh is asked shows which one the review went for.
  stub('gh', 'echo "no pull request $3" >&2; exit 1');
  const review = (pr = '') => {
    writeFileSync(summary, '');
    const done = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PR: pr,
      REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }), SESSION: JSON.stringify({ agent: 'codex' }), GITHUB_STEP_SUMMARY: summary } });
    return { code: done.status, said: done.stderr.trim().split('\n').at(-1), summary: readFileSync(summary, 'utf8').trim() };
  };
  assert.deepEqual(review('https://github.com/acme/app/pull/4'), { code: 1, said: '读不到 PR https://github.com/acme/app/pull/4：no pull request https://github.com/acme/app/pull/4',
    summary: '交叉评审没有进行：读不到 PR https://github.com/acme/app/pull/4：no pull request https://github.com/acme/app/pull/4' });
  assert.deepEqual([review().code, review().said], [1, '请填写 GitHub 返回的完整 PR 地址']);
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
