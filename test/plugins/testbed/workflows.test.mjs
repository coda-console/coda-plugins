import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

test('personal devices leave the held scope without blackscreen on reply, failure, rejection or cancellation', async () => {
  const { root, problem } = await readWorkflow(readFileSync(new URL('../../../plugins/testbed/.coda/capabilities/use-testbed.bpmn', import.meta.url), 'utf8'), 'use-testbed');
  assert.ok(!problem, problem);
  const process = root.rootElements.find(element => element.$type === 'bpmn:Process');
  const find = process.flowElements.find(element => element.id === 'find');
  assert.ok(find.extensionElements.values.some(value => value.name === 'personal'));
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
  for (const [source, end, black] of [
    ['task', 'done', 'black'],
    ['install-failed', 'stopped', 'black-stop'],
    ['install-cancelled', 'stopped', 'black-stop'],
    ['task-failed', 'stopped', 'black-stop'], // Rejected user tasks raise the same error boundary.
    ['task-cancelled', 'stopped', 'black-stop'],
  ]) {
    for (const personal of [true, false, undefined]) {
      const gateway = next(source, personal);
      assert.equal(node(gateway).$type, 'bpmn:ExclusiveGateway');
      assert.equal(next(gateway, personal), personal ? end : black);
    }
  }
});
