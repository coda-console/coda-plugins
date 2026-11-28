import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeCard } from '../../../plugins/memory/lib/card.mjs';
import { projectDir } from '../../../plugins/memory/lib/queue.mjs';
import { activate, deactivate } from '../../../plugins/memory/main.mjs';
import { runSyncScript } from '../../../plugins/memory/scripts/sync-project.mjs';
import { fakeBin } from './helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../../../plugins/memory/scripts/sync-project.mjs', import.meta.url));
const INSTRUCTIONS = fileURLToPath(new URL('../../../plugins/memory/scripts/instructions.mjs', import.meta.url));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what) {
  for (let i = 0; i < 1000; i++) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`等不到：${what}`);
}

const tmp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const initRepo = dir => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'tester'], ['user.email', 'tester@example.com'], ['commit.gpgsign', 'false']]) git(dir, 'config', key, value);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
};
const card = id => ({ id, kind: 'fact', refs: ['r'], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', body: `盐度 ${id}` });
const putCard = (repoDir, c) => {
  mkdirSync(join(repoDir, '.memory', 'items'), { recursive: true });
  writeFileSync(join(repoDir, '.memory', 'items', `${c.id}.md`), serializeCard(c));
};
const commitAll = dir => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c'); return git(dir, 'rev-parse', 'HEAD'); };
const syncState = (stateDir, projectId) => {
  try { return JSON.parse(readFileSync(join(projectDir(stateDir, projectId), 'sync-state.json'), 'utf8')); } catch { return null; }
};

// 假宿主：只做插件用到的那部分。records 是 replace 的每次全量发布；handlers、listeners 是登记的处理函数。
function fakeHost(t, { settings = {}, workspaces = {}, onForbidden = false, machines = [{ id: 'm-1', local: true, spec: { name: '测试机' } }] } = {}) {
  const root = tmp(t), stateDir = join(root, 'state');
  const bin = fakeBin(root);
  const host = {
    root, stateDir, records: [], handlers: new Map(), listeners: new Map(), disposed: 0, settingsListeners: [], watchers: [],
    current: { 'memory.mnemonPath': bin, ...settings },
    coda: {
      plugin: { id: 'memory', state: stateDir },
      error: (code, message, { effects } = {}) => Object.assign(new Error(message), { code, effects }),
      replace: async (kind, items) => { host.records.push({ kind, items: structuredClone(items) }); },
      handle: (kind, operation, fn) => { host.handlers.set(`${kind}#${operation}`, fn); return { dispose() { host.disposed++; } }; },
      on: (name, fn) => {
        if (onForbidden) throw Object.assign(new Error('没有声明可用的事件'), { code: 'forbidden' });
        host.listeners.set(name, fn);
        return { dispose() { host.disposed++; } };
      },
      watch: async (kind, fn, options) => {
        host.watchers.push({ kind, options });
        for (const entry of machines) fn({ type: 'ADDED', entry });
        return { dispose() { host.disposed++; } };
      },
      list: async () => machines,
      query: async (ref, operation) => {
        assert.equal(operation, 'workspace');
        const workspace = workspaces[ref.id];
        if (!workspace) throw Object.assign(new Error('没有这个会话'), { code: 'not_found' });
        return workspace;
      },
      settings: {
        get: async () => host.current,
        onChange: fn => { host.settingsListeners.push(fn); return { dispose() { host.disposed++; } }; },
      },
    },
    call: (operation, input, caller) => host.handlers.get(`memory/engine@1#${operation}`)(input, { caller }),
    last: () => host.records.at(-1).items,
  };
  return host;
}
const caller = { machine: 'm-1', parent: { kind: 'coda/thread@1', id: 't-1' } };
const ready = (repoDir, extra = {}) => ({ path: repoDir, project: { id: 'proj-1', name: 'demo' }, state: 'ready', ...extra });

async function start(t, options = {}, activateOptions) {
  const host = fakeHost(t, options);
  await activate(host.coda, activateOptions);
  t.after(() => deactivate());
  return host;
}

test('本机恰好发布 1 条引擎记录，用机器名与 mnemon 就绪状态', async t => {
  const host = await start(t);
  assert.equal(host.records.length, 1);
  assert.equal(host.records[0].kind, 'memory/engine@1');
  assert.deepEqual(host.last(), [{ key: 'local', spec: { name: '测试机', status: '就绪', projects: 0 }, status: { ready: true } }]);
  assert.deepEqual(host.watchers, [{ kind: 'coda/machine@1', options: { scope: 'local' } }]);
  assert.deepEqual([...host.handlers.keys()].map(key => key.split('#')[1]).sort(), ['archive', 'get', 'link', 'recall', 'remember', 'search']);
  assert.ok(host.listeners.has('pull_request.closed'));
});

test('找不到 mnemon 时记录标成未就绪；设置变化后重新发布', async t => {
  const host = await start(t, { settings: { 'memory.mnemonPath': join(tmp(t), 'none') } }, { env: { PATH: '' } });
  assert.equal(host.last()[0].status.ready, false);
  assert.equal(host.last()[0].spec.status, '缺少 mnemon');
  host.settingsListeners[0]({ 'memory.mnemonPath': fakeBin(tmp(t)) });
  await waitFor(() => host.records.length === 2, '设置变化后重新发布');
  assert.equal(host.last()[0].status.ready, true);
  assert.equal(host.records.length, 2);
});

test('跨机调用被 forbidden 拒绝；本机号未知时向 coda.list 取', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { workspaces: { 't-1': ready(repoDir) } });
  await assert.rejects(host.call('recall', { query: '盐度' }, { ...caller, machine: 'm-2' }), { code: 'forbidden', message: /本机/ });
  assert.deepEqual((await host.call('recall', { query: '盐度' }, caller)).items, []);

  const unwatched = await start(t, { machines: [], workspaces: { 't-1': ready(repoDir) } });
  await assert.rejects(unwatched.call('recall', { query: '盐度' }, caller), { code: 'forbidden' });
});

