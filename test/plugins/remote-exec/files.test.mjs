import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { truncateSync } from 'node:fs';
import { pull, push } from '../../../plugins/remote-exec/lib/files.mjs';
import { caller, scratch, setup, waitFor } from './support.mjs';

const record = { kind: 'remote-exec/machine@1', id: 'r-1', key: 'host' };
const request = (body, init = {}) => new Request('http://stream/', { method: body === undefined ? 'GET' : 'POST', body, duplex: 'half', ...init });

function reading(t, input, options) {
  const host = options?.host ?? setup(t), controller = new AbortController();
  const ctx = { caller, record, input, signal: controller.signal };
  return { host, controller, response: pull(host.env, request(), ctx) };
}
async function bytes(response) { return Buffer.from(await response.arrayBuffer()); }
const pulled = async (t, input) => { const one = reading(t, input), response = await one.response; return { ...one, response, body: await bytes(response) }; };

function writing(t, input, body, options) {
  const host = options?.host ?? setup(t), controller = new AbortController();
  const ctx = { caller, record, input, signal: controller.signal };
  return { host, controller, done: push(host.env, request(body), ctx) };
}
const pushed = async (t, path, body, options) => {
  const one = writing(t, { path }, body, options), response = await one.done;
  return { ...one, response, json: await response.json() };
};
const names = dir => readdirSync(dir).sort();

test('pull: the whole file as octet-stream with its length, and a log line with the path, the range and the bytes sent', async t => {
  const dir = scratch(t), file = join(dir, 'a.bin'), data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
  writeFileSync(file, data);
  const { response, body, host } = await pulled(t, { path: file });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), String(data.length));
  assert.deepEqual(body, data);
  const [line] = await waitFor(() => host.lines().length === 1 && host.lines(), '记录');
  assert.deepEqual(Object.keys(line).sort(), ['caller', 'ms', 'operation', 'params', 'result', 'time']);
  assert.deepEqual(line.caller, caller);
  assert.equal(line.operation, 'pull');
  assert.deepEqual(line.params, { path: file });
  assert.deepEqual(line.result, { bytes: data.length });
});

test('pull: offset and length are a byte range, a length past the end is cut, an offset past the end is an empty body', async t => {
  const file = join(scratch(t), 'a.txt');
  writeFileSync(file, '0123456789');
  const range = async input => {
    const { response, body, host } = await pulled(t, { path: file, ...input });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(body.length));
    await waitFor(() => host.lines().length === 1, '记录');
    return [body.toString(), host.lines()[0]];
  };
  assert.equal((await range({ offset: '3', length: '4' }))[0], '3456');
  assert.equal((await range({ offset: '8' }))[0], '89');
  assert.equal((await range({ length: '3' }))[0], '012');
  assert.equal((await range({ offset: '8', length: '100' }))[0], '89');
  assert.equal((await range({ length: '0' }))[0], '');
  const [empty, line] = await range({ offset: '10' });
  assert.equal(empty, '');
  assert.equal((await range({ offset: '99999999999999999999' }))[0], '');
  assert.deepEqual(line.params, { path: file, offset: '10' });
  assert.deepEqual(line.result, { bytes: 0 });
});

test('pull: a missing file, a directory, a relative path and a closed switch are refused before the first byte with a code, effects none, and a log line', async t => {
  const dir = scratch(t), file = join(dir, 'f');
  writeFileSync(file, 'x');
  for (const [path, code] of [[join(dir, 'missing'), 'not_found'], [dir, 'is_a_directory'], ['rel/f', 'invalid_input'], [join(file, 'under'), 'not_a_directory']]) {
    const one = reading(t, { path });
    await assert.rejects(one.response, { code, effects: 'none' });
    assert.deepEqual(one.host.lines().map(line => [line.operation, line.error, line.params.path]), [['pull', code, path]]);
  }
  const off = setup(t, { enabled: false }), one = reading(t, { path: file }, { host: off });
  await assert.rejects(one.response, { code: 'disabled', effects: 'none' });
  assert.deepEqual(off.lines().map(line => line.error), ['disabled']);
});

