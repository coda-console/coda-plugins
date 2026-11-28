// 六个记忆工具的业务层。ctx 是 { projectId, repoDir, stateDir, settings, engine, now }：
// 写操作改当前工作树里的卡片；读操作先同步主分支索引，再在项目锁里把索引叠上工作树里未合并的草稿卡片。
import { withProjectLock } from './queue.mjs';
import { archiveCard, cardRelPath, linkCards, listWorktreeCards, loadDraftOverlay, normalizeMemoryDir, rememberCard } from './repo-cards.mjs';
import { ensureSyncedLocked, readSyncState, syncProjectLocked } from './sync.mjs';

const notFound = id => Object.assign(new Error(`卡片不存在：${id}`), { code: 'not_found' });
const memoryDirOf = ctx => ctx.settings?.memoryDir ?? '.memory';
const nowOf = ctx => ctx.now ?? new Date();

// 对外的卡片：正文叫 content。
const cardOut = ({ body, ...rest }) => ({ ...rest, content: body });

// ---- 写 ----

const writing = (ctx, fn) => withProjectLock(ctx.stateDir, ctx.projectId, () => fn(memoryDirOf(ctx), { now: nowOf(ctx) }));

export const remember = (ctx, input) => writing(ctx, async (dir, options) => {
  const { card, created, path } = await rememberCard(ctx.repoDir, dir, input, options);
  return { id: card.id, created, path, status: card.status, card: cardOut(card) };
});

export const link = (ctx, input) => writing(ctx, (dir, options) => linkCards(ctx.repoDir, dir, input, options));

export const archive = (ctx, input) => writing(ctx, async (dir, options) => {
  const { id } = await archiveCard(ctx.repoDir, dir, input, options);
  return { id, path: cardRelPath(dir, id), status: 'archived' };
});

// ---- 读 ----

// 在项目锁内同步：关了自动同步时只在没建过索引、索引丢了，或记忆目录、向量配置与索引建成时不一致才做一次本地同步；离线（拉不到远端）不算失败，同步本身不会因此抛错。
async function syncBeforeRead(ctx) {
  const { projectId, repoDir, stateDir, settings = {}, engine } = ctx;
  const options = { projectId, repoDir, stateDir, memoryDir: memoryDirOf(ctx), engine, now: nowOf(ctx) };
  if (settings.autoSync !== false) return ensureSyncedLocked({ ...options, lazySyncSeconds: settings.lazySyncSeconds });
  const dir = normalizeMemoryDir(options.memoryDir), state = await readSyncState(stateDir, projectId);
  if (!state?.indexedCommit || state.memoryDir !== dir || state.indexConfigKey !== engine.indexConfigKey(dir) || !await engine.storeExists()) {
    return syncProjectLocked({ ...options, fetchRemote: false });
  }
  return undefined;
}

// 当前视图：主分支索引里的卡片，叠上工作树的草稿（同 id 草稿覆盖，草稿删掉的 id 隐藏）。
async function buildView(ctx, includeDrafts) {
  const state = await readSyncState(ctx.stateDir, ctx.projectId);
  const indexedCommit = state?.indexedCommit ?? null;
  const cards = new Map(), mnemonToId = new Map();
  for (const [id, item] of state?.items ?? []) {
    cards.set(id, { card: item.card, draft: false, indexed: !!item.mnemonId });
    if (item.mnemonId) mnemonToId.set(item.mnemonId, id);
  }
  let draftCount = 0;
  if (includeDrafts) {
    const dir = memoryDirOf(ctx);
    const { drafts, deletedIds } = indexedCommit
      ? await loadDraftOverlay(ctx.repoDir, indexedCommit, dir)
      : { drafts: new Map((await listWorktreeCards(ctx.repoDir, dir)).map(card => [card.id, card])), deletedIds: new Set() };
    for (const id of deletedIds) cards.delete(id);
    for (const [id, card] of drafts) cards.set(id, { card, draft: true, indexed: false });
    draftCount = drafts.size;
  }
  // 引擎覆盖不到的卡片（草稿、已归档的）靠本地关键词匹配。
  const local = [...cards].filter(([, entry]) => !entry.indexed);
  return { cards, mnemonToId, indexedCommit, draftCount, hasIndex: mnemonToId.size > 0, local };
}

// 同步和读取在同一把项目锁里：读到的状态一定是刚同步完的，不会撞上别人半途失败留下的未完成状态。
// 数据库损坏（可重建的错误）时在同一把锁里作废已索引的提交、全量重建一次再重试；重试仍失败就抛出。
function read(ctx, includeDrafts, fn) {
  return withProjectLock(ctx.stateDir, ctx.projectId, async () => {
    try {
      await syncBeforeRead(ctx);
      return await fn(await buildView(ctx, includeDrafts));
    } catch (error) {
      if (error?.code !== 'index_corrupt') throw error;
      const { projectId, repoDir, stateDir, engine } = ctx;
      await syncProjectLocked({ projectId, repoDir, stateDir, memoryDir: memoryDirOf(ctx), engine, now: nowOf(ctx), forceRebuild: true });
      return fn(await buildView(ctx, includeDrafts));
    }
  });
}