test('调用方的机器号缺失（undefined、null、空串、没有 caller）：6 个操作都 forbidden，不查工作区、不写文件', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = fakeHost(t, { workspaces: { 't-1': ready(repoDir) } });
  let queries = 0;
  const query = host.coda.query;
  host.coda.query = (...args) => { queries++; return query(...args); };
  await activate(host.coda);
  t.after(() => deactivate());
  const inputs = { recall: { query: '盐度' }, search: {}, get: { id: 'x' }, remember: { content: '盐度', refs: ['r'] }, link: { from: 'a', to: 'b', relation: 'related' }, archive: { id: 'x' } };
  for (const caller_ of [{ parent: caller.parent }, { ...caller, machine: undefined }, { ...caller, machine: null }, { ...caller, machine: '' }, undefined]) {
    for (const [operation, input] of Object.entries(inputs)) {
      await assert.rejects(host.call(operation, input, caller_), { code: 'forbidden', message: /本机/ }, `${operation} ${JSON.stringify(caller_)}`);
    }
  }
  assert.equal(queries, 0);
  assert.equal(existsSync(join(repoDir, '.memory')), false);
  assert.deepEqual(readdirSync(host.stateDir), ['machine-settings.json']);
});

test('会话工作区未就绪或调用方不是会话时报错', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { workspaces: { 't-1': ready(repoDir, { state: 'preparing' }), 't-2': ready('', {}), 't-3': ready(repoDir) } });
  await assert.rejects(host.call('recall', { query: '盐度' }, caller), { code: 'workspace_unavailable', message: /preparing/ });
  await assert.rejects(host.call('recall', { query: '盐度' }, { ...caller, parent: { kind: 'coda/thread@1', id: 't-2' } }), { code: 'workspace_unavailable' });
  await assert.rejects(host.call('recall', { query: '盐度' }, { machine: 'm-1' }), { code: 'no_session' });
  await assert.rejects(host.call('recall', { query: '盐度' }, { machine: 'm-1', parent: { kind: 'coda/workflow@1', id: 'w' } }), { code: 'no_session' });
  assert.equal(host.records.length, 1);
});

