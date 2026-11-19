// The「Grok Bot」type's sign-in (scripts/sign-in.mjs, the `sign-in` operation of `coda/resource@1`) and its record (scripts/resource.mjs)
// run as Coda runs them, with a `coda` standing in for Coda's own and a native server that answers the login's polling: not
// confirmed (404) until the test says it is (a file), whatever the clock; its two second pause between polls is shortened, which
// changes nothing of what it waits for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resourceRecords, runResourceCommand } from '../../../check/resources.mjs';
import { fakeCoda, operation, pluginEnv } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1);

// A directory to work in, with a preload that stands in for the network: `/auth/poll` is 404 until `confirmed` is there, then the
// login (500 for TEST_POLL_FAIL), and is noted in the file `polled`; TEST_UNAUTHORIZED answers every other request 401. TEST_SLOW
// answers none (`all`) or none but the renewal's own 401 (`renewal`: the account's request is refused, the renewal never answers) before
// the reading's time is up, which is shortened to a moment, as it is the case that tests it. TEST_BOTS answers the account and a
// list of that many Bots, and notes the list in the file `listed`.
async function machine(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coda-grok-bot-sign-in-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, 'preload.mjs');
  await writeFile(preload, `import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const set = globalThis.setTimeout, timeout = AbortSignal.timeout;
globalThis.setTimeout = (fn, ms, ...args) => set(fn, ms === 2000 ? 5 : ms, ...args);
AbortSignal.timeout = ms => timeout.call(AbortSignal, ms === 20_000 ? 100 : ms);
// A request that is not answered, as a socket is not: it keeps the process going, and ends when its signal does.
const hang = signal => new Promise((_, reject) => {
  const keep = setInterval(() => {}, 1000);
  signal.addEventListener('abort', () => { clearInterval(keep); reject(signal.reason); }, { once: true });
});
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (process.env.TEST_SLOW === 'all' || (process.env.TEST_SLOW === 'renewal' && path === '/oauth/token')) return hang(options.signal);
  if (process.env.TEST_SLOW === 'renewal') return new Response('{}', { status: 401 });
  if (process.env.TEST_BOTS) {
    if (path.endsWith('/GetMe')) return Response.json({ authId: 'account' });
    appendFileSync(join(process.env.TEST_DIR, 'listed'), 'x');
    return Response.json({ agents: Array.from({ length: Number(process.env.TEST_BOTS) }, (_, i) => ({ agentId: \`bot-\${i}\`, name: \`Bot \${i}\` })) });
  }
  if (path !== '/auth/poll') return new Response('{}', { status: process.env.TEST_UNAUTHORIZED ? 401 : 500 });
  appendFileSync(join(process.env.TEST_DIR, 'polled'), 'x');
  if (process.env.TEST_POLL_FAIL) return new Response('{}', { status: 500 });
  return existsSync(join(process.env.TEST_DIR, 'confirmed')) ? Response.json({ accessToken: 'fixture-access' }) : new Response('{}', { status: 404 });
};
`);
  const env = extra => pluginEnv('grok-bot', { TEST_DIR: dir, CODA_PLUGIN_STATE: dir, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ...extra });
  return { dir, env, confirm: () => writeFile(join(dir, 'confirmed'), '') };
}
const reported = async coda => { for (let i = 0; i < 1000; i++) { const calls = await coda.calls(); if (calls.length) return calls; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('没等到登录报告'); };

test('the sign-in reports the official link, polls until it is confirmed, and keeps the login privately in the plugin\'s state', async t => {
  const { dir, env, confirm } = await machine(t), coda = await fakeCoda(dir, env());
  const login = operation(t, 'grok-bot', 'scripts/sign-in.mjs', coda.env);
  const [call] = await reported(coda);
  assert.equal(call.command, 'progress');
  assert.equal(new URL(call.input.url).hostname, 'cursor.com');
  assert.deepEqual(Object.keys(call.input), ['url']);
  assert.equal(existsSync(join(dir, 'native-auth.json')), false, 'not kept before it is confirmed');
  await confirm();
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal(login.stdout, '{}\n');
  assert.equal(JSON.parse(await readFile(join(dir, 'native-auth.json'), 'utf8')).accessToken, 'fixture-access');
  assert.equal((await stat(join(dir, 'native-auth.json'))).mode & 0o777, 0o600);
  assert.equal((await coda.calls()).length, 1, 'once');
});

test('a report that fails fails the login before anything is polled for or kept: the credentials are as they were, the old ones still there', async t => {
  const { dir, env, confirm } = await machine(t), coda = await fakeCoda(dir, env({ FAKE_CODA_FAIL: 'progress' }));
  // The page would be confirmed at the first poll, but there is none.
  await confirm();
  const old = JSON.stringify({ accessToken: 'old-account', refreshToken: 'old-refresh' });
  const kept = join(dir, 'native-auth.json');
  const first = operation(t, 'grok-bot', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await first.ended, 1);
  assert.equal(first.stdout, '');
  assert.equal(lastLine(first.stderr), 'coda progress 没有成功');
  assert.equal(existsSync(kept), false, 'no credentials written where there were none');
  await writeFile(kept, old);
  const second = operation(t, 'grok-bot', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await second.ended, 1);
  assert.equal(await readFile(kept, 'utf8'), old);
  assert.equal(existsSync(join(dir, 'polled')), false, 'the page was not even polled');
});

test('a login the server refuses fails with its own line, after the link has been reported', async t => {
  const { dir, env } = await machine(t), coda = await fakeCoda(dir, env({ TEST_POLL_FAIL: '1' }));
  const login = operation(t, 'grok-bot', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), '登录失败 HTTP 500；请在资源页重试');
  assert.equal((await coda.calls()).length, 1);
});

