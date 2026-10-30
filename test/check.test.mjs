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
  // Coda's own keys, and those the points of the plugins Coda ships take (the resources plugin's `panels`), pass; another no
  // point takes, Coda refuses.
  test('contributes takes what Coda takes, and refuses what nothing takes', async () => {
    const read = async contributes => (await checkPlugin(plugin({ manifest: { contributes } }), { manifestOnly: true })).report;
    const known = await read({ panels: [], executors: [] }), other = await read({ menus: [] });
    assert.deepEqual(failed(known), []);
    assert.deepEqual(failed(other), ['source.catalog']);
    assert.match(other.failures[0].message, /contributes 里有 Coda 不支持的贡献：menus/);
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
    assert.match(good.stdout, /规则是 Coda [0-9a-f]{7} 的代码/);
    assert.match(good.stdout, /以那台「设置 › 插件 › 从仓库添加…」的读取为准/);
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
    ['remote-code-foreign', 'request.session', { live: true }],
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
  test('a remote agent asking for a binding code of its own session is answered as Coda answers it', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'remote-code' }), { live: true, limits });
    assert.deepEqual(failed(report), [], JSON.stringify(report.failures, null, 1));
    assertPasses(report, ['live.instructions', 'live.turn']);
    assert.match(report.items.find(item => item.rule === 'live.turn').message, /绑定码字段 addresses,code,expiresAt/);
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
    files: { 'big.pdf': `%PDF-1.7\n${'%'.repeat(33 * 1024)}` } }, 'manifest.read', /超过 32 KiB/));
  test('an icon that is not a PDF', () => manifestFails({ agent: { icon: { light: 'icon.svg' } }, files: { 'icon.svg': '<svg/>' } }, 'manifest.read', /须为 PDF/));
  test('a command over two lines', () => manifestFails({ agent: { command: 'exec a\nexec b' } }, 'manifest.read', /一行/));
  test('a key Coda does not read', () => manifestFails({ agent: { args: ['acp'] } }, 'manifest.read', /不支持的键：args/));
  // Coda stops at the first thing it refuses: that one, and no other, is the verdict.
  test('only the first refusal is said, in the order Coda reads', async () => {
    const dir = plugin({ agent: { args: ['acp'] }, manifest: { dependencies: { left: '1.0.0' } } });
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    assert.deepEqual(failed((await checkPlugin(dir, { manifestOnly: true })).report), ['source.files']);
    rmSync(join(dir, 'hosts'));
    assert.deepEqual(failed((await checkPlugin(dir, { manifestOnly: true })).report), ['manifest.read']);
  });
  // A fresh Coda has installed those of its plugins it installs from the start: another of one's ID waits for it to be
  // uninstalled. One it ships but does not install, or does not ship, is free.
  test('the ID of a built-in plugin Coda installs from the start is refused from elsewhere; others are free', async () => {
    for (const name of ['grok', 'machine-stats']) {
      const { report } = await checkPlugin(plugin({ manifest: { name } }), { manifestOnly: true });
      assert.deepEqual(failed(report), ['source.catalog'], name);
      assert.match(report.failures[0].message, new RegExp(`与内置插件 ${name} 同名，来源不同，请先卸载内置插件再安装`));
    }
    for (const name of ['review', 'host']) {
      const { report } = await checkPlugin(plugin({ manifest: { name } }), { manifestOnly: true });
      assertPasses(report, ['manifest.name', 'source.catalog']);
    }
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
      await manifestFails({ manifest: { name: 'liar', id } }, 'manifest.read', /package.json 的 id/);
    }
  });
  test('a built-in agent ID', () => manifestFails({ agent: { id: 'claude-sdk' } }, 'source.catalog', /Agent claude-sdk 已由插件 Claude 声明/));
  test('npm dependencies without a lock file', () => manifestFails({ manifest: { dependencies: { left: '1.0.0' } } }, 'source.npm', /没有 package-lock\.json/));
  test('a lock file that does not match the dependencies', () => manifestFails({ manifest: { dependencies: { left: '1.0.0' } },
    files: { 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { left: '2.0.0' } } } }) } }, 'source.npm', /依赖不一致（left）/));
  test('npm dependencies with their lock file are installed by Coda', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { dependencies: { left: '1.0.0' } },
      files: { 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'liar', dependencies: { left: '1.0.0' } } } }) } }), { manifestOnly: true });
    assertPasses(report, ['source.npm', 'source.files']);
  });
  test('a symbolic link', async () => {
    const dir = plugin();
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(failed(report), ['source.files']);
    assert.match(report.failures[0].message, /目录里有符号链接：hosts/);
  });
  // Its directory in the repository Coda's copy comes from is a version of it (Coda's sameSource): it keeps its ID and agent.
  test('a built-in plugin in the repository it comes from is a version of it; from elsewhere it waits for the built-in one to go', async () => {
    // A repository with the plugin where this one keeps it, fetched from here or from somewhere else.
    const repo = (remote, agent, at = 'plugins/claude') => {
      const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-repo-')), dir = join(top, at);
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
    const here = await check(repo('git@github.com:coda-console/coda-plugins.git', 'claude-sdk'));
    assert.deepEqual(failed(here), []);
    assert.match(here.items.find(item => item.rule === 'manifest.name').message, /Coda 内置插件 claude：.*同一来源的新版本/);
    // The agent ID sessions from before #1069 store: Coda's reading takes it, the checker says what it does.
    const old = await check(repo('https://github.com/coda-console/coda-plugins', 'claude'));
    assert.deepEqual(failed(old), []);
    assert.ok(rules(old, 'warn').includes('manifest.agent-id'));
    for (const elsewhere of [repo('https://github.com/someone/coda-plugins', 'claude-sdk'), repo('https://github.com/coda-console/coda-plugins', 'claude-sdk', 'plugins/other')]) {
      const report = await check(elsewhere);
      assert.deepEqual(failed(report), ['source.catalog']);
      assert.match(report.failures[0].message, /与内置插件 claude 同名，来源不同/);
    }
  });
  // The package Coda ships it as is that built-in plugin wherever it is checked: read as from where the package is published.
  test('a built-in plugin is named as the package Coda ships it as; another of the same ID is not', async () => {
    const check = async (name, id) => (await checkPlugin(plugin({ manifest: { name, id } }), { manifestOnly: true })).report;
    const said = async (name, id) => (await check(name, id)).items.find(item => item.rule === 'manifest.name').message;
    assert.match(await said('@coda-console/review', 'review'), /Coda 内置插件 review：Coda 带的是 npm 上 @coda-console\/review 的一个版本/);
    assert.doesNotMatch(await said('@someone/review', 'review'), /内置插件/);
    assert.doesNotMatch(await said('@coda-console/liar', 'liar'), /内置插件/);
    assert.deepEqual(failed(await check('@coda-console/grok', 'grok')), []);
    assert.deepEqual(failed(await check('@someone/grok', 'grok')), ['source.catalog']);
  });
  test('what only a plugin Coda ships may contribute', async () => {
    await manifestFails({ manifest: { contributes: { gitCredentials: [{ url: 'https://example.com', command: 'exec true' }] } } }, 'source.catalog', /只有 Coda 自带的插件能提供 Git 凭据/);
    await manifestFails({ manifest: { contributes: { repositories: { command: 'exec true' } } } }, 'source.catalog', /只有 Coda 自带的插件能提供仓库列表/);
  });
  test('a command Coda answers for itself, or one on two lines', async () => {
    await manifestFails({ manifest: { contributes: { commands: [{ name: 'coda-event', command: 'exec true' }] } } }, 'manifest.read', /coda-run、coda-event/);
    await manifestFails({ manifest: { contributes: { commands: [{ name: 'liar', command: 'a\nb' }] } } }, 'manifest.read', /command 是一行命令/);
  });
  test('events it publishes: named in a domain of its own, once, whether they start and end their subject', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { events: [{ name: 'deploy.started' }, { name: 'deploy.ended', starts: false, ends: true }] } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.match(report.items.find(item => item.rule === 'manifest.events').message, /deploy\.started、deploy\.ended/);
    await manifestFails({ manifest: { contributes: { events: [{ name: 'session.ended' }] } } }, 'manifest.read', /workflow、session、user/);
    for (const events of [[{ name: 'deploy' }], [{ name: 'deploy.ended', ends: 'yes' }], [{ name: 'deploy.ended' }, { name: 'deploy.ended' }]])
      await manifestFails({ manifest: { contributes: { events } } }, 'manifest.read', /contributes\.events 须为/);
  });
  test('a setup action with a key Coda does not read, or on two lines; services that repeat', async () => {
    await manifestFails({ manifest: { contributes: { setup: { command: 'exec true', title: '安装' } } } }, 'manifest.read', /contributes\.setup 须为 \{ command \}/);
    await manifestFails({ manifest: { contributes: { setup: { command: 'a\nb' } } } }, 'manifest.read', /一行/);
    await manifestFails({ manifest: { contributes: { services: ['space', 'space'] } } }, 'manifest.read', /不重复/);
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
      await manifestFails({ manifest: { contributes: { configuration: { properties: { 'liar.focus': spec } } } } }, 'manifest.read', message);
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
      await manifestFails({ manifest: { contributes: { configuration: { properties: { 'liar.value': spec } } } } }, 'manifest.read', message);
  });
  // docs/plugins.md「类型」: a table of rows with named columns, secrets among them, and a model address with its Key and API
  // beside it (coda-plugins#55: Pi's providers).
  test('a table of columns with a secret and a model address is taken as Coda takes it', async () => {
    const providers = { type: 'object', additionalProperties: { type: 'object', required: ['url'], properties: {
      url: { type: 'string', format: 'coda-model-url', modelKey: 'key', modelApi: 'api' }, key: { type: 'string', writeOnly: true }, api: { type: 'string', default: 'openai-completions' } } } };
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { configuration: { properties: { 'liar.providers': providers } } } } }), { manifestOnly: true });
    assertPasses(report, ['manifest.settings']);
    const secret = { ...providers.additionalProperties.properties.key, default: 'sk' };
    await manifestFails({ manifest: { contributes: { configuration: { properties: { 'liar.providers': { ...providers, additionalProperties: { ...providers.additionalProperties,
      properties: { ...providers.additionalProperties.properties, key: secret } } } } } } } }, 'manifest.read', /密文设置（writeOnly）只能是没有 format、enum 与默认值的文本/);
  });
  test('a group with a key Coda does not read', () => manifestFails({ manifest: { contributes: { groups: [{ name: 'liar', capacity: 'liar.capacity', note: '' }],
    configuration: { properties: { 'liar.capacity': { type: 'integer', default: 1 } } } } } }, 'manifest.read', /contributes\.groups 须为/));
  // What only one plugin may declare (Coda's claims): a key of contributes a point takes, opening a kind of reference.
  test("what a plugin Coda ships declares as its own", async () => {
    await manifestFails({ manifest: { contributes: { extensionPoints: { cards: { description: '卡片', contributes: 'panels', title: '卡片', commands: {} } } } } },
      'source.catalog', /扩展点 contributes\.panels 已由插件 资源 声明/);
    await manifestFails({ manifest: { contributes: { views: [{ id: 'runs', title: '运行', entry: 'runs.html', handles: ['workflow-runs'] }] } }, files: { 'runs.html': '' } },
      'source.catalog', /打开 workflow-runs 引用 已由插件 工作流 声明/);
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
  // Of the plugins it depends on, one of the same repository is there (as Coda installs it along); one Coda ships has its
  // directory in Coda, not here, even with a plugin of its ID from another source beside it: Coda picks its own.
  test("a panel's command gets what Coda gives a plugin's processes, and the directories of the plugins it depends on beside it", async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-deps-')), dir = join(top, 'reader');
    temps.push(top);
    execFileSync('git', ['init', '-q', top]);
    mkdirSync(join(top, 'base'));
    writeFileSync(join(top, 'base/package.json'), JSON.stringify({ name: '@acme/base', id: 'base', version: '1.0.0', contributes: {} }));
    mkdirSync(join(top, 'github'));
    writeFileSync(join(top, 'github/package.json'), JSON.stringify({ name: 'github', version: '1.0.0', contributes: {} }));
    mkdirSync(dir);
    const seen = join(top, 'seen.json');
    writeFileSync(join(dir, 'panel.mjs'), `import { writeFileSync } from 'node:fs';
      const e = process.env;
      writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ dependencies: JSON.parse(e.CODA_PLUGIN_DEPENDENCIES),
        settings: JSON.parse(e.CODA_PLUGIN_SETTINGS), groups: JSON.parse(e.CODA_GROUPS_STATE).groups, node: e.CODA_NODE, thread: e.CODA_THREAD_ID ?? null }));
      console.log(JSON.stringify({ items: [] }));`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'reader', version: '1.0.0', extensionDependencies: ['base', 'github'], contributes: {
      configuration: { properties: { 'reader.size': { type: 'integer', default: 3 } } },
      panels: [{ id: 'env', title: '环境', command: 'node "$CODA_PLUGIN_PATH/panel.mjs"' }] } }));
    // A check run from inside a session: neither its ID nor its plugin's variables reach the plugin's processes.
    const before = { CODA_THREAD_ID: process.env.CODA_THREAD_ID, CODA_PLUGIN_EXTENSIONS: process.env.CODA_PLUGIN_EXTENSIONS };
    Object.assign(process.env, { CODA_THREAD_ID: 'a-session', CODA_PLUGIN_EXTENSIONS: '{"x":[]}' });
    try {
      const { report } = await checkPlugin(dir, { limits });
      assert.deepEqual(report.failures, []);
      assert.match(report.items.find(item => item.rule === 'manifest.extensions').message, /github 不在旁边，检查时不带/);
      assert.match(report.items.find(item => item.rule === 'source.catalog').message, /一起装 base（同一提交的 base）、github（Coda 自带）/);
      assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), { dependencies: { base: realpathSync(join(top, 'base')) }, settings: { 'reader.size': 3 },
        groups: [], node: process.execPath, thread: null });
    } finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  // A file system's error reading another plugin of the repository fails Coda's reading of the whole repository: said, not thrown.
  test('another plugin of the repository that cannot be read', async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-broken-'));
    temps.push(top);
    execFileSync('git', ['init', '-q', top]);
    mkdirSync(join(top, 'reader'));
    writeFileSync(join(top, 'reader/package.json'), JSON.stringify({ name: 'reader', version: '1.0.0', contributes: {} }));
    mkdirSync(join(top, 'other/.coda'), { recursive: true });
    writeFileSync(join(top, 'other/package.json'), JSON.stringify({ name: 'other', version: '1.0.0', contributes: {} }));
    writeFileSync(join(top, 'other/.coda/workflows'), '');
    const { report } = await checkPlugin(join(top, 'reader'), { manifestOnly: true });
    assert.deepEqual(failed(report), ['source.read']);
    assert.match(report.failures[0].message, /同一仓库的 other 读不了：.*ENOTDIR.*Coda 读这个仓库时整个出错/);
  });
  test('a panel whose output Coda cannot read', async () => {
    const dir = plugin({ files: { 'panel.mjs': `console.log(JSON.stringify({ items: [{ type: 'meter', label: '用量', fraction: 1.5 }] }))` },
      manifest: { contributes: { panels: [{ id: 'usage', title: '用量', command: 'node "$CODA_PLUGIN_PATH/panel.mjs"' }] } } });
    const { report } = await checkPlugin(dir, { agent: null, limits });
    assert.ok(failed(report).includes('panel.output'), JSON.stringify(report.items, null, 1));
    assert.match(report.failures.find(f => f.rule === 'panel.output').message, /fraction 须在 0–1 之间/);
  });
  test('a panel whose command fails says what the resources page shows', async () => {
    const dir = plugin({ manifest: { contributes: { panels: [{ id: 'usage', title: '用量', command: 'echo 读不到用量 >&2; exit 3' }] } } });
    const { report } = await checkPlugin(dir, { agent: null, limits });
    assert.deepEqual(report.failures.filter(f => f.rule.startsWith('panel.')).map(f => f.message), ['读取没成功（退出码 3）：资源页显示「读不到用量」']);
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

test('the checker waits as long as upstream asks within the budget, and does not retry past it, as Coda does', async () => {
  const retryLimits = { ...limits, retryDelays: [5, 10, 20] };
  const short = (await checkPlugin(plugin({ mode: 'service-wait-short' }), { live: true, limits: retryLimits })).report;
  assertPasses(short, ['live.turn']);
  assert.deepEqual(short.items.filter(x => x.rule === 'live.service-retry').map(x => x.message), ['服务暂不可用，按 Coda 策略 0.3 秒后第 1 次重试']);
  const long = (await checkPlugin(plugin({ mode: 'service-wait-long' }), { live: true, limits: retryLimits })).report;
  assert.equal(long.items.filter(x => x.rule === 'live.service-retry').length, 0);
  assert.deepEqual(failed(long), ['live.turn']);
});

test('the checker recognizes quota exhaustion, preserves its cause and never retries it', async () => {
  const { report } = await checkPlugin(plugin({ mode: 'quota-exhausted' }), { live: true, limits: { ...limits, retryDelays: [5, 10, 20] } });
  assert.deepEqual(failed(report), ['live.turn']);
  assert.match(report.failures[0].message, /额度不足\n\nProvider usage allowance exhausted/);
  assert.equal(report.items.filter(x => x.rule === 'live.service-retry').length, 0);
});
