// 页面：目录聚合视图，只用不带 machine 的 watch 读目录里的记录；等第一次 watch 给完才画第一屏，不发消息、不逐台读；
// 时间窗按看页面这台的当地时间，每次打开从「今天」起；分享开关对每台的状态记录调 set-share。
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { deferred, flush, openPage } from '../view-dom.mjs';
import { A, B, C, DAY, NOW, X, Y, bucket, mirrorToday, stateOf, usageOf } from './boards.mjs';

process.env.TZ = 'UTC';
const KIND = 'token-board/usage@1';

// window.coda：watch 由测试把现有的记录交完再放行；任何带 machine 的读、postMessage 都直接失败。
function fakeCoda({ machines = [X, Y], failing = [] } = {}) {
  const log = { watches: [], calls: [], toolbars: [], headers: [], handlers: {}, messages: [] };
  const first = deferred();
  const coda = {
    machine: machines[0], machines, getState: () => ({ range: '30d' }), setState: () => { throw new Error('页面不留范围'); },
    on: (name, fn) => { log.handlers[name] = fn; },
    toolbar: async items => { log.toolbars.push(items); }, header: async declaration => { log.headers.push(declaration); },
    postMessage: async message => { log.messages.push(message); },
    watch(...args) { log.watches.push(args); log.feed = args[1]; return first.promise; },
    async call(...args) { log.calls.push(args); if (failing.includes(args[0].id)) throw new Error('没连上'); return { share: args[2].on }; },
    query: async () => { throw new Error('页面不该 query'); }, list: async () => { throw new Error('页面不该 list'); }, get: async () => { throw new Error('页面不该 get'); },
  };
  return { coda, log, release: () => first.resolve({ dispose() {} }), reject: error => first.reject(error) };
}
const feed = (log, entries, type = 'ADDED') => { for (const entry of entries) log.feed({ type, id: entry.id, entry }); };
async function open(t, entries, options) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  const host = fakeCoda(options);
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', host.coda);
  feed(host.log, entries);
  host.release();
  await flush();
  return { page, ...host };
}
const texts = (page, cls) => page.all(n => n.attrs?.class === cls).map(n => n.textContent);
const mac = [bucket(DAY + 1000, 1000)], rig = [bucket(DAY + 2000, 300)];
const friendsOf = (...rest) => [stateOf(X, { author: A, friends: [B], lastSyncAt: DAY + 3 * 3_600_000 + 1_800_000 }), stateOf(Y, { author: A, friends: [B], lastSyncAt: DAY + 3_600_000 }),
  ...usageOf(X, { author: A, sourceId: 'x', buckets: mac }), ...usageOf(Y, { author: A, sourceId: 'y', buckets: rig }), mirrorToday(X, B, 'phone', [bucket(DAY + 3000, 50)]), ...rest];

test('第一屏等 watch 给完才画：之前没有数字也没有「读取中」，给完一次画出；只用不带 machine 的 watch，不发消息、不读别的', async t => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  const host = fakeCoda();
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', host.coda);
  feed(host.log, friendsOf());
  await flush();
  assert.equal(page.text(), '', '记录一条条到，watch 没给完之前什么都不画');
  assert.deepEqual(host.log.watches.map(args => [args[0], args.length]), [[KIND, 2]], '协议名与回调，没有筛选、没有 machine');
  host.release();
  await flush();
  const text = page.text();
  assert.ok(text.includes('我 · Mac、rig') && text.includes('1.30K') && text.includes('好友榜'));
  assert.ok(!text.includes('读取中') && !text.includes('不完整'));
  assert.deepEqual(host.log.messages, []);
});

test('默认今天，不从 getState 恢复；顶栏三段，切换后按新的窗口重算', async t => {
  const old = bucket(DAY - 2 * 86_400_000 + 36_000_000, 500);
  const { page, log } = await open(t, [stateOf(X, { author: A }), ...usageOf(X, { author: A, sourceId: 'x', buckets: [old, ...mac] })]);
  assert.deepEqual(log.headers.at(-1), { text: null, segments: { items: [{ id: 'today', label: '今天' }, { id: '7d', label: '近 7 天' }, { id: '30d', label: '近 30 天' }], selected: 'today' } });
  assert.ok(page.text().includes('1.00K'));
  log.handlers.header({ id: '7d' });
  await flush();
  assert.ok(page.text().includes('1.50K'), '近 7 天含两天前的用量');
  log.handlers.header({ id: 'nonsense' });
  await flush();
  assert.ok(page.text().includes('1.50K'));
  log.handlers.header({ id: 'today' });
  await flush();
  assert.ok(page.text().includes('1.00K') && !page.text().includes('1.50K'));
});

