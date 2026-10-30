import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness, http, mailbox, temporary } from './helpers.mjs';
import { bind } from '../../../plugins/grok-bot/remote/coda-bot.mjs';
import { schemas } from '../../../check/schema.mjs';
import { SUBMISSION_WAIT_MS } from '../../../plugins/grok-bot/agent/session.mjs';

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

test('new/load advertise child approval modes; Coda can reapply auto and switch back without saving plugin state', async t => {
  const h = await harness(t, { mcpFactory: () => ({ list: async () => ({ tools: [] }), close() {} }) });
  const modes = h.created.modes;
  assert.equal(modes.currentModeId, 'manual');
  assert.deepEqual(modes.availableModes.map(mode => mode.id), ['manual', 'auto']);
  assert.deepEqual(schemas.zNewSessionResponse.parse(h.created).modes, modes);
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/grok-bot/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contributes.agents[0].modes, { title: '派出的 Agent', unset: '要你批准', auto: 'auto' });
  const setMode = modeId => h.client.request('session/set_mode', { sessionId: h.sessionId, modeId });
  const assertMode = mode => {
    const event = h.events.at(-1);
    assert.equal(event.params.update.sessionUpdate, 'current_mode_update');
    assert.equal(event.params.update.currentModeId, mode);
    assert.ok(schemas.zSessionNotification.safeParse(event.params).success);
  };
  assert.deepEqual(await setMode('auto'), {});
  assertMode('auto');
  h.adapter.close();
  h.adapter.sessions.clear();
  const loaded = await h.client.request('session/load', { ...h.open, sessionId: h.sessionId });
  assert.deepEqual(schemas.zLoadSessionResponse.parse(loaded).modes, modes);
  await setMode('auto'); // Coda reapplies the saved session setting after load.
  assertMode('auto');
  await setMode('manual');
  assertMode('manual');
  const count = h.events.length;
  await assert.rejects(setMode('full'), /未知的派出 Agent 档位/);
  assert.equal(h.events.length, count);
  assert.equal(h.adapter.session(h.sessionId).mode, 'manual');
  assert.deepEqual(readdirSync(h.root).filter(file => file.endsWith('.json')), [], 'mode changes do not persist binding files');
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
  assert.deepEqual({ ...body, turn: 'ID' }, { source: 'coda', sessionId: h.sessionId, turn: 'ID', kind: 'message', preview: 'inspect' });
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
  assert.match(next.preview, /Child session completed/);
  assert.equal(next.kind, 'result');
  assert.equal((await h.remote('input', { turn: next.turn })).text, 'Child session completed: fixed');
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

test('Webhook previews a long child result; input retains full text until the next turn starts', async t => {
  const h = await bound(t);
  const text = '[Coda] 以下子会话已结束，结果自动送达，不需要查询或等待。\n\n' + '完整结果😀'.repeat(2000);
  const pending = h.prompt(text);
  const { body } = await h.deliveries.next();
  assert.deepEqual(body, { source: 'coda', sessionId: h.sessionId, turn: body.turn, kind: 'result',
    preview: [...text].slice(0, 500).join('') + '……（完整内容用 coda_input 取）' });
  assert.doesNotMatch(JSON.stringify(body), /coda-session-instructions|session instructions marker/);
  const expected = { turn: body.turn, kind: 'result', text };
  assert.deepEqual(await h.remote('input', { turn: body.turn }), expected);
  await assert.rejects(h.remote('input'), /必须带/);
  await assert.rejects(h.remote('input', { turn: 'wrong-turn' }), /不存在或已被下一轮替换/);
  await h.remote('done', { turn: body.turn });
  await pending;
  const count = h.events.length;
  assert.deepEqual(await h.remote('input', { turn: body.turn }), expected);
  assert.equal(h.events.length, count, 'reading finished input does not start a turn');
  const next = h.prompt('next task');
  const nextBody = (await h.deliveries.next()).body;
  await assert.rejects(h.remote('input', { turn: body.turn }), /不存在或已被下一轮替换/);
  assert.equal((await h.remote('input', { turn: nextBody.turn })).text, 'next task');
  await h.remote('done', { turn: nextBody.turn });
  await next;
  const autonomous = await h.remote('say', { text: 'routine report' });
  await assert.rejects(h.remote('input', { turn: nextBody.turn }), /不存在或已被下一轮替换/);
  await assert.rejects(h.remote('input', { turn: autonomous.turn }), /不存在或已被下一轮替换/);
  await h.remote('done');
});

test('preview counts Unicode characters, marks truncation, and falls back to message for unknown content', async t => {
  const h = await bound(t);
  for (const [text, kind, preview] of [
    ['😀'.repeat(500), 'message', '😀'.repeat(500)],
    ['😀'.repeat(501), 'message', '😀'.repeat(500) + '……（完整内容用 coda_input 取）'],
    ['[Coda] 流程巡检交给你一个任务', 'notification', '[Coda] 流程巡检交给你一个任务'],
    ['请检查子会话的结果', 'message', '请检查子会话的结果'],
  ]) {
    const pending = h.prompt(text);
    const { body } = await h.deliveries.next();
    assert.equal(body.kind, kind);
    assert.equal(body.preview, preview);
    assert.deepEqual(await h.remote('input', { turn: body.turn }), { turn: body.turn, kind, text });
    await h.remote('done', { turn: body.turn });
    await pending;
  }
});

test('cancel and timeout retain readable input without allowing late output', async t => {
  const h = await bound(t);
  for (const action of ['cancel', 'timeout']) {
    const pending = h.prompt(action);
    const { body } = await h.deliveries.next();
    if (action === 'cancel') await h.client.request('session/cancel', { sessionId: h.sessionId });
    else h.adapter.clock.expire();
    await pending;
    assert.equal((await h.remote('input', { turn: body.turn })).text, action);
    await assert.rejects(h.remote('say', { turn: body.turn, text: 'late' }), /轮次已结束/);
  }
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

test('auto/manual modes keep Bot spawn/send authorization with Coda and preserve refusals', async t => {
  const h = await bound(t);
  for (const modeId of ['auto', 'manual']) {
    await h.client.request('session/set_mode', { sessionId: h.sessionId, modeId });
    await assert.rejects(h.remote('tool', { name: 'spawn', arguments: { prompt: 'fix' } }), /必须指定目标 project/);
    for (const [name, args] of [['spawn', { project: 'app', prompt: 'fix', error: true }], ['send', { childId: 'other', prompt: 'inspect', error: true }]]) {
      const result = await h.remote('tool', { name, arguments: args });
      assert.equal(result.isError, true);
      const forwarded = h.calls().at(-1).arguments;
      const { turn, requestId, ...original } = forwarded;
      assert.deepEqual(original, args);
      assert.equal(turn, 'coda-ticket');
      assert.match(requestId, /^[0-9a-f-]{36}$/);
    }
    await h.remote('done');
  }
  assert.deepEqual(h.calls().map(call => call.name), ['status', 'spawn', 'status', 'send', 'status', 'spawn', 'status', 'send']);
  assert.equal(h.events.some(event => event.method === 'session/request_permission'), false);
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

test('writes reuse requestId for equivalent JSON in a turn, but separate names, arguments and turns', async t => {
  const h = await bound(t);
  const args = { agent: 'codex', project: 'coda', prompt: 'fix', options: { z: 1, a: [{ y: 2, x: 3 }, 'tail'] } };
  const reordered = { options: { a: [{ x: 3, y: 2 }, 'tail'], z: 1 }, prompt: 'fix', project: 'coda', agent: 'codex' };
  for (const name of ['spawn', 'send', 'cancel']) {
    await h.remote('tool', { name, arguments: { ...args, turn: 'forged-a', requestId: 'forged-a' } });
    await h.remote('tool', { name, arguments: { ...reordered, turn: 'forged-b', requestId: 'forged-b' } });
  }
  const first = h.calls().filter(c => c.name !== 'status');
  for (let i = 0; i < first.length; i += 2) {
    assert.equal(first[i].arguments.requestId, first[i + 1].arguments.requestId);
    assert.match(first[i].arguments.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(first[i].arguments.turn, 'coda-ticket');
  }
  assert.equal(new Set(first.map(c => c.arguments.requestId)).size, 3);
  await h.remote('tool', { name: 'spawn', arguments: { ...args, prompt: 'different task' } });
  const different = h.calls().at(-1).arguments.requestId;
  assert.notEqual(different, first[0].arguments.requestId);
  await h.remote('tool', { name: 'spawn', arguments: { ...args, options: { z: 1, a: ['tail', { y: 2, x: 3 }] } } });
  assert.notEqual(h.calls().at(-1).arguments.requestId, first[0].arguments.requestId, 'array order matters');
  await h.remote('done');
  await h.remote('tool', { name: 'spawn', arguments: args });
  assert.notEqual(h.calls().at(-1).arguments.requestId, first[0].arguments.requestId);
  await h.remote('done');
});

async function pendingDispatch(t, name, options = {}) {
  const started = mailbox(), answer = Promise.withResolvers();
  const h = await harness(t, { ...options, mcpFactory: () => ({
    list: async () => ({ tools: ['status', 'spawn', 'send'].map(name => ({ name })) }),
    call(tool, args, signal) {
      if (tool === 'status') return Promise.resolve({ structuredContent: { turn: 'ticket' } });
      started.push({ args, signal });
      return answer.promise;
    },
    close() {},
  }), diagnostics: false });
  await h.remote('hello');
  const result = h.remote('tool', { name, arguments: { project: 'coda', agent: 'codex', prompt: 'fix', childId: 'child' } });
  const dispatched = await started.next();
  const call = h.events.find(e => e.params.update?.title === `Coda · ${name}`).params.update;
  return { ...h, result, answer, dispatched, call };
}

async function toolUpdate(h) {
  for (;;) {
    const event = await h.messages.next();
    if (event.params.update?.sessionUpdate === 'tool_call_update' && event.params.update.toolCallId === h.call.toolCallId)
      return event.params.update;
  }
}

test('slow spawn/send acknowledge submission at the deadline and update the trace only on actual completion', async t => {
  assert.equal(SUBMISSION_WAIT_MS, 20_000);
  for (const name of ['spawn', 'send']) {
    const h = await pendingDispatch(t, name);
    assert.equal(h.dispatched.signal, null, 'submitted request must outlive the turn and MCP default timeout');
    await assert.rejects(h.remote('done'), /仍有工具/);
    h.adapter.clock.advance(SUBMISSION_WAIT_MS);
    const submitted = await h.result;
    assert.match(submitted.content[0].text, /已提交.*Coda 卡片.*新消息.*不要重试或轮询/);
    assert.equal(h.events.some(e => e.params.update?.toolCallId === h.call.toolCallId && e.params.update.sessionUpdate === 'tool_call_update'), false);
    const actual = { content: [{ type: 'text', text: 'Coda approval result' }] };
    h.answer.resolve(actual);
    const update = await toolUpdate(h);
    assert.equal(update.status, 'completed');
    assert.deepEqual(update.rawOutput, actual);
    await h.remote('done');
    assert.equal(h.adapter.clock.size, 0);
  }
});

test('fast dispatch returns the original result and clears its submission timer', async t => {
  for (const isError of [false, true]) {
    const h = await pendingDispatch(t, 'spawn');
    h.adapter.clock.advance(SUBMISSION_WAIT_MS - 1);
    const actual = { isError, content: [{ type: 'text', text: isError ? 'declined' : 'childId: child' }] };
    h.answer.resolve(actual);
    assert.deepEqual(await h.result, actual);
    assert.equal((await toolUpdate(h)).status, isError ? 'failed' : 'completed');
    assert.equal(h.adapter.clock.size, 1, 'only the turn timeout remains');
    await h.remote('done');
  }
});

test('background dispatch survives done, cancel and timeout; late success/failure only logs', async t => {
  for (const outcome of ['success', 'error', 'rejection']) {
    const logged = mailbox();
    const h = await pendingDispatch(t, 'spawn', { submissionWaitMs: 7, log: text => logged.push(JSON.parse(text)) });
    h.adapter.clock.advance(7);
    await h.result;
    if (outcome === 'success') await h.remote('done');
    else if (outcome === 'error') await h.client.request('session/cancel', { sessionId: h.sessionId });
    else h.adapter.clock.expire();
    await h.remote('say', { text: 'next turn' });
    const count = h.events.length;
    if (outcome === 'rejection') h.answer.reject(new Error('MCP connection failed'));
    else h.answer.resolve({ isError: outcome === 'error', content: [{ type: 'text', text: 'late result' }] });
    const entry = await logged.next();
    assert.equal(entry.toolCallId, h.call.toolCallId);
    assert.equal(entry.state, outcome === 'success' ? 'completed' : 'failed');
    assert.equal(h.events.length, count, 'old completion must not enter the new turn');
    await h.remote('done');
  }
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
  assert.equal(body.preview, 'after load');
  assert.equal((await h.remote('input', { turn: body.turn })).text, 'after load');
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
    assert.equal(body.preview, 'inspect');
    assert.equal(body.text, undefined);
    assert.equal((await h.remote('input', { turn: body.turn })).text, 'inspect');
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
