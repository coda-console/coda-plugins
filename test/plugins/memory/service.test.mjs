import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MnemonEngine } from '../../../plugins/memory/lib/mnemon.mjs';
import { projectDir } from '../../../plugins/memory/lib/queue.mjs';
import * as service from '../../../plugins/memory/lib/service.mjs';
import { readSettings } from '../../../plugins/memory/lib/settings.mjs';
import { syncProject } from '../../../plugins/memory/lib/sync.mjs';
import { fakeBin } from './helpers.mjs';

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const PROJECT = 'proj-1';

// 一个研究仓（main 上只有 README）、状态目录和指向假 mnemon 的引擎；merge() 相当于把工作树里的卡片合进 main。
const setup = (t, settings = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo'), stateDir = join(root, 'state');
  mkdirSync(repoDir);
  git(repoDir, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'tester'], ['user.email', 'tester@example.com'], ['commit.gpgsign', 'false']]) git(repoDir, 'config', key, value);
  writeFileSync(join(repoDir, 'README.md'), 'x\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'init');
  const engine = new MnemonEngine({ bin: fakeBin(root), dataDir: join(projectDir(stateDir, PROJECT), 'mnemon'), env: process.env });
  const ctx = { projectId: PROJECT, repoDir, stateDir, settings: readSettings({ 'memory.autoSync': true, ...settings }), engine };
  const merge = () => { git(repoDir, 'add', '-A'); git(repoDir, 'commit', '-q', '-m', 'merge'); return git(repoDir, 'rev-parse', 'HEAD'); };
  return { ctx, repoDir, merge };
};
const remember = (ctx, content, extra = {}) => service.remember(ctx, { content, refs: ['exp-1'], ...extra });
const ids = result => result.items.map(item => item.id);

test('remember、link、archive 的返回形状与落盘位置', async t => {
  const { ctx, repoDir } = setup(t);
  const a = await remember(ctx, '盐度甲', { kind: 'fact' });
  assert.equal(a.created, true);
  assert.equal(a.status, 'active');
  assert.equal(a.path, `.memory/items/${a.id}.md`);
  assert.equal(a.card.content, '盐度甲');
  assert.match(readFileSync(join(repoDir, a.path), 'utf8'), /^---\nid: /);
  const b = await remember(ctx, '盐度乙');
  assert.deepEqual((await service.link(ctx, { from: a.id, to: b.id, relation: 'related' })).changed.sort(), [a.id, b.id].sort());
  assert.deepEqual(await service.archive(ctx, { id: a.id, reason: '重复' }), { id: a.id, path: a.path, status: 'archived' });
  await assert.rejects(service.archive(ctx, { id: 'nope' }), /卡片不存在/);
});

test('草稿默认立刻可见，includeDrafts:false 排除，合并进 main 后 draft 变 false', async t => {
  const { ctx, merge } = setup(t);
  const a = await remember(ctx, '盐度实验的结论甲');

  const recalled = await service.recall(ctx, { query: '盐度' });
  assert.deepEqual(ids(recalled), [a.id]);
  assert.equal(recalled.items[0].draft, true);
  assert.equal(recalled.items[0].content, '盐度实验的结论甲');
  assert.deepEqual(recalled.items[0].refs, ['exp-1']);
  assert.equal(recalled.draftCount, 1);
  assert.deepEqual(ids(await service.search(ctx, { query: '盐度' })), [a.id]);
  assert.equal((await service.search(ctx, {})).items[0].draft, true);
  const got = await service.get(ctx, { id: a.id });
  assert.equal(got.draft, true);
  assert.equal(got.card.content, '盐度实验的结论甲');

  assert.deepEqual((await service.recall(ctx, { query: '盐度', includeDrafts: false })).items, []);
  assert.deepEqual((await service.search(ctx, { includeDrafts: false })).items, []);
  await assert.rejects(service.get(ctx, { id: a.id, includeDrafts: false }), { code: 'not_found' });

  const commit = merge();
  const merged = await service.recall(ctx, { query: '盐度' });
  assert.equal(merged.indexedCommit, commit);
  assert.equal(merged.draftCount, 0);
  assert.equal(merged.items[0].draft, false);
  assert.equal(merged.items[0].matchedVia, 'keyword');
  assert.equal(merged.items[0].score, 0.5);
  assert.equal((await service.get(ctx, { id: a.id })).draft, false);
  assert.equal((await service.search(ctx, { query: '盐度' })).items[0].draft, false);
  assert.deepEqual(ids(await service.recall(ctx, { query: '盐度', includeDrafts: false })), [a.id]);
  await assert.rejects(service.get(ctx, { id: 'missing' }), { code: 'not_found' });
});

