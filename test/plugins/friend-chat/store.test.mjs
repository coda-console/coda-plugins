import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SESSION_PROTOCOL } from '@coda-console/protocol/protocol';
import { newAjv } from '@coda-console/protocol/validate';
import { EVENT_KIND, parseEventRecord } from '../../../plugins/friend-chat/lib/envelope.mjs';
import { dmConversationId } from '../../../plugins/friend-chat/lib/identity.mjs';
import { createStore } from '../../../plugins/friend-chat/lib/store.mjs';

const [A, B, C] = ['11', '22', '33'].map(n => `ed25519:${n.repeat(32)}`);
const conv = dmConversationId(A, B);
let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'friend-chat-store-')); });
after(() => rm(dir, { recursive: true, force: true }));

const event = (id, extra) => ({ status: 'ok', conv, id, author: B, sentAt: 1_700_000_000_000, text: `text ${id}`, ...extra });
const fresh = () => mkdtemp(join(dir, 's-'));
async function filled(count, root = A) {
  const store = createStore(await fresh(), root);
  for (let i = 1; i <= count; i++) await store.ingest(event(`m${i}`));
  return store;
}
const ids = page => page.messages.map(m => m.id.slice(m.id.indexOf('/') + 1));

test('入库：localSeq 从 1 严格递增，重复喂入幂等', async () => {
  const store = createStore(await fresh(), A);
  assert.equal(await store.head(conv), null);
  assert.deepEqual(await store.ingest(event('m1')), { inserted: true, localSeq: 1 });
  assert.deepEqual(await store.ingest(event('m2')), { inserted: true, localSeq: 2 });
  assert.deepEqual(await store.ingest(event('m1', { text: '不同内容' })), { inserted: false, localSeq: 1 });
  assert.deepEqual(await store.ingest(event('m3')), { inserted: true, localSeq: 3 });
  assert.equal(await store.head(conv), '3');
  assert.equal((await store.readMessages(conv)).messages[0].text, 'text m1');
});

test('对外 Message.id 带作者命名空间：不同作者的同名 eventId 不会撞 ID', async () => {
  const store = createStore(await fresh(), A);
  await store.ingest(event('m1'));
  await store.ingest(event('m1', { author: A }));
  assert.deepEqual((await store.readMessages(conv)).messages.map(m => m.id), [`${B}/m1`, `${A}/m1`]);
});

test('hasEvent：按会话、作者与 eventId 查是否已入库，重开后仍在', async () => {
  const state = await fresh(), store = createStore(state, A);
  await store.ingest(event('m1'));
  assert.equal(await store.hasEvent(conv, B, 'm1'), true);
  assert.equal(await store.hasEvent(conv, A, 'm1'), false);
  assert.equal(await store.hasEvent(conv, B, 'm2'), false);
  assert.equal(await store.hasEvent(dmConversationId(A, C), B, 'm1'), false);
  assert.equal(await createStore(state, A).hasEvent(conv, B, 'm1'), true);
});

test('去重按作者加 eventId：不同作者的同名 eventId 是两条消息', async () => {
  const store = createStore(await fresh(), A);
  assert.equal((await store.ingest(event('m1'))).inserted, true);
  assert.deepEqual(await store.ingest(event('m1', { author: A })), { inserted: true, localSeq: 2 });
  assert.deepEqual(await store.ingest(event('m1', { conv: dmConversationId(A, C) })), { inserted: true, localSeq: 1 });
});

test('离线补进来的旧消息：sentAt 更早也拿到更大的 localSeq，head 前进', async () => {
  const store = createStore(await fresh(), A);
  await store.ingest(event('new', { sentAt: 2_000_000_000_000 }));
  await store.ingest(event('old', { sentAt: 1_000_000_000_000 }));
  const page = await store.readMessages(conv);
  assert.deepEqual(page.messages.map(m => [m.id, m.cursor, m.createdAt]), [
    [`${B}/new`, '1', '2033-05-18T03:33:20.000Z'], [`${B}/old`, '2', '2001-09-09T01:46:40.000Z']]);
  assert.equal(await store.head(conv), '2');
});

test('消息输出符合 coda/session@1 的 message 形状', async () => {
  const store = createStore(await fresh(), A);
  const parts = [{ type: 'text', text: 'hi' }], about = { message: 'm0', change: 'edit', value: 'x' };
  await store.ingest(event('m1', { text: 'hi', parts }));
  await store.ingest(event('m2', { text: '', about }));
  assert.deepEqual((await store.readMessages(conv)).messages, [
    { id: `${B}/m1`, cursor: '1', sender: B, text: 'hi', parts, createdAt: '2023-11-14T22:13:20.000Z' },
    { id: `${B}/m2`, cursor: '2', sender: B, text: '', about, createdAt: '2023-11-14T22:13:20.000Z' }]);
});

