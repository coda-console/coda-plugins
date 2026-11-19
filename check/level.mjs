// The API Level a plugin needs, reckoned from what it uses (check/coda/api-surface.txt: every item Coda offers plugins, with the
// Level it came in) against its `engines.coda`. What the manifest and its protocols name is certain; what is read from the text of
// its files (`coda.<member>`, `ctx.<member>`, `window.coda.<member>`) may be a misreading, and is only remarked on.
// Also lists the trial surface it uses: the permission groups and module interfaces that may change from one Coda to the next.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { wantedLevel } from './coda/components/plugins/plugin-extensions.mjs';

// The lines of a surface (check/coda/api-surface.txt) as item → Level.
export const parseSurface = text => new Map(text.split('\n').flatMap(line => { const match = /^(\d+) (.+)$/.exec(line); return match ? [[match[2], Number(match[1])]] : []; }));
const SURFACE = parseSurface(readFileSync(new URL('./coda/api-surface.txt', import.meta.url), 'utf8'));

// The source files of a directory by their paths in it, but what npm installed and Git keeps.
function files(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : files(dir, path);
    return entry.isFile() ? [path] : [];
  });
}
function scan(dir, views, surface) {
  const items = new Set();
  for (const path of files(dir)) {
    const script = ['.mjs', '.js'].includes(extname(path));
    if (!script && !views.has(path)) continue;
    const text = readFileSync(join(dir, path), 'utf8');
    for (const [, name] of text.matchAll(/\bwindow\.coda\.(\w+)/g)) if (surface.has(`bridge window.coda.${name}`)) items.add(`bridge window.coda.${name}`);
    if (!script) continue;
    // The deepest member of `coda` the surface has: `coda.settings.get`, else `coda.settings`.
    for (const [, name, sub] of text.matchAll(/(?<!window\.)\bcoda\.(\w+)(?:\.(\w+))?/g))
      for (const item of [`module coda.${name}.${sub}`, `module coda.${name}`]) if (surface.has(item)) { items.add(item); break; }
    for (const [, name] of text.matchAll(/\bctx\.(\w+)/g)) if (surface.has(`module ctx.${name}`)) items.add(`module ctx.${name}`);
  }
  return items;
}
// What the manifest names: its keys, their keys under them, and what a protocol's `uses` and its own definitions are made of.
function named({ manifest, plugin }, surface) {
  const items = new Set();
  for (const [key, value] of Object.entries(manifest)) {
    items.add(`manifest ${key}`);
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const sub of Object.keys(value)) items.add(`manifest ${key}.${sub}`);
  }
  for (const [kind, groups] of Object.entries(plugin.uses ?? {})) { items.add(kind); for (const group of groups) items.add(`${kind} ${group}`); }
  for (const definition of plugin.protocols ?? []) {
    for (const key of Object.keys(definition)) items.add(`definition ${key}`);
    for (const section of ['permissions', 'operations', 'events', 'streams'])
      for (const entry of Object.values(definition[section] ?? {})) for (const key of Object.keys(entry)) items.add(`definition ${section}.${key}`);
  }
  return [...items].filter(item => surface.has(item));
}

// `checked`: the plugin as the manifest level read it. `say`: the manifest level's; `note`: the notes'. `surface`: the items and
// their Levels, as this Coda has them unless given.
export function checkLevel({ checked, say, note, surface = SURFACE }) {
  const { plugin } = checked;
  const certain = named(checked, surface), read = [...scan(plugin.dir, new Set(plugin.views.map(view => view.entry)), surface)];
  const highest = items => items.reduce((top, item) => !top || surface.get(item) > surface.get(top) ? item : top, null);
  const written = wantedLevel(plugin.engines) ?? undefined, top = highest([...certain, ...read]);
  const need = top ? surface.get(top) : 0;
  if (written === undefined) say.warn('manifest.level', `没写 engines.coda：用到的项最高 Level ${need}${top ? `（${top}）` : ''}，该写 "engines": { "coda": ${need} }`);
  else {
    const short = highest(certain.filter(item => surface.get(item) > written));
    if (short) say.fail('manifest.level', `用到 ${short}（Level ${surface.get(short)}），engines.coda 至少写 ${surface.get(short)}（现写 ${written}）`);
    for (const item of read.filter(item => surface.get(item) > written)) say.warn('manifest.level-text', `文件里出现 ${item}（Level ${surface.get(item)}），engines.coda 写 ${written}：扫描文本得来，可能认错；没错的话至少写 ${surface.get(item)}`);
    if (!short && !read.some(item => surface.get(item) > written)) say.pass('manifest.level', `engines.coda ${written}，用到的项最高 Level ${need}`);
  }
  for (const [kind, groups] of Object.entries(plugin.uses ?? {}))
    for (const group of groups) if (checked.definitionOf(kind)?.permissions?.[group]?.trial) note.info('note.trial', `用到试行面：${kind} 的权限组 ${group}，随 Coda 版本可能变`);
  for (const item of [...certain, ...read].filter(item => item.startsWith('module '))) note.info('note.trial', `用到试行面：模块接口 ${item.slice('module '.length)}，随 Coda 版本可能变`);
}
