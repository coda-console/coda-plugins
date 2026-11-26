// 受限执行的集成测试：在 macOS 上真的跑 /usr/bin/sandbox-exec（其他平台跳过）。
// 要保护的东西都是测试自建的替身（家目录里的 .ssh、状态目录、哨兵文件），机制与真的一样（不在允许目录里就读不到），不碰用户真实的私人文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from '../../../plugins/remote-exec/lib/exec.mjs';
import { HEAD, TAIL } from '../../../plugins/remote-exec/lib/output.mjs';
import { SANDBOX_EXEC, TMP_DIR, sandboxSupported } from '../../../plugins/remote-exec/lib/sandbox.mjs';
import { allGone, caller, fakeSpawn, scratch, setup, waitFor } from './support.mjs';

const skip = sandboxSupported() ? false : '需要 macOS 的 /usr/bin/sandbox-exec';
const record = { kind: 'remote-exec/machine@1', id: 'r-1', key: 'host' };
let serial = 0;

// 一套布局：允许的 rw、ro 两个目录，不在允许范围里的 out（哨兵文件）与替身的家目录（.ssh 里有哨兵）。
function layout(t) {
  const base = realpathSync(scratch(t)), host = setup(t);
  const dirs = { base, rw: join(base, 'rw'), ro: join(base, 'ro'), out: join(base, 'out'), home: join(base, 'home') };
  for (const dir of [dirs.rw, dirs.ro, dirs.out, join(dirs.home, '.ssh')]) mkdirSync(dir, { recursive: true });
  const sentinel = `SENTINEL-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const files = { out: join(dirs.out, 'secret.txt'), ssh: join(dirs.home, '.ssh', 'id_decoy'), home: join(dirs.home, 'notes.txt'), ro: join(dirs.ro, 'readme.txt') };
  for (const file of [files.out, files.ssh, files.home]) writeFileSync(file, sentinel);
  writeFileSync(files.ro, 'ro-content');
  const restrict = { dirs: [{ path: dirs.rw, access: 'rw' }, { path: dirs.ro, access: 'ro' }] };
  const context = (spawn, extra = {}) => ({ id: `sandbox-int-${process.pid}-${++serial}`, caller, record, signal: new AbortController().signal, deadline: null, spawn, ...extra });
  const run = (command, { spawn = fakeSpawn(t), ...input } = {}, extra) => exec(host.env, { command, restrict, ...input }, context(spawn, extra));
  return { ...dirs, files, sentinel, host, restrict, run, context };
}
const denied = (result, sentinel) => {
  assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel), '哨兵不能出现在输出里');
  assert.match(result.stderr, /Operation not permitted/);
};

test('inside the allowed directories: rw reads and writes, ro reads, cwd is the first rw directory, exit codes pass through', { skip }, async t => {
  const l = layout(t);
  const result = await l.run(`pwd -P; echo made > w.txt && cat w.txt; cat '${l.files.ro}'; echo; mkdir sub && echo deep > sub/f && cat sub/f; exit 5`);
  assert.equal(result.exitCode, 5);
  assert.equal(result.stdout, `${l.rw}\nmade\nro-content\ndeep\n`);
  assert.equal(readFileSync(join(l.rw, 'w.txt'), 'utf8'), 'made\n');
  // 是 rw 目录里的普通文件，这个目录下的写入真的落在了磁盘上；命令自己的 71、65 是命令的退出码。
  for (const code of [71, 65]) assert.equal((await l.run(`exit ${code}`)).exitCode, code);
});

test('an ro directory can be read and not written: no new file, no change, no delete, no truncate', { skip }, async t => {
  const l = layout(t);
  const result = await l.run(`cat '${l.files.ro}'; echo; (echo x > '${l.ro}/new'); (echo y >> '${l.files.ro}'); (: > '${l.files.ro}'); rm '${l.files.ro}'; mkdir '${l.ro}/d'; mv '${l.files.ro}' '${l.ro}/moved'`);
  assert.match(result.stdout, /^ro-content\n/);
  assert.equal((result.stderr.match(/Operation not permitted/g) ?? []).length, 6);
  assert.equal(readFileSync(l.files.ro, 'utf8'), 'ro-content');
  assert.deepEqual(readdirSync(l.ro), ['readme.txt']);
});

test('outside the allowed directories nothing can be read: a sibling, a decoy home and its .ssh, the state directory with its record and outputs', { skip }, async t => {
  const l = layout(t);
  for (const file of [l.files.out, l.files.home, l.files.ssh]) denied(await l.run(`cat '${file}'`), l.sentinel);
  for (const dir of [l.out, l.home, join(l.home, '.ssh'), l.base]) assert.match((await l.run(`ls '${dir}'`)).stderr, /Operation not permitted/);
  assert.match((await l.run(`echo x > '${l.out}/new'`)).stderr, /Operation not permitted/);
  assert.equal(existsSync(join(l.out, 'new')), false);
  // 状态目录：操作记录、输出目录、同一状态根下别的插件的状态目录（这里的状态根就是它）。
  const other = join(l.host.state, 'plugins', 'other');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'token'), l.sentinel);
  for (const file of [join(l.host.state, 'audit.jsonl'), join(other, 'token')]) denied(await l.run(`cat '${file}'`), l.sentinel);
  for (const dir of [l.host.state, join(l.host.state, 'outputs')]) assert.match((await l.run(`ls '${dir}'`)).stderr, /Operation not permitted/);
  // 受保护位置与它同级的 ~/.ssh 不能授出：整个家目录、状态根都被拒绝，什么都没跑。
  for (const path of [process.env.HOME, l.host.state, l.base.replace(/\/[^/]+$/, '')]) {
    await assert.rejects(l.run('true', { restrict: { dirs: [{ path, access: 'rw' }] } }), { code: 'restrict_protected', effects: 'none' });
  }
});

test('children are bound as well: a shell in a shell, env, xargs, a background job, a command run from the allowed directory', { skip }, async t => {
  const l = layout(t);
  const script = join(l.rw, 'peek.sh');
  writeFileSync(script, `#!/bin/sh\ncat '${l.files.out}'\n`, { mode: 0o755 });
  for (const command of [
    `sh -c 'sh -c "cat \\"${l.files.out}\\""'`,
    `/usr/bin/env /bin/sh -c 'cat "${l.files.out}"'`,
    `echo '${l.files.out}' | xargs cat`,
    `(cat '${l.files.out}') & wait`,
    `'${script}'`,
    `/bin/sh -c 'exec cat "${l.files.out}"'`,
  ]) denied(await l.run(command), l.sentinel);
  // 对照：同一个子进程读得到允许的目录。
  assert.equal((await l.run(`sh -c 'sh -c "cat \\"${l.files.ro}\\""'`)).stdout, 'ro-content');
});

