// 评审意见的分流（plugins/composer/scripts/triage.mjs）：纯函数，输入是评审子流程各份的输出。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyText, readResponses, triage, triageOverall } from '../../../plugins/composer/scripts/triage.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const done = (slot, findings, extra = {}) => ({ state: 'done', slot, who: '{}', head: HEAD, reviewed: HEAD, decision: findings.length ? 'COMMENT' : 'APPROVE', line: '评审通过',
  findings: JSON.stringify(findings), resolutions: '[]', blocking: 'P2', ...extra });
const finding = (severity, kind, title = `${severity} ${kind}`) => ({ severity, ...kind === undefined ? {} : { kind }, title, location: 'a.mjs:1', detail: '说明' });

test('没有阻塞级发现照常交主 Agent；有阻塞级的非契约类交执行者；契约或范围类升级', () => {
  assert.equal(triage([done('reviewer', [finding('P3', 'style')]), { state: 'skipped' }], { head: HEAD, full: true }).route, 'pass');
  assert.equal(triage([done('reviewer', [])], { head: HEAD, full: true }).route, 'pass');
  for (const kind of ['correctness', 'test-quality', 'documentation', 'style']) assert.equal(triage([done('reviewer', [finding('P2', kind)])], { head: HEAD, full: true }).route, 'fix', kind);
  for (const kind of ['contract', 'scope']) {
    const result = triage([done('reviewer', [finding('P1', 'correctness')]), done('reviewer2', [finding('P3', kind)])], { head: HEAD, full: true });
    assert.equal(result.route, 'escalate', kind);
    assert.match(result.reasons.join(), new RegExp(`reviewer2:1 涉及.*（${kind}）`));
  }
  // 阻塞级别按评审结果带的设置：P1 时 P2 不阻塞。
  assert.equal(triage([done('reviewer', [finding('P2', 'correctness')], { blocking: 'P1' })], { head: HEAD, full: true }).route, 'pass');
});

test('kind 缺失或不认识按 correctness：照样交执行者，不升级', () => {
  // review-commit 已把缺失、不认识的归成 correctness；分流只认 contract、scope 两类升级，别的一律按正确性处理。
  for (const kind of [undefined, 'nonsense']) assert.equal(triage([done('reviewer', [finding('P2', kind)])], { head: HEAD, full: true }).route, 'fix', String(kind));
});

test('没评成（INCOMPLETE，findings 为空）、调用没成、评的不是当前 head：都不当通过，升级', () => {
  const incomplete = done('reviewer', [], { decision: 'INCOMPLETE', line: '评审没有完成：评审方没有按格式给出结论' });
  for (const [results, text] of [
    [[incomplete, done('reviewer2', [])], /评审者没评成：评审没有完成/],
    [[{ state: 'lost', slot: 'reviewer2', who: '{}', head: HEAD }], /第二评审者没评成：调用 review-commit 没有成功/],
    [[done('reviewer', [], { reviewed: OLD })], new RegExp(`评的是 ${OLD.slice(0, 12)}，不是当前 head ${HEAD.slice(0, 12)}，结果不算数`)],
  ]) {
    const result = triage(results, { head: HEAD, full: true });
    assert.equal(result.route, 'escalate');
    assert.match(result.reasons.join('；'), text);
  }
  // 拒收的结果里的发现不记。
  assert.deepEqual(triage([done('reviewer', [finding('P1', 'correctness')], { reviewed: OLD })], { head: HEAD, full: true }).findings, []);
});

test('编号固定：各位置从 1 起，复评的新发现接着编，旧编号不变；完整评审作废之前没关的', () => {
  const first = triage([done('reviewer', [finding('P2', 'correctness', 'x'), finding('P3', 'style', 'y')]), done('reviewer2', [finding('P1', 'correctness', 'z')])], { head: HEAD, full: true });
  assert.deepEqual(first.findings.map(f => [f.id, f.title, f.blocking, f.status]), [['reviewer:1', 'x', true, 'open'], ['reviewer:2', 'y', false, 'open'], ['reviewer2:1', 'z', true, 'open']]);
  assert.deepEqual(first.added, ['reviewer:1', 'reviewer:2', 'reviewer2:1']);
  const resolutions = JSON.stringify([{ id: 'reviewer:1', status: 'resolved', reason: '' }, { id: 'reviewer:2', status: 'withdrawn', reason: '' }]);
  const again = triage([done('reviewer', [finding('P3', 'style', 'w')], { resolutions }), done('reviewer2', [], { resolutions: JSON.stringify([{ id: 'reviewer2:1', status: 'resolved', reason: 'ok' }]) })],
    { head: HEAD, findings: first.findings, rounds: 1 });
  assert.deepEqual(again.findings.map(f => [f.id, f.status]), [['reviewer:1', 'resolved'], ['reviewer:2', 'withdrawn'], ['reviewer2:1', 'resolved'], ['reviewer:3', 'open']]);
  assert.equal(again.route, 'pass');
  assert.deepEqual(again.resolutions.map(r => r.id), ['reviewer:1', 'reviewer:2', 'reviewer2:1']);
  assert.ok(first.findings.every(f => f.status === 'open'), '不改传进来的');
  const full = triage([done('reviewer', [])], { head: HEAD, findings: first.findings, full: true });
  assert.deepEqual(full.findings.map(f => f.status), ['superseded', 'superseded', 'superseded']);
  assert.equal(full.route, 'pass');
  assert.deepEqual(triage([done('reviewer', [finding('P2', 'style')])], { head: HEAD, findings: first.findings, full: true }).added, ['reviewer:3']);
});

