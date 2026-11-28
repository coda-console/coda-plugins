import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeCard } from '../../../plugins/memory/lib/card.mjs';
import {
  archiveCard, diffCardsBetweenCommits, linkCards, listCardPathsAtCommit, listWorktreeCards, loadDraftOverlay,
  readCardAtCommit, readCardFromWorktree, rememberCard, resolveDefaultBranch, writeCardToWorktree,
} from '../../../plugins/memory/lib/repo-cards.mjs';

const MEM = '.memory';
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }).trim();
const repo = t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'tester');
  git(dir, 'config', 'user.email', 'tester@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  return dir;
};
const commit = (dir, message = 'c') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD'); };
const remember = (dir, input = {}) => rememberCard(dir, MEM, { content: '内容', refs: ['a.md'], ...input });
const status = async (dir, id) => (await readCardFromWorktree(dir, MEM, id)).status;
const card = (id, extra = {}) => ({
  id, kind: 'fact', refs: ['r'], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', body: `卡片 ${id}`, ...extra,
});
const put = (dir, c, file = `${c.id}.md`) => {
  mkdirSync(join(dir, MEM, 'items'), { recursive: true });
  writeFileSync(join(dir, MEM, 'items', file), serializeCard(c));
};

test('rememberCard 新建卡片，原子写入且不留临时文件', async t => {
  const dir = repo(t);
  const { card: created, created: isNew, path } = await remember(dir, { kind: 'conclusion', importance: 4, entities: ['E'], tags: ['t'] });
  assert.equal(isNew, true);
  assert.equal(path, `${MEM}/items/${created.id}.md`);
  assert.deepEqual(await readCardFromWorktree(dir, MEM, created.id), created);
  assert.deepEqual(readdirSync(join(dir, MEM, 'items')), [`${created.id}.md`]);
  assert.equal(await readCardFromWorktree(dir, MEM, 'MISSING'), null);
  assert.deepEqual((await listWorktreeCards(dir, MEM)).map(c => c.id), [created.id]);
  await assert.rejects(remember(dir, { refs: [] }), /refs/);
  await assert.rejects(rememberCard(dir, '../out', { content: 'x', refs: ['a'] }), /memoryDir/);
  await assert.rejects(rememberCard(dir, '/abs', { content: 'x', refs: ['a'] }), /memoryDir/);
});

test('appendToId 合并来源、实体和标签而不新建卡片', async t => {
  const dir = repo(t);
  const { card: first } = await remember(dir, { entities: ['E'] });
  const { card: merged, created } = await rememberCard(dir, MEM, { appendToId: first.id, refs: ['a.md', 'b.md'], entities: ['F'], tags: ['t'] }, { now: new Date(Date.now() + 5000) });
  assert.equal(created, false);
  assert.deepEqual([merged.refs, merged.entities, merged.tags], [['a.md', 'b.md'], ['E', 'F'], ['t']]);
  assert.ok(merged.updated_at > first.updated_at);
  assert.equal(merged.body, first.body);
  assert.equal((await listWorktreeCards(dir, MEM)).length, 1);
  await assert.rejects(rememberCard(dir, MEM, { appendToId: 'NOPE', refs: ['x'] }), /不存在/);
  await assert.rejects(rememberCard(dir, MEM, { appendToId: first.id, content: '改正文' }), /不改正文/);
  await archiveCard(dir, MEM, { id: first.id });
  await assert.rejects(rememberCard(dir, MEM, { appendToId: first.id, refs: ['x'] }), /已归档/);
});

test('supersedes 把旧卡片置为 superseded，archived 的不动', async t => {
  const dir = repo(t);
  const { card: old } = await remember(dir);
  const { card: contested } = await remember(dir, { status: 'contested' });
  const { card: gone } = await remember(dir);
  await archiveCard(dir, MEM, { id: gone.id });
  const { card: fresh } = await remember(dir, { supersedes: [old.id, contested.id, gone.id, 'NOT_IN_WORKTREE'] });
  assert.deepEqual(fresh.supersedes, [old.id, contested.id, gone.id, 'NOT_IN_WORKTREE']);
  assert.equal(await status(dir, old.id), 'superseded');
  assert.equal(await status(dir, contested.id), 'superseded');
  assert.equal(await status(dir, gone.id), 'archived');
  assert.equal(await status(dir, fresh.id), 'active');
});

