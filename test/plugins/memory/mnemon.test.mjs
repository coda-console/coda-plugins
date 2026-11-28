import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fakeBin } from './helpers.mjs';
import { MnemonEngine, buildMnemonEnv, mergeRelations, mnemonCategory, mnemonEdge, resolveMnemonBin } from '../../../plugins/memory/lib/mnemon.mjs';
import { VERSION, assetForPlatform, installMnemon, verifySha256 } from '../../../plugins/memory/scripts/setup.mjs';

const tmp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-mnemon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const engineIn = (t, extraEnv = {}) => {
  const dir = tmp(t), dataDir = join(dir, 'data');
  return { dir, dataDir, engine: new MnemonEngine({ bin: fakeBin(dir), dataDir, storeName: 'default', env: { ...process.env, ...extraEnv } }) };
};
const calls = dataDir => readFileSync(join(dataDir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const card = (id, extra = {}) => ({
  id, kind: 'fact', status: 'active', importance: 3, refs: ['r'], entities: [], tags: [], supersedes: [], contradicts: [], related: [],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', body: `卡片 ${id}`, ...extra,
});

test('buildMnemonEnv：none 指向必然拒绝连接的端口并清掉向量变量', () => {
  const env = buildMnemonEnv({}, { PATH: '/bin', MNEMON_EMBED_PROTOCOL: 'openai', MNEMON_EMBED_MODEL: 'm', MNEMON_EMBED_API_KEY: 'secret', MNEMON_MAX_INSIGHTS: '1000' });
  assert.equal(env.MNEMON_MAX_INSIGHTS, '0');
  assert.equal(env.MNEMON_EMBED_ENDPOINT, 'http://127.0.0.1:1');
  for (const name of ['MNEMON_EMBED_PROTOCOL', 'MNEMON_EMBED_MODEL', 'MNEMON_EMBED_API_KEY']) assert.equal(name in env, false);
  assert.equal(env.PATH, '/bin');
  assert.deepEqual(buildMnemonEnv({ embeddingProvider: 'none' }, {}), buildMnemonEnv({}, {}));
});

test('buildMnemonEnv：ollama 与 openai-compatible', () => {
  const base = { MNEMON_EMBED_API_KEY: 'leftover', MNEMON_EMBED_ENDPOINT: 'http://old', MY_KEY: 'sk-1' };
  const ollama = buildMnemonEnv({ embeddingProvider: 'ollama', embeddingBaseUrl: 'http://127.0.0.1:11434', embeddingModel: 'nomic', embeddingApiKeyEnv: 'MY_KEY' }, base);
  assert.deepEqual([ollama.MNEMON_EMBED_PROTOCOL, ollama.MNEMON_EMBED_ENDPOINT, ollama.MNEMON_EMBED_MODEL, 'MNEMON_EMBED_API_KEY' in ollama], ['ollama', 'http://127.0.0.1:11434', 'nomic', false]);
  assert.equal('MNEMON_EMBED_ENDPOINT' in buildMnemonEnv({ embeddingProvider: 'ollama' }, base), false);

  const openai = buildMnemonEnv({ embeddingProvider: 'openai-compatible', embeddingBaseUrl: 'https://api.example.com/v1', embeddingModel: 'e3', embeddingApiKeyEnv: 'MY_KEY' }, base);
  assert.deepEqual([openai.MNEMON_EMBED_PROTOCOL, openai.MNEMON_EMBED_ENDPOINT, openai.MNEMON_EMBED_MODEL, openai.MNEMON_EMBED_API_KEY], ['openai', 'https://api.example.com/v1', 'e3', 'sk-1']);
  // 环境变量名不合法或没有值时，不带密钥；设置本身也不含明文。
  assert.equal('MNEMON_EMBED_API_KEY' in buildMnemonEnv({ embeddingProvider: 'openai-compatible', embeddingApiKeyEnv: 'bad name' }, base), false);
  assert.equal('MNEMON_EMBED_API_KEY' in buildMnemonEnv({ embeddingProvider: 'openai-compatible', embeddingApiKeyEnv: 'UNSET_KEY' }, base), false);
  assert.throws(() => buildMnemonEnv({ embeddingProvider: 'x' }), /embeddingProvider/);
});

test('卡片种类与关系映射到 mnemon 的有效枚举', () => {
  assert.deepEqual(['fact', 'conclusion', 'hypothesis', 'observation'].map(mnemonCategory), ['fact', 'insight', 'context', 'insight']);
  assert.throws(() => mnemonCategory('x'), /种类/);
  assert.deepEqual(mnemonEdge('supersedes'), { type: 'supersedes' });
  assert.deepEqual(mnemonEdge('contradicts'), { type: 'semantic', meta: { relation: 'contradicts' } });
  assert.deepEqual(mnemonEdge('related'), { type: 'semantic', meta: { relation: 'related' } });
  assert.throws(() => mnemonEdge('x'), /关系/);
});

test('同一对端点上矛盾与相关并存时合并成一条 semantic 边的元数据', async t => {
  assert.deepEqual(mnemonEdge(['related', 'contradicts']), { type: 'semantic', meta: { relation: 'contradicts,related' } });
  assert.deepEqual(mnemonEdge(['related']), { type: 'semantic', meta: { relation: 'related' } });
  assert.throws(() => mnemonEdge(['supersedes', 'related']), /supersedes/);
  // A、B 互相矛盾，B 还说与 A 相关：无向的一对端点只出一条；supersedes 按方向，不与它们合并。
  const cards = [card('A', { contradicts: ['B'], supersedes: ['B'] }), card('B', { contradicts: ['A'], related: ['A'] })];
  const list = [['supersedes', 'A', 'B'], ['contradicts', 'A', 'B'], ['contradicts', 'B', 'A'], ['related', 'B', 'A']].map(([relation, from, to]) => ({ from, to, relation }));
  assert.deepEqual(mergeRelations(list), [{ from: 'A', to: 'B', relations: ['supersedes'] }, { from: 'A', to: 'B', relations: ['contradicts', 'related'] }]);

  const { engine, dataDir } = engineIn(t);
  const [a, b] = [await engine.remember(cards[0]), await engine.remember(cards[1])];
  await engine.link(a, b, ['contradicts', 'related']);
  assert.deepEqual(calls(dataDir)[2].args.slice(4, 8), ['--type', 'semantic', '--meta', '{"relation":"contradicts,related"}']);
  // linkCards 用同一条归并规则；任一端不在映射里的关系不补。
  await engine.linkCards([...list, { from: 'A', to: 'Z', relation: 'related' }], new Map([['A', a], ['B', b]]));
  assert.deepEqual(calls(dataDir).slice(3).map(call => [call.command, ...call.args.slice(4, 8)]), [
    ['link', '--type', 'supersedes', '--', a], ['link', '--type', 'semantic', '--meta', '{"relation":"contradicts,related"}'],
  ]);

  await engine.importCards(cards);
  const { draft } = JSON.parse(readFileSync(join(dataDir, 'imports.jsonl'), 'utf8'));
  assert.deepEqual(draft.edges.map(e => [e.source_index, e.target_index, e.edge_type, e.reason]), [
    [0, 1, 'supersedes', 'supersedes'], [0, 1, 'semantic', 'contradicts,related'], [1, 0, 'semantic', 'contradicts,related'],
  ]);
});

test('resolveMnemonBin 按设置、状态目录、PATH 的顺序找，找不到抛 mnemon_missing', t => {
  const dir = tmp(t);
  const make = (...parts) => {
    const file = join(dir, ...parts);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    return file;
  };
  const configured = make('conf', 'mnemon'), installed = make('state', 'bin', 'mnemon'), onPath = make('path', 'mnemon');
  const stateDir = join(dir, 'state'), env = { PATH: join(dir, 'path') };
  assert.equal(resolveMnemonBin({ mnemonPath: configured, stateDir, env }), configured);
  assert.equal(resolveMnemonBin({ mnemonPath: join(dir, 'nope'), stateDir, env }), installed);
  assert.equal(resolveMnemonBin({ stateDir: join(dir, 'empty'), env }), onPath);
  assert.throws(() => resolveMnemonBin({ stateDir: join(dir, 'empty'), env: { PATH: join(dir, 'none') } }), { code: 'mnemon_missing', message: /mnemon 路径/ });
});

test('remember：正文以 - 开头也按正文传，空标签与实体不传参数', async t => {
  const { engine, dataDir } = engineIn(t);
  const id = await engine.remember(card('A', { body: '--not-a-flag 正文', kind: 'conclusion', importance: 5 }));
  assert.equal(id, 'm1');
  const [call] = calls(dataDir);
  assert.deepEqual(call.args, ['--data-dir', dataDir, '--store', 'default', '--no-diff', '--cat', 'insight', '--imp', '5', '--source', 'A', '--', '--not-a-flag 正文']);
  assert.equal((await engine.search({ query: '--not-a-flag' }))[0].mnemonId, 'm1');

  await engine.remember(card('B', { tags: ['a,b', 'c'], entities: ['E'] }));
  const args = calls(dataDir)[2].args;
  assert.deepEqual([args[args.indexOf('--tags') + 1], args[args.indexOf('--entities') + 1]], ['a b,c', 'E']);
});

test('remember 遇到 skipped 取 replaced_id；mnemon 失败带上错误输出', async t => {
  assert.equal(await engineIn(t, { FAKE_MNEMON_SKIP: '1' }).engine.remember(card('A')), 'old');
  await assert.rejects(engineIn(t, { FAKE_MNEMON_FAIL: 'remember' }).engine.remember(card('A')), /mnemon remember 失败：Error: remember 被要求失败/);
});

test('link 与 forget', async t => {
  const { engine, dataDir } = engineIn(t);
  const [a, b] = [await engine.remember(card('A')), await engine.remember(card('B'))];
  await engine.link(a, b, 'supersedes');
  await engine.link(a, b, 'contradicts');
  await engine.link(b, a, 'related');
  const [, , link1, link2, link3] = calls(dataDir);
  assert.deepEqual(link1.args, ['--data-dir', dataDir, '--store', 'default', '--type', 'supersedes', '--', a, b]);
  assert.deepEqual(link2.args.slice(4, 8), ['--type', 'semantic', '--meta', '{"relation":"contradicts"}']);
  assert.deepEqual(link3.args.slice(4, 8), ['--type', 'semantic', '--meta', '{"relation":"related"}']);
  await engine.forget(a);
  assert.deepEqual((await engine.search({ query: '卡片' })).map(r => r.mnemonId), [b]);
  await assert.rejects(engine.link(a, 'nope', 'related'), /not found/);
});

test('importCards 生成 importdraft，只带两端都在这批里的边，并删掉临时文件', async t => {
  const { engine, dataDir } = engineIn(t);
  assert.equal((await engine.importCards([])).size, 0);
  const map = await engine.importCards([
    card('A', { kind: 'hypothesis', tags: ['t'], entities: ['E'], supersedes: ['B', 'OUT'] }),
    card('B', { related: ['A'] }),
    card('C', { contradicts: ['B'] }),
  ]);
  assert.deepEqual([...map], [['A', 'm1'], ['B', 'm2'], ['C', 'm3']]);
  const { file, draft } = JSON.parse(readFileSync(join(dataDir, 'imports.jsonl'), 'utf8'));
  assert.equal(existsSync(file), false);
  assert.equal(draft.schema_version, '1');
  assert.deepEqual(draft.insights[0], { content: '卡片 A', category: 'context', importance: 3, tags: ['t'], entities: ['E'], source: 'A', created_at: '2026-01-01T00:00:00Z' });
  assert.deepEqual(draft.edges, [
    { source_index: 0, target_index: 1, edge_type: 'supersedes', reason: 'supersedes' },
    // 无向的 semantic 边和 mnemon link 一样写两个方向。
    { source_index: 1, target_index: 0, edge_type: 'semantic', reason: 'related' },
    { source_index: 0, target_index: 1, edge_type: 'semantic', reason: 'related' },
    { source_index: 2, target_index: 1, edge_type: 'semantic', reason: 'contradicts' },
    { source_index: 1, target_index: 2, edge_type: 'semantic', reason: 'contradicts' },
  ]);
  assert.deepEqual(calls(dataDir)[0].args.slice(-3, -1), ['--no-diff', '--']);
});

test('importCards 失败时也删临时文件并报错', async t => {
  const { engine, dataDir } = engineIn(t, { FAKE_MNEMON_FAIL: 'import' });
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('memory-import-')).length;
  await assert.rejects(engine.importCards([card('A')]), /mnemon import 失败/);
  assert.equal(readdirSync(tmpdir()).filter(name => name.startsWith('memory-import-')).length, before);
  assert.equal(existsSync(join(dataDir, 'imports.jsonl')), false);
});

test('recall 与 search 规范化结果，intent 非 auto 才传', async t => {
  const { engine, dataDir } = engineIn(t);
  const [a, b] = [await engine.remember(card('A', { body: '缓存 失效' })), await engine.remember(card('B', { body: '缓存 预热' }))];
  await engine.link(b, a, 'supersedes');
  assert.deepEqual(await engine.recall({ query: '缓存' }), [
    { mnemonId: a, score: 0.5, intent: 'GENERAL', matchedVia: 'keyword', superseded: true },
    { mnemonId: b, score: 0.5, intent: 'GENERAL', matchedVia: 'keyword', superseded: false },
  ]);
  assert.equal(calls(dataDir)[3].args.includes('--intent'), false);
  const why = await engine.recall({ query: '缓存', intent: 'why', limit: 1 });
  assert.deepEqual([why.length, why[0].intent], [1, 'WHY']);
  assert.deepEqual(calls(dataDir)[4].args.slice(4, 8), ['--limit', '1', '--intent', 'WHY']);
  assert.deepEqual(await engine.search({ query: '预热' }), [{ mnemonId: b, score: 1.5 }]);
  assert.deepEqual(await engine.search({ query: '没有' }), []);
});

test('storeExists 以 mnemon.db 为准，只有目录不算', async t => {
  const { engine, dataDir } = engineIn(t);
  mkdirSync(join(dataDir, 'data', 'default'), { recursive: true });
  assert.equal(await engine.storeExists(), false);
  await engine.remember(card('A'));
  assert.equal(await engine.storeExists(), true);
  rmSync(join(dataDir, 'data', 'default', 'mnemon.db'));
  assert.equal(await engine.storeExists(), false);
  // 0 字节的数据库文件（上次没写成）也算没有。
  writeFileSync(join(dataDir, 'data', 'default', 'mnemon.db'), '');
  assert.equal(await engine.storeExists(), false);
  rmSync(join(dataDir, 'data', 'default', 'mnemon.db'));
  // 同名的目录不是数据库；上一级是文件（ENOTDIR）也是没有。
  mkdirSync(join(dataDir, 'data', 'default', 'mnemon.db'));
  assert.equal(await engine.storeExists(), false);
  rmSync(join(dataDir, 'data', 'default'), { recursive: true });
  writeFileSync(join(dataDir, 'data', 'default'), 'x');
  assert.equal(await engine.storeExists(), false);
});

test('storeExists 遇到权限之类的探测错误向上抛', { skip: process.getuid?.() === 0 && '以 root 运行时没有权限限制' }, async t => {
  const { engine, dataDir } = engineIn(t);
  await engine.remember(card('A'));
  const store = join(dataDir, 'data', 'default');
  chmodSync(store, 0o000);
  try { await assert.rejects(engine.storeExists(), { code: 'EACCES' }); } finally { chmodSync(store, 0o755); }
});

test('resetStore 只删当前 store', async t => {
  const { engine, dataDir } = engineIn(t);
  assert.equal(await engine.storeExists(), false);
  await engine.remember(card('A'));
  assert.equal(await engine.storeExists(), true);
  mkdirSync(join(dataDir, 'data', 'other'), { recursive: true });
  await engine.resetStore();
  assert.equal(await engine.storeExists(), false);
  assert.equal(existsSync(join(dataDir, 'data', 'other')), true);
  assert.throws(() => new MnemonEngine({ bin: 'x', dataDir, storeName: '../x' }), /storeName/);
});

test('向量变量原样交给 mnemon，密钥不出现在参数里', async t => {
  const { dir, dataDir } = engineIn(t);
  const env = buildMnemonEnv({ embeddingProvider: 'openai-compatible', embeddingBaseUrl: 'http://e', embeddingModel: 'm', embeddingApiKeyEnv: 'K' }, { ...process.env, K: 'sk-secret' });
  await new MnemonEngine({ bin: fakeBin(dir), dataDir, env }).remember(card('A'));
  const [call] = calls(dataDir);
  assert.equal(call.env.MNEMON_EMBED_API_KEY, 'sk-secret');
  assert.equal(JSON.stringify(call.args).includes('sk-secret'), false);
});

// ---- setup.mjs ----

test('assetForPlatform 映射四个平台并拒绝其余', () => {
  assert.deepEqual(assetForPlatform('darwin', 'arm64'), { name: 'mnemon_0.2.15_darwin_arm64.tar.gz', sha256: '1463b0bfbedf96ddfa4b5d7e4cc4cea01d8836c7b65d829a7a9e1fb9363ffdc4', url: 'https://github.com/mnemon-dev/mnemon/releases/download/v0.2.15/mnemon_0.2.15_darwin_arm64.tar.gz' });
  assert.equal(assetForPlatform('darwin', 'x64').name, 'mnemon_0.2.15_darwin_amd64.tar.gz');
  assert.equal(assetForPlatform('linux', 'x64').sha256, '443828b35fa7ecd083446dedf3574e271ad917c4f23e172b7bda6c09bfc0bb0f');
  assert.equal(assetForPlatform('linux', 'arm64').name, 'mnemon_0.2.15_linux_arm64.tar.gz');
  assert.throws(() => assetForPlatform('win32', 'x64'), /没有 win32\/x64/);
});

test('verifySha256 通过与篡改拒绝', async t => {
  const file = join(tmp(t), 'a');
  writeFileSync(file, 'hello');
  const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.equal(await verifySha256(file, sha), true);
  writeFileSync(file, 'hellp');
  assert.equal(await verifySha256(file, sha), false);
});

// 用系统 tar 打一个只有 mnemon 的包，下载则是复制它。
const archive = (t, content = '#!/bin/sh\necho mnemon version 0.2.15\n') => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'mnemon'), content);
  execFileSync('tar', ['-czf', join(dir, 'pkg.tgz'), '-C', dir, 'mnemon']);
  const sha256 = execFileSync('shasum', ['-a', '256', join(dir, 'pkg.tgz')], { encoding: 'utf8' }).split(' ')[0];
  return { file: join(dir, 'pkg.tgz'), asset: { name: 'pkg.tgz', sha256, url: 'https://example.invalid/pkg.tgz' } };
};
const copyFrom = source => async (url, to) => { writeFileSync(to, readFileSync(source)); };
// 宿主 PATH 上可能装着 mnemon：安装测试一律用空 PATH，不受它影响。
const NO_PATH = { PATH: '' };
const versionOfFile = async bin => readFileSync(bin, 'utf8').includes('0.2.15') ? `mnemon version ${VERSION}` : '';