test('「我」：总 Token、回合数、四段条与图例；好友榜：排名、展示名、回合数、总量，「我」高亮带标签', async t => {
  const { page } = await open(t, friendsOf());
  assert.equal(page.all(n => n.attrs?.class === 'stack')[0].children.length, 4);
  assert.deepEqual(texts(page, 'legend')[0].replace(/\d+\.?\d*[KMB]?/g, '#'), '输入#输出#缓存读#缓存写#'.replace(/#/g, '#'));
  const rows = page.all(n => n.attrs?.class?.startsWith('row'));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.startsWith('1') && rows[0].textContent.includes('1.30K') && rows[0].textContent.includes('2 个回合') && rows[0].textContent.includes('我'));
  assert.equal(rows[0].attrs.class, 'row me');
  assert.ok(rows[1].textContent.includes('50') && rows[1].textContent.includes('1 个回合') && !rows[1].textContent.includes('我'));
  assert.equal(page.all(n => n.attrs?.class === 'tag').length, 1);
});

test('没分享的好友不进排名，只写一行；没有好友（没装好友插件、没有身份）只写一行，也没有榜', async t => {
  const { page } = await open(t, [stateOf(X, { author: A, friends: [B, C] }), ...usageOf(X, { author: A, sourceId: 'x', buckets: mac }), mirrorToday(X, B, 'phone', [bucket(DAY + 3000, 50)])]);
  assert.equal(page.all(n => n.attrs?.class?.startsWith('row')).length, 2);
  assert.ok(page.text().includes('还有 1 位好友没有分享'));
  const alone = await open(t, [stateOf(X), ...usageOf(X, { author: null, sourceId: 'x', buckets: mac })]);
  assert.ok(alone.page.text().includes('还没有好友。加了好友、对方也开着分享，就能在这里比一比。'));
  assert.equal(alone.page.all(n => n.attrs?.class?.startsWith('row')).length, 0);
  assert.ok(!alone.page.text().includes('没有分享的好友'));
});

test('页脚一行灰字：分享开着写同步时刻，没分享写好友看不到；证书过期、同步出错才另写一行；别的提示都没有', async t => {
  const at = Date.UTC(2026, 10, 20, 3, 30);
  let { page } = await open(t, [stateOf(X, { author: A, lastSyncAt: at }), stateOf(Y, { author: A, lastSyncAt: at - 60_000 })]);
  assert.deepEqual(texts(page, 'foot'), ['正在向好友分享 · 03:30 已同步']);
  ({ page } = await open(t, [stateOf(X, { author: A, share: false, syncState: 'disabled' })]));
  assert.deepEqual(texts(page, 'foot'), ['没有分享，好友看不到你的用量']);
  ({ page } = await open(t, [stateOf(X, { author: A, share: true, syncState: 'needs_cert' }), stateOf(Y, { author: A, syncState: 'error', error: '发布 x 失败：网关拒绝了这条' })]));
  assert.deepEqual(page.all(n => n.attrs?.class === 'warn').map(n => n.textContent), ['代签证书已过期，打开 Coda 续签后自动补发', 'rig 同步出错：发布 x 失败：网关拒绝了这条']);
  assert.ok(page.text().includes('正在向好友分享'));
  for (const gone of ['读取中', '不完整', '读不到', '需要更新', '零碎', '身份']) assert.ok(!page.text().includes(gone), gone);
});

test('工具栏只有「分享」开关：各台的状态记录都开着才显示开，没有状态记录就没有开关', async t => {
  let { log } = await open(t, []);
  assert.deepEqual(log.toolbars.at(-1) ?? [], []);
  ({ log } = await open(t, [stateOf(X, { author: A }), stateOf(Y, { author: A })]));
  assert.deepEqual(log.toolbars.at(-1), [{ id: 'share', kind: 'toggle', label: '分享', icon: 'person.2.fill', on: true }]);
  ({ log } = await open(t, [stateOf(X, { author: A }), stateOf(Y, { author: A, share: false })]));
  assert.equal(log.toolbars.at(-1)[0].on, false);
});

test('开关对每台的状态记录调 set-share（带记录，不选机器）；某台失败，页脚写「<机器名> 没连上，没有改」', async t => {
  const x = stateOf(X, { author: A }), y = stateOf(Y, { author: A });
  const { page, log } = await open(t, [x, y], { failing: [y.id] });
  log.handlers.toolbar({ id: 'share', on: false });
  await flush();
  assert.deepEqual(log.calls.map(([record, operation, input, options]) => [record, operation, input, options]), [[{ kind: KIND, id: x.id }, 'set-share', { on: false }, undefined], [{ kind: KIND, id: y.id }, 'set-share', { on: false }, undefined]]);
  assert.ok(page.text().includes('rig 没连上，没有改') && !page.text().includes('Mac 没连上'));
  assert.deepEqual(log.messages, []);
  // 记录变了，页脚的开关状态跟着记录走；再按一次，上次的失败提示清掉。
  feed(log, [{ ...x, spec: { ...x.spec, share: false, syncState: 'disabled' } }], 'MODIFIED');
  await flush();
  assert.equal(log.toolbars.at(-1)[0].on, false);
  log.calls.length = 0;
  log.handlers.toolbar({ id: 'share', on: true });
  await flush();
  assert.equal(log.calls.length, 2);
});

test('记录变化只重画一次（合到一帧），展开的状态保留；删除的记录从页面上去掉', async t => {
  const { page, log } = await open(t, friendsOf());
  page.all(n => n.tag === 'button' && n.attrs.class === undefined && n.attrs['aria-expanded'] !== undefined)[0].fire('click');
  assert.ok(page.all(n => n.attrs?.class === 'detail').length === 1);
  const before = page.root.children[0];
  const [first, second] = friendsOf();
  feed(log, [{ ...first, spec: { ...first.spec, lastSyncAt: DAY + 5_000_000 } }, { ...second, spec: { ...second.spec, lastSyncAt: DAY + 6_000_000 } }], 'MODIFIED');
  assert.equal(page.root.children[0], before, '同一帧里，还没重画');
  await flush();
  assert.notEqual(page.root.children[0], before);
  assert.equal(page.all(n => n.attrs?.class === 'detail').length, 1, '展开的行仍展开');
  feed(log, friendsOf().slice(-1), 'DELETED');
  await flush();
  assert.ok(page.text().includes('1.30K'));
});

// 展开后的小节：标题 → 各行文字。
const sections = page => Object.fromEntries(page.all(n => n.attrs?.class === 'sect').map(n => [n.children[0].textContent, n.children[1].children.map(row => row.textContent)]));
const heads = page => page.all(n => n.tag === 'button' && n.attrs.class === 'bar-head');
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 };
const row = over => ({ start: DAY + 1000, person: '', agent: 'codex', service: null, asked: 'gpt-5', served: null, ...zero, ...over });
const service = 'coda://openai-responses/11111111-2222-3333-4444-555555555555';

