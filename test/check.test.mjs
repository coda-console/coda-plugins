// The checker against this repository's plugins (they pass every level) and against plugins that get Coda's contract
// wrong on purpose (each fails on the rule it breaks, and nothing else does).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../check/index.mjs';
import { createTestHost } from '../check/coda/adapters/plugin-test-host.mjs';
import { checkLevel, parseSurface } from '../check/level.mjs';
import { checkManifest } from '../check/manifest.mjs';
import { resourceRecords } from '../check/resources.mjs';
import { NOT_PROVIDED } from '../check/module.mjs';
import { Report } from '../check/report.mjs';
import { agentCapabilitiesProblem, agentMessageProblem, agentResultProblem, agentValueProblem } from '@coda-console/protocol/agent';
import { Waits } from '../check/waits.mjs';

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
  for (const rule of expected) {
    const item = report.items.find(entry => entry.rule === rule);
    assert.ok(passed.includes(rule), `${rule} passed: ${passed.join(', ')}; ${item ? `${item.status}: ${item.message}` : '没有这一项'}`);
  }
}
// A plugin in a directory of its own outside Git: `agent` is merged into a declared agent that runs the liar in `mode`.
function plugin({ mode = 'honest', agent = {}, manifest = {}, files = {}, extension } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-check-test-'));
  temps.push(dir);
  copyFileSync(ICON, join(dir, 'icon.pdf'));
  if (extension) writeFileSync(join(dir, 'extension.json'), JSON.stringify(extension));
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), content); }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'liar', displayName: '说错话', version: '1.0.0', ...manifest,
    contributes: { agents: [{ id: 'liar', displayName: '说错话', icon: { light: 'icon.pdf', template: true },
      command: `exec "$CODA_NODE" "${LIAR}" ${mode}${extension ? ' "$CODA_PLUGIN_PATH/extension.json"' : ''}`, ...agent }], ...manifest.contributes } }));
  return dir;
}

describe('this repository', () => {
  test('templates/agent passes every level', async () => {
    const { report } = await checkPlugin(at('templates/agent'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'manifest.agents', 'handshake.initialize', 'handshake.system-prompt', 'handshake.new',
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
  test('templates/resource gives a resource record Coda takes, and an act command that does its button\'s action', async () => {
    const { report } = await checkPlugin(at('templates/resource'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'resource.read']);
    assert.match(report.items.find(item => item.rule === 'resource.read').message, /输出合 coda\/resource@1：1 条记录，1 个资源，读数 2 个，按钮 1 个/);
    // The button names an action the act command does: it writes the state the record command reads, and refuses any other.
    const [{ spec }] = await resourceRecords(at('templates/resource'));
    const [{ action }] = spec.resources[0].buttons, state = mkdtempSync(join(tmpdir(), 'coda-plugin-check-act-'));
    temps.push(state);
    const act = name => spawnSync(process.execPath, [at('templates/resource/scripts/act.mjs')], { input: JSON.stringify({ action: name, args: {} }), encoding: 'utf8', env: { ...process.env, CODA_PLUGIN_STATE: state } });
    const done = act(action);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(done.stdout.trim(), '{}');
    assert.match(readFileSync(join(state, 'mark.json'), 'utf8'), /"at":"\d{4}-/);
    const refused = act('nope');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /不认识的动作：nope/);
  });
  test('templates/module passes the manifest and the module level, its engines.coda the Level it needs', async () => {
    const { report } = await checkPlugin(at('templates/module'));
    assertPasses(report, ['manifest.name', 'manifest.level', 'module.activate', 'module.registered']);
    assert.match(report.items.find(item => item.rule === 'module.registered').message, /登记了 2 个操作/);
    assert.deepEqual(rules(report, 'warn'), []);
  });
  // Coda's own types pass; another no plugin declares is of no type.
  test('contributes takes what Coda takes, and refuses what nothing takes', async () => {
    const read = async contributes => (await checkPlugin(plugin({ manifest: { contributes } }), { manifestOnly: true })).report;
    const known = await read({ skills: [] }), other = await read({ menus: [] });
    assert.deepEqual(failed(known), []);
    assert.deepEqual(failed(other), ['manifest.read']);
    assert.match(other.failures[0].message, /menus/);
  });
  // The keys Coda retired (retiredContributes of the synced contract, `extensionPoints` and `extensions` among them): a manifest
  // still writing one is one it calls for an update, as it says it.
  for (const key of ['resources', 'panels', 'extensionPoints', 'extensions']) test(`a manifest still writing contributes.${key} is retired, and Coda calls for an update`, async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { [key]: [{ id: 'usage', title: '用量', command: 'true' }] } } }), { manifestOnly: true });
    assert.equal(report.failures.find(f => f.rule === 'manifest.retired')?.message, `本机的 Coda 已不提供 contributes.${key}，插件需要更新`);
  });
  // `self` and `processes` were brought back (Level 8): writing one is no call for an update.
  test('a manifest writing contributes.self or contributes.processes is not retired', async () => {
    for (const [contributes, files] of [[{ self: { ask: 'ask.sh' } }, { 'ask.sh': '#!/bin/sh\n' }], [{ processes: ['daemon'] }, {}]]) {
      const dir = plugin({ manifest: { engines: { coda: 8 }, contributes }, files });
      if (files['ask.sh']) chmodSync(join(dir, 'ask.sh'), 0o755);
      const { report } = await checkPlugin(dir, { manifestOnly: true });
      assert.deepEqual(report.failures.map(f => `${f.rule}: ${f.message}`), [], JSON.stringify(contributes));
    }
  });
  test('a plugin reached through a symbolic link is measured from the real repository', async () => {
    const link = join(mkdtempSync(join(tmpdir(), 'coda-plugin-check-link-')), 'repo');
    temps.push(join(link, '..'));
    symlinkSync(root, link);
    const { report } = await checkPlugin(join(link, 'templates/resource'), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
  });
  test('plugins/cursor passes the manifest level', async () => {
    const { report, plugin: cursor } = await checkPlugin(at('plugins/cursor'), { manifestOnly: true });
    assertPasses(report, ['manifest.name', 'manifest.agents']);
    assert.equal(cursor.agents[0].command, 'if [ -x "$HOME/.local/bin/cursor-agent" ]; then exec "$HOME/.local/bin/cursor-agent" acp; else exec cursor-agent acp; fi');
  });
  test('the command line exits 0 on a pass and 1 on a failure', () => {
    const run = (...args) => spawnSync(process.execPath, [at('bin/check.mjs'), ...args], { encoding: 'utf8' });
    const good = run(at('templates/resource'));
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /结果：通过/);
    assert.match(good.stdout, /类型是 Coda [0-9a-f]{7} 的 schema/);
    assert.match(good.stdout, /由那台在安装时说/);
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
    ['no-system-prompt-ignore', 'live.instructions', { live: true }],
    ['ignore-system-prompt', 'live.instructions', { live: true }],
    ['steer-own-turn', 'live.steering', { live: true }],
    ['steer-started', 'live.steering', { live: true }],
    ['probe-refuses', 'probe.new', {}],
    ['probe-stuck', 'probe.config', {}],
    ['probe-prompt', 'probe.prompt', {}],
    ['probe-prompt-internal', 'probe.prompt', {}],
    ['probe-mark-ignored', 'probe.mark', {}],
    ['probe-empty-id', 'probe.new', {}],
    ['probe-any-option', 'probe.config', {}],
    ['probe-default-refused', 'probe.config', {}],
    ['probe-default-ignored', 'probe.config', {}, /设思考档位 low 后返回的档位是 medium/],
    ['probe-close-error', 'probe.close', {}],
    ['probe-close-keeps', 'probe.close', {}],
    ['probe-load-code', 'probe.resume', {}],
    ['probe-list-pages', 'probe.resume', {}, /第 2 页列出了虚拟会话/],
    ['probe-list-loop', 'probe.resume', {}, /又给了用过的 nextCursor/],
    ['probe-list-endless', 'probe.resume', {}, /翻了 100 页/],
    ['probe-list-cursor', 'probe.resume', {}, /nextCursor 不是字符串（42）/],
    ['probe-list-entry', 'probe.resume', {}, /sessions\[0\] 不合 ACP schema：cwd/],
    ['probe-persist-close', 'probe.resume', {}, /session\/load 接上了虚拟会话/],
    ['probe-resume', 'probe.resume', {}],
    ['probe-list-error', 'probe.resume', {}],
    ['probe-list-shapeless', 'probe.resume', {}],
    ['probe-reinit-error', 'probe.resume', {}],
    ['probe-reinit-shapeless', 'probe.resume', {}],
    ['probe-init-shapeless', 'probe.new', {}],
    ['probe-models-shapeless', 'probe.config', {}],
    ['probe-level-shapeless', 'probe.config', {}],
    ['probe-new-work', 'probe.quiet', {}],
    ['probe-signed-out-work', 'probe.quiet', {}],
    ['probe-wait-work', 'probe.quiet', {}],
    ['probe-wait-ask', 'probe.quiet', {}],
    ['probe-wait-only', 'probe.quiet', {}],
  ];
  for (const [mode, rule, options, message] of cases) test(mode, async () => {
    const { report } = await checkPlugin(plugin({ mode }), { ...options, limits });
    assert.deepEqual([...new Set(failed(report))], [rule], JSON.stringify(report.failures, null, 1));
    if (message) assert.match(report.failures.map(item => item.message).join('\n'), message);
  });
  test('an honest one passes', async () => {
    const { report } = await checkPlugin(plugin(), { live: true, limits });
    assertPasses(report, ['handshake.system-prompt', 'live.instructions', 'live.turn', 'live.cancel']);
    assert.match(report.items.find(item => item.rule === 'live.cancel').message, /stopReason cancelled/);
    assert.ok(rules(report, 'skip').includes('live.steering'), 'steering is optional');
  });
  test('one that declares configuration probes opens a session of its connection alone for them', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'probe' }), { limits });
    assertPasses(report, ['handshake.new', 'probe.new', 'probe.mark', 'probe.config', 'probe.prompt', 'probe.close', 'probe.resume']);
    assert.match(report.items.find(item => item.rule === 'probe.resume').message, /session\/list（2 页）/, 'every page of the probe\'s cwd');
    assert.match(report.items.find(item => item.rule === 'probe.config').message, /3 个.*a（low\/medium\/high），b（low\/medium\/high\/xhigh），c（无档位）/);
    assert.ok(rules(await checkPlugin(plugin(), { limits }).then(r => r.report), 'skip').includes('probe.skipped'), 'one that does not is not asked');
  });
  test('a probe may say its commands and config while its session/new is answered, but not work or ask', async () => {
    assertPasses((await checkPlugin(plugin({ mode: 'probe-quiet-updates' }), { limits })).report, ['probe.new']);
    const work = (await checkPlugin(plugin({ mode: 'probe-new-work' }), { limits })).report;
    assert.match(work.items.find(item => item.rule === 'probe.quiet').message, /agent_message_chunk/);
    const ask = (await checkPlugin(plugin({ mode: 'probe-new-ask' }), { limits })).report;
    assert.match(ask.items.find(item => item.rule === 'probe.quiet').message, /审批/);
  });
  test('a probe that registers activity fails however the rest of it is taken as a turn', async () => {
    const quiet = async mode => (await checkPlugin(plugin({ mode }), { limits })).report.items.find(item => item.rule === 'probe.quiet').message;
    assert.match(await quiet('probe-wait-work'), /_coda\/wait.*agent_message_chunk/);
    assert.match(await quiet('probe-wait-ask'), /_coda\/wait.*审批/);
    assert.match(await quiet('probe-wait-only'), /_coda\/wait/);
  });
  test('an agent without systemPrompt follows the instructions in the first prompt', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'no-system-prompt' }), { live: true, limits });
    assertPasses(report, ['handshake.system-prompt', 'live.instructions', 'live.turn', 'live.cancel']);
    assert.match(report.items.find(item => item.rule === 'handshake.system-prompt').message, /第一轮/);
    assert.deepEqual(failed(report), []);
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

