// A pull request on any GitHub host (github.com or an Enterprise one): its address is parsed in one place, the key of both
// flows keeps hosts apart, and every gh call of the scripts names the host the address names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';
import { parsePrUrl } from '../../../plugins/review/scripts/step.mjs';

const script = name => fileURLToPath(new URL(`../../../plugins/review/scripts/${name}.mjs`, import.meta.url));
const GHE = ['https://git.example.org/acme/app/pull/7', 'https://ghe.corp.internal/acme/app/pull/7'];
const PUBLIC = 'https://github.com/acme/app/pull/7';
// 4 labels of 63 characters: 255 characters, over the 253 a host may have; dropping two characters gives 253.
const LONG = ['a', 'b', 'c', 'd'].map(c => c.repeat(63)).join('.'), LONG_OK = LONG.slice(0, -2);
const SECRET = 'https://x-access-token:FAKE_TOKEN_123@git.example.org/example/coda';
const BAD = ['http://github.com/acme/app/pull/7', 'https://github/acme/app/pull/7', 'https://localhost/acme/app/pull/7',
  'https://user@github.com/acme/app/pull/7', 'https://github.com:443/acme/app/pull/7', 'https://-ghe.example.org/acme/app/pull/7',
  'https://ghe..example.org/acme/app/pull/7', 'https://github.com/./app/pull/7', 'https://github.com/acme/../pull/7',
  'https://github.com/acme/app/pull/0', 'https://github.com/acme/app/pull/07', 'https://github.com/acme/app/pull/7/files',
  'https://github.com/acme/app/pull/7?q=1', 'https://github.com/acme/app/pull/7#top', 'https://github.com/acme/app/pull/7/',
  'https://github.com/acme/app/pull/7x', 'https://github.com/acme/app/pull/7\n', ' https://github.com/acme/app/pull/7',
  'https://github.com/acme/app/pull/7 ', 'https://github.com/acme/app/issues/7', 'https://github.com/acme/pull/7', '', null, undefined,
  'https://127.0.0.1/acme/app/pull/1', 'https://ghe.example.123/acme/app/pull/1', `https://${LONG}/acme/app/pull/1`];

test('parsePrUrl takes the standard HTTPS address of any host and nothing else', () => {
  assert.deepEqual(parsePrUrl(PUBLIC), { host: 'github.com', owner: 'acme', name: 'app', repo: 'acme/app', number: '7', url: PUBLIC });
  assert.deepEqual(parsePrUrl('HTTPS://Git.Example.ORG/Acme/App.js/pull/42'),
    { host: 'git.example.org', owner: 'Acme', name: 'App.js', repo: 'Acme/App.js', number: '42', url: 'https://git.example.org/Acme/App.js/pull/42' });
  for (const url of GHE) assert.equal(parsePrUrl(url).host, new URL(url).host);
  assert.equal(parsePrUrl('https://github.com/.../.a/pull/1').repo, '.../.a');
  assert.equal(parsePrUrl('https://github.com/acme/app/PULL/7'), null, '/pull/ is lower case, as gh has it');
  assert.equal(parsePrUrl('https://github.com/acme/app/Pull/7'), null);
  for (const url of BAD) assert.equal(parsePrUrl(url), null, String(url));
  assert.equal(LONG.length, 255);
  assert.equal(LONG_OK.length, 253);
  assert.equal(parsePrUrl(`https://${LONG_OK}/acme/app/pull/1`).host, LONG_OK);
  assert.equal(parsePrUrl('https://xn--nxasmq6b.example.org/acme/app/pull/1').host, 'xn--nxasmq6b.example.org');
  assert.equal(parsePrUrl('https://ghe.example.org2/acme/app/pull/1').host, 'ghe.example.org2');
});

for (const flow of ['pull-request', 'pull-request-review']) {
  test(`${flow} keys a manual PR by host, as the event does, and refuses what parsePrUrl refuses`, async () => {
    const source = readFileSync(new URL(`../../../plugins/review/.coda/workflows/${flow}.bpmn`, import.meta.url), 'utf8');
    const { root, problem } = await readWorkflow(source, flow); assert.ok(!problem, problem);
    const expression = root.rootElements.find(e => e.$type === 'bpmn:Process').key?.replace(/^=/, '');
    assert.ok(expression);
    const key = (pr, event = {}) => evaluate(expression, { inputs: { pr }, github: { event } }).value;
    for (const url of [PUBLIC, ...GHE, 'https://github.com/.../app/pull/7']) {
      assert.equal(key(url), url.toLowerCase(), url);
      assert.equal(key('', { number: 7, pull_request: { html_url: url } }), url.toLowerCase());
    }
    assert.equal(key('https://GHE.Corp.Internal/Acme/App/pull/7'), GHE[1]);
    assert.equal(key('HTTPS://GHE.Corp.Internal/Acme/App/pull/7'), GHE[1]);
    for (const url of ['https://github.com/acme/app/PULL/7', 'https://github.com/acme/app/Pull/7']) assert.equal(key(url), null, url);
    const keys = [PUBLIC, ...GHE, 'https://git.example.org/other/app/pull/7', 'https://git.example.org/acme/app/pull/8'].map(url => key(url));
    assert.equal(new Set(keys).size, keys.length, 'the same owner/name and number on another host is another run');
    for (const url of BAD.filter(Boolean)) assert.equal(key(url), null, url);
    assert.equal(key(`https://${LONG_OK}/acme/app/pull/1`), `https://${LONG_OK}/acme/app/pull/1`);
  });
}

