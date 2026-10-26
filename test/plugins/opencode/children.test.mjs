import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeChildren, CHILD_CAPABILITY, CHILD_UPDATE } from '../../../plugins/opencode/agent/children.mjs';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const event = (fields, childSessionId = 'child', parentSessionId = 'root') => ({ jsonrpc: '2.0', method: CHILD_UPDATE,
  params: { rootSessionId: 'root', childSessionId, parentSessionId, depth: 1, title: 'Probe', ...fields } });
const status = (state, child, parent) => event({ type: 'status', status: state }, child, parent);
function connected() {
  const bridge = new OpenCodeChildren();
  bridge.fromCoda(request(1, 'initialize'));
  bridge.fromAgent(reply(1, { agentCapabilities: { _meta: { [CHILD_CAPABILITY]: true }, sessionCapabilities: { close: {} } } }));
  bridge.fromCoda(request(2, 'session/new'));
  bridge.fromAgent(reply(2, { sessionId: 'root' }));
  return bridge;
}

test('negotiates native child updates, preserves capabilities and only declares waits when supported', () => {
  const b = new OpenCodeChildren();
  const init = b.fromCoda(request(1, 'initialize', { clientCapabilities: { fs: {}, _meta: { other: true } } })).agent;
  assert.deepEqual(init.params.clientCapabilities, { fs: {}, _meta: { other: true, [CHILD_CAPABILITY]: true } });
  const result = { agentCapabilities: { loadSession: true, _meta: { [CHILD_CAPABILITY]: true, coda: { other: {} } } } };
  assert.deepEqual(b.fromAgent(reply(1, result))[0].result.agentCapabilities._meta.coda, { other: {}, waits: {} });
  b.fromCoda(request(2, 'initialize'));
  const unsupported = reply(2, { agentCapabilities: {} });
  assert.deepEqual(b.fromAgent(unsupported), [unsupported]);
  assert.deepEqual(b.fromAgent(status('created')), []);
});

test('registers before output; nested children belong to their parent and keep namespaced tool IDs', () => {
  const b = connected(), first = b.fromAgent(status('created'));
  assert.deepEqual(first[0].params, { sessionId: 'root', waitId: 'child', state: 'waiting', kind: 'subagent',
    title: 'Probe', childSessionId: 'child', stoppable: true });
  assert.deepEqual(b.fromAgent(status('running')), []);
  assert.equal(b.fromAgent(status('created', 'grandchild', 'child'))[0].params.sessionId, 'child');
  const update = { sessionUpdate: 'tool_call', toolCallId: 'grandchild:call', title: 'Read', status: 'pending' };
  assert.deepEqual(b.fromAgent(event({ type: 'update', update }, 'grandchild', 'child')),
    [{ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grandchild', update } }]);
  const unknown = b.fromAgent(event({ type: 'update', update }, 'other'));
  assert.deepEqual(unknown.map(m => m.method), ['_coda/wait', 'session/update']);
});

test('a parent prompt ending does not end its children; native ends are final and a fresh run has a new wait ID', () => {
  const b = connected();
  b.fromAgent(status('created'));
  b.fromCoda(request(3, 'session/prompt', { sessionId: 'root' }));
  assert.deepEqual(b.fromAgent(reply(3, { stopReason: 'end_turn' })), [reply(3, { stopReason: 'end_turn' })]);
  assert.equal(b.fromAgent(status('completed'))[0].params.state, 'done');
  assert.deepEqual(b.fromAgent(status('completed')), []);
  assert.deepEqual(b.fromAgent(status('created')), []);
  const continued = b.fromAgent(status('running'))[0].params;
  assert.equal(continued.waitId, 'child#2');
  assert.equal(continued.childSessionId, 'child');
  assert.equal(b.fromAgent(status('interrupted'))[0].params.state, 'cancelled');
  b.fromAgent(status('running'));
  assert.deepEqual(b.fromAgent(event({ type: 'status', status: 'failed', error: { message: 'Service failed' } }))[0].params,
    { sessionId: 'root', waitId: 'child#3', state: 'failed', detail: 'Service failed' });
});

test('routes a child permission to its transcript and leaves the reply and root permission intact', () => {
  const b = connected();
  const permission = request('permission', 'session/request_permission', { sessionId: 'root', options: [{ optionId: 'once' }],
    toolCall: { toolCallId: 'child:call', _meta: { 'opencode/child-session': { id: 'child', parentID: 'root' } } } });
  const messages = b.fromAgent(permission);
  assert.equal(messages[0].method, '_coda/wait');
  assert.deepEqual(messages[1], { ...permission, params: { ...permission.params, sessionId: 'child' } });
  const response = reply('permission', { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal(b.fromCoda(response).agent, response);
  const own = request('root-permission', 'session/request_permission', { sessionId: 'root', toolCall: {} });
  assert.deepEqual(b.fromAgent(own), [own]);
});

test('stops only the owned active child through session/close, keeping errors and waiting for its terminal event', () => {
  const b = connected();
  b.fromAgent(status('created'));
  const stop = request(3, '_coda/wait/stop', { sessionId: 'root', waitId: 'child' });
  assert.deepEqual(b.fromCoda(stop).agent, request(3, 'session/close', { sessionId: 'child' }));
  assert.deepEqual(b.fromAgent(reply(3, {})), [reply(3, {})]);
  assert.equal(b.children.get('child').ended, false);
  assert.ok(b.fromCoda({ ...stop, params: { ...stop.params, sessionId: 'unrelated' } }).coda.error);
  b.fromCoda(stop);
  const error = { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Server unavailable' } };
  assert.deepEqual(b.fromAgent(error), [error]);
  b.fromAgent(status('interrupted'));
  assert.ok(b.fromCoda(stop).coda.error);
});

test('rejects unrelated/malformed events, terminal-only history and ancestry changes', () => {
  const b = connected();
  for (const message of [status('completed'), status('created', 'child', 'unknown'), status('created', 'root'),
    event({ rootSessionId: 'unrelated', type: 'status', status: 'created' }), event({ type: 'status', status: 'bad' }),
    event({ type: 'update', update: null }), event({ type: 'status', status: 'created', childSessionId: 'x'.repeat(201) })])
    assert.deepEqual(b.fromAgent(message), []);
  b.fromAgent(status('created'));
  assert.deepEqual(b.fromAgent(status('running', 'child', 'child')), []);
  b.fromCoda(request(4, 'session/load', { sessionId: 'loaded' }));
  b.fromAgent(reply(4, {}));
  assert.equal(b.fromAgent(event({ rootSessionId: 'loaded', parentSessionId: 'loaded', type: 'status', status: 'created' }, 'new-child'))[0].params.sessionId, 'loaded');
});
