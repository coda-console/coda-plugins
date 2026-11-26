import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENT_KIND, buildMessageEvent, parseEventRecord } from '../../../plugins/friend-chat/lib/envelope.mjs';
import { SESSION_PROTOCOL } from '@coda-console/protocol/protocol';
import { newAjv } from '@coda-console/protocol/validate';
import { dmConversationId } from '../../../plugins/friend-chat/lib/identity.mjs';

const [A, B, C] = ['11', '22', '33'].map(n => `ed25519:${n.repeat(32)}`);
const conv = dmConversationId(A, B);
const record = (body, extra) => ({ kind: EVENT_KIND, author: A, id: `${conv}/${body?.id}`, body, ...extra });
const body = extra => ({ v: 1, conv, id: 'm1', type: 'message', sentAt: 1000, text: '你好', ...extra });

test('buildMessageEvent 构造记录 ID 与默认文本片段', () => {
  assert.deepEqual(buildMessageEvent({ conv, id: 'm1', sentAt: 5, text: '你好' }), {
    recordId: `${conv}/m1`,
    body: { v: 1, conv, id: 'm1', type: 'message', sentAt: 5, text: '你好', parts: [{ type: 'text', text: '你好' }] },
  });
  const parts = [{ type: 'text', text: 'x' }];
  assert.deepEqual(buildMessageEvent({ conv, id: 'm1', sentAt: 0, text: 'x', parts }).body.parts, parts);
});

test('buildMessageEvent 校验各个输入', () => {
  const ok = { conv, id: 'm1', sentAt: 5, text: 'x' };
  const bad = patch => assert.throws(() => buildMessageEvent({ ...ok, ...patch }), { code: 'invalid_input', effects: 'none' });
  bad({ conv: 'dm:x' });
  for (const id of ['', 'a/b', undefined, 5, 'a b', 'a\nb', 'x'.repeat(200)]) bad({ id });
  for (const sentAt of [-1, 1.5, '1', undefined, 2 ** 53, 9e15]) bad({ sentAt });
  for (const text of ['', undefined, 5, 'a\ud800']) bad({ text });
  bad({ parts: 'x' });
  bad({ parts: [{ type: 'bogus' }] });
  bad({ text: 'x'.repeat(60000) });
  assert.throws(() => buildMessageEvent(), { code: 'invalid_input' });
});

test('buildMessageEvent 记录 ID 的长度上限按字符与 UTF-8 字节', () => {
  const room = 200 - conv.length - 1;
  assert.ok(buildMessageEvent({ conv, id: 'a'.repeat(room), sentAt: 0, text: 'x' }));
  assert.throws(() => buildMessageEvent({ conv, id: 'a'.repeat(room + 1), sentAt: 0, text: 'x' }), { code: 'invalid_input' });
  assert.throws(() => buildMessageEvent({ conv, id: '好'.repeat(80), sentAt: 0, text: 'x' }), { code: 'invalid_input' });
});

test('parseEventRecord：普通消息', () => {
  const sent = buildMessageEvent({ conv, id: 'm1', sentAt: 1000, text: '你好' });
  const out = parseEventRecord({ kind: EVENT_KIND, author: A, id: sent.recordId, body: sent.body }, { selfRoot: B, peerAuthor: A });
  assert.deepEqual(out, { status: 'ok', conv, id: 'm1', author: A, sentAt: 1000, text: '你好', parts: [{ type: 'text', text: '你好' }] });
});

test('parseEventRecord：基本校验与撤回后的空体', () => {
  assert.equal(parseEventRecord(null).status, 'invalid');
  assert.equal(parseEventRecord(record(body(), { kind: 'other/x' })).status, 'invalid');
  assert.equal(parseEventRecord(record(body(), { author: 'bad' })).status, 'invalid');
  for (const empty of [undefined, null, {}]) assert.deepEqual(parseEventRecord({ kind: EVENT_KIND, author: A, id: 'x', body: empty }), { status: 'empty' });
  for (const patch of [{ v: 2 }, { conv: 'nope' }, { id: 'a/b' }, { sentAt: -1 }, { sentAt: 1.5 }]) {
    assert.equal(parseEventRecord(record(body(patch), { id: `${conv}/m1` })).status, 'invalid', JSON.stringify(patch));
  }
  assert.equal(parseEventRecord(record(body(), { id: `${conv}/other` })).status, 'invalid');
  assert.equal(parseEventRecord(record('text')).status, 'invalid');
});

