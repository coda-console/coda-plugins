import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeShells } from '../../../plugins/opencode/agent/shells.mjs';
import { shellEnvironment } from '../../../plugins/opencode/agent/shell-channel.mjs';

function fixture() {
  const messages = [], sent = [], source = {}, roots = new Set(['root', 'child']);
  const b = new OpenCodeShells({ owns: id => roots.has(id), say: m => messages.push(m.params),
    interrupt: (source, sessionId) => sent.push({ source, sessionId }) });
  const event = (type, data, owner = source) => b.event({ type, data }, owner);
  const created = (session = 'root', id = 'sh_test') => event('shell.created', { info: {
    id, status: 'running', command: 'python experiment.py', file: '/tmp/native.out', metadata: { sessionID: session },
  } });
  const register = (session = 'root', id = 'sh_test') => b.register({ shellId: id, sessionId: session,
    toolCallId: session === 'child' ? 'child:call' : 'call' }, source);
  const ended = (status = 'exited', exit = 0, id = 'sh_test') => event('shell.exited', { id, status, exit });
  const notify = (session = 'root', id = 'sh_test', inbox = 'message') => event('session.inbox.enqueued', {
    sessionID: session, inboxID: inbox, item: { type: 'synthetic', payload: { metadata: { source: 'shell', shellID: id } } },
  });
  const delivered = (session = 'root', inbox = 'message') => event('session.inbox.delivered', { sessionID: session, inboxID: inbox });
  const handled = (session = 'root') => event('session.execution.succeeded', { sessionID: session });
  return { b, source, messages, sent, event, created, register, ended, notify, delivered, handled };
}

test('prompt completion is not shell completion; actual delivery owns handling through the native execution end', () => {
  const f = fixture(); f.created(); f.register();
  f.b.fromCoda({ id: 1, method: 'session/prompt', params: { sessionId: 'root' } });
  f.b.fromAgent({ id: 1, result: { stopReason: 'end_turn' } });
  assert.deepEqual(f.messages, [{ sessionId: 'root', waitId: 'shell:sh_test', kind: 'task', state: 'waiting',
    title: 'python experiment.py', detail: 'python experiment.py', outputFile: '/tmp/native.out', toolCallId: 'call', stoppable: false }]);
  f.ended(); f.notify(); f.handled();
  assert.equal(f.messages.length, 1, 'an unrelated execution end does not consume an undelivered result');
  f.delivered(); f.handled();
  assert.deepEqual(f.messages.map(m => m.state), ['waiting', 'handling', 'done']);
  f.ended(); f.delivered(); f.handled(); f.register();
  assert.equal(f.messages.length, 3, 'duplicate native facts do not reopen a terminal wait');
});

test('a fast command can exit and be handled before the background tool returns', () => {
  const f = fixture(); f.created(); f.ended(); f.notify(); f.delivered(); f.handled();
  assert.deepEqual(f.messages, []);
  f.register();
  assert.deepEqual(f.messages.map(m => m.state), ['waiting', 'done']);
});

test('a foreground shell never creates a background task', () => {
  const f = fixture(); f.created(); f.ended(); f.handled();
  assert.deepEqual(f.messages, []);
});

for (const [status, exit, expected] of [['exited', 7, 'failed'], ['exited', undefined, 'failed'], ['timeout', undefined, 'failed'], ['killed', undefined, 'cancelled']])
  test(`native ${status}/${exit} is ${expected}, including a cancelled result notification`, () => {
    const f = fixture(); f.created(); f.register();
    // Explicit undefined must not take the helper's success default.
    f.event('shell.exited', { id: 'sh_test', status, exit }); f.notify();
    f.event('session.inbox.cancelled', { sessionID: 'root', inboxID: 'message' });
    assert.equal(f.messages.at(-1).state, expected);
    assert.ok(f.messages.at(-1).detail);
  });

test('child shells belong to the child; unrelated sessions, sockets and notifications cannot settle them', () => {
  const f = fixture(); f.created('stranger'); assert.equal(f.register('stranger'), false);
  f.created('child'); assert.equal(f.register('root'), false); assert.equal(f.register('child'), true);
  f.event('shell.exited', { id: 'sh_test', status: 'exited', exit: 0 }, {});
  f.notify('root'); f.delivered('root'); f.handled('root');
  assert.equal(f.messages.length, 1);
  f.ended(); f.notify('child'); f.delivered('child'); f.handled('child');
  assert.ok(f.messages.every(m => m.sessionId === 'child'));
  assert.equal(f.messages[0].toolCallId, 'child:call');
  assert.equal(f.messages.at(-1).state, 'done');
});

