// Plugins installed from a Git repository (docs/plugins.md「从仓库安装」) or from npm (「从 npm 安装」): where one comes from,
// as Coda keeps and shares it (a repository, a directory in it and the ref it follows, pinned to a commit; or a package, the
// tag it follows, pinned to a version and the integrity of its tarball), which directories of a commit are plugins, what a
// package is as a plugin, what a plugin from elsewhere may not be, and the npm packages it brings. Where the built-in
// plugins come from (「内置插件的来源」) is said the same way. Reading the repository or the registry is
// components/plugins/plugin-sources.mjs's.
import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { requireCondition as check } from '../../domain/errors.mjs';
import { offerPoint, offeredCommands, offerProblem, withDependencies } from './plugin-extensions.mjs';

export const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
// All of a plugin directory's files in its repository together; the npm packages installed beside them do not count.
export const SIZE_LIMIT = 10 * 1024 * 1024;
// The root of the repository and the directories at most this deep under it: `cursor`, `plugins/cursor`.
const DEPTH = 2;
// The npm packages a plugin's manifest may name, which Coda installs from its `package-lock.json`.
const NPM = ['dependencies', 'optionalDependencies'];

// The repository as Git is given it. `owner/repo` is GitHub's; an absolute path is this machine's (for trying a plugin
// out); anything else Git could run a command for (`ext::`, an option) is refused here, and Git is told so as well. An
// address carries no credentials: it is kept, shared with the space and shown to every client, and Git uses the ones the
// backend's account has.
export function repoAddress(input) {
  const value = typeof input === 'string' ? input.trim().replace(/(.)\/+$/, '$1') : '';
  check(value && value.length <= 500 && !/[\s\0]/.test(value) && !value.startsWith('-'), 'invalid_input', '需要仓库地址');
  check(!/^https:\/\/[^/]*@/i.test(value) && !/^ssh:\/\/[^/@]*:[^/@]*@/i.test(value), 'invalid_input', '仓库地址里不能带账号、密码或令牌：Git 用运行后端的账户已有的凭据');
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith('.')) return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  const github = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(\.git)?$/i.exec(value);
  if (github) return `https://github.com/${github[1]}.git`;
  if (/^(https|ssh):\/\/[^/\s]+\/./.test(value) || /^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^/:\\]/.test(value) || value.startsWith('/')) return value;
  check(false, 'invalid_input', '仓库地址只能是 https://、ssh://、git@主机:路径、owner/repo 或本机的绝对路径');
}
// A plugin's ID as a URL names it: its package name (components/plugins/plugin-rules.mjs), also the name of its version directories.
export function pluginId(id) {
  check(typeof id === 'string' && ID.test(id), 'invalid_input', '插件 ID 只能用小写字母、数字和「-」，以字母开头');
  return id;
}
// A branch, a tag or a commit; empty is the repository's default branch.
export function sourceRef(input = '') {
  const value = typeof input === 'string' ? input.trim() : null;
  check(value !== null && (value === '' || (value.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(value) && !/^[-/]|\/$|\.\.|\/\/|\.lock$/.test(value))),
    'invalid_input', '版本只能是分支、标签或提交号');
  return value;
}
// A directory of the repository: its root (''), or at most DEPTH names under it.
export function sourcePath(input = '') {
  const parts = typeof input === 'string' ? input.split('/').filter(Boolean) : null;
  check(parts && parts.length <= DEPTH && parts.every(p => SEGMENT.test(p) && p !== '.' && p !== '..'), 'invalid_input', `插件目录须在仓库根下 ${DEPTH} 层以内`);
  return parts.join('/');
}
// A source as a client sends it, as Coda keeps it, and as a space shares it.
export function checkSource(raw) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'invalid_input', '来源须为对象');
  if (raw.kind === 'npm') return npmSource(raw);
  const extra = Object.keys(raw).filter(k => !['kind', 'repo', 'path', 'ref', 'commit', 'previous'].includes(k));
  check(!extra.length, 'invalid_input', `来源里有不支持的键：${extra.join('、')}`);
  check(raw.kind === undefined || raw.kind === 'git', 'invalid_input', '来源只能是 Git 仓库或 npm 包');
  check(typeof raw.commit === 'string' && COMMIT.test(raw.commit), 'invalid_input', '来源须钉在一个提交上（40 位提交号）');
  check(raw.previous == null || (typeof raw.previous === 'string' && COMMIT.test(raw.previous)), 'invalid_input', '上一个版本须为 40 位提交号');
  return { kind: 'git', repo: repoAddress(raw.repo), path: sourcePath(raw.path ?? ''), ref: sourceRef(raw.ref ?? ''), commit: raw.commit,
    ...(raw.previous && raw.previous !== raw.commit ? { previous: raw.previous } : {}) };
}
// Which repository an address is, whatever way it is written: GitHub's by owner and name in any case and over any
// transport (`owner/repo`, `https://`, `git@github.com:`, `ssh://`), any other by its address without a trailing `.git`.
export function repoIdentity(repo) {
  const github = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(repo);
  return github ? `github.com/${github[1].toLowerCase()}` : repo.replace(/\.git$/, '');
}
// Whether two sources name the same package, at whatever version, or the same directory of the same repository, at whatever
// commit: a built-in plugin and a version of it from where it comes from. A built-in package's copy names both, the
// directory being the one its package says it is published from (components/plugins/plugin-rules.mjs dependencyPlugins).
export const sameSource = (a, b) => !!a?.package && a.package === b?.package
  || !!(a?.repo && b?.repo) && repoIdentity(a.repo) === repoIdentity(b.repo) && (a.path ?? '') === (b.path ?? '');
