import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serializeCard } from '../../../plugins/memory/lib/card.mjs';
import { MnemonEngine, buildMnemonEnv } from '../../../plugins/memory/lib/mnemon.mjs';
import { projectDir, safeProjectId, withProjectLock } from '../../../plugins/memory/lib/queue.mjs';
import { ensureSynced, fetchRemote, syncProject } from '../../../plugins/memory/lib/sync.mjs';
import { fakeBin } from './helpers.mjs';

const CHILD = fileURLToPath(new URL('./lock-child.mjs', import.meta.url));
const MEM = '.memory';
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const initRepo = (dir, bare = false, branch = 'main') => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch, ...(bare ? ['--bare'] : []));
  for (const [key, value] of [['user.name', 'tester'], ['user.email', 'tester@example.com'], ['commit.gpgsign', 'false']]) git(dir, 'config', key, value);
  return dir;
};
const commit = (dir, message = 'c') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD'); };
const card = (id, extra = {}) => ({
  id, kind: 'fact', refs: ['r'], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', body: `卡片 ${id}`, ...extra,
});
const put = (dir, c, memoryDir = MEM) => {
  mkdirSync(join(dir, memoryDir, 'items'), { recursive: true });
  writeFileSync(join(dir, memoryDir, 'items', `${c.id}.md`), serializeCard(c));
};
const drop = (dir, id) => rmSync(join(dir, MEM, 'items', `${id}.md`));

const PROJECT = 'proj-1';
// 一个研究仓、一个状态目录和一个指向假 mnemon 的引擎。
const setup = t => {
  const root = tmp(t), repoDir = initRepo(join(root, 'repo')), stateDir = join(root, 'state');
  writeFileSync(join(repoDir, 'README.md'), 'x\n');
  const dataDir = join(projectDir(stateDir, PROJECT), 'mnemon');
  const engine = new MnemonEngine({ bin: fakeBin(root), dataDir, env: process.env });
  const sync = (extra = {}) => syncProject({ projectId: PROJECT, repoDir, stateDir, engine, ...extra });
  const state = () => JSON.parse(readFileSync(join(projectDir(stateDir, PROJECT), 'sync-state.json'), 'utf8'));
  const calls = () => (existsSync(join(dataDir, 'calls.jsonl')) ? readFileSync(join(dataDir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  const positional = call => call.args.slice(call.args.indexOf('--') + 1);
  const db = () => JSON.parse(readFileSync(join(dataDir, 'data', 'default', 'mnemon.db'), 'utf8'));
  return { root, repoDir, stateDir, dataDir, engine, sync, state, calls, positional, db };
};

// ---- 队列与锁 ----

test('safeProjectId 编码成单层目录名，不会路径穿越也不会撞名', () => {
  assert.equal(safeProjectId('proj_1-a'), 'proj_1-a');
  assert.equal(safeProjectId('../a'), '%2E%2E%2Fa');
  assert.notEqual(safeProjectId('a/b'), safeProjectId('a%2Fb'));
  assert.equal(projectDir('/s', '../../x'), '/s/projects/%2E%2E%2F%2E%2E%2Fx');
  assert.throws(() => safeProjectId(''), /projectId/);
  assert.throws(() => safeProjectId('a'.repeat(201)), /太长/);
});

test('withProjectLock 同一项目严格 FIFO 且不重叠，出错也放行下一项', async t => {
  const stateDir = tmp(t), events = [];
  const task = (name, ms, fail) => () => withProjectLock(stateDir, 'p', async () => {
    events.push(`start ${name}`);
    await delay(ms);
    events.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([task('a', 40)(), task('b', 5, true)(), task('c', 20)(), task('d', 0)()]);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
  assert.deepEqual(results.map(r => r.value ?? r.reason.message), ['a', 'b', 'c', 'd']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(existsSync(join(projectDir(stateDir, 'p'), '.lock')), false);
});

// 不同项目并行：两边都进了临界区才一起放行；若被串行化，永远凑不齐，测试超时失败。
test('withProjectLock 不同项目互不等待', { timeout: 5000 }, async t => {
  const stateDir = tmp(t);
  let entered = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  await Promise.all(['x', 'y'].map(id => withProjectLock(stateDir, id, async () => {
    if (++entered === 2) release();
    await both;
  })));
  assert.equal(entered, 2);
});

test('withProjectLock 跨进程互斥：几个进程的临界区一个接一个', async t => {
  const stateDir = tmp(t), log = join(stateDir, 'log.txt');
  writeFileSync(log, '');
  const children = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, stateDir, 'p', log, '60'], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`子进程退出码 ${code}`))));
  }));
  await Promise.all(children);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 8);
  for (let i = 0; i < lines.length; i += 2) {
    const [enter, pid] = lines[i].split(' ');
    assert.deepEqual([enter, lines[i + 1]], ['enter', `exit ${pid}`]);
  }
});

