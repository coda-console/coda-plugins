// The agents a plugin brings (docs/plugins.md「Agent」): who each is, how the clients draw it, and how Coda starts its
// process, which speaks ACP with Coda's waits (docs/agent-protocol.md). Nothing here knows any agent by name: Codex and
// Claude are plugins like any other.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { requireCondition as check } from '../../domain/errors.mjs';
import { AGENT_ID } from '../../domain/values.mjs';

export const ICON_LIMIT = 32 * 1024;
const NAME = 40, MODE_TITLE = 10, MODE_UNSET = 20, MODE_NOTE = 100, HINT = 200, COMMAND = 4000, CONFIG_FILES = 16, PATH = 1000;
const code = 'invalid_plugin';
const keys = (value, allowed, where) => {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  check(!extra.length, code, `${where} 里有 Coda 不支持的键：${extra.join('、')}`);
};
const object = (value, where) => check(value && typeof value === 'object' && !Array.isArray(value), code, `${where} 须为对象`);
const line = (value, max, where) => {
  check(typeof value === 'string' && value.trim() && [...value].length <= max && !/[\0\r\n]/.test(value), code, `${where} 须为不超过 ${max} 字的一行文本`);
  return value;
};
const optional = (value, max, where) => value === undefined ? undefined : line(value, max, where);
// A path inside the plugin's directory or the working copy: relative, and never leaving it.
const inside = (value, where, { segments = Infinity } = {}) => {
  line(value, PATH, where);
  const path = normalize(value);
  check(!isAbsolute(value) && path !== '..' && !path.startsWith(`..${sep}`) && path.split(sep).length <= segments, code,
    `${where} 须为不离开所在目录的相对路径${Number.isFinite(segments) ? `，至多 ${segments} 段` : ''}`);
  return path;
};
// An icon file, read once with the plugin: a PDF both clients draw as they drew the brand artwork they shipped with.
function icon(dir, value, where) {
  const path = inside(value, where);
  let data;
  try { data = readFileSync(join(dir, path)); } catch (e) { check(false, code, `${where} 读不到：${e.message}`); }
  check(data.length <= ICON_LIMIT, code, `${where} 超过 ${ICON_LIMIT / 1024} KiB`);
  check(data.subarray(0, 5).toString('latin1') === '%PDF-', code, `${where} 须为 PDF`);
  return data.toString('base64');
}

function declaration(raw, where, dir) {
  object(raw, where);
  keys(raw, ['id', 'displayName', 'icon', 'command', 'modes', 'skillsDir', 'configFiles', 'setupHint'], where);
  check(typeof raw.id === 'string' && AGENT_ID.test(raw.id), code, `${where} 的 id 只能用小写字母、数字和「-」，以字母开头，至多 40 个字符`);
  const at = `Agent ${raw.id}`;
  object(raw.icon, `${at} 的 icon`);
  keys(raw.icon, ['light', 'dark', 'template'], `${at} 的 icon`);
  check(raw.icon.template === undefined || typeof raw.icon.template === 'boolean', code, `${at} 的 icon.template 须为开或关`);
  const modes = raw.modes ?? {};
  object(modes, `${at} 的 modes`);
  keys(modes, ['title', 'unset', 'note', 'auto', 'full'], `${at} 的 modes`);
  check(raw.configFiles === undefined || (Array.isArray(raw.configFiles) && raw.configFiles.length <= CONFIG_FILES), code,
    `${at} 的 configFiles 须为至多 ${CONFIG_FILES} 项的数组`);
  return {
    id: raw.id, displayName: line(raw.displayName, NAME, `${at} 的 displayName`),
    icon: { light: icon(dir, raw.icon.light, `${at} 的 icon.light`),
      ...(raw.icon.dark !== undefined ? { dark: icon(dir, raw.icon.dark, `${at} 的 icon.dark`) } : {}), template: raw.icon.template === true },
    command: line(raw.command, COMMAND, `${at} 的 command`),
    modes: Object.fromEntries([['title', MODE_TITLE], ['unset', MODE_UNSET], ['note', MODE_NOTE], ['auto', 200], ['full', 200]]
      .filter(([key]) => modes[key] !== undefined).map(([key, max]) => [key, line(modes[key], max, `${at} 的 modes.${key}`)])),
    ...(raw.skillsDir !== undefined ? { skillsDir: inside(raw.skillsDir, `${at} 的 skillsDir`, { segments: 3 }) } : {}),
    configFiles: (raw.configFiles ?? []).map((file, i) => line(file, PATH, `${at} 的 configFiles[${i}]`)),
    ...(raw.setupHint !== undefined ? { setupHint: optional(raw.setupHint, HINT, `${at} 的 setupHint`) } : {}),
  };
}
// `contributes.agents` of the plugin in `dir`.
export function agentDeclarations(raw, dir) {
  if (raw === undefined) return [];
  check(Array.isArray(raw), code, 'contributes.agents 须为数组');
  const agents = raw.map((a, i) => declaration(a, `contributes.agents[${i}]`, dir));
  check(new Set(agents.map(a => a.id)).size === agents.length, code, 'contributes.agents 里有重复的 id');
  return agents;
}

// A configuration file an agent reads its models from, as its plugin names it: `~/` is the home directory, `${VAR}` and
// `${VAR:-default}` the backend's environment (a variable empty and without a default leaves the file out), and a relative
// path is the project's.
export function configFile(spec, { env, home, root }) {
  let empty = false;
  const expanded = spec.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const value = env[name];
    if (value) return value;
    if (fallback === undefined) { empty = true; return ''; }
    return fallback;
  });
  if (empty || !expanded) return null;
  const path = expanded === '~' ? home : expanded.startsWith('~/') ? join(home, expanded.slice(2)) : expanded;
  return isAbsolute(path) ? path : join(root, path);
}
