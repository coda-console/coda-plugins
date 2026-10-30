import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rpc } from '../../../plugins/grok-bot/agent/rpc.mjs';
import { bind, call, net, serveMcp, TOOLS } from '../../../plugins/grok-bot/remote/coda-bot.mjs';
import { http, temporary } from './helpers.mjs';

async function endpoint(t) {
  const calls = [], tokens = new Map();
  let serial = 0;
  const address = await http(t, (request, response, body) => {
    calls.push({ path: request.url, authorization: request.headers.authorization, body });
    if (request.url === '/v1/remote-agent/bind') {
      const sessionId = body.code.split(':')[0], token = `token-${++serial}`;
      tokens.set(sessionId, token);
      response.end(JSON.stringify({ token, session: { id: sessionId } }));
    } else {
      const sessionId = [...tokens].find(([, token]) => request.headers.authorization === `Bearer ${token}`)?.[0];
      if (!sessionId) { response.writeHead(401); response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token' } })); return; }
      if (body.method === 'fail') { response.writeHead(409); response.end(JSON.stringify({ error: { code: 'archived', message: '会话已归档' } })); return; }
      const result = body.method === 'hello' ? { sessionId, instructions: 'Be concise' }
        : body.method === 'tool' ? { content: [{ type: 'text', text: JSON.stringify(body.params) }] } : { echo: body, sessionId };
      response.end(JSON.stringify({ result }));
    }
  });
  return { address, calls, tokens };
}

test('bind stores token privately, replaces just that session and keeps multiple Bots isolated', async t => {
  const home = temporary(t), remote = await endpoint(t);
  const result = await bind(remote.address, 'first:code', { home });
  assert.deepEqual(result, { sessionId: 'first', instructions: 'Be concise', message: '已绑定；token 已保存，未打印。' });
  const path = join(home, 'config.json');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const old = JSON.parse(readFileSync(path)).sessions.first.token;
  await bind(remote.address, 'second:code', { home });
  await assert.rejects(call('say', { text: 'ambiguous' }, { home }), /多个 Bot/);
  await bind(remote.address, 'first:new-code', { home });
  const saved = JSON.parse(readFileSync(path));
  assert.notEqual(saved.sessions.first.token, old);
  assert.equal(Object.keys(saved.sessions).length, 2);
  const reply = await call('say', { text: 'hello' }, { home, session: 'first' });
  assert.equal(reply.sessionId, 'first');
  assert.equal(remote.calls.at(-1).authorization, `Bearer ${saved.sessions.first.token}`);
  assert.equal((await call('say', { text: 'other' }, { home, session: 'second' })).sessionId, 'second');
  await assert.rejects(call('fail', {}, { home, session: 'first' }), /会话已归档/);
  writeFileSync(join(home, 'config.lock'), '');
  await assert.rejects(bind(remote.address, 'first:code', { home }), /配置正在写入/);
});

test('MCP initialize/list/call map every named tool through HTTP and check net before each invocation', async t => {
  const home = temporary(t), remote = await endpoint(t);
  await bind(remote.address, 'only:code', { home });
  const input = new PassThrough(), output = new PassThrough();
  let checks = 0;
  const lines = serveMcp({ input, output, ensureNet: async () => { checks++; }, invoke: (method, params) => call(method, params, { home }) });
  const rpc = new Rpc(output, input);
  t.after(() => { rpc.close(); lines.close(); input.end(); output.end(); });
  const init = await rpc.request('initialize', { protocolVersion: '2024-11-05' });
  assert.ok(init.capabilities.tools);
  rpc.notify('notifications/initialized', {});
  const listed = (await rpc.request('tools/list', {})).tools;
  assert.equal(checks, 0);
  for (const tool of TOOLS) {
    assert.ok(listed.some(t => t.name === tool.name && t.description));
    const args = { turn: 'webhook-turn' };
    for (const key of tool.inputSchema.required) args[key] = key === 'query' ? {} : key === 'kind' ? 'network' : `${key}-value`;
    const result = await rpc.request('tools/call', { name: tool.name, arguments: args });
    assert.equal(result.isError, undefined, tool.name);
    const sent = remote.calls.at(-1).body;
    assert.equal(sent.method, tool.method);
    assert.equal(sent.params.turn, 'webhook-turn');
    if (tool.tool) {
      assert.equal(sent.params.name, tool.tool);
      assert.equal(sent.params.arguments.turn, undefined);
      assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(sent.params) }]);
    }
  }
  assert.equal(checks, TOOLS.length);
  const failure = await rpc.request('tools/call', { name: 'coda_say', arguments: {} });
  assert.equal(failure.isError, true);
  await assert.rejects(rpc.request('tools/call', { name: 'shell', arguments: {} }), /Unknown tool/);
});

test('MCP returns net and remote failures as tool errors without corrupting stdio', async t => {
  const input = new PassThrough(), output = new PassThrough();
  let called = false;
  const lines = serveMcp({ input, output, ensureNet: async () => { throw new Error('Login at https://login.tailscale.com/a/example'); }, invoke: async () => { called = true; } });
  const rpc = new Rpc(output, input);
  t.after(() => { rpc.close(); lines.close(); input.end(); output.end(); });
  const answer = await rpc.request('tools/call', { name: 'coda_machines' });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /login.tailscale.com/);
  assert.equal(called, false);
  assert.deepEqual(await rpc.request('ping', {}), {});
});

test('net fast check does not install or restart a running daemon', async () => {
  const commands = [];
  const result = await net({ run: async (command, args) => { commands.push([command, args]); return { stdout: JSON.stringify({ BackendState: 'Running' }) }; }, pause: () => assert.fail('no wait') });
  assert.deepEqual(result, { connected: true });
  assert.deepEqual(commands, [['sudo', ['-n', 'tailscale', 'status', '--json']]]);
});

test('net recovery uses persistent state, lock and official installer; login link is actionable', async () => {
  const commands = [], login = 'https://login.tailscale.com/a/fixture';
  let first = true;
  await assert.rejects(net({ home: '/workspace/.coda-bot', pause: async () => {}, run: async (command, args) => {
    commands.push([command, args]);
    if (args.includes('status')) {
      if (first) { first = false; throw new Error('daemon missing'); }
      return { stdout: JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: login }) };
    }
    return { stdout: '' };
  } }), new RegExp(login));
  const recovery = commands.find(([, args]) => args.includes('flock'))[1];
  assert.ok(recovery.includes('/workspace/.coda-bot/tailscale/net.lock'));
  assert.match(recovery.join(' '), /https:\/\/tailscale.com\/install.sh/);
  assert.match(recovery.join(' '), /cp -a \/var\/lib\/tailscale/);
  assert.match(recovery.join(' '), /--statedir=/);
});