test('读：默认取最新 limit 条（升序），more 表示更早还有', async () => {
  const store = await filled(5);
  assert.deepEqual(await store.readMessages(conv), { messages: (await store.readMessages(conv, { limit: 100 })).messages, cursor: '5', more: false });
  const page = await store.readMessages(conv, { limit: 2 });
  assert.deepEqual([ids(page), page.cursor, page.more], [['m4', 'm5'], '5', true]);
  const exact = await store.readMessages(conv, { limit: 5 });
  assert.deepEqual([exact.messages.length, exact.more], [5, false]);
  const empty = await createStore(await fresh(), A).readMessages(conv);
  assert.deepEqual(empty, { messages: [], cursor: null, more: false });
});

test('读：after 取之后最早的 limit 条，无新消息时游标为 null', async () => {
  const store = await filled(5);
  let page = await store.readMessages(conv, { after: '1', limit: 2 });
  assert.deepEqual([ids(page), page.cursor, page.more], [['m2', 'm3'], '3', true]);
  page = await store.readMessages(conv, { after: '3', limit: 2 });
  assert.deepEqual([ids(page), page.cursor, page.more], [['m4', 'm5'], '5', false]);
  page = await store.readMessages(conv, { after: '5' });
  assert.deepEqual(page, { messages: [], cursor: null, more: false });
  page = await store.readMessages(conv, { after: '99' });
  assert.deepEqual(page, { messages: [], cursor: null, more: false });
});

test('读：before 取之前最新的 limit 条并按升序返回', async () => {
  const store = await filled(5);
  let page = await store.readMessages(conv, { before: '5', limit: 2 });
  assert.deepEqual([ids(page), page.cursor, page.more], [['m3', 'm4'], '4', true]);
  page = await store.readMessages(conv, { before: '3', limit: 2 });
  assert.deepEqual([ids(page), page.cursor, page.more], [['m1', 'm2'], '2', false]);
  page = await store.readMessages(conv, { before: '99', limit: 2 });
  assert.deepEqual([ids(page), page.cursor, page.more], [['m4', 'm5'], '5', true]);
  page = await store.readMessages(conv, { before: '1' });
  assert.deepEqual(page, { messages: [], cursor: null, more: false });
});

test('读：非法游标、limit、会话与 after/before 同带都抛 invalid_input', async () => {
  const store = await filled(1);
  const bad = options => assert.rejects(store.readMessages(conv, options), { code: 'invalid_input', effects: 'none' });
  for (const cursor of ['0', '-1', '01', '1.5', 'abc', '', '1'.repeat(17), 5, null]) {
    await bad({ after: cursor });
    await bad({ before: cursor });
  }
  await bad({ after: '1', before: '2' });
  for (const limit of [0, 101, 1.5, '5']) await bad({ limit });
  await assert.rejects(store.readMessages('nope'), { code: 'invalid_input', effects: 'none' });
  assert.equal((await store.readMessages(conv, { after: '1'.repeat(16) })).more, false);
});

test('持久化：重开后消息、序号与去重都在，别的会话与别的本机身份互相隔离', async () => {
  const root = await fresh();
  const first = createStore(root, A);
  await first.ingest(event('m1'));
  await first.ingest(event('m2'));
  const again = createStore(root, A);
  assert.deepEqual(await again.ingest(event('m2')), { inserted: false, localSeq: 2 });
  assert.deepEqual(await again.ingest(event('m3')), { inserted: true, localSeq: 3 });
  assert.deepEqual(ids(await createStore(root, A).readMessages(conv)), ['m1', 'm2', 'm3']);
  assert.equal(await again.head(dmConversationId(A, C)), null);
  assert.equal(await createStore(root, B).head(conv), null);
});

test('文件布局与权限：roots/<哈希>/ 下 0700 目录、0600 文件，原子写不留临时文件', async () => {
  const root = await fresh(), store = createStore(root, A);
  await store.ingest(event('m1'));
  const [rootDir] = await readdir(join(root, 'roots'));
  assert.match(rootDir, /^[0-9a-f]{24}$/);
  const folder = join(root, 'roots', rootDir), files = await readdir(folder);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{24}\.json$/);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'roots'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(folder, files[0]))).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(join(folder, files[0]), 'utf8'));
  assert.deepEqual([saved.v, saved.conv, saved.messages.map(m => m.localSeq)], [1, conv, [1]]);
});

test('并发入库：序号不重复、不丢', async () => {
  const root = await fresh(), store = createStore(root, A);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.ingest(event(`m${i}`))));
  assert.deepEqual(results.map(r => r.localSeq), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await createStore(root, A).readMessages(conv, { limit: 100 })).messages.length, 20);
});

test('写盘失败时不留半条：回滚后可重新入库', async () => {
  const root = await fresh();
  const store = createStore(join(root, 'blocked'), A);
  await store.ingest(event('m1'));
  await rm(join(root, 'blocked'), { recursive: true });
  await writeFile(join(root, 'blocked'), 'file');
  await assert.rejects(store.ingest(event('m2')));
  assert.equal(await store.head(conv), '1');
  await rm(join(root, 'blocked'));
  assert.deepEqual(await store.ingest(event('m2')), { inserted: true, localSeq: 2 });
});