describe('Agent extensions use the shared protocol diagnostics', () => {
  const model = options => ({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'liar', options });
  const choice = coda => ({ value: 'liar', name: 'Liar', _meta: { coda } });
  const capabilities = meta => ({ sessionCapabilities: { systemPrompt: {} }, _meta: meta });
  const error = failure => ({ code: -32603, data: { _meta: { coda: { failure } } } });
  const fast = { ...limits, pause: 10, steerQuiet: 30 };
  const run = async (extension, live = true, mode = 'honest') => (await checkPlugin(plugin({ extension, mode }), { live, limits: fast })).report;

  test('wait errors keep their rule and protocol text, without echoing the payload', () => {
    const items = [], waits = new Waits({ fail: (rule, message) => items.push({ rule, message }), warn: () => {} });
    waits.sessionId = 's';
    for (const value of [null, {}, { sessionId: 's', waitId: 'w', state: 'running', detail: 'private detail' },
      { sessionId: 's', waitId: 'w', state: 'waiting', title: '😀'.repeat(251) },
      { sessionId: 's', waitId: 'w', state: 'waiting', at: 'not a date' }]) {
      waits.take(value, { turn: true });
      assert.deepEqual(items.at(-1), { rule: 'wait.invalid', message: agentMessageProblem('_coda/wait', value) });
    }
    assert.equal(waits.registered.length, 0);
    waits.take({ sessionId: 's', waitId: 'w', state: 'waiting', kind: 'future-kind', extra: true }, { turn: true });
    waits.take({ sessionId: 's', waitId: 'w', state: 'done' }, { turn: false });
    assert.equal(waits.registered.length, 1);
    waits.take({ sessionId: 's', waitId: 'w', state: 'handling' }, { turn: false });
    assert.equal(items.at(-1).rule, 'wait.after-terminal');
  });

  test('capability objects are checked without changing capability probes', async () => {
    for (const key of ['waits', 'compact', 'remote']) {
      const meta = { coda: { [key]: [] } };
      const report = await run({ initialize: { agentCapabilities: capabilities(meta) } }, false);
      assert.deepEqual(report.failures.map(({ rule, message }) => ({ rule, message })),
        [{ rule: 'handshake.initialize', message: agentCapabilitiesProblem(meta) }]);
      assert.ok(rules(report, 'pass').includes('handshake.new'), 'the session still opens');
    }
    const meta = { steering: { supported: 'yes' } };
    const report = await run({ initialize: { _meta: meta } }, false);
    assert.deepEqual(report.failures.map(x => x.message), [agentValueProblem('steering.json#/$defs/capabilities', meta, 'initialize result._meta')]);
  });

  test('review, usage and grouped default markers report under update.schema', async () => {
    const reviews = [null, { state: 'pending' }, { state: 'denied', reason: 'x'.repeat(4001) }];
    const usages = [null, [], { text: '界'.repeat(1400) }];
    const configOptions = [model([{ group: 'g', name: 'Group', options: [choice({ default: 'yes' })] }])];
    const updates = [
      ...reviews.map((review, i) => ({ sessionUpdate: i % 2 ? 'tool_call' : 'tool_call_update', toolCallId: 't', title: 'Tool', _meta: { coda: { review } } })),
      ...usages.map(coda => ({ sessionUpdate: 'usage_update', used: 1, size: 10, _meta: { coda } })),
      { sessionUpdate: 'config_option_update', configOptions },
    ];
    const report = await run({ updates });
    assert.deepEqual(report.failures.map(x => x.rule), updates.map(() => 'update.schema'));
    assert.deepEqual(report.failures.map(x => x.message), [
      ...reviews.map(value => agentValueProblem('review.json', value, 'session/update params.update._meta.coda.review')),
      ...usages.map(value => agentValueProblem('usage.json', value, 'session/update params.update._meta.coda')),
      agentValueProblem('default.json', { default: 'yes' }, 'session/update params.update.configOptions[0].options[0].options[0]._meta.coda'),
    ]);
    assert.ok(!rules(report, 'pass').includes('live.updates'));
    assert.ok(rules(report, 'pass').includes('live.turn'), 'invalid metadata does not hide turn activity');
  });

  test('default markers in new and load results use their existing rules', async () => {
    const configOptions = [model([choice({ default: 1 })])];
    const report = await run({ initialize: { agentCapabilities: { ...capabilities({ coda: { waits: {} } }), loadSession: true } },
      newResult: { configOptions }, loadResult: { configOptions } });
    assert.deepEqual(report.failures.map(x => x.rule), ['handshake.new', 'handshake.load']);
    assert.deepEqual(report.failures.map(x => x.message), ['session/new', 'session/load'].map(method =>
      agentValueProblem('default.json', { default: 1 }, `${method} result.configOptions[0].options[0]._meta.coda`)));
  });

  test('grouped defaults follow ACP parsing even with extra value fields', async () => {
    const configOptions = [model([
      { group: 'g', name: 'Group', value: null, options: [choice({ default: 'yes' })] },
      { group: 'h', name: 'Other group', value: 'extra', options: [choice({ default: 'yes' })] },
    ]), { ...model([{ ...choice({ default: true }), group: 'extra', options: [choice({ default: 'yes' })] }]), id: 'flat' }];
    const opened = await run({ initialize: { agentCapabilities: { ...capabilities({}), loadSession: true } },
      newResult: { configOptions }, loadResult: { configOptions } });
    const updated = await run({ updates: [{ sessionUpdate: 'config_option_update', configOptions }] });
    for (const [report, sources] of [[opened, [['handshake.new', 'session/new result'], ['handshake.load', 'session/load result']]],
      [updated, [['update.schema', 'session/update params.update']]]]) {
      assert.deepEqual(report.failures.map(({ rule, message }) => ({ rule, message })), sources.flatMap(([rule, where]) =>
        [0, 1].map(i => ({ rule, message: agentValueProblem('default.json', { default: 'yes' },
          `${where}.configOptions[0].options[${i}].options[0]._meta.coda`) }))));
    }
  });

  test('malformed remote-code parameters are diagnosed before session ownership', async () => {
    const report = await run({ requests: [{ method: '_coda/remote/code', params: {} }] });
    assert.deepEqual(report.failures.map(x => x.rule), ['request.schema']);
    assert.equal(report.failures[0].message, agentMessageProblem('_coda/remote/code', {}));
  });

  test('malformed execution failures are diagnosed before retry or signed-out handling', async () => {
    const failure = { kind: 'service_unavailable', input: 'accepted', retryAfterMs: -1 };
    for (const [field, rule] of [['promptError', 'live.turn'], ['newError', 'handshake.new'], ['loadError', 'handshake.load']]) {
      const report = await run({ [field]: error(failure), ...(field === 'loadError'
        ? { initialize: { agentCapabilities: { ...capabilities({}), loadSession: true } } } : {}) });
      assert.deepEqual(report.failures.map(x => x.rule), [rule]);
      assert.equal(report.failures[0].message, agentValueProblem('failure.json', failure, 'error.data._meta.coda.failure'));
      assert.equal(report.items.filter(x => x.rule === 'live.service-retry').length, 0);
    }
    const signedOut = await run({ newError: { ...error(null), code: -32000 } });
    assert.deepEqual(failed(signedOut), ['handshake.new']);
    assert.equal(signedOut.failures[0].message, agentValueProblem('failure.json', null, 'error.data._meta.coda.failure'));
  });

  test('steering result shape is shared, while a late injected result still fails the state check', async () => {
    for (const result of [null, { outcome: 'startedNewTurn' }]) {
      const report = await run({ steeringResult: result }, true, 'steer');
      assert.ok(report.failures.length > 0);
      for (const item of report.failures) {
        assert.equal(item.rule, 'live.steering');
        assert.equal(item.message, agentResultProblem('_session/steering', result));
      }
    }
    const report = await run({ steeringResult: { outcome: 'injected' } }, true, 'steer');
    assert.deepEqual(failed(report), ['live.steering']);
    assert.match(report.failures[0].message, /一轮已经结束.*要回 promptRequired/);
    const extra = await run({ steeringResult: { outcome: 'promptRequired', error: 'an unknown field' } }, true, 'steer');
    assert.deepEqual(failed(extra), [], 'unknown result fields are not checker diagnostics');
  });

  test('unknown risks and fields, absent metadata and valid default markers remain accepted', async () => {
    const configOptions = [model([choice({ default: true }), { value: 'other', name: 'Other' }]),
      { id: 'boolean', name: 'Switch', type: 'boolean', currentValue: true },
      { ...model([{ group: 'g', name: 'Group', options: [choice({ default: false })] }]), id: 'grouped' }];
    const report = await run({ initialize: { agentCapabilities: capabilities({ coda: { waits: {}, remote: {}, compact: {} }, future: [] }) },
      newResult: { configOptions }, updates: [
        { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Tool', _meta: { coda: { review: { state: 'approved', reason: '', risk: 'future', extra: [] } } } },
        { sessionUpdate: 'tool_call_update', toolCallId: 't' },
        { sessionUpdate: 'usage_update', used: 1, size: 10, _meta: { coda: { future: [true, null] } } },
        { sessionUpdate: 'usage_update', used: 1, size: 10 },
        { sessionUpdate: 'config_option_update', configOptions },
      ] });
    assertPasses(report, ['live.turn', 'live.updates']);
    const quota = await run({ promptError: error({ kind: 'quota_exhausted', login: 1, retryAfterMs: -1 }) });
    assert.deepEqual(failed(quota), ['live.turn']);
    assert.match(quota.failures[0].message, /额度不足/);
    // Since protocol 6.2.0 a quota failure's optional `input` is checked.
    const badInput = { kind: 'quota_exhausted', input: 'future' };
    assert.equal((await run({ promptError: error(badInput) })).failures[0].message,
      agentValueProblem('failure.json', badInput, 'error.data._meta.coda.failure'));
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
  test('an icon that is not a PDF', () => manifestFails({ agent: { icon: { light: 'icon.svg' } }, files: { 'icon.svg': '<svg/>' } }, 'manifest.read', /icon\.light/));
  test('a command over two lines', () => manifestFails({ agent: { command: 'exec a\nexec b' } }, 'manifest.read', /一行/));
  test('a key Coda does not read', () => manifestFails({ agent: { args: ['acp'] } }, 'manifest.read', /args/));
  test('a scoped npm package uses its explicit Coda ID for settings and agent ownership', async () => {
    const { report, plugin: checked } = await checkPlugin(plugin({
      manifest: { name: '@coda-console/claude', id: 'claude', contributes: {
        configuration: { properties: { 'claude.enabled': { type: 'boolean', default: true } } } } },
      agent: { id: 'claude-sdk' },
    }), { manifestOnly: true });
    assertPasses(report, ['manifest.name', 'manifest.settings', 'manifest.agents']);
    assert.equal(checked.id, 'claude');
    for (const id of ['', '@acme/board', 1, null]) {
      await manifestFails({ manifest: { name: 'liar', id } }, 'manifest.read', /\bid[ ：]/);
    }
  });
  // Its workflows are read with Coda's dialect of BPMN (the protocol's): one written in it passes, and each thing the
  // dialect does not have fails, on the workflow's own line.
  test('its workflows are of Coda\'s dialect of BPMN', async () => {
    const flow = body => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:coda="https://coda.pub/schema/bpmn/1.0" targetNamespace="https://coda.pub/test">
  <process id="p" isExecutable="true"><startEvent id="start" />${body}</process>
</definitions>`;
    const good = flow('<sequenceFlow id="to-say" sourceRef="start" targetRef="say" /><scriptTask id="say" coda:timeout="1" scriptFormat="bash"><script>echo hi</script></scriptTask>'
      + '<sequenceFlow id="to-end" sourceRef="say" targetRef="end" /><endEvent id="end" />');
    const { report } = await checkPlugin(plugin({ files: { '.coda/workflows/hello.bpmn': good } }), { manifestOnly: true });
    assertPasses(report, ['manifest.workflows']);
    assert.match(report.items.find(item => item.rule === 'manifest.workflows').message, /流程 hello：合乎 Coda 的流程方言/);
    await manifestFails({ files: { '.coda/workflows/typo.bpmn': flow('<scriptTask id="say" coda:timout="1" scriptFormat="bash"><script>echo hi</script></scriptTask>') } },
      'manifest.workflows', /^typo\.bpmn 有无法识别的内容：unknown attribute <coda:timout>/);
    await manifestFails({ files: { '.coda/workflows/act.bpmn': flow('<serviceTask id="go" coda:action="deploy-everything" />') } },
      'manifest.workflows', /^go：coda:action 只能是 /);
    await manifestFails({ files: { '.coda/workflows/broken.bpmn': '<definitions' } }, 'manifest.workflows', /^broken\.bpmn 不是有效的 BPMN 2\.0/);
  });
  // Events are of a protocol (the definition's `events`); a protocol of events only has no spec, status or operations.
  const deploys = { name: 'liar/deploy@1', title: '部署', events: { 'deploy.started': { payload: { type: 'object' } }, 'deploy.ended': { payload: { type: 'object' }, starts: false, ends: true } },
    permissions: { watch: { title: '看部署', events: ['deploy.started', 'deploy.ended'] } } };
  test('the events its protocols define are said', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { protocols: [deploys] } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events').map(item => item.message),
      ['协议 liar/deploy@1 定义的事件 deploy.started：starts true，ends false', '协议 liar/deploy@1 定义的事件 deploy.ended：starts false，ends true']);
  });
  test('the event groups it uses are said', async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-events-'));
    temps.push(top);
    const write = (id, manifest) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...manifest })); };
    write('liar', { contributes: { protocols: [deploys] } });
    write('reader', { extensionDependencies: ['liar'], uses: { 'liar/deploy@1': ['watch'] }, contributes: {} });
    const { report } = await checkPlugin(join(top, 'reader'), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events').map(item => item.message), ['用到 liar/deploy@1 的事件组 watch：deploy.started、deploy.ended']);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events-main').map(item => [item.status, item.message]),
      [['warn', '订了事件组 liar/deploy@1 watch，但没有 main，收不到事件']]);
  });
  test('an event group with a main is not warned about', async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-events-'));
    temps.push(top);
    const write = (id, manifest) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...manifest })); };
    write('liar', { contributes: { protocols: [deploys] } });
    write('reader', { extensionDependencies: ['liar'], main: 'index.mjs', uses: { 'liar/deploy@1': ['watch'] }, contributes: {} });
    writeFileSync(join(top, 'reader', 'index.mjs'), '');
    const { report } = await checkPlugin(join(top, 'reader'), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events-main'), []);
  });
  test('a group the protocol it uses does not have is refused, as Coda refuses it at install', async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-events-'));
    temps.push(top);
    const write = (id, manifest) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...manifest })); };
    write('liar', { contributes: { protocols: [deploys] } });
    write('reader', { extensionDependencies: ['liar'], uses: { 'liar/deploy@1': ['watc'] }, contributes: {} });
    const { report } = await checkPlugin(join(top, 'reader'), { manifestOnly: true });
    assert.deepEqual(failed(report), ['manifest.uses']);
    assert.match(report.items.find(item => item.rule === 'manifest.uses').message, /插件 reader 用到的协议 liar\/deploy@1 没有权限组 watc/);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events'), []);
  });
  test('a group of a protocol that is not here is said, with no events listed', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { uses: { 'liar/deploy@1': ['watch'] } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events').map(item => item.message),
      ['用到 liar/deploy@1 的权限组 watch：协议定义不在本地，列不出事件']);
  });
  test('a group of a protocol Coda defines is judged against Coda\'s own definition', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { uses: { 'coda/composer@1': ['read'] } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(report.items.filter(item => item.rule === 'manifest.events').map(item => item.message), ['用到 coda/composer@1 的权限组 read：不含事件']);
    const wrong = await checkPlugin(plugin({ manifest: { uses: { 'coda/composer@1': ['raed'] } } }), { manifestOnly: true });
    assert.deepEqual(failed(wrong.report), ['manifest.uses']);
    assert.match(wrong.report.items.find(item => item.rule === 'manifest.uses').message, /用到的协议 coda\/composer@1 没有权限组 raed/);
  });
  // A plugin `reader` that may use `liar/deploy@1` (of the plugin `liar` beside it unless `beside` is false) by `groups`, and does not depend on it.
  const optionally = ({ groups = ['watch'], beside = true, manifest = {} } = {}) => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-optional-'));
    temps.push(top);
    const write = (id, content) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...content })); };
    if (beside) write('liar', { contributes: { protocols: [deploys] } });
    write('reader', { engines: { coda: 13 }, categories: ['工作流程'], optionalUses: { 'liar/deploy@1': groups }, contributes: {}, ...manifest });
    return join(top, 'reader');
  };
  test('what it may use optionally is said as what it uses is, and the plugin beside it is no dependency', async () => {
    const checked = checkManifest(optionally(), new Report().scope('manifest'));
    assert.deepEqual(checked.dependencies, {});
    assert.equal(checked.definitionOf('liar/deploy@1').name, 'liar/deploy@1');
    const { report } = await checkPlugin(optionally(), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(messages(report, 'manifest.events'), ['可选用到 liar/deploy@1 的事件组 watch：deploy.started、deploy.ended']);
    assert.deepEqual(rules(report, 'warn'), ['manifest.events-main']);
    assert.deepEqual(messages(report, 'manifest.extensions'), []);
  });
  test('a sibling it does not depend on is not looked at by its hard uses, whatever its optionalUses reach', async () => {
    const dir = optionally({ manifest: { uses: { 'liar/deploy@1': ['watc'] }, optionalUses: { 'liar/deploy@1': ['watch'] } } });
    const checked = checkManifest(dir, new Report().scope('manifest'));
    assert.deepEqual(checked.dependencies, {});
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(messages(report, 'manifest.events'), ['用到 liar/deploy@1 的权限组 watc：协议定义不在本地，列不出事件', '可选用到 liar/deploy@1 的事件组 watch：deploy.started、deploy.ended']);
  });
  test('a group the protocol it may use lacks is a warning, not a failure', async () => {
    const { report } = await checkPlugin(optionally({ groups: ['watc'] }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(rules(report, 'warn'), ['manifest.optionalUses']);
    assert.match(messages(report, 'manifest.optionalUses')[0], /插件 reader 可选用到的协议 liar\/deploy@1 当前定义没有权限组 watc/);
    assert.deepEqual(messages(report, 'manifest.events'), []);
  });
  test('a protocol it may use whose definition is not here is only said', async () => {
    const { report } = await checkPlugin(optionally({ beside: false }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(rules(report, 'warn'), []);
    assert.deepEqual(messages(report, 'manifest.events'), ['可选用到 liar/deploy@1 的权限组 watch：协议定义不在本地，列不出事件']);
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
      [{ type: 'string', format: 'coda-directory', default: 'relative' }, /绝对目录/], [{ type: 'string', format: 'coda-unknown' }, /liar\.value/]];
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
  // Concurrency groups are coda/group@1 records, no longer of the manifest: `groups` is a key Coda retired.
  test('a groups key is retired', () => manifestFails({ manifest: { contributes: { groups: [{ name: 'liar', capacity: 'liar.capacity' }],
    configuration: { properties: { 'liar.capacity': { type: 'integer', default: 1 } } } } } }, 'manifest.retired', /contributes\.groups/));
  // Endpoints went with `window.coda.request`: like `groups`, a key Coda retired.
  test('an endpoints key is retired', () => manifestFails({ manifest: { contributes: { endpoints: [] } } }, 'manifest.retired', /contributes\.endpoints/));
  // Coda reads these (docs/plugins.md); the checker does not refuse a plugin for bringing them.
  test('Skills, variables, PATH, MCP servers, views and model services are contributions Coda takes', async () => {
    const contributes = { skills: [], environment: {}, path: [], mcpServers: {}, views: [], modelProviders: [] };
    const { report } = await checkPlugin(plugin({ manifest: { contributes } }), { manifestOnly: true });
    assert.ok(!failed(report).includes('manifest.contributes'), JSON.stringify(report.failures));
  });
  test('commands of its own are taken', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { commands: [{ name: 'liar-run', command: 'exec true' }] } } }), { manifestOnly: true });
    assertPasses(report, ['manifest.commands']);
  });
  // Of the plugins it depends on, one of the same repository is there (as Coda installs it along); one Coda ships has its
  // directory in Coda, not here, even with a plugin of its ID from another source beside it: Coda picks its own.
  test("a resource record command gets what Coda gives a plugin's processes, and the directories of the plugins it depends on beside it", async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-deps-')), dir = join(top, 'reader');
    temps.push(top);
    execFileSync('git', ['init', '-q', top]);
    mkdirSync(join(top, 'base'));
    writeFileSync(join(top, 'base/package.json'), JSON.stringify({ name: '@acme/base', id: 'base', version: '1.0.0', contributes: {} }));
    mkdirSync(join(top, 'github'));
    writeFileSync(join(top, 'github/package.json'), JSON.stringify({ name: 'github', version: '1.0.0', contributes: {} }));
    mkdirSync(dir);
    const seen = join(top, 'seen.json');
    writeFileSync(join(dir, 'resource.mjs'), `#!/usr/bin/env node
      import { writeFileSync } from 'node:fs';
      const e = process.env;
      writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ dependencies: JSON.parse(e.CODA_PLUGIN_DEPENDENCIES),
        settings: JSON.parse(e.CODA_PLUGIN_SETTINGS), groups: JSON.parse(e.CODA_GROUPS_STATE).groups, node: e.CODA_NODE, thread: e.CODA_THREAD_ID ?? null }));
      console.log(JSON.stringify([{ key: 'env', spec: { type: 'env', title: '环境', resources: [{ values: [{ value: 'ok' }], buttons: [] }] } }]));`, { mode: 0o755 });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'reader', version: '1.0.0', engines: { coda: 6 }, extensionDependencies: ['base', 'github'], contributes: {
      configuration: { properties: { 'reader.size': { type: 'integer', default: 3 } } },
      protocolImplementations: ['coda/resource@1'], records: [{ kind: 'coda/resource@1', command: 'resource.mjs' }] } }));
    // A check run from inside a session: neither its ID nor its plugin's variables reach the plugin's processes.
    const before = { CODA_THREAD_ID: process.env.CODA_THREAD_ID, CODA_PLUGIN_EXTENSIONS: process.env.CODA_PLUGIN_EXTENSIONS };
    Object.assign(process.env, { CODA_THREAD_ID: 'a-session', CODA_PLUGIN_EXTENSIONS: '{"x":[]}' });
    try {
      const { report } = await checkPlugin(dir, { limits });
      assert.deepEqual(report.failures, []);
      assert.match(report.items.find(item => item.rule === 'manifest.extensions').message, /github 不在旁边，检查时不带/);
      assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), { dependencies: { base: realpathSync(join(top, 'base')) }, settings: { 'reader.size': 3 },
        groups: [], node: process.execPath, thread: null });
    } finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  // A plugin whose resource record command is the script `script` (executable, with its `#!`: `executable` makes it so).
  const recorder = ({ script }) => plugin({ files: { 'resource.mjs': script },
    manifest: { engines: { coda: 6 }, contributes: { protocolImplementations: ['coda/resource@1'], records: [{ kind: 'coda/resource@1', command: 'resource.mjs' }] } } });
  const executable = dir => chmodSync(join(dir, 'resource.mjs'), 0o755);
  const record = spec => `#!/usr/bin/env node\nconsole.log(JSON.stringify([{ key: 'usage', spec: { type: 'usage', title: '用量', resources: [${spec}] } }]))`;
  test('a resource record whose output Coda cannot read', async () => {
    const dir = recorder({ script: record("{ values: [{ label: '用量', fraction: 1.5 }], buttons: [] }") });
    executable(dir);
    const { report } = await checkPlugin(dir, { limits });
    assert.ok(failed(report).includes('resource.output'), JSON.stringify(report.items, null, 1));
    assert.match(report.failures.find(f => f.rule === 'resource.output').message, /输出不合 coda\/resource@1：.*fraction/);
  });
  test('a resource that explains itself is not of the protocol', async () => {
    const dir = recorder({ script: record("{ name: '用量', subtitle: '本月', values: [], buttons: [] }") });
    executable(dir);
    const { report } = await checkPlugin(dir, { limits });
    assert.match(report.failures.find(f => f.rule === 'resource.output').message, /subtitle/);
  });
  test('records of another type than their key, or an array that is not one, fail the output', async () => {
    for (const [script, expected] of [
      [`#!/usr/bin/env node\nconsole.log(JSON.stringify([{ key: 'other', spec: { type: 'usage', title: '用量', resources: [] } }]))`, /spec\.type（usage）须与 key 相同/],
      [`#!/usr/bin/env node\nconsole.log(JSON.stringify({ resources: [] }))`, /不是数组/]]) {
      const dir = recorder({ script });
      executable(dir);
      assert.match((await checkPlugin(dir, { limits })).report.failures.find(f => f.rule === 'resource.output').message, expected);
    }
  });
  test('a record command that fails says what it said, and the record Coda has stays', async () => {
    const dir = recorder({ script: `#!/bin/sh\necho 读不到用量 >&2\nexit 3\n` });
    executable(dir);
    const { report } = await checkPlugin(dir, { limits });
    const failures = report.failures.filter(f => f.rule.startsWith('resource.'));
    assert.deepEqual(failures.map(f => f.rule), ['resource.read']);
    assert.match(failures[0].message, /读取没成功：.*读不到用量/);
  });
  test('resourceRecords gives the records of a plugin and throws what is wrong with them', async () => {
    const dir = recorder({ script: record("{ values: [{ value: '1' }], buttons: [] }") });
    executable(dir);
    assert.deepEqual(await resourceRecords(dir), [{ key: 'usage', spec: { type: 'usage', title: '用量', resources: [{ values: [{ value: '1' }], buttons: [] }] } }]);
    const bad = recorder({ script: record("{ values: [], buttons: [] }") });
    executable(bad);
    await assert.rejects(resourceRecords(bad));
  });
});

describe('a check that is stopped', () => {
  // A record command that says who it is and where its state is, then takes its time.
  for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} while a record is read leaves neither its process nor its state directory`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-check-test-')), mark = join(dir, 'mark');
    temps.push(dir);
    writeFileSync(join(dir, 'slow.sh'), `#!/bin/sh\necho "$$ $CODA_PLUGIN_STATE" > '${mark}'; exec sleep 30\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'slow', version: '1.0.0', engines: { coda: 6 },
      contributes: { protocolImplementations: ['coda/resource@1'], records: [{ kind: 'coda/resource@1', command: 'slow.sh' }] } }));
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

