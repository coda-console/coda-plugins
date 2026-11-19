// From Coda's backend/test/kimi.test.mjs at 9ffb9911, as plain node:test.
// The kimi plugin's「Kimi」resources: who is signed in and the quota, from the CLI's own local server (scripts/web.mjs, quota.mjs,
// the record command resource.mjs). Signing in and installing with the CLI's own login and installer: sign-in.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, mkdir, utimes } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { resourceRecords, resourceRecordsProblem } from '../../../check/resources.mjs';
import { account, resource, windows } from '../../../plugins/kimi/scripts/quota.mjs';
import { KimiUnavailable, kimiWeb } from '../../../plugins/kimi/scripts/web.mjs';
import { barePath, pluginEnv } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
async function root(t) { const dir = await mkdtemp(join(tmpdir(), 'coda-kimi-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

// A Kimi CLI whose `kimi web` serves as the real one: it says where it listens with a token, answers the two paths, and
// notes what it was asked. What it does is set by the `mode` file of its KIMI_CODE_HOME.
const fixture = `#!${process.execPath}
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const home = process.env.KIMI_CODE_HOME;
const mode = fs.readFileSync(path.join(home, 'mode'), 'utf8').trim();
fs.writeFileSync(path.join(home, 'process.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }));
if (mode === 'exit') process.exit(1);
if (mode === 'silent') setInterval(() => {}, 1000);
else if (mode === 'flood') { process.stdout.write('x'.repeat(65537)); setInterval(() => {}, 1000); }
else {
  const server = http.createServer((req, res) => {
    fs.appendFileSync(path.join(home, 'requests.jsonl'), JSON.stringify({ url: req.url, auth: req.headers.authorization }) + '\\n');
    if (mode === 'malformed') return res.end('SECRET invalid JSON');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/oauth/userinfo') return res.end(JSON.stringify(mode === 'signed-out' ? { code: 0, data: { kind: 'error', status: 401, message: 'SECRET unauthorized' } }
      : mode === 'nameless' ? { code: 0, data: { kind: 'error', message: 'SECRET request timed out' } }
      : { code: 0, data: { kind: 'ok', userInfo: { userId: 'u1', nickname: ' 登月者0448 ', userLevelName: 'Allegretto', email: 'SECRET@example.com', phone: { number: 'SECRET' } } } }));
    res.end(JSON.stringify(mode === 'expired' ? { code: 0, data: { kind: 'error', message: 'SECRET login expired' } }
      : { code: 0, data: { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.25, resetAt: '2026-10-13T05:00:00Z' } }, extraUsage: { totalCents: 2500, balanceCents: 400 } } } }));
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('Kimi server: http://127.0.0.1:' + server.address().port + '/#token=SECRET-');
    setTimeout(() => process.stdout.write('LOCAL-TOKEN\\n'), 20);
  });
  process.on('SIGTERM', () => process.exit(0));
}
`;
// A machine's home with that CLI where its installer puts it, and a Kimi home in `mode`, signed in unless `signedIn` is false.
async function machine(t, mode, { signedIn = true } = {}) {
  const home = await root(t), kimiHome = join(home, '.kimi-code'), binary = join(kimiHome, 'bin/kimi');
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, fixture, { mode: 0o755 });
  await writeFile(join(kimiHome, 'mode'), mode);
  if (signedIn) { await mkdir(join(kimiHome, 'credentials')); await writeFile(join(kimiHome, 'credentials/kimi-code.json'), '{}'); }
  const requests = async () => (await readFile(join(kimiHome, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { home, kimiHome, binary, requests, setMode: value => writeFile(join(kimiHome, 'mode'), value) };
}

test('the quota is what the plan has left, booster balance included; who is signed in is a nickname and level, never a phone or email', () => {
  assert.deepEqual(windows({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.32, resetAt: '2026-09-27T04:21:05Z' }, limit7d: { usedRatio: 0.162 },
    monthTotal: { usedRatio: 1.4, resetAt: 'soon' }, monthCode: { usedRatio: 0.2 } }, extraUsage: { totalCents: 2500, balanceCents: 400 } } }), [
    { label: '5 小时', value: '剩余 68%', fraction: 0.68, time: '2026-09-27T04:21:05.000Z' },
    { label: '7 天', value: '剩余 84%', fraction: 0.84 },
    { label: '月度', value: '剩余 0%', fraction: 0 },
    { label: 'Extra Usage 余额', value: '剩余 16%', fraction: 0.16 },
  ]);
  assert.deepEqual(windows({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: '0.3' }, limit7d: { usedRatio: -1 }, monthTotal: {} }, extraUsage: { totalCents: 'x', balanceCents: 5 } } }), []);
  assert.equal(windows({ kind: 'error' }), null);
  assert.deepEqual(account({ kind: 'ok', userInfo: { nickname: ' 登月者0448 ', userLevelName: 'Allegretto', email: 'x@example.com' } }), { name: '登月者0448', plan: 'Allegretto' });
  // The account Coda's group view compares across machines: its user ID.
  assert.deepEqual(account({ kind: 'ok', userInfo: { userId: 42, nickname: 'a', userLevelName: 'b' } }), { name: 'a', plan: 'b', id: '42' });
  assert.equal(account({ kind: 'error', status: 401 }), null, 'Kimi refuses the login');
  assert.throws(() => account({ kind: 'error', message: 'timed out' }), /没有说明/, 'a passing fault is not a sign-out');
  const shown = resource({ name: '', plan: '' }, { error: 'Kimi 本地服务返回 500' });
  assert.deepEqual(shown, { name: 'Kimi', values: [], buttons: [], error: '暂时无法获取额度：Kimi 本地服务返回 500' });
  assert.equal(resourceRecordsProblem([{ key: 'account', spec: { type: 'account', title: 'Kimi', resources: [shown] } }]), null, 'a reading the host takes');
});

