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

test('run-held keeps simulator and local builds on this Mac, and lets other builds go where a slot is free', async () => {
  const { inputs, element, held } = await runHeld();
  assert.equal(inputs.local, false);
  // 模拟器与要用产物的构建走 hold-group；其余由写着自己名额的一步去别台。
  const route = element('route');
  assert.equal(route.default.id, 'elsewhere');
  const here = element('here');
  assert.equal(here.targetRef, held);
  const expression = here.conditionExpression.body.trim().slice(1);
  const local = extra => evaluate(expression, { inputs: { ...inputs, ...extra } }).value;
  assert.equal(local({ what: '模拟器' }), true);
  assert.equal(local({ local: true }), true);
  assert.equal(local({ what: '构建', local: true }), true);
  assert.equal(local({}), false);
  assert.equal(local({ what: '其他命令' }), false);
  const command = held.flowElements.find(element => element.id === 'command');
  const elsewhere = element('elsewhere-run');
  assert.equal(element('elsewhere').targetRef, elsewhere);
  // 两条路都就地跑 coda:source：本机是调用方的 cwd，别台是快照检出后对应的子目录。
  for (const step of [command, elsewhere]) {
    assert.equal(step.source, '=inputs.cwd');
    assert.equal(step.checkout, 'false');
    assert.equal(step.timeout, 1440);
    assert.equal(step.cancelTimeout, 5);
    assert.equal(step.extensionElements.values.find(value => value.name === 'HELD_COMMAND').value, '=inputs.command');
    assert.equal(step.extensionElements.values.some(value => value.name === 'HELD_CWD'), false);
    assert.deepEqual(step.extensionElements.values.filter(value => value.$type === 'coda:Output').map(value => value.name), ['exit_code', 'failure_reason']);
    assert.equal(step.script, 'exec node "$CODA_PLUGIN_PATH/scripts/run-held.mjs"');
  }
  // 只有别台那条自己占名额、写推送条件；本机那条在 hold-group 段里。
  assert.equal(elsewhere.group, 'host');
  assert.equal(elsewhere.runsOn, 'darwin');
  assert.ok(!command.group && !command.runsOn);
  assert.ok(held.flowElements.some(element => element.id === 'hold' && element.action === 'hold-group'));
  assert.equal(element('held-done').targetRef, element('end'));
  assert.equal(element('elsewhere-ran').targetRef, element('end'));
});

test('both run-held paths hand the total limit to run-held, counted from the command', async () => {
  const { process, inputs, element, held } = await runHeld();
  const command = held.flowElements.find(element => element.id === 'command');
  const elsewhere = element('elsewhere-run');
  for (const step of [command, elsewhere]) {
    const value = step.extensionElements.values.find(value => value.name === 'HELD_TIMEOUT_MINUTES').value;
    const minutes = extra => evaluate(value.trim().slice(1), { inputs: { ...inputs, ...extra } }).value;
    assert.equal(minutes({}), 30);
    assert.equal(minutes({ what: '模拟器' }), 60);
    assert.equal(minutes({ what: '其他命令' }), 30);
    assert.equal(minutes({ timeoutMinutes: 120 }), 120);
    assert.equal(minutes({ timeoutMinutes: 1440 }), 1440);
    assert.equal(minutes({ timeoutMinutes: -1 }), -1);
    assert.equal(minutes({ timeoutMinutes: 1441 }), 1441);
    assert.equal(step.timeout, 1440);
    assert.equal(step.extensionElements.values.find(value => value.name === 'HELD_IDLE_MINUTES').value, '=inputs.idleMinutes');
  }
  // 没有挂在步骤上的计时边界事件：排队也算进入这一步，会把排队时间算进总时限。
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:BoundaryEvent').length, 0);
  assert.equal(held.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
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