test('复评：修过仍被坚持的再交执行者，到两轮升级；执行者反驳后评审者仍坚持的直接升级', () => {
  const first = triage([done('reviewer', [finding('P2', 'correctness')])], { head: HEAD, full: true });
  const upheld = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '没修好' }]);
  const fixed = first.findings.map(f => ({ ...f, response: { disposition: 'fixed', commit: HEAD } }));
  assert.equal(triage([done('reviewer', [], { resolutions: upheld })], { head: HEAD, findings: fixed, rounds: 1 }).route, 'fix');
  const limit = triage([done('reviewer', [], { resolutions: upheld })], { head: HEAD, findings: fixed, rounds: 2 });
  assert.deepEqual([limit.route, limit.reasons], ['escalate', ['自动修了 2 轮仍有阻塞级发现']]);
  // 第一次完整评审没有阻塞级发现时，轮数用完也照常通过。
  assert.equal(triage([done('reviewer', [])], { head: HEAD, rounds: 2, full: true }).route, 'pass');
  const disputed = first.findings.map(f => ({ ...f, response: { disposition: 'disputed', reason: '不成立' } }));
  const kept = triage([done('reviewer', [], { resolutions: upheld })], { head: HEAD, findings: disputed, rounds: 1 });
  assert.deepEqual([kept.route, kept.reasons], ['escalate', ['reviewer:1：执行者反驳了，评审者仍坚持']]);
  assert.equal(kept.findings[0].status, 'open');
  // 反驳成立就撤回、关闭。
  assert.equal(triage([done('reviewer', [], { resolutions: JSON.stringify([{ id: 'reviewer:1', status: 'withdrawn', reason: '' }]) })], { head: HEAD, findings: disputed, rounds: 1 }).route, 'pass');
});

test('执行者的回应：只收交给它的编号和合法的 disposition，取最后一个 responses 代码块', () => {
  const answer = ['改好了。', '```responses', '{"responses":[{"id":"x:9"}]}', '```', '最后的：', '```responses',
    JSON.stringify({ responses: [{ id: 'reviewer:1', disposition: 'fixed', commit: 'abc', reason: ' 修了 ' }, { id: 'reviewer:2', disposition: 'maybe' }, { id: 'other:1', disposition: 'fixed' },
      { id: 'reviewer2:1', disposition: 'disputed', reason: '不成立', evidence: 'a.mjs:3' }] }), '```'].join('\n');
  assert.deepEqual(readResponses(answer, ['reviewer:1', 'reviewer:2', 'reviewer2:1']), {
    'reviewer:1': { disposition: 'fixed', commit: 'abc', reason: '修了', evidence: '' },
    'reviewer2:1': { disposition: 'disputed', commit: '', reason: '不成立', evidence: 'a.mjs:3' },
  });
  for (const answer of ['没有代码块', '```responses\n不是 JSON\n```', undefined]) assert.deepEqual(readResponses(answer, ['reviewer:1']), {});
});

