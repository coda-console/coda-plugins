// What the plugin host takes of plugins (components/plugins/contribution-points.mjs): the processes a plugin's module
// starts to outlive the call or the module that started them (docs/plugins.md「起进程」), each by a name its `spawn`
// gives (`{ name }`), defined as this module loads. Descriptions only: nothing here imports a component.
import { defineContributionPoint } from './contribution-points.mjs';

defineContributionPoint({ key: 'processes',
  schema: { description: '模块起的、比起它的调用或模块活得久的进程，各一个名字；spawn 时用 { name } 对上', type: 'array', uniqueItems: true,
    items: { description: '进程名：小写字母、数字和「-」，以字母开头，至多 40 个字符', type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' } },
  read: (raw = []) => raw.length ? { processes: [...raw] } : {} });
