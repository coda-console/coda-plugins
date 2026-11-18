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
  const next = (id, personal, platform = 'ios', inputs = { device: 'phone', select: '' }) => {
    const current = node(id);
    const flows = held.flowElements.filter(element => element.sourceRef === current);
    const flow = current.$type === 'bpmn:ExclusiveGateway'
      ? flows.find(flow => flow.conditionExpression && evaluate(flow.conditionExpression.body.trim().slice(1), { find: { personal, platform }, inputs }).value === true) ?? current.default
      : flows[0];
    return flow.targetRef.id;
  };
  return { process, held, node, next };
}

test('a personal device is lent by the user before anything is installed; a resident testbed goes straight on', async () => {
  const { held, node, next } = await heldScope();
  // Connect only after the group is held.
  assert.equal(next('hold'), 'connect');
  const lend = next('connect');
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
  const { node, next } = await heldScope();
  const find = node('find');
  assert.ok(find.extensionElements.values.some(value => value.name === 'personal'));
  for (const [source, end, black] of [
    ['task', 'done', 'black'],
    ['install-failed', 'stopped', 'black-stop'],
    ['install-cancelled', 'stopped', 'black-stop'],
    ['task-failed', 'stopped', 'black-stop'], // Rejected user tasks raise the same error boundary.
    ['task-cancelled', 'stopped', 'black-stop'],
    ['connect-failed', 'stopped', 'black-stop'],
    ['connect-cancelled', 'stopped', 'black-stop'],
  ]) {
    for (const personal of [true, false, undefined]) {
      const gateway = next(source, personal);
      assert.equal(node(gateway).$type, 'bpmn:ExclusiveGateway');
      assert.equal(next(gateway, personal), personal ? end : black);
    }
  }
});

test('Android returns through the custodian without iOS blackscreen or manual retry cards', async () => {
  const { next } = await heldScope();
  assert.equal(next('return-device', false, 'android'), 'done');
  assert.equal(next('return-stopped', false, 'android'), 'stopped');
});

test('device and select are exactly one: a named device is found, then held; a pool is held, then found; both or neither stop before any queue', async () => {
  const { node, next } = await heldScope();
  const choose = inputs => next('choose', false, 'ios', inputs);
  assert.equal(next('testbed-start'), 'choose');
  // As Coda hands them over: an optional text left out is an empty string.
  assert.equal(choose({ device: 'phone', select: '' }), 'find');
  assert.equal(choose({ device: '', select: 'platform=android' }), 'hold-select');
  for (const inputs of [{ device: '', select: '' }, { device: 'phone', select: 'platform=android' }]) assert.equal(node(choose(inputs)).$type, 'bpmn:EndEvent');
  assert.equal(node('not-chosen').eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  // Named: found, then held, then connected. Pooled: held, found by the group it got, then connected: it is held already.
  assert.equal(next('hold-select'), 'find');
  assert.equal(next('find'), 'found');
  assert.equal(next('found', false, 'ios', { device: 'phone', select: '' }), 'hold');
  assert.equal(next('found', false, 'android', { device: '', select: 'platform=android' }), 'connect');
  assert.equal(next('hold'), 'connect');
});

test('the group a pool held is what find resolves; a named device leaves it empty', async () => {
  const { node } = await heldScope();
  const env = name => node('find').extensionElements.values.find(value => value.name === name).value.slice(1);
  assert.equal(evaluate(env('HELD'), { inputs: { device: '', select: 'platform=android' }, 'hold-select': { group: 'device:xiaomi' } }).value, 'device:xiaomi');
  assert.equal(evaluate(env('HELD'), { inputs: { device: 'phone', select: '' } }).value, '');
  assert.equal(evaluate(env('DEVICE'), { inputs: { device: 'phone', select: '' } }).value, 'phone');
});

test('hold-group takes group or select, exactly one', async () => {
  const hold = params => readWorkflow(`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:coda="https://coda.pub/schema/bpmn/1.0" targetNamespace="x" id="d">
  <process id="p" name="p" isExecutable="true"><startEvent id="s" />
    <serviceTask id="hold" coda:action="hold-group"><extensionElements>${params}</extensionElements></serviceTask>
    <sequenceFlow id="f" sourceRef="s" targetRef="hold" />
  </process>
</definitions>`, 'p');
  const param = (name, value) => `<coda:param name="${name}" value="${value}" />`;
  assert.ok(!(await hold(param('select', 'platform=android'))).problem);
  assert.ok(!(await hold(param('group', 'device:phone'))).problem);
  for (const params of [param('group', 'device:phone') + param('select', 'platform=android'), '']) assert.match((await hold(params)).problem, /group、select 须恰写一个/);
  assert.match((await hold(param('select', 'platform'))).problem, /键=值/);
});

test('the capabilities hold the resolved group; resolution exposes group, platform and adb', async () => {
  for (const name of ['use-testbed', 'run-on-device', 'resolve-testbed']) {
    const { root, problem } = await readWorkflow(readFileSync(new URL(`../../../plugins/testbed/.coda/capabilities/${name}.bpmn`, import.meta.url), 'utf8'), name);
    assert.ok(!problem, problem);
    const process = root.rootElements.find(element => element.$type === 'bpmn:Process');
    if (name === 'resolve-testbed') {
      const end = process.flowElements.find(element => element.id === 'end');
      assert.deepEqual(end.extensionElements.values.map(v => v.name), ['group', 'platform', 'adb']);
    } else {
      const scope = name === 'use-testbed' ? process.flowElements.find(e => e.id === 'testbed') : process;
      const hold = scope.flowElements.find(e => e.id === 'hold' || e.id === 'borrow');
      assert.equal(hold.action, 'hold-group');
      assert.equal(hold.extensionElements.values.find(v => v.name === 'group').value, '=find.group');
    }
  }
});