// Installed again from the same directory, another commit keeps the one it replaces as `previous`, so that going back is
// installing that one (the two change places); the same commit again (a retry) keeps what it had. From another
// repository or directory there is nothing to go back to. A package the same, by its versions.
export function nextSource(prior, source) {
  const { previous, ...next } = source;
  if (next.kind === 'npm') {
    if (prior?.kind !== 'npm' || prior.package !== next.package) return next;
    if (prior.integrity === next.integrity) return prior.previous ? { ...next, previous: prior.previous } : next;
    return { ...next, previous: { version: prior.version, integrity: prior.integrity } };
  }
  if (prior?.kind !== 'git' || prior.repo !== next.repo || prior.path !== next.path) return next;
  if (prior.commit === next.commit) return prior.previous ? { ...next, previous: prior.previous } : next;
  return { ...next, previous: prior.commit };
}

// Whether a plugin was installed from elsewhere than Coda's own copies: a repository or npm.
export const fromElsewhere = source => source?.kind === 'git' || source?.kind === 'npm';
// What names the version of a source on this machine, and its version directory: a repository's commit, or for a package
// the integrity of its tarball, which names that tarball and no other. The one it had before likewise (`previousKey`).
export const versionKey = source => source.kind === 'npm' ? createHash('sha256').update(source.integrity).digest('hex').slice(0, 40) : source.commit;
export const previousKey = source => !source.previous ? null : source.kind === 'npm' ? versionKey({ kind: 'npm', integrity: source.previous.integrity }) : source.previous;

