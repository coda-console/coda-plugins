import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';
import { smartHTTP } from '../../../plugins/git/lib/http.mjs';
import { Sources } from '../../../plugins/host/lib/source.mjs';
import { prepareWorkspace, git } from '../../../plugins/host/lib/workspace.mjs';

test('official resolver adapter feeds git provider smart HTTP v2 into the host cache without persisting credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-git-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), cache = join(root, 'cache');
  await mkdir(repo); await mkdir(cache);
  await git(repo, ['init', '--quiet']);
  await writeFile(join(repo, 'input'), 'snapshot contents');
  await git(repo, ['add', 'input']);
  await promisify(execFile)('git', ['-C', repo, 'commit', '-qm', 'fixture'], { env: {
    ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  } });
  const commit = await git(repo, ['rev-parse', 'HEAD']), ref = 'refs/coda/snapshots/transport';
  await git(repo, ['update-ref', ref, commit]);
  const requests = [], token = 'fixture-ephemeral-credential', path = '/v1/plugins/git/services/repository/';
  const http = smartHTTP({ lookup: async id => id === 'local-source' ? { path: repo, refs: new Set([ref]) } : null,
    environment: async () => ({ PATH: process.env.PATH }) });
  const server = createServer((req, res) => {
    requests.push({ url: req.url, protocol: req.headers['git-protocol'], authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (!req.url.startsWith(path)) { res.writeHead(404); res.end(); return; }
    req.url = req.url.slice(path.length - 1);
    void http(req, res, { role: 'backend' });
  });
  t.after(async () => { http.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const objects = [
    { kind: 'gitSource', id: 'mirrored-source', instance: 'source-incarnation', status: { ready: true } },
    { kind: 'sourceSnapshot', id: 'mirrored-snapshot', spec: { source: 'local-source' }, status: { ready: true, commit, ref } },
  ];
  const protocols = providerAPI({ connection: () => ({ url, token }), call: async (method, args) => {
    assert.equal(method, 'resolve'); assert.equal(args[1], 'repository');
    return { resource: { kind: args[0].kind, id: args[0].kind === 'gitSource' ? 'local-source' : 'local-snapshot' }, path };
  }, watch: async (kind, fn, options) => {
    assert.equal(options.scope, 'available');
    for (const object of objects.filter(object => kind === `provider:${object.kind}`)) fn({ type: 'ADDED', id: object.id, object });
    return { dispose() {} };
  } });
  const sources = new Sources({ protocols }); await sources.start(); t.after(() => sources.stop());
  for (const input of [{ snapshot: { kind: 'sourceSnapshot', id: 'mirrored-snapshot' } },
    { repository: { kind: 'gitSource', id: 'mirrored-source' }, commit }]) {
    const source = await sources.resolve(input);
    const workspace = await prepareWorkspace({ root: cache, source, slot: 0, attempt: 'transport' });
    assert.equal(await readFile(join(workspace, 'input'), 'utf8'), 'snapshot contents');
    assert.equal((await readFile(join(workspace, '.git', 'config'), 'utf8')).includes(token), false);
  }
  assert.ok(requests.some(request => request.url.endsWith('/git-upload-pack')));
  assert.ok(requests.every(request => request.protocol === 'version=2' && request.authorization === `Bearer ${token}`));
});