test('the environment is the cleaned one: no plugin token, no CODA_ variables, TMPDIR is this call\'s own directory, writable and gone afterwards', { skip }, async t => {
  const l = layout(t);
  const result = await l.run('env; echo "[$TMPDIR]"; echo ok > "$TMPDIR/f" && cat "$TMPDIR/f"; mktemp "$TMPDIR/x.XXXXXX" > /dev/null && echo mktemp-ok');
  assert.ok(!/CODA_|plugin-token/.test(result.stdout));
  const tmp = /\[(.+)\]/.exec(result.stdout)[1];
  assert.equal(tmp.startsWith(join(realpathSync(l.host.state), TMP_DIR)), true);
  assert.match(result.stdout, /ok\nmktemp-ok\n/);
  assert.equal(existsSync(tmp), false);
  assert.deepEqual(readdirSync(join(l.host.state, TMP_DIR)), []);
});

test('two calls at once do not reach each other\'s temp directory, and the temp directory is outside what an allowed directory can reach', { skip }, async t => {
  const l = layout(t), spawn = fakeSpawn(t, { ready: true });
  const controller = new AbortController(), first = l.run('echo TMP-SECRET > "$TMPDIR/mine"; echo "$TMPDIR"; sleep 30', { spawn }, { signal: controller.signal });
  const [tmp] = await waitFor(() => { try { const names = readdirSync(join(l.host.state, TMP_DIR)); return names.length && names.map(name => join(realpathSync(l.host.state), TMP_DIR, name)); } catch { return false; } }, '第一个调用的临时目录');
  await waitFor(() => existsSync(join(tmp, 'mine')), '第一个调用写好了文件');
  denied(await l.run(`cat '${join(tmp, 'mine')}'`), 'TMP-SECRET');
  assert.match((await l.run(`ls '${tmp}'`)).stderr, /Operation not permitted/);
  controller.abort(new DOMException('done', 'AbortError'));
  await assert.rejects(first, { name: 'AbortError' });
  assert.deepEqual(readdirSync(join(l.host.state, TMP_DIR)), []);
});

