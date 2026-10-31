// 输入框模式插件里的 Ultra：按 Coda 的调用方式验证参数和给 Agent 的提示，Coda 自身的执行行为由主仓库验证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginDir } from '../plugin.mjs';
import { modeParameters } from '../../../check/coda/components/plugins/plugin-rules.mjs';
import { activate } from '../../../plugins/composer/main.mjs';
import { CUSTOM, OFF, STILL_ON, on, templateValue, templates } from '../../../plugins/composer/ultra.mjs';

const rows = [
  { template: '均衡', who: { agent: 'claude-sdk', model: 'claude-opus-5-5', effort: 'xhigh' }, when: '界面' },
  { template: '均衡', who: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', options: { 'service-tier': 'priority' } }, when: '调研' },
  { template: '快', who: { agent: 'codex', effort: 'low', mode: 'agent' } },
  { template: '', who: { agent: 'codex' } }, { template: '缺 Agent', who: {} },
];
// 模拟 Coda 的提示长度限制：最多 4000 字。
function plugin(settings = { 'composer.templates': rows }) {
  const hooks = new Map(), told = [];
  activate({ plugin: { id: 'composer', path: pluginDir('composer') },
    composerModes: { register: (id, h) => hooks.set(id, h) },
    environment: async () => ({ CODA_PLUGIN_SETTINGS: JSON.stringify(settings) }),
    tell: async (session, text) => { if (text.length > 4000) throw new Error('要告诉的话须为不超过 4000 字的文字'); told.push([session, text]); } });
  return { ultra: hooks.get('ultra'), told };
}
const session = { id: 's1', projectId: 'p1' };
// 按 Coda 的方式从清单读取模式参数。
const parameters = JSON.parse(readFileSync(join(pluginDir('composer'), 'package.json'), 'utf8')).contributes.composerModes.find(m => m.id === 'ultra').parameters;

test('模板按名称分组并保持首次出现的顺序，忽略没有名称或 Agent 的行', () => {
  const all = templates(rows);
  assert.deepEqual([...all.keys()], ['均衡', '快']);
  assert.deepEqual(all.get('均衡').map(r => r.when), ['界面', '调研']);
  assert.deepEqual(templates(undefined), new Map());
});

test('进入时选择首个模板并填入名单，没有模板时使用自定义空名单', async () => {
  const { ultra } = plugin();
  const entered = await ultra.enter({ session, projectId: 'p1', values: {}, parameters });
  assert.deepEqual(entered.parameters.properties.template.enum, [templateValue('均衡'), templateValue('快'), CUSTOM]);
  assert.deepEqual(entered.parameters.properties.template.enumItemLabels, ['均衡', '快', '自定义']);
  assert.equal(entered.parameters.properties.template.default, templateValue('均衡'));
  assert.deepEqual(entered.parameters.properties.subagents.items.properties.when, { title: '什么时候派给它', type: 'string' }, '其余参数保持清单声明');
  assert.deepEqual([entered.values.template, entered.values.subagents.map(r => r.who.agent)], [templateValue('均衡'), ['claude-sdk', 'codex']]);
  // 过长的模板名仍符合 Coda 参数契约，emoji 按完整字符截断。
  const emoji = '😀'.repeat(51), long = await plugin({ 'composer.templates': [{ template: emoji, who: { agent: 'kimi' } }] }).ultra.enter({ session, projectId: 'p1', values: {}, parameters });
  assert.equal(modeParameters(long.parameters, 'ultra').properties.template.enumItemLabels[0], '😀'.repeat(50));
  const none = await plugin({}).ultra.enter({ session, projectId: 'p1', values: {}, parameters });
  assert.deepEqual([none.values.template, none.values.subagents, none.parameters.properties.template.enum], [CUSTOM, [], [CUSTOM]]);
});

test('选择模板填入名单，手动修改名单转为自定义', async () => {
  const { ultra } = plugin();
  const values = { template: templateValue('快'), subagents: [] };
  assert.deepEqual((await ultra.change({ session, projectId: 'p1', values, changed: 'template' })).values.subagents, [{ who: { agent: 'codex', effort: 'low', mode: 'agent' } }]);
  assert.deepEqual((await ultra.change({ session, projectId: 'p1', values: { template: templateValue('均衡'), subagents: [] }, changed: 'subagents' })).values.template, CUSTOM);
  assert.deepEqual((await ultra.change({ session, projectId: 'p1', values: { template: CUSTOM, subagents: [1] }, changed: 'template' })).values.subagents, [1], '自定义名单保持不变');
  // 名为「自定义」或 custom 的模板与自定义选项分开，后者保持现有名单。
  const named = plugin({ 'composer.templates': [{ template: '自定义', who: { agent: 'kimi' } }, { template: 'custom', who: { agent: 'kimi' } }] }).ultra;
  assert.deepEqual((await named.enter({ session, projectId: 'p1', values: {}, parameters })).parameters.properties.template.enumItemLabels, ['自定义', 'custom', '自定义']);
  assert.deepEqual((await named.change({ session, projectId: 'p1', values: { template: CUSTOM, subagents: [1] }, changed: 'template' })).values.subagents, [1]);
  assert.deepEqual((await named.change({ session, projectId: 'p1', values: { template: templateValue('custom'), subagents: [1] }, changed: 'template' })).values.subagents,
    [{ who: { agent: 'kimi' } }]);
});

test('首条和参数变化后发送完整规则，后续发送提醒，已发送过才告知退出', async () => {
  const { ultra, told } = plugin();
  const list = templates(rows).get('均衡'), values = { template: templateValue('均衡'), subagents: list };
  // Coda 在消息被接收后附带提示，插件不自行保存发送状态。
  const said = async (sent, changedSinceSent = false, chosen = values) => (await ultra.send({ session, projectId: 'p1', values: chosen, sent, changedSinceSent }))?.tell ?? null;
  assert.equal(await said(0), on(list));
  assert.match(on(list), /- agent=codex model=gpt-6\.1-sol effort=ultra options=\{"service-tier":"priority"\}: 调研/);
  for (const sent of [1, 2, 9, 10, 11]) assert.equal(await said(sent), STILL_ON);
  const other = { template: CUSTOM, subagents: [list[1]] };
  assert.equal(await said(11, true, other), on([list[1]]));
  await ultra.exit({ session, projectId: 'p1', sent: 12 });
  assert.deepEqual(told.splice(0), [['s1', OFF]]);
  await ultra.exit({ session: { id: 's2' }, projectId: 'p1', sent: 0 });
  assert.deepEqual(told, [], '未发送就退出，无需撤销提示');
  assert.match(on([]), /your own agent and model/);
});

test('新任务尚无会话时读取项目模板，首条消息告知名单', async () => {
  const { ultra, told } = plugin();
  const entered = await ultra.enter({ session: null, projectId: 'p1', values: {}, parameters });
  assert.deepEqual(entered.values.template, templateValue('均衡'));
  assert.equal((await ultra.send({ session: null, projectId: 'p1', values: entered.values, sent: 0, changedSinceSent: false })).tell, on(entered.values.subagents));
  await ultra.exit({ session: null, projectId: 'p1', sent: 0 });
  assert.deepEqual(told, []);
});

// 旧键的迁移属于 Coda 第 4 步；此处只读取当前项目的新键。
test('Ultra 读取当前项目的 composer.templates，旧设置不再生效', async () => {
  const hooks = new Map(), projects = [];
  activate({
    composerModes: { register: (id, callbacks) => hooks.set(id, callbacks) },
    environment: async projectId => {
      projects.push(projectId);
      return { CODA_PLUGIN_SETTINGS: JSON.stringify({
        'ultra.templates': [{ template: '旧模板', who: { agent: 'kimi' } }],
        'composer.templates': [{ template: projectId, who: { agent: 'codex' } }],
      }) };
    },
  });
  const ultra = hooks.get('ultra');
  for (const projectId of ['p1', 'p2']) {
    const entered = await ultra.enter({ session: null, projectId, parameters });
    assert.equal(entered.values.template, templateValue(projectId));
    assert.deepEqual(entered.parameters.properties.template.enumItemLabels, [projectId, '自定义']);
    assert.deepEqual((await ultra.change({ projectId, values: { template: templateValue(projectId) }, changed: 'template' })).values.subagents,
      [{ who: { agent: 'codex' } }]);
  }
  assert.deepEqual(projects, ['p1', 'p1', 'p2', 'p2']);
  const oldOnly = await plugin({ 'ultra.templates': rows }).ultra.enter({ projectId: 'p1', parameters });
  assert.deepEqual(oldOnly.values, { template: CUSTOM, subagents: [] });
});