test('the CLI\'s local server is started privately, asked each path with its token, and ended with its directory', async t => {
  const m = await machine(t, 'ok');
  const [usage, info] = await kimiWeb(['/api/v1/oauth/usage', '/api/v1/oauth/userinfo'], { binary: m.binary, home: m.kimiHome });
  assert.equal(usage.data.quota.usages.limit5h.usedRatio, 0.25); assert.equal(info.data.userInfo.userLevelName, 'Allegretto');
  assert.deepEqual(await m.requests(), [{ url: '/api/v1/oauth/usage', auth: 'Bearer SECRET-LOCAL-TOKEN' }, { url: '/api/v1/oauth/userinfo', auth: 'Bearer SECRET-LOCAL-TOKEN' }]);
  const started = JSON.parse(await readFile(join(m.kimiHome, 'process.json')));
  assert.deepEqual(started.args, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0']);
  assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(started.cwd), { code: 'ENOENT' });
  // A path answered badly is that path's; a server that never starts, or says too much before it does, fails them all.
  await m.setMode('malformed');
  assert.match((await kimiWeb(['/api/v1/oauth/usage'], { binary: m.binary, home: m.kimiHome }))[0].error, /JSON/);
  for (const [mode, message] of [['exit', /提前退出/], ['flood', /输出不对/], ['silent', /没有答复/]]) {
    await m.setMode(mode);
    await assert.rejects(kimiWeb(['/api/v1/oauth/usage'], { binary: m.binary, home: m.kimiHome, timeoutMs: 500, closeTimeoutMs: 100 }), e => e instanceof KimiUnavailable && message.test(e.message), mode);
  }
  await assert.rejects(kimiWeb(['/x'], { binary: '/does/not/exist/kimi' }), /没能启动/);
});

