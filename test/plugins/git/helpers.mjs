import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pointProblem } from '@coda-console/protocol/validate';
import { createMockCoda } from '../../helpers/mock-coda.mjs';
import { recordId, validKey } from '../records.mjs';
import { SOURCE } from '../../../plugins/git/lib/definitions.mjs';
const exec = promisify(execFile);
const manifest = JSON.parse(readFileSync(new URL('../../../plugins/git/package.json', import.meta.url), 'utf8'));
export const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
export async function command(cwd, args, extra = {}) {
  return (await exec('git', args, { cwd, env: { ...env, ...extra }, maxBuffer: 16 * 1024 * 1024 })).stdout.trimEnd();
}
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coda-git-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await command(dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'tracked'), 'base\n');
  await writeFile(join(dir, '.gitignore'), 'ignored\n');
  await command(dir, ['add', '.']); await command(dir, ['commit', '-m', 'base']);
  return dir;
}
// As the host compares: by the keys sorted, at every depth; an array keeps its order.
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const STATUS = { invalid_input: 400, forbidden: 403, not_found: 404, method_not_allowed: 405 };
export const packet = line => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line);

// The in-memory `coda` with what the plugin's manifest says of it.
export function testHost(t, state) {
  const { protocols, protocolImplementations } = manifest.contributes;
  const host = createMockCoda({ plugin: { id: 'git', state, protocols, protocolImplementations } });
  t.after(() => host.close());
  return host;
}
// A backend's entry to the streams of its records, for a real `git`: each request handed to the module's, answered as it answers.
export async function gateway(t, host, { caller } = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push({ url: req.url, protocol: req.headers['git-protocol'] });
    const [, kind, id, name, rest] = /^\/v1\/records\/([^/]+)\/([^/]+)\/streams\/([^/?]+)(.*)$/.exec(req.url);
    const gone = new AbortController();
    res.once('close', () => gone.abort());
    try {
      const response = await host.stream({ kind: decodeURIComponent(kind), id }, name, new Request(`http://stream${rest}`, { method: req.method,
        headers: req.headers, signal: gone.signal, ...(req.method === 'GET' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) }), { caller });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      res.writeHead(STATUS[error.code] ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
    }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

// The plugin's reconciliation runs against the synchronized host API and real Git. Storage/transport belong
// to Coda's tests; this fixture keeps the records of the interface (`put`, `delete`, `replace` by the plugin's key, the ID
// the host's, derived from it), whole as a plugin writes them. A `replace` without a status keeps the one held. `seed` puts a
// record there as an earlier version left it, without a key. The stream and the service it registers are the
// in-memory `coda`'s (`served`).
export function host(t, state) {
  const definitions = new Map(manifest.contributes.protocols.map(definition => [definition.name, definition])), objects = new Map(), plugin = 'git';
  let version = 0;
  const entry = object => ({ owner: 'self', location: 'test', id: object.id, ...(object.key !== undefined ? { key: object.key } : {}),
    local: true, spec: object.spec, status: object.status, labels: object.labels, version: object.version });
  const check = (kind, key, value) => {
    assert.ok(validKey(key), `key ${key}`); const definition = definitions.get(kind);
    for (const problem of [pointProblem(definition.spec, value.spec, 'spec'), pointProblem(definition.status, value.status ?? {}, 'status')]) assert.equal(problem, null);
  };
  const write = (kind, key, value) => {
    const id = recordId(plugin, kind, key), at = `${kind}/${id}`, old = objects.get(at), status = value.status ?? old?.status ?? {};
    if (!old || !same(old.spec, value.spec) || !same(old.status, status))
      objects.set(at, { kind, id, key, spec: value.spec, status, labels: null, version: String(++version) });
    return entry(objects.get(at));
  };
  const put = async ({ kind, key, ...rest }, value) => { assert.deepEqual(rest, {}); check(kind, key, value); return write(kind, key, value); };
  const remove = async ({ kind, key, ...rest }) => {
    assert.deepEqual(rest, {}); assert.ok(validKey(key), `key ${key}`);
    objects.delete(`${kind}/${recordId(plugin, kind, key)}`);
  };
  // All or nothing: checked first, then what this plugin holds of the kind and is not given goes, keyless ones among them.
  const replace = async (kind, items) => {
    for (const { key, ...value } of items) check(kind, key, value);
    for (const [at, object] of objects) if (object.kind === kind && !items.some(item => item.key === object.key)) objects.delete(at);
    return items.map(({ key, ...value }) => write(kind, key, value));
  };
  const seed = (kind, id, value) => objects.set(`${kind}/${id}`, { kind, id, spec: value.spec, status: value.status ?? {}, labels: null, version: String(++version) });
  const served = testHost(t, state);
  const coda = { plugin: { id: plugin, state }, put, delete: remove, replace, serve: served.coda.serve, stream: served.coda.stream };
  return { coda, served, objects, seed, id: name => recordId(plugin, SOURCE, name) };
}
