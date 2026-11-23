import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fixture, command, env, gateway, packet, testHost } from './helpers.mjs';
import { activate, deactivate } from '../../../plugins/git/main.mjs';
import { SOURCE } from '../../../plugins/git/lib/definitions.mjs';
import { MAX_REQUEST, smartHTTP } from '../../../plugins/git/lib/http.mjs';
import { git } from '../../../plugins/git/lib/git.mjs';

// This file's own, so that each exchange's temporary directory is seen to go.
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'coda-git-http-test-'));
process.on('exit', () => rmSync(process.env.TMPDIR, { recursive: true, force: true }));
const views = () => readdirSync(process.env.TMPDIR).filter(name => /^coda-git-http-/.test(name));
const until = async (t, check) => { while (!check()) { t.signal.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); } };
afterEach(async () => { await deactivate(); assert.deepEqual(views(), []); });

// Kept, what was asked: a `Request` collected, its signal no longer goes off with the one it was given.
const asked = [];
// The plugin's module with the repository `dir` registered: its record, and its stream asked as a backend asks it (`ask`) or
// over HTTP (`url`).
async function source(t, dir, { caller } = {}) {
  const host = testHost(t, join(dir, '.git', 'coda-state'));
  await activate(host.coda);
  const registered = await host.serve('repository', new Request('http://service/sources/source', { method: 'POST', body: JSON.stringify({ spec: { path: dir } }) }));
  const record = await registered.json(), { status } = await host.coda.get(record);
  const { base, seen } = await gateway(t, host, { caller });
  return { record, url: base + status.url, seen, ask(path, { method = 'GET', body, headers = {}, signal, to = record } = {}) {
    const request = new Request(`http://stream${path}`, { method, signal, ...(body ? { body, duplex: 'half' } : {}),
      headers: { 'git-protocol': 'version=2', ...(method === 'POST' ? { 'content-type': 'application/x-git-upload-pack-request' } : {}), ...headers } });
    asked.push(request);
    return host.stream(to, 'transport', request, { caller });
  } };
}
const DISCOVERY = '/info/refs?service=git-upload-pack', UPLOAD = '/git-upload-pack';
const fetching = oid => Buffer.concat([packet('command=fetch\n'), Buffer.from('0001'), packet(`want ${oid}\n`), packet('done\n'), Buffer.from('0000')]);
// The pack in an answer to a fetch.
function packOf(body) {
  const pack = [];
  for (let offset = 0; offset < body.length;) {
    const size = parseInt(body.subarray(offset, offset + 4).toString(), 16); offset += 4;
    if (size <= 2) continue;
    const data = body.subarray(offset, offset + size - 4); offset += size - 4;
    if (data[0] === 1) pack.push(data.subarray(1));
  }
  return Buffer.concat(pack);
}

function raw(base, path, { method = 'GET', body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: {
      'Git-Protocol': 'version=2', ...(body ? { 'Content-Type': 'application/x-git-upload-pack-request' } : {}),
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), sent })); res.on('error', reject);
    });
    let sent = 0; req.on('error', reject);
    void (async () => {
      if (body) for (let offset = 0; offset < body.length; offset += chunked ? 8191 : body.length) {
        const chunk = body.subarray(offset, offset + (chunked ? 8191 : body.length));
        if (!req.write(chunk)) await once(req, 'drain');
        sent += chunk.length;
        if (chunked) await new Promise(resolve => setImmediate(resolve));
      }
      req.end();
    })().catch(reject);
  });
}

