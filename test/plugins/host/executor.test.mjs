import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probe, capacityStatus } from '../../../plugins/host/lib/capabilities.mjs';
import { prepareWorkspace, inside, git } from '../../../plugins/host/lib/workspace.mjs';
import { executeHooks } from '../../../plugins/host/lib/hooks.mjs';
import { Journal, identity, taskFingerprint } from '../../../plugins/host/lib/journal.mjs';
import { Executions } from '../../../plugins/host/lib/executions.mjs';
import { Sources } from '../../../plugins/host/lib/source.mjs';
import { outputs } from '../../../plugins/host/lib/results.mjs';

const exec = promisify(execFile);
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'host-executor-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const spec = () => ({ protocolVersion: 1, executor: { kind: 'executor', id: 'host' }, assignmentId: 'binding-a',
  run: { kind: 'workflow-runs', id: 'workflow' }, attempt: 1, source: null, requirements: { labels: ['linux'] },
  resources: { slots: 1 }, exclusiveResources: [], task: { command: 'true', args: [] }, env: {}, cancel: false });
const request = () => ({ kind: 'execution', id: 'job', instance: 'instance-a', revision: 'v1', spec: spec(), status: {} });

test('read-only capability probes distinguish missing Xcode and unavailable runtimes; capacity includes other ledger users', async () => {
  const calls = [];
  const discovered = await probe({ os: 'darwin', cpu: 'arm64', node: '26.8.2', run: async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'xcodebuild') throw new Error('not installed');
    if (file === 'stat') return `${process.getuid()}\n`;
    return JSON.stringify({ runtimes: [{ identifier: 'r1', name: 'iOS 26.1', version: '26.1', isAvailable: true },
      { identifier: 'r2', name: 'iOS 25.0', version: '25.0', isAvailable: false }] });
  } });
  assert.deepEqual(discovered.detectedLabels, ['arm64', 'darwin', 'gui', 'ios-26.1', 'node-26']);
  assert.equal(discovered.capabilities.xcode, undefined); assert.equal(discovered.reason.code, 'probe_incomplete');
  assert.equal(calls.some(call => call.includes('boot')), false);
  const value = capacityStatus({ enabled: true, capacity: { slots: 1 } }, { capacity: 3, occupied: 2, available: 1 }, discovered);
  assert.deepEqual([value.capacity, value.occupied, value.available], [{ slots: 1 }, { slots: 2 }, { slots: 0 }]);
  assert.equal(capacityStatus({ enabled: true, capacity: { slots: 2 } }, null, discovered).accepting, false);
});

test('real Git cache keeps ignored files, cleans stale source, isolates work copies and ledger slots, and checks commit', async t => {
  const root = await temporary(t), repo = join(root, 'repo'), cache = join(root, 'cache'); await mkdir(repo); await mkdir(cache);
  await git(repo, ['init', '--quiet']); await writeFile(join(repo, 'a'), 'one'); await writeFile(join(repo, '.gitignore'), 'cache/\n');
  await git(repo, ['add', '.']);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  await exec('git', ['-C', repo, 'commit', '-qm', 'one'], { env });
  const commit = await git(repo, ['rev-parse', 'HEAD']);
  const source = { key: 'work-copy-a:instance', commit, ref: commit, url: 'https://fixture.invalid/repo' };
  // Test the filesystem/Git semantics at their own layer, substituting only the already-tested HTTP transport.
  const localGit = (cwd, args, signal) => git(cwd, args.map(arg => arg === source.url ? repo : arg), signal);
  const prepare = (more = {}) => prepareWorkspace({ root: cache, source, slot: 0, attempt: 'one', runGit: localGit, ...more });
  const workspace = await prepare(); await mkdir(join(workspace, 'cache')); await writeFile(join(workspace, 'cache', 'compiled'), 'kept');
  await writeFile(join(workspace, 'stale'), 'remove'); await writeFile(join(workspace, 'a'), 'dirty');
  assert.equal(await prepare(), workspace);
  assert.equal(await readFile(join(workspace, 'a'), 'utf8'), 'one');
  assert.equal(await readFile(join(workspace, 'cache', 'compiled'), 'utf8'), 'kept');
  await assert.rejects(readFile(join(workspace, 'stale')), { code: 'ENOENT' });
  assert.notEqual(await prepare({ slot: 1 }), workspace);
  assert.notEqual(await prepare({ source: { ...source, key: 'work-copy-b:instance' } }), workspace);
  await assert.rejects(prepare({ source: { ...source, ref: await git(repo, ['symbolic-ref', 'HEAD']), commit: 'a'.repeat(40) } }), /commit 不一致/);
  await symlink(repo, join(workspace, 'escape')); await assert.rejects(inside(workspace, 'escape'), /逃出/);
  await assert.rejects(inside(workspace, '../repo'), /工作副本内/);
});

