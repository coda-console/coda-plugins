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

async function runHeld() {
  const process = await processOf('capabilities', 'run-held');
  const inputs = Object.fromEntries(process.extensionElements.values.map(input => [input.name,
    input.type === 'number' ? Number(input.default) : input.type === 'boolean' ? input.default === 'true' : input.default]));
  const element = id => process.flowElements.find(element => element.id === id);
  const held = element('held');
  return { process, inputs, element, held };
}

test('run-held always queues on this Mac: a single hold-group, no local input and no step that may go elsewhere', async () => {
  const { process, inputs, element, held } = await runHeld();
  assert.deepEqual(Object.keys(inputs), ['command', 'cwd', 'what', 'timeoutMinutes', 'idleMinutes']);
  assert.equal(process.flowElements.some(element => element.$type === 'bpmn:ExclusiveGateway'), false);
  assert.equal(element('to-held').targetRef, held);
  assert.ok(held.flowElements.some(element => element.id === 'hold' && element.action === 'hold-group'));
  const command = held.flowElements.find(element => element.id === 'command');
  // The command runs where the caller's work copy is, inside the held slot, with nothing that asks Coda to push it elsewhere.
  assert.equal(command.source, '=inputs.cwd');
  assert.equal(command.checkout, 'false');
  assert.equal(command.timeout, 1440);
  assert.equal(command.cancelTimeout, 5);
  assert.equal(command.extensionElements.values.find(value => value.name === 'HELD_COMMAND').value, '=inputs.command');
  assert.deepEqual(command.extensionElements.values.filter(value => value.$type === 'coda:Output').map(value => value.name), ['exit_code', 'failure_reason']);
  assert.equal(command.script, 'exec node "$CODA_PLUGIN_PATH/scripts/run-held.mjs"');
  assert.ok(!command.group && !command.runsOn);
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 0);
  assert.equal(element('held-done').targetRef, element('end'));
});

test('run-held hands the total limit to run-held, counted from the command', async () => {
  const { process, inputs, held } = await runHeld();
  const command = held.flowElements.find(element => element.id === 'command');
  const value = command.extensionElements.values.find(value => value.name === 'HELD_TIMEOUT_MINUTES').value;
  const minutes = extra => evaluate(value.trim().slice(1), { inputs: { ...inputs, ...extra } }).value;
  assert.equal(minutes({}), 30);
  assert.equal(minutes({ what: '模拟器' }), 60);
  assert.equal(minutes({ what: '其他命令' }), 30);
  assert.equal(minutes({ timeoutMinutes: 120 }), 120);
  assert.equal(minutes({ timeoutMinutes: 1440 }), 1440);
  assert.equal(minutes({ timeoutMinutes: -1 }), -1);
  assert.equal(minutes({ timeoutMinutes: 1441 }), 1441);
  assert.equal(command.timeout, 1440);
  assert.equal(command.extensionElements.values.find(value => value.name === 'HELD_IDLE_MINUTES').value, '=inputs.idleMinutes');
  // No timer boundary event on the step: queueing would count into the limit.
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:BoundaryEvent').length, 0);
  assert.equal(held.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
});

test('periodic simulator cleanup never enters the host queue', async () => {
  const process = await processOf('workflows', 'clean-simulators');
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
  assert.ok(process.flowElements.every(element => !element.group && !element.action && element.$type !== 'bpmn:SubProcess'));
});

test('fseventsd guard runs once per machine, only while its setting is on, and never enters the host queue', async () => {
  const process = await processOf('workflows', 'fseventsd-guard');
  assert.equal(process.autoRun, '=vars.host.fseventsdGuard');
  const start = process.flowElements.find(element => element.$type === 'bpmn:StartEvent');
  assert.equal(start.scope, 'machine');
  assert.equal(start.eventDefinitions[0].timeCycle.body, '=vars.host.fseventsdSchedule');
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
  assert.ok(process.flowElements.every(element => !element.group && !element.action && element.$type !== 'bpmn:SubProcess'));
});