test('contradicts 互相记录且双方变 contested，related 双向记录', async t => {
  const dir = repo(t);
  const { card: a } = await remember(dir);
  const { card: b } = await remember(dir, { contradicts: [a.id], related: [a.id] });
  const reloaded = await readCardFromWorktree(dir, MEM, a.id);
  assert.deepEqual([b.status, reloaded.status], ['contested', 'contested']);
  assert.deepEqual(reloaded.contradicts, [b.id]);
  assert.deepEqual(reloaded.related, [b.id]);
  assert.deepEqual(b.contradicts, [a.id]);
});

test('linkCards 建立与撤销关系并联动状态', async t => {
  const dir = repo(t);
  const [a, b, c] = [(await remember(dir)).card, (await remember(dir)).card, (await remember(dir)).card];

  assert.deepEqual((await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'contradicts' })).changed.sort(), [a.id, b.id].sort());
  assert.deepEqual([await status(dir, a.id), await status(dir, b.id)], ['contested', 'contested']);
  assert.deepEqual((await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'contradicts' })).changed, []);
  await linkCards(dir, MEM, { from: a.id, to: c.id, relation: 'contradicts' });
  await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'contradicts', remove: true });
  assert.deepEqual([await status(dir, a.id), await status(dir, b.id)], ['contested', 'active']);
  await linkCards(dir, MEM, { from: c.id, to: a.id, relation: 'contradicts', remove: true });
  assert.deepEqual([await status(dir, a.id), await status(dir, c.id)], ['active', 'active']);

  await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'related' });
  assert.deepEqual((await readCardFromWorktree(dir, MEM, b.id)).related, [a.id]);
  await linkCards(dir, MEM, { from: b.id, to: a.id, relation: 'related', remove: true });
  assert.deepEqual([(await readCardFromWorktree(dir, MEM, a.id)).related, (await readCardFromWorktree(dir, MEM, b.id)).related], [[], []]);

  await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'supersedes' });
  await linkCards(dir, MEM, { from: c.id, to: b.id, relation: 'supersedes' });
  assert.equal(await status(dir, b.id), 'superseded');
  await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'supersedes', remove: true });
  assert.equal(await status(dir, b.id), 'superseded');
  await linkCards(dir, MEM, { from: c.id, to: b.id, relation: 'supersedes', remove: true });
  assert.equal(await status(dir, b.id), 'active');

  await assert.rejects(linkCards(dir, MEM, { from: a.id, to: a.id, relation: 'related' }), /自己/);
  await assert.rejects(linkCards(dir, MEM, { from: a.id, to: 'NOPE', relation: 'related' }), /不存在/);
  await assert.rejects(linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'x' }), /relation/);
});

test('archiveCard 置 archived 并保留原因，文件不删', async t => {
  const dir = repo(t);
  const { card: a } = await remember(dir);
  await archiveCard(dir, MEM, { id: a.id, reason: '过时了' });
  const archived = await readCardFromWorktree(dir, MEM, a.id);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.archived_reason, '过时了');
  assert.equal(archived.body, a.body);
  await assert.rejects(archiveCard(dir, MEM, { id: 'NOPE' }), /不存在/);
});

test('git 只读：切分支后仍能读主分支卡片，工作区不被弄脏', async t => {
  const dir = repo(t);
  put(dir, card('A1'));
  put(dir, card('B2'));
  const main = commit(dir);
  assert.deepEqual(await resolveDefaultBranch(dir), { ref: 'refs/heads/main', commit: main });
  git(dir, 'checkout', '-q', '-b', 'feature');
  git(dir, 'rm', '-q', '-r', MEM);
  commit(dir, 'drop');
  const before = git(dir, 'status', '--porcelain');
  assert.deepEqual(await listCardPathsAtCommit(dir, main, MEM), [`${MEM}/items/A1.md`, `${MEM}/items/B2.md`]);
  assert.equal((await readCardAtCommit(dir, main, `${MEM}/items/A1.md`)).body, '卡片 A1');
  assert.equal(git(dir, 'branch', '--show-current'), 'feature');
  assert.equal(git(dir, 'status', '--porcelain'), before);
  assert.deepEqual(await listCardPathsAtCommit(dir, 'HEAD', MEM), []);
  await assert.rejects(readCardAtCommit(dir, main, `${MEM}/items/NOPE.md`));
});