test('工具路由：按会话工作区解析研究仓，登记项目并重新发布，错误码透传', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { workspaces: { 't-1': ready(repoDir) } });
  const saved = await host.call('remember', { content: '盐度实验结论', refs: ['exp-1'] }, caller);
  assert.equal(saved.created, true);
  assert.ok(existsSync(join(repoDir, saved.path)));
  await waitFor(() => host.records.length === 2, '项目数变化后重新发布');
  assert.equal(host.last()[0].spec.projects, 1);
  assert.equal(host.records.length, 2);

  const recalled = await host.call('recall', { query: '盐度' }, caller);
  assert.deepEqual(recalled.items.map(item => [item.id, item.draft]), [[saved.id, true]]);
  assert.equal((await host.call('get', { id: saved.id }, caller)).card.content, '盐度实验结论');
  assert.equal((await host.call('search', { query: '盐度' }, caller)).items.length, 1);
  const other = await host.call('remember', { content: '盐度另一条', refs: ['exp-2'] }, caller);
  assert.deepEqual((await host.call('link', { from: saved.id, to: other.id, relation: 'related' }, caller)).changed.length, 2);
  assert.equal((await host.call('archive', { id: other.id }, caller)).status, 'archived');
  await assert.rejects(host.call('get', { id: 'missing' }, caller), { code: 'not_found' });
  assert.equal(host.records.length, 2);
});

test('没有 mnemon 时 remember、link、archive 照常写工作树卡片，读取才报 mnemon_missing', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { settings: { 'memory.mnemonPath': join(tmp(t), 'none') }, workspaces: { 't-1': ready(repoDir) } }, { env: { PATH: '' } });
  // 注入空 PATH：宿主 PATH 上装了 mnemon 也不影响这个用例。
  const a = await host.call('remember', { content: '盐度甲', refs: ['r'] }, caller);
  const b = await host.call('remember', { content: '盐度乙', refs: ['r'] }, caller);
  assert.ok(existsSync(join(repoDir, a.path)));
  assert.equal((await host.call('link', { from: a.id, to: b.id, relation: 'related' }, caller)).changed.length, 2);
  assert.equal((await host.call('archive', { id: b.id }, caller)).status, 'archived');
  for (const [operation, input] of [['recall', { query: '盐度' }], ['search', {}], ['get', { id: a.id }]]) {
    await assert.rejects(host.call(operation, input, caller), { code: 'mnemon_missing' });
  }
});

test('合并的 pull_request.closed 触发已登记项目的异步同步，其余事件忽略', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { workspaces: { 't-1': ready(repoDir) } });
  await host.call('recall', { query: '盐度' }, caller);
  await waitFor(() => syncState(host.stateDir, 'proj-1')?.indexedCommit, '读取时的首次同步');
  const first = syncState(host.stateDir, 'proj-1').indexedCommit;

  putCard(repoDir, card('A1'));
  const merged = commitAll(repoDir);
  const fire = host.listeners.get('pull_request.closed');
  fire({ project: 'proj-1', data: { pull_request: { merged: false } } });
  fire({ project: 'unknown', data: { pull_request: { merged: true } } });
  fire({ project: 'proj-1', data: {} });
  await sleep(300);
  assert.equal(syncState(host.stateDir, 'proj-1').indexedCommit, first);

  assert.equal(fire({ project: 'proj-1', data: { pull_request: { merged: true } } }), undefined);
  await waitFor(() => syncState(host.stateDir, 'proj-1').indexedCommit === merged, '合并事件触发的同步');
  assert.deepEqual(Object.keys(syncState(host.stateDir, 'proj-1').items), ['A1']);
});