const plant = (stateDir, owner) => {
  const lock = join(projectDir(stateDir, 'p'), '.lock');
  mkdirSync(lock, { recursive: true });
  if (owner) writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'old', ...owner }));
  return lock;
};

test('withProjectLock 清理持有者已退出的锁，以及没有有效 pid 且过期的锁', async t => {
  const stateDir = tmp(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  plant(stateDir, { pid: dead, createdAt: Date.now() });
  assert.equal(await withProjectLock(stateDir, 'p', async () => 'dead'), 'dead');
  // 没有 owner.json、pid 不是整数：按目录年龄，没到期不动，到期才清。
  const lock = plant(stateDir, { pid: 'x' });
  await assert.rejects(withProjectLock(stateDir, 'p', async () => {}, { timeoutMs: 150 }), { code: 'lock_timeout' });
  assert.equal(await withProjectLock(stateDir, 'p', async () => 'stale', { staleMs: 50 }), 'stale');
  rmSync(lock, { recursive: true, force: true });
  plant(stateDir);
  assert.equal(await withProjectLock(stateDir, 'p', async () => 'ownerless', { staleMs: 50 }), 'ownerless');
  assert.equal(existsSync(lock), false);
});

test('withProjectLock 不按超时回收仍活着的持有者，等不到就超时', async t => {
  const stateDir = tmp(t), lock = plant(stateDir, { pid: process.pid, createdAt: 0 });
  await assert.rejects(withProjectLock(stateDir, 'p', async () => {}, { timeoutMs: 200, staleMs: 1 }), { code: 'lock_timeout' });
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'old');
});

test('withProjectLock 的锁被当过期清掉后，释放时不删别人新建的锁', async t => {
  const stateDir = tmp(t), lock = join(projectDir(stateDir, 'p'), '.lock');
  await withProjectLock(stateDir, 'p', async () => {
    rmSync(lock, { recursive: true });
    plant(stateDir, { pid: process.pid, createdAt: Date.now(), token: 'someone-else' });
  });
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'someone-else');
});

// ---- 同步 ----

test('首次同步全量建库：非归档卡片批量导入含内部边，归档的只留元数据', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  put(s.repoDir, card('B', { supersedes: ['A'], status: 'active' }));
  put(s.repoDir, card('C', { status: 'archived', archived_reason: '过期' }));
  const head = commit(s.repoDir);

  const now = new Date('2026-02-03T04:05:06.000Z');
  assert.deepEqual(await s.sync({ now }), { action: 'rebuild', commit: head, indexed: 2 });
  const state = s.state();
  assert.deepEqual([state.version, state.memoryDir, state.indexedCommit, state.lastCheckedAt], [1, MEM, head, now.toISOString()]);
  assert.deepEqual(Object.keys(state.items), ['A', 'B', 'C']);
  assert.deepEqual([state.items.A.mnemonId, state.items.B.mnemonId, state.items.C.mnemonId], ['m1', 'm2', null]);
  assert.equal(state.items.A.path, `${MEM}/items/A.md`);
  assert.equal(state.items.C.card.status, 'archived');
  assert.deepEqual(s.db().edges.map(e => [e.from, e.to, e.type]), [['m2', 'm1', 'supersedes']]);
  assert.deepEqual(s.calls().map(call => call.command), ['import']);
  assert.deepEqual(readdirSync(projectDir(s.stateDir, PROJECT)).sort(), ['mnemon', 'sync-state.json']);
});

test('已索引的提交没变就只刷新 lastCheckedAt；索引目录被删则重建', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);
  await s.sync();
  const before = s.calls().length;
  const now = new Date('2030-01-01T00:00:00.000Z');
  assert.deepEqual(await s.sync({ now }), { action: 'noop', commit: head });
  assert.equal(s.state().lastCheckedAt, now.toISOString());
  assert.equal(s.calls().length, before);
  assert.equal((await s.sync({ forceRebuild: true })).action, 'rebuild');
  rmSync(join(s.dataDir, 'data'), { recursive: true });
  assert.equal((await s.sync()).action, 'rebuild');
});