// gh notes its arguments and GH_REPO; it answers the author question with true, the base with main (or STACKED_ON), no checks, and a merge ok.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), calls = join(root, 'calls'), outputs = join(root, 'outputs'), summary = join(root, 'summary.md');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, repo: process.env.GH_REPO }) + '\\n');
if (args[0] === 'api' && args.includes('graphql')) console.log('true');
else if (args[0] === 'api') console.log(JSON.stringify({ base: process.env.STACKED_ON ?? 'main', main: 'main' }));
else if (args[1] === 'checks') console.log('[]');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const run = (name, env) => {
    for (const file of [calls, outputs, summary]) writeFileSync(file, '');
    const done = spawnSync(process.execPath, [script(name)], { encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary, ...env } });
    return { code: done.status, said: done.stderr.trim(), summary: readFileSync(summary, 'utf8'), outputs: readFileSync(outputs, 'utf8'),
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
  return { run };
}

test('who wrote it is asked of the PR\'s own host; GH_REPO names the host only where it is not github.com', t => {
  const f = fixture(t);
  for (const [url, repo, host] of [[PUBLIC, 'acme/app', 'github.com'], [GHE[0], 'git.example.org/acme/app', 'git.example.org'], [GHE[1], 'ghe.corp.internal/acme/app', 'ghe.corp.internal']]) {
    const done = f.run('mine', { URL: url });
    assert.equal(done.code, 0, done.said);
    assert.match(done.outputs, /mine<<EOF_mine\ntrue\nEOF_mine/);
    assert.deepEqual(done.calls.map(c => [c.repo, c.args.slice(0, 4)]), [[repo, ['api', 'graphql', '--hostname', host]]]);
  }
  for (const url of BAD.filter(Boolean)) {
    const done = f.run('mine', { URL: url });
    assert.deepEqual([done.code, done.calls.length, done.outputs], [1, 0, ''], url);
    assert.match(done.said, /不是 GitHub 上的 PR/);
    assert.match(done.summary, /没能确认/);
  }
  assert.equal(f.run('mine', {}).code, 1, 'no address at all');
});

test('the base is read, the checks waited for and the merge made on the PR\'s own host', t => {
  const f = fixture(t), head = 'a'.repeat(40);
  for (const url of [PUBLIC, ...GHE]) {
    const { host, repo } = parsePrUrl(url);
    const base = f.run('base', { URL: url });
    assert.equal(base.code, 0, base.said);
    assert.deepEqual(base.calls.map(c => c.args.slice(0, 3)), [['api', '--hostname', host]]);
    assert.ok(base.calls[0].args.includes(`repos/${repo}/pulls/7`));
    const stacked = f.run('base', { URL: url, STACKED_ON: 'feature' });
    assert.equal(stacked.code, 0, stacked.said);
    assert.ok(stacked.summary.includes(`\`gh pr edit ${url} --base main\``), `the command names the full address: ${stacked.summary}`);
    const checks = f.run('checks', { URL: url });
    assert.equal(checks.code, 0, checks.said);
    assert.deepEqual(checks.calls.map(c => c.args.slice(0, 3)), [['pr', 'checks', url]]);
    const merge = f.run('merge', { URL: url, HEAD: head, METHOD: 'squash', WHAT: '合并' });
    assert.equal(merge.code, 0, merge.said);
    assert.deepEqual(merge.calls.map(c => c.args.slice(0, 3)), [['api', '--hostname', host], ['pr', 'merge', url]]);
    assert.match(merge.outputs, /merged<<EOF_merged\ntrue\n/);
  }
  for (const url of BAD.filter(Boolean)) {
    const checks = f.run('checks', { URL: url });
    assert.deepEqual([checks.code, checks.said, checks.calls.length], [1, '不是 GitHub 上的 PR，需要标准 HTTPS PR 地址', 0], url);
    const merge = f.run('merge', { URL: url, HEAD: head });
    assert.deepEqual([merge.code, merge.said, merge.calls.length], [1, '不知道要合并哪个 PR 的哪个提交', 0], url);
    const base = f.run('base', { URL: url });
    assert.deepEqual([base.code, base.calls.length], [1, 0], url);
  }
});

test('a manual review takes the PR address as given: with a space around it, it is refused before gh is asked', t => {
  const f = fixture(t), env = { REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }), SESSION: JSON.stringify({ agent: 'codex' }) };
  for (const pr of [`${GHE[0]} `, ` ${GHE[0]}`]) {
    const done = f.run('review', { ...env, PR: pr });
    assert.deepEqual([done.code, done.said, done.calls.length], [1, '不是 GitHub 上的 PR，需要标准 HTTPS PR 地址', 0], JSON.stringify(pr));
  }
});

test('an address that is refused is not echoed: the credentials in it reach neither stderr nor the summary', t => {
  const f = fixture(t);
  for (const url of [`${SECRET}.git`, `${SECRET}/pull/1`]) {
    for (const [name, env] of [['mine', { URL: url }], ['checks', { URL: url }], ['base', { URL: url }]]) {
      const done = f.run(name, env);
      assert.deepEqual([done.code, done.calls.length], [1, 0], `${name} ${url}`);
      assert.doesNotMatch(done.said + done.summary, /FAKE_TOKEN_123/, `${name} ${url}`);
    }
  }
});
