// The kickoff entry flow (plugins/composer/.coda/workflows/kickoff.bpmn): the card's three answers,
// what it passes to simple and develop, and that the two development flows declare the same kind.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/kickoff.bpmn', import.meta.url), 'utf8');
const simple = readFileSync(new URL('../../../plugins/review/.coda/workflows/simple.bpmn', import.meta.url), 'utf8');
const develop = readFileSync(new URL('../../../plugins/composer/.coda/workflows/develop.bpmn', import.meta.url), 'utf8');

async function definition(xml, id) {
  const { root, problem } = await readWorkflow(xml, id);
  assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const elements = process.flowElements;
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  const outputs = id => Object.fromEntries(values(nodes[id]).filter(v => v.name).map(v => [v.name, v.value]));
  return { process, elements, nodes, values, params, route, outputs };
}

test('开工卡的三条答复：调用简易开发、调用监督开发、先别', async () => {
  const { process, nodes, values, params, route } = await definition(workflow, 'kickoff');
  assert.equal(process.name, '开工');
  assert.equal(process.kind, undefined, '入口不是一种开发实现');
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['title', 'goal', 'way', 'devices', 'device', 'executor', 'executor2', 'reviewer', 'reviewer2', 'reviewerOnce', 'branch', 'base']);
  for (const name of ['title', 'goal']) assert.equal(inputs[name].required, true);
  assert.equal(inputs.way.default, 'develop');
  assert.deepEqual([inputs.devices.type, inputs.devices.default], ['boolean', 'false']);
  assert.deepEqual([inputs.executor.type, inputs.executor.defaultFrom], ['agent', 'session.agent']);
  assert.deepEqual([inputs.branch.type, inputs.branch.defaultFrom], ['branch', 'session.branch']);

  assert.equal(nodes.card.name, '开工');
  assert.equal(nodes.card.assignee, 'user');
  const choices = values(nodes.card);
  assert.deepEqual(choices.map(v => [v.id, v.name]), [['simple', '开工：简易开发'], ['develop', '开工：监督开发'], ['later', '先别']]);
  for (const choice of choices.slice(0, 2)) {
    assert.deepEqual(choice.options.map(option => [option.id, option.name, option.default]), [['devices', '设备验收', '=inputs.devices']]);
  }

  assert.equal(route('way-choice', { card: { chose: { simple: true } } }), 'simple-call');
  assert.equal(route('way-choice', { card: { chose: { develop: true } } }), 'develop-call');
  assert.equal(route('way-choice', { card: { chose: { later: true } } }), 'stopped');
  assert.equal(route('way-choice', { card: { chose: {} } }), 'stopped', '没选时走默认的「先别」');

  assert.equal(nodes['simple-call'].calledElement, 'simple');
  assert.deepEqual(params('simple-call'), {
    branch: '=inputs.branch', devices: '=card.options.devices', device: '=inputs.device', base: '=inputs.base',
  });
  assert.equal(nodes['develop-call'].calledElement, 'develop');
  assert.deepEqual(params('develop-call'), {
    title: '=inputs.title',
    task: '=if card.note = null or card.note = "" then inputs.goal else inputs.goal + "\\n\\n用户开工时补充：\\n" + card.note',
    devices: '=card.options.devices',
    device: '=inputs.device',
    executor: '=inputs.executor',
    executor2: '=inputs.executor2',
    reviewer: '=inputs.reviewer',
    reviewer2: '=inputs.reviewer2',
    reviewerOnce: '=inputs.reviewerOnce',
    base: '=inputs.base',
  });
  // 「先别」只结束，不调用任何流程。
  assert.equal(nodes.stopped.$type, 'bpmn:EndEvent');
  assert.deepEqual(process.flowElements.filter(e => e.$type === 'bpmn:CallActivity').map(e => e.id), ['simple-call', 'develop-call']);
  assert.equal(process.flowElements.filter(e => e.sourceRef?.id === 'stopped').length, 0);
});

test('开工卡上的附言接在监督开发的任务后，设备验收勾选传给两个流程', async () => {
  const { params, outputs, nodes } = await definition(workflow, 'kickoff');
  const task = note => evaluate(params('develop-call').task.slice(1), { inputs: { goal: '目标与范围' }, card: { note } }).value;
  for (const note of [null, '']) assert.equal(task(note), '目标与范围', note);
  assert.equal(task('顺带修一下输入框'), '目标与范围\n\n用户开工时补充：\n顺带修一下输入框');

  for (const id of ['simple-call', 'develop-call']) {
    for (const devices of [true, false]) {
      assert.equal(evaluate(params(id).devices.slice(1), { card: { options: { devices } } }).value, devices, id);
    }
  }

  const message = note => evaluate(outputs('stopped').message.slice(1), { card: { note } }).value;
  for (const note of [null, '']) assert.equal(message(note), '用户没有开工。', note);
  assert.equal(message('这周先不做'), '用户没有开工。\n\n附言：\n这周先不做');

  // 被调用流程的结束输出原样成为「开工」的输出。
  assert.deepEqual(outputs('done-simple'), { pr: '=simple-call.pr', commit: '=simple-call.commit' });
  assert.deepEqual(outputs('done-develop'), { pr: '=develop-call.pr', commit: '=develop-call.commit' });
  assert.deepEqual([nodes['done-simple'].notify, nodes['done-develop'].notify],
    ['=if simple-call.notify = false then false else true', '=if develop-call.notify = false then false else true']);
});

