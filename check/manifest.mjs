// The manifest level: whether the plugin is of the types it names (Coda's docs/plugins.md「插件的内容」, #1917). Its
// package.json is checked against the schemas of Coda's types (check/coda/components/plugins/schemas/, copied as they are
// from the Coda commit check/coda/contract.json names) by the checker Coda runs itself, and then read as Coda reads it: its
// ID, and its settings named under it. What Coda says only where it installs one — the repository it comes from, its npm
// lock, the plugins of that machine beside it — is that machine's to say, not a question of the plugin's types: the checker
// does not run it. The plugins Coda ships (check/coda/builtin.json) and those beside this one in its directory's parent
// stand in for what it depends on, for the levels after this one.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import shipped from './coda/builtin.json' with { type: 'json' };
import { manifestProblem } from './coda/components/plugins/plugin-schema.mjs';
import { offerProblem } from './coda/components/plugins/plugin-extensions.mjs';
import { choosesModelProviders, pluginEnv, readPlugin, resolveSettings } from './coda/components/plugins/plugin-rules.mjs';
import { panelEntries } from './coda/resources/plugins/resources/panels/rules.mjs';

// The plugins Coda ships, by ID. Their files are Coda's, not here: none has a directory on this machine.
const builtin = new Map(shipped.map(plugin => [plugin.id, { ...plugin, dir: undefined }]));
// Those it installs from the start, as rows without a source (components/plugins/plugins.mjs).
const installed = new Map(shipped.filter(plugin => plugin.defaultInstalled).map(plugin => [plugin.id, { id: plugin.id, source: null }]));
// The categories Coda's own plugins use, which its plugin pages list first, in this order.
export const CATEGORIES = ['Agent', '模型与账号', '工作流程', '机器与资源', 'Skills 与工具'];
// A plugin it depends on, beside it in its parent directory (as coda-plugins keeps them) and of the ID asked for: read as Coda
// reads one, or none.
function beside(dir, id) {
  const at = join(dirname(realpathSync(dir)), id);
  if (!existsSync(join(at, 'package.json'))) return null;
  try { const plugin = readPlugin(at, { kind: 'git' }); return plugin.id === id ? plugin : null; } catch { return null; }
}
// iOS draws an icon's PDF at 96 points and only ever scales it down: a smaller page comes out as a dot (Coda's own icons are
// 256 points). The page box may sit in a compressed object stream (PDF 1.5 and later, as CairoSVG writes them).
function pageSize(data) {
  const MEDIA_BOX = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/;
  const raw = data.toString('latin1'), texts = [raw];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length, end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try { texts.push(inflateSync(data.subarray(start, end)).toString('latin1')); } catch {}
  }
  for (const text of texts) {
    const box = MEDIA_BOX.exec(text);
    if (box) return { width: Number(box[3]) - Number(box[1]), height: Number(box[4]) - Number(box[2]) };
  }
  return null;
}

