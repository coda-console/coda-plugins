import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness, http, mailbox, temporary } from './helpers.mjs';
import { bind } from '../../../plugins/grok-bot/remote/coda-bot.mjs';
import { schemas } from '../../../check/schema.mjs';

test('unbound instructions carry one-time code, commands and missing-address explanation', async t => {
  const h = await harness(t);
  assert.deepEqual(h.initialized.agentCapabilities._meta.coda.remote, {});
  assert.equal(h.created.configOptions[0].currentValue, 'grok-bot');
  assert.equal((await h.prompt('hello')).stopReason, 'end_turn');
  for (const text of ['single-use-code', 'http://100.88.214.15:8080', '/workspace/.coda-bot/', 'coda-bot.mjs net', 'coda-bot.mjs bind', 'coda-bot.mjs mcp', 'SKILL.md', 'Routine']) assert.ok(h.text().includes(text), text);
  assert.equal(h.events.filter(e => e.method === '_coda/remote/code').length, 1);
  assert.equal(h.adapter.clock.size, 0);
  const { bindingGuide } = await import('../../../plugins/grok-bot/agent/setup.mjs');
  assert.match(bindingGuide('s', { code: 'code', expiresAt: '2030-01-01T00:00:00Z', addresses: [] }), /尚未提供远端入口地址/);
});

test('old Coda gets an upgrade explanation without sending unknown requests', async t => {
  const h = await harness(t, { capabilities: { waits: {} } });
  await h.prompt('hello');
  assert.match(h.text(), /升级/);
  assert.equal(h.events.some(e => e.method === '_coda/remote/code'), false);
});

async function bound(t, extra = {}) {
  const deliveries = mailbox();
  const webhook = await http(t, (request, response, body) => {
    deliveries.push({ request, body });
    response.writeHead(extra.status ?? 200); response.end('{}');
  });
  const h = await harness(t, { ...extra, settings: { 'grok-bot.bots': { inspector: { webhook, key: null } }, ...extra.settings } });
  await h.select();
  const hello = await h.remote('hello');
  assert.equal(hello.instructions, 'session instructions marker');
  return { ...h, deliveries };
}

test('prompt -> Webhook -> say -> done; bearer secret, traces and subsequent child-result prompt', async t => {
  const h = await bound(t);
  const pending = h.prompt('inspect');
  const { body, request } = await h.deliveries.next();
  assert.equal(request.headers.authorization, 'Bearer secret-for-fixture');
  assert.deepEqual({ ...body, turn: 'ID' }, { source: 'coda', sessionId: h.sessionId, turn: 'ID', text: '<coda-session-instructions>\nsession instructions marker\n</coda-session-instructions>\n\ninspect' });
  await assert.rejects(h.remote('say', { text: 'missing ID' }), /必须带/);
  await h.remote('say', { text: 'report', turn: body.turn });
  await h.remote('tool', { name: 'read_thread', arguments: { reference: 'thread' }, turn: body.turn });
  await h.remote('done', { turn: body.turn });
  assert.equal((await pending).stopReason, 'end_turn');
  assert.match(h.text(), /report/);
  assert.equal((await h.remote('hello')).instructions, 'session instructions marker');
  const updates = h.events.filter(e => e.method === 'session/update');
  assert.ok(updates.some(e => e.params.update.sessionUpdate === 'tool_call_update'));
  for (const e of updates) assert.ok(schemas.zSessionNotification.safeParse(e.params).success, JSON.stringify(e.params));
  const child = h.prompt('Child session completed: fixed');
  const next = (await h.deliveries.next()).body;
  assert.match(next.text, /Child session completed/);
  assert.notEqual(next.turn, body.turn);
  await assert.rejects(h.remote('say', { text: 'late', turn: body.turn }), /轮次已结束/);
  await h.remote('done', { turn: next.turn });
  await child;
});

test('autonomous say registers handling before output and done returns recurring timer to waiting', async t => {
  const h = await bound(t);
  const start = h.events.length;
  const { turn } = await h.remote('say', { text: 'found a problem' });
  await h.remote('done', { turn });
  const events = h.events.slice(start);
  assert.equal(events[0].params.state, 'handling');
  assert.equal(events[1].params.update.content.text, 'found a problem');
  assert.equal(events[2].params.state, 'waiting');
  assert.equal(events[2].params.recurring, true);
  assert.equal(h.adapter.clock.size, 0);
});