// 对立的卡片 id：它指向的，加上别的未归档卡片指向它的。
function opposingIds({ cards }, id) {
  const ids = new Set(cards.get(id).card.contradicts.filter(other => cards.has(other)));
  for (const [other, { card }] of cards) if (other !== id && card.status !== 'archived' && card.contradicts.includes(id)) ids.add(other);
  return [...ids];
}

// 返回给调用方的一张卡片，自带对立条目。
function present(view, id, extra = {}) {
  const { card, draft } = view.cards.get(id);
  const contradictions = opposingIds(view, id).map(other => {
    const { card: opposing, draft: opposingDraft } = view.cards.get(other);
    return { id: other, status: opposing.status, content: opposing.body, refs: opposing.refs, draft: opposingDraft };
  });
  return { ...cardOut(card), draft, contradictions, ...extra };
}

// 轻量匹配：整句和各个词在正文、实体、标签里出现的比例；没命中是 0。
function keywordScore(card, query) {
  const haystack = [card.body, ...card.entities, ...card.tags].join('\n').toLowerCase();
  const lowered = query.trim().toLowerCase();
  const terms = [...new Set([lowered, ...lowered.split(/\s+/)])].filter(Boolean);
  return terms.filter(term => haystack.includes(term)).length / terms.length;
}

export const recall = (ctx, { query, intent = 'auto', limit = 10, includeSuperseded = false, includeDrafts = true }) => read(ctx, includeDrafts, async view => {
  const hits = new Map();
  const visible = (id, hit) => {
    const { status } = view.cards.get(id).card;
    return status !== 'archived' && (includeSuperseded || !(hit.superseded || status === 'superseded'));
  };
  if (view.hasIndex) {
    // 草稿覆盖、已取代的过滤在引擎之后做：有效结果不足而引擎返回数顶到请求上限时，窗口翻倍再查，直到凑满、到达索引总数或引擎耗尽。
    for (let window = Math.min(50, limit * 2); ; window = Math.min(window * 2, view.mnemonToId.size)) {
      hits.clear();
      const results = await ctx.engine.recall({ query, intent, limit: window });
      for (const hit of results) {
        const id = view.mnemonToId.get(hit.mnemonId);
        if (view.cards.get(id)?.indexed && !hits.has(id)) hits.set(id, { score: hit.score, matchedVia: hit.matchedVia, superseded: hit.superseded });
      }
      if ([...hits].filter(([id, hit]) => visible(id, hit)).length >= limit || results.length < window || window >= view.mnemonToId.size) break;
    }
  }
  for (const [id, { card }] of view.local) {
    const score = keywordScore(card, query);
    if (score && !hits.has(id)) hits.set(id, { score, matchedVia: 'keyword', superseded: false });
  }
  const items = [];
  for (const [id, hit] of hits) {
    if (visible(id, hit)) items.push(present(view, id, { score: hit.score, matchedVia: hit.matchedVia, superseded: hit.superseded || view.cards.get(id).card.status === 'superseded' }));
  }
  items.sort((a, b) => b.score - a.score);
  return { items: items.slice(0, limit), indexedCommit: view.indexedCommit, draftCount: view.draftCount };
});

export const search = (ctx, { query, kind, status, entity, tag, ref, limit = 20, includeDrafts = true }) => read(ctx, includeDrafts, async view => {
  const scores = new Map();
  if (query) {
    if (view.hasIndex) {
      // 过滤在引擎之后做，所以要拿全部命中，不能先截断。
      for (const hit of await ctx.engine.search({ query, limit: view.mnemonToId.size })) {
        const id = view.mnemonToId.get(hit.mnemonId);
        if (view.cards.get(id)?.indexed && !scores.has(id)) scores.set(id, hit.score);
      }
    }
    for (const [id, { card }] of view.local) {
      const score = keywordScore(card, query);
      if (score && !scores.has(id)) scores.set(id, score);
    }
  } else for (const id of view.cards.keys()) scores.set(id, undefined);
  const items = [];
  for (const [id, score] of scores) {
    const card = view.cards.get(id).card;
    if ((kind && card.kind !== kind) || (status ? card.status !== status : card.status === 'archived')
      || (entity && !card.entities.includes(entity)) || (tag && !card.tags.includes(tag)) || (ref && !card.refs.some(item => item.includes(ref)))) continue;
    items.push(present(view, id, query ? { score } : {}));
  }
  items.sort(query ? (a, b) => b.score - a.score : (a, b) => b.updated_at.localeCompare(a.updated_at));
  return { items: items.slice(0, limit), indexedCommit: view.indexedCommit };
});

export const get = (ctx, { id, includeDrafts = true }) => read(ctx, includeDrafts, async view => {
  const entry = view.cards.get(id);
  if (!entry) throw notFound(id);
  const summary = ids => ids.filter(other => view.cards.has(other)).map(other => {
    const { card } = view.cards.get(other);
    return { id: other, status: card.status, refs: card.refs };
  });
  const pointing = field => [...view.cards].filter(([, { card }]) => card[field].includes(id)).map(([other]) => other);
  const { card } = entry;
  return {
    card: present(view, id),
    draft: entry.draft,
    neighbors: {
      supersedes: summary(card.supersedes),
      supersededBy: summary(pointing('supersedes')),
      contradicts: summary(opposingIds(view, id)),
      related: summary([...new Set([...card.related, ...pointing('related')])]),
    },
    indexedCommit: view.indexedCommit,
  };
});