test('收敛经过：每轮的发现、回应与结论', () => {
  const text = historyText([
    { kind: 'review', full: true, head: HEAD, resolutions: [], added: [{ id: 'reviewer:1', severity: 'P2', kind: 'correctness', blocking: true, title: '漏了\n失败路径', location: 'a:1' }], route: 'fix', reasons: [] },
    { kind: 'fix', round: 1, from: HEAD, head: OLD, ids: ['reviewer:1', 'reviewer:2'], responses: { 'reviewer:1': { disposition: 'disputed', reason: '不成立', evidence: 'e' } }, note: '' },
    { kind: 'review', full: false, head: OLD, resolutions: [{ id: 'reviewer:1', status: 'upheld', reason: '仍成立' }], added: [], route: 'escalate', reasons: ['reviewer:1：执行者反驳了，评审者仍坚持'] },
  ]);
  for (const part of [`评审（head ${HEAD.slice(0, 12)}）：`, '- reviewer:1 [P2·correctness·阻塞] 漏了 失败路径（a:1）', '结论：交执行者逐条修复或反驳',
    `交执行者修第 1 轮（${HEAD.slice(0, 12)} → ${OLD.slice(0, 12)}）：`, '- reviewer:1：disputed：不成立；证据：e', '- reviewer:2：没有按格式回应',
    `复评（head ${OLD.slice(0, 12)}）：`, '- reviewer:1 → upheld：仍成立', '结论：升级给主 Agent：reviewer:1：执行者反驳了，评审者仍坚持']) assert.ok(text.includes(part), part);
});

// 监督开发的整体评审：同一本账，路由按严重程度与类别。
const overall = (results, options = {}) => triageOverall(results, { head: HEAD, full: true, ...options });

test('收敛经过带原发现的说明：新发现写全 detail，复评坚持的在那一轮下面再列原发现，只取最后一轮也看得到', () => {
  const detail = '入口函数没处理空输入\n复现：传 ""', first = overall([done('reviewer', [{ ...finding('P2', 'documentation', 'README 漏了'), detail }])]);
  const disputed = first.findings.map(f => ({ ...f, response: { disposition: 'disputed', reason: '写了' } }));
  const upheld = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '没写' }]);
  const second = overall([done('reviewer', [], { resolutions: upheld })], { findings: disputed, rounds: 1, full: false });
  assert.equal(second.route, 'escalate');
  assert.deepEqual(second.resolutions, [{ id: 'reviewer:1', status: 'upheld', reason: '没写',
    finding: { id: 'reviewer:1', severity: 'P2', kind: 'documentation', blocking: true, title: 'README 漏了', location: 'a.mjs:1', detail } }]);
  const history = [
    { kind: 'review', full: true, head: HEAD, resolutions: first.resolutions, added: first.findings, route: first.route, reasons: first.reasons },
    { kind: 'fix', round: 1, from: HEAD, head: HEAD, ids: ['reviewer:1'], responses: { 'reviewer:1': { disposition: 'disputed', reason: '写了' } }, note: '' },
    { kind: 'review', full: false, head: HEAD, resolutions: second.resolutions, added: [], route: second.route, reasons: second.reasons },
  ];
  assert.ok(historyText(history).includes('- reviewer:1 [P2·documentation·阻塞] README 漏了（a.mjs:1）\n  入口函数没处理空输入\n  复现：传 ""\n'), '第 1 轮的新发现带说明');
  assert.equal(historyText(history.slice(-1)), `复评（head ${HEAD.slice(0, 12)}）：\n- reviewer:1 → upheld：没写\n  - reviewer:1 [P2·documentation·阻塞] README 漏了（a.mjs:1）\n    入口函数没处理空输入\n    复现：传 ""\n`
    + '结论：升级给主 Agent：reviewer:1：执行者反驳了，评审者仍坚持');
  // 没被坚持的结论只有一行。
  const resolved = overall([done('reviewer', [], { resolutions: JSON.stringify([{ id: 'reviewer:1', status: 'resolved', reason: '' }]) })], { findings: disputed, rounds: 1, full: false });
  assert.deepEqual(resolved.resolutions, [{ id: 'reviewer:1', status: 'resolved', reason: '' }]);
});


test('整体评审：只有 P3 或没有发现直接验收；P2 全是测试、文档、风格类交执行者；不看 review 设置的阻塞级别', () => {
  assert.equal(overall([done('reviewer', [])]).route, 'accept');
  const minor = overall([done('reviewer', [finding('P3', 'style'), finding('P3', 'correctness')]), done('reviewer2', [finding('P3', 'test-quality')]), { state: 'skipped' }]);
  assert.deepEqual([minor.route, minor.reasons], ['accept', []]);
  assert.deepEqual(minor.findings.map(f => [f.id, f.status]), [['reviewer:1', 'open'], ['reviewer:2', 'open'], ['reviewer2:1', 'open']], 'P3 留在账上，交汇报');
  for (const kind of ['test-quality', 'documentation', 'style']) assert.equal(overall([done('reviewer', [finding('P2', kind), finding('P3', 'correctness')])]).route, 'fix', kind);
  assert.equal(overall([done('reviewer', [finding('P2', 'style')], { blocking: 'P1' })]).route, 'fix', 'P2 不阻塞的设置下也照样修');
});

