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
    assert.match(text, /Coda spawn, lane-pr executor, executor2, reviewer, reviewer2, and the overall reviewer, reviewer2, reviewer3 of develop/);
    assert.match(text, /Your own agent only if no entry fits/);
  }
  for (const text of [on([]), reminder([])]) {
    assert.ok(text.endsWith('Use your own agent and model for Coda spawn, lane-pr and the overall reviewers of develop.'));
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

const composerEvent = (id, { sent = 0, subagents = list, ultra = true, type = 'MODIFIED' } = {}) => ({ type, id, object: {
  kind: 'coda/composer@1', id, revision: 1,
  spec: { ...(id.startsWith('new:') ? { project: id.slice(4) } : { thread: id }),
    modes: [...(ultra ? [{ mode: 'composer/ultra', values: { subagents } }] : []), { mode: 'composer/loop', values: { every: 'PT30M' } }] },
  status: { modes: [...(ultra ? [{ mode: 'composer/ultra', sent, changedSinceSent: false, presets: {} }] : []),
    { mode: 'composer/loop', sent: 42, changedSinceSent: false, presets: {} }] },
} });
// replay：watch 返回前交给插件的输入框（宿主重放的 ADDED）。
async function rig(replay = []) {
  const watchers = new Map(), told = [], submissions = new Map(), state = new Map();
  await activate({
    protocols: { register: (_kind, id, handler) => submissions.set(id, handler) },
    watch: async (kind, handler) => {
      watchers.set(kind, handler);
      if (kind === 'coda/composer@1') for (const [id, options] of replay) await handler(composerEvent(id, { ...options, type: 'ADDED' }));
      return { dispose() {} };
    },
    tell: async (thread, text) => { told.push([thread, text]); },
  });
  const composer = (id, options) => watchers.get('coda/composer@1')(composerEvent(id, options));
  const turn = async (id, running) => {
    const type = state.has(id) ? 'MODIFIED' : 'ADDED';
    state.set(id, running);
    return watchers.get('threads')({ type, id, object: { id, turn: running ? `${id}-turn` : null, needsAction: false, title: id } });
  };
  // 一轮：开始再结束。
  const round = async id => { await turn(id, true); await turn(id, false); };
  const take = () => told.splice(0);
  // 用户在已有会话里发一条消息：先问参与者要补充，再投递（sent 加一）、跑一轮。
  const send = async (id, subagents = list, sent = 1) => {
    const contribution = await submissions.get('ultra')({ spec: { composer: id, thread: id, projectId: 'p1',
      defaultTarget: { kind: 'message', thread: id },
      modes: [{ mode: 'composer/ultra', values: { subagents }, sent, changedSinceSent: false }] } });
    await composer(id, { subagents, sent: sent + 1 });
    await round(id);
    return contribution;
  };
  const create = (subagents = list) => submissions.get('ultra')({ spec: { composer: 'new:p1', projectId: 'p1',
    defaultTarget: { kind: 'thread', open: true },
    modes: [{ mode: 'composer/ultra', values: { subagents }, sent: 0, changedSinceSent: true }] } });
  return { composer, turn, round, take, send, create };
}

test('没有用户消息的连续多轮：第一轮结束给完整，之后每轮结束都给短提醒', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  assert.deepEqual(r.take(), [], '输入框的变化不 tell');
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', on(list)]]);
  for (let i = 0; i < 12; i++) {
    await r.round('s1'); // 流程结果、卡片叫醒的轮，输入框一直没变。
    assert.deepEqual(r.take(), [['s1', reminder(list)]]);
  }
});

test('短提醒含名单行和泳道 PR 范围；名单为空时写用自己的 Agent', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED', subagents: [] });
  await r.round('s1');
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', on([])], ['s1', reminder([])]]);
  assert.match(reminder([]), /Use your own agent and model for Coda spawn, lane-pr/);
  const text = reminder(list);
  assert.match(text, /- agent=codex model=gpt-6\.1-sol effort=ultra mode=agent options=\{"service-tier":"priority"\}: 任何工作/);
  assert.match(text, /lane-pr executor, executor2, reviewer, reviewer2, and the overall reviewer, reviewer2, reviewer3/);
});

test('压缩（sent 由大于 0 变 0）：这一轮结束给完整说明，再下一轮回到短；用户随后发消息不再返回第二份', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.send('s1');
  r.take();
  await r.composer('s1', { sent: 5 });
  await r.composer('s1', { sent: 0 }); // 空闲时压缩：不 tell。
  assert.deepEqual(r.take(), []);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', on(list)]]);
  assert.equal(await r.send('s1', list, 0), null);
  assert.deepEqual(r.take(), [['s1', reminder(list)]]);
  await r.composer('s1', { sent: 3 });
  await r.turn('s1', true); // 正在跑时压缩，等这一轮结束。
  await r.composer('s1', { sent: 0 });
  assert.deepEqual(r.take(), []);
  await r.turn('s1', false);
  assert.deepEqual(r.take(), [['s1', on(list)]]);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', reminder(list)]]);
});