// Checks the manifest in `dir` and reports under `say` (report.mjs). Returns what the later levels need — the plugin as Coda
// reads it, its agents and the panels the resources plugin can read, its settings for every project, the directories of the
// plugins it depends on that are here, and `env(stateDir)`, what Coda gives each of its processes —; null when it is no
// plugin, or not of the types it names.
export function checkManifest(dir, say) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) { say.fail('manifest.read', `没有可读的 package.json：${e.message}`); return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !('contributes' in manifest)) {
    say.fail('manifest.contributes', 'package.json 没有 contributes：Coda 读仓库时不把这个目录当插件'); return null;
  }
  const problem = manifestProblem(manifest, dir);
  if (problem) { say.fail('manifest.read', `不合它用到的类型：${problem}`); return null; }
  let plugin;
  try { plugin = readPlugin(dir, { kind: 'git' }); }
  catch (e) { if (e.code !== 'invalid_plugin') throw e; say.fail('manifest.read', `Coda 读不成插件：${e.message}`); return null; }

  say.pass('manifest.name', `package.json 合乎它用到的类型，插件 ID ${plugin.id}${builtin.has(plugin.id) ? `（Coda 也自带 ${plugin.id}：装同一来源的新版本才能盖过它）` : ''}`);
  if (typeof manifest.version !== 'string') say.warn('manifest.version', 'package.json 没有 version：Coda 只认提交，version 只作显示，但安装确认里会空着');
  // Coda's plugin pages group plugins by the first of their `categories` (Coda's docs/plugins.md「商店」).
  if (!plugin.category) say.warn('manifest.categories', `package.json 没有 categories：Coda 的插件页把它归「其他」；分类用 ${CATEGORIES.join('、')} 之一`);
  else if (!CATEGORIES.includes(plugin.category)) say.warn('manifest.categories', `分类「${plugin.category}」不是 Coda 自己的插件用的（${CATEGORIES.join('、')}）：插件页把它排在这些之后`);
  else say.pass('manifest.categories', `分类 ${plugin.category}`);

  // What it brings, as Coda read it.
  const settingCount = Object.keys(plugin.properties).length, names = list => list.map(x => x.name).join('、');
  if (settingCount) say.pass('manifest.settings', `设置 ${settingCount} 项`);
  if (plugin.workflows.length || plugin.capabilities.length) say.pass('manifest.capabilities', `流程 ${plugin.workflows.join('、') || '无'}，能力 ${plugin.capabilities.join('、') || '无'}`);
  if (plugin.groups.length) say.pass('manifest.groups', `并发组 ${names(plugin.groups)}`);
  if (plugin.events?.length) say.pass('manifest.events', `发布的事件 ${names(plugin.events)}`);
  if (plugin.commands.length) say.pass('manifest.commands', `会话 PATH 上的命令 ${names(plugin.commands)}`);
  if (plugin.services.length) say.pass('manifest.services', `开启随包服务 ${plugin.services.join('、')}：没有已安装插件开启的服务不运行`);
  if (plugin.setup) say.pass('manifest.setup', '设置动作（contributes.setup）：一行命令；检查不运行它（可能装软件）');
  plugin.agents.forEach((agent, i) => {
    const declared = manifest.contributes.agents[i].icon;
    const icons = [['light', declared.light], ...(agent.icon.dark ? [['dark', declared.dark]] : [])].map(([key, at]) => ({ at, data: Buffer.from(agent.icon[key], 'base64') }));
    say.pass('manifest.agents', `Agent ${agent.id}「${agent.displayName}」：command 一行，图标 PDF（${icons.map(i => `${i.at} ${(i.data.length / 1024).toFixed(1)} KiB`).join('，')}）`);
    // Sessions from before #1069 store the agent ID `claude`: a plugin that declares it takes them over.
    if (agent.id === 'claude') say.warn('manifest.agent-id', 'Agent ID claude 是 Coda 早先的 Claude 会话存的 ID：装上会接管那些旧会话，换一个 ID');
    for (const icon of icons) {
      const page = pageSize(icon.data);
      if (page && Math.min(page.width, page.height) < 64) say.warn('manifest.icon-page', `${icon.at} 的页面只有 ${page.width}×${page.height} pt：iOS 按 96 pt 光栅化图标、只缩不放，页面太小会画成一个点；照 Coda 自带图标按 256 px（192 pt）出图`);
    }
  });
  // What it writes for other plugins' points (Coda's own keys aside) is of the types they declare: one no plugin Coda ships, and
  // none it depends on beside it, declares is of no type.
  const found = new Map(plugin.dependencies.filter(id => !builtin.has(id)).flatMap(id => { const there = beside(dir, id); return there ? [[id, there]] : []; }));
  const offered = offerProblem(plugin, new Map([...builtin, ...found]));
  if (offered) say.fail('manifest.offers', offered);
  // Its panels, as the resources plugin reads what is written for its point: one it cannot read shows there as such.
  const panels = [];
  for (const entry of panelEntries(plugin.offers?.panels, plugin.displayName)) {
    if (entry.invalid) { say.fail('manifest.panels', `面板 ${entry.invalid.id}：${entry.invalid.error}（资源页上它只显示「声明无效」）`); continue; }
    const { panel } = entry;
    panels.push(panel);
    say.pass('manifest.panels', `面板 ${panel.id}「${panel.title}」：动作 ${Object.keys(panel.actions).join('、') || '无'}${panel.signIn ? '，可从 Coda 登录' : ''}`);
  }

  // What its processes are given (pluginEnv): the plugins it depends on, those beside it here; one Coda ships has its
  // directory in Coda, not here, even with one of its ID beside it (Coda picks its own), and one found nowhere is not named.
  const given = new Map([...builtin, ...found, [plugin.id, { ...plugin, dependencies: plugin.dependencies.filter(d => found.has(d) || builtin.has(d)) }]]);
  const dependencies = Object.fromEntries([...found].map(([id, each]) => [id, each.dir]));
  if (plugin.dependencies.length) {
    const absent = plugin.dependencies.filter(d => !found.has(d));
    say.info('manifest.extensions', `依赖 ${plugin.dependencies.join('、')}：Coda 装它时先装它们，它的进程从 CODA_PLUGIN_DEPENDENCIES 拿到它们的目录${absent.length
      ? `；${absent.join('、')} 不在旁边，检查时不带` : ''}`);
  }
  // Its settings for every project, as nobody has set any: the declarations' defaults.
  const settings = resolveSettings(plugin).values;
  // The model services of a machine with none, for one that chooses them; the PATH has no directories of Coda's own here.
  const env = stateDir => pluginEnv({ catalog: given, installed, id: plugin.id, stateDir: id => id === plugin.id ? stateDir : null, settings,
    providers: choosesModelProviders(plugin) ? {} : null, userPath: process.env.PATH ?? '' });
  return { id: plugin.id, manifest, plugin, agents: plugin.agents, panels, settings, dependencies, env };
}
