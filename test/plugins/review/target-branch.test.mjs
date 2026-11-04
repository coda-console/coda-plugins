import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate } from 'feelin';

const scripts = fileURLToPath(new URL('../../../plugins/review/scripts/', import.meta.url));
const head = 'a'.repeat(40), url = 'https://github.com/acme/app/pull/4';
const workflow = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-target-')), bin = join(root, 'bin');
  const outputs = join(root, 'outputs'), summary = join(root, 'summary.md'), log = join(root, 'gh.jsonl');
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'api') console.log(JSON.stringify({ base: process.env.FAKE_BASE, main: process.env.FAKE_MAIN }));
else if (args[0] === 'repo' && args[1] === 'view') {
  if (process.env.FAKE_ERROR) { console.error(process.env.FAKE_ERROR); process.exit(1); }
  console.log(process.env.FAKE_MAIN);
} else if (args[0] !== 'pr' || args[1] !== 'merge') process.exit(1);
`, { mode: 0o755 });
  return (name, env = {}) => {
    for (const file of [outputs, summary, log]) writeFileSync(file, '');
    const done = spawnSync(process.execPath, [join(scripts, `${name}.mjs`)], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log,
        GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary, CODA_PLUGIN_SETTINGS: '{}',
        URL: url, HEAD: head, METHOD: 'squash', TARGET: '', APPROVED: '{}', FAKE_BASE: 'main', FAKE_MAIN: 'main', FAKE_ERROR: '', ...env },
    });
    return { code: done.status, stdout: done.stdout.trim(), stderr: done.stderr.trim(),
      outputs: Object.fromEntries([...readFileSync(outputs, 'utf8').matchAll(/^(\w+)<<EOF_\1\n([\s\S]*?)\nEOF_\1$/gm)].map(match => [match[1], match[2]])),
      summary: readFileSync(summary, 'utf8'), calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
}

test('the target command reads the directory settings; an empty value queries the repository default and failures are reported', t => {
  const run = setup(t);
  for (const target of ['develop', 'release/2026.11', ' main ']) {
    const result = run('target-branch', { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'review.targetBranch': target }) });
    assert.deepEqual([result.code, result.stdout, result.calls], [0, target.trim(), []]);
  }
  for (const settings of [{}, { 'review.targetBranch': '' }, { 'review.targetBranch': '  ' }]) {
    const result = run('target-branch', { CODA_PLUGIN_SETTINGS: JSON.stringify(settings), FAKE_MAIN: 'trunk' });
    assert.deepEqual([result.code, result.stdout, result.calls], [0, 'trunk', [['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']]]);
  }
  const failed = run('target-branch', { FAKE_ERROR: 'HTTP 403' });
  assert.deepEqual([failed.code, failed.stdout], [1, '']);
  assert.match(failed.stderr, /读不到仓库默认分支：HTTP 403/);
  for (const branch of ['', 'null']) assert.equal(run('target-branch', { FAKE_MAIN: branch }).code, 1);
});

test('the base check waits only when the PR base differs from the configured target, with the repository default used when empty', t => {
  const run = setup(t);
  for (const [target, base, main, effective, stacked] of [
    ['', 'main', 'main', 'main', 'false'],
    ['', 'below', 'trunk', 'trunk', 'true'],
    ['develop', 'develop', 'main', 'develop', 'false'],
    ['develop', 'main', 'main', 'develop', 'true'],
    ['release/2026.11', 'feature/a', 'main', 'release/2026.11', 'true'],
    ['  ', 'trunk', 'trunk', 'trunk', 'false'],
  ]) {
    const result = run('base', { TARGET: target, FAKE_BASE: base, FAKE_MAIN: main });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.outputs, { stacked, base, target: effective });
    if (stacked === 'true') {
      assert.ok(result.summary.includes(`当前 base 为 ${base}，等待改到合并目标分支 ${effective}`));
      assert.match(result.summary, /不会自动修改 PR 的 base/);
    } else assert.equal(result.summary, '');
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0].slice(0, 2), ['api', 'repos/acme/app/pulls/4']);
  }
});

test('merging a configured non-default branch keeps the reviewed head guard and the selected follow-up actions', t => {
  const run = setup(t);
  for (const target of ['develop', 'release/2026.11']) {
    const approved = run('approval', { BASE: target,
      APPROVED: JSON.stringify({ options: { deploy: true, preview: true, notify: true } }) });
    assert.equal(approved.code, 0, approved.stderr);
    assert.deepEqual([approved.outputs.base, approved.outputs.deleteBranch, approved.outputs.deploy, approved.outputs.release, approved.outputs.releaseKinds, approved.outputs.notify],
      [target, 'false', 'true', 'true', 'preview', 'true']);
    const result = run('merge', { TARGET: target, FAKE_BASE: target, METHOD: 'rebase', WHAT: approved.outputs.what });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.calls[1], ['pr', 'merge', url, '--rebase', '--match-head-commit', head]);
    assert.deepEqual(result.outputs, { merged: 'true', refused: 'false', reason: '' });
    assert.ok(result.summary.includes(approved.outputs.what));
    assert.ok(result.summary.includes(`合并到 ${target}`));
  }
  const defaulted = run('merge');
  assert.equal(defaulted.outputs.merged, 'true');
  assert.deepEqual(defaulted.calls[1], ['pr', 'merge', url, '--squash', '--match-head-commit', head]);
});

test('a base changed on GitHub cannot merge into another branch or follow a newly changed repository default', t => {
  const run = setup(t);
  for (const [target, base, main] of [['develop', 'main', 'main'], ['main', 'develop', 'develop'], ['release/2026.11', 'below', 'main']]) {
    const result = run('merge', { TARGET: target, FAKE_BASE: base, FAKE_MAIN: main });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual([result.outputs.merged, result.outputs.refused], ['false', 'true']);
    assert.ok(result.outputs.reason.includes(`base 是 ${base}，不是合并目标分支 ${target}`));
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0].slice(0, 2), ['api', 'repos/acme/app/pulls/4']);
  }
});

test('the workflow passes the displayed target to merge and invalidates approval even after base changes back', () => {
  const merge = /<scriptTask id="merge"[\s\S]*?<\/scriptTask>/.exec(workflow)[0];
  const target = /<coda:env name="TARGET" value="=([^"]+)"/.exec(merge)[1];
  assert.equal(evaluate(target, { based: { target: 'develop' }, vars: { review: { targetBranch: '' } } }).value, 'develop');
  const condition = /<sequenceFlow id="as-approved"[\s\S]*?<conditionExpression[^>]*>=([^<]+)<\/conditionExpression>/.exec(workflow)[1];
  for (const [base, changedAt, changesAt, allowed] of [
    ['main', null, 10, true],
    ['main', 20, 10, true],
    ['main', 40, 10, false],
    ['develop', 20, 10, false],
    ['main', 20, 40, false],
  ]) {
    const variables = { approval: { base: 'main', at: '30' }, based: { base }, review: { changesAt: String(changesAt) }, 'base-changed': { at: changedAt === null ? null : String(changedAt) } };
    assert.equal(evaluate(condition, variables).value, allowed);
  }
});
