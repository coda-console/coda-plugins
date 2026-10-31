import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallCache, toolCallFields } from '../../../plugins/claude/agent/tools.mjs';

const preview = toolCallFields('Write', { file_path: '/x', content: 'next' }).content;
const written = (text = 'next', old = 'before') => ({ type: 'update', filePath: '/x', originalFile: old, content: text, structuredPatch: [] });
const diff = (text = 'next', old = 'before') => [{ type: 'diff', path: '/x', oldText: old, newText: text }];

test('completed-call eviction preserves pending tools, and failed calls also leave the pending set', () => {
  const cache = new ToolCallCache({ maxCompleted: 2 });
  for (const id of ['pending', 'first', 'failed', 'last']) cache.start(id, 'Write', preview);
  cache.finish('first', written());
  assert.deepEqual(cache.finish('failed', undefined, true), preview);
  cache.finish('last', written());
  assert.equal(cache.finish('first'), undefined, 'old completed results are ignored');
  assert.deepEqual(cache.finish('pending', written()), diff(), 'pending calls survive completion pressure');
  assert.equal(cache.finish('failed'), undefined, 'failed results were eligible for eviction too');
  assert.equal(cache.finish('unknown', written()), undefined, 'a late result cannot register itself');
});

test('the byte budget bounds repeated writes to one file independently of the call-count limit', () => {
  const cache = new ToolCallCache({ maxCompleted: 128, maxBytes: 1000 });
  const text = 'n'.repeat(150), old = 'o'.repeat(150);
  for (let i = 0; i < 20; i++) {
    cache.start(`write-${i}`, 'Write', preview);
    assert.deepEqual(cache.finish(`write-${i}`, written(text, old)), diff(text, old));
  }
  for (let i = 0; i < 19; i++) assert.equal(cache.finish(`write-${i}`), undefined);
  assert.deepEqual(cache.finish('write-19'), diff(text, old));
});

test('oversized diffs are delivered but not retained, without evicting smaller completed calls', () => {
  const cache = new ToolCallCache({ maxBytes: 1000 });
  cache.start('small', 'Write', preview); cache.finish('small', written());
  cache.start('large', 'Write', preview);
  const text = 'n'.repeat(1000);
  assert.deepEqual(cache.finish('large', written(text)), diff(text));
  assert.equal(cache.finish('large'), undefined, 'the oversized call is no longer pending or cached');
  assert.deepEqual(cache.finish('small'), diff());
});

test('repeated results keep actual diffs and refresh recency without accumulating their size', () => {
  const cache = new ToolCallCache({ maxCompleted: 2, maxBytes: 1000 });
  cache.start('first', 'Write', preview); cache.finish('first', written());
  cache.start('second', 'Write', preview); cache.finish('second', written());
  for (let i = 0; i < 20; i++) assert.deepEqual(cache.finish('first'), diff());
  cache.start('third', 'Write', preview); cache.finish('third', written());
  assert.equal(cache.finish('second'), undefined, 'the least recently completed call is evicted');
  assert.deepEqual(cache.finish('first'), diff());
  assert.deepEqual(cache.finish('third'), diff());
});

test('reusing an ID replaces its completed entry with a pending call and releases its old byte charge', () => {
  const cache = new ToolCallCache({ maxBytes: 1000 });
  cache.start('same', 'Write', preview); cache.finish('same', written('n'.repeat(150), 'o'.repeat(150)));
  cache.start('same', 'Write', preview);
  cache.start('other', 'Write', preview); cache.finish('other', written());
  assert.deepEqual(cache.finish('same', written()), diff());
  assert.deepEqual(cache.finish('other'), diff());
});
