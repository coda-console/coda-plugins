// 页面：视图里有几台就读几台、按人合并；页面不自己选机器，消息都带 machine 发给每台。
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { deferred, flush, openPage } from '../view-dom.mjs';
import { A, B, C, DAY, X, Y, bucket, dayRec, reply } from './boards.mjs';

// 严格多机的 window.coda：不指明 machine 的 postMessage 直接拒绝；rejects 里的机器发送一律失败。
// hold(msg, machine) 可以返回一个 promise 把这条发送挂住，之后再让它成功或失败。
function strictCoda(machines, { rejects = [], state = {}, hold } = {}) {
  const log = { sent: [], watches: [], saved: [], toolbars: [] };
  const coda = {
    machine: machines[0], machines, getState: () => state, setState: value => log.saved.push(value), on() {}, toolbar: async items => { log.toolbars.push(items); }, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      if (rejects.includes(options.machine)) throw new Error(`no route to ${options.machine}`);
      await hold?.(msg, options.machine);
      log.sent.push([msg.type, options.machine, msg]);
    },
    watch(kind, cb, selector, options) { log.watches.push({ kind, cb, machine: options?.machine }); return Promise.resolve({ dispose() {} }); },
  };
  return { coda, log };
}
const status = (share, extra = {}) => ({ type: 'status', share, range: '7d', syncState: share ? 'synced' : 'disabled', lastError: null, lastSyncAt: null, notice: null, ...extra });
const sentTo = (log, type) => log.sent.filter(([t]) => t === type).map(([, machine]) => machine);
// 回包的 id 要对上页面刚发出的那条 board 请求。
const answer = (page, log, machine, board) => page.reply({ ...board, id: log.sent.findLast(([t, m]) => t === 'board' && m === machine)[2].id }, { id: machine });
const open = async (t, machines, options) => {
  const { coda, log } = strictCoda(machines, options);
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', coda);
  await flush();
  return { page, log, coda };
};
const buttons = page => page.all(n => n.tag === 'button').map(n => n.textContent);

const mac = [bucket(DAY + 1000, 1000)], rig = [bucket(DAY + 2000, 300)];
const macBoard = reply({ selfAuthor: A, sourceId: 'x', local: mac, records: [dayRec(A, 'y', rig)], friends: [{ author: B }] });
const rigBoard = reply({ selfAuthor: A, sourceId: 'y', local: rig, records: [dayRec(A, 'x', mac), dayRec(B, 'phone', [bucket(DAY + 3000, 50)])], friends: [{ author: B }] });

test('每台可达的机器都收到 hello 和 board，不可达的不发；页面上没有选机器的控件，也不存机器', async t => {
  const { page, log, coda } = await open(t, [X, Y, { id: 'z', name: 'nas', unreachable: '断开' }]);
  assert.deepEqual(sentTo(log, 'hello'), ['x', 'y']);
  page.reply(status(false), { id: 'x' });
  await flush();
  assert.deepEqual(sentTo(log, 'board'), ['x', 'y'], '第一份状态定下默认范围后，每台各读一次');
  assert.deepEqual(log.saved, [], '启动时不写状态');
  assert.deepEqual(buttons(page).filter(label => ['Mac', 'rig', 'nas', '全部'].includes(label)), []);
  assert.deepEqual(log.watches.map(w => [w.kind, w.machine]), [['friends/social@1', 'x'], ['friends/social@1', 'y']]);
  assert.ok(page.text().includes('nas 读不到：断开，合计不含这台'));
  assert.ok(!coda.getState().machine);
});

test('两台同一身份：榜上只有一行「我」，不重复；用量写明合了哪几台', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  page.reply(status(false), { id: 'y' });
  await flush();
  answer(page, log, 'x', macBoard);
  answer(page, log, 'y', rigBoard);
  const text = page.text();
  assert.ok(text.includes('合计 · Mac、rig'));
  assert.equal(page.all(n => n.attrs?.class === 'row').length, 2, '我和好友各一行');
  assert.ok(text.includes('1.30K'), '我：1000 + 300 只算一次');
  assert.ok(!text.includes('不完整'));
});

test('不同身份的两台：每个身份一块用量，榜上两个人', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  answer(page, log, 'y', reply({ selfAuthor: C, sourceId: 'y', local: rig }));
  assert.equal(page.all(n => n.attrs?.class === 'row').length, 2);
  assert.equal(page.all(n => n.attrs?.class === 'group').length, 2);
  assert.ok(page.text().includes('Mac') && page.text().includes('rig'));
});

test('一台读不到（发送失败）：标出是哪台和原因，合计只含另一台，并标不完整', async t => {
  const { page, log } = await open(t, [X, Y], { rejects: ['y'] });
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  assert.ok(page.text().includes('rig 读不到：no route to y，合计不含这台'));
  assert.ok(page.text().includes('不完整'));
  assert.ok(page.text().includes('1.00K'));
});

