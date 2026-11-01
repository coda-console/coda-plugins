import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture, command, env, packet } from './helpers.mjs';
import { smartHTTP } from '../../../plugins/git/lib/http.mjs';
import { repository, createSnapshot, snapshotRef, git } from '../../../plugins/git/lib/git.mjs';

async function server(t, dir, refs = new Set()) {
  const handler = smartHTTP({ lookup: async id => id === 'source' ? { ...await repository(dir, env), refs } : null, environment: async () => env });
  const seen = [];
  const http = createServer((req, res) => { seen.push({ url: req.url, protocol: req.headers['git-protocol'] }); void handler(req, res, { local: true }); });
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

test('真实 v2 全量与增量 fetch、快照 tree 与 fsck 一致，只导出分支和登记快照', async t => {
  const dir = await fixture(t), repo = await repository(dir, env);
  await writeFile(join(dir, 'blob'), randomBytes(1024 * 1024));
  await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'payload']);
  await writeFile(join(dir, 'local'), 'snapshot');
  const ref = snapshotRef('d'.repeat(64)), commit = await createSnapshot(repo, { mode: 'worktree' }, ref, env);
  await command(dir, ['update-ref', 'refs/private/secret', commit]);
  const { base, seen } = await server(t, dir, new Set([ref]));
  const discovery = await raw(base, '/repos/source/info/refs?service=git-upload-pack');
  assert.equal(discovery.status, 200, discovery.body.toString());
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  const trace = join(dir, 'trace');
  await command(target, ['-c', 'protocol.version=2', 'fetch', `${base}/repos/source`, `${ref}:refs/heads/snapshot`], { GIT_TRACE_PACKET: trace });
  assert.equal(await command(target, ['rev-parse', 'refs/heads/snapshot^{tree}']), await command(dir, ['rev-parse', `${commit}^{tree}`]));
  assert.match(await readFile(trace, 'utf8'), /version 2/);
  await writeFile(join(dir, 'tracked'), 'incremental'); await command(dir, ['add', 'tracked']); await command(dir, ['commit', '-m', 'next']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', `${base}/repos/source`, 'refs/heads/main:refs/heads/main'], { GIT_TRACE_PACKET: trace });
  assert.match(await readFile(trace, 'utf8'), /have [a-f0-9]{40}/);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  await command(target, ['fsck', '--full']);
  assert.ok(seen.every(item => item.protocol === 'version=2'));
  const listed = await command(target, ['-c', 'protocol.version=2', 'ls-remote', `${base}/repos/source`]);
  assert.ok(listed.includes(ref)); assert.ok(!listed.includes('refs/private/'));
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
