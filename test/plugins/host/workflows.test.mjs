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

test('both run-held paths keep the same total timeout', async () => {
  const { inputs, element, held } = await runHeld();
  assert.equal(inputs.idleMinutes, 10);
  const paths = [
    [held.flowElements.find(element => element.id === 'command'), held.flowElements.find(element => element.id === 'timed-out'),
      held.flowElements.find(element => element.id === 'timeout-failed'), held.flowElements.find(element => element.id === 'report-timeout')],
    [element('elsewhere-run'), element('elsewhere-timed-out'), element('elsewhere-timeout-failed'), element('elsewhere-report-timeout')],
  ];
  for (const [command, timer, flow, report] of paths) {
    assert.equal(timer.attachedToRef, command);
    assert.equal(timer.cancelActivity, true);
    assert.equal(flow.targetRef, report);
    assert.equal(report.script, 'exec node "$CODA_PLUGIN_PATH/scripts/report-timeout.mjs"');
    const expression = timer.eventDefinitions[0].timeDuration.body.trim().slice(1);
    const limit = extra => evaluate(expression, { inputs: { ...inputs, ...extra } }).value;
    assert.equal(limit({ what: '模拟器' }), 'PT60M');
    assert.equal(limit({}), 'PT30M');
    assert.equal(limit({ what: '其他命令' }), 'PT30M');
    assert.equal(limit({ what: '模拟器', timeoutMinutes: 120 }), 'PT120M');
    assert.equal(limit({ timeoutMinutes: 900 }), 'PT900M');
    assert.equal(limit({ timeoutMinutes: -1 }), null);
    assert.equal(limit({ timeoutMinutes: 1441 }), null);
  }
  assert.equal(held.flowElements.find(element => element.id === 'command').extensionElements.values.find(value => value.name === 'HELD_IDLE_MINUTES').value, '=inputs.idleMinutes');
  assert.equal(element('elsewhere-run').extensionElements.values.find(value => value.name === 'HELD_IDLE_MINUTES').value, '=inputs.idleMinutes');
  assert.equal(element('elsewhere-timed-out-end').targetRef, element('end'));
  const report = held.flowElements.find(element => element.id === 'report-timeout');
  assert.ok(!held.flowElements.some(element => element.sourceRef === report || element.id === 'timed-out-end'));
});

test('periodic simulator cleanup never enters the host queue', async () => {
  const process = await processOf('workflows', 'clean-simulators');
  assert.equal(process.flowElements.filter(element => element.$type === 'bpmn:ScriptTask').length, 1);
  assert.ok(process.flowElements.every(element => !element.group && !element.action && element.$type !== 'bpmn:SubProcess'));
});
