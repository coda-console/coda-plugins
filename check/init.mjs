// `coda-plugin-check init <目录> [--template module|agent|resource]`: a template copied into a new directory, named after it.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATES = ['module', 'agent', 'resource'];
const ROOT = fileURLToPath(new URL('../templates', import.meta.url));
// A plugin ID: the directory's name is the plugin's.
const ID = /^[a-z][a-z0-9-]{0,39}$/;

// Copies `template` into `target` (absent or empty), and says the plugin's `name`, the protocol prefix of the module template's
// `<name>/note@1` and the domain of its event `note_<name>.added` (event names are one machine's: `_` for `-`), the directory's.
// Returns the plugin ID.
export function init(target, template) {
  if (!TEMPLATES.includes(template)) throw new Error(`没有模板「${template}」，可选 ${TEMPLATES.join('、')}`);
  const dir = resolve(target), id = basename(dir);
  if (!ID.test(id)) throw new Error(`目录名「${id}」要作插件 ID：小写字母开头，只用小写字母、数字和 -，至多 40 个字符`);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length)) throw new Error(`${target} 不是空目录，不往里复制`);
  const source = join(ROOT, template);
  const was = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name;
  cpSync(source, dir, { recursive: true, filter: path => basename(path) !== 'node_modules' });
  for (const file of ['package.json', 'package-lock.json', 'main.mjs', 'test/main.test.mjs']) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8').replaceAll(`${was}/note@1`, `${id}/note@1`).replaceAll(`note_${was}.added`, `note_${id.replaceAll('-', '_')}.added`);
    if (!file.endsWith('.json')) { writeFileSync(path, text); continue; }
    const json = JSON.parse(text);
    json.name = id;
    if (json.packages?.['']) json.packages[''].name = id;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
  return id;
}