test('resolveDefaultBranch 优先 origin/HEAD，回退到 origin/main、本地分支和 HEAD', async t => {
  const dir = repo(t);
  const first = commit(dir);
  git(dir, 'branch', '-m', 'trunk');
  assert.deepEqual(await resolveDefaultBranch(dir), { ref: 'HEAD', commit: first });
  git(dir, 'branch', 'master');
  assert.equal((await resolveDefaultBranch(dir)).ref, 'refs/heads/master');
  writeFileSync(join(dir, 'x'), 'x');
  const second = commit(dir);
  git(dir, 'update-ref', 'refs/remotes/origin/main', first);
  assert.deepEqual(await resolveDefaultBranch(dir), { ref: 'refs/remotes/origin/main', commit: first });
  git(dir, 'update-ref', 'refs/remotes/origin/dev', second);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
  assert.deepEqual(await resolveDefaultBranch(dir), { ref: 'refs/remotes/origin/dev', commit: second });
  const empty = repo(t);
  await assert.rejects(resolveDefaultBranch(empty), /找不到默认分支/);
  // 不是仓库：git 的失败不能被当成「没有这个分支」吞掉。
  const plain = mkdtempSync(join(tmpdir(), 'memory-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(resolveDefaultBranch(plain), /not a git repository/);
});

test('diffCardsBetweenCommits：增删改、重命名、中文文件名与非祖先重建', async t => {
  const dir = repo(t);
  put(dir, card('KEEP'));
  put(dir, card('EDIT'));
  put(dir, card('DEL'));
  put(dir, card('MOVE', { body: '这张卡片会被改名，内容足够长以便识别为重命名。'.repeat(5) }));
  const c1 = commit(dir);

  put(dir, card('EDIT', { body: '改过' }));
  git(dir, 'rm', '-q', `${MEM}/items/DEL.md`);
  put(dir, card('NEW'));
  put(dir, card('ZH'), '中文 卡片"x".md');
  git(dir, 'mv', `${MEM}/items/MOVE.md`, `${MEM}/items/MOVED.md`);
  writeFileSync(join(dir, 'README.md'), '无关改动\n');
  const c2 = commit(dir);

  const diff = await diffCardsBetweenCommits(dir, c1, c2, MEM);
  const p = name => `${MEM}/items/${name}`;
  assert.equal(diff.mode, 'incremental');
  assert.deepEqual(diff.added.sort(), [p('MOVED.md'), p('NEW.md'), p('中文 卡片"x".md')].sort());
  assert.deepEqual(diff.modified, [p('EDIT.md')]);
  assert.deepEqual(diff.deleted.sort(), [p('DEL.md'), p('MOVE.md')].sort());
  assert.deepEqual(await diffCardsBetweenCommits(dir, c1, c1, MEM), { mode: 'incremental', added: [], modified: [], deleted: [] });

  // 非 ASCII 路径也能列出（文件内容的 id 与文件名不符，这里只看路径）。
  assert.ok((await listCardPathsAtCommit(dir, c2, MEM)).includes(p('中文 卡片"x".md')));

  // force-push：旧提交不再是新提交的祖先。
  git(dir, 'reset', '-q', '--hard', c1);
  writeFileSync(join(dir, 'other'), 'o');
  const rewritten = commit(dir, 'rewritten');
  assert.deepEqual(await diffCardsBetweenCommits(dir, c2, rewritten, MEM), { mode: 'rebuild' });
  assert.deepEqual(await diffCardsBetweenCommits(dir, '0'.repeat(40), rewritten, MEM), { mode: 'rebuild' });
});

test('loadDraftOverlay：未跟踪新卡、修改卡与删除卡', async t => {
  const dir = repo(t);
  put(dir, card('KEEP'));
  put(dir, card('EDIT'));
  put(dir, card('DEL'));
  const base = commit(dir);
  assert.deepEqual(await loadDraftOverlay(dir, base, MEM), { drafts: new Map(), deletedIds: new Set() });

  put(dir, card('EDIT', { body: '草稿改动' }));
  rmSync(join(dir, MEM, 'items', 'DEL.md'));
  put(dir, card('FRESH'));
  put(dir, card('STAGED'));
  git(dir, 'add', `${MEM}/items/STAGED.md`);
  writeFileSync(join(dir, 'README.md'), '无关\n');

  const { drafts, deletedIds } = await loadDraftOverlay(dir, base, MEM);
  assert.deepEqual([...drafts.keys()].sort(), ['EDIT', 'FRESH', 'STAGED']);
  assert.equal(drafts.get('EDIT').body, '草稿改动');
  assert.deepEqual([...deletedIds], ['DEL']);

  // 删掉又以未跟踪文件重建：算草稿，不算删除。
  git(dir, 'rm', '-q', '--cached', `${MEM}/items/EDIT.md`);
  const again = await loadDraftOverlay(dir, base, MEM);
  assert.ok(again.drafts.has('EDIT'));
  assert.ok(!again.deletedIds.has('EDIT'));
});

test('writeCardToWorktree 写前校验，非法卡片不落盘', async t => {
  const dir = repo(t);
  await assert.rejects(writeCardToWorktree(dir, MEM, card('BAD', { body: 'x'.repeat(8001) })), /8000/);
  await assert.rejects(writeCardToWorktree(dir, MEM, card('../BAD')), /卡片 id/);
  assert.deepEqual(await listWorktreeCards(dir, MEM), []);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'x\n');
});

test('撤销不存在的关系不改变状态', async t => {
  const dir = repo(t);
  const [a, b, c] = [(await remember(dir)).card, (await remember(dir, { status: 'contested' })).card, (await remember(dir)).card];
  // b 是手工标的 contested，没有矛盾边：撤销一条不存在的矛盾边不该把它恢复成 active。
  assert.deepEqual((await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'contradicts', remove: true })).changed, []);
  assert.equal(await status(dir, b.id), 'contested');
  // c 被手工置为 superseded，a 并没有取代它：撤销不存在的 supersedes 不该恢复它。
  await archiveCard(dir, MEM, { id: c.id });
  writeFileSync(join(dir, MEM, 'items', `${c.id}.md`), readFileSync(join(dir, MEM, 'items', `${c.id}.md`), 'utf8').replace('"archived"', '"superseded"'));
  assert.deepEqual((await linkCards(dir, MEM, { from: a.id, to: c.id, relation: 'supersedes', remove: true })).changed, []);
  assert.equal(await status(dir, c.id), 'superseded');
  // 一侧有边一侧没有（手工编辑的残缺数据）：只恢复真有这条边的那侧。
  await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'contradicts' });
  await linkCards(dir, MEM, { from: a.id, to: b.id, relation: 'contradicts', remove: true });
  assert.deepEqual([await status(dir, a.id), await status(dir, b.id)], ['active', 'active']);
});