// ---- npm ----
// A package as npm names it (`name`, `@scope/name`) and the version of it wanted: one version, a dist-tag, or (empty) the
// one its `latest` tag names.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
export const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const npmName = name => {
  check(typeof name === 'string' && name.length <= 214 && NPM_NAME.test(name), 'invalid_input', 'npm 包名只能是 name 或 @scope/name（小写字母、数字和「-._~」）');
  return name;
};
export function npmSpec(input) {
  const value = typeof input === 'string' ? input.trim() : '', at = value.indexOf('@', value.startsWith('@') ? 1 : 0);
  const wanted = at < 0 ? '' : value.slice(at + 1);
  check(wanted === '' || NPM_VERSION.test(wanted) || NPM_TAG.test(wanted), 'invalid_input', '包名后面只能跟一个版本号或标签，如 @1.2.0、@next');
  return { package: npmName(at < 0 ? value : value.slice(0, at)), wanted };
}
// The tag a package installed as `wanted` follows for its updates: the one named, or `latest` for a version.
export const npmTag = wanted => !wanted || NPM_VERSION.test(wanted) ? 'latest' : wanted;
// Whether version `a` comes before `b`, as semver orders them: by major, minor and patch, a pre-release before its release,
// pre-releases by their dot-separated parts (numbers below words, numbers by value); build metadata does not count.
export function versionBefore(a, b) {
  const parse = version => { const [core, pre] = version.split('+')[0].split(/-(.*)/s); return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i];
  if (!x.pre.length || !y.pre.length) return x.pre.length > 0 && !y.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined;
    if (p === q) continue;
    const m = /^\d+$/.test(p), n = /^\d+$/.test(q);
    return m && n ? Number(p) < Number(q) : m !== n ? m : p < q;
  }
  return false;
}
// The plugin a package is installed as: its ID made of its name (a scoped one's with its scope: `@acme/kit` is `acme-kit`).
export function npmPluginId(name) {
  const id = name.replace(/^@/, '').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?=[^a-z])/, 'npm-');
  return pluginId(id.slice(0, 40).replace(/-+$/, ''));
}
function npmSource(raw) {
  const extra = Object.keys(raw).filter(k => !['kind', 'package', 'tag', 'version', 'integrity', 'previous'].includes(k));
  check(!extra.length, 'invalid_input', `来源里有不支持的键：${extra.join('、')}`);
  const pinned = (at, what) => {
    check(at && typeof at.version === 'string' && NPM_VERSION.test(at.version), 'invalid_input', `${what}须钉在一个版本号上`);
    check(typeof at.integrity === 'string' && INTEGRITY.test(at.integrity), 'invalid_input', `${what}须带包的 sha512 完整性摘要`);
    return { version: at.version, integrity: at.integrity };
  };
  const tag = raw.tag ?? 'latest', at = pinned(raw, 'npm 来源'), previous = raw.previous == null ? null : pinned(raw.previous, '上一个版本');
  check(typeof tag === 'string' && NPM_TAG.test(tag), 'invalid_input', '跟随的标签只能是字母开头的标签名');
  return { kind: 'npm', package: npmName(raw.package), tag, ...at, ...(previous && previous.integrity !== at.integrity ? { previous } : {}) };
}
// What a package without a manifest of Coda's is as a plugin (docs/plugins.md「从 npm 安装」), written beside it as the
// version directory's package.json, the package as npm has it under `package/`: its Agent Skills (directories with a
// SKILL.md at its root or in its `skills/`, `skills`), and the MCP server it says it is (`mcpName`, which the MCP Registry
// asks of a server's package), run from its `bin` by the backend's Node, named after the package without its scope (the
// scope itself for one called only that: `@playwright/mcp` is `playwright`). Why not, for a package that is neither.
export function npmManifest(id, own, skills) {
  const contributes = {}, [, scope = '', unscoped = ''] = /^(?:@([^/]+)\/)?(.*)$/.exec(String(own.name));
  if (skills.length) contributes.skills = skills.map(skill => `package/${skill}`);
  if (typeof own.mcpName === 'string' && own.mcpName) {
    const bins = typeof own.bin === 'string' ? { [unscoped]: own.bin } : own.bin && typeof own.bin === 'object' && !Array.isArray(own.bin) ? own.bin : {};
    const names = Object.keys(bins), chosen = names.length === 1 ? names[0] : names.find(name => name === unscoped);
    if (!chosen) return { problem: names.length ? `它有 ${names.length} 个 bin（${names.join('、')}），读不出哪个是 MCP 服务器` : '它写了 mcpName，却没有 bin：读不出怎么启动这个 MCP 服务器' };
    const file = typeof bins[chosen] === 'string' ? normalize(bins[chosen]).replace(/^\.\//, '') : '';
    if (!file || file.startsWith('/') || file.split('/').includes('..')) return { problem: `bin ${chosen} 不是包里的文件` };
    const named = scope && ['mcp', 'server', 'mcp-server'].includes(unscoped) ? scope : unscoped;
    const server = (named.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?=[^a-z])/, 'mcp-').slice(0, 40).replace(/-+$/, '') || 'mcp').replace(/^coda$/, 'coda-mcp');
    contributes.mcpServers = { [server]: { command: '${CODA_NODE}', args: [`\${CODA_PLUGIN_PATH}/package/${file}`] } };
  }
  if (!Object.keys(contributes).length) return { problem: '这个 npm 包读不成插件：package.json 没有 contributes，没有 Skill 目录，也不是写了 mcpName 的 MCP 服务器' };
  return { manifest: { name: id, displayName: own.name, description: typeof own.description === 'string' ? own.description.slice(0, 500) : '',
    version: String(own.version ?? ''), contributes } };
}
// The packages npm installs for a package from npm, by name with the range it asks for: its dependencies are not pinned
// (docs/plugins.md「从 npm 安装」), unless it brings an `npm-shrinkwrap.json`, whose versions they then are. Among them the
// peers it needs (`peerDependencies` not marked optional), which npm installs with it: a package may need nothing else.
export function npmRanges(own, shrinkwrap) {
  const peers = own?.peerDependencies && typeof own.peerDependencies === 'object' && !Array.isArray(own.peerDependencies) ? own.peerDependencies : {};
  const named = { ...own, dependencies: { ...Object.fromEntries(Object.entries(peers).filter(([name]) => own.peerDependenciesMeta?.[name]?.optional !== true)),
    ...own?.dependencies } };
  return npmPackages(named, shrinkwrap).map(each => shrinkwrap ? each : { ...each, range: true });
}