test('空闲时连续改名单不 tell；用户发消息，参与者只返回一份最新名单的完整说明', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.round('s1');
  r.take();
  for (const subagents of [[{ who: { agent: 'codex' } }], [{ who: { agent: 'codex', model: 'gpt-6.1-sol' } }], other]) await r.composer('s1', { subagents });
  assert.deepEqual(r.take(), []);
  assert.deepEqual(await r.send('s1', other), { tell: [on(other)] });
  // 这一轮结束给短提醒（名单已是新的）；再发消息不再返回完整说明。
  assert.deepEqual(r.take(), [['s1', reminder(other)]]);
  assert.equal(await r.send('s1', other, 2), null);
});

test('空闲时连续改名单，下一轮由流程叫醒：结束时给一份最新名单的完整说明', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.round('s1');
  r.take();
  await r.composer('s1', { subagents: list.slice(0, 0) });
  await r.composer('s1', { subagents: other });
  assert.deepEqual(r.take(), []);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', on(other)]]);
  await r.round('s1');
  assert.deepEqual(r.take(), [['s1', reminder(other)]]);
  // 正在跑时改名单，同样等这一轮结束。
  await r.turn('s1', true);
  await r.composer('s1', { subagents: list });
  await r.composer('s1', { subagents: [] });
  assert.deepEqual(r.take(), []);
  await r.turn('s1', false);
  assert.deepEqual(r.take(), [['s1', on([])]]);
});

test('首次看到的输入框：重放→一轮结束给完整；重放后 sent=1 的新会话→给短；重放后 sent=0→下一次给完整', async () => {
  const r = await rig([['old', { sent: 4 }]]);
  assert.deepEqual(r.take(), []);
  await r.round('old');
  assert.deepEqual(r.take(), [['old', on(list)]]);
  await r.composer('c1', { type: 'ADDED', sent: 1 }); // 带着 Ultra 新建的会话，第一条已带完整说明。
  assert.deepEqual(r.take(), []);
  await r.round('c1');
  assert.deepEqual(r.take(), [['c1', reminder(list)]]);
  await r.composer('n1', { type: 'ADDED', sent: 0 }); // 刚进入 Ultra：发消息时给。
  assert.deepEqual(await r.send('n1'), { tell: [on(list)] });
  assert.deepEqual(r.take(), [['n1', reminder(list)]]);
  await r.composer('n2', { type: 'ADDED', sent: 0 }); // 或者一轮结束时给。
  await r.round('n2');
  assert.deepEqual(r.take(), [['n2', on(list)]]);
});

test('新会话创建与另一个已有会话开启 Ultra 交错、名单相同：已有会话不被抑制', async () => {
  const r = await rig();
  assert.deepEqual(await r.create(), { tell: [on(list)] });
  await r.composer('s1', { type: 'ADDED', sent: 0 }); // 另一个会话此时开启 Ultra，名单相同。
  await r.composer('c1', { type: 'ADDED', sent: 1 });
  await r.round('c1');
  await r.round('s1');
  assert.deepEqual(r.take(), [['c1', reminder(list)], ['s1', on(list)]]);
});

test('关闭：收到过说明（轮结束或消息带的）就 tell OFF 一次，之后不再提醒', async () => {
  const r = await rig();
  await r.composer('s1', { type: 'ADDED' });
  await r.round('s1');
  r.take();
  await r.composer('s1', { ultra: false });
  await r.composer('s1', { ultra: false });
  assert.deepEqual(r.take(), [['s1', OFF]]);
  await r.round('s1');
  assert.deepEqual(r.take(), []);
  // 说明由发消息带出（sent 在输入框事件里还是 0），退出也要告知。
  await r.composer('s2', { type: 'ADDED' });
  await r.send('s2', list, 0);
  r.take();
  await r.composer('s2', { ultra: false, sent: 0 });
  assert.deepEqual(r.take(), [['s2', OFF]]);
  // 还没收到过说明就退出：不告知关闭。
  await r.composer('s3', { type: 'ADDED' });
  await r.composer('s3', { ultra: false });
  assert.deepEqual(r.take(), []);
  // 重放后不知道是否告诉过，按 sent > 0 判断。
  const restarted = await rig([['s4', { sent: 10 }]]);
  await restarted.composer('s4', { ultra: false, sent: 10 });
  assert.deepEqual(restarted.take(), [['s4', OFF]]);
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