test('parseEventRecord：成员安全边界', () => {
  const ctx = { selfRoot: A, peerAuthor: B };
  assert.equal(parseEventRecord(record(body()), ctx).status, 'ok');
  assert.equal(parseEventRecord(record(body(), { author: B }), ctx).status, 'ok');
  const third = parseEventRecord(record(body(), { author: C }), ctx);
  assert.equal(third.status, 'invalid');
  assert.match(third.reason, /成员/);
  const foreign = dmConversationId(B, C);
  assert.equal(parseEventRecord(record(body({ conv: foreign }), { id: `${foreign}/m1` }), ctx).status, 'invalid');
  assert.equal(parseEventRecord(record(body()), { selfRoot: A, peerAuthor: A }).status, 'invalid');
  assert.equal(parseEventRecord(record(body(), { author: C })).status, 'ok');
  const grp = 'grp:team';
  assert.equal(parseEventRecord(record(body({ conv: grp }), { id: `${grp}/m1`, author: C }), ctx).status, 'ok');
});

test('parseEventRecord：消息片段只留认得的，媒体保留 blob 指针', () => {
  const blob = { owner: '12345678-1234-1234-1234-123456789abc', path: `content/${'a'.repeat(64)}`, size: 3 };
  const parts = [{ type: 'text', text: 'hi' }, { type: 'image', name: 'a.png', width: 4, height: 5, mime: 'image/png', blob, extra: 1 },
    { type: 'audio', name: 'a.m4a', blob: { owner: 'x' } }, { type: 'image', name: 'no-blob' }, { type: 'sticker' }, { type: 'text', text: 5 }, 'x', null,
    { type: 'file', name: 'f', blob: { ...blob, junk: 1 }, preview: blob }];
  const out = parseEventRecord(record(body({ text: undefined, parts })));
  assert.equal(out.text, 'hi');
  assert.deepEqual(out.parts, [{ type: 'text', text: 'hi' }, { type: 'image', name: 'a.png', blob, width: 4, height: 5, mime: 'image/png' },
    { type: 'file', name: 'f', blob, preview: blob }]);
});

test('parseEventRecord：只有顶层文本、或没有可显示内容的消息', () => {
  const textOnly = parseEventRecord(record(body({ parts: 'junk' })));
  assert.deepEqual([textOnly.status, textOnly.text, textOnly.parts], ['ok', '你好', undefined]);
  assert.deepEqual(parseEventRecord(record(body({ text: undefined, parts: [] }))), { status: 'ignored' });
  assert.deepEqual(parseEventRecord(record(body({ text: '', parts: [{ type: 'sticker' }] }))), { status: 'ignored' });
});

test('parseEventRecord：撤回、编辑、表情映射到 about，裸 eventId 归一化为作者命名空间', () => {
  const recall = parseEventRecord(record(body({ type: 'recall', target: 'm0', text: undefined })));
  assert.deepEqual(recall, { status: 'ok', conv, id: 'm1', author: A, sentAt: 1000, text: '', about: { message: `${A}/m0`, change: 'recall' } });
  const edit = parseEventRecord(record(body({ type: 'edit', target: 'm0', value: '改后', text: '改后' })));
  assert.deepEqual([edit.text, edit.about], ['改后', { message: `${A}/m0`, change: 'edit', value: '改后' }]);
  const reaction = parseEventRecord(record(body({ type: 'reaction', target: `${B}/m0`, value: '👍', text: undefined })));
  assert.deepEqual(reaction.about, { message: `${B}/m0`, change: 'reaction', value: '👍' });
  for (const target of [undefined, '', 5]) assert.deepEqual(parseEventRecord(record(body({ type: 'recall', target }))), { status: 'ignored' });
});

test('parseEventRecord：不合法的变更目标与内容返回 invalid', () => {
  const change = extra => parseEventRecord(record(body({ type: 'reaction', target: 'm0', ...extra })));
  for (const target of ['a b', 'bad/m0', `${B}/`, `${B}/a/b`, '/m0', `${B}/a b`, 'x'.repeat(201), `${B}/${'x'.repeat(201)}`, 'm0\n', `${B}/\ud800`]) {
    assert.equal(change({ target }).status, 'invalid', target);
  }
  for (const value of [5, null, {}, 'x'.repeat(2049), 'a\ud800']) assert.equal(change({ value }).status, 'invalid');
  assert.equal(change({ value: 'x'.repeat(2048) }).status, 'ok');
});

