// 仓库里的卡片：工作树里的读写（<worktree>/<memoryDir>/items/<id>.md），以及只读的 git 读取（不 checkout、不动工作区）。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertId, newId, normalizeCard, parseCard, serializeCard, stringList } from './card.mjs';
import { CARD_EXT, ITEMS_DIR } from './definitions.mjs';

const run = promisify(execFile);
// GIT_LITERAL_PATHSPECS：目录名里的 `:`、`*` 等按字面处理，不当 pathspec 魔法。
const git = async (repoDir, args, env) => (await run('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoDir, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env }, maxBuffer: 256 * 1024 * 1024 })).stdout;
// 命令以 expected 里的退出码结束算正常，返回退出码和输出；别的（含 git 起不来）照常抛出。
async function gitExit(repoDir, args, expected = [0, 1]) {
  try { return { code: 0, stdout: await git(repoDir, args) }; } catch (error) {
    if (typeof error.code === 'number' && expected.includes(error.code)) return { code: error.code, stdout: error.stdout };
    throw error;
  }
}

// memoryDir 只能是仓库内的相对目录。
export function normalizeMemoryDir(memoryDir) {
  if (typeof memoryDir !== 'string' || !memoryDir.trim() || memoryDir.includes('\\') || posix.isAbsolute(memoryDir)) throw new Error(`memoryDir 必须是仓库内的相对目录：${JSON.stringify(memoryDir)}`);
  const dir = posix.normalize(memoryDir.trim()).replace(/\/+$/, '');
  if (dir === '.' || dir === '..' || dir.startsWith('../')) throw new Error(`memoryDir 必须是仓库内的相对目录：${JSON.stringify(memoryDir)}`);
  return dir;
}
const itemsPath = memoryDir => posix.join(normalizeMemoryDir(memoryDir), ITEMS_DIR);
export const cardRelPath = (memoryDir, id) => posix.join(itemsPath(memoryDir), `${assertId(id)}${CARD_EXT}`);
const isCardPath = (memoryDir, path) => posix.dirname(path) === itemsPath(memoryDir) && path.endsWith(CARD_EXT);
const idOfPath = path => basename(path, CARD_EXT);

function parseNamed(text, path) {
  let card;
  try { card = parseCard(text); } catch (error) { throw new Error(`${path}：${error.message}`); }
  if (card.id !== idOfPath(path)) throw new Error(`${path}：文件名与卡片 id ${card.id} 不一致`);
  return card;
}

// 最深的已存在祖先的真实路径必须在仓库里：记忆目录是指向仓库外的链接时，读写都拒绝。
async function assertInsideRepo(worktreeDir, memoryDir) {
  const root = await realpath(worktreeDir);
  let probe = join(worktreeDir, itemsPath(memoryDir)), real;
  for (;;) {
    try { real = await realpath(probe); break; } catch (error) {
      if (error.code !== 'ENOENT' || probe === dirname(probe)) throw error;
      probe = dirname(probe);
    }
  }
  const rel = relative(root, real);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`记忆目录指向仓库之外：${normalizeMemoryDir(memoryDir)}`);
}

// 卡片必须是普通文件，符号链接一律拒绝；不存在返回 null。
async function readCardFile(file, path) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new Error(`${path}：卡片必须是普通文件，不能是符号链接或目录`);
  return readFile(file, 'utf8');
}

export async function readCardFromWorktree(worktreeDir, memoryDir, id) {
  const path = cardRelPath(memoryDir, id);
  await assertInsideRepo(worktreeDir, memoryDir);
  const text = await readCardFile(join(worktreeDir, path), path);
  return text === null ? null : parseNamed(text, path);
}