test('installMnemon 校验通过后原子装到状态目录的 bin 并可执行', async t => {
  const stateDir = join(tmp(t), 'state'), { file, asset } = archive(t);
  const result = await installMnemon({ stateDir, env: NO_PATH, deps: { asset, download: copyFrom(file), versionOf: versionOfFile } });
  assert.deepEqual(result, { action: 'installed', path: join(stateDir, 'bin', 'mnemon') });
  assert.equal(execFileSync(result.path, { encoding: 'utf8' }).trim(), 'mnemon version 0.2.15');
  assert.deepEqual(readdirSync(stateDir), ['bin']);
});

test('installMnemon 拒绝被篡改的包，不留文件', async t => {
  const stateDir = join(tmp(t), 'state'), { file, asset } = archive(t);
  const tampered = join(tmp(t), 'bad.tgz');
  writeFileSync(tampered, `${readFileSync(file, 'latin1')}x`, 'latin1');
  await assert.rejects(installMnemon({ stateDir, env: NO_PATH, deps: { asset, download: copyFrom(tampered), versionOf: versionOfFile } }), /SHA-256/);
  assert.deepEqual(readdirSync(stateDir), []);
});

test('installMnemon 在设置的路径可执行或已装对版本时跳过下载', async t => {
  const stateDir = join(tmp(t), 'state'), { file, asset } = archive(t);
  const download = async () => { throw new Error('不该下载'); };
  const configured = fakeBin(tmp(t));
  assert.deepEqual(await installMnemon({ stateDir, env: NO_PATH, settings: { 'memory.mnemonPath': configured }, deps: { download } }), { action: 'configured', path: configured });

  await installMnemon({ stateDir, env: NO_PATH, deps: { asset, download: copyFrom(file), versionOf: versionOfFile } });
  assert.equal((await installMnemon({ stateDir, env: NO_PATH, deps: { download, versionOf: versionOfFile } })).action, 'present');
  // 版本不对的旧文件会被换掉。
  writeFileSync(join(stateDir, 'bin', 'mnemon'), '#!/bin/sh\necho 0.2.14\n');
  assert.equal((await installMnemon({ stateDir, env: NO_PATH, deps: { asset, download: copyFrom(file), versionOf: versionOfFile } })).action, 'installed');
});

