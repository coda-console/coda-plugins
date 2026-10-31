import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeModels, configOptions } from '../../plugins/claude/agent/models.mjs';
import { codexDisplayNames } from '../../plugins/codex/agent/display.mjs';
import { kimiDisplayNames } from '../../plugins/kimi/agent/display.mjs';

test('Claude names keep versions and context variants, while full labels and execution IDs stay intact', () => {
  const models = claudeModels([
    { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-4-6' },
    { value: 'opus', displayName: 'Claude Opus 4.6', resolvedModel: 'claude-opus-4-6' },
    { value: 'opus[1m]', displayName: 'Claude Opus 4.6 (1M context)', resolvedModel: 'claude-opus-4-6' },
  ]);
  assert.deepEqual(models.map(m => [m.id, m.shortName]), [['claude-opus-4-6', 'Opus 4.6'], ['claude-opus-4-6[1m]', 'Opus 4.6 [1m]']]);
  assert.equal(models[0].name, 'Claude Opus 4.6 (claude-opus-4-6)');
  for (const grouped of [false, true]) {
    const opts = configOptions([...models, ...(grouped ? [{ id: 'service/custom', name: 'Custom', shortName: 'C', service: 'service' }] : [])], { model: models[0].id, mode: 'default' });
    const choices = opts.find(x => x.category === 'model').options.flatMap(x => x.options ?? x);
    assert.equal(choices[0]._meta.coda.shortName, 'Opus 4.6');
    assert.equal(opts[0].options[0]._meta.coda.shortName, '审批');
  }
  const duplicate = claudeModels([{ value: 'a', displayName: 'Custom' }, { value: 'b', displayName: 'Custom' }]);
  assert.notEqual(duplicate[0].shortName, duplicate[1].shortName);
});

for (const [name, present, mode, short, modelName, modelShort] of [
  ['Codex', codexDisplayNames, 'read-only', '审批', 'GPT-6.1 Sol', '6.1 Sol'],
  ['Kimi', kimiDisplayNames, 'default', '审批', 'K3.1 Pro Highspeed 2x Usage Cost', 'K3.1 Pro 高速·2×用量'],
]) test(`${name} publishes compact names on opening, setting changes and live updates, without replacing metadata or IDs`, () => {
  const option = { category: 'mode', options: [{ value: mode, name: 'Full label', _meta: { future: 1, coda: { default: true } } }] };
  const configOptions = [option, { category: 'model', options: [{ group: 'native', name: name, options: [{ value: 'wire-id', name: modelName }] }] }];
  for (const message of [{ id: 1, result: { configOptions } }, { params: { update: { sessionUpdate: 'config_option_update', configOptions } } }]) {
    const original = structuredClone(message), result = present(message), options = result.result?.configOptions ?? result.params.update.configOptions;
    assert.deepEqual(options[0].options[0], { ...option.options[0], _meta: { future: 1, coda: { default: true, shortName: short } } });
    assert.equal(options[1].options[0].options[0]._meta.coda.shortName, modelShort);
    assert.deepEqual(message, original);
  }
  const legacy = present({ result: { modes: { availableModes: [{ id: mode, name: 'Full' }] } } });
  assert.equal(legacy.result.modes.availableModes[0]._meta.coda.shortName, short);
  const unknown = { category: 'mode', options: [{ value: 'future', name: 'Future' }] };
  assert.deepEqual(present({ result: { configOptions: [unknown] } }).result.configOptions[0], unknown);
});