test('selfRoot 必须是合法公钥', () => {
  assert.throws(() => createStore(dir, 'bad'), TypeError);
});

test('远端畸形记录不会污染 store：入库的消息始终通过 coda/session@1 read 结果校验', async () => {
  const validate = newAjv().compile(SESSION_PROTOCOL.operations.read.result);
  const store = createStore(await fresh(), A);
  const owner = '12345678-1234-1234-1234-123456789abc';
  const remote = (id, body) => ({ kind: EVENT_KIND, author: B, id: `${conv}/${id}`, body: { v: 1, conv, id, sentAt: 1000, ...body } });
  const records = [
    remote('ok', { type: 'message', text: '正常', parts: [{ type: 'image', name: 'a', blob: { owner, path: `uploads/${owner}` } }] }),
    remote('badblob', { type: 'message', text: '坏附件', parts: [{ type: 'image', name: 'a', blob: { owner: 'x', path: '../x' } }, { type: 'audio', name: 'b', blob: { owner, path: 'nope' } }] }),
    remote('long', { type: 'recall', target: 'x'.repeat(5000) }),
    remote('longvalue', { type: 'edit', target: 'm0', value: 'x'.repeat(5000) }),
    remote('numvalue', { type: 'reaction', target: 'm0', value: 5 }),
    remote('badtarget', { type: 'recall', target: 'a/b/c' }),
    remote('arrayowner', { type: 'message', text: '数组 owner', parts: [{ type: 'image', name: 'a', blob: { owner: [owner], path: `uploads/${owner}` } },
      { type: 'video', name: 'v', blob: { owner, path: `uploads/${owner}` }, preview: { owner: [owner], path: `uploads/${owner}/preview` } }] }),
    remote('good-recall', { type: 'recall', target: 'ok' }),
  ];
  const statuses = [];
  for (const record of records) {
    const parsed = parseEventRecord(record, { selfRoot: A, peerAuthor: B });
    statuses.push(parsed.status);
    if (parsed.status === 'ok') await store.ingest(parsed);
  }
  assert.deepEqual(statuses, ['ok', 'ok', 'invalid', 'invalid', 'invalid', 'invalid', 'ok', 'ok']);
  const page = await store.readMessages(conv);
  assert.equal(validate(page), true, JSON.stringify(validate.errors));
  assert.deepEqual(page.messages.map(m => m.id), [`${B}/ok`, `${B}/badblob`, `${B}/arrayowner`, `${B}/good-recall`]);
  assert.deepEqual([page.messages[1].parts, page.messages[2].parts], [undefined, undefined]);
  assert.deepEqual(page.messages[3].about, { message: `${B}/ok`, change: 'recall' });
});

test('read 一页按 UTF-8 JSON 字节预算裁剪：20 条约 28 KB 长文本，默认 / before / after 页都在 768 KiB 内，翻页不丢不重', async () => {
  const BUDGET = 768 * 1024, bytes = page => Buffer.byteLength(JSON.stringify(page));
  const store = createStore(await fresh(), A);
  for (let i = 1; i <= 20; i++) {
    const text = `${i}:${'长'.repeat(9300)}`;
    await store.ingest(event(`m${i}`, { text, parts: [{ type: 'text', text }] }));
  }
  const seq = page => page.messages.map(m => Number(m.cursor));
  const latest = await store.readMessages(conv);
  assert.ok(bytes(latest) <= BUDGET && latest.messages.length < 20 && latest.more);
  assert.equal(latest.cursor, '20');
  // before 一页页往前，接得上，直到最早。
  const backward = [seq(latest)];
  for (let page = latest; page.more;) {
    page = await store.readMessages(conv, { before: page.messages[0].cursor });
    assert.ok(bytes(page) <= BUDGET && page.messages.length > 0);
    assert.equal(page.cursor, page.messages.at(-1).cursor);
    backward.unshift(seq(page));
  }
  assert.deepEqual(backward.flat(), Array.from({ length: 20 }, (_, i) => i + 1));
  // after 从第 1 条起一页页往后，cursor 是这页最后一条。
  const forward = [];
  for (let cursor = '1', more = true; more;) {
    const page = await store.readMessages(conv, { after: cursor });
    assert.ok(bytes(page) <= BUDGET && page.messages.length > 0);
    assert.equal(page.cursor, page.messages.at(-1).cursor);
    forward.push(...seq(page));
    ({ cursor, more } = page);
  }
  assert.deepEqual(forward, Array.from({ length: 19 }, (_, i) => i + 2));
});

test('hasEvent：eventId 不是字符串时给 false，不抛', async () => {
  const store = await filled(1);
  assert.equal(await store.hasEvent(conv, B, { toString: 1 }), false);
});