test('真实 v2 全量与增量 fetch 与 fsck 一致，只导出分支，快照 ref 与其他内部 ref 取不到', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'blob'), randomBytes(1024 * 1024));
  await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'payload']);
  const hidden = await command(dir, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'hidden']);
  const ref = `refs/coda/snapshots/${'d'.repeat(64)}`;
  await command(dir, ['update-ref', ref, hidden]);
  await command(dir, ['update-ref', 'refs/private/secret', hidden]);
  const { record, url, seen, ask } = await source(t, dir);
  assert.ok(url.endsWith(`/v1/records/git%2Fsource%401/${record.id}/streams/transport`));
  const discovery = await ask(DISCOVERY);
  assert.equal(discovery.status, 200, await discovery.text());
  assert.equal(discovery.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  const trace = join(dir, 'trace');
  await command(target, ['-c', 'protocol.version=2', 'fetch', url, 'refs/heads/main:refs/heads/main'], { GIT_TRACE_PACKET: trace });
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  assert.match(await readFile(trace, 'utf8'), /version 2/);
  await writeFile(join(dir, 'tracked'), 'incremental'); await command(dir, ['add', 'tracked']); await command(dir, ['commit', '-m', 'next']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', url, 'refs/heads/main:refs/heads/main'], { GIT_TRACE_PACKET: trace });
  assert.match(await readFile(trace, 'utf8'), /have [a-f0-9]{40}/);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  await command(target, ['fsck', '--full']);
  assert.ok(seen.every(item => item.protocol === 'version=2'));
  const listed = await command(target, ['-c', 'protocol.version=2', 'ls-remote', url]);
  assert.ok(listed.includes('refs/heads/main')); assert.ok(!listed.includes('refs/coda/') && !listed.includes('refs/private/'));
  await assert.rejects(command(target, ['-c', 'protocol.version=2', 'fetch', url, `${ref}:refs/heads/hidden`]));
  await assert.rejects(command(target, ['-c', 'protocol.version=2', 'fetch', url, `${hidden}:refs/heads/hidden`]));
  assert.equal((await ask(UPLOAD, { method: 'POST', body: fetching(hidden) })).status, 403);
});

test('谁能读由 Coda 判，处理函数不看调用方：客户端、别的后端、插件都照常读到', async t => {
  for (const caller of [{ role: 'client', device: 'phone' }, { role: 'backend', device: 'backend:test' }, { plugin: 'other' }]) {
    const dir = await fixture(t), { ask } = await source(t, dir, { caller });
    const response = await ask(DISCOVERY);
    assert.equal(response.status, 200, await response.text());
    await deactivate();
  }
});

test('超过 5 MiB 分块 POST 的末尾 want 被处理，响应不截断', async t => {
  const dir = await fixture(t), { url } = await source(t, dir);
  const head = await command(dir, ['rev-parse', 'HEAD']);
  const lines = [packet('command=fetch\n'), Buffer.from('0001')];
  // Valid repeated shallow lines exceed Git's normal request buffer; the decisive want is the LAST packet.
  const shallow = packet(`shallow ${head}\n`);
  for (let bytes = 0; bytes < 5 * 1024 * 1024; bytes += shallow.length) lines.push(shallow);
  lines.push(packet(`want ${head}\n`), packet('done\n'), Buffer.from('0000'));
  const body = Buffer.concat(lines);
  const result = await raw(url, UPLOAD, { method: 'POST', body, chunked: true });
  assert.equal(result.sent, body.length); assert.equal(result.status, 200, result.body.toString());
  assert.ok(result.body.includes(Buffer.from('PACK')), result.body.subarray(0, 300).toString());
  assert.ok(!result.body.includes(Buffer.from('ERR ')));
  const target = join(dir, 'long-post-client'); await mkdir(target); await command(target, ['init']);
  await git(target, ['index-pack', '--stdin'], { env, input: packOf(result.body) });
  assert.equal(await command(target, ['cat-file', '-t', head]), 'commit');
  await command(target, ['fsck', '--full']);
});

