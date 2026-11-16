// 小改动免主控审查的资格判定（plugins/composer/scripts/minor.mjs）：纯函数，逐条核对放行条件。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoLandReasons, isMinorPath, parseRaw } from '../../../plugins/composer/scripts/minor.mjs';

const HEAD = 'a'.repeat(40);
const approve = (slot = 'reviewer', extra = {}) => ({ state: 'done', slot, reviewed: HEAD, decision: 'APPROVE', findings: '[]', ...extra });
const change = (path, status = 'A', modes = ['000000', '100644']) => ({ status, modes, paths: [path] });
const eligible = { auto: true, sync: false, head: HEAD, checks: { head: HEAD, runs: [] }, reviews: [approve(), { state: 'skipped' }], findings: [],
  changes: [change('test/plugins/x/a.test.mjs')], patches: { 'test/plugins/x/a.test.mjs': { added: ['+assert.ok(1);'], removed: [] } } };
const reasons = extra => autoLandReasons({ ...eligible, ...extra });

test('全部满足时可以免审', () => {
  assert.deepEqual(reasons({}), []);
  assert.deepEqual(reasons({ stack: { restacked: true } }), [], '叠放已重接');
  assert.deepEqual(reasons({ changes: [change('README.md'), change('plugins/composer/THIRD_PARTY_NOTICES.md', 'M')], patches: {} }), []);
});

test('开关、跟上目标分支、叠放未重接、检查、评审与账本：缺一条就不免审', () => {
  for (const [extra, text] of [
    [{ auto: false }, /没开/], [{ sync: true }, /跟上目标分支/], [{ stack: { restacked: false } }, /没有重接/],
    [{ checks: undefined }, /项目检查没有通过/], [{ checks: { head: 'b'.repeat(40) } }, /项目检查没有通过/],
    [{ reviews: [{ state: 'skipped' }, { state: 'skipped' }] }, /没有评审者/],
    [{ reviews: [approve(), { state: 'lost', slot: 'reviewer2' }] }, /第二评审者没评成/],
    [{ reviews: [approve('reviewer', { decision: 'INCOMPLETE' })] }, /INCOMPLETE/],
    [{ reviews: [approve('reviewer', { decision: 'REQUEST_CHANGES' })] }, /REQUEST_CHANGES/],
    [{ reviews: [approve('reviewer', { reviewed: 'b'.repeat(40) })] }, /评的不是当前 head/],
    [{ reviews: [approve('reviewer', { findings: '[{"severity":"P3"}]' })] }, /这次有发现/],
    [{ findings: [{ id: 'reviewer:1', status: 'open' }] }, /没关的发现/],
  ]) assert.match(reasons(extra).join('\n'), text, JSON.stringify(extra));
});

test('路径：只放行测试与非契约说明文档；源码、package.json、schema、.coda、.github、scripts、check、bin、docs、AGENTS.md、CLAUDE.md、.bpmn 一律不免审', () => {
  for (const path of ['test/plugins/composer/lane-pr.test.mjs', 'test/plugins/composer/fixtures/lane-pr-10.0.0.bpmn', 'plugins/x/a.test.js', 'App/FooTests.swift',
    'README.md', 'plugins/composer/README.md', 'THIRD_PARTY_NOTICES.md']) assert.ok(isMinorPath(path), path);
  for (const path of ['plugins/composer/scripts/lane-pr.mjs', 'plugins/composer/package.json', 'package-lock.json', 'plugins/x/schema.json',
    'plugins/composer/.coda/workflows/lane-pr.bpmn', '.github/workflows/ci.yml', 'scripts/a.test.mjs', 'check/agent.mjs', 'bin/check.mjs',
    'docs/workflows.md', 'docs/README.md', 'AGENTS.md', 'CLAUDE.md', 'plugins/x/docs/README.md', 'plugins/x/.coda/a.test.mjs',
    'test/AGENTS.md', 'test/CLAUDE.md', 'test/package.json', 'test/package-lock.json', 'test/.coda/live.bpmn', 'test/live.bpmn', 'test/.github/ci.yml',
    'test/scripts/a.test.mjs', 'test/plugins/x/docs/a.md']) assert.ok(!isMinorPath(path), path);
  assert.match(reasons({ changes: [{ status: 'R', modes: ['100644', '100644'], paths: ['plugins/x/a.mjs', 'test/a.test.mjs'] }], patches: {} }).join('\n'), /plugins\/x\/a\.mjs/, '重命名的旧路径也算');
  assert.match(reasons({ changes: [], patches: {} }).join('\n'), /没有改动的文件/);
  for (const mode of ['120000', '160000']) assert.match(reasons({ changes: [change('test/link', 'A', ['000000', mode])], patches: {} }).join('\n'), /符号链接或子模块/);
});

