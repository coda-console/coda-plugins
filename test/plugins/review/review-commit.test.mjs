// Reviewing a stretch of commits with no pull request (the capability review-commit), against the pull request's review.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workflowProblem } from '@coda-console/protocol/workflow';

const script = fileURLToPath(new URL('../../../plugins/review/scripts/review.mjs', import.meta.url));
const capability = new URL('../../../plugins/review/.coda/capabilities/review-commit.bpmn', import.meta.url);

// A project with a base commit carrying its guidelines and a head commit on it; a reviewer that keeps what it was asked and
// gives one blocking and one light finding; a gh that notes every call.
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-commit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), work = join(root, 'work'), calls = join(root, 'gh-calls'), prompt = join(root, 'prompt.md'), args = join(root, 'args');
  mkdirSync(bin); mkdirSync(join(work, '.coda'), { recursive: true });
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub('gh', `echo "$*" >> ${JSON.stringify(calls)}`);
  stub('coda-agent', `echo "$*" > ${JSON.stringify(args)}; while [ "$1" != --prompt-file ]; do shift; done; cp "$2" ${JSON.stringify(prompt)}
printf '%s\\n' '看过了。' '\`\`\`review' '{"findings":[{"severity":"P1","title":"阻塞","location":"a:1","detail":"d"},{"severity":"P3","title":"低优"}]}' '\`\`\`'`);
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...a], { cwd: work, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  writeFileSync(join(work, '.coda/review.md'), '项目准则：只跑相关测试。');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(work, 'a'), 'x'); git('add', '.'); git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  const run = (argv, env) => {
    const outputs = join(root, 'outputs'), summary = join(root, 'summary.md');
    writeFileSync(outputs, ''); writeFileSync(summary, '');
    const done = spawnSync(process.execPath, [script, ...argv], { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root,
      RUNNER_TEMP: root, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary, PRINCIPLES: '["tests"]', BLOCKING: 'P2', ...env } });
    const out = Object.fromEntries([...readFileSync(outputs, 'utf8').matchAll(/^(\w+)<<EOF_\1\n([\s\S]*?)\nEOF_\1$/gm)].map(m => [m[1], m[2]]));
    return { code: done.status, said: done.stderr.trim().split('\n').at(-1), out, summary: readFileSync(summary, 'utf8') };
  };
  const reviewCommit = env => run(['commit'], { REVIEWER: JSON.stringify({ agent: 'codex' }), BASE: base, HEAD: head, TASK: '把按钮改成蓝色。', ...env });
  const reviewPr = () => run([], { REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }),
    PULL_REQUEST: JSON.stringify({ number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'T', body: 'B', head: { sha: head, ref: 'f' }, base: { sha: base, ref: 'main' } }) });
  const read = file => existsSync(file) ? readFileSync(file, 'utf8') : '';
  return { base, head, reviewCommit, reviewPr, prompt: () => read(prompt), args: () => read(args), ghCalls: () => read(calls), clear: () => rmSync(calls, { force: true }) };
}

test('a commit is reviewed against its task, with no pull request, no gh and no comment', t => {
  const p = project(t);
  const done = p.reviewCommit({ FOCUS: '看颜色' });
  assert.equal(done.code, 0, done.said);
  const prompt = p.prompt();
  assert.ok(prompt.startsWith(`请对提交 ${p.head} 相对 ${p.base} 的改动做交叉评审。`), prompt.split('\n')[0]);
  for (const part of ['把按钮改成蓝色。', '任务书原文', `git diff ${p.base} ${p.head}`, `检出的就是被评审的提交 ${p.head}`, `来自 base 提交 ${p.base}`,
    '项目准则：只跑相关测试。', '看颜色']) assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /PR #|github\.com|gh pr|\{\{/);
  assert.equal(p.ghCalls(), '', 'gh is never called');
  assert.match(p.args(), new RegExp(`--commit ${p.head} --title 交叉评审 提交 ${p.head.slice(0, 12)} `));
  assert.deepEqual([done.out.head, done.out.base, done.out.pr], [p.head, p.base, undefined]);
  assert.match(done.out.report, /^看过了。\n```review\n/);
  assert.doesNotMatch(done.summary, /PR|评论/);
});

test('both entries read the same findings from the same reply; a commit gets every one of them', t => {
  const p = project(t);
  const commit = p.reviewCommit(), pr = p.reviewPr();
  assert.deepEqual([commit.code, pr.code], [0, 0]);
  const findings = JSON.parse(commit.out.findings);
  assert.deepEqual(findings, [{ severity: 'P1', title: '阻塞', location: 'a:1', detail: 'd' }, { severity: 'P3', title: '低优', location: '', detail: '' }]);
  assert.deepEqual([commit.out.decision, commit.out.line], [pr.out.decision, pr.out.line]);
  assert.equal(commit.out.decision, 'REQUEST_CHANGES');
  for (const f of findings) assert.ok(pr.out.report.includes(`**[${f.severity}]** ${f.title}`), f.title);
  // The pull request's review is as it was: its comment, its outputs, its opening line.
  assert.match(p.ghCalls(), /^pr comment https:\/\/github\.com\/acme\/app\/pull\/7 --body/);
  assert.deepEqual([pr.out.pr, pr.out.base, pr.out.findings], ['#7（https://github.com/acme/app/pull/7）', 'main', '- **[P1]** 阻塞（`a:1`）：d']);
  assert.ok(p.prompt().startsWith('请对 PR #7（https://github.com/acme/app/pull/7）做交叉评审。'));
  assert.ok(p.prompt().includes(`来自 PR base 提交 ${p.base}`));
});

test('a base or head that is not a commit of the project is refused, saying which', t => {
  const p = project(t);
  const missing = 'f'.repeat(40);
  assert.equal(p.reviewCommit({ HEAD: 'abc123' }).said, '被评审的提交 head 不是完整的提交号');
  assert.equal(p.reviewCommit({ BASE: '' }).said, '对照的提交 base 不是完整的提交号');
  const unknown = p.reviewCommit({ BASE: missing });
  assert.deepEqual([unknown.code, unknown.said], [1, `本地仓库里找不到提交 ${p.head.slice(0, 12)} 与 ${missing.slice(0, 12)} 的共同祖先`]);
  assert.equal(p.prompt(), '', 'no reviewer was asked');
});

test('the capability takes base, head, task, reviewer and focus, and gives the review step\'s outputs', async () => {
  const source = readFileSync(capability, 'utf8');
  assert.equal(await workflowProblem(source, 'review-commit'), null);
  assert.deepEqual([...source.matchAll(/<coda:input name="(\w+)"[^>]*\/>/g)].map(m => [m[1], m[0].includes('required="true"')]),
    [['base', true], ['head', true], ['task', true], ['reviewer', true], ['focus', false]]);
  assert.match(source, /<coda:input name="reviewer"[^>]*type="agent"/);
  assert.match(source, /scripts\/review\.mjs" commit</);
  const outputs = [...source.matchAll(/<coda:output name="(\w+)" value="=review\.(\w+)" \/>/g)];
  assert.deepEqual(outputs.map(m => m[1]), ['decision', 'findings', 'line', 'report', 'head', 'base']);
  assert.ok(outputs.every(m => m[1] === m[2]));
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/review/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contributes.capabilities, ['review-commit']);
});