test('型号：先显示前 5 个，「展开全部 N 个型号」看全部；所有型号行都能展开，展开后列请求来源（直连与服务接口分开标）', async t => {
  const many = Array.from({ length: 7 }, (_, i) => row({ asked: `plain-${i}`, input: 10 + i }));
  const layered = [row({ service, served: 'gpt-5-2025', input: 9000 }), row({ service, turns: 2, reportedTurns: 2 }), row({ asked: 'gpt-5-latest', served: 'gpt-5-2025', input: 1000 })];
  const { page } = await open(t, [stateOf(X, { author: A }), ...usageOf(X, { author: A, sourceId: 'x', buckets: [...layered, ...many] })]);
  const names = () => page.all(n => n.tag === 'span' && n.attrs.class === 'truncate').map(n => n.textContent);
  assert.deepEqual(names(), ['gpt-5-2025', 'plain-6', 'plain-5', 'plain-4', 'plain-3']);
  page.button('展开全部 8 个型号').fire('click');
  assert.equal(names().length, 8);
  assert.equal(page.button('展开全部 8 个型号'), undefined);
  assert.equal(heads(page).length, 8, '每个型号行都是展开按钮');
  assert.ok(heads(page).every(head => head.attrs['aria-expanded'] === 'false' && head.children[0].children.some(c => c.attrs?.class === 'chev')));
  assert.ok(!page.text().includes('openai-responses'));
  heads(page)[0].fire('click');
  assert.equal(heads(page)[0].attrs['aria-expanded'], 'true');
  assert.deepEqual(sections(page)['请求来源'], ['gpt-5openai-responses9.00K · 2 回合', 'gpt-5-latest直连1.00K · 0 回合']);
  assert.ok(!page.text().includes('11111111'));
  heads(page)[0].fire('click');
  assert.equal(page.all(n => n.attrs.class === 'mdetail').length, 0);
});