test('请求体最多 32 MiB：边读边数，没有尽头的也在超出时回 413', async t => {
  const dir = await fixture(t), { ask } = await source(t, dir);
  t.mock.method(console, 'error', () => {});
  let given = 0;
  const endless = new ReadableStream({ pull(out) { out.enqueue(new Uint8Array(65536)); given += 65536; } });
  const refused = await ask(UPLOAD, { method: 'POST', body: endless });
  assert.equal(refused.status, 413); assert.deepEqual(await refused.json(), { error: { message: '请求体过大' } });
  assert.ok(given > MAX_REQUEST && given < 2 * MAX_REQUEST, given);
  // At the limit it is read whole, and is not what Git speaks.
  const read = await ask(UPLOAD, { method: 'POST', body: Buffer.alloc(MAX_REQUEST) });
  assert.equal(read.status, 400); assert.deepEqual(await read.json(), { error: { message: '无效 pkt-line' } });
});

test('拒绝 receive-pack、别的路径、未登记源、隐藏提交和直接文件读取', async t => {
  const dir = await fixture(t), { record, ask } = await source(t, dir);
  t.mock.method(console, 'error', () => {});
  await command(dir, ['checkout', '--orphan', 'secret']);
  await writeFile(join(dir, 'secret'), 'private'); await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'secret']);
  const secret = await command(dir, ['rev-parse', 'HEAD']);
  await command(dir, ['config', 'http.receivepack', 'true']);
  await command(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await command(dir, ['update-ref', 'refs/private/secret', secret]);
  await command(dir, ['checkout', 'main']); await command(dir, ['branch', '-D', 'secret']);
  for (const path of ['/git-receive-pack', '/info/refs?service=git-receive-pack'])
    assert.equal((await ask(path, { method: 'POST' })).status, 403);
  for (const path of ['', '/HEAD', '/objects/info/alternates', '/info/refs', '/info/refs/', '/git-upload-pack/', '//info/refs?service=git-upload-pack',
    '/info/refs?service=git-upload-pack&x=y', '/info%2frefs?service=git-upload-pack', '/%69nfo/refs?service=git-upload-pack',
    '/source%2f..%2fsecret/git-upload-pack', `/repos/${record.id}/info/refs?service=git-upload-pack`])
    assert.equal((await ask(path)).status, 404, path);
  assert.equal((await ask(DISCOVERY, { to: { kind: SOURCE, id: 'unknown' } })).status, 404);
  assert.equal((await ask(UPLOAD, { method: 'POST', body: fetching(secret) })).status, 403);
});

test('方法、协议版本、内容类型、压缩不对的拒绝', async t => {
  const dir = await fixture(t), { ask } = await source(t, dir);
  t.mock.method(console, 'error', () => {});
  assert.equal((await ask(UPLOAD)).status, 405);
  assert.equal((await ask(DISCOVERY, { method: 'POST' })).status, 405);
  await assert.rejects(ask(UPLOAD, { method: 'PUT' }), { code: 'method_not_allowed' });
  assert.equal((await ask(DISCOVERY, { headers: { 'git-protocol': 'version=1' } })).status, 400);
  assert.equal((await ask(UPLOAD, { method: 'POST', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await ask(UPLOAD, { method: 'POST', headers: { 'content-encoding': 'gzip' } })).status, 415);
  const head = await command(dir, ['rev-parse', 'HEAD']);
  const read = await ask(UPLOAD, { method: 'POST', headers: { 'content-encoding': 'identity' }, body: fetching(head) });
  assert.equal(read.status, 200); assert.ok((await read.text()).includes('PACK'));
});

test('浅克隆源仍可提供 v2 fetch', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'tracked'), 'second'); await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'second']);
  const shallow = join(dir, 'shallow-source');
  await command(dir, ['clone', '--depth=1', `file://${dir}`, shallow]);
  const { url } = await source(t, shallow);
  const target = join(dir, 'shallow-client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', '--update-shallow', url, 'main:refs/heads/main']);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'HEAD']));
  await command(target, ['fsck', '--full']);
});