test('防删测与防跳过：删测试文件、新增 skip、todo 或 only、只删断言都不免审', () => {
  assert.match(reasons({ changes: [change('test/a.test.mjs', 'D', ['100644', '000000'])], patches: {} }).join('\n'), /删了测试文件/);
  // 原样重命名（R100、补丁里没有增删行）成说明文档：新旧路径都放行，但原测试不再被发现。
  const renamed = to => parseRaw([`:100644 100644 ${'1'.repeat(40)} ${'1'.repeat(40)} R100`, 'test/a.test.mjs', to, ''].join('\0'));
  assert.deepEqual(reasons({ changes: renamed('README.md'), patches: {} }), ['把测试文件 test/a.test.mjs 改成了非测试文件 README.md']);
  assert.deepEqual(reasons({ changes: renamed('test/b.test.mjs'), patches: { 'test/b.test.mjs': { added: [], removed: [] } } }), [], '测试改名成测试可以');
  for (const line of ["+test.skip('x', () => {});", "+it.todo('x');", "+test('x', { skip: true }, () => {});", "+test('x', {todo: 'later'}, () => {});",
    '+  skip: true,', "+  timeout: 5, todo: 'later',", "+test.only('x', () => {});", "+describe.only('x', () => {});", "+test('x', { only: true }, () => {});", '+  only: true,']) {
    assert.match(reasons({ patches: { 'test/a.test.mjs': { added: [line, '+assert.ok(1);'], removed: [] } } }).join('\n'), /新增了 skip、todo 或 only/, line);
  }
  for (const line of ["+{ state: 'skipped' }", "+  assert.deepEqual(outputs, { only: '[]' });"]) {
    assert.deepEqual(reasons({ patches: { 'test/a.test.mjs': { added: [line, '+assert.ok(1);'], removed: [] } } }), [], `${line} 不算`);
  }
  assert.match(reasons({ patches: { 'test/a.test.mjs': { added: ['+console.log(1);'], removed: ['-  assert.equal(1, 1);'] } } }).join('\n'), /删了断言/);
  assert.deepEqual(reasons({ patches: { 'test/a.test.mjs': { added: ['+  assert.equal(2, 2);'], removed: ['-  assert.equal(1, 1);'] } } }), [], '改写断言可以');
});

test('parseRaw 读 git diff --raw -z -M：状态、mode 与路径，重命名带新旧两个路径', () => {
  const z = [':000000 100644 0000 1111 A', 'test/a.test.mjs', ':100644 100644 2222 3333 R087', 'old.md', 'README.md', ':100644 000000 4444 0000 D', 'test/b.test.mjs', ''].join('\0');
  assert.deepEqual(parseRaw(z), [
    { status: 'A', modes: ['000000', '100644'], paths: ['test/a.test.mjs'] },
    { status: 'R', modes: ['100644', '100644'], paths: ['old.md', 'README.md'] },
    { status: 'D', modes: ['100644', '000000'], paths: ['test/b.test.mjs'] }]);
  assert.deepEqual(parseRaw(''), []);
});
