// 把主分支的卡片同步进检索索引：对着默认分支的提交读（不碰工作区），已索引的提交没变就什么都不做，
// 祖先关系成立时按差异增量更新，否则全量重建。每个项目的同步串行执行。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CARD_EXT, RELATIONS } from './definitions.mjs';
import { projectDir, withProjectLock } from './queue.mjs';
import { diffCardsBetweenCommits, listCardPathsAtCommit, normalizeMemoryDir, readCardAtCommit, resolveDefaultBranch } from './repo-cards.mjs';

const run = promisify(execFile);
const STATE_FILE = 'sync-state.json';
const stateFile = (stateDir, projectId) => join(projectDir(stateDir, projectId), STATE_FILE);
// 内存里的 items 是 Map：卡片 id 可以是 __proto__ 这类名字，放进普通对象会丢。文件里仍是普通对象。
const emptyState = memoryDir => ({ version: 1, memoryDir, indexedCommit: null, lastCheckedAt: null, items: new Map() });

async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return state?.version === 1 ? { ...state, items: new Map(Object.entries(state.items)) } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

// 读取同步状态（没建过返回 null）；写入只在项目锁内，读到的总是完整的一份。
export const readSyncState = (stateDir, projectId) => readState(stateFile(stateDir, projectId));

// 同目录临时文件加 rename，读的人看不到写了一半的状态。
async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...state, items: Object.fromEntries(state.items) }), 'utf8');
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

const gitOut = async (repoDir, args) => (await run('git', args, { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 })).stdout.trim();

