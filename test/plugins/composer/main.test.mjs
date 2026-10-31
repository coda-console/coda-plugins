// 迁入后的模式通过同一个 activate 注册，保持会话关系、回报对象与命令发送行为。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../../../check/index.mjs';
import { activate } from '../../../plugins/composer/main.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../plugins/composer/package.json', import.meta.url), 'utf8'));
function plugin() {
  const hooks = new Map();
  activate({ composerModes: { register(id, callbacks) {
    assert.ok(!hooks.has(id), `模式 ${id} 不应重复注册`);
    hooks.set(id, callbacks);
  } } });
  return hooks;
}

test('清单声明的五个模式都有发送回调', () => {
  const hooks = plugin();
  assert.deepEqual(manifest.contributes.composerModes.map(mode => mode.id), ['handoff', 'subagent', 'shell', 'ultra', 'loop']);
  assert.deepEqual([...hooks.keys()], manifest.contributes.composerModes.map(mode => mode.id));
  for (const callbacks of hooks.values()) assert.equal(typeof callbacks.send, 'function');
});

test('交接承接当前上下文，子会话只从根会话创建并保留回报对象', () => {
  const hooks = plugin();
  assert.deepEqual(hooks.get('handoff').send(), { create: { handoff: true } });
  const child = hooks.get('subagent');
  assert.doesNotThrow(() => child.enter({ session: { id: 'root', parentThreadId: null } }));
  assert.throws(() => child.enter({ session: { id: 'child', parentThreadId: 'root' } }), /请从根会话创建子会话/);
  for (const replyTo of [undefined, 'parent', 'sender']) {
    assert.deepEqual(child.send({ values: { replyTo } }), {
      create: { handoff: true, parent: true, replyTo: replyTo ?? 'parent' },
    });
  }
});

test('命令仍由 ! 触发，在会话和新任务中使用，回调不改写消息', () => {
  const shell = manifest.contributes.composerModes.find(mode => mode.id === 'shell');
  assert.equal(shell.trigger, '!');
  assert.equal(shell.agent, 'off');
  assert.deepEqual(shell.in, ['session', 'new']);
  for (const session of [null, { id: 's1' }]) {
    assert.deepEqual(plugin().get('shell').send({ session, text: 'pwd', values: {} }), {});
  }
});

test('循环发送所选周期，交由 Coda 建立循环并退出模式', () => {
  const loop = plugin().get('loop');
  for (const every of ['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT6H', 'PT12H', 'P1D']) {
    assert.deepEqual(loop.send({ values: { every } }), { loop: { every } });
  }
});

test('含循环的清单通过 plugin-check，保留会话限制、时长格式和周期档位', async () => {
  const { report, plugin: checked } = await checkPlugin(fileURLToPath(new URL('../../../plugins/composer', import.meta.url)), { manifestOnly: true });
  assert.deepEqual(report.failures, []);
  const loop = checked.plugin.composerModes.find(mode => mode.id === 'loop');
  assert.equal(loop.agent, 'session');
  assert.deepEqual(loop.in, ['session']);
  const every = loop.parameters.properties.every;
  assert.equal(every.type, 'string');
  assert.equal(every.format, 'duration');
  assert.equal(every.default, 'PT30M');
  assert.deepEqual(every.enum, ['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT6H', 'PT12H', 'P1D']);
  assert.deepEqual(every.enumItemLabels, ['5 分钟', '10 分钟', '15 分钟', '30 分钟', '1 小时', '2 小时', '3 小时', '6 小时', '12 小时', '1 天']);
});