test('增量：新增、修改、归档、删除，并补齐出边、入边，互相矛盾只补一次', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  put(s.repoDir, card('B', { supersedes: ['A'] }));
  put(s.repoDir, card('E', { related: ['A'] }));
  commit(s.repoDir);
  await s.sync();
  const calls0 = s.calls().length;

  // A 改正文（mnemon id 变）；新增 D 相关于 A；新增 F、G 互相矛盾。
  put(s.repoDir, card('A', { body: '改过的 A', updated_at: '2026-02-01T00:00:00.000Z' }));
  put(s.repoDir, card('D', { related: ['A'] }));
  put(s.repoDir, card('F', { contradicts: ['G'] }));
  put(s.repoDir, card('G', { contradicts: ['F'] }));
  const head = commit(s.repoDir);
  assert.deepEqual(await s.sync(), { action: 'incremental', commit: head, indexed: 6 });
  const calls = s.calls().slice(calls0);
  assert.deepEqual(calls.filter(c => c.command === 'forget').map(s.positional), [['m1']]);
  // 新增和修改的卡片走保留 created_at 的导入，不用 remember。
  assert.deepEqual(calls.filter(c => c.command === 'remember'), []);
  const imported = readFileSync(join(s.dataDir, 'imports.jsonl'), 'utf8').trim().split('\n').slice(1).map(line => JSON.parse(line).draft.insights[0]);
  assert.deepEqual(imported.map(item => item.content), ['卡片 D', '卡片 F', '卡片 G', '改过的 A']);
  assert.deepEqual(imported.map(item => item.created_at), Array(4).fill('2026-01-01T00:00:00.000Z'));
  const ids = Object.fromEntries(Object.entries(s.state().items).map(([id, item]) => [id, item.mnemonId]));
  assert.deepEqual(ids, { A: 'm7', B: 'm2', D: 'm4', E: 'm3', F: 'm5', G: 'm6' });
  const links = calls.filter(c => c.command === 'link').map(c => s.positional(c).join('>') + ':' + c.args[c.args.indexOf('--type') + 1]).sort();
  assert.deepEqual(links, ['m2>m7:supersedes', 'm3>m7:semantic', 'm4>m7:semantic', 'm5>m6:semantic']);

  // 归档 B、删掉 E：各自 forget；归档的保留元数据。
  put(s.repoDir, card('B', { supersedes: ['A'], status: 'archived', archived_reason: '过期' }));
  drop(s.repoDir, 'E');
  commit(s.repoDir);
  const calls1 = s.calls().length;
  assert.equal((await s.sync()).action, 'incremental');
  assert.deepEqual(s.calls().slice(calls1).filter(c => c.command === 'forget').map(s.positional).sort(), [['m2'], ['m3']]);
  const items = s.state().items;
  assert.deepEqual([Object.keys(items), items.B.mnemonId, items.B.card.status], [['A', 'B', 'D', 'F', 'G'], null, 'archived']);
  assert.deepEqual((await s.engine.search({ query: '卡片' })).map(r => r.mnemonId), ['m4', 'm5', 'm6']);
});

test('无 origin 时 fetchRemote 降级为本地默认分支并记下 fetchError', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);
  const result = await s.sync({ fetchRemote: true });
  assert.deepEqual([result.action, result.commit, typeof result.fetchError], ['rebuild', head, 'string']);
  assert.equal('fetchError' in await s.sync(), false);
});

test('fetchRemote 只更新远端跟踪分支，不动工作区', async t => {
  const s = setup(t), remote = initRepo(join(s.root, 'remote.git'), true);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  git(s.repoDir, 'remote', 'add', 'origin', remote);
  git(s.repoDir, 'push', '-q', 'origin', 'main');
  git(s.repoDir, 'fetch', '-q', 'origin');
  assert.equal((await s.sync({ fetchRemote: true })).action, 'rebuild');

  const other = join(s.root, 'other');
  execFileSync('git', ['clone', '-q', remote, other]);
  for (const [key, value] of [['user.name', 'o'], ['user.email', 'o@example.com'], ['commit.gpgsign', 'false']]) git(other, 'config', key, value);
  put(other, card('B'));
  const remoteHead = commit(other);
  git(other, 'push', '-q', 'origin', 'main');

  const localHead = git(s.repoDir, 'rev-parse', 'HEAD');
  const result = await s.sync({ fetchRemote: true });
  assert.deepEqual([result.action, result.commit, 'fetchError' in result], ['incremental', remoteHead, false]);
  assert.equal(git(s.repoDir, 'rev-parse', 'HEAD'), localHead);
  assert.equal(existsSync(join(s.repoDir, MEM, 'items', 'B.md')), false);
  assert.deepEqual(Object.keys(s.state().items), ['A', 'B']);
});

test('默认分支被强推成非祖先时全量重建', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  put(s.repoDir, card('B'));
  commit(s.repoDir);
  await s.sync();
  git(s.repoDir, 'reset', '-q', '--hard', 'HEAD~1');
  put(s.repoDir, card('Z'));
  const head = commit(s.repoDir);
  assert.deepEqual(await s.sync(), { action: 'rebuild', commit: head, indexed: 2 });
  assert.deepEqual(Object.keys(s.state().items), ['A', 'Z']);
  assert.equal(s.db().next, 3);
});

test('更换 memoryDir 触发全量重建', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  put(s.repoDir, card('X'), 'docs/mem');
  const head = commit(s.repoDir);
  await s.sync();
  assert.deepEqual(await s.sync({ memoryDir: 'docs/mem' }), { action: 'rebuild', commit: head, indexed: 1 });
  assert.deepEqual([s.state().memoryDir, Object.keys(s.state().items)], ['docs/mem', ['X']]);
  assert.equal((await s.sync({ memoryDir: 'docs/mem/' })).action, 'noop');
  assert.throws(() => s.sync({ memoryDir: '../x' }), /memoryDir/);
});