test('all read tools proxy outside a turn with logs only; disallowed tools never reach MCP', async t => {
  const h = await bound(t);
  assert.deepEqual(h.discovered().sort(), ['coda', 'diagnostics']);
  const start = h.events.length;
  for (const name of ['read_thread', 'read_tool_call', 'agents', 'status', 'workflow_status', 'workflow_list', 'machines', 'machine_diagnostics']) {
    const result = await h.remote('tool', { name, arguments: { reference: 'reference', machine: 'machine', kind: 'network' } });
    assert.ok(result.content.length);
  }
  assert.equal(h.calls().length, 8);
  assert.deepEqual(h.calls().map(c => [c.name, c.server]).slice(-2), [['machines', 'diagnostics'], ['machine_diagnostics', 'diagnostics']]);
  assert.equal(h.events.length, start);
  assert.equal(h.logs.length, 16);
  for (const name of ['exec', 'workflow_run', 'tools/call', '__proto__', 'forbidden_tool']) await assert.rejects(h.remote('tool', { name }), /不允许代理/);
  assert.equal(h.calls().length, 8);
});

test('missing diagnostics reports diagnostics unavailable while coda reads still work', async t => {
  const h = await bound(t, { diagnostics: false });
  assert.deepEqual(h.discovered(), ['coda']);
  for (const name of ['machines', 'machine_diagnostics']) await assert.rejects(h.remote('tool', { name }), /这两个工具需要在 Coda 里安装并为这个目录启用『机器诊断』插件/);
  await h.remote('tool', { name: 'read_thread', arguments: { reference: 'thread' } });
  assert.deepEqual(h.calls().map(c => [c.name, c.server]), [['read_thread', 'coda']]);
});

test('spawn requires a target project before starting a turn or calling MCP', async t => {
  const h = await bound(t);
  const start = h.events.length;
  for (const project of [undefined, null, '', '  ', 123])
    await assert.rejects(h.remote('tool', { name: 'spawn', arguments: { agent: 'codex', prompt: 'fix', project } }), /必须指定目标 project/);
  assert.deepEqual(h.calls(), []);
  assert.equal(h.events.length, start);
});

test('spawn with project starts a turn and proxies with a fresh ticket and requestId, without extra approval', async t => {
  const h = await bound(t);
  const result = await h.remote('tool', { name: 'spawn', arguments: { agent: 'codex', project: 'app', prompt: 'fix', turn: 'forged', requestId: 'forged' } });
  const { args } = JSON.parse(result.content[0].text);
  assert.equal(args.project, 'app');
  assert.equal(args.turn, 'coda-ticket');
  assert.notEqual(args.requestId, 'forged');
  assert.deepEqual(h.calls().map(c => c.name), ['status', 'spawn']);
  assert.equal(h.events.some(e => e.method === 'session/request_permission'), false);
  const handling = h.events.findIndex(e => e.params.state === 'handling');
  assert.ok(handling >= 0 && handling < h.events.findIndex(e => e.params.update?.sessionUpdate === 'tool_call'));
  await h.remote('done');
});

test('send and cancel delegate authorization to Coda and preserve its refusal without retry', async t => {
  const h = await bound(t);
  const ids = new Set();
  for (const [name, args] of [['send', { childId: 'own-child', prompt: 'continue' }], ['send', { childId: 'other', prompt: 'inspect' }],
    ['cancel', { childId: 'own-child' }], ['cancel', { childId: 'not-owned', error: true }], ['spawn', { project: 'app', agent: 'codex', prompt: 'fix', error: true }]]) {
    const result = await h.remote('tool', { name, arguments: args });
    assert.equal(!!result.isError, !!args.error);
    const forwarded = JSON.parse(result.content[0].text).args;
    assert.equal(forwarded.turn, 'coda-ticket');
    assert.equal(typeof forwarded.requestId, 'string');
    ids.add(forwarded.requestId);
  }
  assert.equal(ids.size, 5);
  assert.deepEqual(h.calls().map(c => c.name), ['status', 'send', 'status', 'send', 'status', 'cancel', 'status', 'cancel', 'status', 'spawn']);
  assert.equal(h.events.some(e => e.method === 'session/request_permission'), false);
  await h.remote('done');
});

test('cancel while obtaining a turn ticket never dispatches the write', async t => {
  const answer = Promise.withResolvers(), started = Promise.withResolvers();
  const h = await bound(t);
  const provider = h.adapter.provider(h.adapter.session(h.sessionId), 'status');
  const call = provider.call.bind(provider);
  provider.call = (name, args, signal) => {
    if (name !== 'status') return call(name, args, signal);
    started.resolve();
    return answer.promise;
  };
  const operation = h.remote('tool', { name: 'spawn', arguments: { project: 'app', agent: 'codex', prompt: 'fix' } });
  const rejected = assert.rejects(operation, /没有有效的 Coda turn 票据/);
  await started.promise;
  await assert.rejects(h.remote('done'), /仍有工具/);
  await h.client.request('session/cancel', { sessionId: h.sessionId });
  answer.resolve({ content: [{ type: 'text', text: JSON.stringify({ turn: 'stale-ticket' }) }] });
  await rejected;
  assert.deepEqual(h.calls(), []);
  assert.equal(h.events.some(e => e.method === 'session/request_permission'), false);
  assert.equal(h.events.filter(e => e.method === '_coda/wait').at(-1).params.state, 'waiting');
});

