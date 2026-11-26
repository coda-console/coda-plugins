// friend-chat 在测试宿主里整段跑（./host.mjs）：几端共用一本 Accord 账本，记录与操作按 coda/session@1 校验。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friend-chat/main.mjs';
import { buildMessageEvent } from '../../../plugins/friend-chat/lib/envelope.mjs';
import { dmConversationId, identityTitle, renderIdenticonPng } from '../../../plugins/friend-chat/lib/identity.mjs';
import { TEST_OWNER } from '../../helpers/mock-coda.mjs';
import { ACTIVE, author, EVENT, friend, manualClock, MACHINE, network, SESSION, side, START } from './host.mjs';

const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(author);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const avatar = who => ({ owner: TEST_OWNER, path: `plugins/friend-chat/services/avatar/ed25519/${who.slice(8)}.png`, mime: 'image/png' });
const texts = page => page.messages.map(message => message.text);
// 对端签的一条消息记录，`version` 是它自己的时间。
const signed = (by, to, id, text, version) => {
  const { recordId, body } = buildMessageEvent({ conv: dmConversationId(by, to), id, sentAt: version, text });
  return { kind: EVENT, author: by, id: recordId, version, body, audience: [to] };
};
const rejects = (promise, code, effects = 'none') => assert.rejects(promise, error => error.code === code && error.effects === effects);

async function pair(t, { a = {}, b = {} } = {}) {
  const net = network();
  const alice = await side(t, net, { root: A, friends: [friend(B)], ...a });
  const bob = await side(t, net, { root: B, friends: [friend(A)], ...b });
  return { net, alice, bob };
}

test('双端互认：建会话、发消息（audience 与 expectAuthor）、head 推进、read 默认 / after / before 分页', async t => {
  const { net, alice, bob } = await pair(t);
  const session = await alice.session(B);
  assert.deepEqual(session.spec, { title: identityTitle(B), container: { id: A, title: '好友对话' } });
  assert.deepEqual(session.status, {
    participants: [{ id: A, name: identityTitle(A), kind: 'person', self: true, avatar: avatar(A) }, { id: B, name: identityTitle(B), kind: 'person', avatar: avatar(B) }],
    notify: true, state: 'active',
  });
  assert.equal((await bob.session(A)).status.head, undefined);
  assert.deepEqual(await alice.read(B), { messages: [], cursor: null, more: false });

  const sent = await alice.post(B, { text: '你好' }, { id: 'call-1' });
  await net.settled();
  const [{ input, options }] = alice.accord.calls, eventId = sent.message.id.slice(A.length + 1);
  assert.match(eventId, UUID);
  assert.deepEqual(sent, { message: { id: `${A}/${eventId}`, cursor: '1' } });
  assert.deepEqual([input.kind, input.id, input.audience, input.expectAuthor, options], [EVENT, `${dmConversationId(A, B)}/${eventId}`, [B], A, { id: 'publish:call-1' }]);
  assert.deepEqual([input.body.text, input.body.parts], ['你好', [{ type: 'text', text: '你好' }]]);
  assert.equal((await alice.session(B)).status.head, '1');
  assert.equal((await bob.session(A)).status.head, '1');
  const got = await bob.read(A);
  assert.deepEqual(got.messages.map(m => [m.id, m.sender, m.text, m.cursor]), [[`${A}/${eventId}`, A, '你好', '1']]);

  // 同一次调用重来：同一个事件 ID、同一个游标，不多一条。
  assert.deepEqual(await alice.post(B, { text: '你好' }, { id: 'call-1' }), sent);
  for (let i = 1; i <= 4; i++) await bob.post(A, { text: `回复 ${i}`, parts: [{ type: 'text', text: `回复 ${i}` }] });
  await net.settled();
  assert.equal((await alice.session(B)).status.head, '5');
  assert.equal((await bob.session(A)).status.head, '5');
  assert.deepEqual(await alice.read(B, { limit: 2 }).then(page => [texts(page), page.cursor, page.more]), [['回复 3', '回复 4'], '5', true]);
  assert.deepEqual(await alice.read(B, { after: '1', limit: 2 }).then(page => [texts(page), page.cursor, page.more]), [['回复 1', '回复 2'], '3', true]);
  assert.deepEqual(await alice.read(B, { before: '3' }).then(page => [texts(page), page.cursor, page.more]), [['你好', '回复 1'], '2', false]);
  assert.deepEqual((await alice.read(B)).messages.map(m => m.sender), [A, B, B, B, B]);
});

