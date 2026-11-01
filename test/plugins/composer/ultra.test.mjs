import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activate } from '../../../plugins/composer/main.mjs';
import { OFF, on } from '../../../plugins/composer/ultra.mjs';

test('Ultra 名单保留 spawn 的 Agent、模型、强度、模式、选项和分工', () => {
  assert.match(on([{ who: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', mode: 'agent',
    options: { 'service-tier': 'priority' } }, when: '调研' }]),
  /- agent=codex model=gpt-6\.1-sol effort=ultra mode=agent options=\{"service-tier":"priority"\}: 调研/);
  assert.match(on([]), /your own agent and model/);
});


test('watch 按会话记住对象，仅 Ultra 发过再退出时告知关闭一次', async () => {
  let changed;
  const told = [], watched = { dispose() {} };
  assert.equal(await activate({ protocols: { register() {} },
    watch: async (kind, handler) => { assert.equal(kind, 'composers'); changed = handler; return watched; },
    tell: async (thread, text) => { told.push([thread, text]); },
  }), watched);
  const event = (id, sent, active = true, type = 'MODIFIED') => ({ type, id, object: {
    kind: 'composers', id, revision: 1,
    spec: { ...(id.startsWith('new:') ? { project: id.slice(4) } : { thread: id }),
      modes: [...(active ? [{ mode: 'composer/ultra', values: {} }] : []), { mode: 'composer/loop', values: { every: 'PT30M' } }] },
    status: { modes: [...(active ? [{ mode: 'composer/ultra', sent, changedSinceSent: false, presets: {} }] : []),
      { mode: 'composer/loop', sent: 42, changedSinceSent: false, presets: {} }] },
  } });
  await changed(event('s1', 0, true, 'ADDED'));
  await changed(event('s2', 0, true, 'ADDED'));
  await changed(event('s1', 1));
  await changed(event('s1', 2));
  await changed(event('s2', 0, false)); // 其他模式发过不算 Ultra 发过。
  await changed(event('new:p1', 1, true, 'ADDED'));
  await changed(event('new:p1', 1, false)); // 新任务没有会话，不 tell。
  assert.deepEqual(told, []);
  await changed(event('s1', 2, false));
  await changed(event('s1', 2, false));
  assert.deepEqual(told.splice(0), [['s1', OFF]]);
  await changed(event('s1', 0)); // 再进入还没发就退出，不沿用上次计数。
  await changed(event('s1', 0, false));
  assert.deepEqual(told, []);
  await changed(event('restored', 10, true, 'ADDED')); // 宿主启动时的首批对象。
  await changed(event('restored', 10, false));
  assert.deepEqual(told.splice(0), [['restored', OFF]]);
  await changed(event('removed', 1, true, 'ADDED'));
  await changed({ type: 'DELETED', id: 'removed' });
  await changed(event('removed', 0, false, 'ADDED'));
  assert.deepEqual(told, []);
});