export async function listWorktreeCards(worktreeDir, memoryDir) {
  const dir = itemsPath(memoryDir);
  await assertInsideRepo(worktreeDir, memoryDir);
  let names;
  try { names = await readdir(join(worktreeDir, dir)); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const cards = [];
  for (const name of names.filter(name => name.endsWith(CARD_EXT)).sort()) {
    const path = posix.join(dir, name), text = await readCardFile(join(worktreeDir, dir, name), path);
    if (text !== null) cards.push(parseNamed(text, path));
  }
  return cards;
}

// 同目录临时文件加 rename，读的人看不到写了一半的卡片。
export async function writeCardToWorktree(worktreeDir, memoryDir, card) {
  const path = cardRelPath(memoryDir, card.id), file = join(worktreeDir, path);
  const text = serializeCard(card);
  await assertInsideRepo(worktreeDir, memoryDir);
  await readCardFile(file, path);
  await mkdir(join(worktreeDir, itemsPath(memoryDir)), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return path;
}

const union = (a, b) => [...new Set([...a, ...b])];
const iso = now => now.toISOString();
// 对卡片做一次修改；有字段真的变了才返回新卡片（并刷新 updated_at），没变返回 null。
function changed(card, now, mutate) {
  const next = structuredClone(card);
  mutate(next);
  if (JSON.stringify(next) === JSON.stringify(card)) return null;
  next.updated_at = iso(now);
  return next;
}
const without = (items, id) => items.filter(item => item !== id);
// 不再有矛盾边的 contested 卡片回到 active。
const settle = card => { if (card.status === 'contested' && !card.contradicts.length) card.status = 'active'; };

async function saveAll(worktreeDir, memoryDir, cards) {
  for (const card of cards) await writeCardToWorktree(worktreeDir, memoryDir, card);
  return cards.map(card => card.id);
}

export async function rememberCard(worktreeDir, memoryDir, input, { now = new Date() } = {}) {
  if (input.appendToId !== undefined) {
    if (input.content !== undefined) throw new Error('appendToId 只合并来源、实体和标签，不改正文，不能同时给 content');
    const refs = stringList(input.refs, 'refs', { required: true });
    const target = await readCardFromWorktree(worktreeDir, memoryDir, input.appendToId);
    if (!target) throw new Error(`要补充的卡片不存在：${input.appendToId}`);
    if (target.status === 'archived') throw new Error(`要补充的卡片已归档：${input.appendToId}`);
    // 即使来源已都在，也刷新 updated_at 并落盘。
    const next = {
      ...target,
      refs: stringList([...target.refs, ...refs], 'refs'),
      entities: stringList([...target.entities, ...stringList(input.entities, 'entities')], 'entities'),
      tags: stringList([...target.tags, ...stringList(input.tags, 'tags')], 'tags'),
      updated_at: iso(now),
    };
    await writeCardToWorktree(worktreeDir, memoryDir, next);
    return { card: next, created: false, path: cardRelPath(memoryDir, target.id) };
  }

  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'contested') throw new Error(`新卡片的 status 只能是 active 或 contested：${JSON.stringify(status)}`);
  const card = normalizeCard({
    id: newId(now.getTime()),
    kind: input.kind ?? 'observation',
    status,
    importance: input.importance,
    refs: input.refs,
    entities: input.entities,
    tags: input.tags,
    supersedes: input.supersedes,
    contradicts: input.contradicts,
    related: input.related,
    created_at: iso(now),
    updated_at: iso(now),
    body: input.content,
  });
  if ([...card.supersedes, ...card.contradicts, ...card.related].includes(card.id)) throw new Error('卡片不能关联自己');
  if (card.contradicts.length && card.status === 'active') card.status = 'contested';

  // 写任何文件之前，关系的目标都要在工作树里：缺一张就整个不写，不留悬空的 contested。
  const targets = new Map();
  for (const id of new Set([...card.supersedes, ...card.contradicts, ...card.related])) {
    const target = await readCardFromWorktree(worktreeDir, memoryDir, id);
    if (!target) throw Object.assign(new Error(`关系指向的卡片不存在：${id}`), { code: 'not_found' });
    targets.set(id, target);
  }
  // 同一张目标卡片可能被几种关系改到，在内存里累积后一起写。
  const updates = new Map();
  const edit = (id, mutate) => {
    const next = changed(updates.get(id) ?? targets.get(id), now, mutate);
    if (next) updates.set(id, next);
  };
  for (const id of card.supersedes) edit(id, c => { if (c.status === 'active' || c.status === 'contested') c.status = 'superseded'; });
  for (const id of card.contradicts) edit(id, c => {
    c.contradicts = union(c.contradicts, [card.id]);
    if (c.status === 'active') c.status = 'contested';
  });
  for (const id of card.related) edit(id, c => { c.related = union(c.related, [card.id]); });
  const path = await writeCardToWorktree(worktreeDir, memoryDir, card);
  await saveAll(worktreeDir, memoryDir, [...updates.values()]);
  return { card, created: true, path, changed: [...updates.keys()] };
}

export async function linkCards(worktreeDir, memoryDir, { from, to, relation, remove = false }, { now = new Date() } = {}) {
  if (relation !== 'supersedes' && relation !== 'contradicts' && relation !== 'related') throw new Error(`relation 必须是 supersedes、contradicts、related 之一：${JSON.stringify(relation)}`);
  if (assertId(from) === assertId(to)) throw new Error('卡片不能关联自己');
  const source = await readCardFromWorktree(worktreeDir, memoryDir, from), target = await readCardFromWorktree(worktreeDir, memoryDir, to);
  if (!source) throw new Error(`卡片不存在：${from}`);
  if (!target) throw new Error(`卡片不存在：${to}`);

  let nextSource, nextTarget;
  if (relation === 'supersedes') {
    nextSource = changed(source, now, c => { c.supersedes = remove ? without(c.supersedes, to) : union(c.supersedes, [to]); });
    if (!remove) {
      nextTarget = changed(target, now, c => { if (c.status === 'active' || c.status === 'contested') c.status = 'superseded'; });
    } else if (nextSource && target.status === 'superseded') {
      // 没有别的卡片还在取代它，才恢复。
      const others = (await listWorktreeCards(worktreeDir, memoryDir)).some(c => c.id !== from && c.supersedes.includes(to));
      if (!others) nextTarget = changed(target, now, c => { c.status = c.contradicts.length ? 'contested' : 'active'; });
    }
  } else if (relation === 'contradicts') {
    // 撤销时只有这条边原本在，才谈得上恢复状态。
    const edit = other => c => {
      const had = c.contradicts.includes(other);
      c.contradicts = remove ? without(c.contradicts, other) : union(c.contradicts, [other]);
      if (remove) { if (had) settle(c); } else if (c.status === 'active') c.status = 'contested';
    };
    nextSource = changed(source, now, edit(to));
    nextTarget = changed(target, now, edit(from));
  } else {
    const edit = other => c => { c.related = remove ? without(c.related, other) : union(c.related, [other]); };
    nextSource = changed(source, now, edit(to));
    nextTarget = changed(target, now, edit(from));
  }
  return { changed: await saveAll(worktreeDir, memoryDir, [nextSource, nextTarget].filter(Boolean)) };
}

// 归档不删文件，审计轨迹留在仓库里。
export async function archiveCard(worktreeDir, memoryDir, { id, reason }, { now = new Date() } = {}) {
  const card = await readCardFromWorktree(worktreeDir, memoryDir, id);
  if (!card) throw new Error(`卡片不存在：${id}`);
  const next = changed(card, now, c => {
    c.status = 'archived';
    if (typeof reason === 'string' && reason.trim()) c.archived_reason = reason.trim();
  });
  if (next) await writeCardToWorktree(worktreeDir, memoryDir, next);
  return { id: card.id };
}

// ---- 只读的 git 读取 ----

// 只认明确的默认分支：origin/HEAD、origin/main、origin/master、本地 main、master；都没有（含没有任何提交）返回 null。
// 当前检出的 HEAD 可能是功能分支，不能当默认分支。
export async function resolveDefaultBranch(repoDir) {
  // 退出码 1 只表示「没有这个引用」；别的失败（git 起不来、不是仓库）照常抛出。
  const candidates = [];
  const head = (await gitExit(repoDir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])).stdout?.trim();
  if (head) candidates.push(head);
  candidates.push('refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master');
  for (const ref of candidates) {
    const commit = (await gitExit(repoDir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).stdout?.trim();
    if (commit) return { ref, commit };
  }
  return null;
}

export async function listCardPathsAtCommit(repoDir, commit, memoryDir) {
  const dir = itemsPath(memoryDir);
  const out = await git(repoDir, ['ls-tree', '-r', '-z', '--name-only', commit, '--', `${dir}/`]);
  return out.split('\0').filter(path => path && isCardPath(memoryDir, path)).sort();
}

export async function readCardAtCommit(repoDir, commit, relPath) {
  return parseNamed(await git(repoDir, ['show', `${commit}:${relPath}`]), relPath);
}

// -z 的 name-status：状态与路径各占一段，R、C 后面跟旧、新两个路径。
function parseNameStatus(out) {
  const parts = out.split('\0'), entries = [];
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const status = parts[i][0];
    if (status === 'R' || status === 'C') { entries.push({ status, from: parts[i + 1], path: parts[i + 2] }); i += 2; } else { entries.push({ status, path: parts[i + 1] }); i += 1; }
  }
  return entries;
}