test('parseEventRecord：成员上下文给了任一键就必须两个都合法', () => {
  const rec = record(body());
  for (const ctx of [{ selfRoot: null, peerAuthor: B }, { selfRoot: A, peerAuthor: null }, { selfRoot: A }, { peerAuthor: B },
    { selfRoot: undefined, peerAuthor: undefined }, { selfRoot: 'bad', peerAuthor: B }, { selfRoot: A, peerAuthor: '' }]) {
    const out = parseEventRecord(rec, ctx);
    assert.equal(out.status, 'invalid', JSON.stringify(ctx));
    assert.match(out.reason, /成员上下文/);
  }
  assert.equal(parseEventRecord(rec).status, 'ok');
  assert.equal(parseEventRecord(rec, {}).status, 'ok');
  assert.equal(parseEventRecord(rec, { selfRoot: A, peerAuthor: B }).status, 'ok');
});

test('parseEventRecord：未来未知类型按顶层文本降级', () => {
  const out = parseEventRecord(record(body({ type: 'poll-from-the-future', text: '投票：吃啥', options: [1] })));
  assert.deepEqual([out.status, out.text, out.parts, out.about], ['ok', '投票：吃啥', [{ type: 'text', text: '投票：吃啥' }], undefined]);
  assert.deepEqual(parseEventRecord(record(body({ type: 'future', text: '' }))), { status: 'ignored' });
  assert.deepEqual(parseEventRecord(record(body({ type: 'future', text: undefined }))), { status: 'ignored' });
});

const OWNER = '12345678-1234-1234-1234-123456789abc';
const goodBlob = { owner: OWNER, path: `uploads/${OWNER}`, name: 'n', size: 1, mime: 'image/png', sha256: 'a'.repeat(64) };
const image = extra => ({ type: 'image', name: 'a.png', blob: goodBlob, ...extra });

test('parseEventRecord：媒体片段严格合乎 coda/session@1，不合规的整片丢弃并回退顶层文本', () => {
  const clean = parts => parseEventRecord(record(body({ parts })));
  assert.deepEqual(clean([image({ width: 3, height: 4, duration: 1.5, thumb: 'abc', extra: 1, blob: { ...goodBlob, junk: 1 }, preview: { owner: OWNER, path: `uploads/${OWNER}/preview` } })]).parts,
    [{ type: 'image', name: 'a.png', blob: goodBlob, width: 3, height: 4, duration: 1.5, thumb: 'abc', preview: { owner: OWNER, path: `uploads/${OWNER}/preview` } }]);
  const content = { owner: OWNER, path: `content/${'b'.repeat(64)}` };
  assert.ok(clean([image({ blob: content })]).parts);
  const poison = [
    image({ blob: { owner: OWNER, path: '../etc/passwd' } }), image({ blob: { owner: OWNER, path: 'uploads/x' } }),
    image({ blob: { owner: OWNER.toUpperCase(), path: `uploads/${OWNER}` } }), image({ blob: { owner: 'x', path: `uploads/${OWNER}` } }),
    image({ blob: { ...goodBlob, path: `plugins/a/services/b/${'x'.repeat(2048)}` } }), image({ blob: 'x' }), image({ blob: undefined }),
    image({ preview: 'legacy' }), image({ preview: { owner: OWNER, path: 'nope' } }), image({ name: 5 }), image({ name: 'x'.repeat(1025) }),
    image({ size: -1 }), image({ size: 1.5 }), image({ width: 0 }), image({ height: '3' }), image({ duration: -1 }), image({ duration: null }),
    image({ mime: 'x'.repeat(256) }), image({ thumb: 'x'.repeat(8193) }), image({ blob: { ...goodBlob, sha256: 'A'.repeat(64) } }),
    image({ blob: { ...goodBlob, size: -1 } }), image({ blob: { ...goodBlob, name: 'x'.repeat(1025) } }),
    image({ blob: { ...goodBlob, owner: [OWNER] } }), image({ preview: { owner: [OWNER], path: `uploads/${OWNER}/preview` } }), image({ blob: { ...goodBlob, sha256: ['a'.repeat(64)] } }),
  ];
  for (const part of poison) {
    const out = clean([part, { type: 'text', text: '剩下的' }]);
    assert.deepEqual(out.parts, [{ type: 'text', text: '剩下的' }]);
  }
  const onlyBad = parseEventRecord(record(body({ parts: [poison[0]] })));
  assert.deepEqual([onlyBad.text, onlyBad.parts], ['你好', undefined]);
});

