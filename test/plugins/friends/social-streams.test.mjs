// 私信、动态的纯逻辑：入参清洗、Accord 记录的投影（最高版本、归属过滤、排序），以及实时流的变更集与游标续传。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DM_KIND, FEED_KIND, MAX_HISTORY, MAX_MEDIA, MAX_SNAPSHOT_FRAME_BYTES, MAX_TEXT, createStreamHub, frameOf, normalizeDmInput, normalizeFeedInput, parseCursor,
  projectDmRecords, projectFeedRecords, snapshotFrames } from '../../../plugins/friends/lib/social-streams.mjs';

const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`, C = `ed25519:${'c'.repeat(64)}`;
const HASH = 'ab'.repeat(32), PIC = { owner: '0123abcd-4567-89ef-0123-456789abcdef', path: `content/${HASH}`, sha256: HASH, mime: 'image/png', size: 10 };
const EPOCH = '00000000-0000-4000-8000-000000000001';

test('the constants are the ones the protocol definition uses', () => {
  assert.deepEqual([DM_KIND, FEED_KIND, MAX_TEXT, MAX_MEDIA, MAX_HISTORY], ['friends/dm', 'friends/feed', 8000, 4, 500]);
});

test('normalizeDmInput sends to exactly one friend, never to the public or to oneself, and needs text or an attachment', () => {
  const at = { selfAuthor: A, now: 100 };
  assert.deepEqual(normalizeDmInput({ to: B, id: ' m1 ', text: ' 你好 ', replyTo: 'm0' }, at),
    { id: 'm1', to: B, audience: [B], body: { to: B, text: '你好', replyTo: 'm0', createdAt: 100 } });
  assert.deepEqual(normalizeDmInput({ to: B, attachments: [PIC] }, at), { id: undefined, to: B, audience: [B], body: { to: B, text: '', attachments: [PIC], createdAt: 100 } });
  assert.equal(normalizeDmInput({ to: B, text: '😀'.repeat(MAX_TEXT) }, at).body.text.length, 2 * MAX_TEXT, '8000 code points are allowed');
  for (const input of [{ to: 'public', text: 'x' }, { to: '', text: 'x' }, { to: A, text: 'x' }, { to: B.toUpperCase(), text: 'x' }, { to: B }, { to: B, text: '  ' },
    { to: B, text: '😀'.repeat(MAX_TEXT + 1) }, { to: B, attachments: [] }, { to: B, attachments: Array(5).fill(PIC) }, { to: B, attachments: [{ ...PIC, path: 'uploads/x' }] },
    { to: B, text: 'x', id: '' }, { to: B, text: 'x', id: 'a\u0000b' }, { to: B, text: 'x', id: 'x'.repeat(201) }, { to: B, text: 'x', replyTo: '' }, { to: B, text: 'x', replyTo: 'a\nb' }])
    assert.throws(() => normalizeDmInput(input, at), Error, JSON.stringify(input).slice(0, 80));
});

test('a retry keeps the createdAt of the record already there, so the same message hashes the same', () => {
  assert.equal(normalizeDmInput({ to: B, id: 'm1', text: 'x' }, { selfAuthor: A, existingCreatedAt: 7, now: 100 }).body.createdAt, 7);
  assert.equal(normalizeFeedInput({ id: 'p1', text: 'x' }, { existingCreatedAt: 7, now: 100 }).body.createdAt, 7);
  assert.equal(normalizeFeedInput({ text: 'x' }, { existingCreatedAt: -1, now: 100 }).body.createdAt, 100, 'a bad stored createdAt is not reused');
  assert.throws(() => normalizeFeedInput({ text: 'x' }, { now: -1 }));
});

test('normalizeFeedInput defaults to the public, dedupes a chosen audience, refuses an empty one and checks the media', () => {
  assert.deepEqual(normalizeFeedInput({ text: ' 今天 ' }, { now: 5 }), { id: undefined, audience: ['public'], body: { text: '今天', createdAt: 5 } });
  assert.deepEqual(normalizeFeedInput({ id: 'p', media: [PIC], audience: [B, C, B] }, { now: 5 }), { id: 'p', audience: [B, C], body: { text: '', media: [PIC], createdAt: 5 } });
  for (const input of [{ text: 'x', audience: [] }, { text: 'x', audience: ['everyone'] }, { text: 'x', audience: Array(501).fill(B) }, {}, { text: '' },
    { media: Array(5).fill(PIC) }, { media: [{ ...PIC, sha256: 'cd'.repeat(32) }] }, { text: '😀'.repeat(MAX_TEXT + 1) }])
    assert.throws(() => normalizeFeedInput(input, { now: 5 }), Error, JSON.stringify(input).slice(0, 80));
});

const dm = (author, id, version, body, local) => ({ kind: DM_KIND, author, id, version, body, local });

test('projectDmRecords keeps only the highest version, drops a withdrawn one entirely, and keeps only what is really between this machine and the peer', () => {
  const records = [
    dm(A, 'm1', 1, { to: B, text: '旧', createdAt: 10 }, true), dm(A, 'm1', 2, { to: B, text: '新', attachments: [PIC, { path: 'bad' }], createdAt: 10 }, true),
    dm(B, 'r1', 1, { to: A, text: '回', replyTo: 'm1', createdAt: 20 }, false),
    dm(B, 'r2', 1, { to: A, text: '撤了', createdAt: 5 }, false), dm(B, 'r2', 2, {}, false),
    dm(C, 'y', 1, { to: A, text: 'C 说', createdAt: 15 }, false),
    dm(C, 'x', 1, { to: B, text: '串线', createdAt: 1 }, false),
    dm(B, 'f', 1, { to: A, text: '冒充本机', createdAt: 1 }, true),
    dm(A, 'self', 1, { to: A, text: '给自己', createdAt: 1 }, true),
    dm(A, 'echo', 1, { to: C, text: '本机的却不是本机签', createdAt: 1 }, false),
    dm(B, 'bad', 1, { to: A, text: '', attachments: [{ path: 'x' }], createdAt: 1 }, false),
    dm(B, 'long', 1, { to: A, text: 'x'.repeat(MAX_TEXT + 1), createdAt: 1 }, false),
    dm(B, 'time', 1, { to: A, text: 'x', createdAt: -1 }, false),
  ];
  assert.deepEqual(projectDmRecords(records, { selfAuthor: A }), [
    { author: A, id: 'm1', version: 2, local: true, peer: B, to: B, text: '新', attachments: [PIC], createdAt: 10 },
    { author: C, id: 'y', version: 1, local: false, peer: C, to: A, text: 'C 说', attachments: [], createdAt: 15 },
    { author: B, id: 'r1', version: 1, local: false, peer: B, to: A, text: '回', attachments: [], replyTo: 'm1', createdAt: 20 },
  ]);
  assert.deepEqual(projectDmRecords(records, { selfAuthor: null }), [], 'with no identity nothing is anyone\'s');
});

test('projectDmRecords sorts by createdAt, then version, author and id, and does not depend on the input order', () => {
  const records = [dm(B, 'b', 1, { to: A, text: '1', createdAt: 1 }, false), dm(A, 'a', 3, { to: B, text: '2', createdAt: 1 }, true),
    dm(A, 'c', 1, { to: B, text: '3', createdAt: 1 }, true), dm(A, 'b', 1, { to: B, text: '4', createdAt: 1 }, true)];
  const order = list => projectDmRecords(list, { selfAuthor: A }).map(item => `${item.author[8]}${item.id}`);
  assert.deepEqual(order(records), ['ab', 'ac', 'bb', 'aa']);
  assert.deepEqual(order([...records].reverse()), ['ab', 'ac', 'bb', 'aa']);
});

test('projectFeedRecords keeps the highest version, a later withdrawal removes the post, and the newest comes first', () => {
  const post = (author, id, version, body, local = false) => ({ kind: FEED_KIND, author, id, version, body, local });
  const items = projectFeedRecords([post(A, 'p1', 1, { text: '早', createdAt: 1 }, true), post(B, 'p2', 1, { text: '旧', createdAt: 3 }), post(B, 'p2', 2, { text: '改', media: [PIC], createdAt: 3 }),
    post(B, 'p3', 1, { text: '撤', createdAt: 9 }), post(B, 'p3', 2, {}), post(C, 'p4', 1, { media: [{ path: 'no' }], createdAt: 5 }), post(C, 'p5', 1, { media: [PIC], createdAt: 2 })]);
  assert.deepEqual(items, [
    { author: B, id: 'p2', version: 2, local: false, text: '改', media: [PIC], createdAt: 3 },
    { author: C, id: 'p5', version: 1, local: false, text: '', media: [PIC], createdAt: 2 },
    { author: A, id: 'p1', version: 1, local: true, text: '早', media: [], createdAt: 1 },
  ]);
});

test('parseCursor takes only epoch:seq', () => {
  assert.deepEqual(parseCursor(`${EPOCH}:12`), { epoch: EPOCH, seq: 12 });
  for (const bad of [undefined, '', 'x:1', `${EPOCH}:`, `${EPOCH}:-1`, `${EPOCH}:01`, `${EPOCH}:1.5`, `${EPOCH}:99999999999999999999`, `${EPOCH.replace('4000', '4OOO')}:1`]) assert.equal(parseCursor(bad), null, String(bad));
});

const item = (author, id, version, more = {}) => ({ author, id, version, peer: author === A ? B : author, createdAt: version, ...more });

test('applySnapshot gives a retract for what is gone and an upsert for what is new or changed, each with the next seq', () => {
  const hub = createStreamHub({ epoch: EPOCH });
  assert.deepEqual(hub.applySnapshot([item(A, '1', 1), item(B, '2', 1)]).map(e => [e.seq, e.type, e.item?.id]), [[1, 'upsert', '1'], [2, 'upsert', '2']]);
  assert.deepEqual(hub.applySnapshot([item(A, '1', 1), item(B, '2', 1)]), [], 'nothing changed, nothing to say');
  assert.deepEqual(hub.applySnapshot([item(B, '2', 2), item(C, '3', 1)]), [
    { seq: 3, type: 'retract', author: A, id: '1', peer: B },
    { seq: 4, type: 'upsert', item: item(B, '2', 2) },
    { seq: 5, type: 'upsert', item: item(C, '3', 1) },
  ]);
  assert.deepEqual(hub.applySnapshot([item(B, '2', 2, { text: 'same version, other content' }), item(C, '3', 1)]).map(e => e.seq), [6]);
  assert.equal(hub.cursor(), `${EPOCH}:6`);
  assert.deepEqual(frameOf(EPOCH, { seq: 3, type: 'retract', author: A, id: '1' }), { type: 'retract', author: A, id: '1', cursor: `${EPOCH}:3` });
});

test('resume gives the missed changes after a good cursor, filtered and without repeats, and a snapshot otherwise', () => {
  const hub = createStreamHub({ epoch: EPOCH, maxHistory: 4 });
  assert.deepEqual(hub.resume(`${EPOCH}:0`), { mode: 'delta', cursor: `${EPOCH}:0`, events: [] });
  hub.applySnapshot([item(A, '1', 1), item(B, '2', 1)]);
  const seen = hub.cursor();
  hub.applySnapshot([item(B, '2', 1), item(C, '3', 1)]);
  const onlyB = one => one.peer === B;
  assert.deepEqual(hub.resume(seen), { mode: 'delta', cursor: `${EPOCH}:4`,
    events: [{ seq: 3, type: 'retract', author: A, id: '1', peer: B }, { seq: 4, type: 'upsert', item: item(C, '3', 1) }] });
  assert.deepEqual(hub.resume(seen, onlyB).events.map(e => e.seq), [3], 'the retract carries its peer, so the filter keeps it');
  assert.deepEqual(hub.resume(hub.cursor()).events, [], 'up to date: nothing again');
  for (const after of [undefined, 'garbage', `00000000-0000-4000-8000-000000000002:2`, `${EPOCH}:99`])
    assert.deepEqual(hub.resume(after), { mode: 'snapshot', cursor: `${EPOCH}:4`, items: [item(B, '2', 1), item(C, '3', 1)] }, String(after));
  assert.deepEqual(hub.resume(undefined, onlyB).items, [item(B, '2', 1)]);
  // 四条之后的变化把 seq 1、2 挤出环缓冲：停在 0 的续不上，停在 2（最老的是 3）的还续得上。
  assert.equal(hub.oldestSeq, 1);
  hub.applySnapshot([item(B, '2', 2), item(C, '3', 2)]);
  assert.equal(hub.oldestSeq, 3);
  assert.equal(hub.resume(`${EPOCH}:0`).mode, 'snapshot');
  assert.equal(hub.resume(`${EPOCH}:1`).mode, 'snapshot');
  assert.deepEqual(hub.resume(`${EPOCH}:2`).events.map(e => e.seq), [3, 4, 5, 6]);
});

test('each hub has its own epoch, so a cursor from before a restart starts over with a snapshot', () => {
  const before = createStreamHub(), after = createStreamHub();
  assert.notEqual(before.epoch, after.epoch);
  before.applySnapshot([item(A, '1', 1)]);
  after.applySnapshot([item(A, '1', 1)]);
  assert.equal(after.resume(before.cursor()).mode, 'snapshot');
});

test('id and replyTo are at most 200 characters and 256 UTF-8 bytes as given, with no control characters; text is at most 8000 code points before trimming', () => {
  const at = { selfAuthor: A, now: 1 };
  assert.equal(normalizeDmInput({ to: B, text: 'x', id: '好'.repeat(85) }, at).id, '好'.repeat(85), '85 Han characters are 255 bytes');
  assert.equal(normalizeDmInput({ to: B, text: 'x', replyTo: '好'.repeat(85) }, at).body.replyTo, '好'.repeat(85));
  assert.equal(normalizeDmInput({ to: B, text: 'x', id: ' m1 ', replyTo: ' m0 ' }, at).body.replyTo, 'm0', 'both are trimmed after the checks');
  for (const more of [{ id: '好'.repeat(86) }, { replyTo: '好'.repeat(86) }, { id: '😀'.repeat(65) }, { replyTo: 'a\u0000b' }, { replyTo: '\u0007' }, { id: ' '.repeat(3) },
    { replyTo: ' ' }, { id: 'x'.repeat(200) + ' ' }])
    assert.throws(() => normalizeDmInput({ to: B, text: 'x', ...more }, at), Error, JSON.stringify(more).slice(0, 60));
  assert.throws(() => normalizeFeedInput({ text: 'x', id: '好'.repeat(86) }, at));
  assert.equal(normalizeDmInput({ to: B, text: `${'😀'.repeat(MAX_TEXT - 1)} ` }, at).body.text, '😀'.repeat(MAX_TEXT - 1));
  assert.throws(() => normalizeDmInput({ to: B, text: `${'😀'.repeat(MAX_TEXT)} ` }, at), /8000/, '8000 code points and a trailing space are 8001 as given, as the schema counts');
  assert.throws(() => normalizeFeedInput({ text: ` ${'x'.repeat(MAX_TEXT)}` }, at), /8000/);
  const long = { kind: DM_KIND, author: B, id: 'l', version: 1, body: { to: A, text: `${'x'.repeat(MAX_TEXT)} `, createdAt: 1 }, local: false };
  assert.deepEqual(projectDmRecords([long], { selfAuthor: A }), [], 'a record is read by the same rule');
});

test('a snapshot is cut into frames of at most the byte limit, the last one (also of an empty snapshot) saying more: false', () => {
  assert.equal(MAX_SNAPSHOT_FRAME_BYTES, 256 * 1024);
  const cursor = `${EPOCH}:3`;
  assert.deepEqual(snapshotFrames(cursor, []), [{ type: 'snapshot', cursor, items: [], more: false }]);
  const items = Array.from({ length: 10 }, (_, i) => item(B, `i${i}`, 1, { text: '好'.repeat(100) }));
  assert.deepEqual(snapshotFrames(cursor, items), [{ type: 'snapshot', cursor, items, more: false }], 'a small one is one frame');
  const frames = snapshotFrames(cursor, items, 1024);
  assert.ok(frames.length > 1);
  assert.deepEqual(frames.map(frame => frame.more), [...Array(frames.length - 1).fill(true), false]);
  assert.deepEqual(frames.flatMap(frame => frame.items), items, 'in order, nothing lost or repeated');
  for (const frame of frames) assert.ok(new TextEncoder().encode(JSON.stringify(frame)).length <= 1024, JSON.stringify(frame).length);
  const huge = item(B, 'big', 1, { text: 'x'.repeat(2000) });
  assert.deepEqual(snapshotFrames(cursor, [huge], 1024).map(frame => frame.items.length), [1], 'an item bigger than the limit still goes, alone');
});

test('a message moved to another recipient is withdrawn from the old conversation before it is upserted into the new one, live and on resume', () => {
  const hub = createStreamHub({ epoch: EPOCH });
  hub.applySnapshot([item(A, 'm', 1, { peer: B, to: B })]);
  const seen = hub.cursor();
  const moved = item(A, 'm', 2, { peer: C, to: C });
  assert.deepEqual(hub.applySnapshot([moved]), [{ seq: 2, type: 'retract', author: A, id: 'm', peer: B }, { seq: 3, type: 'upsert', item: moved }]);
  assert.deepEqual(hub.resume(seen, one => one.peer === B).events, [{ seq: 2, type: 'retract', author: A, id: 'm', peer: B }]);
  assert.deepEqual(hub.resume(seen, one => one.peer === C).events, [{ seq: 3, type: 'upsert', item: moved }]);
  assert.deepEqual(hub.applySnapshot([item(A, 'm', 3, { peer: C, to: C })]).map(e => e.type), ['upsert'], 'the same recipient again: just an upsert');
});

test('a refresh with hundreds of thousands of changes keeps only the last MAX_HISTORY of them, without spreading them into one call', () => {
  const hub = createStreamHub({ epoch: EPOCH }), many = Array.from({ length: 300_000 }, (_, i) => item(B, `i${i}`, 1));
  const events = hub.applySnapshot(many);
  assert.equal(events.length, 300_000);
  assert.deepEqual([hub.seq, hub.oldestSeq], [300_000, 300_000 - MAX_HISTORY + 1]);
  assert.equal(hub.resume(`${EPOCH}:${300_000 - MAX_HISTORY - 1}`).mode, 'snapshot');
  assert.deepEqual(hub.resume(`${EPOCH}:${300_000 - MAX_HISTORY}`).events.map(e => e.seq), Array.from({ length: MAX_HISTORY }, (_, i) => 300_000 - MAX_HISTORY + 1 + i));
  hub.applySnapshot(many.slice(1));
  assert.deepEqual([hub.seq, hub.oldestSeq], [300_001, 300_002 - MAX_HISTORY], 'a small change after it is appended and trimmed');
});