test('空仓库返回 empty 并保存空状态', async t => {
  const s = setup(t);
  assert.deepEqual(await s.sync(), { action: 'empty' });
  assert.deepEqual([s.state().indexedCommit, s.state().items], [null, {}]);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  assert.equal((await s.sync()).action, 'rebuild');
});

test('同步中途失败后不留已索引提交，下一次全量重建', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await s.sync();
  put(s.repoDir, card('D'));
  const head = commit(s.repoDir);
  const broken = new MnemonEngine({ bin: fakeBin(s.root), dataDir: s.dataDir, env: { ...process.env, FAKE_MNEMON_FAIL: 'import' } });
  await assert.rejects(s.sync({ engine: broken }), /mnemon import 失败/);
  assert.equal(s.state().indexedCommit, null);
  assert.deepEqual(await s.sync(), { action: 'rebuild', commit: head, indexed: 2 });
});

test('同一项目的并发同步串行执行', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);
  const actions = (await Promise.all([s.sync(), s.sync(), s.sync()])).map(r => r.action);
  assert.deepEqual(actions, ['rebuild', 'noop', 'noop']);
  assert.equal(s.state().indexedCommit, head);
});

test('ensureSynced 按惰性间隔节流', async t => {
  const s = setup(t);
  const base = new Date('2026-01-01T00:00:00.000Z'), at = seconds => new Date(base.getTime() + seconds * 1000);
  const ensure = (seconds, extra = {}) => ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine, now: at(seconds), ...extra });
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);

  // 没建过索引：立即同步，并尝试拉远端（这里没有 origin，降级）。
  const first = await ensure(0);
  assert.deepEqual([first.action, typeof first.fetchError], ['rebuild', 'string']);
  // 节流期内本地默认分支没动：直接返回，不碰 mnemon，也不拉远端。
  const calls = s.calls().length;
  assert.deepEqual(await ensure(30), { action: 'throttled', commit: head });
  assert.equal(s.calls().length, calls);
  assert.equal(s.state().lastCheckedAt, at(0).toISOString());
  // 节流期内本地默认分支动了：同步，但不拉远端。
  put(s.repoDir, card('B'));
  const next = commit(s.repoDir);
  assert.deepEqual(await ensure(31), { action: 'incremental', commit: next, indexed: 2 });
  // 过了间隔：带远端拉取同步。
  const late = await ensure(31 + 61);
  assert.deepEqual([late.action, typeof late.fetchError], ['noop', 'string']);
  // lazySyncSeconds 为 0：每次都同步；换 memoryDir 即使在节流期内也重建。
  assert.equal((await ensure(31 + 61, { lazySyncSeconds: 0 })).action, 'noop');
  assert.equal((await ensure(31 + 62, { memoryDir: 'docs/mem' })).action, 'rebuild');
});

// 包一层引擎，只覆盖 overrides 里的方法（MnemonEngine 有私有成员，不能用原型继承）。
const wrap = (engine, overrides) => new Proxy(engine, { get: (target, key) => overrides[key] ?? (typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });

test('动索引之前先落盘未完成标记，中断后下一次（含 ensureSynced）自动重建', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await s.sync();
  put(s.repoDir, card('B'));
  const head = commit(s.repoDir);
  let seen;
  const dying = wrap(s.engine, { importCards: async () => { seen = s.state().indexedCommit; throw new Error('中断'); } });
  await assert.rejects(s.sync({ engine: dying }), /中断/);
  assert.equal(seen, null);
  assert.equal(s.state().indexedCommit, null);
  // 节流期内也不会把中断的状态当成有效索引。
  const synced = await ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine });
  assert.deepEqual([synced.action, synced.commit, synced.indexed], ['rebuild', head, 2]);
});

test('ensureSynced 的判断与同步在同一把锁里：等正在进行的同步结束再判断', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await s.sync();
  put(s.repoDir, card('B'));
  const head = commit(s.repoDir);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const slow = wrap(s.engine, { importCards: async cards => { entered(); await gate; return s.engine.importCards(cards); } });
  const running = s.sync({ engine: slow });
  await started;
  const ensured = ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine });
  release();
  assert.equal((await running).action, 'incremental');
  assert.deepEqual(await ensured, { action: 'throttled', commit: head });
});