export async function diffCardsBetweenCommits(repoDir, oldCommit, newCommit, memoryDir) {
  await git(repoDir, ['rev-parse', '--verify', `${newCommit}^{commit}`]);
  // 旧提交没了（如 force-push 后被回收），或不是新提交的祖先，才重建；别的 git 错误照常抛出。
  if ((await gitExit(repoDir, ['rev-parse', '--verify', '-q', `${oldCommit}^{commit}`])).code === 1) return { mode: 'rebuild' };
  if ((await gitExit(repoDir, ['merge-base', '--is-ancestor', oldCommit, newCommit])).code === 1) return { mode: 'rebuild' };
  const entries = parseNameStatus(await git(repoDir, ['diff', '--name-status', '-z', '-M', '-C', oldCommit, newCommit, '--', itemsPath(memoryDir)]));
  const result = { mode: 'incremental', added: [], modified: [], deleted: [] };
  const take = (list, path) => { if (path && isCardPath(memoryDir, path)) list.push(path); };
  for (const entry of entries) {
    if (entry.status === 'A' || entry.status === 'C') take(result.added, entry.path);
    else if (entry.status === 'D') take(result.deleted, entry.path);
    else if (entry.status === 'R') { take(result.deleted, entry.from); take(result.added, entry.path); } else take(result.modified, entry.path);
  }
  return result;
}