test('入站结果里每个字段都能通过 coda/session@1 read 结果的校验', () => {
  const validate = newAjv().compile(SESSION_PROTOCOL.operations.read.result);
  const messageOf = out => ({ id: `${out.author}/${out.id}`, cursor: '1', sender: out.author, text: out.text, createdAt: new Date(out.sentAt).toISOString(),
    ...(out.parts ? { parts: out.parts } : {}), ...(out.about ? { about: out.about } : {}) });
  const outs = [
    parseEventRecord(record(body({ parts: [{ type: 'text', text: 'hi' }, image({ width: 1, height: 1, preview: { owner: OWNER, path: `uploads/${OWNER}/preview` } }),
      { type: 'audio', name: 'v', duration: 2, blob: { owner: OWNER, path: `plugins/p/services/s/a%20b/c.m4a` } }] }))),
    parseEventRecord(record(body({ type: 'edit', target: `${B}/m0`, value: 'v' }))),
    parseEventRecord(record(body({ type: 'recall', target: 'm0' }))),
    parseEventRecord(record(body({ type: 'reaction', target: `${B}/${'x'.repeat(190)}`, value: '👍' }))),
  ];
  for (const out of outs) assert.equal(out.status, 'ok');
  const result = { messages: outs.map(messageOf), cursor: '1', more: false };
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(validate({ messages: [{ ...result.messages[0], parts: [image({ blob: { owner: 'x', path: '..' } })] }], cursor: null, more: false }), false);
});

test('buildMessageEvent：拒绝孤立代理项，自定义 parts 只留合规字段的干净副本', () => {
  const ok = { conv, id: 'm1', sentAt: 5, text: 'x' };
  for (const patch of [{ id: 'a\ud800' }, { text: 'a\udc00b' }, { parts: [{ type: 'text', text: 'a\ud800' }] },
    { parts: [image({ name: 'a\ud800' })] }, { parts: [image({ mime: '\ud800' })] }, { parts: [image({ thumb: '\udfff' })] },
    { parts: [image({ blob: { ...goodBlob, name: '\ud800' } })] }, { parts: [image({ blob: { owner: OWNER, path: 'bad' } })] },
    { parts: [image({ blob: { ...goodBlob, owner: [OWNER] } })] }, { parts: [image({ preview: { owner: [OWNER], path: `uploads/${OWNER}/preview` } })] }]) {
    assert.throws(() => buildMessageEvent({ ...ok, ...patch }), { code: 'invalid_input', effects: 'none' }, JSON.stringify(patch));
  }
  const dirty = [{ type: 'text', text: 'a', evil: { deep: 1 } }, image({ junk: 1, blob: { ...goodBlob, junk: 1 } })];
  const out = buildMessageEvent({ ...ok, parts: dirty });
  assert.deepEqual(out.body.parts, [{ type: 'text', text: 'a' }, { type: 'image', name: 'a.png', blob: goodBlob }]);
  assert.notEqual(out.body.parts[0], dirty[0]);
  assert.equal(buildMessageEvent({ ...ok, id: '好', text: '😀' }).body.text, '😀');
});

test('字符串长度上限按 Unicode 码点计，与 JSON Schema maxLength 一致', () => {
  const emoji = n => '😀'.repeat(n);
  const clean = part => parseEventRecord(record(body({ parts: [part, { type: 'text', text: 'rest' }] }))).parts.length;
  assert.equal(clean(image({ name: emoji(1024) })), 2);
  assert.equal(clean(image({ name: emoji(1025) })), 1);
  assert.equal(clean(image({ mime: emoji(255) })), 2);
  assert.equal(clean(image({ mime: emoji(256) })), 1);
  assert.equal(clean(image({ thumb: emoji(8192) })), 2);
  assert.equal(clean(image({ thumb: emoji(8193) })), 1);
  assert.equal(clean(image({ blob: { ...goodBlob, name: emoji(1024) } })), 2);
  const reaction = value => parseEventRecord(record(body({ type: 'reaction', target: 'm0', value }))).status;
  assert.equal(reaction(emoji(2048)), 'ok');
  assert.equal(reaction(emoji(2049)), 'invalid');
  assert.equal(buildMessageEvent({ conv, id: 'm1', sentAt: 0, text: 'x', parts: [image({ name: emoji(1024) })] }).body.parts.length, 1);
  assert.throws(() => buildMessageEvent({ conv, id: 'm1', sentAt: 0, text: 'x', parts: [image({ name: emoji(1025) })] }), { code: 'invalid_input' });
});
