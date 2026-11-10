import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

async function heldScope() {
  const { root, problem } = await readWorkflow(readFileSync(new URL('../../../plugins/testbed/.coda/capabilities/use-testbed.bpmn', import.meta.url), 'utf8'), 'use-testbed');
  assert.ok(!problem, problem);
  const process = root.rootElements.find(element => element.$type === 'bpmn:Process');
  const held = process.flowElements.find(element => element.id === 'testbed');
  const node = id => held.flowElements.find(element => element.id === id);
  const next = (id, personal) => {
    const current = node(id);
    const flows = held.flowElements.filter(element => element.sourceRef === current);
    const flow = current.$type === 'bpmn:ExclusiveGateway'
      ? flows.find(flow => flow.conditionExpression && evaluate(flow.conditionExpression.body.trim().slice(1), { find: { personal } }).value === true) ?? current.default
      : flows[0];
    return flow.targetRef.id;
  };
  return { process, held, node, next };
}

test('a personal device is lent by the user before anything is installed; a resident testbed goes straight on', async () => {
  const { held, node, next } = await heldScope();
  // What an Android device is like is noted once it is held, before anything else is done with it.
  assert.equal(next('hold'), 'note');
  const lend = next('note');
  assert.equal(node(lend).$type, 'bpmn:ExclusiveGateway');
  for (const personal of [false, undefined]) assert.equal(next(lend, personal), 'has-app');
  const borrow = node(next(lend, true));
  assert.equal(borrow.$type, 'bpmn:UserTask');
  assert.equal(borrow.assignee, 'user');
  assert.equal(next(borrow.id), 'has-app');
  // Declining rejects the card, which raises its error boundary; the device is released without blackscreen.
  const boundaries = held.flowElements.filter(element => element.$type === 'bpmn:BoundaryEvent' && element.attachedToRef === borrow);
  assert.deepEqual(boundaries.map(boundary => boundary.eventDefinitions[0].$type).sort(), ['bpmn:ErrorEventDefinition', 'bpmn:MessageEventDefinition']);
  for (const boundary of boundaries) {
    const gateway = next(boundary.id);
    assert.equal(next(gateway, true), 'stopped');
  }
});

test('personal devices leave the held scope without blackscreen on reply, failure, rejection or cancellation', async () => {
  const { process, node, next } = await heldScope();
  const find = process.flowElements.find(element => element.id === 'find');
  assert.ok(find.extensionElements.values.some(value => value.name === 'personal'));
  for (const [source, end, black] of [
    ['task', 'done', 'black'],
    ['install-failed', 'stopped', 'black-stop'],
    ['install-cancelled', 'stopped', 'black-stop'],
    ['task-failed', 'stopped', 'black-stop'], // Rejected user tasks raise the same error boundary.
    ['task-cancelled', 'stopped', 'black-stop'],
    ['note-failed', 'stopped', 'black-stop'],
    ['note-cancelled', 'stopped', 'black-stop'],
  ]) {
    for (const personal of [true, false, undefined]) {
      const gateway = next(source, personal);
      assert.equal(node(gateway).$type, 'bpmn:ExclusiveGateway');
      assert.equal(next(gateway, personal), personal ? end : black);
    }
  }
});
