// The manifest level: what Coda reads of a plugin's directory before anything of it runs, by Coda's own code (check/coda/,
// copied as it is from the Coda commit check/coda/contract.json names), in the order its「从仓库添加…」reads a repository
// (components/plugins/plugin-sources.mjs readSource, inspect): whether it finds the directory, what the directory holds
// (treeProblem), the plugin (readPlugin), its npm packages (manifestProblem), and the plugin beside those of the machine it
// goes to (candidate). Coda stops at the first thing it refuses, and the verdict here is that one failure; the rest is
// advice of the checker's that Coda does not refuse a plugin for. The machine is a Coda fresh from installing it: the
// plugins it ships (check/coda/builtin.json, as its builtinPlugins reads them), those it installs from the start installed.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import shipped from './coda/builtin.json' with { type: 'json' };
import { choosesModelProviders, pluginEnv, readPlugin, resolveSettings } from './coda/components/plugins/plugin-rules.mjs';
import { candidate, candidates, catalogAfter, manifestId, manifestProblem, npmPackages, repoAddress, sameSource, sourcePath, treeProblem } from './coda/components/plugins/plugin-source-rules.mjs';
import { panelEntries } from './coda/resources/plugins/resources/panels/rules.mjs';

// The plugins Coda ships, by ID. Their files are Coda's, not here: none has a directory on this machine, and what Coda gives
// a plugin's processes of them names none.
const builtin = new Map(shipped.map(plugin => [plugin.id, { ...plugin, dir: undefined }]));
// Those it installs from the start, as rows without a source (components/plugins/plugins.mjs), and its catalog, which is
// they and nothing installed from elsewhere yet.
const installed = new Map(shipped.filter(plugin => plugin.defaultInstalled).map(plugin => [plugin.id, { id: plugin.id, source: null }]));
const catalog = new Map(builtin);
// The categories Coda's own plugins use, which its plugin pages list first, in this order.
export const CATEGORIES = ['Agent', '模型与账号', '工作流程', '机器与资源', 'Skills 与工具'];
// Where a refusal comes in the order Coda reads: one after the first is not reached.
const ORDER = ['source.depth', 'source.segment', 'source.files', 'manifest.read', 'source.npm', 'source.catalog'];

// ---- The repository, as Coda's reading of it sees it ----
// The repository a directory is read from, as Coda would be given it — its Git origin, else its top directory (Coda reads a
// repository of this machine by its absolute path) —, the directory in it, and the files a commit of it would hold: those
// Git tracks, and those it would once they are committed (`untracked`). Outside Git, the directory is a repository of its own.
function repository(dir) {
  const real = realpathSync(dir);
  const git = (at, args) => execFileSync('git', ['-C', at, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let top = null;
  try { top = git(real, ['rev-parse', '--show-toplevel']).trim(); } catch {}
  if (!top) return { top: null, at: real, repo: real, path: '', commit: null, files: walk(real) };
  const tracked = git(top, ['ls-files', '-s', '-z']).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t'), [mode] = entry.slice(0, tab).split(' ');
    return { mode, name: entry.slice(tab + 1) };
  });
  const untracked = git(top, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean).map(name => ({ name, untracked: true }));
  let repo = top, commit = null;
  try { repo = repoAddress(git(top, ['remote', 'get-url', 'origin']).trim()); } catch {}
  try { commit = git(top, ['rev-parse', 'HEAD']).trim(); } catch {}
  // Git names the top by its real path; so is the directory measured.
  return { top, at: top, repo, commit, path: relative(top, real).split(sep).filter(Boolean).join('/'), files: [...tracked, ...untracked].map(e => withStat(top, e)) };
}
// Every file but `.git`, and the npm packages installed beside them, which do not count (SIZE_LIMIT); a directory with a `.git`
// of its own is another repository.
function walk(dir) {
  const entries = [];
  const visit = sub => {
    for (const name of readdirSync(join(dir, sub))) {
      if ((!sub && name === '.git') || name === 'node_modules') continue;
      const rel = sub ? `${sub}/${name}` : name, stat = lstatSync(join(dir, rel));
      if (stat.isDirectory()) { if (existsSync(join(dir, rel, '.git'))) entries.push({ name: rel, mode: '160000', size: 0 }); else visit(rel); }
      else entries.push(withStat(dir, { name: rel }));
    }
  };
  visit('');
  return entries;
}
function withStat(dir, entry) {
  let stat = null;
  try { stat = lstatSync(join(dir, entry.name)); } catch {}
  const mode = entry.mode ?? (stat?.isSymbolicLink() ? '120000' : '100644');
  return { ...entry, mode, size: stat && !stat.isSymbolicLink() && stat.isFile() ? stat.size : 0, missing: !stat && mode !== '160000' };
}
// The files of the directory at `path`, named within it, as `git ls-tree -r -l <commit>:<path>` lists them for Coda.
const within = (files, path) => path ? files.filter(f => f.name.startsWith(`${path}/`)).map(f => ({ ...f, name: f.name.slice(path.length + 1) })) : files;
// Coda's reading of a commit takes a directory as a plugin by its manifest saying what it contributes.
const contributing = manifest => !!manifest && typeof manifest === 'object' && !Array.isArray(manifest) && 'contributes' in manifest;

