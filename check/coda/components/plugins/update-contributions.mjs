// What updating plugins takes of plugins (components/plugins/contribution-points.mjs): which of a plugin's own boolean
// settings is this machine's switch for updating its plugins by itself (docs/plugins.md「自动更新插件」, plugins.mjs
// autoUpdate), defined as this module loads. One plugin's alone: the switch is stored once, where its plugin keeps it.
// Descriptions only: nothing here imports a component.
import { defineContributionPoint } from './contribution-points.mjs';

defineContributionPoint({ key: 'autoUpdateSetting',
  schema: { title: 'contributes.autoUpdateSetting：自动更新插件的开关',
    description: 'autoUpdateSetting 是本插件声明过的一项布尔设置的名字：这台机器自动更新插件的开关，只有设为 false 时关',
    type: 'string', 'x-ref': { pointer: '/contributes/configuration/properties', match: { properties: { type: { const: 'boolean' } }, required: ['type'] } } },
  read: raw => raw ? { autoUpdateSetting: raw } : {},
  claim: plugin => plugin.autoUpdateSetting ? ['自动更新插件的开关'] : [] });
