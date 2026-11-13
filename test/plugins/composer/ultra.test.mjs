import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activate } from '../../../plugins/composer/main.mjs';
import { OFF, on, reminder } from '../../../plugins/composer/ultra.mjs';

const chosen = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', mode: 'agent', options: { 'service-tier': 'priority' } };
const list = [{ who: chosen, when: '任何工作' }];
const other = [{ who: { agent: 'claude-sdk', model: 'claude-opus-5-5' } }];

test('Ultra 名单给 spawn、泳道 PR 与整体评审者按任务选 Agent，带上选项', () => {
  const full = on(list);
  assert.match(full, /- agent=codex model=gpt-6\.1-sol effort=ultra mode=agent options=\{"service-tier":"priority"\}: 任何工作/);
  for (const text of [full, reminder(list)]) {
    assert.match(text, /Pick the Agent from this list by task \(pass agent\/model\/effort\/mode\/options\)/);
    assert.match(text, /Coda spawn, lane-pr executor, executor2, reviewer, reviewer2, reviewerOnce, and the overall reviewer, reviewer2 of kickoff and develop/);
    assert.match(text, /Your own agent only if no entry fits/);
  }
  for (const text of [on([]), reminder([])]) {
    assert.ok(text.endsWith('Use your own agent and model for Coda spawn, lane-pr and the overall reviewers of kickoff and develop.'));
  }
});

// 开发流程由用户在会话里开启，规则写在流程的任务里：Ultra 可以点名流程来说选谁，但不讲流程怎么走。
test('Ultra 留派活规则：主 Agent 定任务、做决定、审查，spawn 只做不改代码的工作', () => {
  const full = on([]);
  for (const text of ['Conserve the lead agent', 'framing', 'difficult decisions', 'review', '`spawn`', 'do not change code',
    'Write each brief to stand alone', 'what is already known or ruled out', 'conclusions first, then sources and actual evidence (paths, commands, output)',
    'Do not repeat their routine work', 'When a result falls short, act on the cause', 'send it to the same session', 'ask that session for the evidence',
    'give the task to another entry of the list', 'retry', 'Do not quietly redo the work yourself', 'native subagents', 'concurrency is full']) assert.ok(full.includes(text), text);
  const short = reminder(list);
  for (const text of ['frame', 'review', 'without code changes', '`spawn`', 'concurrency is full', 'No native subagents']) assert.ok(short.includes(text), text);
  for (const text of [full, short, OFF]) assert.doesNotMatch(text, /ALL code changes|确认达标|放行合并|待交付|preview-install/);
  assert.ok(full.length < 2000, '默认说明给执行者名单留下空间');
  assert.ok(short.length - short.split('\n').at(-1).length <= 450, '短提醒除名单外约 400 字');
});

async function rig() {
  const watchers = new Map(), told = [], submissions = new Map();
  await activate({
    protocols: { register: (_kind, id, handler) => submissions.set(id, handler) },
    watch: async (kind, handler) => { watchers.set(kind, handler); return { dispose() {} }; },
    tell: async (thread, text) => { told.push([thread, text]); },
  });
  const state = new Map();
  const composer = async (id, { sent = 0, subagents = list, ultra = true, type = 'MODIFIED' } = {}) => watchers.get('coda/composer@1')({ type, id, object: {
    kind: 'coda/composer@1', id, revision: 1,
    spec: { ...(id.startsWith('new:') ? { project: id.slice(4) } : { thread: id }),
      modes: [...(ultra ? [{ mode: 'composer/ultra', values: { subagents } }] : []), { mode: 'composer/loop', values: { every: 'PT30M' } }] },
    status: { modes: [...(ultra ? [{ mode: 'composer/ultra', sent, changedSinceSent: false, presets: {} }] : []),
      { mode: 'composer/loop', sent: 42, changedSinceSent: false, presets: {} }] },
  } });
  const turn = async (id, running) => {
    const type = state.has(id) ? 'MODIFIED' : 'ADDED';
    state.set(id, running);
    return watchers.get('threads')({ type, id, object: { id, turn: running ? `${id}-turn` : null, needsAction: false, title: id } });
  };
  // 一轮：开始再结束。
  const round = async id => { await turn(id, true); await turn(id, false); };
  const take = () => told.splice(0);
  const submit = (spec, id = 'ultra') => submissions.get(id)({ spec });
  return { composer, turn, round, take, submit };
}
const create = (subagents = list) => ({ composer: 'new:p1', projectId: 'p1', defaultTarget: { kind: 'thread', open: true },
  modes: [{ mode: 'composer/ultra', values: { subagents }, sent: 0, changedSinceSent: true }] });

test('没有用户消息的连续多轮：第一轮完整，之后每轮结束都给短提醒', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  assert.deepEqual(r.take(), [['s1', on(list)]]);
  for (let i = 0; i < 12; i++) {
    await r.round('s1'); // 流程结果、卡片叫醒的轮，输入框一直没变。
    assert.deepEqual(r.take(), [['s1', reminder(list)]]);
  }
});

