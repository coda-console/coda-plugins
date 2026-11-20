// What the plugin host takes of plugins (components/plugins/contribution-points.mjs): the commands that answer a plugin's
// own queries (docs/plugins.md「只给自己用的查询」), by the name its page or process asks them by, defined as this module
// loads. The commands are read where the plugin is (plugin-rules.mjs `selfCommands`: each file one Coda runs itself), so
// what a point reads of it here is nothing. Descriptions only: nothing here imports a component.
import { defineContributionPoint } from './contribution-points.mjs';

defineContributionPoint({ key: 'self',
  schema: { title: 'contributes.self：只给自己用的查询',
    description: '名字 → 插件目录里的文件（相对路径，不离开插件目录），由命令回答插件自己的页面与进程的 self 查询；同一个名字写了命令就交给命令，没有再找模块。至多 50 个。',
    type: 'object', maxProperties: 50,
    propertyNames: { $ref: 'https://coda.pub/schemas/protocol/v1/definition.json#/$defs/operationName' },
    additionalProperties: { type: 'string', 'x-file': { type: 'file' } } },
  read: () => ({}) });
