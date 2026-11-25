// Coda's backend/test/codex-app-server-fixture.mjs at ef1d2311, for the Codex entry's contract check here.
// A minimal Codex app-server for driving the real codex-acp. The first turn of a state
// directory dies mid-turn with exit code 0, as a terminated app-server does; later turns complete. FAKE_CODEX_EXIT makes it
// die with that exit code (after a line on stderr) or by that signal (`SIGKILL`) instead; FAKE_CODEX_SAY instead has it say a message and go on, its pid in `pid` in the state directory, for the test to end it once the message is heard.
// FAKE_CODEX_MODEL_ERROR instead returns a model-service error of that kind (`codexErrorInfo`) on that first turn.
// FAKE_CODEX_RPC_ERROR_METHOD fails that native method before it starts, with FAKE_CODEX_RPC_ERROR as its explanation;
// FAKE_CODEX_FAIL_ONCE (`<method>` or `<method>#<n>`) fails that method the first (or n-th) time it is asked in the state
// directory, across the app-servers started there. A turn on a thread this app-server has not started or resumed fails as
// Codex fails it: the thread is not loaded.
// What thread/start, thread/resume and thread/name/set are asked goes to threads.ndjson in the state directory, each turn/start to
// prompts.ndjson. FAKE_CODEX_HOLD=thread/read holds the answer to thread/read, saying so by `held` in the state directory,
// until `release` is there. The thread is written down (rollout.jsonl there, its `path`, as thread/start and thread/resume
// answer it) once it is named or has a turn; a turn gives the model the tools of FAKE_CODEX_TOOLS (`additional_tools` there).
// config/read gives the configured developer instructions from developer_instructions.txt there, when there is one.
// A later turn whose input names `subagent` runs a subagent that answers and ends; one that names `background` leaves a
// command in the background, listed until it is terminated; one that names `send_user_message_async` or
// `request_user_input_async` says that async message, the latter with the questions of FAKE_CODEX_QUESTIONS; one that names
// `unrecognized` says what the Codex entry has not registered (two items of a new type with text, one without, a new
// notification and request) beside what it has (an agent message streamed, another not). What a turn is steered with goes
// to steers.ndjson, the answers to its requests to answers.ndjson. One that names `compaction` compacts the thread as the locked
// Codex does (a `contextCompaction` item, started and completed), with the deprecated `thread/compacted` too before it
// (`legacy-first`), after it (`legacy-last`), or alone (`legacy-only`); `compaction-failed` starts it and ends the turn failed.
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const died = join(process.env.FAKE_CODEX_STATE, 'died'), rollout = join(process.env.FAKE_CODEX_STATE, 'rollout.jsonl');
const [failing, failingAt = '1'] = (process.env.FAKE_CODEX_FAIL_ONCE ?? '').split('#'), failingCalls = join(process.env.FAKE_CODEX_STATE, 'failing-calls');
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const thread = { id: 'fake-thread', turns: [], historyMode: 'paginated', path: rollout };
const model = { id: 'fake', model: 'fake', displayName: 'Fake', description: '', isDefault: true, hidden: false,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], inputModalities: ['text'] };
const models = process.env.FAKE_CODEX_MODELS ? JSON.parse(process.env.FAKE_CODEX_MODELS) : [model];
const session = { thread, model: models[0].model, reasoningEffort: 'medium', modelProvider: 'openai', serviceTier: process.env.FAKE_CODEX_SERVICE_TIER ?? null };
const results = {
  'account/read': { account: { type: 'apiKey' }, requiresOpenaiAuth: false },
  'model/list': { data: models, nextCursor: null },
  'skills/list': { data: [], nextCursor: null },
  'thread/start': session,
  'thread/resume': { ...session, turnsBackwardsCursor: null },
};
const command = { type: 'commandExecution', id: 'command-1', command: 'sleep 100', cwd: '/', processId: '4242', status: 'inProgress', commandActions: [], source: 'agent' };
const count = { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 };
// FAKE_CODEX_TOKENS: the thread's count is kept across the app-server's restarts, as Codex keeps it in its rollout, and told again when the thread is resumed.
const kept = join(process.env.FAKE_CODEX_STATE, 'tokens.json');
const tokenUsage = () => existsSync(kept) ? JSON.parse(readFileSync(kept, 'utf8')) : null;
let terminals = [], instructions = '', loaded = false;
let sleeping = null;
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\n')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id !== undefined && !message.method) appendFileSync(join(process.env.FAKE_CODEX_STATE, 'answers.ndjson'), JSON.stringify(message) + '\n');
    if (message.id === undefined || !message.method) continue;
    if (message.method === 'turn/steer') appendFileSync(join(process.env.FAKE_CODEX_STATE, 'steers.ndjson'), JSON.stringify(message.params) + '\n');
    if (sleeping && ['turn/steer', 'turn/interrupt'].includes(message.method)) {
      const { turn, item } = sleeping; sleeping = null;
      send({ id: message.id, result: message.method === 'turn/steer' ? { turnId: turn.id } : {} });
      if (message.method === 'turn/steer') send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });
      send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: message.method === 'turn/steer' ? 'completed' : 'interrupted' } } });
      continue;
    }
    if (message.method === 'turn/start') appendFileSync(join(process.env.FAKE_CODEX_STATE, 'prompts.ndjson'), JSON.stringify(message.params) + '\n');
    if (['thread/start', 'thread/resume'].includes(message.method) && !message.params.ephemeral) instructions = message.params.developerInstructions ?? '';
    if (['thread/start', 'thread/resume', 'thread/name/set'].includes(message.method)) appendFileSync(join(process.env.FAKE_CODEX_STATE, 'threads.ndjson'), JSON.stringify({ method: message.method, params: message.params }) + '\n');
    if (['thread/name/set', 'turn/start'].includes(message.method)) appendFileSync(rollout, '');
    if (message.method === 'turn/start' && !message.params.outputSchema && process.env.FAKE_CODEX_TOOLS) {
      appendFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'additional_tools', tools: JSON.parse(process.env.FAKE_CODEX_TOOLS) } }) + '\n');
    }
    if (message.method === 'thread/read') {
      const answer = () => send({ id: message.id, result: { thread: { ...thread, path: rollout } } });
      if (process.env.FAKE_CODEX_HOLD !== 'thread/read') { answer(); continue; }
      const state = process.env.FAKE_CODEX_STATE;
      writeFileSync(join(state, 'held'), '');
      const held = setInterval(() => { if (existsSync(join(state, 'release'))) { clearInterval(held); answer(); } }, 10);
      continue;
    }
    if (message.method === process.env.FAKE_CODEX_RPC_ERROR_METHOD && (message.method !== 'turn/start' || !existsSync(died))) {
      writeFileSync(died, '');
      send({ id: message.id, error: { code: -32603, message: process.env.FAKE_CODEX_RPC_ERROR } }); continue;
    }
    if (message.method === failing) {
      appendFileSync(failingCalls, '.');
      if (readFileSync(failingCalls, 'utf8').length === Number(failingAt)) { send({ id: message.id, error: { code: -32603, message: `${message.method} failed` } }); continue; }
    }
    if (['thread/start', 'thread/resume'].includes(message.method) && !message.params.ephemeral) loaded = true;
    if (message.method === 'turn/start' && !message.params.outputSchema && !loaded) {
      send({ id: message.id, error: { code: -32600, message: `thread not loaded: ${message.params.threadId}` } }); continue;
    }
    if (message.method === 'thread/backgroundTerminals/list') { send({ id: message.id, result: { data: terminals, nextCursor: null } }); continue; }
    if (message.method === 'thread/backgroundTerminals/terminate') {
      const terminated = terminals.some(t => t.processId === message.params.processId);
      terminals = terminals.filter(t => t.processId !== message.params.processId);
      send({ id: message.id, result: { terminated } }); continue;
    }
    if (message.method === 'config/read') {
      const configured = join(process.env.FAKE_CODEX_STATE, 'developer_instructions.txt');
      send({ id: message.id, result: { config: { developer_instructions: existsSync(configured) ? readFileSync(configured, 'utf8') : null }, layers: null, origins: {} } }); continue;
    }
    if (message.method !== 'turn/start') {
      send({ id: message.id, result: results[message.method] ?? {} });
      const before = tokenUsage();
      if (message.method === 'thread/resume' && before) send({ method: 'thread/tokenUsage/updated', params: { threadId: thread.id, turnId: before.turnId, tokenUsage: { last: count, total: before.total, modelContextWindow: 1000 } } });
      continue;
    }
    const turn = { id: `turn-${Date.now()}`, items: [], status: 'inProgress', error: null };
    // FAKE_CODEX_TOKENS: the thread's count told again outside any turn of this process (a `snapshot.json` the test left), as Codex does when a thread is resumed.
    const snapshot = join(process.env.FAKE_CODEX_STATE, 'snapshot.json');
    if (existsSync(snapshot)) {
      send({ method: 'thread/tokenUsage/updated', params: { threadId: thread.id, turnId: 'earlier-turn', tokenUsage: { last: count, total: JSON.parse(readFileSync(snapshot, 'utf8')), modelContextWindow: 1000 } } });
      unlinkSync(snapshot);
    }
    send({ id: message.id, result: { turn } });
    send({ method: 'turn/started', params: { threadId: thread.id, turn } });
    if (!existsSync(died)) {
      writeFileSync(died, '');
      if (process.env.FAKE_CODEX_MODEL_ERROR) {
        const error = { message: process.env.FAKE_CODEX_MODEL_MESSAGE ?? JSON.stringify({ type: 'error', error: { message: "model 'gpt-6.1-sol' is not enabled in rustponsesapi",
          type: 'invalid_request_error', param: null, code: null }, status: 400 }),
        codexErrorInfo: process.env.FAKE_CODEX_MODEL_ERROR.startsWith('{') ? JSON.parse(process.env.FAKE_CODEX_MODEL_ERROR) : process.env.FAKE_CODEX_MODEL_ERROR, additionalDetails: null };
        if (!process.env.FAKE_CODEX_TERMINAL_ONLY) send({ method: 'error', params: { threadId: thread.id, turnId: turn.id, willRetry: false, error } });
        send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'failed', error } } });
      } else if (process.env.FAKE_CODEX_SAY) {
        writeFileSync(join(process.env.FAKE_CODEX_STATE, 'pid'), String(process.pid));
        send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: { type: 'agentMessage', id: 'said', text: 'working', phase: 'commentary', memoryCitation: null } } });
      } else setTimeout(() => {
        const exit = process.env.FAKE_CODEX_EXIT ?? '0';
        if (!/^\d+$/.test(exit)) process.kill(process.pid, exit);
        else { if (exit !== '0') console.error('fake codex: boom'); process.exit(Number(exit)); }
      }, 100);
      continue;
    }
    const input = JSON.stringify(message.params.input ?? '');
    for (const tool of ['send_user_message_async', 'request_user_input_async']) if (input.includes(tool) && !message.params.outputSchema) {
      const questions = tool === 'request_user_input_async' ? JSON.parse(process.env.FAKE_CODEX_QUESTIONS) : null;
      const text = questions ? questions.map(q => [q.title, ...(q.options ?? []).map(o => `- ${o}`)].join('\n')).join('\n\n') : '先说一声：开始发布了';
      send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: { type: 'agentMessage', id: `${tool}-${turn.id}`, text,
        phase: 'final_answer', memoryCitation: null, delivery: 'async', questions } } });
    }
    if (input.includes('unrecognized') && !message.params.outputSchema) {
      const said = (method, item) => send({ method, params: { threadId: thread.id, turnId: turn.id, item } });
      for (const [id, text] of [['foo-1', '新东西'], ['foo-2', '又一个新东西']]) {
        said('item/started', { type: 'fooBar', id, text: '' });
        said('item/completed', { type: 'fooBar', id, text });
      }
      said('item/completed', { type: 'bazQux', id: 'baz-1' });
      const message = { type: 'agentMessage', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
      said('item/started', { ...message, id: 'streamed', text: '' });
      send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'streamed', delta: '逐段的回复' } });
      said('item/completed', { ...message, id: 'streamed', text: '逐段的回复' });
      said('item/completed', { ...message, id: 'plain', text: '没有增量的回复' });
      send({ method: 'thread/fooChanged', params: { threadId: thread.id } });
      send({ method: 'thread/readState/changed', params: { threadId: thread.id } });
      send({ id: 'fake-request', method: 'item/tool/bar', params: { threadId: thread.id, turnId: turn.id } });
    }
    if (input.includes('compaction') && !message.params.outputSchema) {
      const item = { type: 'contextCompaction', id: `compaction-${turn.id}` };
      const legacy = () => send({ method: 'thread/compacted', params: { threadId: thread.id, turnId: turn.id } });
      if (input.includes('compaction-failed')) {
        send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item } });
        send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'failed', error: { message: 'compaction failed', codexErrorInfo: null, additionalDetails: null } } } });
        continue;
      }
      if (input.includes('legacy-first') || input.includes('legacy-only')) legacy();
      if (!input.includes('legacy-only')) {
        send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item } });
        send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });
      }
      if (input.includes('legacy-last')) legacy();
    }
    if (input.includes('clock.sleep') && !message.params.outputSchema) {
      const item = { type: 'sleep', id: `sleep-${turn.id}`, durationMs: 7200000 };
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item } });
      if (input.includes('hold')) { sleeping = { turn, item }; continue; }
      send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });
    }
    if (input.includes('subagent')) {
      const child = 'fake-child', childTurn = { id: `child-${turn.id}`, items: [], status: 'inProgress', error: null };
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'subAgentActivity', id: 'activity-1', agentThreadId: child, agentPath: '/root/echo_check', kind: 'started' } } });
      send({ method: 'turn/started', params: { threadId: child, turn: childTurn } });
      send({ method: 'item/agentMessage/delta', params: { threadId: child, turnId: childTurn.id, itemId: 'child-message', delta: '子 Agent 的回答' } });
      if (process.env.FAKE_CODEX_TOKENS) send({ method: 'thread/tokenUsage/updated', params: { threadId: child, turnId: childTurn.id, tokenUsage: { last: count, total: count, modelContextWindow: 1000 } } });
      send({ method: 'turn/completed', params: { threadId: child, turn: { ...childTurn, status: 'completed' } } });
    }
    // A subagent spawned and told of before its session is made: with native subagent sessions its first notifications are held back and handled again then.
    if (input.includes('staged children')) {
      const child = 'staged-child', childTurn = { id: `child-${turn.id}`, items: [], status: 'inProgress', error: null };
      const twice = { totalTokens: 60, inputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 4 };
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'inProgress', senderThreadId: thread.id,
        receiverThreadIds: [child], prompt: 'echo', model: null, reasoningEffort: null, agentsStates: {} } } });
      send({ method: 'turn/started', params: { threadId: child, turn: childTurn } });
      for (const total of [count, twice]) send({ method: 'thread/tokenUsage/updated', params: { threadId: child, turnId: childTurn.id, tokenUsage: { last: count, total, modelContextWindow: 1000 } } });
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'subAgentActivity', id: 'activity-1', agentThreadId: child, agentPath: '/root/staged_check', kind: 'started' } } });
      send({ method: 'turn/completed', params: { threadId: child, turn: { ...childTurn, status: 'completed' } } });
    }
    // A subagent whose turn begins, and tells its count twice, before its parent tells of it (Codex gives the subagent its first input, then the parent says it spawned it); it counts once more after.
    if (input.includes('early children')) {
      const child = 'early-child', childTurn = { id: `child-${turn.id}`, items: [], status: 'inProgress', error: null };
      const told = times => ({ method: 'thread/tokenUsage/updated', params: { threadId: child, turnId: childTurn.id, tokenUsage: { last: count,
        total: Object.fromEntries(Object.entries(count).map(([key, value]) => [key, value * times])), modelContextWindow: 1000 } } });
      send({ method: 'turn/started', params: { threadId: child, turn: childTurn } });
      send(told(1)); send(told(2));
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'subAgentActivity', id: 'activity-1', agentThreadId: child, agentPath: '/root/early_check', kind: 'started' } } });
      send(told(3));
      send({ method: 'turn/completed', params: { threadId: child, turn: { ...childTurn, status: 'completed' } } });
    }
    // The checker's question about the session instructions, answered from the developer instructions as a model would.
    if (input.includes('What is the Coda check word?')) {
      const word = /reply with exactly (\S+) and nothing else/.exec(instructions)?.[1] ?? '不知道';
      send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'answer', delta: word } });
    }
    if (input.includes('background')) {
      terminals = [{ itemId: command.id, processId: command.processId, command: command.command }];
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: command } });
    }
    // FAKE_CODEX_TOKENS: the turn calls the model that many times, each saying what it used (`total` the thread's so far), as Codex does before it completes.
    if (process.env.FAKE_CODEX_TOKENS && !message.params.outputSchema) {
      const total = tokenUsage()?.total ?? {};
      for (let i = 0; i < Number(process.env.FAKE_CODEX_TOKENS); i++) {
        for (const key of Object.keys(count)) total[key] = (total[key] ?? 0) + count[key];
        send({ method: 'thread/tokenUsage/updated', params: { threadId: thread.id, turnId: turn.id, tokenUsage: { last: count, total: { ...total }, modelContextWindow: 1000 } } });
      }
      writeFileSync(kept, JSON.stringify({ total, turnId: turn.id }));
    }
    send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
  }
});
