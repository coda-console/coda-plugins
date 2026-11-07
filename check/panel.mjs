// A resource type (or a panel before them) at the handshake level: read once by Coda's own resources module
// (check/coda/resources/plugins/resources/panels/, Panels), given what Coda's plugin host gives it
// (components/plugins/plugin-host.mjs): the installed plugins as it watches them, here the one checked, and each one's
// environment, as Coda gives every process of the plugin's.
// Its actions are not run: a button may change things (switch an account, spend a reset), and only a person presses it.
import { dirname } from 'node:path';
import { cleared } from './coda/components/plugins/plugin-rules.mjs';
import { ended, runCommand } from './coda/resources/plugins/resources/panels/command.mjs';
import { Panels } from './coda/resources/plugins/resources/panels/panels.mjs';
import { OUTPUT_LIMIT, panelItems, resourceItems } from './coda/resources/plugins/resources/panels/rules.mjs';
import { closing, temporary } from './leftovers.mjs';

// The session a process would belong to: the host's belong to none.
const THREAD_ENV = 'CODA_THREAD_ID';

// The item types a reading holds, cards' items included.
const typesOf = items => items.flatMap(item => item.type === 'card' ? ['card', ...item.items.map(i => i.type)] : [item.type]);
// What a panel's command printed as Coda takes it (panelItems), by type; throws PanelError with where it went wrong. For the
// tests of a plugin's panel.
export const panelTypes = (output, panel, views = []) => typesOf(panelItems(output, panel, views));
// What a resource type's command printed as Coda takes it (resourceItems): its resources, each with only the keys it has and
// its values and buttons; throws PanelError with where it went wrong. For the tests of a plugin's resources.
export const readResources = (output, type, views = []) => resourceItems(output, type, views);
// A reading of resources in a line: how many, and how many values and buttons they have.
const counted = resources => `${resources.length} 个资源，读数 ${resources.reduce((n, r) => n + r.values.length, 0)} 个，按钮 ${resources.reduce((n, r) => n + r.actions.length, 0)} 个${
  resources.some(r => r.error) ? `，${resources.filter(r => r.error).length} 个写了错误` : ''}`;

// `checked`: the plugin as the manifest level read it (manifest.mjs checkManifest). `limit`: how long a reading may take, as
// Panels has it unless given.
export async function checkPanel({ panel, checked, say, limit }) {
  const { plugin } = checked;
  // The plugin's state directory, which Coda keeps for it; here a temporary one, gone however the checker ends.
  const state = temporary('coda-plugin-check-state-');
  // The host's environment of a plugin (env): its processes', the backend's `node` first on the PATH, and the concurrency
  // groups in use as it is asked for (none here).
  const environment = async () => {
    const env = { ...cleared(process.env), ...checked.env(state.dir) };
    delete env[THREAD_ENV];
    env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(':');
    env.CODA_GROUPS_STATE = JSON.stringify({ now: Date.now(), groups: [] });
    return env;
  };
  // The installed plugins as a module watches them (components/plugins/plugins.mjs offered).
  const offered = { id: plugin.id, name: plugin.displayName, version: plugin.version, source: plugin.source, views: plugin.views.map(v => v.id), contributes: plugin.offers ?? {} };
  const coda = { plugin: { state: null }, environment,
    watch: async (name, told) => { told({ type: 'ADDED', id: offered.id, object: offered }); return { dispose() {} }; } };
  // The command's own result, beside what the page shows of it: whether it ended well and what it printed was not a panel's.
  let result = null;
  const panels = new Panels(coda, { run: async (command, options) => (result = await runCommand(command, options)), ...(limit ? { readTimeoutMs: limit } : {}) });
  const done = closing(() => panels.close());
  try {
    await panels.start();
    const started = Date.now(), reading = await panels.read(`${plugin.id}/${panel.id}`), took = ((Date.now() - started) / 1000).toFixed(1);
    const kind = panel.format === 'resources' ? '资源' : '面板';
    if (reading.error && result && ended(result)) return say.fail('panel.output', `输出不合${kind}格式：资源页显示「${reading.error}」`);
    if (reading.error) {
      const why = !result ? '没有运行' : result.timedOut ? `${panels.readTimeoutMs / 1000} 秒没读完，Coda 停下这次读取` : result.overflow ? `标准输出超过 ${OUTPUT_LIMIT / 1024} KiB，Coda 停下这次读取`
        : result.error ? '命令起不来' : `退出码 ${result.code}`;
      return say.fail('panel.read', `读取没成功（${why}）：资源页显示「${reading.error}」`);
    }
    const empty = `资源页不显示它${panel.signIn ? '，它出现在「添加资源」里' : ''}`;
    if (panel.format === 'resources') {
      if (!reading.resources.length) say.info('panel.read', `读出空的 resources（${took} 秒）：${empty}`);
      else say.pass('panel.read', `读取 ${took} 秒，输出合资源格式：${counted(reading.resources)}`);
    } else {
      const types = typesOf(reading.items);
      const counts = Object.entries(Object.groupBy(types, t => t)).map(([t, list]) => `${t} ×${list.length}`).join('，');
      if (!types.length) say.info('panel.read', `读出空的 items（${took} 秒）：${empty}`);
      else say.pass('panel.read', `读取 ${took} 秒，输出合面板格式：${counts}`);
    }
    if (Object.keys(panel.actions).length) say.skip('panel.actions', `动作 ${Object.keys(panel.actions).join('、')} 不运行：按钮可能改动东西，只由人点`);
  } finally {
    panels.close();
    done();
    state.remove();
  }
}
