import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

for (const name of ['develop', 'deliver']) {
  test(`${name}：设备占用限定在安装与验收段，退出后再分流`, async () => {
    const xml = readFileSync(new URL(`../../../plugins/composer/.coda/workflows/${name}.bpmn`, import.meta.url), 'utf8');
    const { root, problem } = await readWorkflow(xml, name);
    assert.ok(!problem, problem);
    const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
    const segment = process.flowElements.find(e => e.id === 'acceptance');
    const elements = [...process.flowElements, ...segment.flowElements];
    const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
    const values = node => node.extensionElements?.values ?? [];
    const route = (id, context = {}) => {
      const node = nodes[id];
      const flows = elements.filter(e => e.sourceRef === node);
      return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.slice(1), context).value)
        ?? node.default ?? flows[0]).targetRef.id;
    };
    const device = values(process).find(v => v.name === 'device');
    assert.equal(device.type, 'string');
    assert.equal(device.default, '');
    assert.ok(!device.required);
    const params = Object.fromEntries(values(nodes['device-lock']).map(v => [v.name, v.value]));
    assert.deepEqual(params, name === 'develop' ? { group: '=device-resolve.group', capacity: '1', borrow: 'no' } : { group: '=device-resolve.group', capacity: '1' });
    assert.equal(nodes['device-lock'].action, 'hold-group');
    assert.equal(nodes['device-lock'].status, '等验收设备 {{inputs.device}}');
    assert.equal(process.concurrency, undefined);
    // 只有监督开发能另占一个组（hold）：先占它再占设备（先组后设备），没有就直接去安装；需求交付直接占设备。
    assert.equal(route('acceptance-start'), name === 'develop' ? 'hold-choice' : 'device-lock-choice');
    for (const devices of [false, true]) for (const device of ['', 'duo-testbed']) {
      assert.equal(route('device-lock-choice', { inputs: { devices, device } }),
        devices && device ? 'device-resolve' : 'preview');
    }
    assert.equal(nodes['device-resolve'].calledElement, 'resolve-testbed');
    assert.equal(route('device-resolve'), 'device-lock');
    assert.equal(route('device-lock'), 'preview');
    for (const id of ['preview', 'preview-result', 'device', 'device-result', 'device-lock']) {
      assert.ok(segment.flowElements.includes(nodes[id]));
      assert.equal(elements.filter(e => e.id === id).length, 1);
    }
    // 所有跨段出口均先到段内结束事件；由引擎在段结束、取消收尾后释放 hold-group。
    for (const flow of segment.flowElements.filter(e => e.$type === 'bpmn:SequenceFlow')) {
      assert.ok(segment.flowElements.includes(flow.sourceRef));
      assert.ok(segment.flowElements.includes(flow.targetRef));
    }
    assert.ok(!elements.some(e => e.attachedToRef === segment), '取消没有被边界事件改道留在段内');
    assert.equal(route('preview'), 'preview-result');
    assert.equal(route('preview-result'), 'after-preview');
    assert.equal(route('device'), 'device-result');
    assert.equal(route('device-result'), 'after-device');
    const back = name === 'develop' ? 'progress' : 'confirm';
    for (const [gateway, result, outcomes] of [
      ['after-preview', 'preview-result', { preview: 'preview', [back]: 'acceptance-return', device: 'device' }],
      ['after-device', 'device-result', { device: 'device', [back]: 'acceptance-return', [name === 'develop' ? 'passed' : 'report']: 'acceptance-passed' }],
    ]) for (const [value, expected] of Object.entries(outcomes)) {
      assert.equal(route(gateway, { [result]: { route: value } }), expected);
    }
    for (const outcome of ['return', 'passed']) {
      const end = nodes[`acceptance-${outcome}`];
      assert.equal(end.$type, 'bpmn:EndEvent');
      assert.deepEqual(values(end).map(v => [v.name, v.value]), [['route', outcome]]);
      assert.equal(route('acceptance-route', { acceptance: { route: outcome } }),
        outcome === 'return' ? (name === 'develop' ? 'resume' : 'context') : (name === 'develop' ? 'tell-device' : 'report'));
    }
    assert.equal(route('acceptance'), 'acceptance-route');
    const entry = name === 'develop' ? 'acceptance-needed' : 'integrate-preview';
    assert.equal(nodes[entry].targetRef, segment, '每轮重新进入段并走占用网关');
    for (const device of ['', 'duo-testbed']) {
      const context = { inputs: { device } };
      const instructions = nodes.preview.documentation[0].text;
      const expression = [...instructions.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('ios-preview-install'))[1];
      const rendered = evaluate(expression, context).value;
      // 填了设备时才出现的提醒：用填了设备时的渲染结果认出它（提到「验收时占用」的模板），分别核对「填进验收时占用」和「host 这类构建名额组不要填」；未填设备时它渲染为空串。
      const templates = [...instructions.matchAll(/{{(.*?)}}/g)].map(m => m[1]);
      const reminders = templates.filter(t => String(evaluate(t, { inputs: { device: 'duo-testbed' } }).value).includes('验收时占用'));
      assert.equal(reminders.length, name === 'develop' ? 1 : 0);
      if (name === 'develop') {
        const queuedText = evaluate(reminders[0], context).value;
        if (device) {
          const sentences = queuedText.split(/[；。]/);
          assert.ok(sentences.some(t => t.includes('验收时占用')), '提醒要说明共享环境组填进「验收时占用」');
          assert.ok(sentences.some(t => t.includes('host') && t.includes('不要填')), '提醒要说明 host 这类构建名额组不要填');
        } else assert.equal(queuedText, '');
      }
      assert.equal(rendered, device ? '发起 ios-preview-install 时还要传 device="duo-testbed"。安装运行会借本段占着的设备，不另排队。' : '');
      const acceptance = nodes.device.documentation[0].text;
      const note = [...acceptance.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('inputs.device'))[1];
      assert.equal(evaluate(note, context).value, device ? '验收期间设备 duo-testbed 一直被本段占着。' : '');
    }
  });
}

