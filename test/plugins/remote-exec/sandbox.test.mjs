// 受限执行（exec 的 restrict）：不依赖真的 sandbox-exec——平台与 spawn 都是假的，只看插件交给 spawn 的启动链、profile、拒绝路径与记录。
// 真的跑 sandbox-exec 的在 sandbox.integration.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pointProblem } from '@coda-console/protocol/validate';
import { cleanEnv, shellArgs } from '../../../plugins/remote-exec/lib/environ.mjs';
import { exec } from '../../../plugins/remote-exec/lib/exec.mjs';
import { MAX_DIRS, SANDBOX_EXEC, TMP_DIR, profileText } from '../../../plugins/remote-exec/lib/sandbox.mjs';
import { activate, deactivate } from '../../../plugins/remote-exec/main.mjs';
import { createMockCoda } from '../../helpers/mock-coda.mjs';
import { caller, fakeSpawn, scratch, setup } from './support.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../plugins/remote-exec/package.json', import.meta.url), 'utf8'));
const operation = manifest.contributes.protocols[0].operations.exec;
const record = { kind: 'remote-exec/machine@1', id: 'r-1', key: 'host' };
let serial = 0;

// 假的子进程：不起任何进程，退出码与输出是给定的。
const fakeChild = ({ code = 0, stdout = '', stderr = '' } = {}) => ({
  pid: 0, stdin: new PassThrough(), exited: Promise.resolve({ code, signal: null }),
  stdout: Readable.from(stdout ? [Buffer.from(stdout)] : []), stderr: Readable.from(stderr ? [Buffer.from(stderr)] : []),
});
// 空跑探测的那一条（sh -c ':'）。
const isProbe = call => call.args.at(-2) === '-c' && call.args.at(-1) === ':';
// 启动链里 sandbox-exec 的参数：SANDBOX_EXEC 与 /bin/sh 之间的部分。
const sandboxPart = call => call.args.slice(call.args.indexOf(SANDBOX_EXEC) + 1, call.args.lastIndexOf('/bin/sh'));
const paramsOf = call => Object.fromEntries(sandboxPart(call).flatMap((arg, i, all) => arg === '-D' ? [all[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
const profileOf = call => { const part = sandboxPart(call); return part[part.indexOf('-p') + 1]; };
const assignments = call => Object.fromEntries(call.args.slice(1, call.args.indexOf(SANDBOX_EXEC)).map(one => one.split(/=(.*)/s).slice(0, 2)));
const sandboxed = call => call.command === '/usr/bin/env' && call.args[0] === '-i' && call.args.indexOf(SANDBOX_EXEC) > 0
  && call.args.indexOf(SANDBOX_EXEC) < call.args.indexOf('/bin/sh') && call.args.at(-3) === '/bin/sh' && call.args.at(-2) === '-c';

// 一台带记录的环境：这台“支持”受限执行（可改），spawn 记下每次调用，`decide(call)` 回子进程（默认都成功退出）。
function rig(t, { supported = true, decide = () => fakeChild() } = {}) {
  const host = setup(t), calls = [];
  host.env.sandboxSupported = () => supported;
  const spawn = async (command, args, options) => { const call = { command, args, options }; calls.push(call); return decide(call); };
  const context = (extra = {}) => ({ id: `sandbox-test-${process.pid}-${++serial}`, caller, record, signal: new AbortController().signal, deadline: null, spawn, ...extra });
  const tmpLeft = () => { try { return readdirSync(join(host.state, TMP_DIR)); } catch { return []; } };
  return { host, calls, context, tmpLeft, run: (input, extra) => exec(host.env, input, context(extra)) };
}
// 一份目录布局（真实路径）：两个允许的目录、一个不在允许范围里的目录，各有一个文件。
function layout(t) {
  const base = realpathSync(scratch(t)), dirs = { base, rw: join(base, 'rw'), ro: join(base, 'ro'), out: join(base, 'out') };
  for (const dir of [dirs.rw, dirs.ro, dirs.out]) mkdirSync(dir);
  return dirs;
}
const both = d => ({ dirs: [{ path: d.rw, access: 'rw' }, { path: d.ro, access: 'ro' }] });

test('without restrict nothing changes: the same chain as before, no sandbox in it, and the log has no restrict', async t => {
  const one = rig(t, { supported: false });
  const result = await one.run({ command: 'echo hi', cwd: homedir() });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(one.calls.map(call => [call.command, call.args, call.options.cwd]), [[...shellArgs('echo hi', cleanEnv()), homedir()]]);
  const [line] = one.host.lines();
  assert.deepEqual(line.params, { command: 'echo hi', cwd: homedir() });
  assert.equal(one.tmpLeft().length, 0);
});

test('the definition takes an optional restrict of 1 to 50 {path, access} lines and nothing else, and the record can say sandbox', () => {
  const ok = [{ dirs: [{ path: '/a', access: 'rw' }] }, { dirs: [{ path: '/a', access: 'ro' }, { path: '/b', access: 'rw' }] }];
  for (const restrict of ok) assert.equal(pointProblem(operation.input, { command: 'x', restrict }, 'input'), null);
  assert.equal(pointProblem(operation.input, { command: 'x' }, 'input'), null);
  const bad = [{}, { dirs: [] }, { dirs: [{ path: '/a', access: 'x' }] }, { dirs: [{ path: '/a' }] }, { dirs: [{ path: '', access: 'rw' }] },
    { dirs: [{ path: '/a', access: 'rw', extra: 1 }] }, { dirs: [{ path: '/a', access: 'rw' }], extra: 1 },
    { dirs: Array.from({ length: MAX_DIRS + 1 }, (_, i) => ({ path: `/d${i}`, access: 'rw' })) }];
  for (const restrict of bad) assert.notEqual(pointProblem(operation.input, { command: 'x', restrict }, 'input'), null, JSON.stringify(restrict).slice(0, 60));
  assert.equal(pointProblem(operation.input, { command: 'x', restrict: { dirs: Array.from({ length: MAX_DIRS }, (_, i) => ({ path: `/d${i}`, access: 'rw' })) } }, 'input'), null);
  // 记录的形状不动：旧版的节点按自己的 schema 接收镜像，多出的键会让整条记录被丢掉。能力发现靠 os 提示与带 restrict 的探测。
  const [{ spec, status }] = manifest.contributes.protocols;
  assert.deepEqual(Object.keys(spec.properties), ['name', 'os', 'user', 'cwd']);
  assert.deepEqual(Object.keys(status.properties), ['available']);
  assert.match(operation.description, /restrict/);
  assert.match(operation.description, /outputDir/);
});

test('a restrict that is not well formed is refused with invalid_input before anything is run, with effects none, and logged with the code', async t => {
  const d = layout(t), file = join(d.base, 'file'), rw = { path: d.rw, access: 'rw' };
  writeFileSync(file, '');
  const bad = [null, 'x', 5, [], {}, { dirs: [] }, { dirs: 'x' }, { dirs: [rw], extra: 1 }, { dirs: [null] }, { dirs: [{ path: d.rw }] },
    { dirs: [{ path: d.rw, access: 'rwx' }] }, { dirs: [{ path: 'relative', access: 'rw' }] }, { dirs: [{ path: 5, access: 'rw' }] },
    { dirs: [{ path: `${d.rw}\0x`, access: 'rw' }] }, { dirs: [{ path: d.rw, access: 'rw', extra: 1 }] },
    { dirs: [{ path: d.ro, access: 'ro' }] }, { dirs: Array.from({ length: MAX_DIRS + 1 }, () => rw) }];
  for (const restrict of bad) {
    const one = rig(t);
    await assert.rejects(one.run({ command: 'true', restrict }), { code: 'invalid_input', effects: 'none' }, JSON.stringify(restrict)?.slice(0, 60));
    assert.deepEqual(one.calls, []);
    assert.equal(one.tmpLeft().length, 0);
    const [line] = one.host.lines();
    assert.equal(line.error, 'invalid_input');
    assert.deepEqual(line.params.restrict, restrict);
  }
  // 上限本身可以（50 行）。
  const edge = rig(t);
  await edge.run({ command: 'true', restrict: { dirs: Array.from({ length: MAX_DIRS }, () => rw) } });
  assert.equal(edge.calls.length, 2);
});

test('each refusal has its own code, effects none, no process started, no temp directory left, and a start and an end line', async t => {
  const d = layout(t), file = join(d.rw, 'file'), link = join(d.rw, 'out-link');
  writeFileSync(file, '');
  symlinkSync(d.out, link);
  const cases = [
    ['sandbox_unsupported', { rig: { supported: false }, restrict: both(d) }],
    ['restrict_dir_not_found', { restrict: { dirs: [{ path: join(d.base, 'missing'), access: 'rw' }] } }],
    ['restrict_dir_not_found', { restrict: { dirs: [{ path: d.rw, access: 'rw' }, { path: join(d.base, 'missing'), access: 'ro' }] } }],
    ['restrict_dir_not_a_directory', { restrict: { dirs: [{ path: file, access: 'rw' }] } }],
    ['restrict_dir_not_a_directory', { restrict: { dirs: [{ path: join(file, 'below'), access: 'rw' }] } }],
    ['restrict_protected', { restrict: state => ({ dirs: [{ path: state, access: 'rw' }] }) }],
    ['restrict_protected', { restrict: state => ({ dirs: [{ path: dirname(state), access: 'ro' }, { path: d.rw, access: 'rw' }] }) }],
    ['restrict_protected', { restrict: state => ({ dirs: [{ path: join(state, 'plugins'), access: 'rw' }] }), prepare: state => mkdirSync(join(state, 'plugins'), { recursive: true }) }],
    ['restrict_protected', { restrict: { dirs: [{ path: homedir(), access: 'rw' }] } }],
    ['restrict_protected', { restrict: { dirs: [{ path: '/', access: 'rw' }] } }],
    ['cwd_not_allowed', { restrict: both(d), cwd: d.out }],
    ['cwd_not_allowed', { restrict: both(d), cwd: d.base }],
    ['cwd_not_allowed', { restrict: both(d), cwd: link }],
    ['invalid_input', { restrict: both(d), cwd: 'relative/dir' }],
    ['not_found', { restrict: both(d), cwd: join(d.rw, 'missing') }],
    ['not_a_directory', { restrict: both(d), cwd: file }],
  ];
  for (const [code, one] of cases) {
    const it = rig(t, one.rig);
    one.prepare?.(it.host.state);
    const restrict = typeof one.restrict === 'function' ? one.restrict(it.host.state) : one.restrict;
    await assert.rejects(it.run({ command: 'true', cwd: one.cwd, restrict }), { code, effects: 'none' }, `${code} ${JSON.stringify(restrict)}`);
    assert.deepEqual(it.calls, [], code);
    assert.equal(it.tmpLeft().length, 0, code);
    const lines = it.host.raw();
    assert.deepEqual(lines.map(line => line.phase), ['start', 'end'], code);
    assert.equal(lines[1].error, code);
    assert.deepEqual(lines[0].params.restrict, restrict);
  }
});

// 文件系统不分大小写（macOS 默认）时，换个大小写的拼写指向同一处；分大小写的卷上这几个用例不适用（跳过）。
const skewed = path => path.replace(/[a-z]/g, c => c.toUpperCase());

test('on a case-insensitive volume a differently spelled path is the same path: a protected location is still protected, a cwd is still inside its allowed directory, and the profile gets the volume\'s own spelling', async t => {
  const probe = realpathSync(scratch(t));
  if (!existsSync(skewed(probe)) || !existsSync(probe.toLowerCase())) return t.skip('卷分大小写');
  const d = layout(t);
  // 受保护的位置换个拼写授出：状态根、它的祖先、家目录（含 ~/.ssh）。
  for (const spelled of [it => skewed(it.host.state), it => skewed(dirname(it.host.state)), () => skewed(realpathSync(homedir()))]) {
    const one = rig(t);
    const path = spelled(one);
    await assert.rejects(one.run({ command: 'true', restrict: { dirs: [{ path, access: 'rw' }] } }), { code: 'restrict_protected', effects: 'none' }, path);
    assert.deepEqual(one.calls, []);
  }
  // cwd 与允许目录各换拼写：仍在里面，交给 spawn 与 profile 的是真写法。
  const inner = join(d.rw, 'inner');
  mkdirSync(inner);
  for (const [dirPath, cwd] of [[d.rw, skewed(inner)], [skewed(d.rw), inner], [skewed(d.rw), skewed(inner)]]) {
    const one = rig(t);
    await one.run({ command: 'pwd', cwd, restrict: { dirs: [{ path: dirPath, access: 'rw' }] } });
    assert.deepEqual(one.calls.map(call => call.options.cwd), [inner, inner]);
    assert.equal(paramsOf(one.calls[1]).D0, d.rw);
  }
  // 换了拼写、实际在允许目录之外的 cwd 仍被拒。
  await assert.rejects(rig(t).run({ command: 'true', cwd: skewed(d.out), restrict: both(d) }), { code: 'cwd_not_allowed' });
});

test('a protected location that does not exist yet (no ~/.ssh) is still compared by its real path: the existing part is canonicalised', async t => {
  const base = realpathSync(scratch(t)), one = rig(t);
  one.host.env.stateRoot = join(base, 'not', 'there');   // 还没有的状态根：已有的祖先按真写法，其余原样
  await assert.rejects(one.run({ command: 'true', restrict: { dirs: [{ path: base, access: 'rw' }] } }), { code: 'restrict_protected' });
});

test('a profile that does not load is told apart from a command that exits non-zero: it is a sandbox_failed, the real command is never started', async t => {
  const d = layout(t);
  // 空跑不过：sandbox-exec 自己报错（65 语法、71 起不来），真命令没起。
  for (const code of [65, 71, 1]) {
    const one = rig(t, { decide: () => fakeChild({ code, stderr: 'sandbox-exec: boom\n' }) });
    await assert.rejects(one.run({ command: 'touch x', restrict: both(d) }), error => error.code === 'sandbox_failed' && error.effects === 'none' && /boom/.test(error.message));
    assert.equal(one.calls.length, 1);
    assert.ok(isProbe(one.calls[0]));
    assert.equal(one.tmpLeft().length, 0);
    assert.equal(one.host.lines()[0].error, 'sandbox_failed');
  }
  // 空跑过了，用户命令自己退出 71 / 65 就是命令的普通结果。
  const fine = rig(t, { decide: call => fakeChild({ code: isProbe(call) ? 0 : 71 }) });
  assert.equal((await fine.run({ command: 'exit 71', restrict: both(d) })).exitCode, 71);
  assert.deepEqual(fine.calls.map(isProbe), [true, false]);
  assert.equal(fine.host.lines()[0].error, undefined);
});

test('a call with restrict never reaches an unrestricted spawn: every spawn is the sandbox chain, whatever fails', async t => {
  const d = layout(t), restrict = both(d), seen = [];
  const scenarios = [
    ['success', {}, () => fakeChild()],
    ['probe fails', {}, call => fakeChild({ code: isProbe(call) ? 71 : 0 })],
    ['probe spawn throws', {}, () => { throw Object.assign(new Error('no'), { code: 'spawn_failed', effects: 'none' }); }],
    ['command spawn throws', {}, call => { if (!isProbe(call)) throw Object.assign(new Error('no'), { code: 'spawn_failed', effects: 'none' }); return fakeChild(); }],
    ['command fails', {}, call => fakeChild({ code: isProbe(call) ? 0 : 3 })],
    ['platform unsupported', { supported: false }, () => fakeChild()],
  ];
  for (const [name, options, decide] of scenarios) {
    const one = rig(t, { ...options, decide });
    await one.run({ command: 'echo', restrict }).catch(() => {});
    seen.push(...one.calls.map(call => [name, call]));
    assert.equal(one.tmpLeft().length, 0, name);
  }
  // 参数有问题或目录不对的，一次 spawn 都没有。
  for (const bad of [null, {}, { dirs: [] }, { dirs: [{ path: '/nonexistent-dir-xyz', access: 'rw' }] }, { dirs: [{ path: d.ro, access: 'ro' }] }]) {
    const one = rig(t);
    await one.run({ command: 'echo', restrict: bad }).catch(() => {});
    assert.deepEqual(one.calls, [], JSON.stringify(bad));
  }
  assert.ok(seen.length >= 8);
  for (const [name, call] of seen) assert.ok(sandboxed(call), `${name}: ${call.command} ${call.args.join(' ').slice(0, 80)}`);
  // 没带 restrict 的才走不受限的链，二者不会混。
  const plain = rig(t);
  await plain.run({ command: 'echo' });
  assert.ok(!plain.calls.some(call => call.args.includes(SANDBOX_EXEC)));
});

test('the launch chain: env -i with only the whitelist (TMPDIR replaced), then sandbox-exec, then sh -c; the profile has no path in it, the paths are -D parameters, as real paths', async t => {
  const d = layout(t), alias = join(d.base, 'alias');
  symlinkSync(d.rw, alias);
  const one = rig(t);
  await one.run({ command: 'echo "$X"', restrict: { dirs: [{ path: alias, access: 'rw' }, { path: d.ro, access: 'ro' }] } });
  const [probe, real] = one.calls;
  assert.ok(isProbe(probe) && !isProbe(real));
  assert.equal(real.command, '/usr/bin/env');
  assert.equal(real.args[0], '-i');
  assert.deepEqual(real.args.slice(-3), ['/bin/sh', '-c', 'echo "$X"']);
  assert.deepEqual(Object.keys(assignments(real)).sort(), Object.keys({ ...cleanEnv(), TMPDIR: 1 }).sort());
  assert.ok(!Object.keys(assignments(real)).some(key => key.startsWith('CODA_')));
  const params = paramsOf(real), tmp = assignments(real).TMPDIR;
  assert.deepEqual(params, { D0: d.rw, D1: d.ro, TMP: tmp });   // 符号链接解析成真实路径
  assert.deepEqual(probe.args.slice(0, -1), real.args.slice(0, -1));   // 探测与真命令是同一条链，只有最后的命令不同
  // 临时目录：状态目录下，本次专用。
  assert.equal(dirname(tmp), join(realpathSync(one.host.state), TMP_DIR));
  // profile：deny-default、system.sb 为底，没有任何路径。
  const text = profileOf(real);
  assert.match(text, /^\(version 1\)\n\(deny default\)\n\(import "system\.sb"\)/);
  assert.ok(![d.base, tmp, homedir()].some(piece => text.includes(piece)), text);
  assert.equal(text, profileText([{ access: 'rw' }, { access: 'ro' }]));
  const rule = name => text.split('\n').find(line => line.includes(`(param "${name}")`));
  assert.match(rule('D0'), /file-read\* file-write\*/);
  assert.doesNotMatch(rule('D1'), /file-write/);
  assert.match(rule('D1'), /file-read\*/);
  assert.match(rule('TMP'), /file-read\* file-write\*/);
  assert.equal(real.options.cwd, d.rw);
});

test('paths with quotes, backslashes, parentheses and newlines cannot get into the profile: they only travel as -D values', async t => {
  const d = layout(t), nasty = join(d.base, 'q"uo\\te (x) ) (allow default) ;\nnl');
  mkdirSync(nasty);
  const one = rig(t);
  await one.run({ command: 'true', restrict: { dirs: [{ path: nasty, access: 'rw' }] } });
  const call = one.calls[1];
  assert.equal(paramsOf(call).D0, nasty);
  assert.equal(profileOf(call), profileText([{ access: 'rw' }]));
  assert.ok(!profileOf(call).includes('allow default'));
  assert.equal(call.options.cwd, nasty);
});

test('without cwd the command runs in the first rw directory (not the home directory, not an ro one listed first); with cwd it must be inside an allowed directory, by real path', async t => {
  const d = layout(t), inner = join(d.ro, 'inner'), second = join(d.base, 'second');
  mkdirSync(inner); mkdirSync(second);
  const restrict = { dirs: [{ path: d.ro, access: 'ro' }, { path: d.rw, access: 'rw' }, { path: second, access: 'rw' }] };
  const one = rig(t);
  await one.run({ command: 'pwd', restrict });
  assert.deepEqual(one.calls.map(call => call.options.cwd), [d.rw, d.rw]);
  assert.equal(one.host.lines()[0].params.cwd, d.rw);
  for (const cwd of [inner, second, d.ro, d.rw]) {
    const again = rig(t);
    await again.run({ command: 'pwd', cwd, restrict });
    assert.deepEqual(again.calls.map(call => call.options.cwd), [cwd, cwd]);
    assert.equal(again.host.lines()[0].params.cwd, cwd);
  }
  // 允许的目录是符号链接时，cwd 写链接这一边或真实这一边都行。
  const alias = join(d.base, 'alias');
  symlinkSync(d.rw, alias);
  const linked = rig(t);
  await linked.run({ command: 'pwd', cwd: alias, restrict: { dirs: [{ path: d.rw, access: 'rw' }] } });
  assert.equal(linked.calls[1].options.cwd, d.rw);
});

test('the call\'s temp directory is made fresh in the state directory, owned by it alone, and gone after success, a failing command, a timeout, a cancel and a failed spawn', async t => {
  const d = layout(t), restrict = both(d), made = [];
  const watching = real => call => {
    if (isProbe(call)) return fakeChild();
    const tmp = assignments(call).TMPDIR;
    made.push(tmp);
    assert.ok(existsSync(tmp), '运行时在');
    assert.equal(statSync(tmp).mode & 0o777, 0o700);
    return real(call);
  };
  // 成功、命令自己失败
  for (const code of [0, 3]) {
    const one = rig(t, { decide: watching(() => fakeChild({ code })) });
    assert.equal((await one.run({ command: 'x', restrict })).exitCode, code);
    assert.equal(one.tmpLeft().length, 0);
  }
  // 起进程失败
  const failing = rig(t, { decide: watching(() => { throw Object.assign(new Error('no'), { code: 'spawn_failed', effects: 'none' }); }) });
  await assert.rejects(failing.run({ command: 'x', restrict }), { code: 'spawn_failed' });
  assert.equal(failing.tmpLeft().length, 0);
  // 超时、取消：命令是真的在睡的进程（不经 sandbox-exec，只为有个活的进程可结束）
  const sleeper = fakeSpawn(t, { ready: true });
  const hang = call => sleeper('/bin/sh', ['-c', 'echo up; sleep 30'], call.options);
  const slow = rig(t, { decide: watching(hang) });
  const timedOut = await slow.run({ command: 'x', restrict, timeout: 1 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(slow.tmpLeft().length, 0);
  const controller = new AbortController(), away = new DOMException('away', 'AbortError');
  const cancelled = rig(t, { decide: watching(hang) });
  const done = cancelled.run({ command: 'x', restrict }, { signal: controller.signal });
  while (made.length < 5) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(away);
  await assert.rejects(done, error => error === away);
  assert.equal(cancelled.tmpLeft().length, 0);
  assert.equal(new Set(made).size, made.length, '每次各用各的');
});

test('the log has whether it was restricted and the directory list with its marks; the judge gets it too; a call without it has neither', async t => {
  const d = layout(t), restrict = both(d), judged = [];
  const one = rig(t);
  one.host.env.judge = request => { judged.push(request.content); return { allow: true }; };
  await one.run({ command: 'echo', restrict });
  await one.run({ command: 'echo' });
  const [restricted, plain] = one.host.lines();
  assert.deepEqual(restricted.params, { command: 'echo', cwd: d.rw, restrict });
  assert.deepEqual(plain.params.restrict, undefined);
  assert.deepEqual(judged[0].restrict, restrict);
  assert.equal('restrict' in judged[1], false);
  // 开关关着时拒绝的也记。
  one.host.set(false);
  await assert.rejects(one.run({ command: 'echo', restrict }), { code: 'disabled' });
  assert.deepEqual(one.host.lines().at(-1).params.restrict, restrict);
});

test('activation removes the temp directories a crash left behind, before the handlers are registered', async t => {
  const state = scratch(t), leftover = join(state, TMP_DIR, 'c-old');
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, 'f'), '');
  const host = createMockCoda({ plugin: { id: 'remote-exec', protocols: manifest.contributes.protocols, state }, settings: {} });
  await activate(host.coda, { sandbox: () => true });
  t.after(() => { deactivate(); host.close(); });
  assert.equal(existsSync(join(state, TMP_DIR)), false);
});