test('fetchRemote 用显式 refspec，仓库自带的 remote.origin.fetch 改写 refs/heads 也不受影响', async t => {
  const s = setup(t), remote = initRepo(join(s.root, 'remote.git'), true);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  git(s.repoDir, 'remote', 'add', 'origin', remote);
  git(s.repoDir, 'push', '-q', 'origin', 'main');
  git(s.repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
  assert.equal((await s.sync()).action, 'rebuild');

  const other = join(s.root, 'other');
  execFileSync('git', ['clone', '-q', remote, other]);
  for (const [key, value] of [['user.name', 'o'], ['user.email', 'o@example.com'], ['commit.gpgsign', 'false']]) git(other, 'config', key, value);
  put(other, card('B'));
  const remoteHead = commit(other);
  git(other, 'push', '-q', 'origin', 'main');

  const localHead = git(s.repoDir, 'rev-parse', 'HEAD');
  const result = await s.sync({ fetchRemote: true });
  assert.deepEqual([result.action, result.commit, result.fetchError], ['incremental', remoteHead, undefined]);
  assert.equal(git(s.repoDir, 'rev-parse', 'refs/heads/main'), localHead);
  assert.equal(git(s.repoDir, 'rev-parse', 'refs/remotes/origin/main'), remoteHead);
  assert.equal(git(s.repoDir, 'rev-parse', 'HEAD'), localHead);
});

test('数据库文件缺失（目录还在）时重建，节流短路路径也一样', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);
  await s.sync();
  const dbFile = join(s.dataDir, 'data', 'default', 'mnemon.db');
  rmSync(dbFile);
  assert.deepEqual(await s.sync(), { action: 'rebuild', commit: head, indexed: 1 });
  rmSync(dbFile);
  const ensure = () => ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine });
  assert.deepEqual(await ensure(), { action: 'rebuild', commit: head, indexed: 1 });
  assert.deepEqual(await ensure(), { action: 'throttled', commit: head });
});

test('卡片 id 是 __proto__、constructor 这类名字也照常索引', async t => {
  const s = setup(t);
  put(s.repoDir, card('__proto__'));
  put(s.repoDir, card('constructor', { related: ['__proto__'] }));
  put(s.repoDir, card('A', { related: ['__proto__'] }));
  const head = commit(s.repoDir);
  assert.deepEqual(await s.sync(), { action: 'rebuild', commit: head, indexed: 3 });
  const saved = () => JSON.parse(readFileSync(join(projectDir(s.stateDir, PROJECT), 'sync-state.json'), 'utf8')).items;
  assert.deepEqual(Object.keys(saved()).sort(), ['A', '__proto__', 'constructor']);
  assert.equal(Object.hasOwn(saved(), '__proto__'), true);
  const first = saved()['__proto__'].mnemonId;

  put(s.repoDir, card('__proto__', { body: '改过', updated_at: '2026-02-01T00:00:00.000Z' }));
  commit(s.repoDir);
  assert.equal((await s.sync()).action, 'incremental');
  assert.deepEqual(Object.keys(saved()).sort(), ['A', '__proto__', 'constructor']);
  assert.notEqual(saved()['__proto__'].mnemonId, first);
  assert.equal((await s.engine.search({ query: '改过' })).length, 1);
  assert.equal((await s.sync()).action, 'noop');
});

test('同一对端点上矛盾与相关并存：增量 link 只补一条，元数据合并', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await s.sync();
  put(s.repoDir, card('B', { contradicts: ['A'], related: ['A'] }));
  commit(s.repoDir);
  assert.equal((await s.sync()).action, 'incremental');
  assert.deepEqual(s.db().edges.map(e => [e.from, e.to, e.type, e.meta]), [['m2', 'm1', 'semantic', { relation: 'contradicts,related' }]]);
});

test('空仓库分支清空索引前先落盘未完成标记', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await s.sync();
  git(s.repoDir, 'update-ref', '-d', 'refs/heads/main');
  let seen;
  const probe = wrap(s.engine, { resetStore: async () => { seen = s.state().indexedCommit; return s.engine.resetStore(); } });
  assert.deepEqual(await s.sync({ engine: probe }), { action: 'empty' });
  assert.equal(seen, null);
  assert.deepEqual([s.state().indexedCommit, s.state().items], [null, {}]);
});

test('ensureSynced 对非法 memoryDir 返回 rejected Promise 而不是同步抛', async t => {
  const s = setup(t);
  let promise;
  assert.doesNotThrow(() => { promise = ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine, memoryDir: '../x' }); });
  await assert.rejects(promise, /memoryDir/);
});

test('缺少 origin/HEAD 时先问远端的默认分支：本地 main、远端 master 也能首次拉取', async t => {
  const s = setup(t), remote = initRepo(join(s.root, 'remote.git'), true, 'master');
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  git(s.repoDir, 'remote', 'add', 'origin', remote);

  const other = initRepo(join(s.root, 'other'), false, 'master');
  git(other, 'remote', 'add', 'origin', remote);
  put(other, card('B'));
  const remoteHead = commit(other);
  git(other, 'push', '-q', 'origin', 'master');

  const localHead = git(s.repoDir, 'rev-parse', 'HEAD');
  const result = await s.sync({ fetchRemote: true });
  assert.deepEqual([result.action, result.commit, result.fetchError], ['rebuild', remoteHead, undefined]);
  assert.deepEqual(Object.keys(s.state().items), ['B']);
  assert.equal(git(s.repoDir, 'rev-parse', 'refs/remotes/origin/master'), remoteHead);
  assert.equal(git(s.repoDir, 'rev-parse', 'refs/heads/main'), localHead);
  assert.equal(git(s.repoDir, 'branch', '--list', 'master'), '');
  assert.equal(git(s.repoDir, 'branch', '--list', '-r', 'origin/main'), '');
});

