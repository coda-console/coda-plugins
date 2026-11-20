// From codex-accounts 2.4.1's test/plugins/codex-accounts/accounts.test.mjs, now that its account management is the codex
// plugin's「多账号」(the setting `codex.multipleAccounts`): the complete lifecycle of the managed accounts through the commands
// Coda runs, no external manager, Python, network or real login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceRecords, resourceRecordsProblem } from '@coda-console/plugin-check/resources';
import { identity, list, tokens, selection, chosen, choose, remove, saveLogin } from '../../../plugins/codex/scripts/manager.mjs';
import { SignInAgain, managedResources as resources } from '../../../plugins/codex/scripts/quota.mjs';
import { endWait, fakeCoda, manifest, operation, pluginEnv, probed } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { substitute, substituted } from '../substitute.mjs';

// The operation's file, as the manifest names it: the record offers the sign-in, which is run by this.
const signInCommand = manifest('codex').contributes.protocolImplementations.find(one => one.kind === 'coda/resource@1').commands['sign-in'];
const fixture = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url));
// The Codex the manager starts in this process, as in the plugin's commands: the fixture.
substitute({ '@openai/codex/bin/codex.js': fixture });
const on = JSON.stringify({ 'codex.multipleAccounts': true });
const jwt = value => `x.${Buffer.from(JSON.stringify(value)).toString('base64url')}.x`;
const auth = (account, exp = Date.now() / 1000 + 3600) => ({ auth_mode: 'chatgpt', tokens: {
  access_token: jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'pro' } }),
  id_token: jwt({ email: `${account}@example.com` }), refresh_token: `PRIVATE-REFRESH-${account}`, account_id: account,
} });
// What the host finds wrong in a reading as the record of the type, or null.
const problem = value => resourceRecordsProblem([{ key: 'accounts', spec: { type: 'accounts', title: 'Codex', ...value } }]);
async function until(fn) { for (let i = 0; i < 1000; i++) { if (await fn()) return; await delay(10); } throw Error('timed out'); }
async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coda-owned-accounts-'))), plugin = join(dir, 'state'), native = join(dir, 'native'), log = join(dir, 'events.jsonl');
  // The managed accounts are kept below the plugin's state directory.
  const state = join(plugin, 'accounts');
  await mkdir(state, { recursive: true }); await mkdir(native);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = extra => pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': fixture }),
    CODA_PLUGIN_STATE: plugin, CODA_PLUGIN_SETTINGS: on, CODEX_HOME: native, FAKE_LOG: log, ...extra });
  // Where the manager keeps them, and what the Codex it starts is given (`extra`, to the fixture).
  const at = { state, native, env: env() }, atWith = extra => ({ ...at, env: env(extra) });
  // The managed accounts' record, as the plugin's command prints it.
  const record = async extra => (await resourceRecords(pluginDir('codex'), { env: env(extra) })).find(one => one.key === 'accounts');
  // An action of a button, as Coda runs the `act` operation.
  const act = (action, args, extra) => operation(t, 'codex', 'scripts/act.mjs', env(extra), { action, args });
  // The sign-in as Coda runs it, with a `coda` that notes what it reports: how it ended, what it printed, and what it reported.
  const login = async (account, extra) => {
    // A silent login's wait for its link ends when the test says, once the login has read what the CLI said (not by the clock).
    const watch = { ack: join(dir, 'ack'), gate: join(dir, 'gate') }, made = env({ FAKE_ACCOUNT: account, ...extra });
    const coda = await fakeCoda(dir, extra?.FAKE_SILENT ? probed(made, watch) : made), run = operation(t, 'codex', signInCommand, coda.env);
    if (extra?.FAKE_SILENT) await endWait(watch, 'Contacting OpenAI...');
    return { code: await run.ended, stdout: run.stdout, stderr: run.stderr, reported: await coda.calls() };
  };
  const home = account => join(state, 'accounts', identity(account));
  const events = async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  // What the account bridge asks of the managed accounts (agent/accounts.mjs), with `extra` given to the Codex it starts.
  const source = (extra = {}) => ({ selected: () => chosen(atWith(extra)), tokens: (account, { refresh = false } = {}) => tokens(account, atWith(extra), { refresh }) });
  return { dir, plugin, state, native, at, env, record, act, login, home, events, source };
}