test('草稿覆盖 main 的同 id 版本（appendToId 补来源），草稿删除的卡片被隐藏', async t => {
  const { ctx, repoDir, merge } = setup(t);
  const a = await remember(ctx, '盐度甲');
  const b = await remember(ctx, '盐度乙');
  merge();
  assert.deepEqual((await service.get(ctx, { id: a.id })).card.refs, ['exp-1']);

  const appended = await service.remember(ctx, { appendToId: a.id, refs: ['exp-2'] });
  assert.equal(appended.created, false);
  assert.equal(appended.id, a.id);
  const draft = (await service.recall(ctx, { query: '盐度' })).items.find(item => item.id === a.id);
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.refs, ['exp-1', 'exp-2']);
  assert.deepEqual((await service.get(ctx, { id: a.id, includeDrafts: false })).card.refs, ['exp-1']);
  merge();
  const after = (await service.recall(ctx, { query: '盐度' })).items.find(item => item.id === a.id);
  assert.equal(after.draft, false);
  assert.deepEqual(after.refs, ['exp-1', 'exp-2']);

  rmSync(join(repoDir, b.path));
  assert.deepEqual(ids(await service.recall(ctx, { query: '盐度' })), [a.id]);
  assert.deepEqual(ids(await service.search(ctx, {})), [a.id]);
  await assert.rejects(service.get(ctx, { id: b.id }), { code: 'not_found' });
  assert.equal((await service.get(ctx, { id: b.id, includeDrafts: false })).card.id, b.id);
});

test('supersedes：默认不返回被取代的卡片，includeSuperseded 放开并带 superseded 标记', async t => {
  const { ctx, merge } = setup(t);
  const a = await remember(ctx, '盐度旧结论');
  merge();
  const b = await remember(ctx, '盐度新结论', { supersedes: [a.id] });

  for (const stage of ['草稿', '已合并']) {
    if (stage === '已合并') merge();
    assert.deepEqual(ids(await service.recall(ctx, { query: '盐度' })), [b.id], stage);
    const all = await service.recall(ctx, { query: '盐度', includeSuperseded: true });
    assert.deepEqual(Object.fromEntries(all.items.map(item => [item.id, item.superseded])), { [a.id]: true, [b.id]: false }, stage);
    const got = await service.get(ctx, { id: a.id });
    assert.equal(got.card.status, 'superseded');
    assert.deepEqual(got.neighbors.supersededBy, [{ id: b.id, status: 'active', refs: ['exp-1'] }]);
    assert.deepEqual((await service.get(ctx, { id: b.id })).neighbors.supersedes.map(item => item.id), [a.id]);
  }
});

test('contradicts：双向附带对立卡片及其出处', async t => {
  const { ctx, merge } = setup(t);
  const a = await remember(ctx, '盐度升高', { refs: ['paper-a'] });
  merge();
  const b = await remember(ctx, '盐度降低', { refs: ['paper-b'], contradicts: [a.id] });

  for (const stage of ['草稿', '已合并']) {
    if (stage === '已合并') merge();
    const draft = stage === '草稿';
    const items = Object.fromEntries((await service.recall(ctx, { query: '盐度' })).items.map(item => [item.id, item]));
    assert.equal(items[a.id].status, 'contested', stage);
    assert.deepEqual(items[a.id].contradictions, [{ id: b.id, status: 'contested', content: '盐度降低', refs: ['paper-b'], draft }], stage);
    assert.deepEqual(items[b.id].contradictions, [{ id: a.id, status: 'contested', content: '盐度升高', refs: ['paper-a'], draft }], stage);
    assert.deepEqual((await service.get(ctx, { id: a.id })).card.contradictions.map(item => item.id), [b.id], stage);
    assert.deepEqual((await service.search(ctx, { query: '升高' })).items[0].contradictions.map(item => item.id), [b.id], stage);
  }
  // 对立卡片归档后：它自己仍带着指向的卡片；指向它的一方因自己的 contradicts 还在，仍能看到它，状态是 archived。
  await service.archive(ctx, { id: b.id, reason: '撤回' });
  assert.deepEqual((await service.get(ctx, { id: a.id })).card.contradictions.map(item => [item.id, item.status]), [[b.id, 'archived']]);
});