test('pull: an unreadable file is refused with permission_denied', { skip: process.getuid?.() === 0 }, async t => {
  const file = join(scratch(t), 'secret');
  writeFileSync(file, 'x');
  chmodSync(file, 0);
  await assert.rejects(reading(t, { path: file }).response, { code: 'permission_denied', effects: 'none' });
});

test('pull: the caller going away mid-way closes the file and is logged; so is a reader that cancels', async t => {
  const file = join(scratch(t), 'big');
  writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 1));
  const gone = reading(t, { path: file }), response = await gone.response, reader = response.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  const away = new DOMException('away', 'AbortError');
  gone.controller.abort(away);
  // 流要以出错断开，正常读到结尾不算。
  await assert.rejects(async () => { for (;;) assert.equal((await reader.read()).done, false, '流正常结束了'); }, error => error === away);
  const [line] = await waitFor(() => gone.host.lines().length === 1 && gone.host.lines(), '记录');
  assert.equal(line.error, 'cancelled');
  assert.deepEqual(line.params, { path: file });

  const cancelled = reading(t, { path: file }), second = (await cancelled.response).body.getReader();
  await second.read();
  await second.cancel();
  const [other] = await waitFor(() => cancelled.host.lines().length === 1 && cancelled.host.lines(), '记录');
  assert.equal(other.error, 'interrupted');
});

test('push: a new file, with the parent directories made; the answer is { path, size } and a line is logged', async t => {
  const dir = scratch(t), path = join(dir, 'a', 'b', 'c.txt'), data = Buffer.from('héllo\n'.repeat(50_000));
  const { response, json, host } = await pushed(t, path, data);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(json, { path, size: data.length });
  assert.deepEqual(readFileSync(path), data);
  assert.deepEqual(names(join(dir, 'a', 'b')), ['c.txt']);
  const [line] = host.lines();
  assert.deepEqual(Object.keys(line).sort(), ['caller', 'ms', 'operation', 'params', 'result', 'time']);
  assert.deepEqual(line.caller, caller);
  assert.equal(line.operation, 'push');
  assert.deepEqual(line.params, { path });
  assert.deepEqual(line.result, { bytes: data.length });
});

test('push: it replaces a whole file and keeps its permission bits; pushing again gives the same file; an empty body gives an empty file', async t => {
  const dir = scratch(t), path = join(dir, 'run.sh');
  writeFileSync(path, 'old old old old');
  chmodSync(path, 0o750);
  assert.deepEqual((await pushed(t, path, 'new')).json, { path, size: 3 });
  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.equal(statSync(path).mode & 0o7777, 0o750);
  assert.deepEqual((await pushed(t, path, 'new')).json, { path, size: 3 });
  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.deepEqual((await pushed(t, path, new Uint8Array(0))).json, { path, size: 0 });
  assert.equal(readFileSync(path, 'utf8'), '');
  assert.equal(statSync(path).mode & 0o7777, 0o750);
  assert.deepEqual(names(dir), ['run.sh']);
});

test('push: a path that is a symbolic link writes the file it points to and keeps the link', async t => {
  const dir = scratch(t), real = join(dir, 'real', 'target.txt'), link = join(dir, 'link.txt');
  mkdirSync(join(dir, 'real'));
  writeFileSync(real, 'old');
  symlinkSync(real, link);
  const { json } = await pushed(t, link, 'through the link');
  assert.deepEqual(json, { path: link, size: 16 });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, 'utf8'), 'through the link');
  assert.deepEqual(names(dir), ['link.txt', 'real']);
  assert.deepEqual(names(join(dir, 'real')), ['target.txt']);
});