// 远端有 origin 的研究仓：remote 是裸仓，other 是推送用的另一份克隆。
const withRemote = (s, remoteBranch) => {
  const remote = initRepo(join(s.root, 'remote.git'), true, remoteBranch), other = initRepo(join(s.root, 'other'), false, remoteBranch);
  git(other, 'remote', 'add', 'origin', remote);
  git(s.repoDir, 'remote', 'add', 'origin', remote);
  return { remote, other, push: () => git(other, 'push', '-q', 'origin', remoteBranch) };
};

test('远端默认分支是 trunk 且没有 origin/HEAD、本地检出 feature 时，索引的是 origin/trunk 而不是 feature', async t => {
  const s = setup(t), { other, push } = withRemote(s, 'trunk');
  put(other, card('T1'));
  const trunk = commit(other);
  push();
  git(s.repoDir, 'checkout', '-q', '-b', 'feature');
  put(s.repoDir, card('F1'));
  commit(s.repoDir);

  const result = await s.sync({ fetchRemote: true });
  assert.deepEqual([result.action, result.commit, result.fetchError], ['rebuild', trunk, undefined]);
  assert.deepEqual(Object.keys(s.state().items), ['T1']);
  // 之后不拉远端的读取路径也认 trunk，不会来回重建。
  const ensure = () => ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine });
  assert.deepEqual(await ensure(), { action: 'throttled', commit: trunk });
});

test('没拉过远端、也没有明确的默认分支时，不把检出的功能分支当默认分支索引', async t => {
  const s = setup(t);
  git(s.repoDir, 'checkout', '-q', '-b', 'feature');
  put(s.repoDir, card('F1'));
  commit(s.repoDir);
  git(s.repoDir, 'branch', '-m', 'feature', 'dev');
  assert.deepEqual(await s.sync(), { action: 'empty' });
  assert.equal(s.state().indexedCommit, null);
});

test('远端切换默认分支导致本地 origin/HEAD 陈旧时，同步到新的默认分支', async t => {
  const s = setup(t), { remote, other, push } = withRemote(s, 'main');
  put(other, card('M1'));
  const main = commit(other);
  push();
  git(s.repoDir, 'fetch', '-q', 'origin');
  git(s.repoDir, 'remote', 'set-head', 'origin', 'main');
  assert.equal((await s.sync({ fetchRemote: true })).commit, main);

  git(other, 'checkout', '-q', '-b', 'trunk');
  put(other, card('T1'));
  const trunk = commit(other);
  git(other, 'push', '-q', 'origin', 'trunk');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  assert.equal(git(s.repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');

  const result = await s.sync({ fetchRemote: true });
  assert.deepEqual([result.action, result.commit], ['incremental', trunk]);
  assert.deepEqual(Object.keys(s.state().items), ['M1', 'T1']);
  assert.equal(git(s.repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/trunk');
  assert.equal((await s.sync()).action, 'noop');
});

test('向量配置或记忆目录变化会让指纹变化：noop 与节流短路都改为全量重建', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);
  const engineWith = embedding => new MnemonEngine({ bin: fakeBin(s.root), dataDir: s.dataDir, env: process.env, embedding });
  const none = engineWith({ embeddingProvider: 'none', embeddingBaseUrl: 'ignored' });
  assert.equal((await s.sync({ engine: none })).action, 'rebuild');
  assert.equal(s.state().indexConfigKey, none.indexConfigKey(MEM));
  // none 时地址、模型不参与指纹。
  assert.equal((await s.sync({ engine: engineWith({}) })).action, 'noop');

  const ollama = engineWith({ embeddingProvider: 'ollama', embeddingBaseUrl: 'http://127.0.0.1:11434', embeddingModel: 'a' });
  assert.deepEqual(await s.sync({ engine: ollama }), { action: 'rebuild', commit: head, indexed: 1 });
  assert.equal((await s.sync({ engine: ollama })).action, 'noop');
  const ensure = engine => ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine });
  assert.deepEqual(await ensure(ollama), { action: 'throttled', commit: head });
  for (const next of [{ embeddingModel: 'b' }, { embeddingBaseUrl: 'http://127.0.0.1:11435' }, { embeddingProvider: 'openai-compatible' }]) {
    const changed = engineWith({ embeddingProvider: 'ollama', embeddingBaseUrl: 'http://127.0.0.1:11434', embeddingModel: 'a', ...next });
    assert.deepEqual(await ensure(changed), { action: 'rebuild', commit: head, indexed: 1 }, JSON.stringify(next));
    assert.deepEqual(await ensure(changed), { action: 'throttled', commit: head });
    await s.sync({ engine: ollama });
  }
});

