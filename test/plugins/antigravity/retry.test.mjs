// agy's notice that it retries a model request is told from the text of an answer: only a chunk that is exactly that one line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryNotice } from '../../../plugins/antigravity/agent/retry.mjs';

const chunk = (text, sessionUpdate = 'agent_message_chunk', type = 'text') => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate, content: { type, text } } } });
const reason = 'request failed: stream idle timeout (5m0s): context deadline exceeded';

test('the retry notices of agy 1.5.9, as its journal has them, are told', () => {
  for (const attempt of [1, 2, 3]) {
    const text = `\n⚠ API error (attempt ${attempt}): ${reason}\n`;
    assert.equal(retryNotice(chunk(text)), text);
  }
  assert.notEqual(retryNotice(chunk('⚠ API error (attempt 12): UNAVAILABLE (code 503): The service is currently unavailable.')), null, 'without the newlines around it, too');
});

test('text with anything else in it is the answer, and is not told', () => {
  const line = `⚠ API error (attempt 1): ${reason}`;
  for (const text of [`${line}\nsecond line`, `before\n${line}`, `before ${line}`, `${line} after\nand more`, `\n${line}\n\n${line}\n`,
    '⚠ API error (attempt 0): x', '⚠ API error (attempt -1): x', '⚠ API error (attempt 1.5): x', '⚠ API error (attempt x): x', '⚠ API error (attempt 1):', '⚠ API error (attempt 1): ',
    '⚠ API error: request failed', 'API error (attempt 1): x', '`⚠ API error (attempt 1): x`', '⚠ API error (attempt 1): x\u2028y', '']) {
    assert.equal(retryNotice(chunk(text)), null, JSON.stringify(text));
  }
});

test('the same text in a thought, another update, another content or another message is not told', () => {
  const text = `\n⚠ API error (attempt 1): ${reason}\n`;
  for (const sessionUpdate of ['agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage_update']) assert.equal(retryNotice(chunk(text, sessionUpdate)), null, sessionUpdate);
  assert.equal(retryNotice(chunk(text, 'agent_message_chunk', 'image')), null);
  assert.equal(retryNotice({ ...chunk(text), method: 'session/prompt' }), null);
  assert.equal(retryNotice({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }), null);
  assert.equal(retryNotice({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 1 } } } }), null);
});
