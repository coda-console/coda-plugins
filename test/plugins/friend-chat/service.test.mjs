// friend-chat 在测试宿主里整段跑（./host.mjs）：几端共用一本 Accord 账本，记录与操作按 coda/session@1 校验。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friend-chat/main.mjs';
import { buildMessageEvent } from '../../../plugins/friend-chat/lib/envelope.mjs';
import { dmConversationId, renderIdenticonPng } from '../../../plugins/friend-chat/lib/identity.mjs';
import { XS_A, XS_B, titleOf as identityTitle } from '../../helpers/accord-keys.mjs';
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

test('会话标题与参与者名：同昵称同末 4 位尾号时，本机身份、当前好友与历史对端一起向左加位', async t => {
  const net = network();
  const alice = await side(t, net, { root: XS_A, friends: [friend(B)] });
  assert.equal((await alice.session(B)).spec.title, identityTitle(B));
  await alice.accord.change({ friends: [friend(B), friend(XS_B)] });
  await net.settled();
  const session = await alice.session(XS_B);
  assert.deepEqual([session.spec.title, session.status.participants.map(p => p.name)], ['xs #14084', ['xs #04084', 'xs #14084']]);
  assert.equal((await alice.session(B)).spec.title, identityTitle(B), '别的好友的名字不受影响');
  // 对方发过消息、之后不再是好友：历史会话仍参与撞号比较。
  const bob = await side(t, net, { root: XS_B, friends: [friend(XS_A)] });
  await alice.post(XS_B, { text: '你好' }, { id: 'call-1' });
  await net.settled();
  await alice.accord.change({ friends: [friend(B)] });
  await net.settled();
  const kept = await alice.session(XS_B);
  assert.deepEqual([kept.spec.title, kept.status.participants.map(p => p.name), kept.status.state], ['xs #14084', ['xs #04084', 'xs #14084'], 'unreachable']);
  assert.equal(bob.root, XS_B);
});

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
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [ACTIVE.until - START + 1]);
  await clock.advance(ACTIVE.until - START + 1);
  await alice.service.settled();
  assert.deepEqual(await alice.sessions(), {});
  assert.equal(clock.timers.size, 0);
});

test('首次 replace 挂起期间跨过证书 until：立即补跑一轮，撤下空会话，不留 active', async t => {
  const clock = manualClock(), net = network();
  const alice = await side(t, net, { root: A, friends: [friend(B)], clock, certificate: { active: true, until: START + 1000 }, start: false });
  alice.onWrite = () => { alice.onWrite = null; clock.pass(1001); };
  await alice.start();
  assert.deepEqual(alice.writes.map(([what]) => what), ['replace', 'delete']);
  assert.deepEqual(await alice.sessions(), {});
  assert.equal(clock.timers.size, 0);
});

test('写完之后读时钟恰好越过 until：要么立即补跑，要么排上定时器，不留无定时器的 active 会话', async t => {
  // until 当刻仍有效。写完后接下来几次读时钟给出的时刻：先在 until 再越过（两次读之间跨过），或第一次读就越过。
  for (const script of [[START + 1000, START + 1001], [START + 1001]]) {
    const clock = manualClock(), net = network();
    const alice = await side(t, net, { root: A, friends: [friend(B)], clock, certificate: { active: true, until: START + 1000 }, start: false });
    alice.onWrite = () => { alice.onWrite = null; clock.script.push(...script); };
    await alice.start();
    const sessions = await alice.sessions();
    assert.ok(Object.keys(sessions).length === 0 || clock.timers.size === 1, `${script}：既没补跑也没排定时器`);
    await clock.advance(1001 - (clock.now() - START));
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
  alice.onWrite = () => { alice.onWrite = null; clock.pass(1001); };
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
  await clock.advance(1001);
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
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [502]);
  assert.equal((await alice.session(B)).status.state, 'active');
});

test('其他插件调 read、post、draft 一律 forbidden；本机客户端（无 caller.plugin）照常', async t => {
  const { net, alice } = await pair(t);
  const record = { kind: SESSION, id: 'rec', key: `${A}:${B}` };
  const ctx = caller => ({ id: `call-${Math.random()}`, record, caller, signal: new AbortController().signal, call: alice.accord.call });
  const native = { machine: MACHINE };
  const sent = await alice.handlers.get('post')({ text: '客户端发的' }, ctx(native));
  assert.equal(sent.message.cursor, '1');
  assert.deepEqual(texts(await alice.handlers.get('read')({}, ctx(native))), ['客户端发的']);
  assert.deepEqual(await alice.handlers.get('draft')({}, ctx(native)), {});
  const other = { machine: MACHINE, plugin: 'other-plugin' };
  for (const operation of ['read', 'post', 'draft']) {
    await rejects(Promise.resolve().then(() => alice.handlers.get(operation)({ text: '偷发' }, ctx(other))), 'forbidden');
  }
  await net.settled();
  assert.equal(alice.accord.calls.length, 1, '被拒的 post 没有发布');
  assert.equal((await alice.session(B)).status.head, '1');
});