// ---- What a commit holds ----
// The directories of a commit (its files' paths, `git ls-tree -r --name-only`) that may be plugins: those with a
// `package.json`, at the root and DEPTH under it; which of them are is said by their manifests (`contributes`).
export function candidates(names) {
  return [...new Set(names.filter(name => name === 'package.json' || name.endsWith('/package.json')).map(name => name.slice(0, -'package.json'.length).replace(/\/$/, ''))
    .filter(dir => { const parts = dir ? dir.split('/') : []; return parts.length <= DEPTH && !parts.includes('node_modules'); }))].sort();
}
// The directories of a commit that hold Agent Skills with nothing to say they are a plugin's (docs/plugins.md「只有 Skills
// 的目录」): one whose own subdirectories have a SKILL.md, at the root and DEPTH under it, not in a plugin's directory
// (`plugins`, those whose manifests say what they contribute). Each is a plugin of those Skills.
export function skillDirectories(names, plugins) {
  const dirs = new Set();
  for (const name of names) {
    const parts = name.split('/');
    if (parts.length < 2 || parts.at(-1) !== 'SKILL.md' || parts.includes('node_modules')) continue;
    const dir = parts.slice(0, -2).join('/');
    if ((dir ? dir.split('/').length : 0) <= DEPTH) dirs.add(dir);
  }
  return [...dirs].filter(dir => !plugins.some(plugin => plugin === '' || dir === plugin || dir.startsWith(`${plugin}/`))).sort();
}
// What a directory of Skills says of itself as a plugin, written beside them as it is read and installed: named after the
// repository (and the directory, below its root; one called `skills` is its parent's), each subdirectory with a SKILL.md
// one Skill (`skills`, their names).
export function skillsManifest(repo, path, skills) {
  const repoName = repo.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
  const parts = path ? path.split('/') : [];
  if (parts.at(-1) === 'skills') parts.pop();
  const label = [repoName, ...parts.slice(-1)];
  const id = label.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?=[^a-z])/, 'skills-').slice(0, 40).replace(/-+$/, '');
  return { name: id, displayName: label.join('/'), description: `${skills.length} 个 Skill`, version: '',
    contributes: { skills: skills.map(name => name) } };
}
// Why a directory's files (`git ls-tree -r -l`: mode, type and size of each) cannot be a plugin's, or null. A link may
// point anywhere on the machine that takes it, and a submodule is another repository.
export function treeProblem(entries) {
  const link = entries.find(e => e.mode === '120000'), module = entries.find(e => e.mode === '160000');
  if (link) return `目录里有符号链接：${link.name}`;
  if (module) return `目录里有子模块：${module.name}`;
  return entries.reduce((sum, e) => sum + (Number(e.size) || 0), 0) > SIZE_LIMIT ? `整个目录超过 ${SIZE_LIMIT / 1024 / 1024} MiB` : null;
}
// The npm packages a manifest names (`dependencies`, `optionalDependencies`), by name: the version range it asks for, and
// whether a machine may go without it (a package for another platform).
const npmNamed = manifest => Object.fromEntries(NPM.flatMap(key => manifest?.[key] && typeof manifest[key] === 'object' && !Array.isArray(manifest[key])
  ? Object.entries(manifest[key]).map(([name, range]) => [name, { range, optional: key === 'optionalDependencies' }]) : []));