const facts = (page, node) => page.all(n => n.attrs?.class?.startsWith('facts'), node).map(n => n.textContent);
const headOf = (page, name, node) => page.all(n => n.attrs?.class === 'bar-head', node).find(head => head.children[0].children[0].textContent === name);

test('展开：回合、占比、缓存命中、四项明细（四色条与四列数值）、按 Agent 拆分；占比小于 0.1% 写 <0.1%，没有缓存读不写命中率', async t => {
  const opus = { asked: 'opus-5', served: 'opus-5' };
  const rows = [row({ ...opus, agent: 'claude', input: 100, output: 50, cacheRead: 800, cacheWrite: 50, turns: 3, reportedTurns: 3 }), row({ ...opus, agent: 'sub', input: 40, turns: 1, reportedTurns: 1 }), row({ ...opus, agent: '_', input: 10 }),
    row({ agent: 'claude', asked: 'tiny', served: 'tiny', input: 1 }), row({ agent: 'claude', asked: 'big', served: 'big', input: 99_000 })];
  const { page } = await open(t, [stateOf(X, { author: A }), ...usageOf(X, { author: A, sourceId: 'x', buckets: rows })]);
  headOf(page, 'opus-5').fire('click');
  assert.deepEqual(facts(page), ['4 回合 · 占 1.0% · 缓存命中 80.0%']);
  const detail = page.all(n => n.attrs.class === 'mdetail')[0];
  assert.deepEqual(detail.children[1].children.map(span => span.attrs.class), ['c-input', 'c-output', 'c-cacheRead', 'c-cacheWrite'], '模型自己的四色堆叠条');
  assert.equal(detail.children[2].attrs.class, 'legend');
  assert.deepEqual(detail.children[2].children.map(c => c.textContent), ['输入150', '输出50', '缓存读800', '缓存写50']);
  assert.deepEqual(sections(page)['Agent'], ['claude1.00K · 3 回合', 'sub40 · 1 回合'], '兜底占位符 _ 不列');
  assert.ok(!('请求来源' in sections(page)) && !('设备' in sections(page)), '单一直连、单机：不列请求来源与设备');
  headOf(page, 'tiny').fire('click');
  assert.deepEqual(facts(page), ['4 回合 · 占 1.0% · 缓存命中 80.0%', '0 回合 · 占 <0.1%']);
});

test('Claude 官方直连：served-only 与请求行（含恢复首轮的少量 Token）合成一项，展开不列重复同名的请求来源', async t => {
  const rows = [row({ asked: null, served: 'claude-opus-5-5', agent: 'claude', input: 900, cacheRead: 100 }), row({ asked: 'claude-opus-5-5', agent: 'claude', turns: 149, reportedTurns: 149 }), row({ asked: 'claude-opus-5-5', agent: 'claude', input: 3, turns: 1, reportedTurns: 1 })];
  const { page } = await open(t, [stateOf(X, { author: A }), ...usageOf(X, { author: A, sourceId: 'x', buckets: rows })]);
  assert.equal(heads(page).length, 1);
  heads(page)[0].fire('click');
  assert.deepEqual(facts(page), ['150 回合 · 占 100.0% · 缓存命中 10.0%']);
  assert.deepEqual(Object.keys(sections(page)), ['Agent']);
});

test('「我」多台设备共用一个型号才列设备小节，好友榜展开不列设备；好友榜同样有回合、Agent 与四项明细', async t => {
  const solo = { ...bucket(DAY + 1500, 7), model: 'solo' };
  const { page } = await open(t, [stateOf(X, { author: A, friends: [B] }), stateOf(Y, { author: A, friends: [B] }),
    ...usageOf(X, { author: A, sourceId: 'x', buckets: [bucket(DAY + 1000, 1000), solo] }), ...usageOf(Y, { author: A, sourceId: 'y', buckets: [bucket(DAY + 2000, 300)] }), mirrorToday(X, B, 'phone', [bucket(DAY + 3000, 50)])]);
  const mineList = page.all(n => n.attrs.class === 'models')[0];
  headOf(page, 'opus', mineList).fire('click');
  assert.deepEqual(sections(page)['设备'], ['Mac1.00K · 1 回合', 'rig300 · 1 回合']);
  headOf(page, 'solo', mineList).fire('click');
  assert.equal(page.all(n => n.attrs.class === 'sect' && n.children[0].textContent === '设备').length, 1, '只有一台有用量的型号不列设备');
  page.all(n => n.tag === 'button' && n.attrs.class === undefined && n.attrs['aria-expanded'] !== undefined)[1].fire('click');
  headOf(page, 'opus', page.all(n => n.attrs.class === 'detail')[0]).fire('click');
  const friend = page.all(n => n.attrs.class === 'detail')[0];
  const detail = page.all(n => n.attrs.class === 'mdetail', friend)[0];
  assert.deepEqual(facts(page, friend), ['1 回合 · 占 100.0%']);
  assert.deepEqual(detail.children[2].children.map(c => c.textContent), ['输入50', '输出0', '缓存读0', '缓存写0']);
  assert.deepEqual(page.all(n => n.attrs.class === 'sect', friend).map(n => n.children[0].textContent), ['Agent']);
});

