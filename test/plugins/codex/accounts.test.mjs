// From Coda's backend/test/codex-accounts.test.mjs at 9ffb9911, as plain node:test: its cases of the bridge alone. The bridge
// with codex-accounts' source and a Codex CLI is in codex-accounts/accounts.test.mjs.
// The codex plugin's account bridge (agent/accounts.mjs): between codex-acp and the app-server, it signs Codex in to the
// account the source plugged into `account-source` chooses, at a session's boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startAccountBridge } from '../../../plugins/codex/agent/accounts.mjs';

async function until(fn) { for (let i = 0; i < 1000; i++) { if (await fn()) return; await delay(10); } throw Error('timed out'); }
const turns = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

// A bridge between a fake codex-acp (`send`) and a fake app-server, asking a fake source. `choose` is what the source says
// is chosen; `hooks.tokens` and `hooks.login` may be replaced to hold or fail what they do; `late` is whatever the server
// is asked once it is closed.
async function bridgeFixture(t, chosen = null) {
  const input = new PassThrough(), outputs = [], sent = [], logins = [], late = [];
  const accounts = { a: { id: 'a', name: 'a' }, b: { id: 'b', name: 'b' }, native: { id: 'native', name: '本机登录' } };
  let choice = chosen, signedIn = null, incoming, closeServer, closed = false;
  const hooks = { tokens: async id => ({ accessToken: `SECRET-${id}`, chatgptAccountId: `${id}-account` }), login: async () => {} };
  const source = { selected: async () => { if (choice === 'gone') throw Error('账号来源没有答复'); return choice && accounts[choice]; }, tokens: (id, options) => hooks.tokens(id, options), close() {} };
  const fake = {
    send: value => { if (closed) late.push(value); sent.push(value); },
    request: async (method, params) => {
      if (closed) late.push({ method });
      if (method === 'account/login/start') { await hooks.login(params); logins.push(params.chatgptAccountId.replace(/-account$/, '')); signedIn = params.chatgptAccountId; return {}; }
      if (method === 'account/read') return { account: { type: 'chatgpt' }, workspaceRouting: { chatgptAccountId: signedIn } };
      return {};
    },
    exited: new Promise(resolve => { closeServer = resolve; }), close: async () => { closed = true; closeServer(); } };
  const bridge = startAccountBridge({ source, input, output: value => outputs.push(value), makeServer: ({ onMessage }) => { incoming = onMessage; return fake; } });
  t.after(() => bridge.close());
  const send = async (method, params = {}, id = method) => { input.write(JSON.stringify({ id, method, params }) + '\n'); await bridge.settled(); };
  await send('initialize'); incoming({ id: 'initialize', result: {} }); await bridge.settled();
  return { bridge, fake, incoming: message => incoming(message), send, sent, outputs, logins, late, hooks, choose: value => { choice = value; } };
}
const error = (f, id) => f.outputs.find(m => m.id === id)?.error;

