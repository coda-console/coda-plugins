import test from 'node:test';
import assert from 'node:assert/strict';
import { assertId, newId, normalizeCard, parseCard, serializeCard } from '../../../plugins/memory/lib/card.mjs';

const base = (extra = {}) => ({
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: 'fact',
  refs: ['docs/a.md'],
  created_at: '2026-01-02T03:04:05.000Z',
  updated_at: '2026-01-02T03:04:05.000Z',
  body: '正文',
  ...extra,
});

test('ULID 是 26 位 Crockford Base32，同一毫秒内单调递增', () => {
  const ids = Array.from({ length: 50 }, () => newId(1_700_000_000_000));
  for (const id of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(newId(1_700_000_000_001) > ids.at(-1));
});

test('ID 只允许字母、数字、下划线、连字符，路径穿越被拒绝', () => {
  assert.equal(assertId('abc_DEF-1'), 'abc_DEF-1');
  for (const bad of ['', '../x', 'a/b', 'a\\b', 'a.b', '.', '..', 'a'.repeat(65), 'a b', '中文', null, 5]) assert.throws(() => assertId(bad), /卡片 id/, String(bad));
});

test('中文与特殊字符的 frontmatter 和多行正文往返一致', () => {
  const card = normalizeCard(base({
    status: 'contested',
    importance: 5,
    refs: ['路径/含 空格.md', 'a: b', '# 井号', 'C:\\dir\\file', '"引号"', "it's"],
    entities: ['实体: 一', '---'],
    tags: ['标签', 'a,b'],
    supersedes: ['OLD-1'],
    contradicts: ['OLD_2'],
    related: ['x'],
    archived_reason: '原因: "x" \\ 换行\n第二行',
    body: '# 标题\n\n---\n正文: 含冒号、"引号"、# 井号、\\反斜杠\n\n  缩进行\n末行 emoji 🧠',
  }));
  const text = serializeCard(card);
  assert.deepEqual(parseCard(text), card);
  assert.equal(serializeCard(parseCard(text)), text);
});

test('正文 trim 后不能为空，且不超过 8000 个 UTF-8 字节', () => {
  assert.throws(() => normalizeCard(base({ body: ' \n ' })), /正文不能为空/);
  assert.equal(normalizeCard(base({ body: 'a'.repeat(8000) })).body.length, 8000);
  assert.throws(() => normalizeCard(base({ body: 'a'.repeat(8001) })), /8000 字节/);
  // 2667 个汉字是 8001 字节，2666 个是 7998 字节。
  assert.equal(normalizeCard(base({ body: '汉'.repeat(2666) })).body.length, 2666);
  assert.throws(() => normalizeCard(base({ body: '汉'.repeat(2667) })), /8000 字节/);
});

test('refs 必填、非空，去重保序，列表字段默认空数组', () => {
  assert.throws(() => normalizeCard(base({ refs: undefined })), /refs/);
  assert.throws(() => normalizeCard(base({ refs: [] })), /refs 至少/);
  assert.throws(() => normalizeCard(base({ refs: ['a', '  '] })), /refs/);
  assert.throws(() => normalizeCard(base({ refs: 'a' })), /refs/);
  const card = normalizeCard(base({ refs: [' b ', 'a', 'b'], tags: ['t', 't'] }));
  assert.deepEqual(card.refs, ['b', 'a']);
  assert.deepEqual(card.tags, ['t']);
  assert.deepEqual([card.entities, card.supersedes, card.contradicts, card.related], [[], [], [], []]);
  assert.equal(card.status, 'active');
  assert.equal(card.importance, 3);
});

test('kind、status、importance、时间戳与关系 id 都要合法', () => {
  assert.throws(() => normalizeCard(base({ kind: 'note' })), /kind/);
  assert.throws(() => normalizeCard(base({ status: 'deleted' })), /status/);
  for (const importance of [0, 6, 2.5, '3']) assert.throws(() => normalizeCard(base({ importance })), /importance/);
  for (const at of ['2026-01-02', '2026-01-02T03:04:05+08:00', 'x', undefined]) assert.throws(() => normalizeCard(base({ created_at: at })), /created_at/);
  assert.throws(() => normalizeCard(base({ related: ['../x'] })), /卡片 id/);
});

test('不合规的文本解析时报错', () => {
  assert.throws(() => parseCard('正文'), /frontmatter/);
  assert.throws(() => parseCard('---\nid: "a"\n正文'), /结尾/);
  assert.throws(() => parseCard('---\nunknown: 1\n---\n\nx\n'), /不认识/);
  assert.throws(() => parseCard('---\nid: oops\n---\n\nx\n'), /合法 JSON/);
});

test('正文原样保留首尾空白和缩进，字节数按实际正文算', () => {
  const body = '\n  缩进行\n\n\t末行  \n\n';
  const card = normalizeCard(base({ body }));
  assert.equal(card.body, body);
  assert.equal(parseCard(serializeCard(card)).body, body);
  // 首尾空白也占字节：7999 个字符加 2 个空格就是 8001 字节。
  assert.equal(normalizeCard(base({ body: `  ${'a'.repeat(7998)}` })).body.length, 8000);
  assert.throws(() => normalizeCard(base({ body: `  ${'a'.repeat(7999)}` })), /8001 字节/);
  assert.throws(() => normalizeCard(base({ body: ' \n\t ' })), /正文不能为空/);
});

test('U+2028、U+2029 与行尾的 \\r 往返无损', () => {
  const card = normalizeCard(base({ refs: ['a\u2028b', 'c\u2029d'], entities: ['\ud800 孤立代理'], body: '行一\u2028行二\u2029\r\n行三\r' }));
  assert.deepEqual(parseCard(serializeCard(card)), card);
});

test('解析 CRLF 分隔的卡片', () => {
  const card = normalizeCard(base({ refs: ['a\u2028b'], body: '第一行\n第二行' }));
  const crlf = serializeCard(card).replaceAll('\n', '\r\n');
  assert.deepEqual(parseCard(crlf), { ...card, body: '第一行\r\n第二行' });
});

test('时间戳要是日历上真有的日期', () => {
  for (const at of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-04-31T00:00:00Z', '2025-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-00-10T00:00:00Z']) {
    assert.throws(() => normalizeCard(base({ created_at: at })), /created_at/, at);
    assert.throws(() => normalizeCard(base({ updated_at: at })), /updated_at/, at);
  }
  for (const at of ['2024-02-29T23:59:59Z', '2026-12-31T00:00:00.123Z']) assert.equal(normalizeCard(base({ created_at: at })).created_at, at);
});
