// The checker against this repository's plugins (they pass every level) and against plugins that get Coda's contract
// wrong on purpose (each fails on the rule it breaks, and nothing else does).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../check/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = path => join(root, path);
const LIAR = at('test/fixtures/liar.mjs'), ICON = at('templates/agent/icons/echo.pdf');
// Short enough for a test, long enough for the templates.
const limits = { turn: 10_000, settle: 6_000, cancel: 2_000, exit: 1_000, cancelReply: 1_000, steerQuiet: 300 };
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const rules = (report, status) => report.items.filter(item => item.status === status).map(item => item.rule);
const failed = report => rules(report, 'fail');
function assertPasses(report, expected) {
  assert.deepEqual(report.failures, [], 'no failures');
  const passed = rules(report, 'pass');
  for (const rule of expected) assert.ok(passed.includes(rule), `${rule} passed: ${passed.join(', ')}`);
}
// A plugin in a directory of its own outside Git: `agent` is merged into a declared agent that runs the liar in `mode`.
function plugin({ mode = 'honest', agent = {}, manifest = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-check-test-'));
  temps.push(dir);
  copyFileSync(ICON, join(dir, 'icon.pdf'));
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), content); }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'liar', displayName: '说错话', version: '1.0.0', ...manifest,
    contributes: { agents: [{ id: 'liar', displayName: '说错话', icon: { light: 'icon.pdf', template: true },
      command: `exec "$CODA_NODE" "${LIAR}" ${mode}`, ...agent }], ...manifest.contributes } }));
  return dir;
}

describe('this repository', () => {
  test('templates/agent passes every level', async () => {
    const { report } = await checkPlugin(at('templates/agent'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'manifest.agents', 'source.files', 'handshake.initialize', 'handshake.system-prompt', 'handshake.new',
      'handshake.sigterm', 'handshake.exit-input', 'live.instructions', 'live.turn', 'live.steering', 'live.cancel', 'live.updates']);
    assert.ok(rules(report, 'skip').includes('live.load'), 'session/load is not asked of an agent that does not declare it');
    // Late, it is not taken; under way, it is, and the turn ends as it would.
    assert.deepEqual(report.items.filter(item => item.rule === 'live.steering').map(item => item.message.split('：')[0]), ['一轮已经结束时插话', '一轮进行中插话']);
    assert.match(report.items.filter(item => item.rule === 'live.steering')[1].message, /injected.*插话：数完后再说一句/);
  });
  test('templates/agent registers a wait and takes a turn of its own', async () => {
    const { report } = await checkPlugin(at('templates/agent'), { live: true, prompt: 'wait 演示', limits });
    assertPasses(report, ['live.turn', 'live.waits', 'live.cancel', 'live.cancel-autonomous']);
    assert.match(report.items.find(item => item.rule === 'live.waits').message, /登记 1 个（task ×1），自主轮次 1 次，都已结束/);
    assert.match(report.items.find(item => item.rule === 'live.autonomous').message, /两秒到了/);
  });
  test('templates/panel reads as a panel', async () => {
    const { report } = await checkPlugin(at('templates/panel'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'manifest.panels', 'panel.read']);
    assert.match(report.items.find(item => item.rule === 'panel.read').message, /card ×1.*button ×1.*meter ×1/);
  });
  // Coda's own keys, and those the points of the plugins Coda ships take (the resources plugin's `panels`), pass; another is
  // said, not failed: it may be one Coda added since this copy, which Coda's reading decides.
  test('contributes takes what Coda takes, and says what it does not know without failing it', async () => {
    const read = async contributes => (await checkPlugin(plugin({ manifest: { contributes } }), { manifestOnly: true })).report;
    const known = await read({ panels: [], executors: [] }), other = await read({ menus: [] });
    assert.ok(!rules(known, 'warn').includes('manifest.contributes-unknown') && !failed(known).includes('manifest.contributes'));
    assert.deepEqual(failed(other), []);
    assert.match(other.items.find(item => item.rule === 'manifest.contributes-unknown').message, /menus.*以 Coda「从仓库添加…」的读取为准/);
  });
  test('a plugin reached through a symbolic link is measured from the real repository', async () => {
    const link = join(mkdtempSync(join(tmpdir(), 'coda-plugin-check-link-')), 'repo');
    temps.push(join(link, '..'));
    symlinkSync(root, link);
    const { report } = await checkPlugin(join(link, 'templates/panel'), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
  });
  test('plugins/cursor passes the manifest level', async () => {
    const { report, plugin: cursor } = await checkPlugin(at('plugins/cursor'), { manifestOnly: true });
    assertPasses(report, ['manifest.name', 'manifest.agents', 'source.files']);
    assert.equal(cursor.agents[0].command, 'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/entry.mjs"');
  });
  test('the command line exits 0 on a pass and 1 on a failure', () => {
    const run = (...args) => spawnSync(process.execPath, [at('bin/check.mjs'), ...args], { encoding: 'utf8' });
    const good = run(at('templates/panel'));
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /结果：通过/);
    assert.match(good.stdout, /权威校验仍是 Coda 的「读取来源」/);
    const bad = run(plugin({ mode: 'no-model' }));
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, /✗ session\/new 没报当前模型/);
    assert.equal(run().status, 2);
  });
});

