// 表格只验证插件补充；去向执行、预设解析与模式计数由 Coda 的测试覆盖。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { activate } from '../../../plugins/composer/main.mjs';
import { STILL_ON, on } from '../../../plugins/composer/ultra.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../plugins/composer/package.json', import.meta.url), 'utf8'));
function plugin() {
  const handlers = new Map();
  activate({ protocols: { register(kind, id, handler) {
    assert.equal(kind, 'submissions');
    assert.ok(!handlers.has(id), `模式 ${id} 不应重复注册`);
    handlers.set(id, handler);
  } }, watch: async () => ({ dispose() {} }) });
  return handlers;
}
const chosen = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', options: { 'service-tier': 'priority' } };
const subagents = [{ who: chosen, when: '调研' }];
function submission(id, { thread = 'child', values = {}, sent = 0, changedSinceSent = false } = {}) {
  return { kind: 'submissions', id: 'request-1', revision: 1, status: {}, spec: {
    composer: thread ?? 'new:p1', thread, projectId: 'p1', text: '原始正文',
    attachments: ['/tmp/example.txt'], quotes: ['引用'],
    agent: { agent: 'claude-sdk', settings: { model: 'claude-opus-5-5' } },
    // 目标模式不在首项，另有同名的其他插件模式；按完整 mode ID 取快照。
    modes: [{ mode: `other/${id}`, values: { agent: 'wrong' }, sent: 99, changedSinceSent: true },
      { mode: `composer/${id}`, values, sent, changedSinceSent }],
    defaultTarget: thread ? { kind: 'message', thread } : { kind: 'thread', open: true },
  } };
}
const cases = [
  ['交接指定 Agent', 'handoff', { values: { agent: chosen } }, { divert: true,
    targets: [{ kind: 'thread', handoffSource: 'child', agent: chosen, open: true }] }],
  ...[undefined, null].map(agent => [`交接空 Agent ${agent}`, 'handoff', { values: { agent } }, { divert: true,
    targets: [{ kind: 'thread', handoffSource: 'child', open: true }] }]),
  ...['parent', 'sender'].map(replyTo => [`子会话回报 ${replyTo}`, 'subagent', { values: { agent: chosen, replyTo } }, { divert: true,
    targets: [{ kind: 'thread', handoffSource: 'child', parentThreadId: 'child', replyTo, agent: chosen, open: true }] }]),
  ['子会话沿用执行者', 'subagent', { values: { agent: null, replyTo: 'parent' } }, { divert: true,
    targets: [{ kind: 'thread', handoffSource: 'child', parentThreadId: 'child', replyTo: 'parent', open: true }] }],
  ['会话执行命令', 'shell', {}, { divert: true, targets: [{ kind: 'message', thread: 'child', run: true }] }],
  ['新任务执行命令', 'shell', { thread: null }, { divert: true, targets: [{ kind: 'thread', run: true, open: true }] }],
  ...['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT6H', 'PT12H', 'P1D']
    .map(every => [`循环 ${every}`, 'loop', { values: { every } }, { divert: true, targets: [{ kind: 'loop', thread: 'child', every }] }]),
  ['Ultra 首条名单', 'ultra', { values: { subagents } }, { tell: [on(subagents)] }],
  ['Ultra 新任务空名单', 'ultra', { thread: null }, { tell: [on([])] }],
  ['Ultra 改参数', 'ultra', { values: { subagents }, sent: 11, changedSinceSent: true }, { tell: [on(subagents)] }],
  ['Ultra 改参数优先于周期提醒', 'ultra', { values: { subagents }, sent: 10, changedSinceSent: true }, { tell: [on(subagents)] }],
  ...[1, 2, 9, 11, 19, 21].map(sent => [`Ultra 已收下 ${sent} 条不提醒`, 'ultra', { sent }, null]),
  ...[10, 20, 30].map(sent => [`Ultra 已收下 ${sent} 条提醒`, 'ultra', { sent }, { tell: [STILL_ON] }]),
];
for (const [name, id, input, expected] of cases) test(name, async () => {
  const object = submission(id, input), before = structuredClone(object);
  assert.deepEqual(await plugin().get(id)(object), expected);
  assert.deepEqual(object, before, '不改正文、附件、引用、执行者或模式快照');
});

test('清单的五个模式注册 submissions 参与者，未开模式不补充', async () => {
  const handlers = plugin();
  assert.deepEqual([...handlers.keys()], manifest.contributes.composerModes.map(mode => mode.id));
  for (const [id, handler] of handlers) {
    const object = submission(id);
    object.spec.modes = [];
    assert.equal(await handler(object), null);
  }
});

test('模式声明：一次性模式、可选执行者、Ultra 预设和命令入口', () => {
  const modes = Object.fromEntries(manifest.contributes.composerModes.map(mode => [mode.id, mode]));
  for (const mode of Object.values(modes)) assert.equal(Object.hasOwn(mode, 'agent'), false);
  for (const id of ['handoff', 'subagent', 'loop']) assert.equal(modes[id].once, true);
  for (const id of ['shell', 'ultra']) assert.notEqual(modes[id].once, true);
  for (const id of ['handoff', 'subagent']) {
    const { parameters } = modes[id];
    assert.equal(parameters.properties.agent.type, 'object');
    assert.equal(parameters.properties.agent.format, 'coda-agent');
    assert.ok(!parameters.required?.includes('agent'));
  }
  assert.equal(modes.shell.trigger, '!');
  assert.deepEqual(modes.shell.in, ['session', 'new']);
  assert.deepEqual(modes.ultra.in, ['session', 'new']);
  assert.equal(Object.hasOwn(modes.ultra.parameters.properties, 'template'), false);
  assert.deepEqual(modes.ultra.parameters.properties.subagents.presets, { from: 'composer.templates', by: 'template' });
  assert.deepEqual(manifest.contributes.configuration.properties['composer.templates'].default, []);
  assert.deepEqual(modes.loop.in, ['session']);
  const every = modes.loop.parameters.properties.every;
  assert.equal(every.format, 'duration');
  assert.equal(every.default, 'PT30M');
  assert.deepEqual(every.enum, ['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT6H', 'PT12H', 'P1D']);
});