// Why a manifest that reads as a plugin's still cannot come from a repository, or null. The npm packages it names are
// installed from its lock (the `package-lock.json` beside it; `lock` is null without one), which must be there and name
// the same: installing them asks nothing of anyone.
export function manifestProblem(manifest, lock) {
  const named = npmNamed(manifest);
  if (!Object.keys(named).length) return null;
  if (lock === null) return '带 npm 依赖却没有 package-lock.json：在插件目录里运行 npm install 生成它';
  const root = lock?.packages?.[''];
  if (!root || typeof root !== 'object') return 'package-lock.json 读不懂：须由 npm 7 以上生成（lockfileVersion 2 或 3）';
  const locked = npmNamed(root), differ = [...new Set([...Object.keys(named), ...Object.keys(locked)])]
    .filter(name => named[name]?.range !== locked[name]?.range || named[name]?.optional !== locked[name]?.optional);
  return differ.length ? `package-lock.json 与 package.json 的依赖不一致（${differ.join('、')}）：在插件目录里运行 npm install 更新它` : null;
}
// What installing it takes from npm, as the confirmation lists it: each package the manifest names, at the version its lock
// pins (the range asked for where the lock pins none), and whether a machine may go without it.
export function npmPackages(manifest, lock) {
  return Object.entries(npmNamed(manifest)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, { range, optional }]) => {
    const version = lock?.packages?.[`node_modules/${name}`]?.version;
    return { name, version: typeof version === 'string' ? version : String(range), ...(optional ? { optional: true } : {}) };
  });
}
// An installed built-in plugin (including an update from its own source) reserves its ID. Uninstalling frees the name;
// an installed replacement from another source keeps it across refreshes and updates.
export function builtinProblem(id, source, builtin, installed) {
  const copy = builtin.get(id), row = installed.get(id);
  if (!copy || !row || sameSource(copy.source, source)) return null;
  if (fromElsewhere(row.source) && !sameSource(copy.source, row.source)) return null;
  return `与内置插件 ${id} 同名${copy.source?.repo || copy.source?.package ? '，来源不同' : ''}，请先卸载内置插件再安装`;
}
// What only one plugin may declare, as said to the user: an agent (sessions name it by its ID alone), a concurrency group
// (any process takes it by its name), Git's credentials for an address, opening a kind of reference (a view's `handles`),
// a composer mode's name and the character typed to enter one (the composer finds it by them)
// and a key of `contributes` a point takes. A command, as a Skill or a variable, is a
// project's: one two plugins of a project bring is neither's there (components/plugins/plugins.mjs launch).
export const claims = plugin => [...plugin.agents.map(a => `Agent ${a.id}`), ...plugin.groups.map(g => `组 ${g.name}`),
  ...(plugin.gitCredentials ?? []).map(c => `${c.url} 的 Git 凭据`), ...(plugin.views ?? []).flatMap(v => (v.handles ?? []).map(kind => `打开 ${kind} 引用`)),
  ...(plugin.composerModes ?? []).flatMap(m => [`输入框模式 /${m.id}`, ...(m.trigger ? [`输入框里打 ${m.trigger} 进入的模式`] : [])]),
  ...Object.values(plugin.extensionPoints ?? {}).filter(p => p.contributes).map(p => `扩展点 contributes.${p.contributes}`)];