test('results delivered inside a foreground prompt stay tied to that prompt, without an autonomous handling report', () => {
  const f = fixture(); f.b.fromCoda({ id: 'p', method: 'session/prompt', params: { sessionId: 'root' } });
  f.created(); f.register(); f.ended(); f.notify(); f.delivered(); f.handled();
  assert.deepEqual(f.messages.map(m => m.state), ['waiting', 'done']);
});

test('delivery racing the old ACP response becomes handling once the foreground prompt ends', () => {
  const f = fixture(); f.b.fromCoda({ id: 'p', method: 'session/prompt', params: { sessionId: 'root' } });
  f.created(); f.register(); f.ended(); f.notify(); f.delivered();
  f.b.fromAgent({ id: 'p', result: { stopReason: 'end_turn' } });
  assert.deepEqual(f.messages.map(m => m.state), ['waiting', 'handling']);
  f.handled(); assert.equal(f.messages.at(-1).state, 'done');
});

test('cancelling autonomous handling interrupts only the owning native session and awaits the native end', () => {
  const f = fixture(); f.created(); f.register(); f.ended(); f.notify(); f.delivered();
  assert.equal(f.b.fromCoda({ method: 'session/cancel', params: { sessionId: 'stranger' } }), false);
  assert.equal(f.b.fromCoda({ method: 'session/cancel', params: { sessionId: 'root' } }), true);
  assert.deepEqual(f.sent[0], { source: f.source, sessionId: 'root' });
  assert.equal(f.messages.at(-1).state, 'handling');
  f.event('session.execution.interrupted', { sessionID: 'root' });
  assert.match(f.messages.at(-1).detail, /停止处理/);
  assert.equal(f.b.fromCoda({ method: 'session/cancel', params: { sessionId: 'root' } }), false);
});

test('a lost event stream ends only that connection’s waits, and preserves confirmed terminal outcomes', () => {
  const f = fixture(); f.created(); f.register(); f.b.disconnected({});
  assert.equal(f.messages.length, 1); f.b.disconnected(f.source);
  assert.equal(f.messages.at(-1).state, 'failed'); assert.match(f.messages.at(-1).detail, /未确认/);
  f.b.disconnected(f.source); assert.equal(f.messages.length, 2);
});

test('native result handling failure is visible even if the command itself succeeded', () => {
  const f = fixture(); f.created(); f.register(); f.ended(); f.notify(); f.delivered();
  f.event('session.execution.failed', { sessionID: 'root', error: { message: 'Model service unavailable' } });
  assert.equal(f.messages.at(-1).state, 'failed');
  assert.match(f.messages.at(-1).detail, /退出码 0.*Model service unavailable/);
});

test('missing native integration is explicit, but lookalike metadata from another tool is not a shell', () => {
  const f = fixture();
  const update = update => f.b.fromAgent({ method: 'session/update', params: { sessionId: 'root', update } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'call', name: 'read' });
  const result = { sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed',
    rawOutput: { metadata: { status: 'running', shellID: 'sh_test' } } };
  update(result); assert.deepEqual(f.messages, []);
  update({ sessionUpdate: 'tool_call', toolCallId: 'call', name: 'shell' }); update(result);
  assert.deepEqual(f.messages.map(m => m.state), ['waiting', 'failed']);
  assert.match(f.messages.at(-1).detail, /未建立.*未确认/);
});

