import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
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
export const packet = line => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line);

// The plugin's reconciliation runs against the synchronized host API and real Git. Storage/transport belong
// to Coda's tests; this fixture keeps the records of the new interface (`put`, `delete`, `watch`, events as
// `{ type, id, entry }`), whole as a plugin writes them, and hands out each handler's result so a test can wait for it.
export function host(state) {
  const types = new ProtocolTypes(), objects = new Map(), watchers = new Set(), pending = [], failures = [];
  for (const definition of manifest.contributes.protocols)
    types.register({ kind: definition.name, spec: definition.spec, status: definition.status, participants: () => [] });
  let version = 0;
  const entry = object => ({ owner: 'self', location: 'test', id: object.id, local: true, spec: object.spec, status: object.status, labels: object.labels, version: object.version });
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
  const put = async ({ kind, id }, value) => {
    const key = `${kind}/${id}`, old = objects.get(key), type = types.get(kind), status = value.status ?? {};
    validate(type.spec, value.spec, 'spec'); validate(type.status, status, 'status');
    if (old && JSON.stringify(old.spec) === JSON.stringify(value.spec) && JSON.stringify(old.status) === JSON.stringify(status)) return;
    const object = { kind, id, spec: value.spec, status, labels: null, version: String(++version) };
    objects.set(key, object); emit(kind, old ? 'MODIFIED' : 'ADDED', object);
  };
  const remove = async ({ kind, id }) => {
    const old = objects.get(`${kind}/${id}`);
    if (old) { objects.delete(`${kind}/${id}`); emit(kind, 'DELETED', old); }
  };
  const coda = { plugin: { state }, environment: async () => env, watch, put, delete: remove,
    services: { register: async (_id, handler) => { coda.handler = handler; return { dispose() {} }; } },
  };
  // Waits for every handler, and those the writes of the handlers set off.
  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
    if (failures.length) throw failures.shift();
  };
  return { coda, objects, failures, flush };
}