test('离线补同步：对端更小 version 的旧记录排在本机新记录之后到达，照样入库、localSeq 与 head 前进', async t => {
  const { net, alice } = await pair(t, { a: { pageSize: 2 } });
  for (let i = 1; i <= 3; i++) await alice.post(B, { text: `新 ${i}` });
  await net.settled();
  assert.equal((await alice.session(B)).status.head, '3');
  alice.accord.queries.length = 0;
  await net.deliver(signed(B, A, 'offline-1', '离线写的旧消息', 5));
  await net.settled();
  assert.equal((await alice.session(B)).status.head, '4');
  const last = (await alice.read(B)).messages.at(-1);
  assert.deepEqual([last.text, last.cursor, last.createdAt], ['离线写的旧消息', '4', new Date(5).toISOString()]);
  // 翻完所有页，不因为前面的 version 大就停。
  assert.deepEqual(alice.accord.queries.map(query => query.cursor), [undefined, '2']);
  assert.ok(alice.accord.queries.every(query => query.kind === EVENT && query.limit === 200));
});

test('游标不前进的异常翻页不会死循环', async t => {
  const { net, alice } = await pair(t);
  const query = alice.accord.query;
  alice.accord.query = async (ref, operation, input) => ({ ...(await query(ref, operation, input)), nextCursor: 'same' });
  alice.coda.query = alice.accord.query;
  await alice.stop(); await alice.start();
  await net.deliver(signed(B, A, 'm1', '一条', 7));
  await net.settled();
  assert.equal((await alice.session(B)).status.head, '1');
});

test('本人另一台设备签的消息（author === selfRoot）按 conv 反查对端入库，head 前进', async t => {
  const { net, alice } = await pair(t);
  await net.deliver(signed(A, B, 'from-phone', '另一台设备发的', 9));
  await net.settled();
  assert.equal((await alice.session(B)).status.head, '1');
  assert.deepEqual((await alice.read(B)).messages.map(m => [m.id, m.sender, m.text]), [[`${A}/from-phone`, A, '另一台设备发的']]);
  // 发给不是好友的人的，没有会话可以反查，不入库。
  await net.deliver(signed(A, C, 'to-stranger', '给陌生人', 10));
  await net.settled();
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);
});

test('准入：机器钥匙裸绑、冲突、未互认的好友不建会话，消息也不收', async t => {
  const net = network();
  const friends = [friend(B), friend(C, { certified: false }), friend(D, { conflict: true }), friend(E, { bound: false })];
  const alice = await side(t, net, { root: A, friends });
  for (const [who, i] of [[C, 1], [D, 2], [E, 3]]) await net.deliver(signed(who, A, `m${i}`, `来自 ${i}`, i));
  await net.settled();
  assert.deepEqual(Object.keys(await alice.sessions()), [`${A}:${B}`]);
  // 之后对方成了可对话的好友，旧消息才被收进来。
  await alice.accord.change({ friends: [friend(B), friend(C)] });
  await net.settled();
  assert.equal((await alice.session(C)).status.head, '1');
});

test('没有历史的会话：解除好友、证书自然到期（定时器重算）后撤下', async t => {
  const clock = manualClock();
  const { alice } = await pair(t, { a: { clock, friends: [friend(B), friend(C)] } });
  assert.deepEqual(Object.keys(await alice.sessions()).sort(), [`${A}:${B}`, `${A}:${C}`]);
  await alice.accord.change({ friends: [friend(B)] });
  await alice.service.settled();
  assert.deepEqual(Object.keys(await alice.sessions()), [`${A}:${B}`]);
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [ACTIVE.until - START]);
  await clock.advance(ACTIVE.until - START);
  await alice.service.settled();
  assert.deepEqual(await alice.sessions(), {});
  assert.equal(clock.timers.size, 0);
});

