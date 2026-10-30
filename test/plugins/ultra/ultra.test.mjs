// The Ultra plugin's module (plugins/ultra/README.md), its hooks called as Coda calls them, with a `coda` that keeps what
// it is told. Entering, the parameters and what the agent hears; what Coda does with them is Coda's own to test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginDir } from '../plugin.mjs';
import { activate } from '../../../plugins/ultra/main.mjs';
import { CUSTOM, OFF, STILL_ON, on, templateValue, templates } from '../../../plugins/ultra/ultra.mjs';

const rows = [
  { template: '均衡', who: { agent: 'claude-sdk', model: 'claude-opus-5-5', effort: 'xhigh' }, when: '界面' },
  { template: '均衡', who: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', options: { 'service-tier': 'priority' } }, when: '调研' },
  { template: '快', who: { agent: 'codex', effort: 'low', mode: 'agent' } },
  { template: '', who: { agent: 'codex' } }, { template: '缺 Agent', who: {} },
];
// `coda.tell` refuses what Coda's does: more than 4000 characters.
function plugin(settings = { 'ultra.templates': rows }) {
  const hooks = new Map(), told = [];
  activate({ plugin: { id: 'ultra', path: pluginDir('ultra') },
    composerModes: { register: (id, h) => hooks.set(id, h) },
    environment: async () => ({ CODA_PLUGIN_SETTINGS: JSON.stringify(settings) }),
    tell: async (session, text) => { if (text.length > 4000) throw new Error('要告诉的话须为不超过 4000 字的文字'); told.push([session, text]); } });
  return { ultra: hooks.get('ultra'), told };
}
const session = { id: 's1', projectId: 'p1' };
// The mode's parameters as Coda gives them to its hooks: as package.json writes them.
const parameters = JSON.parse(readFileSync(join(pluginDir('ultra'), 'package.json'), 'utf8')).contributes.composerModes.find(m => m.id === 'ultra').parameters;

test('the templates are the setting\'s rows by name, in the order each first comes; a row with no name or no agent is none', () => {
  const all = templates(rows);
  assert.deepEqual([...all.keys()], ['均衡', '快']);
  assert.deepEqual(all.get('均衡').map(r => r.when), ['界面', '调研']);
  assert.deepEqual(templates(undefined), new Map());
});

test('entering offers the templates, the first chosen and its list filled in; none set, the list is the user\'s own', async () => {
  const { ultra } = plugin();
  const entered = await ultra.enter({ session, values: {}, parameters });
  assert.deepEqual(entered.parameters.properties.template.enum, [templateValue('均衡'), templateValue('快'), CUSTOM]);
  assert.deepEqual(entered.parameters.properties.template.enumItemLabels, ['均衡', '快', '自定义']);
  assert.equal(entered.parameters.properties.template.default, templateValue('均衡'));
  assert.deepEqual(entered.parameters.properties.subagents.items.properties.when, { title: '什么时候派给它', type: 'string' }, 'the rest as declared');
  assert.deepEqual([entered.values.template, entered.values.subagents.map(r => r.who.agent)], [templateValue('均衡'), ['claude-sdk', 'codex']]);
  const none = await plugin({}).ultra.enter({ session, values: {}, parameters });
  assert.deepEqual([none.values.template, none.values.subagents, none.parameters.properties.template.enum], [CUSTOM, [], [CUSTOM]]);
});

test('choosing a template fills the list; changing the list makes it the user\'s own', async () => {
  const { ultra } = plugin();
  const values = { template: templateValue('快'), subagents: [] };
  assert.deepEqual((await ultra.change({ session, values, changed: 'template' })).values.subagents, [{ who: { agent: 'codex', effort: 'low', mode: 'agent' } }]);
  assert.deepEqual((await ultra.change({ session, values: { template: templateValue('均衡'), subagents: [] }, changed: 'subagents' })).values.template, CUSTOM);
  assert.deepEqual((await ultra.change({ session, values: { template: CUSTOM, subagents: [1] }, changed: 'template' })).values.subagents, [1], 'its own list stays its own');
  // A template named as the hand-made list is shown is still a template of its own: choosing 自定义 keeps the list.
  const named = plugin({ 'ultra.templates': [{ template: '自定义', who: { agent: 'kimi' } }, { template: 'custom', who: { agent: 'kimi' } }] }).ultra;
  assert.deepEqual((await named.enter({ session, values: {}, parameters })).parameters.properties.template.enumItemLabels, ['自定义', 'custom', '自定义']);
  assert.deepEqual((await named.change({ session, values: { template: CUSTOM, subagents: [1] }, changed: 'template' })).values.subagents, [1]);
  assert.deepEqual((await named.change({ session, values: { template: templateValue('custom'), subagents: [1] }, changed: 'template' })).values.subagents,
    [{ who: { agent: 'kimi' } }]);
});

test('the agent is told it is on with the first message and whenever the list changed, reminded every ten, and told it is off only once told it was on', async () => {
  const { ultra, told } = plugin();
  const list = templates(rows).get('均衡'), values = { template: templateValue('均衡'), subagents: list };
  await ultra.send({ session, values, sent: 0 });
  assert.deepEqual(told.splice(0), [['s1', on(list)]]);
  assert.match(on(list), /- agent=codex model=gpt-6\.1-sol effort=ultra options=\{"service-tier":"priority"\}: 调研/);
  for (const sent of [1, 2, 9]) await ultra.send({ session, values, sent });
  assert.deepEqual(told.splice(0), []);
  await ultra.send({ session, values, sent: 10 });
  assert.deepEqual(told.splice(0), [['s1', STILL_ON]]);
  const other = { template: CUSTOM, subagents: [list[1]] };
  await ultra.send({ session, values: other, sent: 11 });
  assert.deepEqual(told.splice(0), [['s1', on([list[1]])]]);
  await ultra.exit({ session, sent: 12 });
  assert.deepEqual(told.splice(0), [['s1', OFF]]);
  await ultra.exit({ session: { id: 's2' }, sent: 0 });
  assert.deepEqual(told, [], 'left before anything was sent: nothing to take back');
  assert.match(on([]), /your own agent and model/);
});

test('a list the agent could not be told refuses the message, and the same list sent again is told again', async () => {
  const { ultra, told } = plugin();
  const short = [{ who: { agent: 'codex' }, when: '调研' }], long = [{ who: { agent: 'codex' }, when: '长'.repeat(4000) }];
  await ultra.send({ session, values: { subagents: short }, sent: 0 });
  for (let i = 0; i < 2; i++) await assert.rejects(ultra.send({ session, values: { subagents: long }, sent: 1 }), /4000/);
  const shorter = [{ who: { agent: 'codex' }, when: '短了' }];
  await ultra.send({ session, values: { subagents: shorter }, sent: 1 });
  assert.deepEqual(told.map(([, text]) => text), [on(short), on(shorter)]);
});