// Why a plugin cannot sit beside those this machine has (`catalog`: built-in and installed, by ID; `builtin`: the plugins
// Coda ships, by ID), or null: an installed built-in one's ID from another source (builtinProblem), or an agent, a group
// or Git's credentials for an address another plugin declares. What it needs of the others — the plugins it depends on,
// the points it plugs into or writes for (plugin-extensions.mjs offerProblem) — is checked once all of them are there.
export function catalogProblem(plugin, catalog, builtin, installed) {
  const named = builtinProblem(plugin.id, plugin.source, builtin, installed);
  if (named) return named;
  // Clients do not list a plugin's Git credentials in the confirmation yet: only one Coda ships may bring them.
  if (plugin.gitCredentials?.length && plugin.source?.kind !== 'builtin') return '只有 Coda 自带的插件能提供 Git 凭据';
  // Nor the command that lists repositories to choose from.
  if (plugin.repositories && plugin.source?.kind !== 'builtin') return '只有 Coda 自带的插件能提供仓库列表';
  for (const claim of claims(plugin)) {
    const owner = [...catalog.values()].find(p => p.id !== plugin.id && claims(p).includes(claim));
    if (owner) return `${claim} 已由插件 ${owner.displayName} 声明`;
  }
  return null;
}
// What installing a plugin from a repository brings along, in the order installing does it (components/plugins/plugin-extensions.mjs
// withDependencies, as components/plugins/plugins.mjs installFrom): what this version of it needs, directly or through another,
// and this machine has not installed; each found among this machine's plugins (`builtin`: one Coda ships, not installed),
// else in another directory of the same commit (`source`, `siblings`: ID → { path, plugin }), else nowhere (`missing`).
// What each found one brings is confirmed with it.
export function together(plugin, { catalog, installed, siblings }) {
  const id = plugin.id, known = new Map([...[...siblings].map(([sibling, at]) => [sibling, at.plugin]), ...catalog, [id, plugin]]);
  const after = catalogAfter(plugin, { catalog, siblings });
  const shown = plugin => ({ displayName: plugin.displayName, contributes: contributions(plugin, after) });
  return withDependencies(known, id).filter(each => each !== id && !(installed.has(each) && catalog.has(each)))
    .map(each => catalog.has(each) ? { id: each, from: 'builtin', ...shown(catalog.get(each)) }
      : siblings.has(each) ? { id: each, from: 'source', path: siblings.get(each).path, ...shown(siblings.get(each).plugin) } : { id: each, from: 'missing' });
}
// The catalog once a plugin from a source is installed: this machine's, what of the same commit is installed with it
// (what it needs, directly or through another, as together finds it), and it. Not the other plugins of the commit: what
// it and those write for points is confirmed as the points installed say.
export function catalogAfter(plugin, { catalog, siblings }) {
  const known = new Map([...[...siblings].map(([sibling, at]) => [sibling, at.plugin]), ...catalog, [plugin.id, plugin]]);
  const along = withDependencies(known, plugin.id).filter(each => each !== plugin.id && !catalog.has(each) && siblings.has(each));
  return new Map([...catalog, ...along.map(each => [each, siblings.get(each).plugin]), [plugin.id, plugin]]);
}
// What installing it brings, as the confirmation lists it: every command it runs, word for word (those it plugs into
// another plugin's points too, which that plugin runs — those it writes for a point under a key of `contributes`, where
// the point says, the catalog beside it (`catalog`) declaring it —, those it puts on every session's PATH, those
// answering clients' requests, and the one that makes each
// machine ready for it, run as it is installed or updated), the groups it brings,
// what it calls its workflows and capabilities, how many settings, and what it tells every agent.
export function contributions(plugin, catalog = new Map()) {
  const offers = Object.entries(plugin.offers ?? {}).flatMap(([key, raw]) => {
    const found = offerPoint(new Map([...catalog, [plugin.id, plugin]]), key);
    return found ? [{ plugin: found.plugin.id, point: found.point, title: found.declared.title, ...offeredCommands(raw, found.declared) }] : [];
  });
  return {
    // The Agent Skills it lays into the projects it applies to, by name; the variables it gives what starts there, each
    // with its value as written, and the directories it puts on their PATH.
    ...(plugin.skills?.length ? { skills: plugin.skills.map(s => s.name),
      skillDescriptions: Object.fromEntries(plugin.skills.filter(s => s.description).map(s => [s.name, s.description])) } : {}),
    ...(plugin.environment?.length ? { environment: plugin.environment.map(({ name, value }) => ({ name, value })) } : {}),
    ...(plugin.path?.length ? { path: plugin.path } : {}),
    agents: plugin.agents.map(a => ({ id: a.id, displayName: a.displayName, command: a.command })),
    commands: plugin.commands.map(c => ({ name: c.name, command: c.command })),
    ...(plugin.endpoints?.length ? { endpoints: plugin.endpoints.map(e => ({ id: e.id, command: e.command, ...(e.checks ? { checks: e.checks } : {}) })) } : {}),
    // The MCP servers its projects' agents start, word for word: what they run and the variables they are given as written.
    ...(plugin.mcpServers?.length ? { mcpServers: plugin.mcpServers.map(({ name, command, args, env }) => ({ name, command, args, env })) } : {}),
    // Its module the plugin host runs (docs/plugins.md「插件宿主」): code of its own in Coda's Node on this machine.
    ...(plugin.main ? { main: plugin.main } : {}),
    // The pages it opens in the clients, by name, with where they stay and their icon there: they run in the client's
    // sandbox, not as commands here.
    ...(plugin.views?.length ? { views: plugin.views.map(v => ({ id: v.id, title: v.title, ...(v.in ? { in: v.in } : {}), ...(v.icon ? { icon: v.icon } : {}), ...(v.handles ? { handles: v.handles } : {}), ...(v.readout ? { readout: v.readout } : {}),
      ...(v.checkout ? { checkout: v.checkout } : {}) })) } : {}),
    groups: plugin.groups.map(g => ({ name: g.name, capacity: g.capacity })),
    // The modes it puts the composer in, as declared: the clients show them from this.
    ...(plugin.composerModes?.length ? { composerModes: plugin.composerModes.map(({ schema: _, ...mode }) => mode) } : {}),
    extensions: plugin.extensions.map(e => ({ plugin: e.plugin, point: e.point, command: e.command })),
    // What it writes for points under keys of `contributes` (the resources plugin's panels): by point, how many and the
    // commands in them, each with what it is for.
    ...(offers.length ? { offers } : {}),
    ...(plugin.setup ? { setup: { command: plugin.setup.command } } : {}),
    workflows: plugin.workflows, capabilities: plugin.capabilities, settings: Object.keys(plugin.properties).length,
    ...(plugin.instructions ? { instructions: plugin.instructions } : {}),
    // What each machine installs for it from npm, as read from its repository (components/plugins/plugin-sources.mjs inspect).
    ...(plugin.npm?.length ? { npm: plugin.npm } : {}),
  };
}
// The ID a manifest says its plugin has, as readPlugin takes it (not checked): its `id`, or its package name.
export const manifestId = manifest => manifest?.id ?? manifest?.name;

