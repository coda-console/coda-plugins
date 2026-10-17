// The complete plugin lifecycle through the commands Coda runs: no external manager, Python, network or real login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { panelItems } from '../../../check/panel.mjs';
import { identity, list, tokens, selection, choose, remove, saveLogin } from '../../../plugins/codex-accounts/scripts/manager.mjs';
import { panel } from '../../../plugins/codex-accounts/scripts/quota.mjs';
import { AccountSource } from '../../../plugins/codex/agent/account-source.mjs';
import { declaredPanel, manifest, pluginEnv, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { substituted } from '../substitute.mjs';

const declared = declaredPanel('codex-accounts');
const sourceCommand = manifest('codex-accounts').contributes.extensions['codex/account-source'].command;
const fixture = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url));
const jwt = value => `x.${Buffer.from(JSON.stringify(value)).toString('base64url')}.x`;
const auth = (account, exp = Date.now() / 1000 + 3600) => ({ auth_mode: 'chatgpt', tokens: {
  access_token: jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'pro' } }),
  id_token: jwt({ email: `${account}@example.com` }), refresh_token: `PRIVATE-REFRESH-${account}`, account_id: account,
} });
const takes = value => panelItems(JSON.stringify(value), declared);
async function until(fn) { for (let i = 0; i < 1000; i++) { if (await fn()) return; await delay(10); } throw Error('timed out'); }
async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coda-owned-accounts-'))), state = join(dir, 'state'), native = join(dir, 'native'), log = join(dir, 'events.jsonl');
  await mkdir(state); await mkdir(native);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = { state, native };
  const env = extra => pluginEnv('codex-accounts', { ...substituted({ '@openai/codex/bin/codex.js': fixture }),
    CODA_PLUGIN_STATE: state, CODEX_HOME: native, CODA_PLUGIN_DEPENDENCIES: JSON.stringify({ codex: pluginDir('codex') }), FAKE_LOG: log, ...extra });
  const exec = (command, extra) => run(command, env(extra));
  const login = (account, extra) => exec(declared.signIn.command, { FAKE_ACCOUNT: account, ...extra });
  const home = account => join(state, 'accounts', identity(account));
  const events = async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const source = (extra = {}) => {
    const source = new AccountSource({ command: sourceCommand, path: pluginDir('codex-accounts'), state },
      { env: { ...env(extra), CODA_PLUGIN_PATH: pluginDir('codex'), CODA_PLUGIN_DEPENDENCIES: undefined } });
    t.after(() => source.close()); return source;
  };
  return { dir, state, native, at, env, exec, login, home, events, source };
}

test('a clean installation offers Coda login without an external account library or native-login option', async t => {
  const f = await setup(t);
  assert.deepEqual(await list(f.at), []);
  assert.ok(declared.signIn?.command); assert.equal(declared.signIn.installed, undefined);
  const result = await f.exec(declared.command);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { items: [] });
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
  const view = JSON.parse((await g.exec(declared.command)).stdout);
  assert.ok(view.items.some(i => i.type === 'error')); takes(view);
});

test('device login adds accounts, re-login updates by identity, and failed login preserves accounts and selection', async t => {
  const f = await setup(t);
  const first = await f.login('first', { OPENAI_API_KEY: 'UNRELATED-KEY', CODEX_ACCESS_TOKEN: 'UNRELATED-TOKEN' });
  assert.equal(first.code, 0, first.stderr); assert.match(first.stdout, /https:\/\/auth.openai.com\/codex\/device/); assert.match(first.stdout, /ABCD-12345/);
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
  assert.ok(!first.stdout.includes('PRIVATE-REFRESH')); assert.ok(!JSON.stringify(await list(f.at)).includes('PRIVATE-REFRESH'));
});