test('合并后同步失败只记日志，不抛给宿主', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { workspaces: { 't-1': ready(repoDir) } });
  await host.call('recall', { query: '盐度' }, caller);
  const published = host.records.length;
  host.settingsListeners[0]({ 'memory.mnemonPath': '', 'memory.memoryDir': '/绝对路径' });
  await waitFor(() => host.records.length > published, '设置生效');
  const logs = [], original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    assert.doesNotThrow(() => host.listeners.get('pull_request.closed')({ project: 'proj-1', data: { pull_request: { merged: true } } }));
    await waitFor(() => logs.some(line => line.includes('合并后同步失败')), '失败日志');
  } finally { console.error = original; }
});

test('缺 GitHub 插件时订阅事件被 forbidden，静默降级，工具照常可用', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { onForbidden: true, workspaces: { 't-1': ready(repoDir) } });
  assert.equal(host.listeners.size, 0);
  assert.equal(host.records.length, 1);
  assert.deepEqual((await host.call('recall', { query: '盐度' }, caller)).items, []);
});

test('deactivate 清理全部登记，之后设置变化也不再发布', async t => {
  const host = fakeHost(t);
  await activate(host.coda);
  // 六个处理函数、事件订阅、设置订阅、机器监听。
  deactivate();
  assert.equal(host.disposed, 9);
  const before = host.records.length;
  host.settingsListeners[0]({ 'memory.memoryDir': 'x' });
  await sleep(50);
  assert.equal(host.records.length, before);
});

test('发布失败按退避加倍重试，deactivate 取消等待中的重试', async t => {
  const host = fakeHost(t), timers = [], logs = [], log = console.error;
  host.coda.replace = async () => { throw new Error('宿主忙'); };
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await activate(host.coda, { schedule: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; }, cancel: timer => { if (timer) timer.cleared = true; } });
    assert.deepEqual(timers.map(timer => timer.ms), [5000]);
    timers[0].fn();
    await waitFor(() => timers.length === 2, '第二次重试');
    assert.deepEqual(timers.map(timer => timer.ms), [5000, 10000]);
    deactivate();
    assert.equal(timers[1].cleared, true);
  } finally { console.error = log; deactivate(); }
  assert.equal(logs.filter(line => line.includes('登记记录失败')).length, 2);
});

// ---- 机器层设置 machine-settings.json ----

test('机器层设置原子写入状态目录，不含密钥，设置变化后更新', async t => {
  const host = await start(t, { settings: { 'memory.memoryDir': 'machine-mem', 'memory.embeddingProvider': 'openai-compatible', 'memory.embeddingApiKeyEnv': 'MY_KEY', 'memory.autoSync': false, 'memory.enabled': true } });
  const file = join(host.stateDir, 'machine-settings.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    memoryDir: 'machine-mem', autoSync: false, lazySyncSeconds: 60, mnemonPath: host.current['memory.mnemonPath'],
    embeddingProvider: 'openai-compatible', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKeyEnv: 'MY_KEY',
  });
  host.settingsListeners[0]({ ...host.current, 'memory.memoryDir': 'changed' });
  await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).memoryDir === 'changed', '设置变化后更新');
  assert.deepEqual(readdirSync(host.stateDir), ['machine-settings.json']);
});