test('结束通知跟随批准卡的勾选，暂不合并与先别都叫醒', async () => {
  const entry = await definition(workflow, 'kickoff');
  const simpleDefinition = await definition(simple, 'simple');
  const developDefinition = await definition(develop, 'develop');
  const simpleNotify = simpleDefinition.outputs('done').notify;
  const developNotify = developDefinition.outputs('done').notify;
  assert.equal(simpleDefinition.nodes.done.notify, simpleNotify);
  assert.equal(developDefinition.nodes.done.notify, developNotify);
  for (const notify of [true, false]) {
    assert.equal(evaluate(simpleNotify.slice(1), { approval: { notify } }).value, notify);
  }
  for (const [delivery, notify, expected] of [['', false, false], ['', true, true], ['requirement-1', false, true]]) {
    assert.equal(evaluate(developNotify.slice(1), { inputs: { delivery }, approve: { options: { notify } } }).value, expected);
  }
  const wake = (id, call, outputs) => evaluate(entry.nodes[id].notify.slice(1), { [call]: outputs }).value;
  for (const [id, call] of [['done-simple', 'simple-call'], ['done-develop', 'develop-call']]) {
    assert.equal(wake(id, call, { notify: false }), false, `${id}：明确取消勾选时不叫醒`);
    assert.equal(wake(id, call, { notify: true }), true, `${id}：勾选时叫醒`);
    assert.equal(wake(id, call, {}), true, `${id}：暂不合并没有 notify 输出时叫醒`);
  }
  assert.equal(entry.nodes.stopped.notify, 'true');
});

test('两个开发流程声明 coda:kind="develop"，简易开发的第一张任务不区分谁发起', async () => {
  const simpleDefinition = await definition(simple, 'simple');
  const developDefinition = await definition(develop, 'develop');
  assert.equal(simpleDefinition.process.kind, 'develop');
  assert.equal(developDefinition.process.kind, 'develop');
  assert.match(simpleDefinition.nodes.report.documentation[0].text, /^这次用简易开发：/);
  assert.doesNotMatch(simpleDefinition.nodes.report.documentation[0].text, /用户在这个会话里开启了/);
});

test('备用执行者与评审者的三个位置：不设默认、可不填，原样交给监督开发；开工卡只读列出执行者、备用执行者与评审者', async () => {
  const { process, nodes, values } = await definition(workflow, 'kickoff');
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  for (const [name, label] of [['executor2', '备用执行者'], ['reviewer', '评审者'], ['reviewer2', '第二评审者'], ['reviewerOnce', '首次评审者']]) {
    const input = inputs[name];
    assert.deepEqual([input.type, input.label, input.default, input.defaultFrom, input.required], ['agent', label, undefined, undefined, undefined], name);
  }
  const card = nodes.card.documentation[0].text;
  const expand = context => card.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => evaluate(expression, context).value ?? '');
  const base = { title: '修好输入框', goal: '目标', way: 'develop', devices: false, device: '' };
  const none = expand({ inputs: { ...base, executor: null, executor2: null, reviewer: null, reviewer2: null, reviewerOnce: null } });
  for (const line of ['- 执行者：发起会话的 Agent', '- 备用执行者（主 Agent 审查时可换它重做当前这项）：未指定', '- 评审者（每次交付都评）：未指定', '- 第二评审者（每次交付都评）：未指定', '- 首次评审者（只评每项任务第一次通过项目检查的那次交付）：未指定']) assert.ok(none.includes(line), line);
  const filled = expand({ inputs: { ...base, executor: { agent: 'a1' }, executor2: { agent: 'a4', model: 'm4' }, reviewer: { agent: 'a2', model: 'm2', effort: 'high' }, reviewer2: null, reviewerOnce: { agent: 'a3', effort: 'low' } } });
  for (const line of ['- 执行者：a1', '- 备用执行者（主 Agent 审查时可换它重做当前这项）：a4 · m4', '- 评审者（每次交付都评）：a2 · m2 · high', '- 第二评审者（每次交付都评）：未指定', '- 首次评审者（只评每项任务第一次通过项目检查的那次交付）：a3 · low']) assert.ok(filled.includes(line), line);
  assert.match(card, /卡上不能改，要换人选「先别」并在附言里说明/);
  // 流程只定位置：谁来评由发起的 Agent 填，流程里不写任何 Agent 或模型。
  for (const xml of [workflow, develop]) assert.doesNotMatch(xml, /codex|claude|kimi|grok|opencode|cursor|gpt|sonnet|opus|haiku|gemini/i);
});
