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
import { Journal } from '../../../plugins/host/lib/journal.mjs';
import { Executions, RUN, runStatus } from '../../../plugins/host/lib/executions.mjs';
import { Sources } from '../../../plugins/host/lib/source.mjs';
import { outputs } from '../../../plugins/host/lib/results.mjs';

const exec = promisify(execFile);
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'host-executor-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const input = (patch = {}) => ({ source: null, requirements: { labels: ['linux'] }, resources: { slots: 1 }, exclusiveResources: [],
  task: { command: 'true', args: [] }, env: {}, ...patch });
const run = (id = 'job') => ({ kind: RUN, id, revision: 'r1', status: { state: 'working' } });

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
  const result = await executeHooks({ root, directory: root, attempt: 'a', source: null, slot: 0, spec: input(), env: {}, signal: controller.signal,
    checkpoint: async () => {}, hook: async value => {
      calls.push(value.command);
      if (value.command === 'prepare_job') return { code: 1, answer: { state: { workspace: root } } };
      assert.deepEqual(value.state, { workspace: root }); return { code: 0 };
    } });
  assert.deepEqual(calls, ['prepare_job', 'cleanup_job']); assert.equal(result.outcome, 'failed');
  calls.length = 0;
  const cancelled = await executeHooks({ root, directory: root, attempt: 'a', source: null, slot: 0, spec: input(), env: {}, signal: controller.signal,
    checkpoint: async patch => { if (patch.phase === 'running') controller.abort(); }, hook: async value => {
      calls.push(value.command);
      if (value.command === 'prepare_job') return { code: 0, answer: { state: { workspace: root } } };
      if (value.command === 'cleanup_job') assert.equal(value.signal.aborted, false);
      return { code: 143, aborted: value.command === 'run_script_step' };
    } });
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(calls.at(-1), 'cleanup_job');
});