test('appendToId 来源已存在时也刷新 updated_at 并落盘', async t => {
  const dir = repo(t);
  const { card: first } = await remember(dir);
  const later = new Date(Date.parse(first.updated_at) + 60_000);
  const { card } = await rememberCard(dir, MEM, { appendToId: first.id, refs: first.refs }, { now: later });
  assert.equal(card.updated_at, later.toISOString());
  assert.equal((await readCardFromWorktree(dir, MEM, first.id)).updated_at, later.toISOString());
  assert.deepEqual(card.refs, first.refs);
});

test('带 pathspec 魔法字符的记忆目录按字面处理', async t => {
  for (const memoryDir of [':notes', 'a*b', '[x]', ':(top)m']) {
    const dir = repo(t);
    const put2 = (c, file = `${c.id}.md`) => { mkdirSync(join(dir, memoryDir, 'items'), { recursive: true }); writeFileSync(join(dir, memoryDir, 'items', file), serializeCard(c)); };
    put2(card('KEEP'));
    put2(card('EDIT'));
    put2(card('DEL'));
    const c1 = commit(dir);
    assert.deepEqual(await listCardPathsAtCommit(dir, c1, memoryDir), ['KEEP', 'EDIT', 'DEL'].sort().map(id => `${memoryDir}/items/${id}.md`), memoryDir);
    assert.equal((await readCardAtCommit(dir, c1, `${memoryDir}/items/KEEP.md`)).id, 'KEEP');

    put2(card('EDIT', { body: '改' }));
    git(dir, 'rm', '-q', '--', `${memoryDir}/items/DEL.md`);
    put2(card('NEW'));
    const c2 = commit(dir);
    const diff = await diffCardsBetweenCommits(dir, c1, c2, memoryDir);
    assert.deepEqual([diff.added, diff.modified, diff.deleted], [[`${memoryDir}/items/NEW.md`], [`${memoryDir}/items/EDIT.md`], [`${memoryDir}/items/DEL.md`]], memoryDir);

    put2(card('EDIT', { body: '草稿' }));
    put2(card('FRESH'));
    rmSync(join(dir, memoryDir, 'items', 'KEEP.md'));
    const { drafts, deletedIds } = await loadDraftOverlay(dir, c2, memoryDir);
    assert.deepEqual([[...drafts.keys()].sort(), [...deletedIds]], [['EDIT', 'FRESH'], ['KEEP']], memoryDir);
  }
});