// A plugin with a module: `main` is its text, its protocol `mod/note@1` has the operations `find` and `add`.
const OBJECT = { type: 'object', properties: {}, additionalProperties: false };
const NOTE = { name: 'mod/note@1', title: '便条', spec: OBJECT, status: OBJECT, operations: {
  find: { safe: true, input: OBJECT, result: OBJECT }, add: { idempotent: true, input: OBJECT, result: OBJECT } } };
const BOTH = `export function activate(coda) { coda.handle('mod/note@1', 'find', async () => ({})); coda.handle('mod/note@1', 'add', async () => ({})); }`;
function modulePlugin({ main = BOTH, manifest = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-check-module-'));
  temps.push(dir);
  writeFileSync(join(dir, 'main.mjs'), main);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mod', version: '1.0.0', main: 'main.mjs', engines: { coda: 3 }, categories: ['工作流程'],
    contributes: { protocols: [NOTE], protocolImplementations: ['mod/note@1'] }, ...manifest }));
  return dir;
}
const messages = (report, rule) => report.items.filter(item => item.rule === rule).map(item => item.message);

describe('the module level', () => {
  test('a module that registers what the manifest implements passes', async () => {
    const { report } = await checkPlugin(modulePlugin());
    assertPasses(report, ['module.activate', 'module.registered']);
    assert.match(messages(report, 'module.registered')[0], /登记了 2 个操作/);
  });
  test('an operation the manifest implements and the module does not register fails', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate(coda) { coda.handle('mod/note@1', 'find', async () => ({})); }` }));
    assert.deepEqual(failed(report), ['module.unregistered']);
    assert.match(report.failures[0].message, /mod\/note@1 的操作 add，模块没登记/);
  });
  test('an operation of a command is not the module\'s to register', async () => {
    const files = { 'add.sh': '#!/bin/sh\necho {}\n' };
    const dir = modulePlugin({ files, manifest: { contributes: { protocols: [NOTE], protocolImplementations: [{ kind: 'mod/note@1', commands: { add: 'add.sh' } }] } },
      main: `export function activate(coda) { coda.handle('mod/note@1', 'find', async () => ({})); }` });
    chmodSync(join(dir, 'add.sh'), 0o755);
    assertPasses((await checkPlugin(dir)).report, ['module.registered']);
  });
  test('a module that implements coda/resource@1 with the commands of the operations it has registers no others', async () => {
    const files = { 'sign-in.sh': '#!/bin/sh\necho {}\n' };
    const dir = modulePlugin({ files, manifest: { engines: { coda: 6 }, contributes: { protocols: [NOTE], protocolImplementations: ['mod/note@1', { kind: 'coda/resource@1', commands: { 'sign-in': 'sign-in.sh' } }] } } });
    chmodSync(join(dir, 'sign-in.sh'), 0o755);
    assertPasses((await checkPlugin(dir)).report, ['module.registered']);
  });
  test('an operation the module registers and the manifest does not write fails', async () => {
    const unknownOperation = await checkPlugin(modulePlugin({ main: `${BOTH.slice(0, -2)} coda.handle('mod/note@1', 'extra', async () => ({})); }` }));
    assert.deepEqual(failed(unknownOperation.report), ['module.unlisted']);
    assert.match(unknownOperation.report.failures[0].message, /登记了 mod\/note@1 的操作 extra，协议定义里没有/);
    // A protocol the manifest does not implement is refused as the module registers it.
    const unknownKind = await checkPlugin(modulePlugin({ main: `${BOTH.slice(0, -2)} coda.handle('other/thing@1', 'go', async () => ({})); }` }));
    assert.deepEqual(failed(unknownKind.report), ['module.activate']);
    assert.match(unknownKind.report.failures[0].message, /没有实现 other\/thing@1/);
  });
  test('an activate that throws fails, with the first line of its stack', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate() { throw new Error('起不来'); }` }));
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /activate 失败：Error: 起不来$/);
  });
  test('an activate that does not finish in time fails', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate() { return new Promise(() => {}); }` }), { limits: { ...limits, activate: 200 } });
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /0\.2 秒没完成/);
  });
  test('a coda.on of an event outside the plugin\'s event groups fails', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate(coda) { coda.on('thread.created', () => {}); }` }));
    assert.deepEqual(failed(report), ['module.events']);
    assert.match(report.failures[0].message, /没有订事件 thread\.created/);
  });
  test('an activate that throws nothing says so, and does not stop the check', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate() { throw null; }` }));
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /activate 失败：null$/);
  });
  test('a forbidden from anywhere but coda.on is the module\'s own failure', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate() { throw Object.assign(new Error('不许'), { code: 'forbidden' }); }` }));
    assert.deepEqual(failed(report), ['module.activate']);
  });
  test('deactivate is called once the module has been activated, and its failure is the module\'s', async () => {
    const gone = body => modulePlugin({ main: `import { writeFileSync } from 'node:fs';\n${BOTH}\nexport function deactivate() { writeFileSync(new URL('./gone', import.meta.url), 'x'); ${body} }` });
    const dir = gone('');
    assert.deepEqual(failed((await checkPlugin(dir)).report), []);
    assert.ok(existsSync(join(dir, 'gone')), 'deactivate ran');
    const { report } = await checkPlugin(gone(`throw new Error('收不拢');`));
    assert.deepEqual(failed(report), ['module.deactivate']);
    assert.match(report.failures[0].message, /deactivate 失败：Error: 收不拢$/);
  });
  test('what the test host does not provide ends the check of the module there, as a note, not a failure', async () => {
    for (const [use, shown] of [[`coda.watch('other/x@1', () => {})`, 'watch'], [`coda.tell('s', 't')`, 'tell'], [`coda.pluginSetup.retry('x')`, 'pluginSetup.retry']]) {
      const { report } = await checkPlugin(modulePlugin({ main: `export async function activate(coda) { await ${use}; }` }));
      assert.deepEqual(failed(report), []);
      assert.deepEqual(rules(report, 'warn'), ['module.registered']);
      assert.match(messages(report, 'module.registered')[0], /^未完成核对/);
      assert.deepEqual(rules(report, 'pass').filter(rule => rule.startsWith('module.')), []);
      assert.equal(messages(report, 'note.host')[0], `模块用到测试宿主不提供的能力 coda.${shown}，模块一级只验到这里`);
    }
  });
  test('an unsupported from another member than those the test host lacks is the module\'s failure', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export async function activate(coda) { await coda.query({ kind: 'mod/note@1', id: 'a' }, 'add', {}); }` }));
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /不是只读的操作/);
    assert.deepEqual(messages(report, 'note.host'), []);
  });
  test('a deactivate that waits for what never finishes fails in time, as an activate does', async () => {
    const main = `${BOTH}\nexport function deactivate() { return new Promise(() => {}); }`;
    const { report } = await checkPlugin(modulePlugin({ main }), { limits: { ...limits, activate: 200 } });
    assert.deepEqual(failed(report), ['module.deactivate']);
    assert.match(report.failures[0].message, /deactivate 失败：Error: 0\.2 秒没完成$/);
  });
  test('deactivate is not called when the activate did not finish: failed, timed out or not fully checked', async () => {
    const gone = (activate, limit) => {
      const dir = modulePlugin({ main: `import { writeFileSync } from 'node:fs';\nexport ${activate}\nexport function deactivate() { writeFileSync(new URL('./gone', import.meta.url), 'x'); }` });
      return checkPlugin(dir, { limits: { ...limits, ...(limit && { activate: limit }) } }).then(({ report }) => ({ report, ran: existsSync(join(dir, 'gone')) }));
    };
    const failing = await gone(`function activate() { throw new Error('起不来'); }`);
    assert.deepEqual(failed(failing.report), ['module.activate']);
    assert.equal(failing.ran, false);
    const hanging = await gone(`function activate() { return new Promise(() => {}); }`, 200);
    assert.deepEqual(failed(hanging.report), ['module.activate']);
    assert.equal(hanging.ran, false);
    const lacking = await gone(`async function activate(coda) { await coda.tell('s', 't'); }`);
    assert.deepEqual(failed(lacking.report), []);
    assert.match(messages(lacking.report, 'module.registered')[0], /^未完成核对/);
    assert.equal(lacking.ran, false);
  });
  // A plugin `reader` with a module, using `liar/deploy@1` of its dependency `liar` (written beside it unless `beside` is false;
  // its protocol is `definition`) by `groups`, and `more` of other protocols no definition of which is here.
  const DEPLOY = { name: 'liar/deploy@1', title: '部署', spec: OBJECT, status: OBJECT, events: { 'deploy.started': { payload: { type: 'object' } } },
    permissions: { watch: { title: '看部署', events: ['deploy.started'] }, read: { title: '读部署', read: true } } };
  const EVENTS_ONLY = { name: DEPLOY.name, title: DEPLOY.title, events: DEPLOY.events, permissions: { watch: DEPLOY.permissions.watch } };
  const reading = ({ main, beside = true, groups = ['watch'], definition = DEPLOY, more = {}, by = 'uses', engines = { coda: 3 }, depends = ['liar'] }) => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-uses-'));
    temps.push(top);
    const write = (id, manifest) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...manifest })); };
    if (beside) write('liar', { contributes: { protocols: [definition] } });
    write('reader', { main: 'main.mjs', engines, categories: ['工作流程'], extensionDependencies: depends, [by]: { 'liar/deploy@1': groups, ...more }, contributes: {} });
    writeFileSync(join(top, 'reader', 'main.mjs'), main);
    return join(top, 'reader');
  };
  const LIST = `export async function activate(coda) { await coda.list('liar/deploy@1'); }`;
  test('a coda.on of an event group it may use only optionally passes, as one of its uses does', async () => {
    const { report } = await checkPlugin(reading({ main: `export function activate(coda) { coda.on('deploy.started', () => {}); }`, by: 'optionalUses', engines: { coda: 13 } }));
    assert.deepEqual(failed(report), []);
    assert.deepEqual(rules(report, 'pass').filter(rule => rule.startsWith('module.')), ['module.activate', 'module.registered']);
  });
  test('a coda.on of an event group it may use optionally passes with a plugin beside it that it does not depend on', async () => {
    const { report } = await checkPlugin(reading({ main: `export function activate(coda) { coda.on('deploy.started', () => {}); }`, by: 'optionalUses', engines: { coda: 13 }, depends: [] }));
    assert.deepEqual(failed(report), []);
    assert.deepEqual(rules(report, 'pass').filter(rule => rule.startsWith('module.')), ['module.activate', 'module.registered']);
  });
  test('a coda.on of an event group of a dependency beside it passes; without the dependency the check is not completed', async () => {
    const main = `export function activate(coda) { coda.on('deploy.started', () => {}); }`;
    const beside = await checkPlugin(reading({ main }));
    assert.deepEqual(failed(beside.report), []);
    assert.deepEqual(rules(beside.report, 'pass').filter(rule => rule.startsWith('module.')), ['module.activate', 'module.registered']);
    const apart = await checkPlugin(reading({ main, beside: false }));
    assert.deepEqual(failed(apart.report), []);
    assert.deepEqual(rules(apart.report, 'warn').filter(rule => rule === 'module.registered'), ['module.registered']);
    assert.match(messages(apart.report, 'module.registered')[0], /^未完成核对：协议 liar\/deploy@1 的定义不在本地/);
  });
  test('a coda.list of records it may read passes with the dependency beside it, whose record types the test host has; without it the check is not completed', async () => {
    const beside = (await checkPlugin(reading({ main: LIST, beside: true, groups: ['read'] }))).report;
    assert.deepEqual(failed(beside), []);
    assert.ok(rules(beside, 'pass').includes('module.activate'));
    const alone = (await checkPlugin(reading({ main: LIST, beside: false, groups: ['read'] }))).report;
    assert.deepEqual(failed(alone), []);
    assert.match(messages(alone, 'module.registered')[0], /^未完成核对：协议 liar\/deploy@1 的定义不在本地/);
    assert.deepEqual(rules(alone, 'pass').filter(rule => rule.startsWith('module.')), []);
  });
  test('a coda.list of records of a protocol it uses only for events fails: the group it asked for does not read', async () => {
    const { report } = await checkPlugin(reading({ main: LIST, groups: ['watch'] }));
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /须在清单的 uses 或 optionalUses 里写 liar\/deploy@1 的权限组 read/);
  });
  test('a coda.list of a protocol of events only is the module\'s failure, not the test host\'s limit', async () => {
    const { report } = await checkPlugin(reading({ main: LIST, definition: EVENTS_ONLY }));
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /没有协议：liar\/deploy@1/);
    assert.deepEqual(rules(report, 'warn').filter(rule => rule === 'module.registered'), []);
  });
  test('a coda.on outside the event groups it uses fails, with the dependency beside it or an unrelated one missing', async () => {
    for (const more of [{}, { 'ghost/thing@1': ['read'] }]) {
      // `deploy.started` is liar's, its group `watch` not among those used.
      const { report } = await checkPlugin(reading({ main: `export function activate(coda) { coda.on('deploy.started', () => {}); }`, groups: ['read'], more }));
      assert.deepEqual(failed(report), ['module.events']);
      assert.deepEqual(rules(report, 'warn').filter(rule => rule === 'module.registered'), []);
    }
  });
  test('a coda.on of a name no definition here has is not completed while a definition is missing', async () => {
    const { report } = await checkPlugin(reading({ main: `export function activate(coda) { coda.on('ghost.thing', () => {}); }`, more: { 'ghost/thing@1': ['watch'] } }));
    assert.deepEqual(failed(report), []);
    assert.match(messages(report, 'module.registered')[0], /^未完成核对：协议 ghost\/thing@1 的定义不在本地/);
  });
  test('a member the test host lacks failing otherwise is the module\'s failure', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export async function activate(coda) { await coda.watch('other/x@1', '不是函数'); }` }));
    assert.deepEqual(failed(report), ['module.activate']);
    assert.match(report.failures[0].message, /watch\(集合, fn, 筛选\?\)/);
  });
  test('what the module ends with decides where it failed, not a later call that failed', async () => {
    const main = `export async function activate(coda) {
      let error;
      try { await coda.watch('other/x@1', () => {}); } catch (e) { error = e; }
      try { await coda.query({ kind: 'mod/note@1', id: 'a' }, 'add', {}); } catch {}
      throw error;
    }`;
    const { report } = await checkPlugin(modulePlugin({ main }));
    assert.deepEqual(failed(report), []);
    assert.equal(messages(report, 'note.host')[0], '模块用到测试宿主不提供的能力 coda.watch，模块一级只验到这里');
  });
  test('the test host still answers what it lacks as the checker recognizes it', async () => {
    const asked = { watch: c => c.watch('other/x@1', () => {}), 'services.register': c => c.services.register('s', () => {}), tell: c => c.tell('s', 't'),
      'protocols.upload': c => c.protocols.upload('u'), 'pluginSetup.retry': c => c.pluginSetup.retry('x') };
    // `api` is no longer a member of `coda` (API Level 9 removed it), so there is nothing to ask for it; NOT_PROVIDED still lists it.
    assert.deepEqual(Object.keys(asked).sort(), Object.keys(NOT_PROVIDED).filter(member => member !== 'api').sort());
    const host = createTestHost({ plugin: { id: 'x', path: tmpdir(), state: null } });
    try {
      for (const [member, ask] of Object.entries(asked)) {
        const error = await ask(host.coda).then(() => null, e => e);
        assert.deepEqual([error?.code, error?.message], [NOT_PROVIDED[member].code, NOT_PROVIDED[member].message], member);
      }
    } finally { await host.close(); }
  });
  test('a protocol whose definition is not here leaves the comparison undone, which is no pass', async () => {
    const { report } = await checkPlugin(modulePlugin({ manifest: { contributes: { protocolImplementations: ['other/thing@1'] } }, main: `export function activate() {}` }));
    assert.deepEqual(failed(report), []);
    assert.match(messages(report, 'module.registered')[0], /^未完成核对：协议 other\/thing@1 的定义不在本地/);
    assert.deepEqual(rules(report, 'pass').filter(rule => rule === 'module.registered'), []);
  });
  test('--manifest does not load the module', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `throw new Error('不该被加载');` }), { manifestOnly: true });
    assert.deepEqual(report.items.filter(item => item.level === 'module'), []);
    assert.deepEqual(failed(report), []);
  });
});

