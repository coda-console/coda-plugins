// 发布前的几处收紧：执行环境只带白名单、输出落盘有上限并回收、推送有大小上限、同时在跑的执行有上限、操作记录先记后做。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_FILE } from '../../../plugins/remote-exec/lib/audit.mjs';
import { cleanEnv, FALLBACK_PATH, shellArgs } from '../../../plugins/remote-exec/lib/environ.mjs';
import { exec, runningCount } from '../../../plugins/remote-exec/lib/exec.mjs';
import { push } from '../../../plugins/remote-exec/lib/files.mjs';
import { HEAD, PREFIX, TAIL, openOutputs, sweepOutputs } from '../../../plugins/remote-exec/lib/output.mjs';
import { caller, fakeSpawn, scratch, setup, waitFor } from './support.mjs';

const record = { kind: 'remote-exec/machine@1', id: 'r-1', key: 'host' };
let serial = 0;
function context(t, spawnOptions) {
  const id = `hardening-${process.pid}-${++serial}`, controller = new AbortController();
  return { ctx: { id, caller, record, signal: controller.signal, deadline: null, spawn: fakeSpawn(t, spawnOptions) }, id, controller };
}

// ——— 1. 执行环境 ———

test('the environment of a command is built from a whitelist only: PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_*, TMPDIR, TZ; nothing that starts with CODA_', () => {
  const source = {
    PATH: '/opt/bin:/usr/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', LC_ALL: 'C', LC_TIME: 'en_US',
    TMPDIR: '/tmp/u', TZ: 'Asia/Shanghai', AWS_SECRET_ACCESS_KEY: 'aws', NPM_TOKEN: 'npm', CODA_TOKEN: 'tok', CODA_PLUGIN_STATE: '/state', CODA_LC_X: 'x',
  };
  assert.deepEqual(cleanEnv(source, { username: 'u', homedir: '/home/u', shell: '/bin/zsh' }), {
    PATH: '/opt/bin:/usr/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', LC_ALL: 'C', LC_TIME: 'en_US', TMPDIR: '/tmp/u', TZ: 'Asia/Shanghai',
  });
  // 缺的几项按系统用户补上，和登录时一样；PATH 没有就用一份默认的。
  assert.deepEqual(cleanEnv({}, { username: 'v', homedir: '/home/v', shell: '/bin/sh' }), { HOME: '/home/v', USER: 'v', LOGNAME: 'v', SHELL: '/bin/sh', PATH: FALLBACK_PATH });
  // 交给 spawn 的是 `env -i` 加一项项的赋值，再 exec 成 /bin/sh -c：值原样作参数，不经 shell。
  assert.deepEqual(shellArgs('echo $A', { A: 'x y;$(z)' }), ['/usr/bin/env', ['-i', 'A=x y;$(z)', '/bin/sh', '-c', 'echo $A']]);
});

