import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeCompactions } from '../../../plugins/opencode/agent/compaction.mjs';

const info = (sessionId, status, messageId = 'msg_1', extra = {}) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status, messageId, reason: 'auto', ...extra } } } } });
const update = (sessionId, compactionId, status, error = null) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'compaction_update', compactionId, status, error } } });
const roots = () => new OpenCodeCompactions({ owns: id => id === 'root' });

test('a root session\'s compaction is told in_progress then completed, under one id, the completion once', () => {
  const c = roots();
  assert.deepEqual(c.fromAgent(info('root', 'started')), update('root', 'msg_1', 'in_progress'));
  assert.deepEqual(c.fromAgent(info('root', 'completed')), update('root', 'msg_1', 'completed'));
  assert.equal(c.fromAgent(info('root', 'completed')), null);
  assert.deepEqual(c.fromAgent(info('root', 'completed', 'msg_2')), update('root', 'msg_2', 'completed'));
});

test('a compaction whose start was not seen still completes, and a failure carries its message', () => {
  const c = roots();
  assert.deepEqual(c.fromAgent(info('root', 'completed')), update('root', 'msg_1', 'completed'));
  assert.deepEqual(c.fromAgent(info('root', 'failed', 'msg_2', { error: { type: 'compaction.failed', message: 'no summary' } })),
    update('root', 'msg_2', 'failed', 'no summary'));
  assert.deepEqual(c.fromAgent(info('root', 'failed', 'msg_3')), update('root', 'msg_3', 'failed'));
});

test('a native child\'s compaction, other updates and unreadable reports are not compaction updates', () => {
  const c = roots();
  assert.equal(c.fromAgent(info('child', 'completed')), null);
  assert.equal(c.fromAgent(info('root', 'completed', '')), null);
  assert.equal(c.fromAgent(info('root', 'paused')), null);
  assert.equal(c.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'root',
    update: { sessionUpdate: 'session_info_update', title: 'x' } } }), null);
  assert.equal(c.fromAgent({ jsonrpc: '2.0', id: 1, result: {} }), null);
});