test('机器层设置落盘失败：沿用上一份内存设置并记日志，不重新发布；恢复后再次设置生效', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { settings: { 'memory.memoryDir': 'old-mem' }, workspaces: { 't-1': ready(repoDir) } });
  const file = join(host.stateDir, 'machine-settings.json');
  const before = readFileSync(file, 'utf8'), published = host.records.length;
  // 目标位置换成目录：rename 覆盖不了，写入必然失败。
  rmSync(file);
  mkdirSync(file);
  const logs = [], original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    host.settingsListeners[0]({ ...host.current, 'memory.memoryDir': 'new-mem' });
    await waitFor(() => logs.some(line => line.includes('保存机器层设置失败')), '落盘失败的日志');
  } finally { console.error = original; }
  await sleep(50);
  assert.equal(host.records.length, published);
  assert.deepEqual(readdirSync(host.stateDir), ['machine-settings.json']);
  assert.equal((await host.call('remember', { content: '盐度', refs: ['r'] }, caller)).path.startsWith('old-mem/items/'), true);

  rmSync(file, { recursive: true });
  host.settingsListeners[0]({ ...host.current, 'memory.memoryDir': 'new-mem' });
  await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).memoryDir === 'new-mem', '恢复后落盘');
  await waitFor(async () => (await host.call('remember', { content: '盐度二', refs: ['r'] }, caller)).path.startsWith('new-mem/items/'), '内存设置随落盘更新');
  assert.notEqual(before, readFileSync(file, 'utf8'));
});

test('项目目录覆盖了 memory.memoryDir：会话工具、同步脚本、开场说明都用机器层的目录，目录级的 enabled、autoSync 照常生效', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  const host = await start(t, { settings: { 'memory.memoryDir': 'machine-mem' }, workspaces: { 't-1': ready(repoDir) } });
  const saved = await host.call('remember', { content: '盐度实验结论', refs: ['exp'] }, caller);
  assert.equal(saved.path, `machine-mem/items/${saved.id}.md`);
  assert.ok(existsSync(join(repoDir, saved.path)));
  const commit = commitAll(repoDir);

  const directory = { 'memory.enabled': true, 'memory.autoSync': false, 'memory.memoryDir': 'dir-mem' };
  const env = {
    MEMORY_PROJECT_ID: 'proj-1', MEMORY_PROJECTS_JSON: JSON.stringify([{ id: 'proj-1', name: 'demo', path: repoDir }]),
    CODA_PLUGIN_STATE: host.stateDir, CODA_PLUGIN_SETTINGS: JSON.stringify(directory),
    MEMORY_MNEMON_PATH: host.current['memory.mnemonPath'], MEMORY_DIR: 'dir-mem',
  };
  const done = await runSyncScript(env, { argv: ['--no-fetch'] });
  assert.equal(done.result.action, 'rebuild');
  assert.equal(syncState(host.stateDir, 'proj-1').memoryDir, 'machine-mem');
  assert.equal(syncState(host.stateDir, 'proj-1').indexedCommit, commit);
  assert.deepEqual(Object.keys(syncState(host.stateDir, 'proj-1').items), [saved.id]);
  // 会话工具读到的是同一份索引，不会再因目录不一致重建。
  assert.deepEqual((await host.call('recall', { query: '盐度' }, caller)).items.map(item => item.id), [saved.id]);
  assert.equal((await runSyncScript(env, { argv: ['--no-fetch'] })).result.action, 'noop');

  const instructions = settings => spawnSync(process.execPath, [INSTRUCTIONS], {
    encoding: 'utf8', env: { ...process.env, CODA_PLUGIN_STATE: host.stateDir, CODA_PLUGIN_SETTINGS: JSON.stringify(settings) },
  });
  const on = instructions(directory);
  assert.equal(on.status, 0);
  assert.match(on.stdout, /machine-mem\/items\//);
  assert.doesNotMatch(on.stdout, /dir-mem/);
  // 目录层 autoSync 管定时同步；读前惰性同步跟本机插件层（这里也是关）。
  assert.match(on.stdout, /定时同步（目录设置 memory\.autoSync）已关闭，读取前的惰性同步（本机插件设置 memory\.autoSync）已关闭/);
  assert.match(instructions({ ...directory, 'memory.autoSync': true }).stdout, /定时同步（[^）]*）已开启，读取前的惰性同步（[^）]*）已关闭/);
  const off = instructions({ ...directory, 'memory.enabled': false });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
});