test('native plugin injection preserves JSONC, user plugins, and one-pass template expansion', () => {
  const env = { OPENCODE_CONFIG_CONTENT: '{//comment\n"plugins":["user-plugin",], "provider":{"k":"\\u007bfile:literal}"},}', KEEP: 'kept' };
  const generated = shellEnvironment(env, '/tmp/{env:literal}/events.sock');
  const parsed = JSON.parse(generated.OPENCODE_CONFIG_CONTENT);
  assert.equal(parsed.plugins[0], 'user-plugin');
  assert.equal(parsed.plugins[1].options.socket, '/tmp/{env:literal}/events.sock');
  assert.match(generated.OPENCODE_CONFIG_CONTENT, /\\u007bfile:literal/);
  assert.equal(generated.KEEP, 'kept'); assert.ok(env.OPENCODE_CONFIG_CONTENT.startsWith('{//'));
  const byEnv = shellEnvironment({ OPENCODE_CONFIG_CONTENT: '{"plugins":{env:USER_PLUGINS}}', USER_PLUGINS: '["native"]' }, '/tmp/events.sock');
  assert.equal(byEnv.USER_PLUGINS, '["native"]');
  const variable = /\{env:([^}]+)\}/.exec(byEnv.OPENCODE_CONFIG_CONTENT)[1];
  assert.equal(JSON.parse(byEnv[variable])[0], 'native');
  assert.throws(() => shellEnvironment({ OPENCODE_CONFIG_CONTENT: '{"plugins":false}' }, '/tmp/x'), /必须是数组/);
});

test('native plugin injection expands file-backed arrays with OpenCode file substitution semantics', t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-oc-plugins-file-')), file = join(root, 'plugins.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(file, ' [/* empty plugin list */] \n');
  for (const source of [`{file:${file}}`, '{file:plugins.json}', '{file:~/plugins.json}', '{env:USER_PLUGINS}',
    '{file:{env:PLUGINS_FILE}}', '{file:{env:PLUGINS_DIR}/{env:PLUGINS_NAME}}']) {
    const env = { HOME: root, OPENCODE_CONFIG_CONTENT: `{"plugins":${source},"other":"\\u007bfile:literal}"}`,
      USER_PLUGINS: ` {file:${file}} `, PLUGINS_FILE: file, PLUGINS_DIR: root, PLUGINS_NAME: 'plugins.json' };
    const generated = shellEnvironment(env, '/tmp/{file:literal}/events.sock', root);
    const parsed = JSON.parse(generated.OPENCODE_CONFIG_CONTENT);
    assert.equal(parsed.plugins.length, 1, source);
    assert.equal(parsed.plugins[0].options.socket, '/tmp/{file:literal}/events.sock');
    assert.equal(parsed.other, '{file:literal}');
    assert.match(generated.OPENCODE_CONFIG_CONTENT, /\\u007bfile:literal/);
    assert.equal(generated.USER_PLUGINS, env.USER_PLUGINS);
  }
  const env = { OPENCODE_CONFIG_CONTENT: `{"plugins":{file:${file}}}` };
  // Native files are escaped string contents, not JSON includes; templates introduced by a file get no second pass.
  for (const content of ['["user-plugin"]', '[{file:plugins.json}]', '[{env:PLUGINS}]']) {
    writeFileSync(file, content);
    assert.throws(() => shellEnvironment(env, '/tmp/events.sock'), /必须是数组/);
  }
});

test('env in a plugin file path expands once before file substitution without decoding literal escapes', t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-oc-plugins-path-')), file = join(root, 'plugins"\\name.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(file, '[]');
  const env = { OPENCODE_CONFIG_CONTENT: '{"plugins":{file:{env:PLUGINS_FILE}},"other":"\\u007benv:PLUGINS_FILE}"}',
    PLUGINS_FILE: file };
  const generated = shellEnvironment(env, '/tmp/events.sock');
  assert.equal(JSON.parse(generated.OPENCODE_CONFIG_CONTENT).plugins.length, 1);
  assert.match(generated.OPENCODE_CONFIG_CONTENT, /\\u007benv:PLUGINS_FILE/);
  assert.equal(generated.PLUGINS_FILE, file);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, '{"plugins":{file:{env:PLUGINS_FILE}},"other":"\\u007benv:PLUGINS_FILE}"}');
  for (const source of ['{file:{env:FIRST}}', '{env:USER_PLUGINS}']) {
    assert.throws(() => shellEnvironment({ ...env, OPENCODE_CONFIG_CONTENT: `{"plugins":${source}}`,
      FIRST: '{env:PLUGINS_FILE}', USER_PLUGINS: '{file:{env:PLUGINS_FILE}}' }, '/tmp/events.sock'), SyntaxError);
  }
});