test('cancelled and timed-out webhook turns reject late output even during a subsequent turn', async t => {
  const h = await bound(t);
  for (const action of ['cancel', 'timeout']) {
    const pending = h.prompt('work');
    const { body } = await h.deliveries.next();
    if (action === 'cancel') await h.client.request('session/cancel', { sessionId: h.sessionId });
    else h.adapter.clock.expire();
    assert.equal((await pending).stopReason, action === 'cancel' ? 'cancelled' : 'end_turn');
    const next = h.prompt('new');
    const delivery = (await h.deliveries.next()).body;
    await assert.rejects(h.remote('say', { turn: body.turn, text: 'late' }), /轮次已结束/);
    await assert.rejects(h.remote('done', { turn: body.turn }), /轮次已结束/);
    await h.remote('done', { turn: delivery.turn });
    await next;
  }
  assert.match(h.text(), /未必停止/);
  assert.match(h.text(), /超过 PT30M/);
  assert.doesNotMatch(h.text(), /late/);
});

test('autonomous timeout and cancel return to waiting; failed Webhook completes with honest error', async t => {
  const h = await bound(t, { status: 503 });
  await h.prompt('work');
  assert.match(h.text(), /HTTP 503/);
  const { turn } = await h.remote('say', { text: 'problem' });
  h.adapter.clock.expire();
  await assert.rejects(h.remote('done', { turn }), /轮次已结束/);
  await h.remote('say', { text: 'different problem' });
  await h.client.request('session/cancel', { sessionId: h.sessionId });
  assert.equal(h.events.filter(e => e.method === '_coda/wait').at(-1).params.state, 'waiting');
});

test('session/load preserves Bot binding and re-registers timer; invalid instructions rejected', async t => {
  const h = await bound(t);
  h.adapter.close();
  h.adapter.sessions.clear();
  const loaded = await h.client.request('session/load', { ...h.open, sessionId: h.sessionId });
  assert.deepEqual(h.discovered().sort(), ['coda', 'coda', 'diagnostics', 'diagnostics']);
  assert.equal(loaded.configOptions[1].currentValue, 'inspector');
  const pending = h.prompt('after load');
  const { body } = await h.deliveries.next();
  assert.match(body.text, /session instructions marker[\s\S]*after load/);
  await h.remote('done', { turn: body.turn });
  await pending;
  const before = h.adapter.sessions.size;
  await assert.rejects(h.client.request('session/new', { systemPrompt: { mode: 'replace', content: [] } }), /只支持 append/);
  assert.equal(h.adapter.sessions.size, before);
  await h.prompt('/bind');
  assert.match(h.text(), /single-use-code/);
});

test('session/load takes instructions only from Coda without persisting them or rewriting legacy state', async t => {
  const h = await bound(t);
  const file = h.adapter.file(h.sessionId);
  writeFileSync(file, JSON.stringify({ bot: 'inspector', bound: true, instructions: 'legacy instructions' }));
  const replacement = { mode: 'append', content: [
    { type: 'text', text: 'new project instructions' },
    { type: 'text', text: 'enabled plugin instructions' },
  ] };
  for (const [systemPrompt, expected] of [
    [undefined, ''],
    [replacement, 'new project instructions\nenabled plugin instructions'],
    [undefined, ''],
    [{ mode: 'append', content: [] }, ''],
    [undefined, ''],
  ]) {
    h.adapter.close();
    h.adapter.sessions.clear();
    const before = readFileSync(file, 'utf8');
    const { systemPrompt: _old, ...open } = h.open;
    const loaded = await h.client.request('session/load', {
      ...open, sessionId: h.sessionId, ...(systemPrompt === undefined ? {} : { systemPrompt }),
    });
    assert.equal(loaded.configOptions[1].currentValue, 'inspector');
    assert.equal(readFileSync(file, 'utf8'), before, 'load must not write state');
    assert.equal((await h.remote('hello')).instructions, expected);
    assert.deepEqual(JSON.parse(readFileSync(file)), { bot: 'inspector', bound: true });
    const pending = h.prompt('inspect');
    const { body } = await h.deliveries.next();
    assert.equal(body.text, expected ? `<coda-session-instructions>\n${expected}\n</coda-session-instructions>\n\ninspect` : 'inspect');
    await h.remote('done', { turn: body.turn });
    assert.equal((await pending).stopReason, 'end_turn');
  }
});