// 当前分支相对 baseCommit 新增、修改或删除的卡片（含工作树里未提交、未跟踪的）。
// 只看本分支（自分叉点 merge-base 起）和工作树实际改动过的路径：落后的分支上，baseCommit 新增、修改、删除的卡片不是本分支的草稿。
export async function loadDraftOverlay(repoDir, baseCommit, memoryDir) {
  const dir = itemsPath(memoryDir);
  await git(repoDir, ['rev-parse', '--verify', `${baseCommit}^{commit}`]);
  // 还没有提交的分支（git checkout --orphan）没有 HEAD，也没有共同祖先；有 HEAD 时退出码 1 同样是没有共同祖先：都只统计工作树里的改动。
  const hasHead = !!(await gitExit(repoDir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout?.trim();
  const mergeBase = hasHead ? (await gitExit(repoDir, ['merge-base', 'HEAD', baseCommit])).stdout?.trim() : '';
  const names = out => out.split('\0').filter(path => path && isCardPath(memoryDir, path));
  const changedPaths = new Set();
  if (mergeBase) for (const path of names(await git(repoDir, ['diff', '--name-only', '-z', '--no-renames', mergeBase, 'HEAD', '--', dir]))) changedPaths.add(path);
  if (hasHead) {
    // git diff 对着工作树比较时会顺手刷新并写回索引；在索引的副本上跑，真正的 .git/index 一个字节不动。
    const scratch = await mkdtemp(join(tmpdir(), 'memory-index-'));
    try {
      const index = (await git(repoDir, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
      // 保留索引文件的修改时间：git 靠它识别「和索引同一秒内改过、大小没变」的文件，新时间会让这类改动被当成没改。
      await cp(index, join(scratch, 'index'), { preserveTimestamps: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
      for (const path of names(await git(repoDir, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--', dir], { GIT_INDEX_FILE: join(scratch, 'index') }))) changedPaths.add(path);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else {
    // 没有 HEAD 可比：索引里已暂存的卡片都算本分支改动过的（和 baseCommit 一致的下面会被略过）。
    for (const path of names(await git(repoDir, ['ls-files', '--cached', '-z', '--', dir]))) changedPaths.add(path);
  }
  // 未跟踪的新卡用只读的 ls-files 列出，不用会刷新索引的 status。
  for (const path of names(await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', dir]))) changedPaths.add(path);

  const inBase = new Set(await listCardPathsAtCommit(repoDir, baseCommit, memoryDir));
  const drafts = new Map(), deletedIds = new Set();
  await assertInsideRepo(repoDir, memoryDir);
  for (const path of changedPaths) {
    const text = await readCardFile(join(repoDir, path), path);
    if (text === null) {
      if (inBase.has(path)) deletedIds.add(idOfPath(path));
    } else if (!inBase.has(path) || text !== await git(repoDir, ['show', `${baseCommit}:${path}`])) {
      const card = parseNamed(text, path);
      drafts.set(card.id, card);
    }
  }
  return { drafts, deletedIds };
}