test('the bridge switches within the same process and thread, defers busy turns, renews without leaking tokens and blocks a failed switch', async t => {
  const f = await bridgeFixture(t, 'a');
  assert.deepEqual(f.logins, ['a']);
  const renewed = [];
  f.hooks.tokens = async (id, options) => { if (options?.refresh) renewed.push(id); return { accessToken: `SECRET-${id}`, chatgptAccountId: `${id}-account` }; };
  await f.send('turn/start', { threadId: 'same-thread' }, 'turn1');
  f.incoming({ id: 'turn1', result: { turn: { id: 't1' } } }); f.incoming({ method: 'turn/started', params: { threadId: 'same-thread', turn: { id: 't1' } } });
  f.choose('b');
  await f.send('account/read');
  assert.deepEqual(f.logins, ['a'], 'a busy turn is not interrupted');
  f.incoming({ id: 'renew-busy', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'a-account' } });
  await until(() => f.sent.some(m => m.id === 'renew-busy'));
  assert.equal(f.sent.find(m => m.id === 'renew-busy').result.accessToken, 'SECRET-a');
  assert.deepEqual(renewed, ['a'], 'a rejected token requests renewal of the running account, not the new selection');
  f.incoming({ method: 'turn/completed', params: { threadId: 'same-thread', turn: { id: 't1' } } });
  await f.bridge.settled();
  assert.deepEqual(f.logins, ['a', 'b']);
  await f.send('turn/start', { threadId: 'same-thread' }, 'turn2');
  assert.equal(f.sent.find(m => m.id === 'turn2').params.threadId, 'same-thread');
  f.incoming({ id: 'turn2', error: {} });
  f.incoming({ id: 'renew', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'b-account' } });
  await until(() => f.sent.some(m => m.id === 'renew'));
  assert.equal(f.sent.find(m => m.id === 'renew').result.accessToken, 'SECRET-b');
  f.incoming({ id: 'stale', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'a-account' } });
  await until(() => f.sent.some(m => m.id === 'stale'));
  assert.ok(f.sent.find(m => m.id === 'stale').error, 'never answers for an account no longer signed in');
  f.hooks.login = async () => { throw Error('private failure'); };
  f.choose('a'); await f.send('account/read');
  await f.send('turn/start', { threadId: 'same-thread' }, 'blocked');
  assert.match(error(f, 'blocked').message, /^没能换到所选的 Codex 账号 a：private failure。去「资源」重新选择或登录$/);
  assert.ok(!f.sent.some(m => m.id === 'blocked'), 'never sent on the account before');
  assert.ok(!JSON.stringify(f.outputs).includes('SECRET'));
  f.hooks.login = async () => {};
  await f.send('turn/start', { threadId: 'same-thread' }, 'retry');
  assert.ok(f.sent.some(m => m.id === 'retry'));
  assert.deepEqual(f.logins, ['a', 'b', 'a']);
});

test('legacy null leaves auth alone; every selected identity is explicitly handed in, including a legacy native ID', async t => {
  const f = await bridgeFixture(t, null);
  await f.send('account/read'); await f.send('thread/start');
  assert.deepEqual(f.logins, []);
  await f.send('account/login/start', { type: 'chatgpt' }, 'own-login');
  assert.ok(f.sent.some(m => m.id === 'own-login'), "ACP's own login still passes through");
  f.choose('native'); await f.send('turn/start', { threadId: 'thread' }, 'native-turn');
  assert.deepEqual(f.logins, ['native']); assert.ok(f.sent.some(m => m.id === 'native-turn'));
  f.incoming({ id: 'native-turn', result: { turn: { id: 't0' } } }); f.incoming({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 't0' } } });
  await f.bridge.settled();
  f.choose('a'); await f.send('account/read');
  assert.deepEqual(f.logins, ['native', 'a']);
  await f.send('account/logout', {}, 'logout');
  assert.match(error(f, 'logout').message, /在「资源」里切换/, 'nor may ACP sign out what Coda handed in');
  // Once another was used, this machine's own login is handed in as the others are, by the source.
  f.choose('native'); await f.send('account/read');
  assert.deepEqual(f.logins, ['native', 'a', 'native']);
});

// Review of #1130: a failed switch leaves the server signed in to the account before, or to one unknown; this machine's own
// login chosen then is handed in and checked like any other, and a turn waits until it is.
test('going back to this machine\'s own login after a failed switch hands it in and checks it, never going on with the one before', async t => {
  const f = await bridgeFixture(t, 'a');
  assert.deepEqual(f.logins, ['a']);
  f.hooks.login = async params => { if (params.chatgptAccountId === 'b-account') throw Error('private failure'); };
  f.choose('b'); await f.send('account/read');
  f.choose('native');
  f.hooks.tokens = async () => { throw Error('本机登录的凭据读不到'); };
  await f.send('turn/start', { threadId: 'thread' }, 'unchecked');
  assert.match(error(f, 'unchecked').message, /^没能换到所选的 Codex 账号 本机登录：本机登录的凭据读不到/);
  assert.ok(!f.sent.some(m => m.id === 'unchecked'), 'not sent on a');
  f.hooks.tokens = async id => ({ accessToken: `SECRET-${id}`, chatgptAccountId: `${id}-account` });
  await f.send('turn/start', { threadId: 'thread' }, 'native-turn');
  assert.deepEqual(f.logins, ['a', 'native']);
  assert.ok(f.sent.some(m => m.id === 'native-turn'));
});

