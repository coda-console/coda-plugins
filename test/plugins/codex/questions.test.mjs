// Codex's async messages and questions through the Codex entry (plugins/codex/agent/questions.mjs): the message is shown,
// the questions of a call are one form card in Coda's turn, and the turn goes on until each card is answered and Codex told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { clientCapabilities } from '../../../check/coda/domain/agent-protocol.mjs';
import { CodexQuestions, codexAsyncMessage, shownCodexAsyncMessages } from '../../../plugins/codex/agent/questions.mjs';
import { pluginEnv } from '../command.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const QUESTIONS = [{ title: '打开链接登录 npm', options: ['已完成登录', '登录失败'] }, { title: '还要发哪个包？', options: null }];
const message = (questions = null, text = '登录 npm') => ({ type: 'agentMessage', id: 'ask', text, phase: 'final_answer', memoryCitation: null, delivery: 'async', questions });
const said = (item, streamed = false) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: codexAsyncMessage(item, streamed) } });
const prompt = id => ({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: '发布' }] } });
const ended = (id, stopReason = 'end_turn') => ({ jsonrpc: '2.0', id, result: { stopReason } });
const FORM = {
  sessionId: 's', mode: 'form', message: 'Codex 需要你的回答',
  requestedSchema: { type: 'object', required: ['q0', 'q1'], properties: {
    q0: { type: 'string', title: '打开链接登录 npm', oneOf: [{ const: '已完成登录', title: '已完成登录' }, { const: '登录失败', title: '登录失败' },
      { const: 'coda:other', title: '其他（写在下面）' }] },
    q0_other: { type: 'string', title: '其他' },
    q1: { type: 'string', title: '还要发哪个包？' },
  } },
};
const ANSWER = { action: 'accept', content: { q0: '已完成登录', q1: 'codex' } };
const ANSWERED = '回答你的提问「打开链接登录 npm」：已完成登录\n回答你的提问「还要发哪个包？」：codex';

// A turn of Coda's with one card asked in it: the entry, the card's id, and all Coda was told.
function asked() {
  const questions = new CodexQuestions(), coda = [];
  assert.deepEqual(questions.fromCoda(prompt(1)).agent, [prompt(1)]);
  const out = questions.fromAgent(said(message(QUESTIONS)));
  coda.push(...out.coda);
  const card = out.coda.find(m => m.method === 'elicitation/create');
  return { questions, card: card.id, coda };
}

test('an async message is shown from its text unless it was streamed; others stay codex-acp\'s', () => {
  assert.deepEqual(codexAsyncMessage(message(), false), { sessionUpdate: 'agent_message_chunk', messageId: 'ask', content: { type: 'text', text: '登录 npm' } });
  assert.equal(codexAsyncMessage(message(), true), null);
  assert.equal(codexAsyncMessage({ ...message(), delivery: null }, false), null);
  assert.equal(codexAsyncMessage({ ...message(), delivery: null, questions: QUESTIONS }, false), null);
  // Shown as it is, with no card, in a turn or not.
  const questions = new CodexQuestions();
  assert.deepEqual(questions.fromAgent(said(message())), { agent: [], coda: [said(message())] });
  questions.fromCoda(prompt(1));
  assert.deepEqual(questions.fromAgent(said(message())), { agent: [], coda: [said(message())] });
});

test('the questions of one call are one form card after the text, written the way Claude\'s are', () => {
  const { coda } = asked();
  assert.deepEqual(coda.map(m => m.method), ['session/update', 'elicitation/create']);
  assert.deepEqual(coda[0].params.update, { sessionUpdate: 'agent_message_chunk', messageId: 'ask', content: { type: 'text', text: '登录 npm' } });
  assert.deepEqual(coda[1].params, FORM);
  // Streamed text is not said again; the card still is.
  const questions = new CodexQuestions();
  questions.fromCoda(prompt(1));
  assert.deepEqual(questions.fromAgent(said(message(QUESTIONS), true)).coda.map(m => m.method), ['elicitation/create']);
});

