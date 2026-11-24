// 页面：视图里有几台就读几台、按人合并；页面不自己选机器，消息都带 machine 发给每台。
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { flush, openPage } from '../view-dom.mjs';
import { A, B, C, DAY, X, Y, bucket, dayRec, reply } from './boards.mjs';

// 严格多机的 window.coda：不指明 machine 的 postMessage 直接拒绝；rejects 里的机器发送一律失败。
function strictCoda(machines, { rejects = [], state = {} } = {}) {
  const log = { sent: [], watches: [], saved: [] };
  const coda = {
    machine: machines[0], machines, getState: () => state, setState: value => log.saved.push(value), on() {}, toolbar: async () => {}, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      if (rejects.includes(options.machine)) throw new Error(`no route to ${options.machine}`);
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