test('拒绝取源码的请求时记一行日志：状态、原因、源与三个请求头，不含鉴权头；正常请求不记', async t => {
  const dir = await fixture(t), { record, url, ask } = await source(t, dir);
  const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const send = (path, headers) => new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  const upload = { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' };
  assert.equal(await send(UPLOAD, { 'Git-Protocol': 'version=2', 'Content-Type': 'text/plain', Authorization: 'Bearer top-secret', Cookie: 'sid=top-secret' }), 415);
  assert.deepEqual(logged, [`[git http] 415 需要 upload-pack 请求 POST source=${record.id} content-type="text/plain" content-encoding=无 git-protocol="version=2"`]);
  logged.length = 0;
  assert.equal(await send(UPLOAD, { ...upload, 'Content-Encoding': 'gzip' }), 415);
  assert.deepEqual(logged, [`[git http] 415 不接受压缩请求体 POST source=${record.id} content-type="application/x-git-upload-pack-request" content-encoding="gzip" git-protocol="version=2"`]);
  logged.length = 0;
  assert.equal(await send('/HEAD', {}), 404);
  assert.deepEqual(logged, [`[git http] 404 不允许的 Git 路径 POST source=${record.id} path="/HEAD" content-type=无 content-encoding=无 git-protocol=无`]);
  logged.length = 0;
  assert.equal((await ask(DISCOVERY)).status, 200);
  assert.deepEqual(logged, []);
});

test('处理过程出错回 500 时同样记一行日志', async t => {
  const dir = await fixture(t), host = testHost(t, join(dir, '.git', 'coda-state'));
  await host.coda.stream(SOURCE, 'transport', smartHTTP({ lookup: async () => { throw new Error('boom'); } }));
  const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const response = await host.stream({ kind: SOURCE, id: 'source' }, 'transport', new Request(`http://stream${DISCOVERY}`, { headers: { 'git-protocol': 'version=2' } }));
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: { message: 'boom' } });
  assert.deepEqual(logged, ['[git http] 500 boom GET source=source content-type=无 content-encoding=无 git-protocol="version=2"']);
});

// The `git` the plugin runs, from now on (Git's own binary in the end: macOS's /usr/bin/git looks on the PATH again): each
// one's process ID and arguments noted (`ran(text)`: the process ID of the last whose arguments have `text`), the one whose
// arguments have `text` doing what `does` says instead.
function watchedGit(t, text = 'nothing', does = '') {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'git-')), log = join(dir, 'log'), PATH = process.env.PATH;
  writeFileSync(join(dir, 'git'), `#!/bin/sh
echo "$$ $*" >> '${log}'
case "$*" in *'${text}'*) ${does};; esac
exec '${join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git')}' "$@"
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${PATH}`;
  t.after(() => { process.env.PATH = PATH; });
  return text => existsSync(log) ? Number(readFileSync(log, 'utf8').split('\n').findLast(line => line.includes(text))?.split(' ')[0]) || null : null;
}
// `target`: a process, or (negative) a process group.
const running = target => { try { process.kill(target, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; } };
async function payload(t) {
  const dir = await fixture(t);
  await writeFile(join(dir, 'blob'), randomBytes(16 * 1024 * 1024));
  await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'payload']);
  return { dir, head: await command(dir, ['rev-parse', 'HEAD']) };
}
// What the caller leaving, or the plugin being stopped, does to an exchange under way. Stopped, it is all over by then.
const ENDS = {
  断开: async (t, abort) => { abort(); await until(t, () => !views().length); },
  停用: async () => { await deactivate(); assert.deepEqual(views(), []); },
};
const drain = async reader => { while (!(await reader.read()).done); };

test('pack 按读的快慢送：没人读的停着等，别的照常取完，接着读能读完整', { timeout: 60_000 }, async t => {
  const { dir, head } = await payload(t), { ask } = await source(t, dir), ran = watchedGit(t);
  const fetch = () => ask(UPLOAD, { method: 'POST', body: fetching(head) });
  const reader = (await fetch()).body.getReader(), group = -ran('http-backend');
  const chunks = [(await reader.read()).value];
  // Each as long as the first, had it not waited.
  for (let others = 0; others < 2; others++) await (await fetch()).arrayBuffer();
  assert.ok(running(group));
  for (let read; !(read = await reader.read()).done;) chunks.push(read.value);
  const pack = packOf(Buffer.concat(chunks));
  assert.ok(pack.length > 16 * 1024 * 1024);
  assert.deepEqual(createHash('sha1').update(pack.subarray(0, -20)).digest(), pack.subarray(-20));
  await until(t, () => !views().length);
});

