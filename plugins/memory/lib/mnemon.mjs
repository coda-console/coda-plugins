// 检索引擎：对 mnemon v0.2.15 命令行的封装。业务层只见卡片和卡片关系，mnemon 的参数、枚举和输出都收在这里。
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { RELATIONS } from './definitions.mjs';

const run = promisify(execFile);

const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };

// mnemonPath 设置 → <stateDir>/bin/mnemon（setup 装的）→ PATH 里的 mnemon。
export function resolveMnemonBin({ mnemonPath, stateDir, env = process.env } = {}) {
  const candidates = [
    mnemonPath,
    stateDir && join(stateDir, 'bin', 'mnemon'),
    ...String(env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'mnemon')),
  ].filter(Boolean);
  const found = candidates.find(executable);
  if (found) return found;
  throw Object.assign(new Error('找不到 mnemon：请在插件设置里填写 mnemon 路径，或重新运行插件的安装步骤（会把 mnemon v0.2.15 装到插件状态目录），或把 mnemon 放进 PATH'), { code: 'mnemon_missing' });
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NO_EMBED_ENDPOINT = 'http://127.0.0.1:1';

// 构造 mnemon 的环境变量：不修剪；向量服务按设置配好，none 时指向一个必然拒绝连接的本地端口，
// mnemon 立即得到连接拒绝，而不是对每条记忆等一次探测超时。密钥只从环境变量读，不记录、不落盘。
export function buildMnemonEnv(settings = {}, env = process.env) {
  const out = { ...env, MNEMON_MAX_INSIGHTS: '0' };
  const put = (name, value) => { if (value) out[name] = value; else delete out[name]; };
  const provider = settings.embeddingProvider || 'none';
  if (provider === 'none') {
    out.MNEMON_EMBED_ENDPOINT = NO_EMBED_ENDPOINT;
    for (const name of ['MNEMON_EMBED_PROTOCOL', 'MNEMON_EMBED_MODEL', 'MNEMON_EMBED_API_KEY']) delete out[name];
  } else if (provider === 'ollama') {
    out.MNEMON_EMBED_PROTOCOL = 'ollama';
    put('MNEMON_EMBED_ENDPOINT', settings.embeddingBaseUrl);
    put('MNEMON_EMBED_MODEL', settings.embeddingModel);
    delete out.MNEMON_EMBED_API_KEY;
  } else if (provider === 'openai-compatible') {
    out.MNEMON_EMBED_PROTOCOL = 'openai';
    put('MNEMON_EMBED_ENDPOINT', settings.embeddingBaseUrl);
    put('MNEMON_EMBED_MODEL', settings.embeddingModel);
    const keyEnv = settings.embeddingApiKeyEnv;
    put('MNEMON_EMBED_API_KEY', typeof keyEnv === 'string' && ENV_NAME.test(keyEnv) ? env[keyEnv] : undefined);
  } else {
    throw new Error(`embeddingProvider 必须是 none、ollama、openai-compatible 之一：${JSON.stringify(provider)}`);
  }
  return out;
}

// 卡片种类 → mnemon 的类别；关系 → mnemon 的边类型（及要附的元数据）。
const CATEGORIES = { fact: 'fact', conclusion: 'insight', hypothesis: 'context', observation: 'insight' };
export const mnemonCategory = kind => {
  if (!(kind in CATEGORIES)) throw new Error(`未知的卡片种类：${JSON.stringify(kind)}`);
  return CATEGORIES[kind];
};
// 矛盾和相关在 mnemon 里都是 semantic 边：同一对端点上两者并存时合并成一条边的元数据，不能后写覆盖先写。
// relations 是一个关系，或同一对端点上的多个关系。
export function mnemonEdge(relations) {
  const list = RELATIONS.filter(relation => [relations].flat().includes(relation));
  if (!list.length) throw new Error(`未知的关系：${JSON.stringify(relations)}`);
  if (list.includes('supersedes')) {
    if (list.length > 1) throw new Error('supersedes 不能与别的关系合并');
    return { type: 'supersedes' };
  }
  return { type: 'semantic', meta: list.length === 1 ? { relation: list[0] } : { relations: list } };
}

// 关系列表 [{ from, to, relation }]（from、to 是卡片 id）归并成边：supersedes 按方向各一条；矛盾、相关按无序的一对端点
// 合并成一条，relations 列出这一对上的全部关系。全量导入和增量 link 共用这一条规则。
export function mergeRelations(list) {
  const groups = new Map();
  for (const { from, to, relation } of list) {
    const key = relation === 'supersedes' ? `>${from}>${to}` : `~${[from, to].sort().join('~')}`;
    if (!groups.has(key)) groups.set(key, { from, to, relations: new Set() });
    groups.get(key).relations.add(relation);
  }
  return [...groups.values()].map(({ from, to, relations }) => ({ from, to, relations: RELATIONS.filter(relation => relations.has(relation)) }));
}