test('机器层设置文件损坏或不是对象：同步脚本与开场说明回退到各自拿到的设置', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  mkdirSync(join(repoDir, 'notes', 'items'), { recursive: true });
  writeFileSync(join(repoDir, 'notes', 'items', 'N1.md'), serializeCard(card('N1')));
  commitAll(repoDir);
  for (const text of ['{坏的', 'null', '[1]', '"x"']) {
    const { env, stateDir } = syncEnv(t, { projectPath: repoDir, extra: { MEMORY_DIR: 'notes' } });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'machine-settings.json'), text);
    assert.equal((await runSyncScript(env, { argv: ['--no-fetch'] })).result.action, 'rebuild', text);
    assert.equal(syncState(stateDir, 'proj-1').memoryDir, 'notes', text);
    const child = spawnSync(process.execPath, [INSTRUCTIONS], { encoding: 'utf8', env: { ...process.env, CODA_PLUGIN_STATE: stateDir, CODA_PLUGIN_SETTINGS: '{"memory.enabled":true,"memory.memoryDir":"fallback"}' } });
    assert.match(child.stdout, /fallback\/items\//, text);
  }
});

// ---- sync-project.mjs ----

const clone = (origin, dir) => { execFileSync('git', ['clone', '-q', origin, dir]); return dir; };

function syncEnv(t, { projectPath, extra = {} } = {}) {
  const root = tmp(t), stateDir = join(root, 'state');
  const env = {
    MEMORY_PROJECT_ID: 'proj-1',
    MEMORY_PROJECTS_JSON: JSON.stringify([{ id: 'proj-1', name: 'demo', path: projectPath, origin: '' }]),
    CODA_PLUGIN_STATE: stateDir,
    MEMORY_MNEMON_PATH: fakeBin(root),
    ...extra,
  };
  return { env, stateDir };
}

test('sync-project：没有这个项目、不是 Git 仓库、没有记忆卡片的项目都跳过，不建库', async t => {
  const plain = tmp(t), repoDir = initRepo(join(tmp(t), 'repo'));
  const { env, stateDir } = syncEnv(t, { projectPath: plain });
  assert.match((await runSyncScript(env)).line, /不是 Git 仓库/);
  assert.match((await runSyncScript({ ...env, MEMORY_PROJECT_ID: 'other' })).line, /没有这个项目/);
  assert.match((await runSyncScript({ ...env, MEMORY_PROJECTS_JSON: '[]' })).line, /没有这个项目/);
  const noMemory = syncEnv(t, { projectPath: repoDir });
  assert.match((await runSyncScript(noMemory.env)).line, /没有研究记忆卡片/);
  // 空项目不需要 mnemon：缺 mnemon 时引擎工厂根本不会被调用。
  const noBin = () => { throw Object.assign(new Error('找不到 mnemon'), { code: 'mnemon_missing' }); };
  assert.match((await runSyncScript(noMemory.env, { makeEngine: noBin })).line, /没有研究记忆卡片/);
  assert.equal(existsSync(join(stateDir, 'projects', 'proj-1', 'sync-state.json')), false);
  assert.equal(existsSync(join(noMemory.stateDir, 'projects', 'proj-1', 'sync-state.json')), false);
});

test('sync-project：定时流程要求启用研究记忆，没启用的项目一行跳过且不建库；合并后同步不受影响', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  putCard(repoDir, card('A1'));
  commitAll(repoDir);
  const { env, stateDir } = syncEnv(t, { projectPath: repoDir });
  for (const enabled of [undefined, '', 'false']) {
    const skipped = await runSyncScript({ ...env, MEMORY_REQUIRE_ENABLED: 'true', ...(enabled !== undefined && { MEMORY_ENABLED: enabled }) }, { argv: ['--no-fetch'] });
    assert.match(skipped.line, /没有启用研究记忆/);
  }
  assert.equal(existsSync(join(stateDir, 'projects', 'proj-1', 'sync-state.json')), false);
  assert.equal((await runSyncScript({ ...env, MEMORY_REQUIRE_ENABLED: 'true', MEMORY_ENABLED: 'true' }, { argv: ['--no-fetch'] })).result.action, 'rebuild');
  assert.equal((await runSyncScript(env, { argv: ['--no-fetch'] })).result.action, 'noop');
});