test('a command sees none of the backend environment outside the whitelist: neither a synthetic variable, a synthetic token nor anything CODA_', async t => {
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, { REMOTE_EXEC_SYNTHETIC: 'synthetic-value', GITHUB_TOKEN: 'synthetic-token-123', CODA_PLUGIN_STATE: '/synthetic/state', LC_SYNTH: 'kept' });
  const host = setup(t), { ctx } = context(t);
  const result = await exec(host.env, { command: 'env' }, ctx);
  assert.equal(result.exitCode, 0);
  const seen = Object.fromEntries(result.stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const key of ['REMOTE_EXEC_SYNTHETIC', 'GITHUB_TOKEN', 'CODA_PLUGIN_STATE', 'CODA_TOKEN']) assert.equal(key in seen, false, key);
  assert.ok(!result.stdout.includes('synthetic-token-123') && !result.stdout.includes('synthetic-value') && !result.stdout.includes('plugin-token-for-test'));
  assert.equal(seen.LC_SYNTH, 'kept');
  assert.equal(seen.HOME, process.env.HOME);
  assert.ok(Object.keys(seen).every(key => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TZ', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(key) || key.startsWith('LC_')), Object.keys(seen).join(','));
});

// ——— 2. 输出落盘的上限与回收 ———

test('each stream stores at most its cap on disk; beyond it the result says the stored output is cut too, and how much was kept', async t => {
  const root = scratch(t), outputs = await openOutputs('cap-1', root, { cap: 1000 });
  for (let i = 0; i < 5; i++) await outputs.stdout.write(Buffer.alloc(HEAD + TAIL, 'a'));
  const done = await outputs.finish();
  assert.equal(done.truncated, true);
  assert.equal(statSync(join(done.outputDir, 'stdout')).size, 1000);
  assert.match(done.stdout, /落盘也截断了：.*只存了前 1000 字节（共 \d+ 字节）/);
  // 没到上限的那一路照旧是完整输出。
  const whole = await openOutputs('cap-2', root, { cap: 10 * (HEAD + TAIL) });
  await whole.stdout.write(Buffer.alloc(2 * (HEAD + TAIL), 'b'));
  const kept = await whole.finish();
  assert.equal(statSync(join(kept.outputDir, 'stdout')).size, 2 * (HEAD + TAIL));
  assert.match(kept.stdout, /完整输出在 /);
});

test('left-over output directories are swept: older than the keep time, then oldest first while the total is over the cap; the ones in use, other names and links are left alone', async t => {
  const root = scratch(t), now = Date.now(), make = (name, bytes, age) => {
    const dir = join(root, `${PREFIX}${name}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'stdout'), Buffer.alloc(bytes));
    writeFileSync(join(dir, 'stderr'), '');
    const when = (now - age) / 1000;
    utimesSync(dir, when, when);
    return dir;
  };
  const old = make('old', 1, 10_000), a = make('a', 400, 3000), b = make('b', 400, 2000), inUse = make('in-use', 400, 4000), c = make('c', 400, 1000);
  mkdirSync(join(root, 'someone-else'));
  const removed = await sweepOutputs(root, { now, keepMs: 5000, keepTotal: 900, active: new Set([inUse]) });
  // old 超时删掉；剩下 a、b、c 合计 1200 > 900，从最旧的 a 删起，删到不超为止。
  assert.deepEqual(removed.sort(), [a, old].sort());
  for (const dir of [b, c, inUse]) assert.ok(existsSync(dir), dir);
  assert.ok(existsSync(join(root, 'someone-else')));
  // 不在的根目录不抛，只说一声。
  const warned = [];
  assert.deepEqual(await sweepOutputs(join(root, 'missing'), { warn: message => warned.push(message) }), []);
  assert.equal(warned.length, 1);
});

// ——— 3. 推送的大小上限 ———

test('push: a body over the size cap is refused with too_large, effects none; the temporary file is gone and the original is untouched; a declared length over the cap is refused before reading', async t => {
  const dir = scratch(t), path = join(dir, 'f');
  writeFileSync(path, 'original');
  const host = setup(t);
  host.env.maxPush = 10;
  const send = (body, headers) => push(host.env, new Request('http://stream/', { method: 'POST', body, duplex: 'half', headers }), { caller, record, input: { path }, signal: new AbortController().signal });
  // 一块一块来的，过了上限就停。
  let pulled = 0;
  const chunks = new ReadableStream({ pull(c) { if (++pulled > 10) c.close(); else c.enqueue(Buffer.from('123456')); } });
  await assert.rejects(send(chunks), { code: 'too_large', effects: 'none' });
  assert.ok(pulled <= 3, `过了上限还在读：${pulled}`);
  assert.equal(readFileSync(path, 'utf8'), 'original');
  assert.deepEqual(readdirSync(dir), ['f']);
  await assert.rejects(send('12345678901', { 'content-length': '11' }), { code: 'too_large', effects: 'none' });
  assert.deepEqual(host.lines().map(line => line.error), ['too_large', 'too_large']);
  // 正好在上限上的照常写。
  const response = await send('1234567890');
  assert.deepEqual(await response.json(), { path, size: 10 });
});

// ——— 5. 操作记录先记后做 ———

test('the start line is on disk before the command runs, and the start and the end share one op', async t => {
  const host = setup(t), { ctx } = context(t), file = join(host.state, AUDIT_FILE);
  const result = await exec(host.env, { command: `cat '${file}'` }, ctx);
  const before = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(before.length, 1);
  assert.equal(before[0].phase, 'start');
  assert.equal(before[0].id, ctx.id);
  assert.deepEqual(before[0].caller, caller);
  assert.equal(before[0].params.command, `cat '${file}'`);
  const raw = host.raw();
  assert.deepEqual(raw.map(line => line.phase), ['start', 'end']);
  assert.equal(raw[0].op, raw[1].op);
  assert.equal(typeof raw[0].op, 'string');
  assert.deepEqual(raw[1].result, { exitCode: 0, signal: null, timedOut: false });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a refusal by the switch is logged as a start and an end too, with the refusal code', async t => {
  const host = setup(t, { enabled: false }), { ctx } = context(t);
  await assert.rejects(exec(host.env, { command: 'true' }, ctx), { code: 'disabled' });
  assert.deepEqual(host.raw().map(line => [line.phase, line.error]), [['start', undefined], ['end', 'disabled']]);
});

// ——— 6. 同时在跑的执行 ———

test('executions over the concurrency cap are refused with too_many_running, effects none, and logged; the slot is free again once one ends', async t => {
  const host = setup(t);
  host.env.maxRunning = 1;
  const first = context(t, { ready: true }), done = exec(host.env, { command: 'echo up; sleep 30' }, first.ctx);
  await waitFor(() => runningCount() === 1, '第一个在跑');
  const second = context(t);
  await assert.rejects(exec(host.env, { command: 'true' }, second.ctx), { code: 'too_many_running', effects: 'none' });
  first.controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(done, { name: 'AbortError' });
  assert.equal(runningCount(), 0);
  const third = context(t);
  assert.equal((await exec(host.env, { command: 'true' }, third.ctx)).exitCode, 0);
  assert.deepEqual(host.lines().map(line => line.error ?? 'ok'), ['cancelled', 'too_many_running', 'ok']);
});