test('archive：默认检索隐藏，get 与 search(status:archived) 仍可审计', async t => {
  const { ctx, merge } = setup(t);
  const a = await remember(ctx, '盐度应当归档');
  const b = await remember(ctx, '盐度保留');
  merge();
  await service.archive(ctx, { id: a.id, reason: '重复' });

  for (const stage of ['草稿', '已合并']) {
    if (stage === '已合并') merge();
    assert.deepEqual(ids(await service.recall(ctx, { query: '盐度' })), [b.id], stage);
    assert.deepEqual(ids(await service.search(ctx, { query: '盐度' })), [b.id], stage);
    assert.deepEqual(ids(await service.search(ctx, {})), [b.id], stage);
    assert.deepEqual(ids(await service.search(ctx, { status: 'archived' })), [a.id], stage);
    assert.deepEqual(ids(await service.search(ctx, { query: '盐度', status: 'archived' })), [a.id], stage);
    const got = await service.get(ctx, { id: a.id });
    assert.equal(got.card.status, 'archived');
    assert.equal(got.card.archived_reason, '重复');
  }
});

test('search 的过滤条件取交集：kind、status、entity、tag、ref，ref 可用子串', async t => {
  const { ctx } = setup(t);
  const a = await remember(ctx, '甲', { kind: 'fact', entities: ['海水'], tags: ['t1'], refs: ['commit:abc123'] });
  await remember(ctx, '乙', { kind: 'hypothesis', entities: ['海水'], tags: ['t2'], refs: ['https://example.com/x'] });
  assert.equal((await service.search(ctx, {})).items.length, 2);
  assert.deepEqual(ids(await service.search(ctx, { kind: 'fact' })), [a.id]);
  assert.deepEqual(ids(await service.search(ctx, { entity: '海水', tag: 't1' })), [a.id]);
  assert.deepEqual(ids(await service.search(ctx, { ref: 'abc12' })), [a.id]);
  assert.deepEqual(ids(await service.search(ctx, { ref: 'commit:abc123' })), [a.id]);
  assert.deepEqual(await service.search(ctx, { entity: '海水', tag: 't1', kind: 'hypothesis' }).then(ids), []);
  assert.deepEqual(await service.search(ctx, { status: 'contested' }).then(ids), []);
  assert.equal((await service.search(ctx, {})).items.length, 2);
  assert.equal((await service.search(ctx, { limit: 1 })).items.length, 1);
  // 草稿的实体、标签也参与关键词匹配。
  assert.equal((await service.recall(ctx, { query: 't2' })).items.length, 1);
});

test('autoSync 关闭：只在没建过索引时同步一次；离线（没有 origin）不挡读取', async t => {
  const { ctx, merge } = setup(t, { 'memory.autoSync': false });
  const a = await remember(ctx, '盐度甲');
  const first = merge();
  assert.equal((await service.recall(ctx, { query: '盐度' })).indexedCommit, first);
  const b = await remember(ctx, '盐度乙');
  merge();
  const later = await service.recall(ctx, { query: '盐度' });
  assert.equal(later.indexedCommit, first);
  // 新合并的卡片尚未进索引，但相对索引提交它仍是草稿，所以还是看得到。
  assert.deepEqual(later.items.map(item => [item.id, item.draft]).sort(), [[a.id, false], [b.id, true]].sort());
});

test('autoSync 关闭后切换 memoryDir：不返回旧目录的卡片，自动本地重建新目录的索引', async t => {
  const { ctx, repoDir, merge } = setup(t, { 'memory.autoSync': false });
  const a = await remember(ctx, '盐度甲');
  merge();
  assert.deepEqual(ids(await service.recall(ctx, { query: '盐度' })), [a.id]);

  const moved = { ...ctx, settings: readSettings({ 'memory.autoSync': false, 'memory.memoryDir': 'notes' }) };
  const b = await remember(moved, '盐度乙');
  assert.equal(b.path, `notes/items/${b.id}.md`);
  const head = merge();
  for (const stage of ['含草稿', '不含草稿']) {
    const recalled = await service.recall(moved, { query: '盐度', includeDrafts: stage === '含草稿' });
    assert.deepEqual(ids(recalled), [b.id], stage);
    assert.equal(recalled.indexedCommit, head, stage);
    assert.deepEqual(ids(await service.search(moved, { includeDrafts: stage === '含草稿' })), [b.id], stage);
  }
  const state = JSON.parse(readFileSync(join(projectDir(ctx.stateDir, PROJECT), 'sync-state.json'), 'utf8'));
  assert.equal(state.memoryDir, 'notes');
  assert.deepEqual(Object.keys(state.items), [b.id]);
  assert.ok(repoDir);
});