describe('a liar fails on the rule it breaks', () => {
  const cases = [
    ['protocol-version', 'handshake.protocol', {}],
    ['no-model', 'handshake.model', {}],
    ['bad-update', 'update.schema', { live: true }],
    ['foreign-session', 'update.session', { live: true }],
    ['bad-wait', 'wait.invalid', { live: true }],
    ['wait-no-params', 'wait.invalid', { live: true }],
    ['after-terminal', 'wait.after-terminal', { live: true }],
    ['permission-outside', 'request.outside-turn', { live: true }],
    ['ignore-cancel', 'live.cancel', { live: true }],
    ['keep-going', 'live.cancel-reason', { live: true }],
    ['slow-end-turn', 'live.cancel-reason', { live: true }],
    ['ignore-sigterm', 'handshake.sigterm', {}],
    ['load-fails', 'handshake.load', { live: true }],
    ['load-forgets', 'live.load-turn', { live: true }],
    ['no-system-prompt', 'handshake.system-prompt', { live: true }],
    ['ignore-system-prompt', 'live.instructions', { live: true }],
    ['steer-own-turn', 'live.steering', { live: true }],
    ['steer-started', 'live.steering', { live: true }],
  ];
  for (const [mode, rule, options] of cases) test(mode, async () => {
    const { report } = await checkPlugin(plugin({ mode }), { ...options, limits });
    assert.deepEqual([...new Set(failed(report))], [rule], JSON.stringify(report.failures, null, 1));
  });
  test('an honest one passes', async () => {
    const { report } = await checkPlugin(plugin(), { live: true, limits });
    assertPasses(report, ['handshake.system-prompt', 'live.instructions', 'live.turn', 'live.cancel']);
    assert.match(report.items.find(item => item.rule === 'live.cancel').message, /stopReason cancelled/);
    assert.ok(rules(report, 'skip').includes('live.steering'), 'steering is optional');
  });
  test('one that steers answers promptRequired once its turn has ended', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'steer' }), { live: true, limits });
    assertPasses(report, ['live.steering']);
    // Its work is done but the prompt reply is held until steering arrives: the agent answers promptRequired.
    assert.match(report.items.findLast(item => item.rule === 'live.steering').message, /一轮进行中插话：回 promptRequired/);
  });
  test('the session instructions go with session/load too', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'load-fails' }), { live: true, limits });
    assert.match(report.failures.find(f => f.rule === 'handshake.load').message, /session\/load 回了错误 -32002：会话不见了（收到了检查词 coda-[0-9a-f]{6} 的会话指令）/);
  });
  test('signed out is skipped, not failed', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'signed-out' }), { live: true, limits });
    assert.deepEqual(failed(report), []);
    assert.ok(rules(report, 'skip').includes('handshake.signed-out'));
  });
  test('approvals in a turn are refused', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'permission' }), { live: true, limits });
    assertPasses(report, ['live.turn']);
    assert.match(report.items.find(item => item.rule === 'live.turn').message, /审批答复 \{"outcome":\{"outcome":"selected","optionId":"no"\}\}/);
  });
  test('waits said while the session opens are kept for it', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'wait-while-loading' }), { limits });
    assert.deepEqual(failed(report), []);
  });
  test('noise on standard output is worth a look', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'stdout-noise' }), { live: true, limits });
    assert.deepEqual(failed(report), []);
    assert.ok(rules(report, 'warn').includes('wire.noise'));
  });
  test('one that ignores the end of its input but goes on SIGTERM, as Coda stops it, is worth a look only', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'linger' }), { limits });
    assertPasses(report, ['handshake.sigterm']);
    assert.ok(rules(report, 'warn').includes('handshake.exit-input'));
  });
  test('one that takes longer after SIGTERM than Coda waits before SIGKILL is worth a look', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'slow-sigterm' }), { limits: { ...limits, exit: 3_000 } });
    assertPasses(report, ['handshake.sigterm']);
    assert.ok(rules(report, 'warn').includes('handshake.sigterm-slow'));
  });
  test('a reply on its way as the cancel goes out, or one whose turn was done as it read the cancel, is not a turn that would not stop', async () => {
    for (const [mode, words] of [['reply-in-flight', /还没读到 session\/cancel/], ['late-end-turn', /读到 session\/cancel 时它已经做完/]]) {
      const { report } = await checkPlugin(plugin({ mode }), { live: true, limits });
      assert.deepEqual(failed(report), [], mode);
      const said = report.items.find(item => item.rule === 'live.cancel-reason');
      assert.equal(said?.status, 'info', JSON.stringify(report.items, null, 1));
      assert.match(said.message, words);
    }
  });
  test('a subagent without its session and a timer without its time are taken by Coda: worth a look', async () => {
    for (const [mode, rule] of [['subagent-no-child', 'wait.subagent-child'], ['timer-no-at', 'wait.timer-at']]) {
      const { report } = await checkPlugin(plugin({ mode }), { live: true, limits });
      assert.deepEqual(failed(report), [], mode);
      assert.ok(rules(report, 'warn').includes(rule), mode);
    }
  });
  test('a command that does not start', async () => {
    const { report } = await checkPlugin(plugin({ agent: { command: 'exec definitely-not-installed-agent acp' } }), { limits });
    assert.deepEqual(failed(report), ['handshake.initialize']);
    assert.match(report.failures[0].message, /进程退出了（退出码 127）/);
  });
});