test('a command that does not finish is ended with its whole group and its children; the temp directory goes with it', { skip }, async t => {
  const l = layout(t);
  const result = await l.run('sleep 30 & echo $! > pid; wait', { timeout: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  const pid = Number(readFileSync(join(l.rw, 'pid'), 'utf8'));
  await allGone([pid]);
  assert.deepEqual(readdirSync(join(l.host.state, TMP_DIR)), []);
});

test('weird directory names (quote, backslash, parentheses, newline, equals) work as real sandbox parameters and inject nothing', { skip }, async t => {
  const l = layout(t), nasty = join(l.base, 'q"u\\o(te) =x\nnl');
  mkdirSync(nasty);
  const result = await l.run('echo inside > f && cat f && pwd -P', { restrict: { dirs: [{ path: nasty, access: 'rw' }] } });
  assert.equal(result.stdout, `inside\n${nasty}\n`);
  assert.equal(readFileSync(join(nasty, 'f'), 'utf8'), 'inside\n');
  denied(await l.run(`cat '${l.files.out}'`, { restrict: { dirs: [{ path: nasty, access: 'rw' }] } }), l.sentinel);
});

test('a profile that does not load is a sandbox_failed, not the command\'s own failure: a bad profile (65) and one that cannot exec the shell (71); the command never runs', { skip }, async t => {
  const l = layout(t), marker = join(l.rw, 'ran');
  const through = change => {
    const real = fakeSpawn(t);
    return (command, args, options) => real(command, change(args), options);
  };
  const profile = change => through(args => args.map(arg => arg.startsWith('(version 1)') ? change(arg) : arg));
  const broken = profile(text => `${text}\n(bogus`);
  const noShell = profile(text => text.replace('(allow process-exec* (subpath "/usr") (subpath "/bin") (subpath "/sbin"))', '(allow process-exec* (subpath "/usr"))'));
  for (const spawn of [broken, noShell]) {
    await assert.rejects(l.run(`touch '${marker}'`, { spawn }), error => error.code === 'sandbox_failed' && error.effects === 'none' && /sandbox-exec/.test(error.message));
  }
  assert.equal(existsSync(marker), false);
  assert.equal(l.host.lines().filter(line => line.error === 'sandbox_failed').length, 2);
  // 对照：命令自己退出 71，是普通结果。
  assert.equal((await l.run('exit 71')).exitCode, 71);
  assert.ok(SANDBOX_EXEC);
});

test('truncated output of a restricted call is kept in the state directory by the plugin; the restricted command cannot read it, the plugin (outside the sandbox) can', { skip }, async t => {
  const l = layout(t);
  const result = await l.run(`head -c ${4 * (HEAD + TAIL)} /dev/zero | tr '\\0' a`);
  t.after(() => import('node:fs').then(fs => fs.rmSync(result.outputDir, { recursive: true, force: true })));
  assert.equal(result.truncated, true);
  assert.ok(result.outputDir.startsWith(join(realpathSync(l.host.state), 'outputs')));
  assert.equal(readFileSync(join(result.outputDir, 'stdout')).length, 4 * (HEAD + TAIL));
  assert.match((await l.run(`cat '${join(result.outputDir, 'stdout')}' | head -c 10; ls '${result.outputDir}'`)).stderr, /Operation not permitted/);
});

test('a command that writes outside through an allowed directory\'s symlink is stopped as well', { skip }, async t => {
  const l = layout(t);
  const result = await l.run(`ln -s '${l.out}' via && echo x > via/new; cat via/secret.txt; ls -d via/..`);
  assert.equal(existsSync(join(l.out, 'new')), false);
  assert.ok(!result.stdout.includes(l.sentinel));
  assert.match(result.stderr, /Operation not permitted/);
});

test('a command that makes a subdirectory of its temp directory untraversable (chmod 000) and exits 0 still returns its own exit code and output, and the temp directory is gone afterwards', { skip }, async t => {
  const l = layout(t);
  const result = await l.run('mkdir "$TMPDIR/a" && mkdir "$TMPDIR/a/b" && echo x > "$TMPDIR/a/b/f" && chmod 000 "$TMPDIR/a/b" "$TMPDIR/a" && echo finished; exit 0');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'finished\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(join(l.host.state, TMP_DIR)), []);
  assert.deepEqual(l.host.lines().map(line => line.result), [{ exitCode: 0, signal: null, timedOut: false }]);
  // 也有非零退出码的同样情形。
  assert.equal((await l.run('mkdir "$TMPDIR/c" && chmod 000 "$TMPDIR/c"; exit 9')).exitCode, 9);
  assert.deepEqual(readdirSync(join(l.host.state, TMP_DIR)), []);
});

test('when the cleanup still fails the outcome is the same, the cause is on stderr, and the leftover is renamed so no later call can use it', { skip }, async t => {
  const l = layout(t), logged = [], original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  l.host.env.remove = async () => { throw new Error('delete failed on purpose'); };
  const result = await l.run('echo kept; exit 4');
  assert.deepEqual([result.exitCode, result.stdout], [4, 'kept\n']);
  assert.deepEqual(l.host.lines().map(line => line.result.exitCode), [4]);
  assert.equal(logged.filter(line => /delete failed on purpose/.test(line)).length, 1);
  const [left] = readdirSync(join(l.host.state, TMP_DIR));
  assert.match(left, /^dead-c-/);
  // 之后的调用用自己新建的目录，不碰残留。
  delete l.host.env.remove;
  const next = await l.run('echo "$TMPDIR"');
  assert.ok(!next.stdout.includes(left));
  assert.deepEqual(readdirSync(join(l.host.state, TMP_DIR)), [left]);
});
