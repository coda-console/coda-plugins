import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pointProblem } from '@coda-console/protocol/validate';
import { exec } from '../../../plugins/remote-exec/lib/exec.mjs';
import { HEAD, TAIL, openOutputs } from '../../../plugins/remote-exec/lib/output.mjs';
import { allGone, caller, coda, fakeSpawn, scratch, setup, waitFor } from './support.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../plugins/remote-exec/package.json', import.meta.url), 'utf8'));
const operation = manifest.contributes.protocols[0].operations.exec;
const record = { kind: 'remote-exec/machine@1', id: 'r-1', key: 'host' };
let serial = 0;

// 一次执行的 ctx；`id` 每次不同，临时目录的名字带它，所以能查有没有残留。
function context(t, spawnOptions, extra = {}) {
  const id = `exec-test-${process.pid}-${++serial}`, controller = new AbortController();
  return { ctx: { id, caller, record, signal: controller.signal, deadline: null, spawn: fakeSpawn(t, spawnOptions), ...extra }, id, controller };
}
const leftovers = id => readdirSync(tmpdir()).filter(name => name.startsWith(`coda-remote-exec-${id}-`));
const running = async (t, input, spawnOptions, extra) => {
  const host = setup(t), { ctx, id, controller } = context(t, spawnOptions, extra);
  return { host, ctx, id, controller, done: exec(host.env, input, ctx) };
};
const run = async (t, input, options, extra) => {
  const one = await running(t, input, options, extra);
  return { ...one, result: await one.done };
};

test('the output, the exit code and a result that fits the definition', async t => {
  const { result, host, id } = await run(t, { command: 'echo out; echo err >&2; exit 3' });
  assert.equal(pointProblem(operation.result, result, 'result'), null);
  assert.deepEqual({ ...result, ms: 0 }, { exitCode: 3, signal: null, stdout: 'out\n', stderr: 'err\n', timedOut: false, truncated: false, outputDir: null, ms: 0 });
  assert.deepEqual(leftovers(id), []);
  const [line] = host.lines();
  assert.equal(line.operation, 'exec');
  assert.equal(line.id, id);
});

test('a command ended by a signal has exitCode null and the signal name', async t => {
  const { result } = await run(t, { command: 'kill -KILL $$' });
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.timedOut, false);
});

test('stdin is written once and closed; with none the command sees an empty input; a command that never reads it is not a failure', async t => {
  assert.equal((await run(t, { command: 'cat', stdin: 'héllo\n' })).result.stdout, 'héllo\n');
  const none = (await run(t, { command: 'cat; echo done' })).result;
  assert.equal(none.stdout, 'done\n');
  const ignored = (await run(t, { command: 'true', stdin: 'x'.repeat(1024 * 1024) })).result;
  assert.equal(ignored.exitCode, 0);
});

test('without cwd the command runs in the default directory (the one in the record), with cwd where it says', async t => {
  const home = realpathSync(homedir()), dir = realpathSync(scratch(t));
  assert.equal((await run(t, { command: 'pwd -P' })).result.stdout, `${home}\n`);
  assert.equal((await run(t, { command: 'pwd -P', cwd: dir })).result.stdout, `${dir}\n`);
});

test('a cwd that is relative, missing or not a directory is refused before anything is run, with a code and effects none, and logged', async t => {
  const dir = scratch(t), file = join(dir, 'f');
  writeFileSync(file, '');
  const marker = join(dir, 'ran');
  for (const [cwd, code] of [['relative/dir', 'invalid_input'], [join(dir, 'missing'), 'not_found'], [file, 'not_a_directory']]) {
    const host = setup(t), { ctx, id } = context(t);
    await assert.rejects(exec(host.env, { command: `touch ${marker}`, cwd }, ctx), { code, effects: 'none' });
    assert.deepEqual(host.lines().map(line => [line.operation, line.error, line.params.cwd]), [['exec', code, cwd]]);
    assert.deepEqual(leftovers(id), []);
  }
  assert.equal(existsSync(marker), false);
});