test('首次 replace 挂起期间跨过证书 until：立即补跑一轮，撤下空会话，不留 active', async t => {
  const clock = manualClock(), net = network();
  const alice = await side(t, net, { root: A, friends: [friend(B)], clock, certificate: { active: true, until: START + 1000 }, start: false });
  alice.onWrite = () => { alice.onWrite = null; clock.pass(1000); };
  await alice.start();
  assert.deepEqual(alice.writes.map(([what]) => what), ['replace', 'delete']);
  assert.deepEqual(await alice.sessions(), {});
  assert.equal(clock.timers.size, 0);
});

test('写完之后读时钟恰好到达 until：要么立即补跑，要么排上定时器，不留无定时器的 active 会话', async t => {
  // 写完后接下来几次读时钟给出的时刻：差 1 毫秒再到点（两次读之间跨过），或第一次读就正好到点。
  for (const script of [[START + 999, START + 1000], [START + 1000]]) {
    const clock = manualClock(), net = network();
    const alice = await side(t, net, { root: A, friends: [friend(B)], clock, certificate: { active: true, until: START + 1000 }, start: false });
    alice.onWrite = () => { alice.onWrite = null; clock.script.push(...script); };
    await alice.start();
    const sessions = await alice.sessions();
    assert.ok(Object.keys(sessions).length === 0 || clock.timers.size === 1, `${script}：既没补跑也没排定时器`);
    await clock.advance(1000 - (clock.now() - START));
    await alice.service.settled();
    assert.deepEqual(await alice.sessions(), {}, String(script));
    assert.equal(clock.timers.size, 0);
  }
});

test('put 挂起期间跨过新证书的 until：有历史的会话转为 unreachable', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  alice.onWrite = () => { alice.onWrite = null; clock.pass(1000); };
  await alice.accord.change({ certificate: { active: true, until: START + 1000 }, friends: [friend(B), friend(C)] });
  await alice.service.settled();
  const status = (await alice.session(B)).status;
  assert.deepEqual([status.state, status.reason, status.head], ['unreachable', '本机签名证书已过期，打开客户端后自动续期', '1']);
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);
  assert.equal(clock.timers.size, 0);
});

test('合法签名但 conv 不是单聊的事件（grp:…）忽略：不产生 head，解除好友后也不留虚假会话', async t => {
  const { net, alice } = await pair(t);
  const group = (by, id) => {
    const { recordId, body } = buildMessageEvent({ conv: 'grp:team', id, sentAt: 3, text: '群消息' });
    return { kind: EVENT, author: by, id: recordId, version: 3, body, audience: [A, B] };
  };
  await net.deliver(group(B, 'g1'));
  await net.deliver(group(A, 'g2'));
  await net.settled();
  assert.equal((await alice.session(B)).status.head, undefined);
  assert.deepEqual(await alice.read(B), { messages: [], cursor: null, more: false });
  await alice.accord.change({ friends: [] });
  await alice.service.settled();
  assert.deepEqual(await alice.sessions(), {});
});

test('有历史的会话：解除好友、证书到期、解绑个人身份后保留为 unreachable，read 照读，post 以 invalid_state 拒绝且不发布', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  const calls = () => alice.accord.calls.length, before = calls();
  const blocked = async reason => {
    const status = (await alice.session(B)).status;
    assert.deepEqual([status.state, status.reason, status.head], ['unreachable', reason, '1']);
    assert.deepEqual(texts(await alice.read(B)), ['在吗']);
    await rejects(alice.post(B, { text: '再发' }), 'invalid_state');
    assert.equal(calls(), before);
  };

  await alice.accord.change({ friends: [] });
  await alice.service.settled();
  await blocked('对方已不是你的好友');
  await alice.accord.change({ friends: [friend(B, { bound: false })] });
  await alice.service.settled();
  await blocked('双方还没有完成互认');

  await alice.accord.change({ friends: [friend(B)], certificate: { active: true, until: START + 1000 } });
  await alice.service.settled();
  assert.equal((await alice.session(B)).status.state, 'active');
  await clock.advance(1000);
  await alice.service.settled();
  await blocked('本机签名证书已过期，打开客户端后自动续期');
  await alice.accord.change({ certificate: { active: false } });
  await alice.service.settled();
  await blocked('本机签名证书已过期或未生效，打开客户端后自动续期');

  await alice.accord.change({ certificate: null });
  await alice.service.settled();
  assert.equal(alice.accord.entry().spec.author, MACHINE);
  await blocked('请先在「设置 › 身份」绑定个人身份');
  // 重启后也还在：从状态目录里枚举出存过的身份。
  await alice.stop(); await alice.start();
  await blocked('请先在「设置 › 身份」绑定个人身份');
});