test('push: a directory, a relative path, a parent that is a file and a closed switch are refused, nothing is left behind, and each is logged with its code', async t => {
  const dir = scratch(t), file = join(dir, 'f'), sub = join(dir, 'sub');
  writeFileSync(file, 'keep');
  mkdirSync(sub);
  for (const [path, code] of [[sub, 'is_a_directory'], ['rel/f', 'invalid_input'], [join(file, 'x'), 'not_a_directory']]) {
    const one = writing(t, { path }, 'data');
    await assert.rejects(one.done, { code, effects: 'none' });
    assert.deepEqual(one.host.lines().map(line => [line.operation, line.error, line.params.path]), [['push', code, path]]);
  }
  assert.deepEqual(names(dir), ['f', 'sub']);
  assert.deepEqual(names(sub), []);
  const off = setup(t, { enabled: false }), refused = writing(t, { path: join(dir, 'new') }, 'x', { host: off });
  await assert.rejects(refused.done, { code: 'disabled', effects: 'none' });
  assert.deepEqual(off.lines().map(line => line.error), ['disabled']);
  assert.equal(existsSync(join(dir, 'new')), false);
});

// 一个请求体：先给出 `first`，之后由测试决定出错还是结束。
function slowBody(first) {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(first); } });
  return { body, controller: { error: reason => controller.error(reason), close: () => controller.close() } };
}

test('push: aborted halfway, the original file is untouched, no temporary file is left and the signal reason is thrown', async t => {
  const dir = scratch(t), path = join(dir, 'keep.txt');
  writeFileSync(path, 'original');
  const { body } = slowBody(Buffer.from('half of the new content'));
  const one = writing(t, { path }, body), reason = new DOMException('away', 'AbortError');
  await waitFor(() => readdirSync(dir).length === 2, '临时文件');
  // 请求体停在首块之后，什么也不再给；只有 signal 触发。
  one.controller.abort(reason);
  await assert.rejects(one.done, error => error === reason);
  assert.equal(readFileSync(path, 'utf8'), 'original');
  assert.deepEqual(names(dir), ['keep.txt']);
  assert.deepEqual(one.host.lines().map(line => [line.operation, line.error]), [['push', 'cancelled']]);
});

test('push: a body that fails, with the caller still there, leaves the original and no temporary file and says so with a code', async t => {
  const dir = scratch(t), path = join(dir, 'new', 'x');
  const { body, controller } = slowBody(Buffer.from('some'));
  const one = writing(t, { path }, body);
  await waitFor(() => existsSync(join(dir, 'new')) && readdirSync(join(dir, 'new')).length === 1, '临时文件');
  controller.error(new Error('连接断了'));
  await assert.rejects(one.done, { code: 'io_error', effects: 'none' });
  assert.deepEqual(names(join(dir, 'new')), []);
  assert.deepEqual(one.host.lines().map(line => line.error), ['io_error']);
});

test('push: a replace that cannot be completed does not touch the old file (the directory cannot be written)', { skip: process.getuid?.() === 0 }, async t => {
  const dir = scratch(t), path = join(dir, 'f');
  writeFileSync(path, 'original');
  chmodSync(dir, 0o500);
  try { await assert.rejects(pushed(t, path, 'new'), { code: 'permission_denied', effects: 'none' }); } finally { chmodSync(dir, 0o700); }
  assert.equal(readFileSync(path, 'utf8'), 'original');
});

test('pull: a file cut short while it is being read ends the body with an error and a failed line, not a success', async t => {
  const file = join(scratch(t), 'big');
  writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 1));
  const one = reading(t, { path: file }), response = await one.response, reader = response.body.getReader();
  assert.equal(response.headers.get('content-length'), String(8 * 1024 * 1024));
  assert.ok((await reader.read()).value.length > 0);
  truncateSync(file, 100);
  await assert.rejects(async () => { for (;;) assert.equal((await reader.read()).done, false, '短读被当成正常结束'); }, { code: 'short_read' });
  const [line] = await waitFor(() => one.host.lines().length === 1 && one.host.lines(), '记录');
  assert.equal(line.error, 'short_read');
  assert.equal('result' in line, false);
});

// 把 `open` 换成给出替身的：真的文件打开了，但它的 stat 或读会失败（存储的 I/O 错误造不出来）。
async function withFailingFile(make, run) {
  const original = fsp.open;
  fsp.open = async (...args) => { const real = await original(...args); return args[1] === 'r' ? make(real) : real; };
  syncBuiltinESMExports();
  try { return await run(); } finally { fsp.open = original; syncBuiltinESMExports(); }
}
const eio = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });

test('pull: a failing stat or first read is answered before the first byte with the agreed code and effects none, and the line has the same code', async t => {
  const file = join(scratch(t), 'f');
  writeFileSync(file, 'abc');
  await withFailingFile(real => ({ stat: async () => { throw eio(); }, close: () => real.close() }), async () => {
    const one = reading(t, { path: file });
    await assert.rejects(one.response, { code: 'io_error', effects: 'none' });
    assert.deepEqual(one.host.lines().map(line => line.error), ['io_error']);
  });
  await withFailingFile(real => ({ stat: () => real.stat(), close: () => real.close(), createReadStream: () => { real.close(); return Readable.from((async function* () { throw eio(); })()); } }), async () => {
    const one = reading(t, { path: file });
    await assert.rejects(one.response, { code: 'io_error', effects: 'none' });
    assert.deepEqual(one.host.lines().map(line => line.error), ['io_error']);
  });
  // 第一块之后的失败：响应体以同一个码出错，记录也是。
  await withFailingFile(real => ({ stat: () => real.stat(), close: () => real.close(), createReadStream: () => { real.close(); return Readable.from((async function* () { yield Buffer.from('a'); throw eio(); })()); } }), async () => {
    const one = reading(t, { path: file }), response = await one.response, reader = response.body.getReader();
    assert.equal((await reader.read()).value.toString(), 'a');
    await assert.rejects(reader.read(), { code: 'io_error' });
    assert.deepEqual((await waitFor(() => one.host.lines().length === 1 && one.host.lines(), '记录')).map(line => line.error), ['io_error']);
  });
});

test('pull: when the call is aborted the body ends at once with the reason, the read-ahead chunk is not delivered, and the line is written without anyone reading', async t => {
  const file = join(scratch(t), 'big');
  writeFileSync(file, Buffer.alloc(1024 * 1024, 1));
  const one = reading(t, { path: file }), response = await one.response, away = new DOMException('away', 'AbortError');
  one.controller.abort(away);
  const [line] = await waitFor(() => one.host.lines().length === 1 && one.host.lines(), '记录');
  assert.equal(line.error, 'cancelled');
  await assert.rejects(response.body.getReader().read(), error => error === away);
});

test('pull: aborted while the first chunk is still being read, the signal reason is thrown and exactly one cancelled line is written', async t => {
  const file = join(scratch(t), 'f'), away = new DOMException('away', 'AbortError');
  writeFileSync(file, 'abc');
  let reading_ = null;
  await withFailingFile(real => ({ stat: () => real.stat(), close: () => real.close(), createReadStream: () => { real.close(); reading_ = true; return new Readable({ read() {} }); } }), async () => {
    const one = reading(t, { path: file }), failed = assert.rejects(one.response, error => error === away);
    await waitFor(() => reading_, '开始读第一块');
    one.controller.abort(away);
    await failed;
    assert.deepEqual(one.host.lines().map(line => line.error), ['cancelled']);
  });
});

test('push: one abort listener for the whole upload, not a callback per chunk', async t => {
  const dir = scratch(t), path = join(dir, 'many'), chunks = 3000, controller = new AbortController(), real = controller.signal;
  let added = 0, removed = 0;
  const signal = { get aborted() { return real.aborted; }, get reason() { return real.reason; }, throwIfAborted: () => real.throwIfAborted(),
    addEventListener: (...args) => { added++; real.addEventListener(...args); }, removeEventListener: (...args) => { removed++; real.removeEventListener(...args); } };
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent++ < chunks) c.enqueue(Buffer.from('x')); else c.close(); } });
  // 在一个一直待决的 Promise 上每块竞速一次，每次都留下一个回调：不许用。
  const race = mock.method(Promise, 'race');
  const host = setup(t);
  const response = await push(host.env, request(body), { caller, record, input: { path }, signal });
  assert.equal((await response.json()).size, chunks);
  assert.equal(race.mock.callCount(), 0);
  assert.deepEqual([added, removed], [1, 1]);
});
