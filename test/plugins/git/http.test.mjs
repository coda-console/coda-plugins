import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture, command, env, packet } from './helpers.mjs';
import { smartHTTP } from '../../../plugins/git/lib/http.mjs';
import { repository, git } from '../../../plugins/git/lib/git.mjs';

async function server(t, dir, caller = { local: true }) {
  const handler = smartHTTP({ lookup: async id => id === 'source' ? await repository(dir, env) : null, environment: async () => env });
  const seen = [];
  const http = createServer((req, res) => { seen.push({ url: req.url, protocol: req.headers['git-protocol'] }); void handler(req, res, caller); });
  t.after(async () => { handler.dispose(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return { base: `http://127.0.0.1:${http.address().port}`, seen };
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
  const { base, seen } = await server(t, dir);
  const discovery = await raw(base, '/repos/source/info/refs?service=git-upload-pack');
  assert.equal(discovery.status, 200, discovery.body.toString());
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  const trace = join(dir, 'trace');
  await command(target, ['-c', 'protocol.version=2', 'fetch', `${base}/repos/source`, 'refs/heads/main:refs/heads/main'], { GIT_TRACE_PACKET: trace });
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  assert.match(await readFile(trace, 'utf8'), /version 2/);
  await writeFile(join(dir, 'tracked'), 'incremental'); await command(dir, ['add', 'tracked']); await command(dir, ['commit', '-m', 'next']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', `${base}/repos/source`, 'refs/heads/main:refs/heads/main'], { GIT_TRACE_PACKET: trace });
  assert.match(await readFile(trace, 'utf8'), /have [a-f0-9]{40}/);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  await command(target, ['fsck', '--full']);
  assert.ok(seen.every(item => item.protocol === 'version=2'));
  const listed = await command(target, ['-c', 'protocol.version=2', 'ls-remote', `${base}/repos/source`]);
  assert.ok(listed.includes('refs/heads/main')); assert.ok(!listed.includes('refs/coda/') && !listed.includes('refs/private/'));
  await assert.rejects(command(target, ['-c', 'protocol.version=2', 'fetch', `${base}/repos/source`, `${ref}:refs/heads/hidden`]));
  const body = Buffer.concat([packet('command=fetch\n'), Buffer.from('0001'), packet(`want ${hidden}\n`), packet('done\n'), Buffer.from('0000')]);
  assert.equal((await raw(base, '/repos/source/git-upload-pack', { method: 'POST', body })).status, 403);
});

test('鉴权：既不是本机也不是 client／backend 身份的调用被拒，client 身份可读', async t => {
  const dir = await fixture(t);
  const anonymous = await server(t, dir, {}), device = await server(t, dir, { role: 'client', device: 'phone' });
  assert.equal((await raw(anonymous.base, '/repos/source/info/refs?service=git-upload-pack')).status, 403);
  assert.equal((await raw(device.base, '/repos/source/info/refs?service=git-upload-pack')).status, 200);
});

test('超过 5 MiB 分块 POST 的末尾 want 被处理，响应不截断', async t => {
  const dir = await fixture(t), { base } = await server(t, dir);
  const head = await command(dir, ['rev-parse', 'HEAD']);
  const lines = [packet('command=fetch\n'), Buffer.from('0001')];
  // Valid repeated shallow lines exceed Git's normal request buffer; the decisive want is the LAST packet.
  const shallow = packet(`shallow ${head}\n`);
  for (let bytes = 0; bytes < 5 * 1024 * 1024; bytes += shallow.length) lines.push(shallow);
  lines.push(packet(`want ${head}\n`), packet('done\n'), Buffer.from('0000'));
  const body = Buffer.concat(lines);
  const result = await raw(base, '/repos/source/git-upload-pack', { method: 'POST', body, chunked: true });
  assert.equal(result.sent, body.length); assert.equal(result.status, 200, result.body.toString());
  assert.ok(result.body.includes(Buffer.from('PACK')), result.body.subarray(0, 300).toString());
  assert.ok(!result.body.includes(Buffer.from('ERR ')));
  const pack = [];
  for (let offset = 0; offset < result.body.length;) {
    const size = parseInt(result.body.subarray(offset, offset + 4).toString(), 16); offset += 4;
    if (size <= 2) continue;
    const data = result.body.subarray(offset, offset + size - 4); offset += size - 4;
    if (data[0] === 1) pack.push(data.subarray(1));
  }
  const target = join(dir, 'long-post-client'); await mkdir(target); await command(target, ['init']);
  await git(target, ['index-pack', '--stdin'], { env, input: Buffer.concat(pack) });
  assert.equal(await command(target, ['cat-file', '-t', head]), 'commit');
  await command(target, ['fsck', '--full']);
});

test('拒绝 receive-pack、路径穿越、未登记源、隐藏提交和直接文件读取', async t => {
  const dir = await fixture(t), { base } = await server(t, dir);
  await command(dir, ['checkout', '--orphan', 'secret']);
  await writeFile(join(dir, 'secret'), 'private'); await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'secret']);
  const secret = await command(dir, ['rev-parse', 'HEAD']);
  await command(dir, ['config', 'http.receivepack', 'true']);
  await command(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await command(dir, ['update-ref', 'refs/private/secret', secret]);
  await command(dir, ['checkout', 'main']); await command(dir, ['branch', '-D', 'secret']);
  for (const path of ['/repos/source/git-receive-pack', '/repos/source/info/refs?service=git-receive-pack'])
    assert.equal((await raw(base, path, { method: 'POST' })).status, 403);
  for (const path of ['/repos/unknown/info/refs?service=git-upload-pack', '/repos/%2e%2e/info/refs?service=git-upload-pack',
    '/repos/source%2f..%2fsecret/git-upload-pack', '/repos/source/HEAD', '/repos/source/objects/info/alternates',
    '/repos//source/info/refs?service=git-upload-pack', '/repos/source/info/refs?service=git-upload-pack&x=y'])
    assert.equal((await raw(base, path)).status, 404, path);
  const body = Buffer.concat([packet('command=fetch\n'), Buffer.from('0001'), packet(`want ${secret}\n`), packet('done\n'), Buffer.from('0000')]);
  assert.equal((await raw(base, '/repos/source/git-upload-pack', { method: 'POST', body })).status, 403);
});

test('浅克隆源仍可提供 v2 fetch', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'tracked'), 'second'); await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'second']);
  const shallow = join(dir, 'shallow-source');
  await command(dir, ['clone', '--depth=1', `file://${dir}`, shallow]);
  const { base } = await server(t, shallow);
  const target = join(dir, 'shallow-client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', '--update-shallow', `${base}/repos/source`, 'main:refs/heads/main']);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'HEAD']));
  await command(target, ['fsck', '--full']);
});