test('换了个人身份：原身份的历史会话保留为 unreachable，新身份照常', async t => {
  const { net, alice } = await pair(t);
  await alice.post(B, { text: '旧身份' });
  await net.settled();
  await alice.accord.change({ root: C, friends: [friend(B)] });
  await alice.service.settled();
  const sessions = await alice.sessions();
  assert.deepEqual([sessions[`${A}:${B}`].status.state, sessions[`${A}:${B}`].status.reason], ['unreachable', '本机已换成另一个个人身份，这段对话只能查看']);
  assert.deepEqual([sessions[`${C}:${B}`].status.state, sessions[`${C}:${B}`].status.head], ['active', undefined]);
  assert.deepEqual(texts(await alice.read(B, {}, `${A}:${B}`)), ['旧身份']);
  await rejects(alice.post(B, { text: 'x' }, { key: `${A}:${B}` }), 'invalid_state');
});

test('post：取消、不支持的媒体、发布前失败与结果未知', async t => {
  const { net, alice } = await pair(t);
  const aborted = AbortSignal.abort();
  await assert.rejects(alice.post(B, { text: 'x' }, { signal: aborted }), error => error === aborted.reason && error.name === 'AbortError');
  await rejects(alice.post(B, { text: 'x', parts: [{ type: 'image', name: 'a.png', upload: TEST_OWNER }] }), 'unsupported');
  await rejects(alice.post(B, { text: '' }), 'invalid_input');
  assert.equal(alice.accord.calls.length, 0);

  // 发布前被取消（子调用确知没发出）：抛取消的原因。
  const controller = new AbortController();
  alice.accord.beforePublish = () => { controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError', effects: 'none' }); };
  await assert.rejects(alice.post(B, { text: 'x' }, { signal: controller.signal }), error => error === controller.signal.reason);
  assert.equal(alice.accord.calls.length, 1);
  // 子调用已发出、结局未知时父调用被取消：是结果未知，不是可重发的取消。
  for (const effects of ['unknown', undefined]) {
    const midway = new AbortController();
    alice.accord.beforePublish = () => { midway.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError', effects }); };
    await rejects(alice.post(B, { text: 'x' }, { signal: midway.signal }), 'unknown', 'unknown');
  }
  alice.accord.beforePublish = null;
  alice.accord.failure = Object.assign(new Error('证书过期'), { code: 'invalid_state', effects: 'none' });
  await rejects(alice.post(B, { text: 'x' }), 'invalid_state');
  alice.accord.failure = Object.assign(new Error('断了'), { code: 'unavailable', effects: 'unknown' });
  await rejects(alice.post(B, { text: 'x' }), 'unknown', 'unknown');
  alice.accord.failure = null;
  await net.settled();
  assert.equal((await alice.session(B)).status.head, undefined);

  // 发布成功后 signal 才响：照样入库、推进 head。
  const late = new AbortController();
  alice.accord.onPublish = () => late.abort();
  const sent = await alice.post(B, { text: '发出去了' }, { signal: late.signal });
  assert.equal(sent.message.cursor, '1');
  assert.equal((await alice.session(B)).status.head, '1');
});

test('watch 抢先把刚发布的事件入库：post 仍返回同一个游标，等于 head，不重复', async t => {
  const { net, alice } = await pair(t);
  await alice.post(B, { text: '第一条' });
  let headBefore;
  alice.accord.onPublish = async () => {
    await alice.accord.notify();
    await alice.service.settled();
    headBefore = (await alice.session(B)).status.head;
  };
  const sent = await alice.post(B, { text: '第二条' });
  await net.settled();
  assert.equal(headBefore, '2', 'watch 那轮同步已入库');
  assert.equal(sent.message.cursor, '2');
  assert.equal((await alice.session(B)).status.head, '2');
  assert.deepEqual(texts(await alice.read(B)), ['第一条', '第二条']);
});

test('记录写法：首次整份 replace 清掉上次留下的，之后只写变了的', async t => {
  const net = network();
  const stale = { kind: SESSION, owner: TEST_OWNER, plugin: 'friend-chat', id: 'stale', spec: { title: '旧', container: { id: 'x', title: '好友对话' } }, status: { participants: [] } };
  const alice = await side(t, net, { root: A, friends: [friend(B)], records: [stale] });
  assert.deepEqual(alice.writes, [['replace', [`${A}:${B}`]]]);
  assert.deepEqual(Object.keys(await alice.sessions()), [`${A}:${B}`]);
  await alice.accord.notify();
  await alice.service.settled();
  assert.deepEqual(alice.writes.length, 1, '没有变化不写');
  await alice.accord.change({ friends: [friend(B), friend(C)] });
  await alice.service.settled();
  assert.deepEqual(alice.writes.slice(1), [['put', `${A}:${C}`]]);
  await alice.accord.change({ friends: [friend(C)] });
  await alice.service.settled();
  assert.deepEqual(alice.writes.slice(2), [['delete', `${A}:${B}`]]);
});

test('read：不合法的 key 是 not_found', async t => {
  const { alice } = await pair(t);
  await assert.rejects(alice.handlers.get('read')({}, { record: { kind: SESSION, id: 'x', key: `${A}:${A}` } }), error => error.code === 'not_found');
  await assert.rejects(alice.handlers.get('read')({}, { record: { kind: SESSION, id: 'x', key: 'nope' } }), error => error.code === 'not_found');
});

test('avatar 流服务：GET 给确定性 PNG，HEAD 无体，别的方法 405，路径或查询串不对 404', async t => {
  const { alice } = await pair(t);
  const url = `http://service/ed25519/${B.slice(8)}.png`;
  const got = await alice.host.serve('avatar', new Request(url));
  const bytes = Buffer.from(await got.arrayBuffer());
  assert.equal(got.status, 200);
  assert.deepEqual([got.headers.get('content-type'), got.headers.get('content-length'), got.headers.get('cache-control')],
    ['image/png', String(bytes.length), 'private, max-age=31536000, immutable']);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.deepEqual(bytes, renderIdenticonPng(B));
  const head = await alice.host.serve('avatar', new Request(url, { method: 'HEAD' }));
  assert.deepEqual([head.status, head.headers.get('content-length'), (await head.arrayBuffer()).byteLength], [200, String(bytes.length), 0]);
  const post = await alice.host.serve('avatar', new Request(url, { method: 'POST', body: 'x' }));
  assert.deepEqual([post.status, post.headers.get('allow')], [405, 'GET, HEAD']);
  for (const bad of [`${url}?size=1`, 'http://service/ed25519/abc.png', `http://service/ed25519/${B.slice(8).toUpperCase()}.png`, `http://service/x/${B.slice(8)}.png`])
    assert.equal((await alice.host.serve('avatar', new Request(bad))).status, 404, bad);
});

test('main：activate 登记处理函数、服务与 watch，deactivate 全部撤下并清掉到期定时器', async t => {
  const net = network();
  const alice = await side(t, net, { root: A, friends: [friend(B)], start: false });
  await activate(alice.coda);
  assert.ok((await alice.session(B)), '建了会话');
  assert.equal(alice.accord.listeners.size, 1);
  await deactivate();
  assert.equal(alice.accord.listeners.size, 0);
  await assert.rejects(alice.host.serve('avatar', new Request(`http://service/ed25519/${B.slice(8)}.png`)), error => error.code === 'not_found');
  await assert.rejects(alice.host.call({ kind: SESSION, id: (await alice.session(B)).id }, 'read', {}), error => error.code === 'not_found');

  const clock = manualClock();
  const bob = await side(t, net, { root: B, friends: [friend(A)], clock });
  assert.equal(clock.timers.size, 1);
  await bob.stop();
  assert.equal(clock.timers.size, 0);
});

test('证书有效期很长时，定时器按 setTimeout 上限钳制，到点重读后再排', async t => {
  const clock = manualClock();
  const net = network();
  const alice = await side(t, net, { root: A, friends: [friend(B)], clock, certificate: { active: true, until: START + 2 ** 31 + 500 } });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [2 ** 31 - 1]);
  await clock.advance(2 ** 31 - 1);
  await alice.service.settled();
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [501]);
  assert.equal((await alice.session(B)).status.state, 'active');
});