test('the type shows the login and its quota, asks who it is once per state of the login, and shows nothing without one', async t => {
  const m = await machine(t, 'ok', { signedIn: false }), state = join(m.home, 'state');
  await mkdir(state);
  const read = async () => {
    const [record] = await resourceRecords(pluginDir('kimi'), { env: pluginEnv('kimi', { HOME: m.home, KIMI_CODE_HOME: '', CODA_PLUGIN_STATE: state }) });
    assert.deepEqual([record.key, record.spec.type, record.spec.title], ['account', 'account', 'Kimi']);
    assert.deepEqual(record.spec.signIn, { installed: true, installable: true, note: record.spec.signIn.note });
    return record.spec.resources;
  };
  assert.deepEqual(await read(), [], 'no login here: offered under「添加资源」');
  const file = join(m.kimiHome, 'credentials/kimi-code.json');
  await mkdir(dirname(file)); await writeFile(file, '{}');
  assert.deepEqual(await read(), [{ name: '登月者0448', identity: 'kimi:u1', values: [
    { label: '5 小时', value: '剩余 75%', fraction: 0.75, time: '2026-10-13T05:00:00.000Z' },
    { label: 'Extra Usage 余额', value: '剩余 16%', fraction: 0.16 }], buttons: [] }]);
  await read();
  assert.equal((await m.requests()).filter(r => r.url === '/api/v1/oauth/userinfo').length, 1, 'not asked again while the login stays as it was');
  const touch = async offset => utimes(file, new Date(), new Date(Date.now() + offset));
  // Kimi not saying who it is keeps the name seen last, but not the identity: the login changed, and the quota is of
  // whoever it is now. A login it refuses shows nothing.
  await m.setMode('nameless'); await touch(5000);
  const nameless = (await read())[0];
  assert.equal(nameless.name, '登月者0448');
  assert.equal(nameless.identity, undefined);
  await m.setMode('expired'); await touch(10000);
  assert.deepEqual([(await read())[0].values, (await read())[0].error], [[], '暂时无法获取额度：Kimi 没有给出额度']);
  await m.setMode('signed-out'); await touch(15000);
  assert.deepEqual(await read(), []);
  assert.ok(!JSON.stringify(await m.requests()).includes('SECRET@'), 'nothing of the account but what is shown');
});

test('a CLI that is gone, one that cannot be asked, or a login that cannot be read is one row saying so, and the sign-in is still in the record', async t => {
  // The CLI is looked for in the machine's own directory of the test and on a PATH of this Node alone.
  const records = async (m, extra = {}) => resourceRecords(pluginDir('kimi'), { env: { ...pluginEnv('kimi', { HOME: m.home, KIMI_CODE_HOME: '', ...extra }), PATH: await barePath(join(m.home, 'bare')) } }).then(([record]) => record.spec);
  // The CLI exits before it serves: the quota cannot be asked.
  const exits = await machine(t, 'exit');
  const asked = await records(exits);
  assert.deepEqual(asked.resources.map(r => [r.name, r.values, r.buttons, /^暂时无法读取 Kimi：.*提前退出/.test(r.error)]), [['Kimi', [], [], true]]);
  assert.equal(asked.signIn.installed, true);
  // No CLI: the sign-in is the way to get it.
  const gone = await machine(t, 'ok');
  await rm(gone.binary);
  const none = await records(gone);
  assert.deepEqual(none.resources, [{ name: 'Kimi', values: [], buttons: [], error: '这台机器上找不到 Kimi CLI，用「···」里的「重新登录」安装' }]);
  assert.equal(none.signIn.installed, false);
  // A login file that cannot even be looked at.
  const odd = await machine(t, 'ok', { signedIn: false });
  await writeFile(join(odd.home, 'file'), '');
  const unreadable = await records(odd, { KIMI_CODE_HOME: join(odd.home, 'file') });
  assert.deepEqual(unreadable.resources, [{ name: 'Kimi', values: [], buttons: [], error: '读不了 Kimi 的登录：ENOTDIR' }]);
});

