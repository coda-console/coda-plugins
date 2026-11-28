// 测试用的假 mnemon：按 v0.2.15 的命令行约定解析参数，把洞见和边存在 <data-dir>/data/<store>/mnemon.db，
// 并把每次调用记进 <data-dir>/calls.jsonl；输出的 JSON 字段与真 mnemon 一致。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const flags = {}, positional = [];
const VALUE_FLAGS = new Set(['data-dir', 'store', 'cat', 'imp', 'tags', 'entities', 'source', 'type', 'meta', 'limit', 'intent']);
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--') { positional.push(...rest.slice(i + 1)); break; }
  if (rest[i].startsWith('--')) {
    const name = rest[i].slice(2);
    flags[name] = VALUE_FLAGS.has(name) ? rest[++i] : true;
  } else positional.push(rest[i]);
}
const fail = message => { console.error(`Error: ${message}`); process.exit(1); };
const dir = join(flags['data-dir'], 'data', flags.store);
mkdirSync(dir, { recursive: true });
const dbFile = join(dir, 'mnemon.db');
// 真 mnemon 打开损坏的 SQLite 文件时的报错。
const load = () => { try { return JSON.parse(readFileSync(dbFile, 'utf8')); } catch { return fail('file is not a database'); } };
const db = existsSync(dbFile) ? load() : { next: 1, insights: {}, edges: [] };
const save = () => writeFileSync(dbFile, JSON.stringify(db));
const out = value => console.log(JSON.stringify(value, null, 2));
const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'];
const EDGE_TYPES = ['temporal', 'semantic', 'causal', 'entity', 'supersedes'];
const add = fields => {
  const id = `m${db.next++}`;
  db.insights[id] = { id, deleted: false, ...fields };
  return id;
};
const active = () => Object.values(db.insights).filter(insight => !insight.deleted);

appendFileSync(join(flags['data-dir'], 'calls.jsonl'), `${JSON.stringify({ command, args: rest, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MNEMON_'))) })}\n`);
if (process.env.FAKE_MNEMON_FAIL === command) fail(process.env.FAKE_MNEMON_FAIL_MESSAGE ?? `${command} 被要求失败`);

if (command === 'remember') {
  if (!CATEGORIES.includes(flags.cat)) fail(`invalid category ${flags.cat}`);
  if (process.env.FAKE_MNEMON_SKIP) out({ id: 'new', action: 'skipped', replaced_id: 'old' });
  else {
    const id = add({ content: positional.join(' '), cat: flags.cat, imp: Number(flags.imp), tags: flags.tags ?? '', entities: flags.entities ?? '', source: flags.source });
    save();
    out({ id, content: positional.join(' '), action: 'added' });
  }
} else if (command === 'link') {
  const [from, to] = positional;
  if (!db.insights[from]) fail(`source insight ${from} not found`);
  if (!db.insights[to]) fail(`target insight ${to} not found`);
  if (!EDGE_TYPES.includes(flags.type)) fail(`invalid edge type ${flags.type}`);
  // 真 mnemon 的 --meta 在 Go 侧解析为 map[string]string，数组、数字等非字符串值会报错。
  let meta = {};
  if (flags.meta) {
    try { meta = JSON.parse(flags.meta); } catch { fail(`invalid --meta ${flags.meta}`); }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.values(meta).some(value => typeof value !== 'string')) fail('invalid --meta: values must be strings');
  }
  db.edges.push({ from, to, type: flags.type, meta });
  save();
  out({ status: 'linked' });
} else if (command === 'forget') {
  const [id] = positional;
  if (!db.insights[id] || db.insights[id].deleted) fail(`forget: insight ${id} not found`);
  db.insights[id].deleted = true;
  save();
  out({ id, status: 'deleted' });
} else if (command === 'import') {
  const draft = JSON.parse(readFileSync(positional[0], 'utf8'));
  if (draft.schema_version !== '1') fail('unsupported schema_version');
  const ids = draft.insights.map(item => {
    if (!CATEGORIES.includes(item.category)) fail(`invalid category ${item.category}`);
    return add({ content: item.content, cat: item.category, imp: item.importance, tags: (item.tags ?? []).join(','), entities: (item.entities ?? []).join(','), source: item.source });
  });
  for (const edge of draft.edges ?? []) db.edges.push({ from: ids[edge.source_index], to: ids[edge.target_index], type: edge.edge_type, meta: { reason: edge.reason } });
  save();
  appendFileSync(join(flags['data-dir'], 'imports.jsonl'), `${JSON.stringify({ file: positional[0], draft })}\n`);
  out({ imported: ids.length, results: ids.map((id, index) => ({ index, id, content: draft.insights[index].content, action: 'added' })) });
} else if (command === 'recall') {
  const query = positional.join(' ');
  const superseded = new Set(db.edges.filter(edge => edge.type === 'supersedes').map(edge => edge.to));
  const results = active().filter(insight => insight.content.includes(query)).slice(0, Number(flags.limit))
    .map(insight => ({ id: insight.id, content: insight.content, intent: flags.intent ?? 'GENERAL', matched_via: 'keyword', confidence: 'high', score: 0.5, ...(superseded.has(insight.id) ? { superseded: true } : {}) }));
  out({ results });
} else if (command === 'search') {
  const query = positional.join(' ');
  out(active().filter(insight => insight.content.includes(query)).slice(0, Number(flags.limit)).map(insight => ({ id: insight.id, content: insight.content, score: 1.5 })));
} else fail(`unknown command ${command}`);