test('loadDraftOverlay 不改写 .git/index', async t => {
  const dir = repo(t);
  put(dir, card('A1'));
  const base = commit(dir);
  // 只改文件时间让索引里的缓存过期：会刷新索引的命令此时会把它写回去。
  const file = join(dir, MEM, 'items', 'A1.md'), later = new Date(Date.now() + 10_000);
  utimesSync(file, later, later);
  put(dir, card('NEW'));
  const index = join(dir, '.git', 'index'), before = readFileSync(index);
  const { drafts } = await loadDraftOverlay(dir, base, MEM);
  assert.deepEqual([...drafts.keys()], ['NEW']);
  assert.ok(readFileSync(index).equals(before));
});

test('指向仓库外的记忆目录链接和符号链接卡片被拒绝', async t => {
  const outside = mkdtempSync(join(tmpdir(), 'memory-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, 'items'));
  writeFileSync(join(outside, 'items', 'EVIL.md'), serializeCard(card('EVIL')));

  const linked = repo(t);
  symlinkSync(outside, join(linked, MEM));
  await assert.rejects(readCardFromWorktree(linked, MEM, 'EVIL'), /仓库之外/);
  await assert.rejects(listWorktreeCards(linked, MEM), /仓库之外/);
  await assert.rejects(writeCardToWorktree(linked, MEM, card('NEW')), /仓库之外/);
  await assert.rejects(remember(linked), /仓库之外/);
  assert.deepEqual(readdirSync(join(outside, 'items')), ['EVIL.md']);

  // 记忆目录本身还不存在、其上级是外链时，也不能借 mkdir 建到仓库外。
  const parentLinked = repo(t);
  symlinkSync(outside, join(parentLinked, 'docs'));
  await assert.rejects(rememberCard(parentLinked, 'docs/mem', { content: 'x', refs: ['a'] }), /仓库之外/);
  assert.deepEqual(readdirSync(outside), ['items']);

  // 链接指向仓库内部是允许的。
  const inner = repo(t);
  mkdirSync(join(inner, 'real'));
  symlinkSync(join(inner, 'real'), join(inner, MEM));
  const { card: ok } = await remember(inner);
  assert.equal((await readCardFromWorktree(inner, MEM, ok.id)).id, ok.id);

  // 符号链接卡片：读、列举、写、草稿读取都拒绝。
  const dir = repo(t);
  mkdirSync(join(dir, MEM, 'items'), { recursive: true });
  symlinkSync(join(outside, 'items', 'EVIL.md'), join(dir, MEM, 'items', 'EVIL.md'));
  await assert.rejects(readCardFromWorktree(dir, MEM, 'EVIL'), /普通文件/);
  await assert.rejects(listWorktreeCards(dir, MEM), /普通文件/);
  await assert.rejects(writeCardToWorktree(dir, MEM, card('EVIL')), /普通文件/);
  await assert.rejects(loadDraftOverlay(dir, 'HEAD', MEM), /unknown revision|ambiguous|bad revision|Needed a single revision/);
  commit(dir);
  rmSync(join(dir, MEM, 'items', 'EVIL.md'));
  put(dir, card('GOOD'));
  symlinkSync(join(outside, 'items', 'EVIL.md'), join(dir, MEM, 'items', 'LINK.md'));
  await assert.rejects(loadDraftOverlay(dir, 'HEAD', MEM), /普通文件/);
});

test('diffCardsBetweenCommits 只在明确的非祖先或旧提交缺失时重建，其他 git 错误抛出', async t => {
  const dir = repo(t);
  put(dir, card('A1'));
  const c1 = commit(dir);
  await assert.rejects(diffCardsBetweenCommits(dir, c1, 'f'.repeat(40), MEM), /f{40}|Needed a single revision|bad revision/);
  await assert.rejects(diffCardsBetweenCommits(dir, c1, 'no-such-ref', MEM));
  assert.deepEqual(await diffCardsBetweenCommits(dir, 'f'.repeat(40), c1, MEM), { mode: 'rebuild' });
  const plain = mkdtempSync(join(tmpdir(), 'memory-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(diffCardsBetweenCommits(plain, c1, c1, MEM), /not a git repository/);
});