test('post：replyTo 与非空 mentions 明确 unsupported，不发布', async t => {
  const { alice } = await pair(t);
  await rejects(alice.post(B, { text: 'x', replyTo: `${B}/m1` }), 'unsupported');
  await rejects(alice.post(B, { text: 'x', mentions: [B] }), 'unsupported');
  assert.equal(alice.accord.calls.length, 0);
  assert.equal((await alice.post(B, { text: '空提及照发', mentions: [] })).message.cursor, '1');
});

test('离线连发跨页补同步：新消息按发送先后正序拿 localSeq，已有游标不变，head 指向最新一条', async t => {
  const { net, alice } = await pair(t, { a: { pageSize: 2 } });
  for (let i = 1; i <= 2; i++) await alice.post(B, { text: `在线 ${i}` });
  await net.settled();
  const before = (await alice.read(B)).messages;
  // 对端离线时连发三条，回来后一起到达（宿主按 version 降序给，跨两页）。
  for (let i = 1; i <= 3; i++) net.ledger.push(signed(B, A, `offline-${i}`, `离线 ${i}`, 10 + i));
  await net.notify();
  await net.settled();
  const page = await alice.read(B);
  assert.deepEqual(texts(page), ['在线 1', '在线 2', '离线 1', '离线 2', '离线 3']);
  assert.deepEqual(page.messages.slice(0, 2), before);
  assert.equal((await alice.session(B)).status.head, '5');
  assert.equal(page.messages.at(-1).cursor, '5');
  assert.deepEqual(alice.accord.queries.slice(-3).map(query => query.cursor), [undefined, '2', '4']);
});

test('入站要求本机能签且对端此刻可对话：失格或证书失效期间晚到的记录不入库，恢复后再收', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock, friends: [friend(B), friend(C)] } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  const history = async () => [(await alice.session(B)).status.head, texts(await alice.read(B))];
  const expected = ['1', ['在吗']];

  await alice.accord.change({ friends: [friend(B, { conflict: true }), friend(C, { conflict: true })] });
  await net.deliver(signed(B, A, 'late-1', '冲突期间到的', 20));
  await net.deliver(signed(A, B, 'late-2', '本人另一台设备在冲突期间发的', 21));
  await net.deliver(signed(C, A, 'late-3', '没历史的对端发的', 22));
  await net.settled();
  assert.deepEqual(await history(), expected);
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);

  await alice.accord.change({ friends: [] });
  await net.settled();
  assert.deepEqual(await history(), expected);
  assert.deepEqual(Object.keys(await alice.sessions()), [`${A}:${B}`]);

  await alice.accord.change({ friends: [friend(B), friend(C)], certificate: { active: false } });
  await net.deliver(signed(B, A, 'late-4', '证书失效期间到的', 23));
  await net.settled();
  assert.deepEqual(await history(), expected);
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);

  // 双方恢复准入、证书有效后补收。
  await alice.accord.change({ certificate: ACTIVE });
  await net.settled();
  assert.deepEqual(texts(await alice.read(B)), ['在吗', '冲突期间到的', '本人另一台设备在冲突期间发的', '证书失效期间到的']);
  assert.equal((await alice.session(C)).status.head, '1');
});

test('首次同步失败：activate 抛出原错误，撤下处理函数、服务、watch 与定时器', async t => {
  const clock = manualClock(), net = network();
  const alice = await side(t, net, { root: A, friends: [friend(B)], clock, start: false });
  const broken = new Error('宿主写记录失败');
  alice.onWrite = () => { throw broken; };
  await assert.rejects(alice.start(), error => error === broken);
  assert.equal(alice.accord.listeners.size, 0);
  assert.equal(clock.timers.size, 0);
  await assert.rejects(alice.host.serve('avatar', new Request(`http://service/ed25519/${B.slice(8)}.png`)), error => error.code === 'not_found');
  await assert.rejects(alice.host.call({ kind: SESSION, id: 'x' }, 'read', {}), error => error.code === 'not_found');
});

test('运行期同步暂时失败：退避重试（5s 起翻倍），恢复后补齐投影并清掉重试定时器', async t => {
  const clock = manualClock();
  const { alice } = await pair(t, { a: { clock } });
  const retries = () => [...clock.timers.values()].map(timer => timer.ms).filter(ms => ms <= 60_000);
  let failures = 2;
  alice.onWrite = () => { if (failures-- > 0) throw new Error('暂时写不进'); };
  await alice.accord.change({ friends: [friend(B), friend(C)] });
  await alice.service.settled();
  assert.deepEqual(retries(), [5000]);
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);
  await clock.advance(5000);
  await alice.service.settled();
  assert.deepEqual(retries(), [10_000]);
  await clock.advance(10_000);
  await alice.service.settled();
  assert.deepEqual(retries(), []);
  assert.equal((await alice.session(C)).status.state, 'active');
  // 停止时清掉排着的重试。
  failures = 1;
  await alice.accord.change({ friends: [friend(B), friend(C), friend(D)] });
  await alice.service.settled();
  assert.deepEqual(retries(), [5000]);
  await alice.stop();
  assert.equal(clock.timers.size, 0);
});