test('prepare failure still cleans up its returned state; cancellation cannot skip cleanup', async t => {
  const root = await temporary(t), calls = [], controller = new AbortController();
  const result = await executeHooks({ root, directory: root, attempt: 'a', source: null, slot: 0, spec: spec(), env: {}, signal: controller.signal,
    checkpoint: async () => {}, hook: async input => {
      calls.push(input.command);
      if (input.command === 'prepare_job') return { code: 1, answer: { state: { workspace: root } } };
      assert.deepEqual(input.state, { workspace: root }); return { code: 0 };
    } });
  assert.deepEqual(calls, ['prepare_job', 'cleanup_job']); assert.equal(result.outcome, 'failed');
  calls.length = 0;
  const cancelled = await executeHooks({ root, directory: root, attempt: 'a', source: null, slot: 0, spec: spec(), env: {}, signal: controller.signal,
    checkpoint: async patch => { if (patch.phase === 'running') controller.abort(); }, hook: async input => {
      calls.push(input.command);
      if (input.command === 'prepare_job') return { code: 0, answer: { state: { workspace: root } } };
      if (input.command === 'cleanup_job') assert.equal(input.signal.aborted, false);
      return { code: 143, aborted: input.command === 'run_script_step' };
    } });
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(calls.at(-1), 'cleanup_job');
});

test('real three-part hook runs commands in isolation and returns the command exit code and declared outputs', async t => {
  const root = await temporary(t), directory = join(root, 'attempt');
  const task = { ...spec(), task: { script: 'printf "hello=%s\\n" "$DECLARED" >> "$GITHUB_OUTPUT"\nprintf "%s" "${SHOULD_NOT_LEAK-absent}"\nexit 7', shell: 'sh' }, env: { DECLARED: 'yes' } };
  const result = await executeHooks({ root, directory, attempt: 'attempt', source: null, slot: 0, spec: task,
    env: { ...process.env, SHOULD_NOT_LEAK: 'secret' }, signal: new AbortController().signal, checkpoint: async () => {} });
  assert.equal(result.exitCode, 7); assert.equal(result.outcome, 'failed');
  assert.equal(await readFile(join(directory, 'output'), 'utf8'), 'hello=yes\n');
  assert.equal(await readFile(join(directory, 'log'), 'utf8'), 'absent');
});

function engine(root, changes = {}) {
  const writes = [], released = [], launches = [], cancels = [], runs = new Map();
  const coda = { resources: {
    acquire: async () => ({ admitted: true, lease: 'lease', slot: 0 }), release: async lease => released.push(lease),
  }, protocols: {
    setStatus: async (kind, id, status, revision) => { writes.push({ kind, id, status, revision }); },
    put: async object => { runs.set(object.id, { ...object, revision: 'r1' }); return runs.get(object.id); }, publish: async () => {},
  } };
  const host = new Executions({ coda, root, executorId: 'host', sources: { resolve: async () => null }, offered: () => ({
    spec: { labels: [] }, status: { accepting: true, detectedLabels: ['linux'] },
  }), environment: async () => ({}), launch: async input => launches.push(input), control: async (record, action) => { cancels.push(action); return true; }, ...changes });
  host.runs = runs;
  return { host, coda, writes, released, launches, cancels };
}

