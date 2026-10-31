import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cursor, envelope, eventSummary, frames, loginRequest, main, NativeClient, sendMessage } from '../scripts/grok-bot-native-probe.mjs';

function terminal(value = {}) {
  const data = envelope(value);
  data[0] = 2;
  return data;
}
async function collect(chunks) {
  const messages = [];
  for await (const value of frames(chunks)) messages.push(value);
  return messages;
}

test('Connect stream handles split headers, split UTF-8 bodies and multiple frames per chunk', async () => {
  const expected = [{ connected: { streamId: 'stream' } }, { rows: { text: '回复😀' } }];
  const wire = Buffer.concat([...expected.map(envelope), terminal()]);
  assert.deepEqual(await collect([wire]), expected);
  assert.deepEqual(await collect([...wire].map(byte => Buffer.from([byte]))), expected);
  assert.deepEqual(await collect([wire.subarray(0, 3), wire.subarray(3, 20), wire.subarray(20)]), expected);
});

test('Connect failures and malformed frames are explicit and do not expose server body text', async () => {
  await assert.rejects(collect([terminal({ error: { code: 'unauthenticated', message: 'SECRET' } })]),
    error => error.message === 'Connect stream failed: unauthenticated');
  const broken = envelope('SECRET');
  broken[5] = 0;
  await assert.rejects(collect([broken]), /^Error: Invalid Connect JSON frame$/);
  await assert.rejects(collect([envelope({ rows: {} })]), /without its terminal frame/);
  await assert.rejects(collect([envelope({}).subarray(0, 6)]), /Incomplete Connect frame/);
  const oversized = Buffer.alloc(5);
  oversized.writeUInt32BE(32 * 1024 * 1024 + 1, 1);
  await assert.rejects(collect([oversized]), /exceeds 32 MiB/);
  const compressed = envelope({}); compressed[0] = 1;
  await assert.rejects(collect([compressed]), /compressed/);
  const unknown = envelope({}); unknown[0] = 4;
  await assert.rejects(collect([unknown]), /Unknown Connect frame flags/);
});

test('native unary and streaming requests use the same authenticated service without redirects', async () => {
  const calls = [];
  const client = new NativeClient({ token: 'test-token', teamId: 12, fetcher: async (url, options) => {
    calls.push({ url, options });
    return options.headers['content-type'] === 'application/connect+json'
      ? new Response(Buffer.concat([envelope({ connected: {} }), terminal()]))
      : Response.json({ agents: [] });
  } });
  assert.deepEqual(await client.request('ListGrokBotAgents', {}), { agents: [] });
  const request = { cursors: [{ agentId: 'test-bot', afterUpdatedSeq: '9' }] };
  const stream = await client.request('WatchGrokBotTranscripts', request, { stream: true });
  assert.deepEqual(await Array.fromAsync(stream), [{ connected: {} }]);
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://api2.cursor.sh/aiserver.v1.GrokBotService/'));
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.headers['x-cursor-team-id'], '12');
    assert.equal(options.headers['connect-protocol-version'], '1');
    assert.equal(options.redirect, 'error');
  }
  assert.equal(calls[0].options.body, '{}');
  assert.deepEqual(calls[1].options.body, envelope(request));
});

test('HTTP failure exposes status and code, never the body or credentials', async () => {
  const client = new NativeClient({ token: 'SECRET', fetcher: async () =>
    Response.json({ code: 'permission_denied', message: 'SECRET' }, { status: 403 }) });
  await assert.rejects(client.request('ListGrokBotAgents', {}),
    error => error.message === 'ListGrokBotAgents: HTTP 403 (permission_denied)');
});

test('watch cursor preserves uint64 precision and the protobuf default generation', () => {
  assert.deepEqual(cursor('bot', { entries: [{ updatedSeq: '9007199254740993' }, { updatedSeq: '9007199254740992' }] }),
    { agentId: 'bot', sessionId: '', generation: 0, afterUpdatedSeq: '9007199254740993' });
  assert.equal(cursor('bot', { generation: 2 }).afterUpdatedSeq, '0');
  assert.equal(cursor('bot', { generation: 2 }).generation, 2);
});

test('event summaries expose activity and settlement without messages, previews or tool details', () => {
  const summary = eventSummary({
    rows: { entries: [{ seq: '1', updatedSeq: '1', entryKind: 'send-message', body: Buffer.from('SECRET').toString('base64') }] },
    agentState: { live: [{ isRunning: false, activity: { kind: 'tool', tool: 'SetStatus', detail: 'SECRET', target: 'SECRET' },
      awaiting: { reason: 'SECRET' }, lastTurnSettlement: { turnId: 'turn', outcome: 'success', privateData: 'SECRET' } }],
    client: [{ lastMessagePreview: 'SECRET' }] },
    turnFailed: { code: 1, summary: 'SECRET', errorDetails: 'SECRET' },
    unknownFutureFrame: { body: 'SECRET' },
  });
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|U0VDUkVU/);
  assert.equal(summary.rows.entries[0].entryKind, 'send-message');
  assert.equal(summary.rows.entries[0].bodyBytes, 6);
  assert.equal(summary.agentState.live[0].activity.tool, 'SetStatus');
  assert.equal(summary.agentState.live[0].lastTurnSettlement.outcome, 'success');
});

test('send passes the user text unchanged; acceptance does not fabricate a completed turn or retry', async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    return { dispatched: true, delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL' };
  } };
  const result = await sendMessage(client, 'bot', '17+25');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'SendGrokBotUserMessage');
  assert.equal(calls[0].params.text, '17+25');
  assert.equal(calls[0].params.agentId, 'bot');
  assert.equal(result.messageId, calls[0].params.messageId);
  assert.equal(Object.hasOwn(result, 'stopReason'), false);
  await assert.rejects(sendMessage(client, 'bot', '  '), /nonempty/);
  assert.equal(calls.length, 1);
  await assert.rejects(sendMessage({ request: async () => { throw new Error('rejected'); } }, 'bot', 'hello'), /rejected/);
});

test('login uses a fresh PKCE challenge, and invalid commands fail before reading credentials', async () => {
  const pending = loginRequest();
  const url = new URL(pending.url);
  assert.equal(url.origin, 'https://cursor.com');
  assert.equal(url.searchParams.get('challenge'), createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('uuid'), pending.uuid);
  assert.ok(!pending.url.includes(pending.verifier));
  assert.notEqual(loginRequest().verifier, pending.verifier);
  for (const args of [[], ['unknown'], ['watch'], ['send', 'bot', 'unexpected'], ['login', 'unexpected']]) {
    await assert.rejects(main(args), /Usage:/);
  }
});