test('多个请求来源：直连与服务接口同列，无服务的项标「直连」，不同别名分开列', async t => {
  const rows = [row({ asked: null, served: 'claude-opus-5-5', agent: 'claude', input: 900 }), row({ asked: 'claude-opus-5-5', service, served: 'claude-opus-5-5', agent: 'claude', input: 50 }), row({ asked: 'opus', served: 'claude-opus-5-5', agent: 'claude', input: 5, turns: 1, reportedTurns: 1 })];
  const { page } = await open(t, [stateOf(X, { author: A }), ...usageOf(X, { author: A, sourceId: 'x', buckets: rows })]);
  heads(page)[0].fire('click');
  assert.deepEqual(sections(page)['请求来源'], ['claude-opus-5-5直连900 · 0 回合', 'claude-opus-5-5openai-responses50 · 0 回合', 'opus直连5 · 1 回合']);
});

test('外来文字只经文本渲染：只带服务的行显示接口种类名，名字里的控制字符在显示时清洗；展开后 Agent 与设备名同样清洗', async t => {
  const local = [{ ...row({ service: 'coda://openai-responses/11111111-2222-3333-4444-555555555555', asked: null, input: 900, turns: 1, reportedTurns: 1 }) }, row({ asked: 'gpt‮-5', input: 100, agent: 'ag‮ent' })];
  const { page } = await open(t, [stateOf(X, { author: A }), ...usageOf(X, { author: A, sourceId: 'x', buckets: local })]);
  const names = page.all(n => n.tag === 'span' && n.attrs.class === 'truncate').map(n => n.textContent);
  assert.ok(names.includes('openai-responses') && names.includes('gpt -5'), names.join('|'));
  assert.equal(heads(page).length, 2, '所有型号行都能点开');
  heads(page).find(head => head.textContent.startsWith('gpt -5')).fire('click');
  assert.deepEqual(sections(page)['Agent'], ['ag ent100 · 0 回合']);
  assert.ok(!sections(page)['请求来源'], '单一直连：不列请求来源');
});

test('watch 失败：写一行原因，不留空白页', async t => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  const host = fakeCoda();
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', host.coda);
  host.reject(new Error('forbidden'));
  await flush();
  assert.ok(page.text().includes('读不到记录：forbidden'));
});

test('关了分享、撤回没完成：页脚不说「好友看不到」，写「还没撤回完」和原因（出错的写明哪台）；撤完了才说没有分享', async t => {
  const unfinished = '已关闭分享，已发布的记录还没撤回完：';
  const off = withdrawal => stateOf(X, { author: A, share: false, syncState: 'disabled', withdrawal });
  let { page } = await open(t, [off({ state: 'needs_cert', error: null })]);
  assert.deepEqual(texts(page, 'foot'), [`${unfinished}等代签证书续签`]);
  assert.equal(page.all(n => n.attrs?.class === 'warn').length, 1);
  ({ page } = await open(t, [off({ state: 'queued', error: null })]));
  assert.ok(texts(page, 'foot')[0].startsWith(unfinished) && !page.text().includes('好友看不到'));
  ({ page } = await open(t, [stateOf(X, { author: A, share: false, syncState: 'disabled' }), stateOf(Y, { author: A, share: false, syncState: 'disabled', withdrawal: { state: 'error', error: '未安装或未启用好友插件，无法撤回好友可见记录' } })]));
  assert.deepEqual(texts(page, 'foot'), [`rig ${unfinished}未安装或未启用好友插件，无法撤回好友可见记录`]);
  ({ page } = await open(t, [off(null)]));
  assert.deepEqual(texts(page, 'foot'), ['没有分享，好友看不到你的用量']);
});