test('with the switch off the command is not run, the refusal is `disabled`, and it is logged', async t => {
  const dir = scratch(t), marker = join(dir, 'ran'), host = setup(t, { enabled: false }), { ctx, id } = context(t);
  await assert.rejects(exec(host.env, { command: `touch ${marker}`, cwd: dir }, ctx), { code: 'disabled', effects: 'none' });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(leftovers(id), []);
  const [line] = host.lines();
  assert.equal(line.error, 'disabled');
  assert.deepEqual(line.caller, caller);
  assert.deepEqual(line.params, { command: `touch ${marker}`, cwd: dir });
  host.set(true);
  assert.equal((await exec(host.env, { command: 'echo on' }, context(t).ctx)).stdout, 'on\n');
});

test('the log line has the time, call id, the caller as it came, the command and directory, the exit status and the duration', async t => {
  const dir = scratch(t), { host, id } = await run(t, { command: 'exit 2', cwd: dir });
  const [line] = host.lines();
  assert.deepEqual(Object.keys(line).sort(), ['caller', 'id', 'ms', 'operation', 'params', 'result', 'time']);
  assert.equal(line.id, id);
  assert.deepEqual(line.caller, caller);
  assert.deepEqual(line.params, { command: 'exit 2', cwd: dir });
  assert.deepEqual(line.result, { exitCode: 2, signal: null, timedOut: false });
  assert.ok(Number.isInteger(line.ms) && line.ms >= 0);
  assert.ok(Math.abs(Date.parse(line.time) - Date.now()) < 60_000);
});

test('the plugin token is not visible to the command (and the fake does hand it to a process that is not protected)', async t => {
  const control = await fakeSpawn(t)('/bin/sh', ['-c', 'echo "[$CODA_TOKEN]"']);
  let seen = '';
  for await (const chunk of control.stdout) seen += chunk;
  assert.equal(seen, '[plugin-token-for-test]\n');
  const { result } = await run(t, { command: 'echo "[${CODA_TOKEN-unset}]"; env | grep -c CODA_TOKEN; echo "$PATH" | grep -c .' });
  assert.equal(result.stdout.split('\n')[0], '[unset]');
  assert.equal(result.stdout.split('\n')[1], '0');
});

test('output over the limit is cut to head and tail, the whole is in outputDir', async t => {
  const { result } = await run(t, { command: 'head -c 200000 /dev/zero | tr "\\0" a; echo err >&2' });
  t.after(() => rmSync(result.outputDir, { recursive: true, force: true }));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) < HEAD + TAIL + 300);
  assert.match(result.stdout, /省略了 \d+ 字节/);
  assert.equal(readFileSync(join(result.outputDir, 'stdout')).length, 200000);
  assert.equal(readFileSync(join(result.outputDir, 'stderr'), 'utf8'), 'err\n');
  assert.equal(result.stderr, 'err\n');
});

test('a command over its time limit has its whole process group ended, timedOut is true and the output so far comes back', async t => {
  const dir = scratch(t), pidFile = join(dir, 'pid');
  // 后台的 sleep 不拿输出管道，根一退出它还在：只有插件结束整个进程组它才会没。
  const { result, id } = await run(t, { command: `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; echo started; wait`, timeout: 1 }, { reap: false, ready: true });
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, 'started\n');
  assert.ok(result.ms >= 900 && result.ms < 30_000, `ms ${result.ms}`);
  assert.equal(result.truncated, false);
  await allGone([Number(readFileSync(pidFile, 'utf8'))]);
  assert.deepEqual(leftovers(id), []);
});

test('the earlier of the time limit and the deadline wins', async t => {
  const { result } = await run(t, { command: 'sleep 60 >/dev/null 2>&1 & echo go; wait', timeout: 600 }, { reap: false, ready: true }, { deadline: Date.now() + 1000 });
  assert.equal(result.timedOut, true);
  assert.ok(result.ms < 30_000);
});