test('answered while codex-acp\'s prompt runs, the answer is steered in and Coda\'s turn ends with that prompt', () => {
  const { questions, card } = asked();
  const [steer] = questions.fromCoda({ jsonrpc: '2.0', id: card, result: ANSWER }).agent;
  assert.deepEqual(steer.method, '_session/steering');
  assert.deepEqual(steer.params, { sessionId: 's', prompt: [{ type: 'text', text: ANSWERED }], _meta: { steering: { idleBehavior: 'promptRequired' } } });
  assert.deepEqual(questions.fromAgent({ jsonrpc: '2.0', id: steer.id, result: { outcome: 'injected' } }), { agent: [], coda: [] });
  assert.deepEqual(questions.fromAgent(ended(1)), { agent: [], coda: [ended(1)] });
  assert.equal(questions.turn, null);
});

test('answered after Codex stopped, the answer runs as the entry\'s prompt and Coda is answered once, at its end', () => {
  const { questions, card } = asked();
  assert.deepEqual(questions.fromAgent(ended(1)), { agent: [], coda: [] });
  const [next] = questions.fromCoda({ jsonrpc: '2.0', id: card, result: ANSWER }).agent;
  assert.deepEqual([next.method, next.params], ['session/prompt', { sessionId: 's', prompt: [{ type: 'text', text: ANSWERED }] }]);
  const update = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，继续发布' } } } };
  assert.deepEqual(questions.fromAgent(update), { agent: [], coda: [update] });
  assert.deepEqual(questions.fromAgent({ jsonrpc: '2.0', id: next.id, result: { stopReason: 'end_turn', usage: { totalTokens: 9 } } }),
    { agent: [], coda: [{ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn', usage: { totalTokens: 9 } } }] });
});

test('a steer codex-acp could not inject runs as the next prompt once its prompt ends', () => {
  const { questions, card } = asked();
  const [steer] = questions.fromCoda({ jsonrpc: '2.0', id: card, result: ANSWER }).agent;
  assert.deepEqual(questions.fromAgent({ jsonrpc: '2.0', id: steer.id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } }), { agent: [], coda: [] });
  const [next] = questions.fromAgent(ended(1)).agent;
  assert.deepEqual([next.method, next.params.prompt[0].text], ['session/prompt', ANSWERED]);
  assert.deepEqual(questions.fromAgent(ended(next.id)), { agent: [], coda: [ended(1)] });
});

for (const [why, result] of [['declined', { action: 'decline' }], ['withdrawn by Coda', { action: 'cancel' }]]) test(`a card ${why} tells Codex the user did not answer`, () => {
  const { questions, card } = asked();
  questions.fromAgent(ended(1));
  const [next] = questions.fromCoda({ jsonrpc: '2.0', id: card, result }).agent;
  assert.equal(next.params.prompt[0].text, '用户没有回答「打开链接登录 npm」\n用户没有回答「还要发哪个包？」');
});

test('a cancel withdraws the open cards and ends Coda\'s turn as cancelled, now or with codex-acp\'s prompt', () => {
  const held = asked();
  held.questions.fromAgent(ended(1));
  const cancel = { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } };
  assert.deepEqual(held.questions.fromCoda(cancel), { agent: [cancel], coda: [
    { jsonrpc: '2.0', method: '$/cancel_request', params: { id: held.card } }, ended(1, 'cancelled')] });
  // The withdrawn card's answer is not Codex's to hear.
  assert.deepEqual(held.questions.fromCoda({ jsonrpc: '2.0', id: held.card, result: { action: 'cancel' } }), { agent: [], coda: [] });

  // codex-acp's prompt may still end as done when Codex's turn already had: Coda's still ends as cancelled.
  const running = asked();
  assert.deepEqual(running.questions.fromCoda(cancel), { agent: [cancel], coda: [{ jsonrpc: '2.0', method: '$/cancel_request', params: { id: running.card } }] });
  assert.deepEqual(running.questions.fromAgent(ended(1)), { agent: [], coda: [ended(1, 'cancelled')] });
});

test('steering after Codex stopped runs as the turn\'s next prompt, and the card stays', () => {
  const { questions, card } = asked();
  questions.fromAgent(ended(1));
  const steer = { jsonrpc: '2.0', id: 'steer-1', method: '_session/steering', params: { sessionId: 's', prompt: [{ type: 'text', text: '顺便看下日志' }], _meta: { steering: { idleBehavior: 'promptRequired' } } } };
  const { agent: [next], coda } = questions.fromCoda(steer);
  assert.deepEqual(coda, [{ jsonrpc: '2.0', id: 'steer-1', result: { outcome: 'injected' } }]);
  assert.deepEqual([next.method, next.params], ['session/prompt', { sessionId: 's', prompt: steer.params.prompt }]);
  assert.deepEqual(questions.fromAgent(ended(next.id)), { agent: [], coda: [] });
  const [answer] = questions.fromCoda({ jsonrpc: '2.0', id: card, result: ANSWER }).agent;
  assert.equal(answer.params.prompt[0].text, ANSWERED);
  assert.deepEqual(questions.fromAgent(ended(answer.id)), { agent: [], coda: [ended(1)] });
});

test('the async message patch fails loudly once the locked adapter changes', () => {
  const bundle = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  assert.match(shownCodexAsyncMessages(bundle), /return codexAsyncMessage\(event\.item, this\.codaStreamedMessages\.delete\(event\.item\.id\)\);/);
  for (const [before, after] of [['agentMessagePhases = /* @__PURE__ */ new Map();', 'agentMessagePhases = new Map();'],
    ['async createTextEvent(event) {', 'async createTextEvent(delta) {'],
    ['return this.subagents.legacyCollaborationCompleted(event.item);\n      case "agentMessage":', 'return this.subagents.legacyCollaborationCompleted(event.item);\n      case "agentMessage2":']]) {
    assert.throws(() => shownCodexAsyncMessages(bundle.replace(before, after)), /no longer matches/);
  }
});

// Through the real adapter: a fixture app-server says the async message; Coda answers the card as the test says.
for (const path of ['message', 'after', 'during', 'cancel']) test(`through the real adapter: ${path}`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-questions-'));
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700); writeFileSync(join(root, 'died'), '');
  const messages = [];
  let carded;
  const card = new Promise(resolve => { carded = resolve; });
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: pluginEnv('codex', { CODEX_PATH: program, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home'), FAKE_CODEX_QUESTIONS: JSON.stringify(QUESTIONS) }),
    onMessage(message) { messages.push(message); if (message.method === 'elicitation/create') carded(message); } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  const { sessionId } = await request('session/new', { cwd: root, mcpServers: [] });
  const text = { message: 'send_user_message_async', after: 'request_user_input_async', during: 'request_user_input_async clock.sleep hold', cancel: 'request_user_input_async' }[path];
  let finished = false;
  const turn = request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then(result => { finished = true; return result; });
  const lines = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  // The turns of the thread, not those that make its title.
  const turns = () => lines('prompts.ndjson').filter(p => !p.outputSchema);
  const shown = () => messages.filter(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').map(m => m.params.update.content.text);
  if (path === 'message') {
    assert.equal((await turn).stopReason, 'end_turn');
    assert.deepEqual(shown(), ['先说一声：开始发布了']);
    assert.equal(messages.some(m => m.method === 'elicitation/create'), false);
    return;
  }
  const asked = await card;
  assert.deepEqual(asked.params, { ...FORM, sessionId });
  assert.deepEqual(shown(), ['打开链接登录 npm\n- 已完成登录\n- 登录失败\n\n还要发哪个包？']);
  if (path === 'after') {
    // Codex's own turn is over; Coda's goes on.
    while (turns().length < 1) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(finished, false, 'Coda\'s turn goes on while the card waits');
  if (path === 'cancel') {
    proc.notify('session/cancel', { sessionId });
    assert.equal((await turn).stopReason, 'cancelled');
    assert.deepEqual(messages.filter(m => m.method === '$/cancel_request').map(m => m.params.id), [asked.id]);
    return;
  }
  proc.respond(asked.id, ANSWER);
  assert.equal((await turn).stopReason, 'end_turn');
  const told = path === 'after' ? turns().slice(1).map(p => p.input[0].text) : lines('steers.ndjson').map(p => p.input[0].text);
  assert.deepEqual(told, [ANSWERED]);
  assert.equal(turns().length, path === 'after' ? 2 : 1);
});