test('without a state directory to keep the login in, the sign-in says so', async t => {
  const { dir, env } = await machine(t), coda = await fakeCoda(dir, env({ CODA_PLUGIN_STATE: undefined }));
  delete coda.env.CODA_PLUGIN_STATE;
  const login = operation(t, 'grok-bot', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 1);
  assert.equal(lastLine(login.stderr), '缺少 CODA_PLUGIN_STATE，无法保存登录');
  assert.deepEqual(await coda.calls(), []);
});

test('the record has no resource without a login, and a login that cannot be read or is refused is one row saying so, the sign-in still in it', async t => {
  const { dir, env } = await machine(t);
  const read = async extra => (await resourceRecords(pluginDir('grok-bot'), { env: env(extra) }))[0].spec;
  const none = await read();
  assert.deepEqual(none.resources, []);
  assert.deepEqual(none.signIn, { installed: true, installable: false, note: none.signIn.note });
  // A login file that has no token: the plugin cannot read it, and says so; signing in again is how it is replaced.
  await writeFile(join(dir, 'native-auth.json'), '{}');
  assert.deepEqual((await read()).resources, [{ name: 'Grok Bot', values: [], buttons: [], error: '登录响应缺少 accessToken' }]);
  // A login the server refuses, with nothing to renew it with.
  await writeFile(join(dir, 'native-auth.json'), JSON.stringify({ accessToken: 'old' }));
  const refused = await read({ TEST_UNAUTHORIZED: '1' });
  assert.deepEqual(refused.resources, [{ name: 'Grok Bot', values: [], buttons: [], error: '请重新登录' }]);
  assert.equal(refused.signIn.installed, true);
});

test('a reading that cannot be had within its time fails the command with the reason: the account, the Bots and a renewal share the time', async t => {
  const { dir, env } = await machine(t);
  await writeFile(join(dir, 'native-auth.json'), JSON.stringify({ accessToken: 'old', refreshToken: 'refresh' }));
  for (const slow of ['all', 'renewal']) await assert.rejects(resourceRecords(pluginDir('grok-bot'), { env: env({ TEST_SLOW: slow }) }), { message: '读取超时' }, slow);
});

test('a reading that fails for any other reason, after one that went well, fails the command with the reason, keeping the record Coda has', async t => {
  const { dir, env } = await machine(t);
  await writeFile(join(dir, 'native-auth.json'), JSON.stringify({ accessToken: 'fixture-access' }));
  const read = extra => resourceRecords(pluginDir('grok-bot'), { env: env(extra) });
  assert.equal((await read({ TEST_BOTS: '2' }))[0].spec.resources.length, 2);
  // The server answers 500 to the account's request.
  await assert.rejects(read(), { message: /^GetMe: HTTP 500/ });
});

test('a record of hundreds of Bots reaches a host that is slow to read it whole: the command ends only once all of it is written', async t => {
  const { dir, env } = await machine(t);
  await writeFile(join(dir, 'native-auth.json'), JSON.stringify({ accessToken: 'fixture-access' }));
  // Far more than a pipe holds unread (64 KiB), so the most of it is still queued in the command when it has printed it.
  const bots = 800;
  const ran = runResourceCommand(pluginDir('grok-bot'), 'scripts/resource.mjs', env({ TEST_BOTS: String(bots) }));
  // The host reads nothing for a while (it is busy): until the list has been had, and a moment after it to print it in.
  const busy = (until, ms) => { const end = Date.now() + ms; while (!until() && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
  busy(() => existsSync(join(dir, 'listed')), 10_000);
  busy(() => false, 300);
  const { result, error } = await ran;
  assert.equal(error, undefined);
  assert.equal(result[0].spec.resources.length, bots);
  assert.deepEqual(result[0].spec.resources.at(-1).name, `Bot ${bots - 1}`);
});