describe('manifests Coda does not take', () => {
  const manifestFails = async (options, rule, message) => {
    const { report } = await checkPlugin(plugin(options), { manifestOnly: true });
    assert.ok(failed(report).includes(rule), JSON.stringify(report.items, null, 1));
    if (message) assert.match(report.failures.find(f => f.rule === rule).message, message);
  };
  test('an icon over 32 KiB', () => manifestFails({ agent: { icon: { light: 'big.pdf' } },
    files: { 'big.pdf': `%PDF-1.7\n${'%'.repeat(33 * 1024)}` } }, 'manifest.agents', /超过 32 KiB/));
  test('an icon that is not a PDF', () => manifestFails({ agent: { icon: { light: 'icon.svg' } }, files: { 'icon.svg': '<svg/>' } }, 'manifest.agents', /须为 PDF/));
  test('a command over two lines', () => manifestFails({ agent: { command: 'exec a\nexec b' } }, 'manifest.agents', /一行/));
  test('a key Coda does not read', () => manifestFails({ agent: { args: ['acp'] } }, 'manifest.agents', /不支持的键：args/));
  test('built-in names can be reused after uninstalling; the backend checks installed state', async () => {
    for (const name of ['grok', 'review', 'host']) {
      const { report } = await checkPlugin(plugin({ manifest: { name } }), { manifestOnly: true });
      assertPasses(report, ['manifest.name']);
    }
  });
  test('an independently distributed plugin is not reserved by Coda', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { name: 'machine-stats' } }), { manifestOnly: true });
    assertPasses(report, ['manifest.name']);
  });
  test('a scoped npm package uses its explicit Coda ID for settings and agent ownership', async () => {
    const { report, plugin: checked } = await checkPlugin(plugin({
      manifest: { name: '@coda-console/claude', id: 'claude', contributes: {
        configuration: { properties: { 'claude.enabled': { type: 'boolean', default: true } } } } },
      agent: { id: 'claude-sdk' },
    }), { manifestOnly: true });
    assertPasses(report, ['manifest.name', 'manifest.settings', 'manifest.agents']);
    assert.equal(checked.id, 'claude');
    for (const id of ['', '@acme/board', 1, null]) {
      await manifestFails({ manifest: { name: 'liar', id } }, 'manifest.name', /package.json 的 id/);
    }
  });
  test('a built-in agent ID', () => manifestFails({ agent: { id: 'claude-sdk' } }, 'manifest.agent-id', /内置插件 claude/));
  test('npm dependencies without a lock file', () => manifestFails({ manifest: { dependencies: { left: '1.0.0' } } }, 'source.npm', /没有 package-lock\.json/));
  test('a lock file that does not match the dependencies', () => manifestFails({ manifest: { dependencies: { left: '1.0.0' } },
    files: { 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { left: '2.0.0' } } } }) } }, 'source.npm', /对不上/));
  test('npm dependencies with their lock file are installed by Coda', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { dependencies: { left: '1.0.0' } },
      files: { 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'liar', dependencies: { left: '1.0.0' } } } }) } }), { manifestOnly: true });
    assertPasses(report, ['source.npm', 'source.files']);
  });
  test('a symbolic link', async () => {
    const dir = plugin();
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(failed(report), ['source.symlink']);
  });
  test('a built-in plugin or its replacement can declare its own agent, and the old Claude agent ID stays reserved', async () => {
    // A repository with the plugin where this one keeps it, fetched from here or from somewhere else.
    const repo = (remote, agent) => {
      const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-repo-')), dir = join(top, 'plugins/claude');
      temps.push(top);
      mkdirSync(dir, { recursive: true });
      copyFileSync(ICON, join(dir, 'icon.pdf'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'claude', version: '1.0.0', contributes: { agents: [{ id: agent, displayName: 'Claude',
        icon: { light: 'icon.pdf' }, command: 'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/entry.mjs"' }] } }));
      execFileSync('git', ['init', '-q', top]);
      execFileSync('git', ['-C', top, 'remote', 'add', 'origin', remote]);
      return dir;
    };
    const check = async dir => (await checkPlugin(dir, { manifestOnly: true })).report;
    assert.deepEqual(failed(await check(repo('git@github.com:coda-console/coda-plugins.git', 'claude-sdk'))), []);
    assert.deepEqual(failed(await check(repo('https://github.com/coda-console/coda-plugins', 'claude'))), ['manifest.agent-id']);
    const elsewhere = await check(repo('https://github.com/someone/coda-plugins', 'claude-sdk'));
    assert.deepEqual(failed(elsewhere), []);
  });
  test('a built-in plugin is named as the package Coda ships it as; another of the same ID is not', async () => {
    const said = async (name, id) => (await checkPlugin(plugin({ manifest: { name, id } }), { manifestOnly: true })).report.items
      .find(item => item.rule === 'manifest.name').message;
    assert.match(await said('@coda-console/review', 'review'), /Coda 内置插件 review：Coda 带的是 npm 上 @coda-console\/review 的一个版本/);
    assert.doesNotMatch(await said('@someone/review', 'review'), /内置插件/);
    assert.doesNotMatch(await said('@coda-console/liar', 'liar'), /内置插件/);
  });
  test('what only a plugin Coda ships may contribute', async () => {
    await manifestFails({ manifest: { contributes: { gitCredentials: [{ url: 'https://example.com', command: 'exec true' }] } } }, 'manifest.contributes', /Git 凭据/);
    await manifestFails({ manifest: { contributes: { repositories: { command: 'exec true' } } } }, 'manifest.contributes', /仓库列表/);
  });
  test('a command Coda answers for itself, or one on two lines', async () => {
    await manifestFails({ manifest: { contributes: { commands: [{ name: 'coda-event', command: 'exec true' }] } } }, 'manifest.commands', /coda-run、coda-event/);
    await manifestFails({ manifest: { contributes: { commands: [{ name: 'liar', command: 'a\nb' }] } } }, 'manifest.commands');
  });
  test('events it publishes: named in a domain of its own, once, whether they start and end their subject', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { events: [{ name: 'deploy.started' }, { name: 'deploy.ended', starts: false, ends: true }] } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.match(report.items.find(item => item.rule === 'manifest.events').message, /deploy\.started、deploy\.ended/);
    await manifestFails({ manifest: { contributes: { events: [{ name: 'session.ended' }] } } }, 'manifest.events', /workflow、session、user/);
    await manifestFails({ manifest: { contributes: { events: [{ name: 'deploy' }] } } }, 'manifest.events');
    await manifestFails({ manifest: { contributes: { events: [{ name: 'deploy.ended', ends: 'yes' }] } } }, 'manifest.events');
    await manifestFails({ manifest: { contributes: { events: [{ name: 'deploy.ended' }, { name: 'deploy.ended' }] } } }, 'manifest.events');
  });
  test('a setup action with a key Coda does not read, or on two lines; services that repeat', async () => {
    await manifestFails({ manifest: { contributes: { setup: { command: 'exec true', title: '安装' } } } }, 'manifest.setup', /不支持的键：title/);
    await manifestFails({ manifest: { contributes: { setup: { command: 'a\nb' } } } }, 'manifest.setup', /一行/);
    await manifestFails({ manifest: { contributes: { services: ['space', 'space'] } } }, 'manifest.services', /不重复/);
  });
  test('a setup action and services are taken, and the setup action is not run', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { setup: { command: 'exec false' }, services: ['space'] } } }), { manifestOnly: true });
    assertPasses(report, ['manifest.setup', 'manifest.services']);
  });
  // docs/plugins.md「类型」: a choice of several, its options once each, only as a setting of its own.
  test('a choice of several is taken as Coda takes it', async () => {
    const focus = { type: 'array', uniqueItems: true, default: ['state'], items: { anyOf: [{ const: 'state', title: '状态与失败', description: '失败之后' }, { const: 'tests' }] } };
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { configuration: { properties: { 'liar.focus': focus } } } } }), { manifestOnly: true });
    assertPasses(report, ['manifest.settings']);
    const refused = [[{ ...focus, items: { anyOf: [] } }, /1–50 项/], [{ ...focus, items: { anyOf: [{ const: 'a' }, { const: 'a' }] } }, /不能重复/],
      [{ ...focus, default: ['gone'] }, /没有 gone/], [{ type: 'object', additionalProperties: focus }, /不能放进表格/], [{ type: 'string', items: focus.items }, /只有多选/]];
    for (const [spec, message] of refused)
      await manifestFails({ manifest: { contributes: { configuration: { properties: { 'liar.focus': spec } } } } }, 'manifest.settings', message);
  });
  // docs/plugins.md「类型」: a repository, a directory, a model service and its address are texts of their own formats.
  test('the string formats are taken as Coda takes them', async () => {
    const properties = { 'liar.repo': { type: 'string', format: 'coda-repo' }, 'liar.dir': { type: 'string', format: 'coda-directory', default: '' },
      'liar.service': { type: 'string', format: 'coda-model-provider', default: 'magpie/anthropic' }, 'liar.url': { type: 'string', format: 'coda-model-url' } };
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { configuration: { properties } } } }), { manifestOnly: true });
    assertPasses(report, ['manifest.settings']);
    const refused = [[{ type: 'integer', format: 'coda-model-provider' }, /是文本/], [{ type: 'string', format: 'coda-model-provider', default: 'magpie' }, /插件\/服务/],
      [{ type: 'string', format: 'coda-directory', default: 'relative' }, /绝对目录/], [{ type: 'string', format: 'coda-unknown' }, /format 不受支持/]];
    for (const [spec, message] of refused)
      await manifestFails({ manifest: { contributes: { configuration: { properties: { 'liar.value': spec } } } } }, 'manifest.settings', message);
  });
  test('a group with a key Coda does not read', () => manifestFails({ manifest: { contributes: { groups: [{ name: 'liar', capacity: 'liar.capacity', note: '' }],
    configuration: { properties: { 'liar.capacity': { type: 'integer', default: 1 } } } } } }, 'manifest.groups'));
  test("a built-in plugin's group or command", async () => {
    await manifestFails({ manifest: { contributes: { commands: [{ name: 'host-sim', command: 'exec true' }] } } }, 'manifest.claims', /内置插件 host/);
    await manifestFails({ manifest: { contributes: { groups: [{ name: 'host', capacity: 'liar.capacity' }],
      configuration: { properties: { 'liar.capacity': { type: 'integer', default: 1 } } } } } }, 'manifest.claims', /组 host/);
  });
  // Coda reads these (docs/plugins.md); the checker does not refuse a plugin for bringing them.
  test('Skills, variables, PATH, MCP servers, endpoints, views and model services are contributions Coda takes', async () => {
    const contributes = { skills: [], environment: {}, path: [], mcpServers: {}, endpoints: [], views: [], modelProviders: [] };
    const { report } = await checkPlugin(plugin({ manifest: { contributes } }), { manifestOnly: true });
    assert.ok(!failed(report).includes('manifest.contributes'), JSON.stringify(report.failures));
  });
  test('commands and groups of its own are taken', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { commands: [{ name: 'liar-run', command: 'exec true' }],
      groups: [{ name: 'liar', capacity: 'liar.capacity' }], configuration: { properties: { 'liar.capacity': { type: 'integer', default: 1 } } } } } }), { manifestOnly: true });
    assertPasses(report, ['manifest.commands', 'manifest.groups']);
  });
  test("a panel's command gets what Coda gives a plugin's processes, and the directories of the plugins it depends on beside it", async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-deps-')), dir = join(top, 'reader');
    temps.push(top);
    mkdirSync(join(top, 'base'));
    writeFileSync(join(top, 'base/package.json'), JSON.stringify({ name: '@acme/base', id: 'base', version: '1.0.0', contributes: {} }));
    mkdirSync(dir);
    const seen = join(top, 'seen.json');
    writeFileSync(join(dir, 'panel.mjs'), `import { writeFileSync } from 'node:fs';
      const e = process.env;
      writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ dependencies: JSON.parse(e.CODA_PLUGIN_DEPENDENCIES),
        settings: JSON.parse(e.CODA_PLUGIN_SETTINGS), groups: JSON.parse(e.CODA_GROUPS_STATE).groups, node: e.CODA_NODE, thread: e.CODA_THREAD_ID ?? null }));
      console.log(JSON.stringify({ items: [] }));`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'reader', version: '1.0.0', extensionDependencies: ['base', 'gone'], contributes: {
      configuration: { properties: { 'reader.size': { type: 'integer', default: 3 } } },
      panels: [{ id: 'env', title: '环境', command: 'node "$CODA_PLUGIN_PATH/panel.mjs"' }] } }));
    // A check run from inside a session: neither its ID nor its plugin's variables reach the plugin's processes.
    const before = { CODA_THREAD_ID: process.env.CODA_THREAD_ID, CODA_PLUGIN_EXTENSIONS: process.env.CODA_PLUGIN_EXTENSIONS };
    Object.assign(process.env, { CODA_THREAD_ID: 'a-session', CODA_PLUGIN_EXTENSIONS: '{"x":[]}' });
    try {
      const { report } = await checkPlugin(dir, { limits });
      assert.deepEqual(report.failures, []);
      assert.match(report.items.find(item => item.rule === 'manifest.extensions').message, /gone 不在旁边/);
      assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), { dependencies: { base: realpathSync(join(top, 'base')) }, settings: { 'reader.size': 3 },
        groups: [], node: process.execPath, thread: null });
    } finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  test('a panel whose output Coda cannot read', async () => {
    const dir = plugin({ files: { 'panel.mjs': `console.log(JSON.stringify({ items: [{ type: 'meter', label: '用量', fraction: 1.5 }] }))` },
      manifest: { contributes: { panels: [{ id: 'usage', title: '用量', command: 'node "$CODA_PLUGIN_PATH/panel.mjs"' }] } } });
    const { report } = await checkPlugin(dir, { agent: null, limits });
    assert.ok(failed(report).includes('panel.output'), JSON.stringify(report.items, null, 1));
    assert.match(report.failures.find(f => f.rule === 'panel.output').message, /fraction 须在 0–1 之间/);
  });
});