test('late start responses cannot revive completed turns', async t => {
  const f = await bridgeFixture(t, 'a');
  await f.send('turn/start', { threadId: 'thread' }, 'start');
  f.incoming({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 't1' } } });
  f.choose('b'); await f.send('account/read');
  f.incoming({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 't1' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a']);
  f.incoming({ id: 'start', result: { turn: { id: 't1' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a', 'b']);
  // A delayed completion for t1 must also not clear a newer turn in that thread.
  await f.send('turn/start', { threadId: 'thread' }, 'next');
  f.incoming({ id: 'next', result: { turn: { id: 't2' } } });
  f.incoming({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 't1' } } });
  f.choose('a'); await f.send('account/read');
  assert.deepEqual(f.logins, ['a', 'b']);
  f.incoming({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 't2' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a', 'b', 'a']);
});

test('overlapping starts keep the account signed in until all pending turns finish', async t => {
  const f = await bridgeFixture(t, 'a');
  await f.send('turn/start', { threadId: 'first' }, 'first-start');
  f.choose('b');
  await f.send('turn/start', { threadId: 'second' }, 'second-start');
  assert.ok(f.sent.some(m => m.id === 'second-start')); assert.ok(!error(f, 'second-start'));
  assert.deepEqual(f.logins, ['a']);
  f.incoming({ id: 'first-start', result: { turn: { id: 't1' } } });
  f.incoming({ method: 'turn/completed', params: { threadId: 'first', turn: { id: 't1' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a']);
  f.incoming({ id: 'second-start', result: { turn: { id: 't2' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a']);
  f.incoming({ method: 'turn/completed', params: { threadId: 'second', turn: { id: 't2' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a', 'b']);
});

test('an unrelated busy thread cannot get a turn past an account not yet or not at all taken, nor can a source that does not answer', async t => {
  const f = await bridgeFixture(t, null);
  f.incoming({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'native-turn' } } });
  f.choose('a');
  await f.send('turn/start', { threadId: 'parent' }, 'unconfirmed');
  assert.ok(error(f, 'unconfirmed')); assert.ok(!f.sent.some(m => m.id === 'unconfirmed'));
  assert.deepEqual(f.logins, []);
  f.incoming({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-turn' } } });
  await f.bridge.settled(); assert.deepEqual(f.logins, ['a']);
  f.hooks.login = async () => { throw Error('private failure'); };
  f.choose('b'); await f.send('account/read');
  f.incoming({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  await f.send('turn/start', { threadId: 'parent' }, 'blocked');
  assert.ok(error(f, 'blocked')); assert.ok(!f.sent.some(m => m.id === 'blocked'));
  f.incoming({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  await f.bridge.settled();
  f.hooks.login = async () => {};
  await f.send('turn/start', { threadId: 'parent' }, 'retry');
  assert.ok(f.sent.some(m => m.id === 'retry'));
  // A source that cannot say what is chosen: the turn is not sent on whichever account was before.
  f.incoming({ id: 'retry', result: { turn: { id: 't9' } } }); f.incoming({ method: 'turn/completed', params: { threadId: 'parent', turn: { id: 't9' } } });
  f.choose('gone');
  await f.send('turn/start', { threadId: 'parent' }, 'unknown');
  assert.match(error(f, 'unknown').message, /^没能换到所选的 Codex 账号：账号来源没有答复/);
  assert.ok(!f.sent.some(m => m.id === 'unknown'));
});

// The tokens read is held until `release` (or `fail`), and the bridge closed while it is: what the bridge does then.
function heldTokens(f) {
  const held = {};
  f.hooks.tokens = id => new Promise((resolve, reject) => {
    held.release = () => resolve({ accessToken: `SECRET-${id}`, chatgptAccountId: `${id}-account` });
    held.fail = () => reject(Error('private failure'));
  });
  return held;
}

test('a bridge closed while it reads tokens asks the server for nothing when they arrive', async t => {
  const f = await bridgeFixture(t, null), held = heldTokens(f);
  f.choose('a'); void f.send('account/read', {}, 'read'); await until(() => held.release);
  await f.bridge.close();
  held.release(); await f.bridge.settled();
  assert.deepEqual(f.late, []); assert.deepEqual(f.logins, []);
  assert.equal(f.outputs.some(m => m.id === 'read'), false, 'a closed bridge answers nothing more');
});

// `thread/list` is sent on as it is; the others take the choice first.
for (const method of ['account/read', 'turn/start', 'thread/list']) {
  test(`a ${method} queued behind a tokens read when the bridge is closed is neither sent on nor answered`, async t => {
    const f = await bridgeFixture(t, null), held = heldTokens(f);
    f.choose('a'); void f.send('account/read', {}, 'first'); await until(() => held.release);
    const queued = f.send(method, { threadId: 'thread' }, 'queued');
    await f.bridge.close();
    held.release(); await queued; await f.bridge.settled();
    assert.deepEqual(f.late, []);
    assert.equal(f.sent.some(m => m.id === 'queued'), false);
    assert.equal(f.outputs.some(m => m.id === 'queued'), false);
  });
}

for (const outcome of ['release', 'fail']) {
  test(`a renewal whose tokens ${outcome === 'release' ? 'arrive' : 'fail'} after the bridge is closed is not answered to the server that is gone`, async t => {
    const f = await bridgeFixture(t, 'a');
    assert.deepEqual(f.logins, ['a']);
    const held = heldTokens(f);
    f.incoming({ id: 'renew', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'a-account' } });
    await until(() => held.release);
    await f.bridge.close();
    held[outcome](); await turns();
    assert.deepEqual(f.late, []);
    assert.equal(f.sent.some(m => m.id === 'renew'), false);
  });
}

// The bridge as a process, over a real child standing in for Codex's native program (`fake`, a script of its own): how it
// ends is how the child ended. `ready` on stderr says the bridge has started and its signal handlers are in place.
const bridgeDir = mkdtempSync(join(tmpdir(), 'codex-bridge-'));
process.on('exit', () => rmSync(bridgeDir, { recursive: true, force: true }));
const bridgeScript = join(bridgeDir, 'bridge.mjs');
writeFileSync(bridgeScript, `
import { runAccountBridge } from ${JSON.stringify(pathToFileURL(new URL('../../../plugins/codex/agent/accounts.mjs', import.meta.url).pathname).href)};
import { AppServer } from ${JSON.stringify(pathToFileURL(new URL('../../../plugins/codex/scripts/app-server.mjs', import.meta.url).pathname).href)};
const command = JSON.parse(process.argv[2]);
runAccountBridge({ source: { close() {} }, makeServer: options => new AppServer({ ...options, command }) });
process.stderr.write('ready\\n');
`);
const node = code => [process.execPath, '-e', code];
const waiting = 'setInterval(() => {}, 1000)';
function runBridge(command) {
  const child = spawn(process.execPath, [bridgeScript, JSON.stringify(command)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const ready = new Promise(resolve => child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('ready')) resolve(); }));
  const ended = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, ended, stderr: () => stderr };
}

for (const [name, command, expected] of [
  ['killed by SIGKILL', node("process.kill(process.pid, 'SIGKILL')"), { code: null, signal: 'SIGKILL' }],
  ['terminated by SIGTERM', node("process.kill(process.pid, 'SIGTERM')"), { code: null, signal: 'SIGTERM' }],
  ['exiting with code 7', node('process.exit(7)'), { code: 7, signal: null }],
  ['exiting with code 0', node('process.exit(0)'), { code: 0, signal: null }],
  ['not starting at all', [join(bridgeDir, 'missing-codex')], { code: 1, signal: null }],
]) {
  test(`the bridge process ends as its app-server did: ${name}`, async () => {
    const bridge = runBridge(command);
    assert.deepEqual(await bridge.ended, expected);
    if (name === 'not starting at all') assert.match(bridge.stderr(), /Codex 无法启动：ENOENT/);
  });
}

test('the bridge process closing on its client going away or being told to stop is a normal end, not its app-server failing', async () => {
  const closed = runBridge(node(waiting));
  await closed.ready; closed.child.stdin.end();
  assert.deepEqual(await closed.ended, { code: 0, signal: null });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const stopped = runBridge(node(waiting));
    await stopped.ready; stopped.child.kill(signal);
    assert.deepEqual(await stopped.ended, { code: 0, signal: null }, signal);
  }
});
