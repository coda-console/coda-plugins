// 迁入后的模式通过同一个 activate 注册，保持会话关系、回报对象与命令发送行为。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
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

test('清单声明的四个模式都有发送回调', () => {
  const hooks = plugin();
  assert.deepEqual(manifest.contributes.composerModes.map(mode => mode.id), ['handoff', 'subagent', 'shell', 'ultra']);
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
