// Compact labels belong to the adapter. Keep native IDs, full names, groups and all unrelated metadata intact.
const modes = { 'read-only': '审批', agent: '自动审批', 'agent-full-access': '完全访问' };
const label = (value, category, id = value.value ?? value.id) => {
  const shortName = category === 'mode' ? modes[id]
    : category === 'model' && /^GPT[- ]\d/i.test(value.name ?? '') ? value.name.replace(/^GPT[- ]/i, '') : undefined;
  return shortName ? { ...value, _meta: { ...value._meta, coda: { ...value._meta?.coda, shortName } } } : value;
};
const options = list => list.map(option => ({ ...option, ...(Array.isArray(option.options) ? {
  options: option.options.map(value => Array.isArray(value.options)
    ? { ...value, options: value.options.map(each => label(each, option.category)) } : label(value, option.category)),
} : {}) }));
const display = value => ({ ...value,
  ...(value.configOptions ? { configOptions: options(value.configOptions) } : {}),
  ...(value.modes?.availableModes ? { modes: { ...value.modes, availableModes: value.modes.availableModes.map(mode => label(mode, 'mode')) } } : {}),
  ...(value.models?.availableModels ? { models: { ...value.models, availableModels: value.models.availableModels.map(model => label(model, 'model')) } } : {}),
});
export function codexDisplayNames(message) {
  if (message?.result && typeof message.result === 'object') return { ...message, result: display(message.result) };
  if (message?.params?.update?.sessionUpdate === 'config_option_update') {
    return { ...message, params: { ...message.params, update: display(message.params.update) } };
  }
  return message;
}
