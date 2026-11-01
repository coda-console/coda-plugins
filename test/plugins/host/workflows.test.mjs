import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

async function processOf(path, name) {
  const { root, problem } = await readWorkflow(readFileSync(new URL(`../../../plugins/host/.coda/${path}/${name}.bpmn`, import.meta.url), 'utf8'), name);
  assert.ok(!problem, problem);
  return root.rootElements.find(element => element.$type === 'bpmn:Process');
}

test('run-held limits simulator execution to 60 minutes, other commands to 600, with an explicit override', async () => {
  const process = await processOf('capabilities', 'run-held');
  const inputs = Object.fromEntries(process.extensionElements.values.map(input => [input.name, input.type === 'number' ? Number(input.default) : input.default]));
  const held = process.flowElements.find(element => element.id === 'held');
  const command = held.flowElements.find(element => element.id === 'command');
  const timer = held.flowElements.find(element => element.id === 'timed-out');
  assert.equal(timer.attachedToRef, command);
  assert.equal(timer.cancelActivity, true);
  assert.equal(command.cancelTimeout, 5);
  assert.equal(command.timeout, 1440);
  assert.ok(held.flowElements.some(element => element.sourceRef?.id === 'hold' && element.targetRef === command));
  const expression = timer.eventDefinitions[0].timeDuration.body.trim().slice(1);
  const limit = extra => evaluate(expression, { inputs: { ...inputs, ...extra } }).value;
  assert.equal(limit({ what: '模拟器' }), 'PT60M');
  assert.equal(limit({}), 'PT600M');
  assert.equal(limit({ what: '其他命令' }), 'PT600M');
  assert.equal(limit({ what: '模拟器', timeoutMinutes: 120 }), 'PT120M');
  assert.equal(limit({ timeoutMinutes: 900 }), 'PT900M');
  assert.equal(limit({ timeoutMinutes: -1 }), null);
  assert.equal(limit({ timeoutMinutes: 1441 }), null);
  assert.ok(held.flowElements.find(element => element.id === 'timed-out-end').eventDefinitions.some(event => event.$type === 'bpmn:ErrorEventDefinition'));
});

test('periodic simulator cleanup never enters the host queue', async () => {
  const process = await processOf('workflows', 'clean-simulators');
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
  assert.ok(process.flowElements.every(element => !element.group && !element.action && element.$type !== 'bpmn:SubProcess'));
});