// What a directory is as a plugin, as Coda's inspect says it (`found`: `{ plugin }` and why it cannot be installed, or only
// why), with the rule the first refusal is said under. `plugin` is read even where Coda stopped before it, for the levels
// after this one; `lock` is the package-lock.json a commit would hold (null without one, undefined when it does not parse).
// A file system's error reading it (a file where Coda reads a directory, say) is no problem of the directory's own to Coda:
// it fails Coda's reading of the whole repository (`broken`).
function inspect(dir, files, source) {
  let plugin = null, manifest = null, unread = null, broken = false;
  try { plugin = readPlugin(dir, source); manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) {
    if (e.code !== 'invalid_plugin' && !e.syscall) throw e;
    unread = e.code === 'invalid_plugin' ? e.message : `读不了：${e.message}`; broken = !!e.syscall && e.code !== 'ENOENT';
  }
  let lock = null;
  if (files.some(f => f.name === 'package-lock.json' && !f.missing)) try { lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')); } catch { lock = undefined; }
  const tree = treeProblem(files);
  if (tree) return { found: { problem: tree }, rule: 'source.files', plugin, lock };
  if (unread) return { found: { problem: unread }, rule: 'manifest.read', plugin, lock, broken };
  const npm = manifestProblem(manifest, lock);
  plugin = { ...plugin, npm: npmPackages(manifest, lock) };
  return { found: { plugin, problem: npm }, rule: npm ? 'source.npm' : null, plugin, lock };
}
// Why Coda's reading of the repository does not get to the directory at `path`, or null: it looks for plugins only so deep
// (candidates), and a source names only some directories (sourcePath; readSource says so in these words).
function located(path) {
  if (!candidates([path ? `${path}/package.json` : 'package.json']).length)
    return { problem: `插件目录 ${path} 在仓库根下超过 2 层（或在 node_modules 里）：Coda 读仓库时扫不到它`, rule: 'source.depth' };
  try { sourcePath(path); } catch { return { problem: `目录名 ${path} 只能用字母、数字和「._-」`, rule: 'source.segment' }; }
  return null;
}
// The other plugins of the same commit, by ID → `{ path, plugin }`: those that read, as Coda's readSource finds them; and
// those whose reading fails Coda's reading of the whole repository (`broken`: path → why).
function siblingsOf(repo, own) {
  const found = new Map(), broken = new Map();
  for (const path of candidates(repo.files.filter(f => !f.missing).map(f => f.name))) {
    if (path === own) continue;
    const dir = join(repo.at, path);
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch {}
    if (!contributing(manifest)) continue;
    try { sourcePath(path); } catch { continue; }
    const read = inspect(dir, within(repo.files, path), { kind: 'git', repo: repo.repo, path, ref: '', commit: repo.commit });
    if (read.broken) broken.set(path, read.found.problem);
    else if (read.plugin && !read.found.problem) found.set(read.plugin.id, { path, plugin: read.plugin });
  }
  return { found, broken };
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
// plugins it depends on that are here, and `env(stateDir)`, what Coda gives each of its processes —; null when Coda reads no
// plugin there.
export function checkManifest(dir, say) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) { say.fail('manifest.read', `没有可读的 package.json：${e.message}`); return null; }
  if (!contributing(manifest)) { say.fail('manifest.contributes', 'package.json 没有 contributes：Coda 读仓库时不把这个目录当插件'); return null; }
  const repo = repository(dir), { path } = repo, files = within(repo.files, path);
  // A plugin Coda ships, checked where it is kept: a new version of it, from the same source — its directory in the repository
  // it comes from (as Coda's「从仓库添加…」reads it there), or the package Coda ships it as, read as from where that package is
  // published. Any other of the same ID is a plugin from elsewhere, refused while Coda has the built-in one installed.
  const own = [...builtin.values()].find(b => b.id === manifestId(manifest) && b.source?.repo
    && ((b.source.package && b.source.package === manifest.name) || sameSource(b.source, { repo: repo.repo, path })));
  const source = { kind: 'git', repo: own?.source.repo ?? repo.repo, path: own?.source.path ?? path, ref: '', commit: repo.commit };

  const where = located(path), read = inspect(dir, files, source), { found: siblings, broken } = siblingsOf(repo, path);
  for (const [at, why] of broken) say.fail('source.read', `同一仓库的 ${at} ${why}：Coda 读这个仓库时整个出错，这个插件也装不了`);
  const judged = candidate({ path, manifest, ...(where ? { problem: where.problem } : read.found), fallback: basename(path || repo.repo).replace(/\.git$/, '') },
    { catalog, installed, builtin }, siblings);
  const refused = judged.problem ? where?.rule ?? read.rule ?? 'source.catalog' : null;
  const reached = rule => !refused || ORDER.indexOf(rule) < ORDER.indexOf(refused);
  if (refused) say.fail(refused, refused === 'manifest.read' ? `Coda 读不成插件：${judged.problem}`
    : refused === 'source.npm' && read.lock === null && existsSync(join(dir, 'package-lock.json')) ? `${judged.problem}（有这个文件，但被 .gitignore 忽略了，不在提交里）` : judged.problem);

  // What a commit of the directory holds, said after what Coda read of it.
  const commit = () => {
    const size = files.reduce((sum, e) => sum + e.size, 0), untracked = files.filter(e => e.untracked), missing = files.filter(e => e.missing);
    if (reached('source.files') && refused !== 'source.files') say.pass('source.files', `从仓库安装的限制：无符号链接与子模块，整个目录 ${(size / 1024).toFixed(1)} KiB`);
    if (untracked.length) say.warn('source.untracked', `${untracked.length} 个文件还没提交（如 ${untracked[0].name}）：Coda 只读提交里的文件`);
    if (missing.length) say.warn('source.missing', `${missing.length} 个已跟踪的文件在工作区里不见了（如 ${missing[0].name}）`);
    if (!repo.top) say.info('source.git', '目录不在 Git 仓库里：按目录里的文件检查，提交后以 Coda 读到的为准');
  };
  const { plugin } = read;
  if (!plugin) { commit(); return null; }

  say.pass('manifest.name', `package.json 能读，插件 ID ${plugin.id}${own ? `（Coda 内置插件 ${own.id}：Coda 带的是${own.source.package
    ? ` npm 上 ${own.source.package} 的一个版本` : ` ${own.source.repo} 的一个提交`}，这里是它同一来源的新版本，可以盖过它）` : ''}`);
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
    if (agent.id === 'claude') say.warn('manifest.agent-id', 'Agent ID claude 是 Coda 早先的 Claude 会话存的 ID：Coda 的读取来源不拦它，但装上会接管那些旧会话，换一个 ID');
    for (const icon of icons) {
      const page = pageSize(icon.data);
      if (page && Math.min(page.width, page.height) < 64) say.warn('manifest.icon-page', `${icon.at} 的页面只有 ${page.width}×${page.height} pt：iOS 按 96 pt 光栅化图标、只缩不放，页面太小会画成一个点；照 Coda 自带图标按 256 px（192 pt）出图`);
    }
  });
  // Its panels, as the resources plugin reads what is written for its point: one it cannot read shows there as such.
  const panels = [];
  for (const entry of panelEntries(plugin.offers?.panels, plugin.displayName)) {
    if (entry.invalid) { say.fail('manifest.panels', `面板 ${entry.invalid.id}：${entry.invalid.error}（资源页上它只显示「声明无效」）`); continue; }
    const { panel } = entry;
    panels.push(panel);
    say.pass('manifest.panels', `面板 ${panel.id}「${panel.title}」：动作 ${Object.keys(panel.actions).join('、') || '无'}${panel.signIn ? '，可从 Coda 登录' : ''}`);
  }

  // What its processes are given (pluginEnv), on this machine: the plugins it depends on as Coda picks them (catalogAfter:
  // the one the machine has, else the one of the same commit installed with it). One Coda ships has its directory in Coda,
  // not here, unless this repository keeps its source (sameSource as Coda's), which stands in for it; one Coda has nowhere
  // (it refuses the plugin for it) is not named.
  const kept = id => { const at = siblings.get(id), shipped = builtin.get(id);
    return at && shipped && sameSource(shipped.source, { repo: repo.repo, path: at.path }) ? at.plugin.dir : undefined; };
  const local = catalogAfter(plugin, { catalog, siblings });
  const given = new Map([...[...local].map(([id, each]) => [id, each.dir ? each : { ...each, dir: kept(id) }]),
    [plugin.id, { ...plugin, dependencies: plugin.dependencies.filter(d => local.has(d)) }]]);
  const dependencies = Object.fromEntries(plugin.dependencies.flatMap(d => given.get(d)?.dir ? [[d, given.get(d).dir]] : []));
  if (plugin.dependencies.length) {
    const absent = plugin.dependencies.filter(d => !dependencies[d]);
    say.info('manifest.extensions', `依赖 ${plugin.dependencies.join('、')}：Coda 装它时先装它们（这台机器的插件，或同一提交里的兄弟目录），它的进程从 CODA_PLUGIN_DEPENDENCIES 拿到它们的目录${absent.length
      ? `；${absent.join('、')} 不在旁边，检查时不带` : ''}`);
  }
  commit();
  if (reached('source.npm') && refused !== 'source.npm' && plugin.npm?.length)
    say.pass('source.npm', `npm 依赖 ${plugin.npm.length} 个，带 package-lock.json：Coda 在插件的版本目录里 npm ci 装它们`);
  if (!refused) {
    const along = judged.together.map(each => each.from === 'source' ? `${each.id}（同一提交的 ${each.path}）` : `${each.id}（Coda 自带）`);
    say.pass('source.catalog', `与刚装好的 Coda 自带、默认装的插件不冲突${along.length ? `；一起装 ${along.join('、')}` : ''}`);
  }

  // Its settings for every project, as nobody has set any: the declarations' defaults.
  const settings = resolveSettings(plugin).values;
  // The model services of a machine with none, for one that chooses them; the PATH has no directories of Coda's own here.
  const env = stateDir => pluginEnv({ catalog: given, installed, id: plugin.id, stateDir: id => id === plugin.id ? stateDir : null, settings,
    providers: choosesModelProviders(plugin) ? {} : null, userPath: process.env.PATH ?? '' });
  return { id: plugin.id, manifest, plugin, agents: plugin.agents, panels, settings, dependencies, path: repo.top ? path : null, env };
}