const script = (t, version) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'mnemon'), `#!/bin/sh\necho mnemon version ${version}\n`);
  chmodSync(join(dir, 'mnemon'), 0o755);
  return dir;
};

test('installMnemon：运行时会优先用到的 mnemon 是锁定版本才离线跳过下载，否则装到状态目录', async t => {
  const stateDir = join(tmp(t), 'state'), download = async () => { throw new Error('不该下载'); };
  const old = script(t, '0.2.14'), right = script(t, '0.2.15');
  assert.deepEqual(await installMnemon({ stateDir, env: { PATH: [right, old].join(delimiter) }, deps: { download } }), { action: 'present', path: join(right, 'mnemon') });
  assert.equal(existsSync(stateDir), false);
  // PATH 里排在前面的是旧版：运行时会先启动它，所以不能因为后面有新版就跳过。
  const missing = { asset: { name: 'x', url: 'u', sha256: '0' }, download };
  await assert.rejects(installMnemon({ stateDir, env: { PATH: [old, right].join(delimiter) }, deps: missing }), /不该下载/);
  // 状态目录里是旧版、PATH 有新版：状态目录优先，同样要换掉它。
  mkdirSync(join(stateDir, 'bin'), { recursive: true });
  writeFileSync(join(stateDir, 'bin', 'mnemon'), '#!/bin/sh\necho mnemon version 0.2.14\n');
  chmodSync(join(stateDir, 'bin', 'mnemon'), 0o755);
  await assert.rejects(installMnemon({ stateDir, env: { PATH: right }, deps: missing }), /不该下载/);
});

