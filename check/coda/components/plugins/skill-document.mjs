// Read-only documents of the same plugin copy the catalog gives agents: its Skills (docs/plugins.md「Skills」) and its README
// (docs/plugins.md「插件页」).
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { parse } from 'yaml';
import { requireCondition as check } from '../../domain/errors.mjs';

export function skillDocument(content) {
  const header = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  let description = '';
  if (header) {
    try {
      const fields = parse(header[1], { maxAliasCount: 20, logLevel: 'silent' });
      if (typeof fields?.description === 'string') description = fields.description.trim();
    } catch { /* Invalid metadata must not hide the original document. */ }
  }
  return { content, description, metadata: header?.[1] ?? '', markdown: header ? content.slice(header[0].length) : content };
}

export function readSkillDocument(plugin, name) {
  const skill = plugin?.skills?.find(skill => skill.name === name);
  check(skill, 'not_found', `没有 Skill ${plugin?.id ?? ''}/${name}`);
  try {
    const path = realpathSync(join(skill.path, 'SKILL.md'));
    const within = relative(realpathSync(plugin.dir), path);
    check(within && within !== '..' && !within.startsWith('../') && !isAbsolute(within), 'not_found', 'Skill 文件不在插件目录里');
    const file = statSync(path);
    check(file.isFile() && file.size <= 2 * 1024 * 1024, 'invalid_skill', 'Skill 文件须为不超过 2 MiB 的文本');
    return { plugin: plugin.id, displayName: plugin.displayName, version: plugin.version, source: plugin.source,
      name: skill.name, ...skillDocument(readFileSync(path, 'utf8')) };
  } catch (error) {
    check(!['ENOENT', 'ENOTDIR'].includes(error.code), 'not_found', '找不到 SKILL.md，插件可能已更新或卸载。');
    check(!['EACCES', 'EPERM'].includes(error.code), 'invalid_skill', '无法读取这个 Skill 的文件。');
    throw error;
  }
}

// A plugin's README as its page shows it, from its own directory (never through a link out of it): empty without one.
export function readPluginReadme(plugin, file) {
  const said = { plugin: plugin.id, displayName: plugin.displayName, version: plugin.version };
  if (!file) return { ...said, markdown: '' };
  try {
    const path = realpathSync(file), within = relative(realpathSync(plugin.dir), path);
    check(within && within !== '..' && !within.startsWith('../') && !isAbsolute(within), 'not_found', 'README 不在插件目录里');
    const found = statSync(path);
    check(found.isFile() && found.size <= README_LIMIT, 'invalid_plugin', 'README 须为不超过 1 MiB 的文本');
    return { ...said, markdown: readFileSync(path, 'utf8') };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { ...said, markdown: '' };
    check(!['EACCES', 'EPERM'].includes(error.code), 'invalid_plugin', '无法读取这个插件的 README。');
    throw error;
  }
}
export const README_LIMIT = 1024 * 1024;