// 默认分支的名字：origin/HEAD 指向的；没有它就问远端（ls-remote --symref）；问不到再用已有的 origin/main、origin/master、
// 本地 main、master；都没有就是 main。
async function defaultBranchName(repoDir) {
  const head = await gitOut(repoDir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (head) return head.replace(/^refs\/remotes\/origin\//, '');
  const remote = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(await gitOut(repoDir, ['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => ''));
  if (remote) return remote[1];
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (await gitOut(repoDir, ['rev-parse', '--verify', '-q', ref]).catch(() => '')) return ref.replace(/^refs\/(?:remotes\/origin|heads)\//, '');
  }
  return 'main';
}

// 只更新远端跟踪分支：refspec 写死成 refs/remotes/origin/<分支>，--refmap= 让配置里的 remote.origin.fetch
// （可能把远端分支映射到本地 refs/heads/*）一概不参与，工作区和本地分支不会被动。失败（没有 origin、网络不通）返回原因，不抛。
export async function fetchOrigin(repoDir) {
  try {
    const branch = await defaultBranchName(repoDir);
    await gitOut(repoDir, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--refmap=', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return null;
  } catch (error) {
    return String(error.stderr ?? '').trim() || error.message;
  }
}

// 仓库还没有任何提交：resolveDefaultBranch 抛的就是这个；别的错误（不是仓库、git 起不来）照常抛。
async function defaultCommit(repoDir) {
  try { return (await resolveDefaultBranch(repoDir)).commit; } catch (error) {
    if (error.message.startsWith('找不到默认分支')) return null;
    throw error;
  }
}

// 增量：删掉的、归档的卡片 forget；新增和改过的先 forget 旧的再 remember；再补这些卡片的出边和指向它们的入边。
async function applyIncremental({ repoDir, commit, engine, items, diff }) {
  const rebuilt = new Set();
  const forget = async id => {
    const old = items.get(id);
    if (old?.mnemonId) await engine.forget(old.mnemonId);
  };
  for (const path of diff.deleted) {
    const id = basename(path, CARD_EXT);
    await forget(id);
    items.delete(id);
  }
  for (const path of [...diff.added, ...diff.modified]) {
    const card = await readCardAtCommit(repoDir, commit, path);
    await forget(card.id);
    const mnemonId = card.status === 'archived' ? null : await engine.remember(card);
    items.set(card.id, { mnemonId, path, card });
    if (mnemonId) rebuilt.add(card.id);
  }
  // 把这次重建的卡片相关的关系（出边和指向它们的入边）交给引擎，怎么落成边由引擎决定。
  const relations = [], mnemonIds = new Map();
  for (const { mnemonId, card } of items.values()) {
    if (!mnemonId) continue;
    mnemonIds.set(card.id, mnemonId);
    for (const relation of RELATIONS) for (const to of card[relation]) relations.push({ from: card.id, to, relation });
  }
  await engine.linkCards(relations.filter(({ from, to }) => rebuilt.has(from) || rebuilt.has(to)), mnemonIds);
}

// 全量：重置索引，读出提交里的全部卡片，非归档的批量导入；归档的只留元数据。
async function applyRebuild({ repoDir, commit, memoryDir, engine, items }) {
  const cards = [];
  for (const path of await listCardPathsAtCommit(repoDir, commit, memoryDir)) cards.push({ path, card: await readCardAtCommit(repoDir, commit, path) });
  await engine.resetStore();
  const ids = await engine.importCards(cards.filter(({ card }) => card.status !== 'archived').map(({ card }) => card));
  for (const { path, card } of cards) items.set(card.id, { mnemonId: ids.get(card.id) ?? null, path, card });
}

// 在项目锁内执行。
async function runSync({ projectId, repoDir, stateDir, memoryDir, engine, fetchRemote, forceRebuild, now }) {
  const file = stateFile(stateDir, projectId);
  const state = await readState(file) ?? emptyState(memoryDir);
  const result = {};
  if (fetchRemote) {
    const fetchError = await fetchOrigin(repoDir);
    if (fetchError) result.fetchError = fetchError;
  }
  const commit = await defaultCommit(repoDir);
  if (!commit) {
    await writeState(file, { ...state, indexedCommit: null });
    await engine.resetStore();
    await writeState(file, { ...emptyState(memoryDir), lastCheckedAt: now.toISOString() });
    return { ...result, action: 'empty' };
  }
  const hasStore = await engine.storeExists();
  if (!forceRebuild && state.indexedCommit === commit && state.memoryDir === memoryDir && hasStore) {
    await writeState(file, { ...state, lastCheckedAt: now.toISOString() });
    return { ...result, action: 'noop', commit };
  }

  const incremental = !forceRebuild && state.indexedCommit && state.memoryDir === memoryDir && hasStore;
  const diff = incremental ? await diffCardsBetweenCommits(repoDir, state.indexedCommit, commit, memoryDir) : { mode: 'rebuild' };
  const items = diff.mode === 'incremental' ? structuredClone(state.items) : new Map();
  // 动索引之前先落盘「未完成」：中途失败或进程被杀，下一次都从头重建，不会拿着旧的有效提交去信一个半成品索引。
  await writeState(file, { ...state, indexedCommit: null });
  if (diff.mode === 'incremental') await applyIncremental({ repoDir, commit, engine, items, diff });
  else await applyRebuild({ repoDir, commit, memoryDir, engine, items });
  await writeState(file, { version: 1, memoryDir, indexedCommit: commit, lastCheckedAt: now.toISOString(), items });
  return { ...result, action: diff.mode === 'incremental' ? 'incremental' : 'rebuild', commit, indexed: [...items.values()].filter(item => item.mnemonId).length };
}

// 已在项目锁内（withProjectLock 不可重入）时用 Locked 版本；不带 Locked 的自己持锁。
const normalized = ({ memoryDir = '.memory', fetchRemote = false, forceRebuild = false, now = new Date(), ...rest }) => ({ ...rest, memoryDir: normalizeMemoryDir(memoryDir), fetchRemote, forceRebuild, now });

export const syncProjectLocked = options => runSync(normalized(options));

export function syncProject(options) {
  const checked = normalized(options);
  return withProjectLock(checked.stateDir, checked.projectId, () => runSync(checked));
}

// 读取前的惰性同步（判断和同步在同一把项目锁里，不会拿着别人正在重建的旧状态做判断）：
// 没建过索引立即同步；节流期内本地默认分支没动、索引也在就直接返回；动了或索引没了只同步不拉远端；过了节流期带远端拉取同步。
export async function ensureSyncedLocked({ lazySyncSeconds = 60, ...options }) {
  const { projectId, repoDir, stateDir, memoryDir, engine, forceRebuild, now } = normalized(options);
  const sync = fetchRemote => runSync({ projectId, repoDir, stateDir, memoryDir, engine, fetchRemote, forceRebuild, now });
  const state = await readState(stateFile(stateDir, projectId));
  if (!state?.indexedCommit) return sync(true);
  if (!forceRebuild && now - new Date(state.lastCheckedAt) < lazySyncSeconds * 1000) {
    const commit = await defaultCommit(repoDir);
    if (commit === state.indexedCommit && state.memoryDir === memoryDir && await engine.storeExists()) return { action: 'throttled', commit };
    return sync(false);
  }
  return sync(true);
}

export function ensureSynced(options) {
  return withProjectLock(options.stateDir, options.projectId, () => ensureSyncedLocked(options));
}
