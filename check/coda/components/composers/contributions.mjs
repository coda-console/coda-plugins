// What the composer takes of plugins (components/plugins/contribution-points.mjs): the modes a composer can be put in
// (docs/plugins.md「输入框模式」, schemas/composer-modes.json), defined as this module loads.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { defineContributionPoint } from '../plugins/contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';
import { setting } from '../plugins/plugin-rules.mjs';

// Each mode with the composers that offer it (`in`, a session's by default), whether it leaves after acceptance (`once`),
// and declarative parameters.
const MODE_PLACES = ['session', 'new'];
const composerModes = (modes = []) => modes.map((m, i) => ({ id: m.id, title: m.title.trim(), icon: m.icon,
  ...(m.hint ? { hint: m.hint.trim() } : {}), ...(m.placeholder ? { placeholder: m.placeholder.trim() } : {}),
  ...(m.sendLabel ? { sendLabel: m.sendLabel.trim() } : {}), once: m.once === true, ...(m.trigger ? { trigger: m.trigger } : {}),
  in: m.in ? MODE_PLACES.filter(place => m.in.includes(place)) : ['session'],
  ...(m.parameters !== undefined ? { parameters: parametersOf(m.parameters, `contributes.composerModes[${i}].parameters`), schema: structuredClone(m.parameters) } : {}) }));
// A mode's parameters as read: each a setting, in the order written, which the clients show them in (JSON's objects keep
// none of their own there); what it cannot go without, `required`.
function parametersOf(value, where) {
  const ordered = fields => Object.fromEntries(Object.entries(fields).map(([name, spec], i) => [name, { ...spec, order: spec.order ?? i }]));
  const properties = Object.fromEntries(Object.entries(value.properties).map(([name, p], i) => {
    const read = setting(p, `${where}.properties.${name}`);
    return [name, { ...read, ...(p.presets ? { presets: structuredClone(p.presets) } : {}), ...(read.rows ? { rows: { ...read.rows, columns: ordered(read.rows.columns) } } : {}), order: read.order ?? i }];
  }));
  return { properties, ...(value.required?.length ? { required: [...value.required] } : {}) };
}

// A mode's name and the character typed to enter one are one plugin's: the composer finds it by them. Confirmed as
// declared: the clients show them from this.
defineContributionPoint({ key: 'composerModes', schema: SCHEMAS['composer-modes.json'], read: raw => raw?.length ? { composerModes: composerModes(raw) } : {},
  claim: plugin => (plugin.composerModes ?? []).flatMap(m => [`输入框模式 /${m.id}`, ...(m.trigger ? [`输入框里打 ${m.trigger} 进入的模式`] : [])]),
  confirm: plugin => plugin.composerModes?.length ? { composerModes: plugin.composerModes.map(({ schema: _, ...mode }) => mode) } : {} });