// 标签、实体是逗号分隔的参数，项内的逗号换成空格。
const csv = items => items.map(item => item.replaceAll(',', ' ')).join(',');
const STORE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export class MnemonEngine {
  // dataDir 是这个项目自己的 mnemon 数据目录；store 落在 <dataDir>/data/<storeName>。env 用 buildMnemonEnv 构造。
  constructor({ bin, dataDir, storeName = 'default', env = process.env }) {
    if (!STORE_NAME.test(storeName)) throw new Error(`storeName 不合法：${JSON.stringify(storeName)}`);
    Object.assign(this, { bin, dataDir, storeName, env });
  }

  get storeDir() { return join(this.dataDir, 'data', this.storeName); }

  async #run(command, flags, positional = []) {
    const args = [command, '--data-dir', this.dataDir, '--store', this.storeName, ...flags, ...(positional.length ? ['--', ...positional] : [])];
    let stdout;
    try {
      ({ stdout } = await run(this.bin, args, { env: this.env, maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
      throw new Error(`mnemon ${command} 失败：${String(error.stderr ?? '').trim() || error.message}`);
    }
    try { return JSON.parse(stdout); } catch { throw new Error(`mnemon ${command} 的输出不是 JSON：${stdout.slice(0, 200)}`); }
  }

  // 以数据库文件为准：目录在、文件没有（被删、上次没写成）不算有索引；探测本身出错（如没有权限）照常抛。
  async storeExists() {
    try { return (await stat(join(this.storeDir, 'mnemon.db'))).isFile(); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  }

  // 写入一张卡片，返回 mnemon 里的 id。
  async remember(card) {
    const flags = ['--no-diff', '--cat', mnemonCategory(card.kind), '--imp', String(card.importance)];
    if (card.tags.length) flags.push('--tags', csv(card.tags));
    if (card.entities.length) flags.push('--entities', csv(card.entities));
    flags.push('--source', card.id);
    const out = await this.#run('remember', flags, [card.body]);
    return out.action === 'skipped' ? out.replaced_id : out.id;
  }

  // 把一批关系 [{ from, to, relation }] 补成边；两端都要在 mnemonIds（卡片 id → mnemon id）里。
  async linkCards(relations, mnemonIds) {
    const known = relations.filter(({ from, to }) => mnemonIds.has(from) && mnemonIds.has(to));
    for (const { from, to, relations: merged } of mergeRelations(known)) await this.link(mnemonIds.get(from), mnemonIds.get(to), merged);
  }

  async link(fromMnemonId, toMnemonId, relations) {
    const { type, meta } = mnemonEdge(relations);
    await this.#run('link', ['--type', type, ...(meta ? ['--meta', JSON.stringify(meta)] : [])], [fromMnemonId, toMnemonId]);
  }

  async forget(mnemonId) {
    await this.#run('forget', [], [mnemonId]);
  }

  // 批量导入，返回 Map<卡片 id, mnemon id>；边只带两端都在这批里的关系。
  async importCards(cards) {
    const map = new Map();
    if (!cards.length) return map;
    const index = new Map(cards.map((card, i) => [card.id, i]));
    // mnemon 的 link 对无向的 semantic 边写两个方向，导入也一样。
    const relations = cards.flatMap(card => RELATIONS.flatMap(relation => card[relation].filter(to => index.has(to)).map(to => ({ from: card.id, to, relation }))));
    const edges = mergeRelations(relations).flatMap(({ from, to, relations }) => {
      const { type } = mnemonEdge(relations), edge = { source_index: index.get(from), target_index: index.get(to), edge_type: type, reason: relations.join(',') };
      return type === 'supersedes' ? [edge] : [edge, { ...edge, source_index: edge.target_index, target_index: edge.source_index }];
    });
    const draft = {
      schema_version: '1',
      insights: cards.map(card => ({
        content: card.body, category: mnemonCategory(card.kind), importance: card.importance,
        tags: card.tags, entities: card.entities, source: card.id, created_at: card.created_at,
      })),
      edges,
    };
    const dir = await mkdtemp(join(tmpdir(), 'memory-import-'));
    try {
      const file = join(dir, 'draft.json');
      await writeFile(file, JSON.stringify(draft), { mode: 0o600 });
      const { results } = await this.#run('import', ['--no-diff'], [file]);
      const failed = results.filter(result => result.error);
      if (failed.length || results.length !== cards.length) throw new Error(`mnemon import 没有全部导入：${failed.map(result => result.error).join('；') || `${results.length}/${cards.length}`}`);
      for (const result of results) map.set(cards[result.index].id, result.id);
      return map;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async recall({ query, intent = 'auto', limit = 10 }) {
    const flags = ['--limit', String(limit), ...(intent !== 'auto' ? ['--intent', intent.toUpperCase()] : [])];
    const { results } = await this.#run('recall', flags, [query]);
    return results.map(r => ({ mnemonId: r.id, score: r.score, intent: r.intent, matchedVia: r.matched_via, superseded: !!r.superseded }));
  }

  async search({ query, limit = 20 }) {
    const results = await this.#run('search', ['--limit', String(limit)], [query]);
    return results.map(r => ({ mnemonId: r.id, score: r.score }));
  }

  // 删掉这个项目的 store，全量重建用。
  async resetStore() {
    await rm(this.storeDir, { recursive: true, force: true });
  }
}