test('整体评审：P0、P1、正确性类的 P2、任何级别的契约或范围类、没评成、评的不是当前 head、没填执行者，都交主 Agent', () => {
  for (const [results, text] of [
    [[done('reviewer', [finding('P1', 'style')])], /reviewer:1 是 P1/],
    [[done('reviewer', [finding('P0', 'documentation')])], /reviewer:1 是 P0/],
    [[done('reviewer', [finding('P2', 'style'), finding('P2', 'correctness')])], /reviewer:2 是 correctness 类的 P2/],
    [[done('reviewer', [finding('P2', 'nonsense')])], /reviewer:1 是 nonsense 类的 P2/],
    [[done('reviewer', [finding('P3', 'contract')])], /reviewer:1 涉及对外契约（contract）/],
    [[done('reviewer', [finding('P3', 'scope')])], /reviewer:1 涉及任务范围（scope）/],
    [[done('reviewer', [], { decision: 'INCOMPLETE', line: '评审没有完成：超时' })], /评审者没评成：评审没有完成：超时/],
    [[{ state: 'lost', slot: 'reviewer3', who: '{}', head: HEAD }], /第三评审者没评成/],
    [[done('reviewer', [finding('P3', 'style')], { reviewed: OLD })], /不是当前 head/],
  ]) {
    const result = overall(results);
    assert.equal(result.route, 'escalate', String(text));
    assert.match(result.reasons.join('；'), text);
  }
  const unfixed = overall([done('reviewer', [finding('P2', 'documentation')])], { fixer: false });
  assert.deepEqual([unfixed.route, unfixed.reasons], ['escalate', ['有 P2 发现，但没填开工执行者，不能自动修']]);
  assert.equal(overall([done('reviewer', [finding('P3', 'style')])], { fixer: false }).route, 'accept', '只有 P3 不需要执行者');
});

test('整体评审：最多自动修两轮；反驳被坚持交主 Agent；修好了只剩 P3 直接验收', () => {
  const first = overall([done('reviewer', [finding('P2', 'documentation'), finding('P3', 'style')])]);
  assert.equal(first.route, 'fix');
  const fixed = first.findings.map(f => f.id === 'reviewer:1' ? { ...f, response: { disposition: 'fixed', commit: HEAD } } : f);
  const upheld = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '没改全' }]);
  assert.equal(overall([done('reviewer', [], { resolutions: upheld })], { findings: fixed, rounds: 1, full: false }).route, 'fix');
  const limit = overall([done('reviewer', [], { resolutions: upheld })], { findings: fixed, rounds: 2, full: false });
  assert.deepEqual([limit.route, limit.reasons], ['escalate', ['自动修了 2 轮仍有 P2 发现']]);
  const disputed = first.findings.map(f => f.id === 'reviewer:1' ? { ...f, response: { disposition: 'disputed', reason: '文档本来就对' } } : f);
  const kept = overall([done('reviewer', [], { resolutions: upheld })], { findings: disputed, rounds: 1, full: false });
  assert.deepEqual([kept.route, kept.reasons], ['escalate', ['reviewer:1：执行者反驳了，评审者仍坚持']]);
  // 复评新提的问题照样分流：新的正确性 P2 交主 Agent。
  const resolved = JSON.stringify([{ id: 'reviewer:1', status: 'resolved', reason: '' }]);
  assert.equal(overall([done('reviewer', [finding('P2', 'correctness')], { resolutions: resolved })], { findings: fixed, rounds: 1, full: false }).route, 'escalate');
  const done2 = overall([done('reviewer', [], { resolutions: resolved })], { findings: fixed, rounds: 2, full: false });
  assert.deepEqual([done2.route, done2.findings.filter(f => f.status === 'open').map(f => f.id)], ['accept', ['reviewer:2']], '只剩 P3：轮数用完也直接验收');
});

test('整体评审与块同样的发现、不同的路由：同一本账，编号与结论一致', () => {
  const results = [done('reviewer', [finding('P2', 'correctness'), finding('P3', 'style')]), done('reviewer2', [finding('P2', 'style')])];
  const pieceRoute = triage(results, { head: HEAD, full: true }), whole = overall(results);
  assert.deepEqual([pieceRoute.route, whole.route], ['fix', 'escalate']);
  assert.deepEqual(whole.findings, pieceRoute.findings);
  assert.deepEqual([whole.added, whole.resolutions], [pieceRoute.added, pieceRoute.resolutions]);
  assert.match(historyText([{ kind: 'review', full: true, head: HEAD, resolutions: [], added: [], route: 'accept', reasons: [] }]), /结论：只有 P3 或没有发现，直接进验收/);
});