describe('engines.coda against what the plugin uses', () => {
  test('a key or a definition of a later Level than engines.coda fails', async () => {
    const { report } = await checkPlugin(modulePlugin({ manifest: { engines: { coda: 2 } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), ['manifest.level']);
    assert.match(report.failures[0].message, /^用到 definition .+（Level 3），engines\.coda 至少写 3（现写 2）$/);
  });
  test('a key of contributes of a later Level than engines.coda fails, by the surface Coda has', async () => {
    const dir = modulePlugin({ manifest: { engines: { coda: 1 }, contributes: { self: { ask: 'ask.sh' } } }, files: { 'ask.sh': '#!/bin/sh\n' } });
    chmodSync(join(dir, 'ask.sh'), 0o755);
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(failed(report), ['manifest.level']);
    assert.match(report.failures[0].message, /^用到 manifest contributes\.self（Level 8），engines\.coda 至少写 8（现写 1）$/);
  });
  test('a group of `uses` of a later Level than engines.coda fails', async () => {
    const dir = modulePlugin({ manifest: { engines: { coda: 1 }, contributes: {}, uses: { 'coda/thread@1': ['read'] } } });
    const report = new Report(), checked = checkManifest(dir, report.scope('manifest'));
    checkLevel({ checked, say: report.scope('manifest'), note: report.scope('note'), surface: parseSurface('level 2\n1 manifest engines.coda\n2 coda/thread@1 read\n') });
    assert.deepEqual(failed(report), ['manifest.level']);
    assert.match(report.failures[0].message, /^用到 coda\/thread@1 read（Level 2），engines\.coda 至少写 2（现写 1）$/);
  });
  test('what the text of its files says only remarks on it', async () => {
    const dir = modulePlugin({ manifest: { engines: { coda: 2 }, contributes: {} }, main: `export function activate(coda) { coda.tell('s', 'x'); }` });
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.deepEqual(rules(report, 'warn'), ['manifest.level-text']);
    assert.match(messages(report, 'manifest.level-text')[0], /module coda\.tell（Level 3），engines\.coda 写 2/);
  });
  test('without engines.coda it remarks, and gives the value to write', async () => {
    const { report } = await checkPlugin(modulePlugin({ manifest: { engines: undefined } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.match(messages(report, 'manifest.level')[0], /没写 engines\.coda：用到的项最高 Level 3.*"engines": \{ "coda": 3 \}/);
  });
  // A reader that may use `liar/deploy@1` (its `watch` group of Level 14 here, the group `trial` a trial one) beside it, by `engines.coda` `written`.
  const OPTIONAL_SURFACE = 'level 14\n1 manifest engines.coda\n13 manifest optionalUses\n14 liar/deploy@1 watch\n';
  const optionalLevel = (written, { uses = {} } = {}) => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-level-'));
    temps.push(top);
    const write = (id, content) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...content })); };
    const deploy = { name: 'liar/deploy@1', title: '部署', events: { 'deploy.started': { payload: { type: 'object' } } },
      permissions: { watch: { title: '看部署', events: ['deploy.started'], trial: true } } };
    write('liar', { contributes: { protocols: [deploy] } });
    write('reader', { engines: { coda: written }, categories: ['工作流程'], optionalUses: { 'liar/deploy@1': ['watch'] }, uses, contributes: {} });
    const report = new Report(), checked = checkManifest(join(top, 'reader'), report.scope('manifest'));
    checkLevel({ checked, say: report.scope('manifest'), note: report.scope('note'), surface: parseSurface(OPTIONAL_SURFACE) });
    return report;
  };
  test('optionalUses itself needs Level 13', () => {
    const report = optionalLevel(12);
    assert.deepEqual(failed(report), ['manifest.level']);
    assert.match(report.failures[0].message, /^用到 manifest optionalUses（Level 13），engines\.coda 至少写 13（现写 12）$/);
  });
  test('what it may use of a later Level does not raise the Level it needs, and is remarked on', () => {
    const report = optionalLevel(13);
    assert.deepEqual(failed(report), []);
    assertPasses(report, ['manifest.level']);
    assert.deepEqual(messages(report, 'note.optional-level'), ['可选用到 liar/deploy@1 watch（Level 14），engines.coda 写 13：Coda 低于 Level 14 时这项自动不可用']);
    assert.deepEqual(optionalLevel(14).items.filter(item => item.rule === 'note.optional-level'), []);
  });
  test('a trial group it may use is listed once, though it also uses it', () => {
    assert.deepEqual(messages(optionalLevel(13), 'note.trial'), ['用到试行面：liar/deploy@1 的权限组 watch，随 Coda 版本可能变']);
    assert.deepEqual(messages(optionalLevel(14, { uses: { 'liar/deploy@1': ['watch'] } }), 'note.trial'), ['用到试行面：liar/deploy@1 的权限组 watch，随 Coda 版本可能变']);
  });
  test('a plugin writing enough passes, and lists the trial surface it uses', async () => {
    const { report } = await checkPlugin(modulePlugin({ main: `export function activate(coda) { coda.tell('s', 'x'); }` }), { manifestOnly: true });
    assertPasses(report, ['manifest.level']);
    assert.deepEqual(report.items.filter(item => item.level === 'note').map(item => item.message), ['用到试行面：模块接口 coda.tell，随 Coda 版本可能变']);
  });
});