// One plugin of a source as its reading lists it, said against what this machine has (`known`: the catalog, the installed
// rows, the built-in plugins): what it is, the one of its ID installed here, why it cannot be installed, what comes along
// with it (`siblings`: the other plugins of the same commit, by ID) and what it brings. `manifest`: what is known of it
// when it does not read as a plugin, its ID `fallback` without a name.
export function candidate({ path, manifest, plugin, problem, fallback }, { catalog, installed, builtin }, siblings) {
  const id = plugin?.id ?? (typeof manifestId(manifest) === 'string' ? manifestId(manifest) : fallback);
  const row = installed.get(id), along = plugin ? together(plugin, { catalog, installed, siblings }) : [];
  const missing = along.filter(each => each.from === 'missing').map(each => each.id);
  // What this machine has once it is installed, those installed with it among them: the points it may write for.
  const after = plugin ? catalogAfter(plugin, { catalog, siblings }) : catalog;
  return { path, id, displayName: plugin?.displayName ?? (typeof manifest?.displayName === 'string' ? manifest.displayName : id),
    description: plugin?.description ?? (typeof manifest?.description === 'string' ? manifest.description : ''), version: plugin?.version ?? '',
    installed: row ? row.source ?? builtin.get(id)?.source ?? { kind: 'builtin' } : null,
    problem: problem ?? (plugin ? catalogProblem(plugin, catalog, builtin, installed) ?? offerProblem(plugin, after) : null)
      ?? (missing.length ? `要一起装的 ${missing.join('、')} 不在这台机器上${plugin.source?.kind === 'npm' ? '' : '，也不在这个提交里'}` : null),
    together: along.filter(each => each.from !== 'missing'),
    ...(plugin ? { contributes: contributions(plugin, after) } : {}) };
}