test('cancelling device login cleans its attempt and leaves no account behind', async t => {
  const f = await setup(t), confirmation = join(f.dir, 'never-confirmed');
  const child = spawn('/bin/sh', ['-c', declared.signIn.command], { env: f.env({ FAKE_CONFIRM: confirmation }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  let output = ''; child.stdout.on('data', c => { output += c; });
  const ended = new Promise(resolve => child.on('close', resolve));
  await until(() => output.includes('ABCD-12345'));
  process.kill(-child.pid, 'SIGTERM'); await ended;
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

test('the panel shows only managed accounts, with a selection and removal action; failed quota stays on its own card', async () => {
  const accounts = [{ alias: 'work', identity: 'w', plan: 'pro' }, { alias: 'home', identity: 'h', plan: 'plus' }];
  const early = Date.UTC(2026, 9, 20, 1) / 1000;
  const read = async a => {
    if (a.identity === 'h') throw Error('请重新登录');
    return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'c1', status: 'available', resetType: 'codexRateLimits', expiresAt: early }] } };
  };
  const view = await panel(accounts, 'w', read), cards = view.items.filter(i => i.type === 'card'); takes(view);
  assert.deepEqual(cards.map(c => c.title), ['work', 'home']);
  // Without an email who it is is not known: no identity for Coda's group view to merge on.
  assert.deepEqual(cards.map(c => c.identity), [undefined, undefined]);
  // With one, who and which workspace (the manager's identity, the workspace's account ID hashed), as the Codex panel
  // says the same login: one person in one workspace, the same on every machine.
  const named = (await panel([{ alias: 'Me@Example.com', identity: '6941a40c68883449343dbf6ec558673ef50f456eead61cb4fa7ea9c519ee63aa', plan: 'pro' }], null, read)).items.find(i => i.type === 'card');
  assert.equal(named.identity, 'codex:4f8c8f70fdb1a82f325caca6fccb78690831f66027018f748a0c7141a6d929a3');
  const colleague = (await panel([{ alias: 'colleague@example.com', identity: '6941a40c68883449343dbf6ec558673ef50f456eead61cb4fa7ea9c519ee63aa', plan: 'pro' }], null, read)).items.find(i => i.type === 'card');
  assert.notEqual(colleague.identity, named.identity);
  assert.equal(cards[0].items[0].label, '已选择'); assert.equal(cards[0].items[0].disabled, true);
  assert.ok(cards.every(c => c.items.some(i => i.action === 'remove')));
  assert.ok(cards[0].items.some(i => i.action === 'reset' && i.args.creditId === 'c1'));
  assert.ok(cards[1].items.some(i => i.type === 'error'));
  const many = Array.from({ length: 60 }, (_, i) => ({ alias: `account-${i}`, identity: `i${i}`, plan: 'pro' }));
  const big = await panel(many, null, async () => ({ rateLimitResetCredits: { availableCount: 30, credits: Array.from({ length: 30 }, (_, i) =>
    ({ id: `c${i}`, status: 'available', resetType: 'codexRateLimits', expiresAt: early })) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < 64 * 1024);
  const count = takes(big).filter(type => type === 'card').length;
  assert.deepEqual(big.items.at(-1), { type: 'markdown', text: `另有 ${60 - count} 个账号没有列出` });
});

test('panel commands switch only to a checked account, reset its quota, and remove its credentials', async t => {
  const f = await setup(t); await f.login('first'); await f.login('second');
  const read = await f.exec(declared.command); assert.equal(read.code, 0, read.stderr);
  const view = JSON.parse(read.stdout); takes(view);
  assert.ok(view.items.filter(i => i.type === 'card').every(c => c.items.some(i => i.type === 'meter' && i.value === '剩余 50%')));
  const select = account => f.exec(declared.actions.select.command, { CODA_PANEL_ARGS: JSON.stringify({ account: identity(account) }) });
  assert.equal((await select('second')).code, 0); assert.equal(selection(f.at), identity('second'));
  const refused = await f.exec(declared.actions.select.command, { CODA_PANEL_ARGS: JSON.stringify({ account: identity('first') }), FAKE_REFUSE: '1' });
  assert.equal(refused.code, 1); assert.equal(selection(f.at), identity('second'));
  const reset = await f.exec(declared.actions.reset.command, { CODA_PANEL_ARGS: JSON.stringify({ account: identity('first'), creditId: 'c1' }) });
  assert.equal(reset.code, 0, reset.stderr);
  const resets = (await f.events()).filter(e => e.method === 'account/rateLimitResetCredit/consume');
  assert.deepEqual(resets.map(e => [e.credit, e.home]), [['c1', f.home('first')]]);
  const removed = await f.exec(declared.actions.remove.command, { CODA_PANEL_ARGS: JSON.stringify({ account: identity('second') }) });
  assert.equal(removed.code, 0, removed.stderr); assert.equal(selection(f.at), null);
  assert.equal(existsSync(f.home('second')), false); await assert.rejects(f.source().selected(), /添加或选择/);
});

test('the real bridge imports and hands the managed account to Codex before a turn', async t => {
  const f = await setup(t); await writeFile(join(f.native, 'auth.json'), JSON.stringify(auth('existing')));
  const extensions = { 'account-source': [{ plugin: 'codex-accounts', command: sourceCommand, path: pluginDir('codex-accounts'), state: f.state }] };
  const bridge = spawn(process.execPath, [join(pluginDir('codex'), 'agent/accounts.mjs'), 'app-server'], {
    env: { ...f.env(), CODA_PLUGIN_PATH: pluginDir('codex'), CODA_PLUGIN_EXTENSIONS: JSON.stringify(extensions) }, stdio: ['pipe', 'pipe', 'pipe'] });
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

test('installing the source hides the built-in quota board, guards stale resets, and delegates its login entry', async t => {
  const f = await setup(t), original = JSON.stringify(auth('existing'));
  await writeFile(join(f.native, 'auth.json'), original);
  const native = declaredPanel('codex', 'login');
  const extensions = { 'account-source': [{ plugin: 'codex-accounts', command: sourceCommand, path: pluginDir('codex-accounts'), state: f.state }] };
  const env = { ...f.env(), CODA_PLUGIN_PATH: pluginDir('codex'), CODA_PLUGIN_EXTENSIONS: JSON.stringify(extensions) };
  const hidden = await run(native.command, env);
  assert.equal(hidden.code, 0, hidden.stderr); assert.deepEqual(JSON.parse(hidden.stdout), { items: [] });
  assert.deepEqual(await f.events(), [], 'hidden native board never queries the old login');
  const staleReset = await run(native.actions.reset.command, { ...env, CODA_PANEL_ARGS: JSON.stringify({ creditId: 'old-credit' }) });
  assert.equal(staleReset.code, 1); assert.match(staleReset.stderr, /已由账号插件接管/); assert.deepEqual(await f.events(), []);
  const delegated = await run(native.signIn.command, { ...env, FAKE_ACCOUNT: 'second' });
  assert.equal(delegated.code, 0, delegated.stderr);
  assert.deepEqual((await list(f.at)).map(a => a.alias), ['existing@example.com', 'second@example.com']);
  assert.equal(await readFile(join(f.native, 'auth.json'), 'utf8'), original);
  const restored = await run(native.command, { ...env, CODA_PLUGIN_EXTENSIONS: '{}' });
  assert.equal(restored.code, 0, restored.stderr); assert.equal(JSON.parse(restored.stdout).items[0].title, 'existing@example.com');
});

test('an unreadable old login does not prevent signing in directly through the plugin', async t => {
  const f = await setup(t); await writeFile(join(f.native, 'auth.json'), '{broken');
  await assert.rejects(list(f.at), /无法导入已有/);
  const login = await f.login('first'); assert.equal(login.code, 0, login.stderr);
  assert.equal((await list(f.at))[0].alias, 'first@example.com');
  assert.equal(await readFile(join(f.native, 'auth.json'), 'utf8'), '{broken');
});