for (const [how, end] of Object.entries(ENDS)) {
  test(`${how}时，正在送 pack 的停下子进程、删掉临时目录，不记日志`, { timeout: 60_000 }, async t => {
    const { dir, head } = await payload(t), { ask } = await source(t, dir), ran = watchedGit(t);
    const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
    const gone = new AbortController();
    const response = await ask(UPLOAD, { method: 'POST', body: fetching(head), signal: gone.signal });
    assert.equal(response.status, 200);
    // Read no further than its first bytes: the rest waits.
    const reader = response.body.getReader(); await reader.read();
    const group = -ran('http-backend');
    assert.equal(views().length, 1); assert.ok(running(group));
    await end(t, () => gone.abort());
    await until(t, () => !running(group));
    await assert.rejects(drain(reader));
    assert.deepEqual(logged.filter(line => line.startsWith('[git http]')), []);
  });

  test(`${how}时，还在准备临时仓库的停下子进程、删掉临时目录，不再起 http-backend`, { timeout: 60_000 }, async t => {
    const dir = await fixture(t), { ask } = await source(t, dir), ran = watchedGit(t, 'init --bare', 'exec tail -f /dev/null');
    t.mock.method(console, 'error', () => {});
    const gone = new AbortController(), refused = assert.rejects(ask(DISCOVERY, { signal: gone.signal }));
    await until(t, () => ran('init --bare'));
    assert.equal(views().length, 1);
    await end(t, () => gone.abort());
    await refused;
    assert.ok(!running(ran('init --bare'))); assert.equal(ran('http-backend'), null);
  });

  test(`${how}时，http-backend 还没有回答的，连同它起的一起停下、删掉临时目录`, { timeout: 60_000 }, async t => {
    const dir = await fixture(t), { ask } = await source(t, dir), ran = watchedGit(t, 'http-backend', 'tail -f /dev/null & echo "$$ tail-started" >> "$(dirname "$0")/log"; wait');
    t.mock.method(console, 'error', () => {});
    const gone = new AbortController(), refused = assert.rejects(ask(DISCOVERY, { signal: gone.signal }));
    // Cancelled only once the grandchild is started: a group killed while its shell is still forking misses it.
    await until(t, () => ran('tail-started'));
    await end(t, () => gone.abort());
    await refused;
    await until(t, () => !running(-ran('http-backend')));
  });
}

test('http-backend 中途死掉：断流，记一行 500，临时目录删掉', { timeout: 60_000 }, async t => {
  const { dir, head } = await payload(t), { record, ask } = await source(t, dir), ran = watchedGit(t);
  const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const response = await ask(UPLOAD, { method: 'POST', body: fetching(head) });
  const reader = response.body.getReader(); await reader.read();
  process.kill(-ran('http-backend'), 'SIGKILL');
  await assert.rejects(drain(reader));
  await until(t, () => !views().length);
  assert.deepEqual(logged.filter(line => line.startsWith('[git http]')).map(line => line.split(' POST ')),
    [['[git http] 500 git http-backend: 响应未完成', `source=${record.id} content-type="application/x-git-upload-pack-request" content-encoding=无 git-protocol="version=2"`]]);
});

test('http-backend 没有回答就失败：回 500 和它的原因，记一行日志，临时目录删掉', async t => {
  const dir = await fixture(t), { record, ask } = await source(t, dir);
  watchedGit(t, 'http-backend', 'echo broken >&2; exit 3');
  const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const response = await ask(DISCOVERY);
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: { message: 'git http-backend: broken\n' } });
  assert.deepEqual(logged, [`[git http] 500 git http-backend: broken\n GET source=${record.id} content-type=无 content-encoding=无 git-protocol="version=2"`]);
  await until(t, () => !views().length);
});