test('同步状态文件结构无效（缺字段、类型错）时视作失效并全量重建，不抛 TypeError', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  const head = commit(s.repoDir);
  await s.sync();
  const file = join(projectDir(s.stateDir, PROJECT), 'sync-state.json');
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const broken = [
    { ...good, items: null },
    { ...good, items: [] },
    { ...good, items: { A: { mnemonId: 'm1', path: 'p' } } },
    { ...good, items: { A: { ...good.items.A, card: { ...good.items.A.card, contradicts: 'B' } } } },
    { ...good, indexedCommit: 5 },
    // 单个字段缺失（缺 tags、缺 created_at）或键与卡片 id 不一致，也是残缺状态。
    { ...good, items: { A: { ...good.items.A, card: Object.fromEntries(Object.entries(good.items.A.card).filter(([key]) => key !== 'tags')) } } },
    { ...good, items: { A: { ...good.items.A, card: Object.fromEntries(Object.entries(good.items.A.card).filter(([key]) => key !== 'created_at')) } } },
    { ...good, items: { B: good.items.A } },
    { ...good, items: { A: { ...good.items.A, card: { ...good.items.A.card, importance: 9 } } } },
    { ...good, version: 2 },
    [],
    null,
  ];
  for (const state of broken) {
    writeFileSync(file, JSON.stringify(state));
    assert.deepEqual(await s.sync(), { action: 'rebuild', commit: head, indexed: 1 }, JSON.stringify(state)?.slice(0, 60));
  }
  writeFileSync(file, '{"version":1,"items":');
  const ensured = await ensureSynced({ projectId: PROJECT, repoDir: s.repoDir, stateDir: s.stateDir, engine: s.engine });
  assert.deepEqual([ensured.action, ensured.commit], ['rebuild', head]);
});

test('远端没有 HEAD 指向、本地也没有认可的默认分支时，不猜 main：返回未确认并记下原因', async t => {
  const s = setup(t), remote = initRepo(join(s.root, 'remote.git'), true);
  git(s.repoDir, 'checkout', '-q', '-b', 'feature');
  put(s.repoDir, card('F1'));
  commit(s.repoDir);
  git(s.repoDir, 'remote', 'add', 'origin', remote);
  const fetched = await fetchRemote(s.repoDir);
  assert.deepEqual([fetched.commit, fetched.ref, typeof fetched.error], [undefined, undefined, 'string']);
  assert.equal(git(s.repoDir, 'branch', '--list', '-r'), '');
  assert.deepEqual([(await s.sync({ fetchRemote: true })).action, s.state().indexedCommit], ['empty', null]);
});

test('skipIfNoCards：拉远端、判断有没有卡片、同步在同一把项目锁里，没有卡片且没建过索引时什么都不建', async t => {
  const s = setup(t), { other, push } = withRemote(s, 'main');
  put(other, card('R0'));
  commit(other);
  push();
  git(s.repoDir, 'fetch', '-q', 'origin');
  git(s.repoDir, 'remote', 'set-head', 'origin', 'main');
  // 本地 main 没有卡片，远端有：锁内拉到远端后才判断，所以不会被跳过。
  git(s.repoDir, 'update-ref', '-d', 'refs/heads/main');
  git(s.repoDir, 'checkout', '-q', '--orphan', 'work');
  const synced = await s.sync({ fetchRemote: true, skipIfNoCards: true });
  assert.deepEqual([synced.action, synced.indexed], ['rebuild', 1]);

  const empty = setup(t);
  assert.deepEqual(await empty.sync({ skipIfNoCards: true }), { action: 'skipped' });
  assert.equal(existsSync(join(projectDir(empty.stateDir, PROJECT), 'sync-state.json')), false);
  assert.equal(existsSync(join(projectDir(empty.stateDir, PROJECT), 'mnemon')), false);
});

test('skipIfNoCards：engine 是工厂函数，空项目不调用它（缺 mnemon 也能跳过），有卡片时才调用', async t => {
  const s = setup(t);
  const missing = () => { throw Object.assign(new Error('找不到 mnemon'), { code: 'mnemon_missing' }); };
  assert.deepEqual(await s.sync({ engine: missing, skipIfNoCards: true }), { action: 'skipped' });
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await assert.rejects(s.sync({ engine: missing, skipIfNoCards: true }), { code: 'mnemon_missing' });
  assert.equal((await s.sync({ engine: () => s.engine, skipIfNoCards: true })).action, 'rebuild');
});

test('skipIfNoCards：状态文件在但损坏、卡片已删光时仍进入重建清理旧库，不跳过', async t => {
  const s = setup(t);
  put(s.repoDir, card('A'));
  commit(s.repoDir);
  await s.sync();
  assert.equal(existsSync(join(s.dataDir, 'data', 'default', 'mnemon.db')), true);
  drop(s.repoDir, 'A');
  const head = commit(s.repoDir);
  writeFileSync(join(projectDir(s.stateDir, PROJECT), 'sync-state.json'), '{"version":1,');
  assert.deepEqual(await s.sync({ skipIfNoCards: true }), { action: 'rebuild', commit: head, indexed: 0 });
  assert.equal(existsSync(join(s.dataDir, 'data', 'default', 'mnemon.db')), false);
  assert.deepEqual([s.state().indexedCommit, s.state().items], [head, {}]);
  // 状态文件没了、库目录还在（上次没清干净）：同样不算从未建库。
  rmSync(join(projectDir(s.stateDir, PROJECT), 'sync-state.json'));
  assert.equal((await s.sync({ skipIfNoCards: true })).action, 'rebuild');
});