test('model/config probes leave no files; an unwritten session loads unbound and hello persists only binding', async t => {
  const h = await harness(t, { mcpFactory: () => ({ list: async () => ({ tools: [] }), close() {} }) });
  const files = () => readdirSync(h.root).filter(name => name.endsWith('.json'));
  for (let i = 0; i < 5; i++) {
    const created = await h.client.request('session/new', { ...h.open, mcpServers: [] });
    assert.equal(created.configOptions[0].currentValue, 'grok-bot');
    assert.equal(created.configOptions[1].currentValue, '');
  }
  assert.deepEqual(files(), []);
  h.adapter.close();
  h.adapter.sessions.clear();
  const loaded = await h.client.request('session/load', { ...h.open, mcpServers: [], sessionId: h.sessionId });
  assert.equal(loaded.configOptions[0].currentValue, 'grok-bot');
  assert.equal(loaded.configOptions[1].currentValue, '');
  await assert.rejects(h.remote('say', { text: 'not bound' }), /尚未完成绑定/);
  assert.equal((await h.prompt('hello')).stopReason, 'end_turn');
  assert.match(h.text(), /single-use-code/);
  assert.deepEqual(files(), []);
  assert.equal((await h.remote('hello')).instructions, 'session instructions marker');
  assert.equal(files().length, 1);
  assert.deepEqual(JSON.parse(readFileSync(h.adapter.file(h.sessionId))), { bot: '', bound: true });
});

test('selecting and changing Bot persist selection without instructions', async t => {
  const h = await harness(t, { settings: { 'grok-bot.bots': { inspector: {}, replacement: {} } },
    mcpFactory: () => ({ list: async () => ({ tools: [] }), close() {} }) });
  const file = h.adapter.file(h.sessionId);
  assert.throws(() => readFileSync(file), { code: 'ENOENT' });
  await h.select();
  assert.deepEqual(JSON.parse(readFileSync(file)), { bot: 'inspector', bound: false });
  await h.remote('hello');
  assert.deepEqual(JSON.parse(readFileSync(file)), { bot: 'inspector', bound: true });
  await h.client.request('session/set_config_option', { sessionId: h.sessionId, configId: 'bot', value: 'replacement' });
  assert.deepEqual(JSON.parse(readFileSync(file)), { bot: 'replacement', bound: false });
});

test('telemetry preserves JSON, query and base path; refuses traversal, redirects and missing config', async t => {
  const queries = mailbox();
  const base = await http(t, (request, response) => {
    queries.push({ url: request.url, method: request.method });
    if (request.url.endsWith('/redirect')) response.writeHead(302, { Location: '/private' });
    response.end(JSON.stringify({ raw: ['evidence', 1] }));
  });
  const h = await bound(t, { settings: { 'grok-bot.telemetry': `${base}/dashboard` } });
  assert.deepEqual(await h.remote('telemetry', { path: '/api/overview', query: { days: 7 } }), { raw: ['evidence', 1] });
  assert.deepEqual(await queries.next(), { url: '/dashboard/api/overview?days=7', method: 'GET' });
  for (const path of ['/admin', '//evil/api/', '/api/../admin', '/api/%2e%2e/admin', '/api/\\admin', '/api/events?x=1', '/api/.\n./.\t./admin', '/api/\r../admin', '/api/events\0', '/api/events\x7f'])
    await assert.rejects(h.remote('telemetry', { path }), /只允许/);
  await assert.rejects(h.remote('telemetry', { path: '/api/redirect' }));
  const missing = await bound(t);
  await assert.rejects(missing.remote('telemetry', { path: '/api/tags' }), /尚未设置/);
});

test('lost hello response can be rebound after load or Bot switch without losing instructions', async t => {
  const h = await harness(t, { settings: { 'grok-bot.bots': { inspector: {}, replacement: {} } } });
  await h.select();
  const home = temporary(t);
  let loseResponse = true;
  const fetcher = async (address, init) => {
    if (address.pathname.endsWith('/bind')) return Response.json({ token: 'replacement-token', session: {} });
    const { method, params } = JSON.parse(init.body);
    const result = await h.remote(method, params);
    if (loseResponse) { loseResponse = false; throw new Error('HTTP response lost'); }
    return Response.json({ result });
  };
  await assert.rejects(bind('http://coda', 'code-1', { home, fetcher }), /HTTP response lost/);
  h.adapter.close();
  h.adapter.sessions.clear();
  await h.client.request('session/load', { ...h.open, sessionId: h.sessionId });
  await h.prompt('/bind');
  assert.match(h.text(), /single-use-code/);
  const rebound = await bind('http://coda', 'code-2', { home, fetcher });
  assert.equal(rebound.instructions, 'session instructions marker');
  assert.equal((await h.remote('hello')).instructions, rebound.instructions);
  await h.client.request('session/set_config_option', { sessionId: h.sessionId, configId: 'bot', value: 'replacement' });
  assert.equal((await bind('http://coda', 'code-3', { home, fetcher })).instructions, rebound.instructions);
});