test('旧版插件（回包没有 sources）：按读不到处理，写明插件需要更新', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  const { sources, ...old } = reply({ selfAuthor: A, sourceId: 'y', local: rig });
  answer(page, log, 'y', old);
  assert.ok(page.text().includes('rig 读不到：这台的 Token 消耗榜插件需要更新，合计不含这台'));
  assert.ok(page.text().includes('不完整'));
});

test('分享状态一样就显示一份；不一样就按台列出，开关对每台发，同步只发给开着的', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(true, { lastSyncAt: DAY }), { id: 'x' });
  page.reply(status(true, { lastSyncAt: DAY + 60_000 }), { id: 'y' });
  assert.ok(page.text().includes('正在向好友分享每日汇总'));
  assert.ok(!page.text().includes('Mac：'));
  page.reply(status(false), { id: 'y' });
  assert.ok(page.text().includes('Mac：正在分享'));
  assert.ok(page.text().includes('rig：没有分享'));
  log.sent.length = 0;
  page.button('立即同步').fire('click');
  await flush();
  assert.deepEqual(sentTo(log, 'sync'), ['x']);
  page.reply(status(true), { id: 'x' });
  log.sent.length = 0;
  page.button('开启分享').fire('click');
  await flush();
  assert.deepEqual(log.sent.map(([type, machine, msg]) => [type, machine, msg.on]), [['set-share', 'x', true], ['set-share', 'y', true]]);
  log.sent.length = 0;
  page.button('撤回已发布的记录').fire('click');
  await flush();
  assert.deepEqual(sentTo(log, 'withdraw'), ['x', 'y']);
});

test('各台的操作结果逐台写出，失败的标出是哪台', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  page.reply(status(false), { id: 'y' });
  await flush();
  page.reply(status(true, { notice: '已开启分享' }), { id: 'x' });
  page.reply(status(false, { notice: '没有好友身份' }), { id: 'y' });
  assert.ok(page.text().includes('Mac：已开启分享'));
  assert.ok(page.text().includes('rig：没有好友身份'));
  page.reply({ type: 'error', message: '撤回失败' }, { id: 'y' });
  assert.ok(page.text().includes('rig：撤回失败'));
});

test('改时间范围只存 range，每台重读；好友表变动刷新每台', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const headers = [];
  const { coda, log } = strictCoda([X, Y]);
  coda.on = (name, fn) => { headers.push([name, fn]); };
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', coda);
  await flush();
  page.reply(status(false), { id: 'x' });
  await flush();
  log.sent.length = 0;
  headers.find(([name]) => name === 'header')[1]({ id: 'today' });
  await flush();
  assert.deepEqual(log.saved, [{ range: 'today' }]);
  assert.deepEqual(log.sent.map(([type, machine, msg]) => [type, machine, msg.range]), [['board', 'x', 'today'], ['board', 'y', 'today']]);
  log.sent.length = 0;
  log.watches[1].cb({ type: 'MODIFIED' });
  mock.timers.tick(1000);
  await flush();
  assert.deepEqual(log.sent.map(([type, machine]) => [type, machine]), [['hello', 'x'], ['hello', 'y'], ['board', 'x'], ['board', 'y']]);
});

test('只有一台：标题是「本机」，不写合计、不写机器名、没有「不完整」', async t => {
  const { page, log } = await open(t, [X]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', macBoard);
  const text = page.text();
  assert.ok(text.includes('本机'));
  assert.ok(!text.includes('合计 ·') && !text.includes('Mac') && !text.includes('不完整'));
  assert.equal(page.all(n => n.attrs?.class === 'row').length, 2);
  assert.ok(text.includes('1.00K'));
});

test('还在等回包的那台不能当它不存在：先回的那台只显示读取中，不显示完整', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  assert.ok(page.text().includes('读取中…'));
  assert.ok(!page.text().includes('不完整'));
  answer(page, log, 'y', reply({ selfAuthor: A, sourceId: 'y', local: rig }));
  assert.ok(!page.text().includes('读取中…'));
});

test('刷新时某台的榜单请求失败：这台标成读不到，不留着旧数据；旧请求的失败不算', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  const plain = reply({ selfAuthor: A, sourceId: 'x', local: mac });
  answer(page, log, 'x', plain);
  answer(page, log, 'y', reply({ selfAuthor: A, sourceId: 'y', local: rig }));
  assert.ok(page.text().includes('1.30K'));
  page.button('刷新').fire('click');
  await flush();
  const asked = machine => log.sent.findLast(([t, m]) => t === 'board' && m === machine)[2].id;
  page.reply({ type: 'error', request: 'board', id: asked('y') - 1, message: '旧的' }, { id: 'y' });
  assert.ok(!page.text().includes('旧的'));
  page.reply({ type: 'error', request: 'board', id: asked('y'), message: '榜单明细超过宿主的消息上限' }, { id: 'y' });
  answer(page, log, 'x', plain);
  assert.ok(page.text().includes('rig 读不到：榜单明细超过宿主的消息上限，合计不含这台'));
  assert.ok(!page.text().includes('1.30K'), 'rig 的旧数据不再计入');
});