test('assigned controller starts once, accepts cancel while running, and restart never reruns a durable claim', async t => {
  const root = await temporary(t), first = engine(root), object = request();
  await first.host.observe({ type: 'ADDED', id: object.id, object });
  await first.host.observe({ type: 'ADDED', id: object.id, object }); assert.equal(first.launches.length, 1);
  await first.host.observe({ type: 'MODIFIED', id: object.id, object: { ...object, revision: 'v2', spec: { ...object.spec, cancel: true } } });
  assert.ok(first.cancels.includes('cancel'));
  const restart = engine(root, { control: async () => false });
  await restart.host.observe({ type: 'ADDED', id: object.id, object });
  assert.equal(restart.launches.length, 0); assert.deepEqual(restart.released, []);
  assert.equal(restart.writes.at(-1).status.reason.code, 'result_unknown');
});

test('rebind/deletion cannot receive an old result; only a finished worker releases its lease', async t => {
  const root = await temporary(t), fixture = engine(root), object = request();
  await fixture.host.observe({ type: 'ADDED', id: object.id, object });
  const record = fixture.host.journal.get(identity(object));
  record.phase = 'finished'; record.result = { outcome: 'succeeded', exitCode: 0, finishedAt: new Date().toISOString() };
  fixture.host.journal.save(record);
  fixture.writes.length = 0;
  await fixture.host.observe({ type: 'DELETED', id: object.id, object });
  assert.deepEqual(fixture.released, ['lease']); assert.equal(fixture.writes.filter(w => w.kind === 'execution').length, 0);
  const foreign = { ...object, spec: { ...object.spec, executor: { kind: 'executor', id: 'another' }, assignmentId: 'b' } };
  await fixture.host.observe({ type: 'ADDED', id: foreign.id, object: foreign });
  assert.equal(fixture.launches.length, 1);
});

test('a cancellation during source resolution prevents ledger admission and process creation', async t => {
  const root = await temporary(t), object = request(); let resolveSource, looked;
  const ready = new Promise(resolve => { looked = resolve; });
  const source = new Promise(resolve => { resolveSource = resolve; });
  const fixture = engine(root, { sources: { resolve: () => { looked(); return source; } } });
  let acquired = 0; fixture.coda.resources.acquire = async () => { acquired++; return { admitted: false }; };
  const started = fixture.host.observe({ type: 'ADDED', id: object.id, object }); await ready;
  const cancel = fixture.host.observe({ type: 'MODIFIED', id: object.id, object: { ...object, spec: { ...object.spec, cancel: true }, revision: 'v2' } });
  resolveSource(null); await started; await cancel;
  assert.equal(acquired, 0); assert.equal(fixture.launches.length, 0);
  assert.equal(fixture.writes.at(-1).status.outcome, 'cancelled');
});

test('a current journal record cannot skip cancellation or lease release of a later old binding', async t => {
  const root = await temporary(t), object = request(), cancelled = [];
  const fixture = engine(root, { control: async (record, action) => {
    if (action === 'cancel') cancelled.push(record.key);
    return true;
  } });
  const current = { key: identity(object), id: object.id, instance: object.instance, assignmentId: object.spec.assignmentId,
    fingerprint: taskFingerprint(object.spec), phase: 'running', admission: { lease: 'current-lease', slot: 0 } };
  const oldObject = { ...object, spec: { ...object.spec, assignmentId: 'old-binding' } };
  const old = { ...current, key: identity(oldObject), assignmentId: oldObject.spec.assignmentId,
    fingerprint: taskFingerprint(oldObject.spec), admission: { lease: 'old-lease', slot: 1 } };
  fixture.host.journal.save(current); fixture.host.journal.save(old);
  // Exercise the problematic order explicitly, independent of filesystem directory ordering.
  fixture.host.journal.list = () => [current.key, old.key].map(key => fixture.host.journal.get(key));
  await fixture.host.observe({ type: 'ADDED', id: object.id, object });
  assert.deepEqual(cancelled, [old.key]); assert.deepEqual(fixture.released, []);
  old.phase = 'finished'; old.result = { outcome: 'cancelled', exitCode: 143, finishedAt: new Date().toISOString() };
  fixture.host.journal.save(old);
  await fixture.host.tick(); await fixture.host.tick();
  assert.deepEqual(fixture.released, ['old-lease']);
  assert.equal(fixture.host.journal.get(old.key).released, true);
  assert.equal(fixture.host.journal.get(current.key).released, undefined);
  assert.equal(fixture.launches.length, 0);
  const replies = fixture.writes.filter(write => write.kind === 'execution');
  assert.ok(replies.length > 0);
  assert.ok(replies.every(write => write.status.assignmentId === current.assignmentId && write.status.phase === 'running'));
});