test('锁内拉远端：等前一个同步结束后才拉取，索引不会回退到旧提交', async t => {
  const s = setup(t), { other, push } = withRemote(s, 'main');
  put(other, card('R0'));
  commit(other);
  push();
  await s.sync({ fetchRemote: true });
  put(other, card('R1'));
  commit(other);
  push();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  put(other, card('R2'));
  const newest = commit(other);
  const slow = wrap(s.engine, { resetStore: async () => { entered(); await gate; return s.engine.resetStore(); } });
  const first = s.sync({ engine: slow, forceRebuild: true });
  await started;
  const second = s.sync({ fetchRemote: true, skipIfNoCards: true });
  push();
  release();
  await first;
  assert.deepEqual([(await second).commit, s.state().indexedCommit], [newest, newest]);
  assert.deepEqual(Object.keys(s.state().items), ['R0', 'R1', 'R2']);
});

// ---- 真 mnemon ----

test('真 mnemon：同步后能召回，增量修改后召回新内容', async t => {
  const bin = process.env.MNEMON_TEST_BIN || spawnSync('which', ['mnemon'], { encoding: 'utf8' }).stdout.trim();
  if (!bin) return t.skip('没有 mnemon 可执行文件（设置 MNEMON_TEST_BIN 或放进 PATH）');
  const s = setup(t);
  const engine = new MnemonEngine({ bin, dataDir: s.dataDir, env: buildMnemonEnv({}) });
  put(s.repoDir, card('A', { body: 'Redis 缓存失效策略采用 LRU 淘汰', kind: 'conclusion', tags: ['cache'], entities: ['Redis'] }));
  put(s.repoDir, card('B', { body: '部署流水线每晚凌晨两点触发', supersedes: [] }));
  put(s.repoDir, card('C', { body: '旧的缓存方案已废弃', status: 'archived' }));
  commit(s.repoDir);
  assert.equal((await s.sync({ engine })).action, 'rebuild');
  const { items } = s.state();
  const hits = await engine.recall({ query: 'LRU 缓存淘汰' });
  assert.equal(hits[0].mnemonId, items.A.mnemonId);
  assert.equal((await engine.search({ query: '流水线' }))[0].mnemonId, items.B.mnemonId);
  assert.equal((await engine.search({ query: '废弃' })).length, 0);

  put(s.repoDir, card('A', { body: 'Redis 缓存失效策略改为 TTL 加随机抖动', kind: 'conclusion', updated_at: '2026-02-01T00:00:00.000Z' }));
  put(s.repoDir, card('D', { body: '缓存抖动参数取百分之十', related: ['A'] }));
  commit(s.repoDir);
  assert.equal((await s.sync({ engine })).action, 'incremental');
  const next = s.state().items;
  assert.notEqual(next.A.mnemonId, items.A.mnemonId);
  assert.equal((await engine.search({ query: '抖动' })).length, 2);
  assert.equal((await engine.search({ query: 'LRU' })).length, 0);
  assert.equal((await engine.recall({ query: 'TTL 抖动' }))[0].mnemonId === next.A.mnemonId || (await engine.recall({ query: 'TTL 抖动' }))[0].mnemonId === next.D.mnemonId, true);
});

test('真 mnemon：同一对卡片同时矛盾与相关的增量同步能补边', async t => {
  const bin = process.env.MNEMON_TEST_BIN || spawnSync('which', ['mnemon'], { encoding: 'utf8' }).stdout.trim();
  if (!bin) return t.skip('没有 mnemon 可执行文件（设置 MNEMON_TEST_BIN 或放进 PATH）');
  const s = setup(t);
  const engine = new MnemonEngine({ bin, dataDir: s.dataDir, env: buildMnemonEnv({}) });
  put(s.repoDir, card('A', { body: '盐度对藻类生长的影响实验' }));
  commit(s.repoDir);
  assert.equal((await s.sync({ engine })).action, 'rebuild');
  put(s.repoDir, card('B', { body: '盐度对藻类生长没有影响', contradicts: ['A'], related: ['A'], status: 'contested' }));
  commit(s.repoDir);
  assert.deepEqual([(await s.sync({ engine })).action, s.state().items.B.card.contradicts], ['incremental', ['A']]);
  // 超过 mnemon 上限的标签在规范层就被拒绝，到不了 mnemon。
  assert.throws(() => serializeCard(card('C', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })), /tags 最多 20/);
  const { items } = s.state();
  assert.equal((await engine.search({ query: '盐度' })).length, 2);
  assert.ok(items.A.mnemonId && items.B.mnemonId);
});