test('本机用量全读不到、好友记录读到了：榜单照常显示，不完整的提示保留', async t => {
  const { page, log } = await open(t, [X]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: null, friends: [{ author: B }], records: [dayRec(B, 'phone', [bucket(DAY + 1000, 222)])] }));
  assert.equal(page.all(n => n.attrs?.class === 'row').length, 2);
  assert.ok(page.text().includes('222'));
  assert.ok(page.text().includes('不完整'));
});

test('本机用量读不到的那台：写明合计缺它的本机用量', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: null }));
  answer(page, log, 'y', reply({ selfAuthor: A, sourceId: 'y', local: rig }));
  assert.ok(page.text().includes('Mac：读不到本机用量，合计缺它的本机用量'));
  assert.ok(page.text().includes('不完整'));
});

test('开关和撤回：没连上的成员写明没有执行；同步仍只发给开着分享的', async t => {
  const { page, log } = await open(t, [X, { id: 'z', name: 'nas', unreachable: '断开' }]);
  page.reply(status(false), { id: 'x' });
  await flush();
  page.button('开启分享').fire('click');
  assert.ok(page.text().includes('nas：没连上，没有开启分享'));
  page.reply(status(true), { id: 'x' });
  page.button('撤回已发布的记录').fire('click');
  assert.ok(page.text().includes('nas：没连上，没有撤回，它已发布的记录还在'));
  assert.ok(!page.text().includes('没有开启分享'), '上一次操作的结果被新的替换');
  log.sent.length = 0;
  page.button('立即同步').fire('click');
  await flush();
  assert.deepEqual(sentTo(log, 'sync'), ['x']);
  assert.ok(!page.text().includes('没连上，没有撤回'), '同步不带这条');
});

test('每一轮读取给每台发同一组 from、to；切换范围、刷新各自一轮，每轮各台仍收到同一组', async t => {
  // 固定在当地 23:59:59.999：to 是排他上界（now + 1），已经跨到次日，期望值要从这一刻独立算。
  const at = new Date(2026, 10, 20, 23, 59, 59, 999).getTime();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: at });
  t.after(() => mock.timers.reset());
  const headers = [];
  const { coda, log } = strictCoda([X, Y]);
  coda.on = (name, fn) => { headers.push([name, fn]); };
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', coda);
  await flush();
  const dayStart = back => new Date(2026, 10, 20 - back).getTime();
  const rounds = want => {
    const boards = log.sent.filter(([type]) => type === 'board');
    log.sent.length = 0;
    assert.deepEqual(boards.map(([, machine]) => machine), ['x', 'y']);
    for (const [, , msg] of boards) assert.deepEqual([msg.range, msg.from, msg.to], [want.range, want.from, want.to]);
  };
  page.reply(status(false), { id: 'x' });
  await flush();
  rounds({ range: '7d', from: dayStart(6), to: at + 1 });
  headers.find(([name]) => name === 'header')[1]({ id: 'today' });
  await flush();
  rounds({ range: 'today', from: dayStart(0), to: at + 1 });
  mock.timers.tick(1);   // 刷新那一刻已是次日：窗口随之整体换成新的一组，两台仍一致
  page.button('刷新中…').fire('click');
  await flush();
  rounds({ range: 'today', from: dayStart(-1), to: at + 2 });
});

// 分享状态：没回报、读不到的电脑不能被当成「没有分享」。
const shareToggle = log => log.toolbars.at(-1).find(item => item.id === 'share');
const WRONG = ['没有向好友分享', '正在向好友分享每日汇总'];

test('分享状态：A 已回报关闭、B 还没回报：按台列出，不说整个视图没有分享，工具栏不给开关', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  const text = page.text();
  assert.ok(text.includes('Mac：没有分享') && text.includes('rig：还没取到分享状态'));
  for (const wrong of WRONG) assert.ok(!text.includes(wrong));
  assert.equal(shareToggle(log), undefined);
  page.reply(status(false), { id: 'y' });
  assert.ok(page.text().includes('没有向好友分享'), '都回报了才合成一份');
  assert.equal(shareToggle(log).on, false);
});

