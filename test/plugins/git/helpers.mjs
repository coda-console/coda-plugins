import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';
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
// to Coda's tests; this fixture supplies events and rejects stale revisions, without starting a backend.
export function host(state) {
  const types = new ProtocolTypes(), objects = new Map(), listeners = new Map(), runs = new Map();
  const published = new Set(), operations = new Map();
  for (const definition of manifest.contributes.protocols)
    types.register({ kind: definition.name, spec: definition.spec, status: definition.status, participants: () => [] });
  const failures = []; let revision = 0;
  const emit = (collection, event) => { for (const fn of listeners.get(collection) ?? []) fn(structuredClone(event)); };
  const watch = async (collection, fn, filter) => {
    const set = listeners.get(collection) ?? new Set(); listeners.set(collection, set); set.add(fn);
    const entries = collection === 'workflow-runs' ? [...runs.values()] : [...objects.values()].filter(o => o.kind === collection);
    for (const object of entries) if (!filter?.run || object.id === filter.run) fn({ type: 'ADDED', id: object.id, object: structuredClone(object) });
    return { dispose: () => set.delete(fn) };
  };
  const call = async (method, args) => {
    const [kind, id] = method === 'put' ? [args[0].kind, args[0].id] : args;
    const key = `${kind}/${id}`, old = objects.get(key), type = types.get(kind);
    if (method === 'publish') {
      if (args[2] === false) published.delete(key); else published.add(key);
      return;
    }
    if (method === 'delete') { objects.delete(key); if (old) emit(kind, { type: 'DELETED', id, object: old }); return; }
    const expected = method === 'put' ? args[0].revision : args[3];
    if (old && expected !== old.revision) throw new Error('revision conflict');
    const spec = method === 'put' ? args[0].spec : old.spec, status = method === 'setStatus' ? args[2] : old?.status ?? {};
    validate(type.spec, spec, 'spec'); validate(type.status, status, 'status');
    if (old && JSON.stringify(old.spec) === JSON.stringify(spec) && JSON.stringify(old.status) === JSON.stringify(status)) return old;
    const object = { kind, id, spec, status, instance: old?.instance ?? randomUUID(), revision: String(++revision) };
    objects.set(key, object); emit(kind, { type: old ? 'MODIFIED' : 'ADDED', id, object }); return object;
  };
  const plugin = { id: 'git', protocolImplementations: manifest.contributes.protocolImplementations };
  const coda = { plugin: { state }, environment: async () => env, watch,
    api: async path => { const run = runs.get(path.split('/').at(-1)); if (!run) throw new Error('run not found'); return run; },
    services: { register: async (_id, handler) => { coda.handler = handler; return { dispose() {} }; } },
    protocols: providerAPI({ call, watch, plugin, operations, report: (...error) => failures.push(error) }),
  };
  return { coda, objects, failures, published, operations, run(id, state = 'running') {
    const object = { id, runId: id, state }; runs.set(id, object); emit('workflow-runs', { type: 'MODIFIED', id, object });
  } };
}
export async function idle(provider) {
  for (let i = 0; i < 100; i++) {
    const queue = provider.queue; await queue; await new Promise(resolve => setImmediate(resolve));
    if (queue === provider.queue) return;
  }
  throw new Error('controller did not settle');
}