test('拒绝取源码的请求时记一行日志：状态、原因、源与三个请求头，不含鉴权头；正常请求不记', async t => {
  const dir = await fixture(t), { base } = await server(t, dir);
  const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const send = (path, headers) => new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  const upload = { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' };
  assert.equal(await send('/repos/source/git-upload-pack', { 'Git-Protocol': 'version=2', 'Content-Type': 'text/plain', Authorization: 'Bearer top-secret', Cookie: 'sid=top-secret' }), 415);
  assert.deepEqual(logged, ['[git http] 415 需要 upload-pack 请求 POST source=source content-type="text/plain" content-encoding=无 git-protocol="version=2"']);
  logged.length = 0;
  assert.equal(await send('/repos/source/git-upload-pack', { ...upload, 'Content-Encoding': 'gzip' }), 415);
  assert.deepEqual(logged, ['[git http] 415 不接受压缩请求体 POST source=source content-type="application/x-git-upload-pack-request" content-encoding="gzip" git-protocol="version=2"']);
  logged.length = 0;
  assert.equal(await send('/repos/source/HEAD', {}), 404);
  assert.deepEqual(logged, ['[git http] 404 不允许的 Git 路径 POST path="/repos/source/HEAD" content-type=无 content-encoding=无 git-protocol=无']);
  logged.length = 0;
  assert.equal((await raw(base, '/repos/source/info/refs?service=git-upload-pack')).status, 200);
  assert.deepEqual(logged, []);
});

test('处理过程出错回 500 时同样记一行日志', async t => {
  const handler = smartHTTP({ lookup: async () => { throw new Error('boom'); }, environment: async () => env });
  const http = createServer((req, res) => { void handler(req, res, { local: true }); });
  t.after(async () => { handler.dispose(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const logged = []; t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const result = await raw(`http://127.0.0.1:${http.address().port}`, '/repos/source/info/refs?service=git-upload-pack');
  assert.equal(result.status, 500);
  assert.deepEqual(logged, ['[git http] 500 boom GET source=source content-type=无 content-encoding=无 git-protocol="version=2"']);
});