test('autoSync 关闭后切换向量配置：索引配置不一致时本地重建', async t => {
  const { ctx, merge } = setup(t, { 'memory.autoSync': false });
  await remember(ctx, '盐度甲');
  merge();
  await service.recall(ctx, { query: '盐度' });
  const calls = () => readFileSync(join(projectDir(ctx.stateDir, PROJECT), 'mnemon', 'calls.jsonl'), 'utf8').split('\n').filter(line => line.includes('"command":"import"')).length;
  const before = calls();
  await service.recall(ctx, { query: '盐度' });
  assert.equal(calls(), before);
  const embedding = { 'memory.embeddingProvider': 'ollama', 'memory.embeddingBaseUrl': 'http://127.0.0.1:11434', 'memory.embeddingModel': 'm' };
  const switched = { ...ctx, settings: readSettings({ 'memory.autoSync': false, ...embedding }), engine: new MnemonEngine({ bin: ctx.engine.bin, dataDir: ctx.engine.dataDir, env: process.env, embedding: readSettings(embedding) }) };
  await service.recall(switched, { query: '盐度' });
  assert.equal(calls(), before + 1);
});

test('recall 先过滤再截断：前几条命中被草稿覆盖或被取代时，动态扩大候选仍返回有效卡', async t => {
  const { ctx, repoDir, merge } = setup(t);
  const a = await remember(ctx, '盐度甲');
  const b = await remember(ctx, '盐度乙');
  const c = await remember(ctx, '盐度丙');
  merge();
  await remember(ctx, '氯度新结论', { supersedes: [b.id] });
  merge();
  // a 在工作树里被改写成不含关键词的草稿：引擎照样把它排在前面，但它不再有效。
  const file = join(repoDir, a.path);
  writeFileSync(file, readFileSync(file, 'utf8').replace('盐度甲', '氯度甲'));

  await service.search(ctx, { query: '盐度' });
  const calls = () => readFileSync(join(projectDir(ctx.stateDir, PROJECT), 'mnemon', 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.command === 'recall');
  const before = calls().length;
  const recalled = await service.recall(ctx, { query: '盐度', limit: 1 });
  assert.deepEqual(ids(recalled), [c.id]);
  assert.deepEqual(calls().slice(before).map(call => call.args[call.args.indexOf('--limit') + 1]), ['2', '4']);
  assert.deepEqual(ids(await service.recall(ctx, { query: '盐度', limit: 1, includeSuperseded: true })), [b.id]);
});

test('草稿改写了主分支的卡片：只按草稿内容匹配，不再按主分支旧内容命中', async t => {
  const { ctx, repoDir, merge } = setup(t);
  const a = await remember(ctx, '盐度甲');
  merge();
  assert.deepEqual(ids(await service.recall(ctx, { query: '盐度' })), [a.id]);
  const file = join(repoDir, a.path);
  writeFileSync(file, readFileSync(file, 'utf8').replace('盐度甲', '氯度乙'));

  assert.deepEqual((await service.recall(ctx, { query: '盐度' })).items, []);
  assert.deepEqual((await service.search(ctx, { query: '盐度' })).items, []);
  const recalled = await service.recall(ctx, { query: '氯度' });
  assert.deepEqual(recalled.items.map(item => [item.id, item.draft, item.content]), [[a.id, true, '氯度乙']]);
  assert.deepEqual((await service.search(ctx, { query: '氯度' })).items.map(item => [item.id, item.draft]), [[a.id, true]]);
});

test('search 先过滤再截断：引擎命中很多时符合过滤条件的卡片也不会漏', async t => {
  const { ctx, merge } = setup(t);
  for (let i = 0; i < 5; i++) await remember(ctx, `盐度观察 ${i}`, { kind: 'observation', tags: ['x'] });
  const fact = await remember(ctx, '盐度事实', { kind: 'fact', tags: ['y'] });
  merge();
  assert.deepEqual(ids(await service.search(ctx, { query: '盐度', kind: 'fact', limit: 1 })), [fact.id]);
  assert.deepEqual(ids(await service.search(ctx, { query: '盐度', tag: 'y', limit: 1 })), [fact.id]);
  assert.equal((await service.search(ctx, { query: '盐度', limit: 2 })).items.length, 2);
});

test('读取与同步在同一把锁里：夹在中间失败的重建不会让未完成的状态被当成主分支卡片返回', async t => {
  const { ctx, repoDir, merge } = setup(t);
  await remember(ctx, '盐度甲');
  merge();
  await service.recall(ctx, { query: '盐度' });
  await remember(ctx, '盐度乙');
  const head = merge();
  const failing = { indexConfigKey: dir => ctx.engine.indexConfigKey(dir), storeExists: () => ctx.engine.storeExists(), resetStore: async () => { throw new Error('boom'); } };

  const read = service.recall(ctx, { query: '盐度' });
  const broken = assert.rejects(syncProject({ ...ctx, memoryDir: '.memory', engine: failing, forceRebuild: true }), /boom/);
  const result = await read;
  await broken;
  assert.equal(result.indexedCommit, head);
  assert.equal(result.items.length, 2);
  assert.ok(repoDir);
});

test('mnemon.db 损坏：读取在同一把锁里全量重建并重试，结果照常返回', async t => {
  const { ctx, repoDir, merge } = setup(t);
  const a = await remember(ctx, '盐度实验的结论甲');
  const commit = merge();
  assert.deepEqual(ids(await service.recall(ctx, { query: '盐度' })), [a.id]);
  const dbFile = join(projectDir(ctx.stateDir, PROJECT), 'mnemon', 'data', 'default', 'mnemon.db');
  const state = () => JSON.parse(readFileSync(join(projectDir(ctx.stateDir, PROJECT), 'sync-state.json'), 'utf8'));
  const calls = () => readFileSync(join(projectDir(ctx.stateDir, PROJECT), 'mnemon', 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).command);

  // 截断：mnemon 报 file is not a database。
  writeFileSync(dbFile, readFileSync(dbFile, 'utf8').slice(0, 10));
  const before = calls().length;
  const hit = await service.recall(ctx, { query: '盐度' });
  assert.deepEqual([ids(hit), hit.indexedCommit], [[a.id], commit]);
  assert.deepEqual(calls().slice(before).filter(command => command === 'import'), ['import']);
  assert.deepEqual(ids(await service.search(ctx, { query: '盐度' })), [a.id]);
  assert.equal(state().indexedCommit, commit);

  // 重试仍失败就抛出，只重建这一次。
  const engineFailing = message => new MnemonEngine({ bin: fakeBin(repoDir), dataDir: join(projectDir(ctx.stateDir, PROJECT), 'mnemon'), env: { ...process.env, FAKE_MNEMON_FAIL: 'recall', FAKE_MNEMON_FAIL_MESSAGE: message } });
  const imports = () => calls().filter(command => command === 'import').length;
  const beforeImports = imports();
  await assert.rejects(service.recall({ ...ctx, engine: engineFailing('database disk image is malformed') }, { query: '盐度' }), { code: 'index_corrupt' });
  assert.equal(imports(), beforeImports + 1);
});

test('只有可重建的数据库损坏才触发重建：权限类错误和别的失败原样上抛', async t => {
  const { ctx, merge } = setup(t);
  await remember(ctx, '盐度实验的结论甲');
  merge();
  await service.recall(ctx, { query: '盐度' });
  const dir = join(projectDir(ctx.stateDir, PROJECT), 'mnemon');
  const imports = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(line => line.includes('"command":"import"')).length;
  const before = imports();
  for (const message of ['unable to open database file: permission denied', 'EACCES: corrupt cache dir', 'out of memory']) {
    const engine = new MnemonEngine({ bin: fakeBin(ctx.repoDir), dataDir: dir, env: { ...process.env, FAKE_MNEMON_FAIL: 'recall', FAKE_MNEMON_FAIL_MESSAGE: message } });
    await assert.rejects(service.recall({ ...ctx, engine }, { query: '盐度' }), error => error.code === undefined && error.message.includes(message), message);
  }
  assert.equal(imports(), before);
});

test('sync-state.json 损坏或结构无效：读取时重建，不抛', async t => {
  const { ctx, merge } = setup(t);
  const a = await remember(ctx, '盐度实验的结论甲');
  const commit = merge();
  await service.recall(ctx, { query: '盐度' });
  const file = join(projectDir(ctx.stateDir, PROJECT), 'sync-state.json');
  for (const text of ['{"version":1,"items":', JSON.stringify({ version: 1, memoryDir: '.memory', indexedCommit: commit, items: { X: {} } })]) {
    writeFileSync(file, text);
    const hit = await service.recall(ctx, { query: '盐度' });
    assert.deepEqual([ids(hit), hit.indexedCommit], [[a.id], commit]);
  }
});