test('when the call is aborted the group is ended, the output is dropped, a line is logged and the signal reason is thrown', async t => {
  const dir = scratch(t), pidFile = join(dir, 'pid'), command = `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; wait`;
  const { host, id, controller, done } = await running(t, { command }, { reap: false });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 'pid 文件');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const reason = new DOMException('cancelled by caller', 'AbortError');
  controller.abort(reason);
  await assert.rejects(done, error => error === reason);
  await allGone([pid]);
  assert.deepEqual(leftovers(id), []);
  assert.deepEqual(host.lines().map(line => [line.operation, line.error]), [['exec', 'cancelled']]);
});

test('an expired deadline from outside is logged as timeout and its error thrown', async t => {
  const { host, controller, done, ctx } = await running(t, { command: 'sleep 60 >/dev/null 2>&1 & echo hi; wait' }, { reap: false, ready: true });
  const reason = new DOMException('deadline', 'TimeoutError');
  controller.abort(reason);
  await assert.rejects(done, error => error === reason);
  assert.deepEqual(host.lines().map(line => line.error), ['timeout']);
  assert.equal(ctx.signal.aborted, true);
});

test('a call that is already aborted when it starts ends its process too', async t => {
  const host = setup(t), { ctx, controller } = context(t, { reap: false });
  const reason = new DOMException('early', 'AbortError');
  controller.abort(reason);
  await assert.rejects(exec(host.env, { command: 'sleep 60 >/dev/null 2>&1 & wait' }, ctx), error => error === reason);
});

test('a process that cannot be started: the error comes back as it is, the directory is gone, a line with the code is logged', async t => {
  const host = setup(t), { ctx, id } = context(t, undefined, { spawn: async () => { throw coda.error('spawn_failed', '起不来', { effects: 'none' }); } });
  await assert.rejects(exec(host.env, { command: 'echo' }, ctx), { code: 'spawn_failed', message: '起不来', effects: 'none' });
  assert.deepEqual(leftovers(id), []);
  assert.deepEqual(host.lines().map(line => line.error), ['spawn_failed']);
});

test('when the process channel breaks (`exited` fails) the process group is ended and the error thrown, the directory removed', async t => {
  const dir = scratch(t), pidFile = join(dir, 'pid'), real = fakeSpawn(t, { reap: false });
  const broken = Promise.withResolvers();
  const spawn = async (...args) => {
    const child = await real(...args);
    broken.promise.catch(() => {});
    return { ...child, exited: Promise.race([child.exited, broken.promise]) };
  };
  const { host, id, done } = await running(t, { command: `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; wait` }, undefined, { spawn });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 'pid 文件');
  broken.reject(coda.error('interrupted', '通道断了', { effects: 'unknown' }));
  await assert.rejects(done, { code: 'interrupted' });
  await allGone([Number(readFileSync(pidFile, 'utf8'))]);
  assert.deepEqual(leftovers(id), []);
  assert.deepEqual(host.lines().map(line => line.error), ['interrupted']);
});

test('output nobody wants is dropped with its directory, also when it was cut', async t => {
  const root = scratch(t), outputs = await openOutputs('drop', root);
  await outputs.stdout.write(Buffer.alloc(HEAD + TAIL + 1, 'a'));
  await outputs.discard();
  assert.deepEqual(readdirSync(root), []);
});

test('a cancel that arrives while the output is being wrapped up is not a success: the output is dropped, a cancel is logged, the reason thrown', async t => {
  const host = setup(t), { ctx, id, controller } = context(t), reason = new DOMException('late', 'AbortError');
  // 输出文件的关闭停在一个可控的点：`finish()` 开始之后才触发取消。
  const original = fsp.open, closing = Promise.withResolvers(), release = Promise.withResolvers();
  fsp.open = async (...args) => {
    const real = await original(...args);
    if (args[1] !== 'wx') return real;
    return new Proxy(real, { get: (target, key) => key === 'close' ? async () => { closing.resolve(); await release.promise; return target.close(); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.open = original; syncBuiltinESMExports(); });
  const done = exec(host.env, { command: 'head -c 100000 /dev/zero | tr "\\0" a' }, ctx);
  await closing.promise;
  controller.abort(reason);
  release.resolve();
  await assert.rejects(done, error => error === reason);
  assert.deepEqual(leftovers(id), []);
  assert.deepEqual(host.lines().map(line => [line.operation, line.error]), [['exec', 'cancelled']]);
});