test('短提醒含名单行和泳道 PR 范围；名单为空时写用自己的 Agent', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED', subagents: [] });
  r.take();
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', reminder([])]]);
  assert.match(reminder([]), /Use your own agent and model for Coda spawn, lane-pr/);
  const text = reminder(list);
  assert.match(text, /- agent=codex model=gpt-6\.1-sol effort=ultra mode=agent options=\{"service-tier":"priority"\}: 任何工作/);
  assert.match(text, /lane-pr executor, executor2, reviewer, reviewer2, reviewerOnce/);
});

test('压缩（sent 由大于 0 变 0）：空闲时立刻给完整，再下一轮回到短；正在跑时等这一轮结束', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.composer('s1', { sent: 5 });
  r.take();
  await r.composer('s1', { sent: 0 });
  assert.deepEqual(r.take(), [['s1', on(list)]]);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', reminder(list)]]);
  await r.composer('s1', { sent: 3 });
  await r.turn('s1', true);
  await r.composer('s1', { sent: 0 });
  assert.deepEqual(r.take(), []);
  await r.turn('s1', false);
  assert.deepEqual(r.take(), [['s1', on(list)]]);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', reminder(list)]]);
});

test('改名单：空闲时立刻给完整，正在跑时等这一轮结束，且只给一份', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  r.take();
  await r.composer('s1', { subagents: other });
  assert.deepEqual(r.take(), [['s1', on(other)]]);
  await r.composer('s1', { subagents: other, sent: 1 }); // 名单没变，只是发了一条。
  assert.deepEqual(r.take(), []);
  await r.turn('s1', true);
  await r.composer('s1', { subagents: list, sent: 1 });
  await r.composer('s1', { subagents: [], sent: 1 });
  assert.deepEqual(r.take(), []);
  await r.turn('s1', false);
  assert.deepEqual(r.take(), [['s1', on([])]]);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', reminder([])]]);
});

test('用户发消息的一轮不会有两份完整说明', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.round('s1');
  r.take();
  // 用户先改名单（空闲，立刻给完整），再发消息：投递后 sent 加一，轮开始、结束。
  await r.composer('s1', { subagents: other });
  assert.equal(await r.submit({ composer: 's1', thread: 's1', projectId: 'p1', defaultTarget: { kind: 'message', thread: 's1' },
    modes: [{ mode: 'composer/ultra', values: { subagents: other }, sent: 1, changedSinceSent: true }] }), null);
  await r.turn('s1', true);
  await r.composer('s1', { subagents: other, sent: 2 });
  await r.turn('s1', false);
  const told = r.take();
  assert.deepEqual(told, [['s1', on(other)], ['s1', reminder(other)]]);
  assert.equal(told.filter(([, text]) => text === on(other)).length, 1);
});

test('新会话第一条已带完整说明：第一轮结束给短提醒，不补完整说明', async () => {
  const r = await rig();
  assert.deepEqual(await r.submit(create()), { tell: [on(list)] });
  await r.turn('c1', true); // 新会话的第一轮已经在跑。
  await r.composer('c1', { type: 'ADDED', sent: 1 });
  assert.deepEqual(r.take(), []);
  await r.turn('c1', false);
  assert.deepEqual(r.take(), [['c1', reminder(list)]]);
  await r.round('c1');
  assert.deepEqual(r.take(), [['c1', reminder(list)]]);
  // 没有对应的创建时（如插件重启后），看到已开着 Ultra 的输入框就给完整说明。
  await r.composer('c2', { type: 'ADDED', sent: 4 });
  assert.deepEqual(r.take(), [['c2', on(list)]]);
});

test('关闭：收到过说明就 tell OFF 一次，之后不再提醒', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.composer('s1', { sent: 1 });
  r.take();
  await r.composer('s1', { ultra: false, sent: 1 });
  await r.composer('s1', { ultra: false, sent: 1 });
  assert.deepEqual(r.take(), [['s1', OFF]]);
  await r.round('s1');
  assert.deepEqual(r.take(), []);
  // 再进入、说明还没送出就退出：不告知关闭。
  await r.turn('s2', true);
  await r.composer('s2', { type: 'ADDED' });
  await r.composer('s2', { ultra: false });
  assert.deepEqual(r.take(), []);
  // 说明还在等这一轮结束，但 sent > 0（重启后不知道是否告诉过）：告知关闭。
  await r.turn('s3', true);
  await r.composer('s3', { type: 'ADDED', sent: 10 });
  await r.composer('s3', { ultra: false, sent: 10 });
  assert.deepEqual(r.take(), [['s3', OFF]]);
  await r.turn('s3', false);
  assert.deepEqual(r.take(), []);
});

test('未开 Ultra 的会话和新任务输入框不提醒；输入框删除后不再记着', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED', ultra: false });
  await r.round('s1');
  await r.composer('new:p1', { type: 'ADDED' });
  await r.round('new:p1');
  await r.composer('new:p1', { ultra: false });
  assert.deepEqual(r.take(), []);
  await r.composer('s2', { type: 'ADDED' });
  r.take();
  await r.composer('s2', { type: 'DELETED' });
  await r.round('s2');
  await r.composer('s2', { ultra: false, type: 'ADDED' });
  assert.deepEqual(r.take(), []);
});

test('activate 返回的 dispose 取消两个观察', async () => {
  let disposed = 0;
  const handle = await activate({ protocols: { register() {} }, tell: async () => {},
    watch: async () => ({ dispose() { disposed++; } }) });
  handle.dispose();
  assert.equal(disposed, 2);
});