test('develop：填了「验收时占用」时，安装与验收段先占这个组再占设备，不填不占', async () => {
  const xml = readFileSync(new URL('../../../plugins/composer/.coda/workflows/develop.bpmn', import.meta.url), 'utf8');
  const { root, problem } = await readWorkflow(xml, 'develop');
  assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const segment = process.flowElements.find(e => e.id === 'acceptance');
  const elements = [...process.flowElements, ...segment.flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const route = (id, context = {}) => {
    const flows = elements.filter(e => e.sourceRef === nodes[id]);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.slice(1), context).value)
      ?? nodes[id].default ?? flows[0]).targetRef.id;
  };
  const hold = values(process).find(v => v.name === 'hold');
  assert.deepEqual([hold.type, hold.label, hold.default, hold.required], ['string', '验收时占用', '', undefined]);
  for (const id of ['hold-choice', 'hold-lock']) assert.ok(segment.flowElements.includes(nodes[id]), `${id} 在段内，离开段就放开`);
  assert.equal(route('acceptance-start'), 'hold-choice');
  assert.equal(route('hold-choice', { inputs: { hold: '' } }), 'device-lock-choice');
  assert.equal(route('hold-choice', { inputs: { hold: 'preview-backend' } }), 'hold-lock');
  assert.equal(nodes['hold-lock'].action, 'hold-group');
  assert.deepEqual(Object.fromEntries(values(nodes['hold-lock']).map(v => [v.name, v.value])), { group: '=inputs.hold', capacity: '1', borrow: 'no' });
  assert.equal(nodes['hold-lock'].status, '等 {{inputs.hold}}');
  assert.equal(route('hold-lock'), 'device-lock-choice');
  // 四种组合各自经过的占用步骤：只填组、只填设备、两者都填、都不填；有组时组一定在设备之前。
  const walk = inputs => {
    const visited = [];
    const context = { inputs };
    for (let id = 'acceptance-start'; id !== 'preview'; id = route(id, context)) {
      assert.ok(!visited.includes(id), `验收段路径成环：${[...visited, id].join(' → ')}`);
      visited.push(id);
    }
    return visited;
  };
  const path = inputs => walk(inputs).filter(id => ['hold-lock', 'device-lock'].includes(id));
  assert.deepEqual(path({ devices: true, hold: 'preview-backend', device: '' }), ['hold-lock']);
  assert.deepEqual(path({ devices: true, hold: '', device: 'duo-testbed' }), ['device-lock']);
  assert.deepEqual(path({ devices: true, hold: 'preview-backend', device: 'duo-testbed' }), ['hold-lock', 'device-lock']);
  assert.deepEqual(path({ devices: true, hold: '', device: '' }), []);
  for (const [id, text] of [['preview', '本段还占着组 preview-backend：你在这张任务里发起、要用这个组的运行借用它，不另排队；别的要用这个组的运行，按这个组的名额排队。'],
    ['device', '验收期间组 preview-backend 也一直被本段占着。']]) {
    const doc = nodes[id].documentation[0].text;
    const expression = [...doc.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('inputs.hold'))[1];
    assert.equal(evaluate(expression, { inputs: { hold: 'preview-backend' } }).value, text, id);
    assert.equal(evaluate(expression, { inputs: { hold: '' } }).value, '', id);
  }
  // composer 不知道项目的组名和流程名。
  assert.doesNotMatch(xml, /preview-backend|backend-preview-deploy/);
});
