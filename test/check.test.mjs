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
  for (const rule of expected) assert.ok(passed.includes(rule), `${rule} passed: ${passed.join(', ')}`);
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
  test('templates/panel reads as a panel', async () => {
    const { report } = await checkPlugin(at('templates/panel'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'manifest.panels', 'panel.read']);
    assert.match(report.items.find(item => item.rule === 'panel.read').message, /card ×1.*button ×1.*meter ×1/);
  });
  // Coda's own types, and those the points of the plugins Coda ships declare (the resources plugin's `panels`), pass; another
  // no plugin declares is of no type.
  test('contributes takes what Coda takes, and refuses what nothing takes', async () => {
    const read = async contributes => (await checkPlugin(plugin({ manifest: { contributes } }), { manifestOnly: true })).report;
    const known = await read({ panels: [], executors: [] }), other = await read({ menus: [] });
    assert.deepEqual(failed(known), []);
    assert.deepEqual(failed(other), ['manifest.offers']);
    assert.match(other.failures[0].message, /menus/);
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
    assertPasses(report, ['manifest.name', 'manifest.agents']);
    assert.equal(cursor.agents[0].command, 'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/entry.mjs"');
  });
  test('the command line exits 0 on a pass and 1 on a failure', () => {
    const run = (...args) => spawnSync(process.execPath, [at('bin/check.mjs'), ...args], { encoding: 'utf8' });
    const good = run(at('templates/panel'));
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
    const quota = await run({ promptError: error({ kind: 'quota_exhausted', input: 'future', retryAfterMs: -1 }) });
    assert.deepEqual(failed(quota), ['live.turn']);
    assert.match(quota.failures[0].message, /额度不足/);
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
  test('the events it publishes are said', async () => {
    const { report } = await checkPlugin(plugin({ manifest: { contributes: { events: [{ name: 'deploy.started' }, { name: 'deploy.ended', starts: false, ends: true }] } } }), { manifestOnly: true });
    assert.deepEqual(failed(report), []);
    assert.match(report.items.find(item => item.rule === 'manifest.events').message, /deploy\.started、deploy\.ended/);
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
  test('a group with a key Coda does not read', () => manifestFails({ manifest: { contributes: { groups: [{ name: 'liar', capacity: 'liar.capacity', note: '' }],
    configuration: { properties: { 'liar.capacity': { type: 'integer', default: 1 } } } } } }, 'manifest.read', /contributes\.groups/));
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
  // A type is declared by a plugin it depends on through another as well: the checker looks for each beside it, once.
  test('a key of contributes a plugin it depends on through another declares is of that type', async () => {
    const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-chain-'));
    temps.push(top);
    const write = (id, manifest) => { mkdirSync(join(top, id)); writeFileSync(join(top, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', ...manifest })); };
    write('provider', { contributes: { extensionPoints: { widgets: { description: '小部件', contributes: 'widgets', title: '小部件' } } } });
    write('base', { extensionDependencies: ['provider'], contributes: {} });
    write('reader', { extensionDependencies: ['base'], contributes: { widgets: [{ id: 'clock' }] } });
    write('stray', { contributes: { widgets: [{ id: 'clock' }] } });
    assert.deepEqual(failed((await checkPlugin(join(top, 'reader'), { manifestOnly: true })).report), []);
    assert.deepEqual(failed((await checkPlugin(join(top, 'stray'), { manifestOnly: true })).report), ['manifest.offers']);
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
