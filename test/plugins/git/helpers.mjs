import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
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
export const packet = line => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line);

// The plugin's reconciliation runs against the synchronized host API and real Git. Storage/transport belong
// to Coda's tests; this fixture keeps the records of the new interface (`put`, `delete`, `replace` by the plugin's key, the ID
// the host's, derived from it; `watch`, events as `{ type, id, entry }`, the entry with its key, for the plugin wrote it), whole
// as a plugin writes them, and hands out each handler's result so a test can wait for it. `seed` puts a record there as an
// earlier version left it, without a key.
export function host(state) {
  const types = new ProtocolTypes(), objects = new Map(), watchers = new Set(), pending = [], failures = [], plugin = 'git';
  for (const definition of manifest.contributes.protocols)
    types.register({ kind: definition.name, spec: definition.spec, status: definition.status, participants: () => [] });
  let version = 0;
  const entry = object => ({ owner: 'self', location: 'test', id: object.id, ...(object.key !== undefined ? { key: object.key } : {}),
    local: true, spec: object.spec, status: object.status, labels: object.labels, version: object.version });
  const emit = (kind, type, object) => {
    for (const watcher of watchers) if (watcher.kind === kind)
      pending.push(Promise.resolve(watcher.fn(structuredClone({ type, id: object.id, entry: entry(object) }))).catch(error => failures.push(error)));
  };
  const watch = async (kind, fn, filter) => {
    assert.deepEqual(filter, { scope: 'local' });
    const watcher = { kind, fn }; watchers.add(watcher);
    for (const object of objects.values()) if (object.kind === kind) emit(kind, 'ADDED', object);
    return { dispose: () => watchers.delete(watcher) };
  };
  const check = (kind, key, value) => {
    assert.ok(validKey(key), `key ${key}`); const type = types.get(kind);
    validate(type.spec, value.spec, 'spec'); validate(type.status, value.status ?? {}, 'status');
  };
  const write = (kind, key, value) => {
    const id = recordId(plugin, kind, key), at = `${kind}/${id}`, old = objects.get(at), status = value.status ?? {};
    if (!old || !same(old.spec, value.spec) || !same(old.status, status)) {
      const object = { kind, id, key, spec: value.spec, status, labels: null, version: String(++version) };
      objects.set(at, object); emit(kind, old ? 'MODIFIED' : 'ADDED', object);
    }
    return entry(objects.get(at));
  };
  const drop = at => { const old = objects.get(at); objects.delete(at); emit(old.kind, 'DELETED', old); };
  const put = async ({ kind, key, ...rest }, value) => { assert.deepEqual(rest, {}); check(kind, key, value); return write(kind, key, value); };
  const remove = async ({ kind, key, ...rest }) => {
    assert.deepEqual(rest, {}); assert.ok(validKey(key), `key ${key}`);
    const at = `${kind}/${recordId(plugin, kind, key)}`;
    if (objects.has(at)) drop(at);
  };
  // All or nothing: checked first, then what this plugin holds of the kind and is not given goes, keyless ones among them.
  const replace = async (kind, items) => {
    for (const { key, ...value } of items) check(kind, key, value);
    for (const [at, object] of objects) if (object.kind === kind && !items.some(item => item.key === object.key)) drop(at);
    return items.map(({ key, ...value }) => write(kind, key, value));
  };
  const seed = (kind, id, value) => objects.set(`${kind}/${id}`, { kind, id, spec: value.spec, status: value.status ?? {}, labels: null, version: String(++version) });
  const coda = { plugin: { id: plugin, state }, environment: async () => env, watch, put, delete: remove, replace,
    services: { register: async (_id, handler) => { coda.handler = handler; return { dispose() {} }; } },
  };
  // Waits for every handler, and those the writes of the handlers set off.
  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
    if (failures.length) throw failures.shift();
  };
  return { coda, objects, failures, flush, seed, id: name => recordId(plugin, SOURCE, name) };
}