test('sync-project：有记忆卡片的项目同步到默认分支，--no-fetch 不拉远端；只有工作树里的卡片也同步', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  putCard(repoDir, card('A1'));
  const commit = commitAll(repoDir);
  const { env, stateDir } = syncEnv(t, { projectPath: repoDir });
  const done = await runSyncScript(env);
  assert.equal(done.result.action, 'rebuild');
  assert.match(done.line, /rebuild.*已索引 1 张.*没拉到远端/);
  assert.equal(syncState(stateDir, 'proj-1').indexedCommit, commit);
  const again = await runSyncScript(env, { argv: ['--no-fetch'] });
  assert.equal(again.result.action, 'noop');
  assert.equal(again.result.fetchError, undefined);

  // 只有工作树里有卡片（还没提交）也算启用了记忆。
  const draftRepo = initRepo(join(tmp(t), 'draft'));
  putCard(draftRepo, card('D1'));
  const draft = syncEnv(t, { projectPath: draftRepo });
  assert.match((await runSyncScript(draft.env)).line, /同步研究记忆/);
});

test('sync-project：MEMORY_* 覆盖 CODA_PLUGIN_SETTINGS 里的记忆目录；命令行写 GITHUB_OUTPUT 并以 0 退出', async t => {
  const repoDir = initRepo(join(tmp(t), 'repo'));
  mkdirSync(join(repoDir, 'notes', 'items'), { recursive: true });
  writeFileSync(join(repoDir, 'notes', 'items', 'N1.md'), serializeCard(card('N1')));
  commitAll(repoDir);
  const out = join(tmp(t), 'output.txt');
  writeFileSync(out, '');
  const { env, stateDir } = syncEnv(t, { projectPath: repoDir, extra: { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'memory.memoryDir': '.memory' }), MEMORY_DIR: 'notes', GITHUB_OUTPUT: out } });
  const child = spawnSync(process.execPath, [SCRIPT, '--no-fetch'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(readFileSync(out, 'utf8'), /^line=同步研究记忆：rebuild，已索引 1 张\n$/);
  assert.equal(syncState(stateDir, 'proj-1').memoryDir, 'notes');

  const skipped = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env, MEMORY_PROJECT_ID: 'nope', GITHUB_OUTPUT: '' }, encoding: 'utf8' });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /跳过/);
  const broken = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env, CODA_PLUGIN_STATE: '' }, encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /CODA_PLUGIN_STATE/);
});

test('sync-project：别的机器首次推上来记忆卡片，本机先拉远端再判断，能感知并建库；没有卡片的仓库照旧跳过', async t => {
  const root = tmp(t), origin = join(root, 'origin.git'), a = initRepo(join(root, 'a'));
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(a, 'remote', 'add', 'origin', origin);
  git(a, 'push', '-q', 'origin', 'main');
  const b = clone(origin, join(root, 'b'));
  git(b, 'remote', 'set-head', 'origin', '-a');
  const { env, stateDir } = syncEnv(t, { projectPath: b });
  assert.match((await runSyncScript(env)).line, /没有研究记忆卡片/);
  assert.equal(existsSync(join(stateDir, 'projects', 'proj-1', 'sync-state.json')), false);

  putCard(a, card('A1'));
  const commit = commitAll(a);
  git(a, 'push', '-q', 'origin', 'main');
  const done = await runSyncScript(env);
  assert.equal(done.result.action, 'rebuild');
  assert.match(done.line, /已索引 1 张/);
  assert.equal(syncState(stateDir, 'proj-1').indexedCommit, commit);
});
