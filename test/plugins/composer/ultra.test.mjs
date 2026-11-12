import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activate } from '../../../plugins/composer/main.mjs';
import { OFF, STILL_ON, on } from '../../../plugins/composer/ultra.mjs';

test('Ultra 名单给只读 spawn 按任务选执行者，带上选项', () => {
  const full = on([{ who: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', mode: 'agent',
    options: { 'service-tier': 'priority' } }, when: '任何工作' }]);
  assert.match(full, /- agent=codex model=gpt-6\.1-sol effort=ultra mode=agent options=\{"service-tier":"priority"\}: 任何工作/);
  assert.match(full, /Choose executors from this list by task, passing agent\/model\/effort\/mode\/options to spawn/);
  assert.match(full, /Use your own agent and model only when no entry covers the work/);
  assert.match(full, /When you start a lane PR \(lane-pr\), pick its executor, backup executor and reviewers from this list the same way:\n- agent=codex/);
  assert.doesNotMatch(on([]), /lane-pr/, '名单为空时不提');
  assert.match(STILL_ON, /choosing the executor from the list by task and passing agent\/model\/effort\/mode\/options/);
  assert.ok(on([]).endsWith('Use your own agent and model for Coda spawn.'));
});

// 开发流程由用户在会话里开启，规则写在流程的任务里：Ultra 只管派活，不再要求改代码都走 develop。
test('Ultra 只留派活规则：主 Agent 定任务、做决定、审查，spawn 只做不改代码的工作', () => {
  const full = on([]);
  for (const text of ['Conserve the lead agent', 'framing', 'difficult decisions', 'review', '`spawn`', 'do not change code',
    'Write each brief to stand alone', 'what is already known or ruled out', 'conclusions first, then sources and actual evidence (paths, commands, output)',
    'Do not repeat their routine work', 'When a result falls short, act on the cause', 'send it to the same session', 'ask that session for the evidence',
    'give the task to another entry of the list', 'retry', 'Do not quietly redo the work yourself', 'native subagents', 'concurrency is full']) assert.ok(full.includes(text), text);
  for (const text of ['framing', 'review', 'without code changes', 'concurrency is full', 'native subagents']) assert.ok(STILL_ON.includes(text), text);
  for (const text of [full, STILL_ON, OFF]) assert.doesNotMatch(text, /develop|deliver|ALL code changes|确认达标|放行合并|待交付|preview-install/);
  assert.ok(full.length < 2000, '默认说明给执行者名单留下空间');
});

test('watch 按会话记住对象，仅 Ultra 发过再退出时告知关闭一次', async () => {
  let changed;
  const told = [], watched = { dispose() {} };
  assert.equal(await activate({ protocols: { register() {} },
    watch: async (kind, handler) => { assert.equal(kind, 'coda/composer@1'); changed = handler; return watched; },
    tell: async (thread, text) => { told.push([thread, text]); },
  }), watched);
  const event = (id, sent, active = true, type = 'MODIFIED') => ({ type, id, object: {
    kind: 'coda/composer@1', id, revision: 1,
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