test('installMnemon 的版本检查整段匹配：0.2.150、0.2.15.1 不算锁定版本', async t => {
  const stateDir = join(tmp(t), 'state'), download = async () => { throw new Error('不该下载'); };
  for (const version of ['0.2.150', '0.2.15.1', '10.2.15', '0.2.15-rc.1', '0.2.15-beta']) {
    await assert.rejects(installMnemon({ stateDir, env: { PATH: script(t, version) }, deps: { asset: { name: 'x', url: 'u', sha256: '0' }, download } }), /不该下载/, version);
  }
  const ok = script(t, 'v0.2.15');
  assert.equal((await installMnemon({ stateDir, env: { PATH: ok }, deps: { download } })).action, 'present');
});

test('假 mnemon 的 link --meta 拒绝非字符串值，与真 mnemon 的 map[string]string 一致', async t => {
  const { engine, dataDir } = engineIn(t);
  const [a, b] = [await engine.remember(card('A')), await engine.remember(card('B'))];
  await engine.link(a, b, ['contradicts', 'related']);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'data', 'default', 'mnemon.db'), 'utf8')).edges[0].meta, { relation: 'contradicts,related' });
  const bin = fakeBin(dataDir);
  assert.throws(() => execFileSync(bin, ['link', '--data-dir', dataDir, '--store', 'default', '--type', 'semantic', '--meta', '{"relations":["a","b"]}', '--', a, b], { stdio: 'pipe' }), /values must be strings/);
});
