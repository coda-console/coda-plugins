import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { definitionProblem, ownedProtocolsProblem } from '@coda-console/protocol/protocol';
import { manifestProblem } from '@coda-console/protocol/validate';
import { createMockCoda, TEST_OWNER } from '../../helpers/mock-coda.mjs';
import { pluginDir } from '../plugin.mjs';
import { waitFor } from './support.mjs';
import { activate, deactivate } from '../../../plugins/remote-exec/main.mjs';
import { KEY, LOCAL_MACHINE, MACHINE, SETTING } from '../../../plugins/remote-exec/lib/definitions.mjs';
import { admit, decide } from '../../../plugins/remote-exec/lib/gate.mjs';
import { AUDIT_FILE, auditLine, createAuditLog } from '../../../plugins/remote-exec/lib/audit.mjs';
import { HEAD, TAIL, openOutputs, writeAll } from '../../../plugins/remote-exec/lib/output.mjs';
import { DEFAULT_TIMEOUT, MAX_TIMEOUT, timeLimit } from '../../../plugins/remote-exec/lib/limits.mjs';
import { terminate } from '../../../plugins/remote-exec/lib/kill.mjs';
import { hostSpec, osName, prettyName } from '../../../plugins/remote-exec/lib/host.mjs';

const dir = pluginDir('remote-exec');
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const [definition] = manifest.contributes.protocols;
const scratch = t => {
  const path = mkdtempSync(join(tmpdir(), 'remote-exec-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

// ——— 清单 ———

test('manifest and definition pass the protocol checks, and the machine is a resource named by a required string column', () => {
  assert.equal(manifestProblem(manifest, dir), null);
  assert.equal(definitionProblem(definition, { namespace: 'remote-exec', where: definition.name }), null);
  assert.equal(ownedProtocolsProblem(manifest), null);
  assert.deepEqual(manifest.contributes.protocolImplementations, [MACHINE]);
  assert.equal(definition.name, MACHINE);
  const [first] = definition.resource.columns, field = definition.spec.properties[first];
  assert.ok(definition.spec.required.includes(first));
  assert.equal(field.type, 'string');
  assert.ok(field.minLength >= 1);
  assert.deepEqual(definition.resource.columns, ['name', 'os', 'user', 'cwd']);
  assert.equal(definition.spec.additionalProperties, false);
  assert.ok(definition.title && definition.description);
  assert.deepEqual(manifest.uses, { 'coda/machine@1': ['read'] });
  assert.ok(manifest.engines.coda >= 15);
});

test('exec is an operation that does things, and the three paths are in one group open to sessions', () => {
  const exec = definition.operations.exec;
  assert.equal(exec.safe, undefined);
  assert.equal(exec.idempotent, undefined);
  assert.ok(exec.timeout > MAX_TIMEOUT);
  assert.deepEqual(Object.keys(definition.operations), ['exec']);
  assert.equal(definition.streams.pull.shape, 'read');
  assert.equal(definition.streams.push.shape, 'write');
  const groups = Object.values(definition.permissions);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions, true);
  assert.deepEqual(groups[0].operations, ['exec']);
  assert.deepEqual(groups[0].streams, ['pull', 'push']);
});

test('inputs have no target and no combinator at the root, no mcpServers, and tool names stay short', () => {
  const inputs = [definition.operations.exec.input, definition.streams.pull.input, definition.streams.push.input];
  for (const input of inputs) {
    for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(input[key], undefined);
    assert.equal(input.properties.target, undefined);
    assert.equal(input.additionalProperties, false);
  }
  assert.equal(manifest.contributes.mcpServers, undefined);
  const [namespace, rest] = MACHINE.split('/'), protocol = rest.split('@')[0];
  for (const name of [...Object.keys(definition.operations), ...Object.keys(definition.streams)]) {
    const tool = `${namespace}_${protocol}_${name}`;
    assert.match(tool, /^[A-Za-z0-9_-]+$/);
    assert.ok(`mcp__coda__${tool}`.length <= 64);
  }
  assert.deepEqual(definition.streams.pull.input.required, ['path']);
  for (const name of ['offset', 'length']) assert.equal(definition.streams.pull.input.properties[name].pattern, '^[0-9]+$');
  assert.deepEqual(definition.operations.exec.input.required, ['command']);
  const setting = manifest.contributes.configuration.properties[SETTING];
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false);
});

// ——— 开关与记录 ———

async function start(t, { settings = {}, name = 'xiaomi' } = {}) {
  const host = createMockCoda({ plugin: { id: 'remote-exec', protocols: manifest.contributes.protocols }, settings });
  if (name) await host.coda.put({ kind: LOCAL_MACHINE, key: 'machine' }, { spec: { name } });
  await activate(host.coda);
  t.after(() => { deactivate(); host.close(); });
  await settle();
  return host;
}
const records = host => host.coda.list(MACHINE, { scope: 'local' });

test('with the switch off (the default) no record is registered; turning it on registers one, turning it off takes it away', async t => {
  const host = await start(t);
  assert.deepEqual(await records(host), []);
  await host.setSettings({ [SETTING]: true });
  await settle();
  const [one, ...others] = await records(host);
  assert.equal(others.length, 0);
  assert.equal(one.key, KEY);
  assert.equal(one.spec.name, 'xiaomi');
  assert.deepEqual(Object.keys(one.spec).sort(), ['cwd', 'name', 'os', 'user']);
  assert.deepEqual(one.status, { available: true });
  await host.setSettings({ [SETTING]: false });
  await settle();
  assert.deepEqual(await records(host), []);
});

test('with the switch on at startup the record is there, and it is the machine record\'s name that follows a rename', async t => {
  const host = await start(t, { settings: { [SETTING]: true } });
  assert.equal((await records(host))[0].spec.name, 'xiaomi');
  await host.coda.put({ kind: LOCAL_MACHINE, key: 'machine' }, { spec: { name: 'renamed' } });
  await settle();
  const after = await records(host);
  assert.equal(after.length, 1);
  assert.equal(after[0].spec.name, 'renamed');
});

test('a notification that arrives while the settings are being read wins over the older snapshot', async t => {
  const host = createMockCoda({ plugin: { id: 'remote-exec', protocols: manifest.contributes.protocols }, settings: {} });
  t.after(() => { deactivate(); host.close(); });
  let answer;
  host.coda.settings.get = () => new Promise(resolve => { answer = resolve; });
  const started = activate(host.coda);
  await settle();
  await host.setSettings({ [SETTING]: false });
  answer({ [SETTING]: true });
  await started;
  await settle();
  assert.deepEqual(await records(host), []);
});

test('without a machine record the host name is used; a record that cannot be written is reported, not swallowed', async t => {
  const host = await start(t, { settings: { [SETTING]: true }, name: null });
  assert.equal((await records(host))[0].spec.name, hostSpec(null).name);
  const failing = createMockCoda({ plugin: { id: 'remote-exec', protocols: manifest.contributes.protocols }, settings: { [SETTING]: true } });
  failing.coda.replace = async () => { throw new Error('目录库写不进'); };
  await assert.rejects(activate(failing.coda), /目录库写不进/);
  deactivate();
  failing.close();
});

test('the spec is the environment of the process on this machine: user, home directory and the distribution name', () => {
  const spec = hostSpec('box');
  assert.equal(spec.name, 'box');
  assert.equal(spec.user, userInfo().username);
  assert.equal(spec.cwd, homedir());
  assert.equal(prettyName('NAME=Debian\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n'), 'Debian GNU/Linux 12 (bookworm)');
  assert.equal(prettyName("PRETTY_NAME='Alpine \\\"x\\\"'\n"), 'Alpine "x"');
  assert.equal(prettyName('NAME=x\n'), null);
  assert.equal(osName({ platform: 'linux', read: () => 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' }), 'Debian GNU/Linux 12 (bookworm)');
  const generic = osName({ platform: 'darwin' });
  assert.equal(osName({ platform: 'linux', read: () => { throw new Error('no file'); } }), generic);
  assert.equal(osName({ platform: 'linux', read: () => 'NAME=x\n' }), generic);
  assert.match(generic, /\S+ \S+/);
});

// ——— 开关检查与判定点 ———

const coda = { error: (code, message, { effects } = {}) => Object.assign(new Error(message), { code, effects }) };
const caller = { machine: 'm-1', plugin: 'other', parent: { kind: 'coda/thread@1', id: 't-1' }, future: 1 };

test('when the switch is off every operation is refused with `disabled` and nothing done', () => {
  for (const operation of ['exec', 'pull', 'push']) {
    assert.throws(() => admit(coda, { enabled: false, operation, content: {}, caller, record: null }), { code: 'disabled', effects: 'none' });
  }
});

test('the decision point lets everything through and gets the operation, its content, the caller as given and the record', () => {
  const request = { operation: 'exec', content: { command: 'rm -rf x', cwd: '/tmp', timeout: 5, stdin: 'y' }, caller, record: { kind: MACHINE, id: 'r-1', key: KEY } };
  assert.deepEqual(decide(request), { allow: true });
  assert.doesNotThrow(() => admit(coda, { enabled: true, ...request }));
});

test('the order is switch, decision point: a refusal from the decision point keeps its code, and it is not asked when the switch is off', () => {
  const asked = [], refuse = request => { asked.push(request); return { allow: false, code: 'not_allowed', reason: '不许' }; };
  const request = { operation: 'push', content: { path: '/etc/passwd' }, caller, record: { kind: MACHINE, id: 'r-1' } };
  assert.throws(() => admit(coda, { enabled: true, ...request }, refuse), { code: 'not_allowed', message: '不许', effects: 'none' });
  assert.deepEqual(asked, [request]);
  assert.throws(() => admit(coda, { enabled: false, ...request }, refuse), { code: 'disabled' });
  assert.equal(asked.length, 1);
});

// ——— 操作记录 ———

test('a log line has time, call id, the caller as it came (unknown fields too), operation, params, result and duration', () => {
  const line = auditLine({ time: new Date('2026-11-24T01:02:03.456Z'), id: 'call-1', caller, operation: 'exec',
    params: { command: 'ls -l', cwd: '/srv' }, result: { exitCode: 0, signal: null, timedOut: false }, ms: 12 });
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line), { time: '2026-11-24T01:02:03.456Z', id: 'call-1', caller, operation: 'exec',
    params: { command: 'ls -l', cwd: '/srv' }, result: { exitCode: 0, signal: null, timedOut: false }, ms: 12 });
});

test('a stream has no call id, a refused operation has an error code and is logged too', () => {
  const pull = JSON.parse(auditLine({ caller, operation: 'pull', params: { path: '/etc/hosts', offset: '0', length: '10' }, result: { bytes: 10 }, ms: 3 }));
  assert.equal('id' in pull, false);
  assert.deepEqual(pull.result, { bytes: 10 });
  const refused = JSON.parse(auditLine({ id: 'call-2', caller, operation: 'exec', params: { command: 'x' }, error: 'disabled', ms: 0 }));
  assert.equal(refused.error, 'disabled');
  assert.equal('result' in refused, false);
});

test('lines are appended to a file in the state directory, one after another', async t => {
  const state = join(scratch(t), 'state'), log = createAuditLog(state);
  await log.write(auditLine({ id: 'a', caller, operation: 'exec', params: { command: '1' }, result: {}, ms: 1 }));
  await log.write(auditLine({ id: 'b', caller, operation: 'exec', params: { command: '2' }, error: 'disabled', ms: 2 }));
  const lines = readFileSync(join(state, AUDIT_FILE), 'utf8').split('\n');
  assert.equal(lines.at(-1), '');
  assert.deepEqual(lines.slice(0, -1).map(line => JSON.parse(line).id), ['a', 'b']);
  await createAuditLog(state).write(auditLine({ id: 'c', caller, operation: 'push', params: {}, result: { bytes: 1 }, ms: 1 }));
  assert.equal(readFileSync(join(state, AUDIT_FILE), 'utf8').trim().split('\n').length, 3);
});

test('lines written at the same time stay whole lines, and a failed write does not hold up the next', async t => {
  const state = scratch(t), log = createAuditLog(state);
  const long = tag => auditLine({ id: tag, caller, operation: 'exec', params: { command: `${tag}${'x'.repeat(1.2 * 1024 * 1024)}` }, result: {}, ms: 1 });
  await Promise.all([log.write(long('a')), log.write(long('b')), log.write(long('c'))]);
  const lines = readFileSync(join(state, AUDIT_FILE), 'utf8').split('\n').slice(0, -1);
  assert.deepEqual(lines.map(line => JSON.parse(line).id), ['a', 'b', 'c']);
  const broken = scratch(t), warned = [], again = createAuditLog(broken, { warn: message => warned.push(message) });
  mkdirSync(join(broken, AUDIT_FILE));
  await Promise.all([again.write('x'), again.write('y')]);
  assert.equal(warned.length, 2);
  rmSync(join(broken, AUDIT_FILE), { recursive: true });
  await again.write('{"id":"z"}');
  assert.equal(readFileSync(join(broken, AUDIT_FILE), 'utf8'), '{"id":"z"}\n');
});

test('without a state directory nothing is logged and standard error says so once; a failing write is reported, not thrown', async t => {
  const said = [], log = createAuditLog(null, { warn: message => said.push(message) });
  await log.write('x'); await log.write('y');
  assert.equal(said.length, 1);
  // A file where the state directory should be.
  const blocked = join(scratch(t), 'file'), warned = [];
  writeFileSync(blocked, '');
  await createAuditLog(join(blocked, 'state'), { warn: message => warned.push(message) }).write('z');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /写不进/);
  // 操作之后写不进去，标准错误里说明是哪次调用。
  const labelled = [];
  await createAuditLog(join(blocked, 'state'), { warn: message => labelled.push(message) }).write('z', 'exec call-9 /srv');
  assert.match(labelled[0], /exec call-9 \/srv/);
});

test('ready() says whether the log can be written before anything is done: no state directory, a state directory that cannot be made, a log file that cannot be opened; and it writes no line', async t => {
  const root = scratch(t), blocked = join(root, 'file'), asDirectory = join(root, 'dir'), good = join(root, 'good', 'state');
  writeFileSync(blocked, '');
  mkdirSync(join(asDirectory, AUDIT_FILE), { recursive: true });
  for (const state of [null, join(blocked, 'state'), asDirectory]) await assert.rejects(createAuditLog(state).ready(), /./);
  await createAuditLog(good).ready();
  assert.equal(readFileSync(join(good, AUDIT_FILE), 'utf8'), '');
});

// ——— 输出截短 ———

async function collect(t, stdout, stderr = Buffer.alloc(0), chunk = 7919) {
  const root = scratch(t), outputs = await openOutputs('call:1/x', root);
  for (const [sink, data] of [[outputs.stdout, stdout], [outputs.stderr, stderr]]) {
    for (let at = 0; at < data.length; at += chunk) await sink.write(data.subarray(at, at + chunk));
  }
  return { root, ...(await outputs.finish()) };
}

test('output within the limit comes back as it is and the temporary files are gone', async t => {
  const done = await collect(t, Buffer.from('hello\n'), Buffer.from('warn\n'));
  assert.equal(done.stdout, 'hello\n');
  assert.equal(done.stderr, 'warn\n');
  assert.equal(done.truncated, false);
  assert.equal(done.outputDir, null);
  assert.deepEqual(readdirSync(done.root), []);
  const edge = await collect(t, Buffer.alloc(HEAD + TAIL, 'a'));
  assert.equal(edge.truncated, false);
  assert.equal(edge.stdout.length, HEAD + TAIL);
});

test('output over the limit keeps head and tail with a line saying how much is left out and where the whole is; the files stay', async t => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}\n`).join(''), whole = Buffer.from(lines);
  const done = await collect(t, whole, Buffer.from('err\n'));
  assert.equal(done.truncated, true);
  assert.equal(done.stderr, 'err\n');
  assert.ok(done.stdout.startsWith(lines.slice(0, 1000)));
  assert.ok(done.stdout.endsWith(lines.slice(-1000)));
  const omitted = Number(/省略了 (\d+) 字节/.exec(done.stdout)[1]);
  const kept = Buffer.byteLength(done.stdout.replace(/\n\[… 省略了[^\n]*…\]\n/, ''));
  assert.equal(kept + omitted, whole.length);
  assert.ok(done.stdout.includes(join(done.outputDir, 'stdout')));
  assert.ok(Buffer.byteLength(done.stdout) < HEAD + TAIL + 200);
  assert.deepEqual(readFileSync(join(done.outputDir, 'stdout')), whole);
  assert.equal(readFileSync(join(done.outputDir, 'stderr'), 'utf8'), 'err\n');
});

test('a UTF-8 character is never cut in two at either end of the kept parts', async t => {
  for (const prefix of ['', 'a', 'ab', 'abc']) {
    const text = `${prefix}${'好'.repeat(20000)}`;
    const done = await collect(t, Buffer.from(text), Buffer.alloc(0), 1001);
    assert.equal(done.truncated, true);
    assert.ok(!done.stdout.includes('�'), `prefix ${JSON.stringify(prefix)}`);
    const [head, tail] = done.stdout.split(/\n\[… 省略了[^\n]*…\]\n/);
    assert.ok(text.startsWith(head) && head.length > 0);
    assert.ok(text.endsWith(tail) && tail.length > 0);
    const omitted = Number(/省略了 (\d+) 字节/.exec(done.stdout)[1]);
    assert.equal(Buffer.byteLength(head) + Buffer.byteLength(tail) + omitted, Buffer.byteLength(text));
  }
  const emoji = await collect(t, Buffer.from(`ab${'😀'.repeat(20000)}`), Buffer.alloc(0), 999);
  assert.ok(!emoji.stdout.includes('�'));
});

test('every execution gets a new private directory: names planted in the temporary directory are not followed, and the same call id twice does not share', async t => {
  const root = scratch(t), victim = join(root, 'victim');
  writeFileSync(victim, 'keep');
  mkdirSync(join(root, 'call_1_x'));
  symlinkSync(victim, join(root, 'call_1_x', 'stdout'));
  const first = await openOutputs('call:1/x', root), second = await openOutputs('call:1/x', root);
  await first.stdout.write(Buffer.from('one')); await second.stdout.write(Buffer.from('two'));
  const [a, b] = await Promise.all([first.finish(), second.finish()]);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.deepEqual([a.stdout, b.stdout], ['one', 'two']);
  assert.deepEqual(readdirSync(root).sort(), ['call_1_x', 'victim']);
  const big = await openOutputs('big', root);
  await big.stdout.write(Buffer.alloc(HEAD + TAIL + 1, 'a'));
  const done = await big.finish();
  assert.equal(statSync(done.outputDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(done.outputDir, 'stdout')).mode & 0o777, 0o600);
  assert.equal(done.outputDir.startsWith(join(root, 'coda-remote-exec-big-')), true);
});

test('a write that goes in part is written to the end, and one that cannot go in fails instead of leaving a short file', async () => {
  const got = [];
  await writeAll({ write: async (chunk, at, length) => { const n = Math.min(3, length); got.push(chunk.subarray(at, at + n).toString()); return { bytesWritten: n }; } }, Buffer.from('abcdefgh'));
  assert.deepEqual(got, ['abc', 'def', 'gh']);
  await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from('abc')), /写不进去/);
});

test('the tool description counts the request and the answer separately against 1 MiB', () => {
  assert.match(definition.operations.exec.description, /请求和回答各自编码后都不能超过 1 MiB/);
});

// ——— 时限 ———

test('the time limit is 120 s by default, at most 600 s, and the earlier of that and the deadline', () => {
  const now = 1_000_000;
  assert.equal(DEFAULT_TIMEOUT, 120_000);
  assert.equal(timeLimit(undefined, null, now), 120_000);
  assert.equal(timeLimit(5, null, now), 5000);
  assert.equal(timeLimit(600, null, now), 600_000);
  assert.equal(timeLimit(9999, null, now), MAX_TIMEOUT);
  assert.equal(timeLimit(undefined, now + 10_000, now), 10_000);
  assert.equal(timeLimit(5, now + 10_000, now), 5000);
  assert.equal(timeLimit(600, now + 700_000, now), 600_000);
  assert.equal(timeLimit(30, now - 1, now), 0);
});

// ——— 结束进程组 ———

// 假的 kill 与计时：`wait` 默认立刻返回并记下过了多久，`diesAt`（毫秒）之后组里没有进程了；`manual` 时 `wait` 由测试放行。
function fake({ diesAt = Infinity, refuse = () => false, manual = false } = {}) {
  const calls = [], warned = [], waits = [];
  let slept = 0, exit; const exited = new Promise(resolve => { exit = resolve; });
  return { calls, warned, waits, exit, exited, slept: () => slept,
    options: { warn: message => warned.push(message), grace: 2000,
      kill(pid, signal) {
        const code = refuse(pid, signal);
        if (signal !== 0) calls.push([pid, signal]);
        if (code) throw Object.assign(new Error('x'), { code });
        if (signal === 0 && slept >= diesAt) throw Object.assign(new Error('x'), { code: 'ESRCH' });
      },
      wait: ms => manual ? new Promise(resolve => waits.push([ms, resolve])) : (slept += ms, Promise.resolve()) } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the group gets TERM, and KILL when there is still something in it after the grace period', async () => {
  const f = fake();
  assert.equal(await terminate(42, f.exited, f.options), true);
  assert.deepEqual(f.calls, [[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
  assert.ok(f.slept() >= 2000);
  assert.deepEqual(f.warned, []);
});

test('a group that is empty within the grace period gets no KILL', async () => {
  const f = fake({ diesAt: 300 });
  assert.equal(await terminate(42, f.exited, f.options), false);
  assert.deepEqual(f.calls, [[-42, 'SIGTERM']]);
});

test('the leader gone is not the group gone: members that are still there get KILL', async () => {
  const f = fake();
  f.exit();
  assert.equal(await terminate(42, f.exited, f.options), true);
  assert.deepEqual(f.calls, [[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
});

test('when the group cannot be signalled the process alone is, with a line on standard error, and its exit is what counts', async () => {
  const f = fake({ manual: true, refuse: pid => pid < 0 && 'EPERM' }), done = terminate(42, f.exited, f.options);
  await tick();
  assert.deepEqual(f.calls, [[-42, 'SIGTERM'], [42, 'SIGTERM']]);
  assert.equal(f.warned.length, 1);
  f.waits[0][1]();
  await done;
  assert.deepEqual(f.calls, [[-42, 'SIGTERM'], [42, 'SIGTERM'], [-42, 'SIGKILL'], [42, 'SIGKILL']]);
  assert.equal(f.warned.length, 2);
  const g = fake({ manual: true, refuse: pid => pid < 0 && 'EPERM' }), early = terminate(42, g.exited, g.options);
  await tick();
  g.exit();
  assert.equal(await early, false);
  assert.deepEqual(g.calls, [[-42, 'SIGTERM'], [42, 'SIGTERM']]);
});

test('a process that is already gone is not waited for and nothing is thrown', async () => {
  const f = fake({ refuse: () => 'ESRCH' });
  assert.equal(await terminate(42, f.exited, f.options), false);
  assert.deepEqual(f.calls, [[-42, 'SIGTERM'], [42, 'SIGTERM']]);
});

const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
async function allGone(pids) {
  for (let i = 0; i < 100 && !pids.every(gone); i++) await new Promise(resolve => setTimeout(resolve, 50));
  return pids.every(gone);
}
// A shell that is a group leader, its first line the pid of the sleep it leaves in the background.
async function leader(script) {
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const [line] = await once(child.stdout, 'data');
  return { child, exited, pids: [child.pid, Number(String(line).trim())] };
}

test('a real process group goes with its leader: TERM reaches the background children too', async () => {
  const { child, exited, pids } = await leader('sleep 30 & echo $!; wait');
  assert.ok(pids.every(pid => !gone(pid)));
  assert.equal(await terminate(child.pid, exited), false);
  assert.ok(await allGone(pids));
});

test('a real group whose leader leaves on TERM while a member ignores it is killed as a whole', async t => {
  // The member says its pid only once it ignores TERM, so the group is asked to end after that and not before.
  const { child, exited, pids } = await leader(`sh -c 'trap "" TERM; echo $$; exec sleep 30' & sleep 30`);
  t.after(() => { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(await terminate(child.pid, exited, { grace: 300 }), true);
  assert.ok(await allGone(pids));
});

test('a real group that ignores TERM is killed after the grace period', async () => {
  const { child, exited, pids } = await leader("trap '' TERM; sleep 30 & echo $!; while :; do sleep 1; done");
  assert.equal(await terminate(child.pid, exited, { grace: 300 }), true);
  assert.ok(await allGone(pids));
});

// ——— 登记的处理函数 ———

test('the operation and both streams are registered, read the switch as it is now, and are taken away with the plugin', async t => {
  const state = scratch(t), file = join(state, 'hello.txt'), record = { kind: MACHINE, id: 'r-1' };
  writeFileSync(file, 'hello');
  const host = createMockCoda({ plugin: { id: 'remote-exec', protocols: manifest.contributes.protocols, state }, settings: {} });
  await activate(host.coda);
  t.after(() => { deactivate(); host.close(); });
  const get = () => host.stream(record, 'pull', new Request(`http://stream/?path=${encodeURIComponent(file)}`));
  await assert.rejects(host.call(record, 'exec', { command: 'echo' }), { code: 'disabled', effects: 'none' });
  await assert.rejects(get(), { code: 'disabled', effects: 'none' });
  // 测试宿主只从查询串取参数，写的流收不到 path：它先于处理函数拒绝，能证明的只是 push 已登记（没登记是 not_found）。
  await assert.rejects(host.stream(record, 'push', new Request('http://stream/', { method: 'POST', body: 'x' })), { code: 'invalid_input' });
  await host.setSettings({ [SETTING]: true });
  assert.equal(await (await get()).text(), 'hello');
  await host.setSettings({ [SETTING]: false });
  await assert.rejects(get(), { code: 'disabled' });
  const read = () => { try { return readFileSync(join(state, AUDIT_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  const lines = await waitFor(() => read().length === 4 && read(), '四行操作记录');
  assert.deepEqual(lines.map(line => [line.operation, line.error ?? 'ok']), [['exec', 'disabled'], ['pull', 'disabled'], ['pull', 'ok'], ['pull', 'disabled']]);
  deactivate();
  await assert.rejects(host.call(record, 'exec', { command: 'echo' }), { code: 'not_found' });
  await assert.rejects(get(), { code: 'not_found' });
});