describe('a check that is stopped', () => {
  // A panel that says who it is and where its state is, then takes its time.
  for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} while a panel is read leaves neither its process nor its state directory`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-check-test-')), mark = join(dir, 'mark');
    temps.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'slow', version: '1.0.0',
      contributes: { panels: [{ id: 'slow', title: '慢', command: `echo "$$ $CODA_PLUGIN_STATE" > '${mark}'; exec sleep 30` }] } }));
    const checker = spawn(process.execPath, [at('bin/check.mjs'), dir], { stdio: 'ignore' });
    const exited = once(checker, 'exit');
    for (let i = 0; i < 1000 && !(existsSync(mark) && readFileSync(mark, 'utf8').endsWith('\n')); i++) await delay(10);
    const [pid, state] = readFileSync(mark, 'utf8').trim().split(' ');
    assert.ok(existsSync(state));
    checker.kill(signal);
    assert.deepEqual(await exited, [130, null]);
    assert.equal(existsSync(state), false, 'its state directory is removed');
    const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
    for (let i = 0; i < 200 && alive(); i++) await delay(10);
    assert.equal(alive(), false, 'its process is gone');
  });
});


test('the checker follows Coda service retry policy and stops at the shared budget', async () => {
  const retryLimits = { ...limits, retryDelays: [5, 10, 20] };
  const once = (await checkPlugin(plugin({ mode: 'service-failure-once' }), { live: true, limits: retryLimits })).report;
  assertPasses(once, ['live.turn']);
  assert.equal(once.items.filter(x => x.rule === 'live.service-retry').length, 1);
  const always = (await checkPlugin(plugin({ mode: 'service-failure-always' }), { live: true, limits: retryLimits })).report;
  assert.equal(always.items.filter(x => x.rule === 'live.service-retry').length, 3);
  assert.deepEqual(failed(always), ['live.turn']);
});

test('the checker recognizes quota exhaustion, preserves its cause and never retries it', async () => {
  const { report } = await checkPlugin(plugin({ mode: 'quota-exhausted' }), { live: true, limits: { ...limits, retryDelays: [5, 10, 20] } });
  assert.deepEqual(failed(report), ['live.turn']);
  assert.match(report.failures[0].message, /额度不足\n\nProvider usage allowance exhausted/);
  assert.equal(report.items.filter(x => x.rule === 'live.service-retry').length, 0);
});