test('real three-part hook runs commands in isolation and returns the command exit code and declared outputs', async t => {
  const root = await temporary(t), directory = join(root, 'attempt');
  const spec = input({ task: { script: 'printf "hello=%s\\n" "$DECLARED" >> "$GITHUB_OUTPUT"\nprintf "%s" "${SHOULD_NOT_LEAK-absent}"\nexit 7', shell: 'sh' }, env: { DECLARED: 'yes' } });
  const result = await executeHooks({ root, directory, attempt: 'attempt', source: null, slot: 0, spec,
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
    setStatus: async (kind, id, status, revision) => { writes.push({ kind, id, status, revision }); return { kind, id, status, revision: 'r2' }; },
  } };
  const host = new Executions({ coda, root, sources: { resolve: async () => null }, offered: () => ({
    spec: { labels: [] }, status: { accepting: true, detectedLabels: ['linux'] },
  }), environment: async () => ({}), launch: async value => launches.push(value), control: async (record, action) => { cancels.push(action); return true; }, ...changes });
  host.runs = runs;
  const offer = (object = run()) => { runs.set(object.id, object); return object; };
  return { host, coda, writes, released, launches, cancels, runs, offer };
}
const flush = async fixture => { while (fixture.host.busy.size) await Promise.all([...fixture.host.busy.values()]); };

test('execute starts once, reports progress, and restart never reruns the durable run', async t => {
  const root = await temporary(t), first = engine(root), object = run();
  first.offer(object); first.host.execute(object, input());
  first.host.execute(object, input()); await flush(first);
  assert.equal(first.launches.length, 1);
  const record = first.host.journal.list()[0]; record.control = { port: 1, token: 't' }; record.phase = 'running'; first.host.journal.save(record);
  await first.host.tick();
  assert.equal(first.writes.at(-1).status.progress, '运行中');
  const restart = engine(root);
  restart.offer(object); restart.host.execute(object, input()); await flush(restart);
  assert.equal(restart.launches.length, 0);
});

test('completed, failed and canceled results are written on the run exactly once', async t => {
  const root = await temporary(t), fixture = engine(root), object = run();
  fixture.offer(object); fixture.host.execute(object, input()); await flush(fixture);
  const record = fixture.host.journal.list()[0];
  record.phase = 'finished';
  record.result = { outcome: 'succeeded', exitCode: 0, outputTail: 'done', summary: 'ok', outputs: { answer: 'yes' }, finishedAt: new Date().toISOString() };
  fixture.host.journal.save(record); await fixture.host.tick();
  assert.deepEqual(fixture.writes.at(-1).status, { state: 'completed', result: { exitCode: 0, output: 'done', summary: 'ok', outputs: { answer: 'yes' } } });
  const count = fixture.writes.length; await fixture.host.tick(); assert.equal(fixture.writes.length, count, 'terminal status is never written again');
  assert.deepEqual(fixture.released, ['lease']);
  assert.equal(runStatus({ ...record, result: { outcome: 'failed', exitCode: 7, reason: { message: 'bad' } } }).result.message, 'bad');
  assert.deepEqual(runStatus({ ...record, result: { outcome: 'cancelled' } }), { state: 'canceled' });
});

test('cancel asks the worker to stop and a cancellation during source resolution prevents admission', async t => {
  const root = await temporary(t), object = run(); let resolveSource, looked;
  const ready = new Promise(resolve => { looked = resolve; });
  const source = new Promise(resolve => { resolveSource = resolve; });
  const fixture = engine(root, { sources: { resolve: () => { looked(); return source; } } });
  let acquired = 0; fixture.coda.resources.acquire = async () => { acquired++; return { admitted: false }; };
  fixture.offer(object); fixture.host.execute(object, input());
  await ready; await fixture.host.cancel(object.id);
  resolveSource(null); await flush(fixture);
  assert.equal(acquired, 0); assert.equal(fixture.launches.length, 0);
  assert.equal(fixture.writes.at(-1).status.state, 'canceled');

  const running = run('running'); fixture.offer(running); fixture.host.execute(running, input()); await flush(fixture);
  const record = fixture.host.journal.list().find(record => record.runId === running.id);
  record.phase = 'running'; record.control = { port: 1, token: 't' }; fixture.host.journal.save(record);
  await fixture.host.cancel(running.id);
  assert.ok(fixture.cancels.includes('cancel'));
});

test('slots are admitted through the host ledger; no slot waits instead of launching', async t => {
  const root = await temporary(t), object = run(), fixture = engine(root);
  let admitted = false;
  fixture.coda.resources.acquire = async () => admitted ? { admitted: true, lease: 'lease', slot: 0 } : { admitted: false };
  fixture.offer(object); fixture.host.execute(object, input()); await flush(fixture);
  assert.equal(fixture.launches.length, 0);
  assert.equal(fixture.writes.at(-1).status.progress, '等待本机名额');
  admitted = true; await fixture.host.tick();
  assert.equal(fixture.launches.length, 1);
  assert.equal(fixture.released.length, 0);
});

test('snapshot source identity is scoped to its provider endpoint, not the holder-local source ID', async () => {
  const locations = { snap: 'http://localhost:1/a/', wrong: 'http://localhost:1/b/', right: 'http://localhost:1/a/' };
  const sources = new Sources({ protocols: { resolve: async ref => ({ resource: { kind: ref.kind, id: ref.id === 'snap' ? 'snapshot' : 'same-id' }, url: locations[ref.id], headers: { authorization: 'Bearer test' } }) } });
  sources.objects.set('git/snapshot@1/snap', { kind: 'git/snapshot@1', id: 'snap', spec: { source: 'same-id' }, status: { ready: true, commit: 'a'.repeat(40), ref: 'refs/coda/snapshots/a' } });
  for (const id of ['wrong', 'right']) sources.objects.set(`git/source@1/${id}`, { kind: 'git/source@1', id, instance: `${id}-instance`, status: { ready: true } });
  const resolved = await sources.resolve({ snapshot: { kind: 'git/snapshot@1', id: 'snap' } });
  assert.equal(resolved.key, JSON.stringify(['right', 'right-instance'])); assert.equal(resolved.url, 'http://localhost:1/a/repos/same-id');
  assert.equal(resolved.headers.authorization, 'Bearer test');
});

test('outputs support multiline values and reject malformed or excessive results', () => {
  assert.deepEqual({ ...outputs('one=yes\ntwo<<END\na\nb\nEND\n') }, { one: 'yes', two: 'a\nb' });
  assert.throws(() => outputs('two<<END\nmissing'), /结束标记/);
  assert.throws(() => outputs(`one=${'x'.repeat(4097)}`), /限制/);
});