test('未到 from 的证书：到 from 时重读，空会话开放、历史会话从 unreachable 回到 active，再排 until', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  const future = { from: START + 1000, until: START + 5000 };
  await alice.accord.change({ certificate: { active: false, ...future }, friends: [friend(B), friend(C)] });
  await alice.service.settled();
  assert.equal((await alice.session(B)).status.state, 'unreachable');
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [1000]);
  // 宿主到 from 才报 active，且不推送变更。
  alice.accord.certificate = { active: true, ...future };
  await clock.advance(1000);
  await alice.service.settled();
  const sessions = await alice.sessions();
  assert.deepEqual([sessions[`${A}:${B}`].status.state, sessions[`${A}:${B}`].status.head], ['active', '1']);
  assert.deepEqual([sessions[`${A}:${C}`].status.state, sessions[`${A}:${C}`].status.head], ['active', undefined]);
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [4001]);
});

test('写投影期间跨过未来证书的 from：写完立即重读 Accord，开放会话并改排 until', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  const future = { from: START + 1000, until: START + 5000 };
  // 写入挂起期间走到 from，宿主此后报 active（不推送变更）。
  alice.onWrite = () => { alice.onWrite = null; clock.pass(1000); alice.accord.certificate = { active: true, ...future }; };
  await alice.accord.change({ certificate: { active: false, ...future }, friends: [friend(B), friend(C)] });
  await alice.service.settled();
  const sessions = await alice.sessions();
  assert.deepEqual([sessions[`${A}:${B}`].status.state, sessions[`${A}:${C}`]?.status.state], ['active', 'active']);
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [4001]);
});

test('到 from 时重读 Accord 暂时失败：走退避重试，重读成功后开放会话', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  const future = { from: START + 1000, until: START + 60_000 };
  await alice.accord.change({ certificate: { active: false, ...future } });
  await alice.service.settled();
  alice.accord.certificate = { active: true, ...future };
  const get = alice.coda.get;
  let failures = 1;
  alice.coda.get = ref => ref.kind === 'coda/accord@1' && failures-- > 0 ? Promise.reject(new Error('暂时读不到')) : get(ref);
  await clock.advance(1000);
  await alice.service.settled();
  assert.equal((await alice.session(B)).status.state, 'unreachable');
  // 按缓存快照投影后照排 until 重读，另有 5 秒的重读重试。
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [START + 60_000 - clock.now() + 1, 5000]);
  await clock.advance(5000);
  await alice.service.settled();
  assert.equal((await alice.session(B)).status.state, 'active');
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [START + 60_000 - clock.now() + 1]);
});

test('已有历史时同步新消息：已入库的不重排、不重复，新的接在后面', async t => {
  const { net, alice } = await pair(t);
  await alice.post(B, { text: '新 1' });
  await net.deliver(signed(B, A, 'old', '离线旧消息', 5));
  await net.settled();
  const before = (await alice.read(B)).messages;
  assert.deepEqual(texts({ messages: before }), ['新 1', '离线旧消息']);
  await net.deliver(signed(B, A, 'next', '又一条', 7));
  await net.notify();
  await net.settled();
  const page = await alice.read(B);
  assert.deepEqual(page.messages.slice(0, 2), before);
  assert.deepEqual(texts(page), ['新 1', '离线旧消息', '又一条']);
  assert.equal((await alice.session(B)).status.head, '3');
});

test('越过 until 时重读 Accord 暂时失败：当轮仍按缓存快照撤下空会话、有历史的降为 unreachable，并排上重读重试', async t => {
  const clock = manualClock();
  const { net, alice } = await pair(t, { a: { clock, friends: [friend(B), friend(C)], certificate: { active: true, until: START + 1000 } } });
  await alice.post(B, { text: '在吗' });
  await net.settled();
  const get = alice.coda.get;
  let failures = 1;
  alice.coda.get = ref => ref.kind === 'coda/accord@1' && failures-- > 0 ? Promise.reject(new Error('暂时读不到')) : get(ref);
  await clock.advance(1001);
  await alice.service.settled();
  const status = (await alice.session(B)).status;
  assert.deepEqual([status.state, status.reason, status.head], ['unreachable', '本机签名证书已过期，打开客户端后自动续期', '1']);
  assert.equal((await alice.sessions())[`${A}:${C}`], undefined);
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [5000]);
  await clock.advance(5000);
  await alice.service.settled();
  assert.equal(failures, -1, '重试时重读了 Accord');
  assert.equal(clock.timers.size, 0);
  assert.equal((await alice.session(B)).status.state, 'unreachable');
});

test('账本里混入 body.id 不是字符串的畸形记录：忽略它，同轮正常消息照常入库', async t => {
  const { net, alice } = await pair(t);
  const conv = dmConversationId(B, A);
  net.ledger.push({ kind: EVENT, author: B, id: `${conv}/bad`, version: 8, body: { conv, id: { toString: 1 } }, audience: [A] });
  net.ledger.push(signed(B, A, 'good', '正常消息', 7));
  await net.notify();
  await net.settled();
  assert.equal((await alice.session(B)).status.head, '1');
  assert.deepEqual(texts(await alice.read(B)), ['正常消息']);
});
