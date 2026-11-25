import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldThoughtIntoOutput } from '../../../plugins/opencode/agent/usage.mjs';

// OpenCode 2.1.4 (~/.opencode/bin/opencode, the CLI the plugin runs): outputTokens = tokens.output, totalTokens = input + output +
// reasoning + cache read + cache write, thoughtTokens only when reasoning > 0.
const reply = usage => ({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', usage } });

test('a turn with thinking counts it in outputTokens and keeps thoughtTokens as the breakdown', () => {
  const usage = { inputTokens: 100, outputTokens: 40, thoughtTokens: 25, cachedReadTokens: 10, cachedWriteTokens: 5, totalTokens: 180 };
  const folded = foldThoughtIntoOutput(reply(usage));
  assert.deepEqual(folded.result.usage, { ...usage, outputTokens: 65 });
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens } = folded.result.usage;
  assert.equal(inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens, totalTokens);
  assert.equal(usage.outputTokens, 40);
});

test('a turn without thinking is unchanged and gains no field', () => {
  const message = reply({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
  assert.equal(foldThoughtIntoOutput(message), message);
  assert.equal(foldThoughtIntoOutput(reply({ inputTokens: 1, outputTokens: 2, thoughtTokens: 0, totalTokens: 3 })).result.usage.outputTokens, 2);
});

test('missing or invalid fields, and messages without usage, pass unchanged', () => {
  for (const usage of [{ inputTokens: 1, thoughtTokens: 5, totalTokens: 6 }, { outputTokens: '2', thoughtTokens: 5 }, { outputTokens: 2, thoughtTokens: -5 },
    { outputTokens: 2, thoughtTokens: NaN }, { outputTokens: -3, thoughtTokens: 5 }, { outputTokens: 2, thoughtTokens: 1.5 }, { outputTokens: 2.5, thoughtTokens: 5 },
    { outputTokens: Number.MAX_SAFE_INTEGER, thoughtTokens: 1 }, { outputTokens: 2, thoughtTokens: Infinity }, { outputTokens: 2, thoughtTokens: '5' }, { outputTokens: 2, thoughtTokens: null }]) {
    const message = reply(usage);
    assert.equal(foldThoughtIntoOutput(message), message, JSON.stringify(usage));
  }
  for (const message of [{ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } }, { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'x' } },
    { jsonrpc: '2.0', method: 'session/update', params: {} }]) assert.equal(foldThoughtIntoOutput(message), message);
});