test('分享状态：A 已回报关闭、B 读不到：写明 B 读不到，不说整个视图没有分享', async t => {
  const { page, log } = await open(t, [X, { id: 'z', name: 'nas', unreachable: '断开' }]);
  page.reply(status(false), { id: 'x' });
  await flush();
  const text = page.text();
  assert.ok(text.includes('nas：读不到分享状态：断开') && text.includes('Mac：没有分享'));
  for (const wrong of WRONG) assert.ok(!text.includes(wrong));
  assert.equal(shareToggle(log), undefined);
});

test('分享状态：全都没回报：不显示成关闭，工具栏不给开关', async t => {
  const { page, log } = await open(t, [X, Y]);
  const text = page.text();
  assert.ok(text.includes('Mac：还没取到分享状态') && text.includes('rig：还没取到分享状态'));
  for (const wrong of WRONG) assert.ok(!text.includes(wrong));
  assert.equal(shareToggle(log), undefined);
});

test('失败按请求认：新榜单成功后，旧榜单请求的发送才被拒，新数据还在', async t => {
  const old = deferred();
  let held = false;
  const { page, log } = await open(t, [X, Y], { hold: (msg, machine) => { if (msg.type === 'board' && machine === 'x' && !held) { held = true; return old.promise; } } });
  page.reply(status(false), { id: 'x' });
  await flush();
  page.button('刷新中…').fire('click');
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  answer(page, log, 'y', reply({ selfAuthor: A, sourceId: 'y', local: rig }));
  assert.ok(page.text().includes('1.30K'));
  old.reject(new Error('迟到的发送失败'));
  await flush();
  assert.ok(page.text().includes('1.30K'), '新数据没被清掉');
  assert.ok(!page.text().includes('读不到') && !page.text().includes('不完整'));
});

test('失败按请求认：hello 发送失败不清掉已成功的榜单，也不解除写操作的忙碌状态', async t => {
  let failHello = false;
  const { page, log } = await open(t, [X, Y], { hold: msg => { if (failHello && msg.type === 'hello') throw new Error('hello 发不出去'); } });
  page.reply(status(false), { id: 'x' });
  page.reply(status(false), { id: 'y' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  answer(page, log, 'y', reply({ selfAuthor: A, sourceId: 'y', local: rig }));
  page.button('开启分享').fire('click');
  assert.ok(page.button('开启分享').attrs.disabled !== undefined, '写操作进行中');
  failHello = true;
  page.button('刷新').fire('click');
  await flush();
  assert.ok(page.text().includes('1.30K'), '榜单还在');
  assert.ok(!page.text().includes('读不到'));
  assert.ok(page.text().includes('Mac：发送失败：hello 发不出去'));
  assert.ok(page.button('开启分享').attrs.disabled !== undefined, '忙碌状态还在');
});

test('两台身份不同、互为好友：两个人都标「我」，也不写「还没有好友」；真的没有好友才写', async t => {
  const { page, log } = await open(t, [X, Y]);
  page.reply(status(false), { id: 'x' });
  await flush();
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac, friends: [{ author: C }] }));
  answer(page, log, 'y', reply({ selfAuthor: C, sourceId: 'y', local: rig, friends: [{ author: A }] }));
  assert.equal(page.all(n => n.attrs?.class === 'row').length, 2);
  assert.equal(page.all(n => n.attrs?.class === 'me').length, 2);
  assert.ok(!page.text().includes('还没有好友'));
  answer(page, log, 'x', reply({ selfAuthor: A, sourceId: 'x', local: mac }));
  answer(page, log, 'y', reply({ selfAuthor: C, sourceId: 'y', local: rig }));
  assert.ok(page.text().includes('还没有好友'));
});

test('分享状态：A 回报关闭、B 的 hello 被拒：B 那一行写读取失败和原因，不是「还没取到」；后端回错误也一样', async t => {
  const { page, log } = await open(t, [X, Y], { hold: (msg, machine) => { if (msg.type === 'hello' && machine === 'y') throw new Error('hello 被拒'); } });
  page.reply(status(false), { id: 'x' });
  await flush();
  const text = page.text();
  assert.ok(text.includes('rig：读取分享状态失败：hello 被拒') && text.includes('Mac：没有分享'));
  assert.ok(!text.includes('还没取到分享状态'));
  for (const wrong of WRONG) assert.ok(!text.includes(wrong));
  assert.equal(shareToggle(log), undefined, '全局开关仍隐藏');
  page.reply({ type: 'error', request: 'hello', message: '读设置失败' }, { id: 'x' });
  assert.ok(page.text().includes('Mac：没有分享'), '已回报过的状态不被一次失败盖掉');
  page.reply(status(false), { id: 'y' });
  assert.ok(!page.text().includes('读取分享状态失败') && page.text().includes('没有向好友分享'), '之后回报了就恢复');
});