for (const stage of ['source', 'environment', 'admitted', 'denied']) {
  test(`pausing acceptance while awaiting ${stage} rejects without a claim and releases any acquired lease`, async t => {
    const root = await temporary(t), object = request(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const offered = { spec: { labels: [] }, status: { accepting: true, detectedLabels: ['linux'] } };
    const wait = async value => { entered.resolve(); await resume.promise; return value; };
    const fixture = engine(root, { offered: () => offered,
      sources: { resolve: () => stage === 'source' ? wait(null) : Promise.resolve(null) },
      environment: () => stage === 'environment' ? wait({}) : Promise.resolve({}),
    });
    let acquired = 0;
    fixture.coda.resources.acquire = async () => {
      acquired++;
      const result = stage === 'denied' ? { admitted: false } : { admitted: true, lease: 'lease', slot: 0 };
      return ['admitted', 'denied'].includes(stage) ? wait(result) : result;
    };
    const pending = fixture.host.observe({ type: 'ADDED', id: object.id, object });
    await entered.promise; offered.status.accepting = false; resume.resolve(); await pending;
    assert.equal(fixture.launches.length, 0);
    assert.deepEqual(fixture.host.journal.list(), []);
    assert.equal(acquired, ['admitted', 'denied'].includes(stage) ? 1 : 0);
    assert.deepEqual(fixture.released, stage === 'admitted' ? ['lease'] : []);
    const status = fixture.writes.at(-1).status;
    assert.equal(status.phase, 'finished'); assert.equal(status.outcome, 'rejected');
    assert.equal(status.reason.code, 'not_accepting');
  });
}

test('snapshot source identity is scoped to its provider endpoint, not the holder-local source ID', async () => {
  const locations = { snap: 'http://localhost:1/a/', wrong: 'http://localhost:1/b/', right: 'http://localhost:1/a/' };
  const sources = new Sources({ protocols: { resolve: async ref => ({ resource: { kind: ref.kind, id: ref.id === 'snap' ? 'snapshot' : 'same-id' }, url: locations[ref.id], headers: { authorization: 'Bearer test' } }) } });
  sources.objects.set('sourceSnapshot/snap', { kind: 'sourceSnapshot', id: 'snap', spec: { source: 'same-id' }, status: { ready: true, commit: 'a'.repeat(40), ref: 'refs/coda/snapshots/a' } });
  for (const id of ['wrong', 'right']) sources.objects.set(`gitSource/${id}`, { kind: 'gitSource', id, instance: `${id}-instance`, status: { ready: true } });
  const resolved = await sources.resolve({ snapshot: { kind: 'sourceSnapshot', id: 'snap' } });
  assert.equal(resolved.key, JSON.stringify(['right', 'right-instance'])); assert.equal(resolved.url, 'http://localhost:1/a/repos/same-id');
  assert.equal(resolved.headers.authorization, 'Bearer test');
});

test('outputs support multiline values and reject malformed or excessive results', () => {
  assert.deepEqual({ ...outputs('one=yes\ntwo<<END\na\nb\nEND\n') }, { one: 'yes', two: 'a\nb' });
  assert.throws(() => outputs('two<<END\nmissing'), /结束标记/);
  assert.throws(() => outputs(`one=${'x'.repeat(4097)}`), /限制/);
});