test('turned on, a clean machine offers Coda login without an external account library or native-login option', async t => {
  const f = await setup(t);
  assert.deepEqual(await list(f.at), []);
  const { key, spec } = await f.record();
  assert.deepEqual([key, spec.type, spec.title, spec.resources], ['accounts', 'accounts', 'Codex', []]);
  assert.deepEqual([spec.signIn.installed, spec.signIn.installable, spec.signIn.input], [true, false, undefined], 'Codex comes with the plugin; nothing to install');
  await assert.rejects(f.source().selected(), /添加或选择/);
  await assert.rejects(choose('native', f.at), /尚未在插件中登录/);
  assert.deepEqual(await f.events(), [], 'no Codex processes needed to show an empty store');
});

test('the existing Codex login becomes the first ordinary account once, with private owned credentials', async t => {
  const f = await setup(t), original = JSON.stringify(auth('existing'));
  await writeFile(join(f.native, 'auth.json'), original);
  const accounts = await Promise.all([list(f.at), list(f.at)]);
  assert.deepEqual(accounts[0], [{ identity: identity('existing'), alias: 'existing@example.com', plan: 'pro' }]);
  assert.deepEqual(accounts[1], accounts[0]); assert.equal(selection(f.at), identity('existing'));
  assert.equal((await stat(f.home('existing'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.home('existing'), 'auth.json'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(f.native, 'auth.json'), 'utf8'), original, 'does not modify the original login');
  assert.equal((await tokens(identity('existing'), f.at)).chatgptAccountId, 'existing');
  await writeFile(join(f.native, 'auth.json'), JSON.stringify(auth('another-local-login')));
  assert.equal((await list(f.at))[0].alias, 'existing@example.com', 'later local switches do not replace managed credentials');
  await remove(identity('existing'), f.at);
  assert.deepEqual(await list(f.at), []); assert.equal(selection(f.at), null);
  assert.equal(existsSync(f.home('existing')), false);
  await assert.rejects(f.source().selected(), /添加或选择/, 'no fallback to a remaining native login');
});

test('an old native selection is adopted, while an unavailable explicit account is not silently replaced', async t => {
  const f = await setup(t);
  await writeFile(join(f.native, 'auth.json'), JSON.stringify(auth('first')));
  await writeFile(join(f.state, 'selection.json'), JSON.stringify({ account: 'native' }));
  await list(f.at); assert.equal(selection(f.at), identity('first'));
  const g = await setup(t);
  await writeFile(join(g.native, 'auth.json'), JSON.stringify(auth('first')));
  await writeFile(join(g.state, 'selection.json'), JSON.stringify({ account: identity('previous') }));
  await list(g.at); assert.equal(selection(g.at), identity('previous'));
  await assert.rejects(g.source().selected(), /所选账号尚未/);
  const { spec } = await g.record();
  assert.deepEqual(spec.resources[0], { name: '所选账号', values: [], buttons: [], error: '尚未在插件中登录：重新登录它，或切换到其他账号' });
});

test('device login adds accounts, re-login updates by identity, and failed login preserves accounts and selection', async t => {
  const f = await setup(t);
  const first = await f.login('first', { OPENAI_API_KEY: 'UNRELATED-KEY', CODEX_ACCESS_TOKEN: 'UNRELATED-TOKEN' });
  assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout, '{}\n');
  assert.deepEqual(first.reported, [{ command: 'progress', input: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' } }]);
  assert.equal(selection(f.at), identity('first'));
  assert.equal((await f.login('second')).code, 0);
  assert.equal(selection(f.at), identity('first'), 'adding does not switch away from the selection');
  assert.equal((await f.login('first', { FAKE_TOKEN_VERSION: 'updated' })).code, 0);
  assert.equal((await list(f.at)).length, 2);
  assert.match(await readFile(join(f.home('first'), 'auth.json'), 'utf8'), /PRIVATE-REFRESH-first-updated/);
  const failed = await f.login('third', { FAKE_LOGIN_FAIL: '1' }); assert.equal(failed.code, 1);
  assert.equal((await list(f.at)).length, 2); assert.equal(selection(f.at), identity('first'));
  assert.equal((await readdir(f.state)).some(n => n.startsWith('login-')), false, 'temporary login credentials are cleaned up');
  const events = await f.events();
  assert.ok(events.filter(e => e.mode === 'login').every(e => e.home.startsWith(f.state) && e.cwd === e.home && !e.inheritedCredentials));
  assert.ok(events.filter(e => e.mode === 'login').every(e => e.args.includes('cli_auth_credentials_store="file"')));
  assert.ok(!(first.stdout + first.stderr + JSON.stringify(first.reported)).includes('PRIVATE-REFRESH')); assert.ok(!JSON.stringify(await list(f.at)).includes('PRIVATE-REFRESH'));
});

test('cancelling device login cleans its attempt and leaves no account behind', async t => {
  const f = await setup(t), confirmation = join(f.dir, 'never-confirmed');
  const coda = await fakeCoda(f.dir, f.env({ FAKE_CONFIRM: confirmation })), run = operation(t, 'codex', 'scripts/sign-in.mjs', coda.env);
  await until(async () => (await coda.calls()).length);
  // Coda ends the whole group: the login's own cleanup is waited for.
  run.stop('SIGTERM'); assert.equal(await run.ended, 1);
  assert.deepEqual(await list(f.at), []);
  assert.equal((await readdir(f.state)).some(n => n.startsWith('login-')), false);
});

test('concurrent sessions renew an expired managed credential once and explicit rejection forces renewal', async t => {
  const f = await setup(t); assert.equal((await f.login('first')).code, 0);
  await writeFile(join(f.home('first'), 'auth.json'), JSON.stringify(auth('first', 0)));
  const a = f.source({ FAKE_REFRESH_DELAY: '180' }), b = f.source({ FAKE_REFRESH_DELAY: '180' });
  const result = await Promise.all([a.tokens(identity('first')), b.tokens(identity('first'))]);
  assert.ok(result.every(r => r.chatgptAccountId === 'first' && !JSON.stringify(r).includes('PRIVATE-REFRESH')));
  assert.equal((await f.events()).filter(e => e.refresh === true).length, 1);
  await a.tokens(identity('first'), { refresh: true });
  assert.equal((await f.events()).filter(e => e.refresh === true).length, 2, 'a still-valid but rejected access token is renewed');
  const refused = f.source({ FAKE_REFRESH_FAIL: '1' });
  await assert.rejects(refused.tokens(identity('first'), { refresh: true }), /登录已失效/);
  const wrong = f.source({ FAKE_REFRESH_ACCOUNT: 'another' });
  await assert.rejects(wrong.tokens(identity('first'), { refresh: true }), /登录已失效/);
  await assert.rejects(tokens(identity('first'), f.at), /登录已失效/, 'a changed identity is never handed out');
});

test('a login cancelled during verification is not committed', async t => {
  const f = await setup(t), attempt = join(f.dir, 'attempt'); await mkdir(attempt);
  await writeFile(join(attempt, 'auth.json'), JSON.stringify(auth('first')));
  let cancelled = false;
  await assert.rejects(saveLogin(attempt, f.at, { isCancelled: () => cancelled, makeServer: () => ({
    initialize: async () => {}, close: async () => {}, request: async () => {
      cancelled = true; return { account: { type: 'chatgpt', email: 'first@example.com' }, workspaceRouting: { chatgptAccountId: 'first' } };
    },
  }) }), /登录已取消/);
  assert.deepEqual(await list(f.at), []); assert.equal(existsSync(f.home('first')), false);
});

test('a stale credential lock recovers and unsafe auth files fail without exposing their content', async t => {
  const f = await setup(t); await f.login('first');
  const lock = join(f.state, 'locks', identity('first') + '.lock'); await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  assert.equal((await tokens(identity('first'), f.at)).chatgptAccountId, 'first');
  const file = join(f.home('first'), 'auth.json'); await rm(file); await symlink(join(f.native, 'auth.json'), file);
  await assert.rejects(tokens(identity('first'), f.at), /登录已失效/);
  await assert.rejects(remove('../native', f.at), /没有指明/);
});

test('the resources are only the managed accounts, with a selection and removal action; a login no good stays on its own row', async () => {
  const accounts = [{ alias: 'work', identity: 'w', plan: 'pro' }, { alias: 'home', identity: 'h', plan: 'plus' }];
  const early = Date.UTC(2026, 9, 20, 1) / 1000;
  const read = async a => {
    if (a.identity === 'h') throw new SignInAgain('请重新登录');
    return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'c1', status: 'available', resetType: 'codexRateLimits', expiresAt: early }] } };
  };
  const view = await resources(accounts, 'w', read), rows = view.resources;
  assert.equal(problem(view), null, 'rows the host takes');
  assert.deepEqual(rows.map(r => r.name), ['work', 'home']);
  // Without an email who it is is not known: no identity for Coda's group view to merge on.
  assert.deepEqual(rows.map(r => r.identity), [undefined, undefined]);
  // With one, who and which workspace (the manager's identity, the workspace's account ID hashed), as the Codex plugin
  // says the same login: one person in one workspace, the same on every machine.
  const named = (await resources([{ alias: 'Me@Example.com', identity: '6941a40c68883449343dbf6ec558673ef50f456eead61cb4fa7ea9c519ee63aa', plan: 'pro' }], null, read)).resources[0];
  assert.equal(named.identity, 'codex:4f8c8f70fdb1a82f325caca6fccb78690831f66027018f748a0c7141a6d929a3');
  const colleague = (await resources([{ alias: 'colleague@example.com', identity: '6941a40c68883449343dbf6ec558673ef50f456eead61cb4fa7ea9c519ee63aa', plan: 'pro' }], null, read)).resources[0];
  assert.notEqual(colleague.identity, named.identity);
  // The one sessions use says so; the others offer switching to them. No plan beside the name.
  assert.deepEqual(rows[0].values, [{ label: '状态', value: '正在使用' }, { label: '5 小时', value: '剩余 90%', fraction: 0.9 },
    { label: '完全重置', value: '剩余 1 次', time: new Date(early * 1000).toISOString() }]);
  assert.deepEqual(rows.map(r => r.buttons.map(a => a.label)), [['使用完全重置', '移除账号'], ['切换使用', '移除账号']]);
  assert.deepEqual(rows[0].buttons[0].args, { account: 'w', creditId: 'c1' });
  assert.equal(rows[1].error, '请重新登录');
  // Codex saying the login is no good is told so; any other failure of a reading fails them all, once every reading is ended.
  const refused = await resources(accounts, 'w', async a => { throw new Error('401 Unauthorized'); });
  assert.deepEqual(refused.resources.map(r => r.error), ['登录已失效，请重新登录：401 Unauthorized', '登录已失效，请重新登录：401 Unauthorized']);
  const ended = [];
  await assert.rejects(resources(accounts, 'w', async a => { if (a.identity === 'w') throw new Error('503 Service Unavailable'); await delay(20); ended.push(a.identity); return {}; }, { at: 2 }), { message: '503 Service Unavailable' });
  assert.deepEqual(ended, ['h'], 'the other reading was ended');
  // A quota with nothing in it fails the reading, not a row that would replace the one shown; the resets alone are kept.
  await assert.rejects(resources(accounts, 'w', async () => ({})), { message: '暂时无法获取额度：Codex 没有给出work的额度窗口' });
  const resetsOnly = await resources(accounts, null, async () => ({ rateLimitResetCredits: { availableCount: 0, credits: [] } }));
  assert.deepEqual(resetsOnly.resources.map(r => [r.values, r.error]), [[[{ label: '完全重置', value: '剩余 0 次' }], undefined], [[{ label: '完全重置', value: '剩余 0 次' }], undefined]]);
  const many = Array.from({ length: 60 }, (_, i) => ({ alias: `account-${i}`, identity: `i${i}`, plan: 'pro' }));
  const big = await resources(many, null, async () => ({ rateLimitResetCredits: { availableCount: 30, credits: Array.from({ length: 30 }, (_, i) =>
    ({ id: `c${i}`, status: 'available', resetType: 'codexRateLimits', expiresAt: early })) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < 64 * 1024);
  assert.equal(big.resources.length, 40, 'as many as a record holds');
  assert.equal(problem(big), null);
});

test('the type\'s commands switch only to a checked account, reset its quota, and remove its credentials', async t => {
  const f = await setup(t); await f.login('first'); await f.login('second');
  const { spec } = await f.record();
  assert.ok(spec.resources.every(r => r.values.some(v => v.value === '剩余 50%')));
  assert.deepEqual(spec.resources.map(r => r.buttons.map(b => b.action)), [['remove'], ['select', 'remove']], 'the first account is the one in use: only the other can be switched to');
  const select = account => f.act('select', { account: identity(account) });
  const selected = select('second');
  assert.equal(await selected.ended, 0, selected.stderr); assert.equal(selected.stdout, '{}\n'); assert.equal(selection(f.at), identity('second'));
  const refused = f.act('select', { account: identity('first') }, { FAKE_REFUSE: '1' });
  assert.equal(await refused.ended, 1); assert.match(refused.stderr, /^切换失败：/); assert.equal(selection(f.at), identity('second'));
  const reset = f.act('reset', { account: identity('first'), creditId: 'c1' });
  assert.equal(await reset.ended, 0, reset.stderr);
  const resets = (await f.events()).filter(e => e.method === 'account/rateLimitResetCredit/consume');
  assert.deepEqual(resets.map(e => [e.credit, e.home]), [['c1', f.home('first')]]);
  const removed = f.act('remove', { account: identity('second') });
  assert.equal(await removed.ended, 0, removed.stderr); assert.equal(selection(f.at), null);
  assert.equal(existsSync(f.home('second')), false); await assert.rejects(f.source().selected(), /添加或选择/);
  // What it has no action for, or names no account for, is said in a line and changes nothing.
  const unknown = f.act('launch', {});
  assert.deepEqual([await unknown.ended, unknown.stderr.trim()], [1, '不认识的动作：launch']);
  const unnamed = f.act('reset', {});
  assert.deepEqual([await unnamed.ended, unnamed.stderr.trim()], [1, '没有指明用哪个账号的哪一次完全重置']);
});

test('the real bridge imports and hands the managed account to Codex before a turn', async t => {
  const f = await setup(t); await writeFile(join(f.native, 'auth.json'), JSON.stringify(auth('existing')));
  const bridge = spawn(process.execPath, [join(pluginDir('codex'), 'agent/accounts.mjs'), 'app-server'], { env: f.env(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => bridge.kill());
  let buffer = ''; const answers = [];
  bridge.stdout.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0;) { answers.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const ask = async m => { bridge.stdin.write(JSON.stringify(m) + '\n'); await until(() => answers.some(a => a.id === m.id)); return answers.find(a => a.id === m.id); };
  await ask({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
  assert.deepEqual((await ask({ id: 'turn', method: 'turn/start', params: { threadId: 'thread' } })).result, { turn: { id: 't1' } });
  const methods = (await f.events()).filter(e => e.method);
  assert.deepEqual(methods.slice(0, 5).map(e => e.method), ['initialize', 'initialized', 'account/login/start', 'account/read', 'turn/start']);
  assert.equal(methods[2].account, 'existing');
  assert.equal(selection(f.at), identity('existing')); assert.ok(!JSON.stringify(answers).includes('PRIVATE-REFRESH'));
});

test('turned on, the own login shows none and its reset is gone, its login entry adds an account; turned off, the own login is back', async t => {
  const f = await setup(t), original = JSON.stringify(auth('existing'));
  await writeFile(join(f.native, 'auth.json'), original);
  const codex = pluginDir('codex'), env = f.env();
  const [own, accounts, ...more] = await resourceRecords(codex, { env });
  assert.deepEqual([own.key, accounts.key, more], ['login', 'accounts', []]);
  assert.deepEqual(own.spec.resources, []); assert.equal(own.spec.signIn.installed, true, 'its login stays offered');
  assert.deepEqual(accounts.spec.resources.map(r => r.name), ['existing@example.com'], 'the existing login is imported as the first account');
  assert.ok((await f.events()).every(e => e.home !== f.native), 'the own login is never queried');
  // A reset of the own login's row is one of a managed account's, which names none.
  const staleReset = operation(t, 'codex', 'scripts/act.mjs', env, { action: 'reset', args: { creditId: 'old-credit' } });
  assert.deepEqual([await staleReset.ended, staleReset.stderr.trim()], [1, '没有指明用哪个账号的哪一次完全重置']);
  assert.equal((await f.events()).some(e => e.method === 'account/rateLimitResetCredit/consume'), false);
  const coda = await fakeCoda(f.dir, { ...env, FAKE_ACCOUNT: 'second' }), delegated = operation(t, 'codex', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await delegated.ended, 0, delegated.stderr);
  assert.deepEqual((await coda.calls()).map(call => [call.command, call.input.code]), [['progress', 'ABCD-12345']], 'the link and code reach Coda through the plugin\'s own CLI');
  assert.deepEqual((await list(f.at)).map(a => a.alias), ['existing@example.com', 'second@example.com']);
  assert.equal(await readFile(join(f.native, 'auth.json'), 'utf8'), original);
  const off = await resourceRecords(codex, { env: { ...env, CODA_PLUGIN_SETTINGS: '{}' } });
  assert.deepEqual(off.map(one => [one.key, one.spec.resources[0].name]), [['login', 'existing@example.com']]);
  // Nor does it take the managed accounts' actions.
  const select = operation(t, 'codex', 'scripts/act.mjs', { ...env, CODA_PLUGIN_SETTINGS: '{}' }, { action: 'select', args: { account: identity('second') } });
  assert.deepEqual([await select.ended, select.stderr.trim()], [1, '不认识的动作：select']);
});

test('turned off, a reset left on a managed account\'s row is refused before anything is redeemed', async t => {
  const f = await setup(t); assert.equal((await f.login('first')).code, 0);
  const off = { CODA_PLUGIN_SETTINGS: '{}' };
  const stale = f.act('reset', { account: identity('first'), creditId: 'c1' }, off);
  assert.deepEqual([await stale.ended, stale.stderr.trim()], [1, '多账号已关闭，这个账号的操作不可用']);
  assert.equal((await f.events()).some(e => e.method === 'account/rateLimitResetCredit/consume'), false, 'neither with this machine\'s login nor the account\'s');
});

test('installed where the path has a space (Application Support), the managed accounts start the plugin\'s Codex', async t => {
  const f = await setup(t), spaced = join(f.dir, 'Application Support', 'codex.mjs');
  await mkdir(join(f.dir, 'Application Support')); await copyFile(fixture, spaced);
  const there = substituted({ '@openai/codex/bin/codex.js': spaced });
  const signed = await f.login('first', there);
  assert.equal(signed.code, 0, signed.stderr);
  const { spec } = await f.record(there);
  assert.deepEqual(spec.resources.map(r => [r.name, r.values.some(v => v.value === '剩余 50%')]), [['first@example.com', true]]);
});

test('an unreadable old login does not prevent signing in directly through the plugin', async t => {
  const f = await setup(t); await writeFile(join(f.native, 'auth.json'), '{broken');
  await assert.rejects(list(f.at), /无法导入已有/);
  // The record is still written, with the reason on a row and the sign-in offered: the way out is entered from it.
  const { spec } = await f.record();
  assert.deepEqual(spec.resources.map(r => [r.name, r.values, r.buttons, r.error.startsWith('无法导入已有 Codex 登录')]), [['Codex 账号', [], [], true]]);
  assert.deepEqual([spec.signIn.installed, spec.signIn.installable], [true, false]);
  const login = await f.login('first'); assert.equal(login.code, 0, login.stderr);
  assert.equal((await list(f.at))[0].alias, 'first@example.com');
  assert.equal(await readFile(join(f.native, 'auth.json'), 'utf8'), '{broken');
});

test('what only signing in again cures is on the account\'s row, with the sign-in in the record; any other failure after a reading that went well fails the command, with the reason', async t => {
  const f = await setup(t); assert.equal((await f.login('first')).code, 0);
  assert.equal((await f.record()).spec.resources[0].error, undefined);
  // Codex saying the login is no good, and the account's own credentials gone bad.
  const refused = (await f.record({ FAKE_RATE_ERROR: '401 Unauthorized' })).spec;
  assert.equal(refused.resources[0].error, '登录已失效，请重新登录：401 Unauthorized');
  assert.equal(refused.signIn.installed, true);
  const credentials = join(f.home('first'), 'auth.json'), good = await readFile(credentials, 'utf8');
  await writeFile(credentials, '{broken');
  const unreadable = (await f.record()).spec;
  assert.match(unreadable.resources[0].error, /账号登录已失效，请在「资源」重新登录该账号/);
  assert.equal(unreadable.signIn.installed, true);
  await writeFile(credentials, good);
  // Anything else: the network, a server's error, a store that cannot be read.
  await assert.rejects(f.record({ FAKE_RATE_ERROR: '503 Service Unavailable' }), { message: '503 Service Unavailable' });
  await writeFile(join(f.state, 'accounts.json'), '{broken');
  await assert.rejects(f.record(), { message: '读不了插件保存的账号列表' });
});

test('the device login of the own login settles this one too: no link in time ends it with what Codex said, nothing kept', async t => {
  const f = await setup(t), login = await f.login('first', { FAKE_SILENT: '1' });
  assert.equal(login.code, 1); assert.equal(login.stdout, '');
  assert.equal(login.stderr.trim(), 'Contacting OpenAI...');
  assert.deepEqual(login.reported, []);
  assert.deepEqual(await list(f.at), [], 'no account');
  assert.equal((await readdir(f.state)).some(n => n.startsWith('login-')), false, 'the attempt\'s private home is cleaned up');
});
