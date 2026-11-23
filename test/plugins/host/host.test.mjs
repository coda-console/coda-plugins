// The 宿主资源 plugin's scripts, run as Coda runs them (plugins/host/README.md): its resource over the groups as Coda says they
// are, its command host-sim in a session, a step and a held command, the step of 持锁执行 and that of 清点模拟器. How Coda's
// engine queues them (hold-group, coda:group) is Coda's own to test; a simulator tool here is a stand-in's.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { runFinished } from '../../../plugins/host/lib/simulator-status.mjs';
import { registerSimulator, registrations } from '../../../plugins/host/lib/simulators.mjs';
import { pluginDir } from '../plugin.mjs';
import { barePath, manifest, pluginEnv, run } from '../command.mjs';
import { resourceRecords } from '../../helpers/resources.mjs';
import { activate, deactivate } from '../../../plugins/host/main.mjs';
import { createMockCoda, TEST_OWNER } from '../../helpers/mock-coda.mjs';

const dir = pluginDir('host');
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'host-plugin-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
// The environment of a command of the plugin's, without what would say a slot is held here or that this is an environment's own
// backend: the tests may run inside one.
const env = (extra = {}) => {
  const base = pluginEnv('host', { CODA_NODE: process.execPath, ...extra });
  for (const name of ['HOST_SIM_LEASE', 'HOST_SIM_DEVICES', 'CODA_GROUPS', 'CODA_THREAD_ID', 'CODA_ARBITER', 'HOST_SIM_RUN_ID', 'GITHUB_RUN_ID']) if (!(name in extra)) delete base[name];
  return base;
};
const hostSim = (args, extra) => run(`${manifest('host').contributes.commands.find(c => c.name === 'host-sim').command} ${args}`, env(extra));
// A simulator tool standing in for xcrun: `simctl` keeps its devices in a file and logs what it was asked.
function simctl(t, devices = [], { cancelDuringCleanup = false } = {}) {
  const at = temporary(t), state = join(at, 'devices'), log = join(at, 'simctl.log'), tool = join(at, 'simctl');
  writeFileSync(state, devices.map(d => `${d}\n`).join(''));
  writeFileSync(tool, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2).filter(a => a !== 'simctl');
const read = () => fs.readFileSync(${JSON.stringify(state)}, 'utf8').split('\\n').filter(Boolean);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (${cancelDuringCleanup} && args[0] === 'shutdown') process.kill(process.ppid, 'SIGTERM');
if (args[0] === 'list') process.stdout.write(JSON.stringify({ devices: { r: read().map(udid => ({ udid, name: udid, state: 'Booted' })) } }));
if (args[0] === 'delete' && args[1] !== 'STUCK') fs.writeFileSync(${JSON.stringify(state)}, read().filter(u => u !== args[1]).map(u => u + '\\n').join(''));
`, { mode: 0o755 });
  return { tool, devices: () => readFileSync(state, 'utf8').split('\n').filter(Boolean), log: () => existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('the slots are the group record the module writes, the capacity that of the setting, and the manifest declares no groups', async t => {
  assert.equal(manifest('host').contributes.groups, undefined);
  assert.deepEqual(manifest('host').contributes.protocolImplementations, ['coda/group@1', 'coda/resource@1']);
  const host = createMockCoda({ plugin: { id: 'host', state: temporary(t), protocols: manifest('host').contributes.protocols, protocolImplementations: ['coda/group@1'] }, settings: { 'host.capacity': 2 } });
  t.after(() => host.close());
  const rows = () => host.coda.list('coda/group@1', { scope: 'local' });
  await activate(host.coda);
  let [row, ...more] = await rows();
  assert.deepEqual([row.key, more.length], ['host', 0]);
  assert.deepEqual(row.spec, { name: 'host', capacity: 2, reach: { scope: 'machine' }, attributes: {}, unique: [] });
  // Coda keeps the status of a group of capacity 1, and a larger one has none.
  assert.deepEqual(row.status, {});
  await host.setSettings({ 'host.capacity': 5 });
  [row, ...more] = await rows();
  assert.deepEqual([row.spec.capacity, more.length], [5, 0]);
  await host.setSettings({ 'host.capacity': 1 });
  assert.deepEqual((await rows())[0].status, { state: 'free' });
  await deactivate();
  await host.setSettings({ 'host.capacity': 3 });
  assert.equal((await rows())[0].spec.capacity, 1);
});

test('the resource shows the free slots, who holds the group host and who waits; one holding it whole leaves none free', async t => {
  const now = Date.UTC(2026, 9, 13, 12), ago = minutes => now - minutes * 60_000;
  const one = (runId, title, thread, since, more = {}) => ({ runId, workflow: 'w', title, status: null, threadId: 't', thread, since, ...more });
  const host = { name: 'host', occupied: 1, holders: [one('r1', 'testflight', null, ago(75), { borrowed: false, leaving: false })],
    queue: [one('r2', 'xcodebuild test', '会话乙', ago(2), { capacity: 2 })] };
  // The capacity is that of the group's record, as `coda resources group-owner host` says it: the setting may be ahead of it
  // (changed, the record not yet written) and says 5 here, or the record not yet written at all (null). A `coda` that fails
  // says why on its standard error. Nothing of the machine is on the PATH or in the home directory but this Node and the stand-in.
  const tools = temporary(t), node = await barePath(tools, tools);
  const record = body => writeFileSync(join(tools, 'coda'), `#!/bin/sh\n[ "$1 $2 $3" = "resources group-owner host" ] || exit 9\n${body}\n`, { mode: 0o755 });
  const answer = value => record(`echo '${JSON.stringify(value)}'`);
  answer({ name: 'host', capacity: 2 });
  const read = async groups => {
    const [{ key, spec }, ...more] = await resourceRecords(dir, { env: env({ CODA_GROUPS_STATE: JSON.stringify({ now, groups }),
      CODA_PLUGIN_SETTINGS: JSON.stringify({ 'host.capacity': 5 }), PATH: node, HOME: tools }) });
    assert.deepEqual([key, spec.type, spec.title, more.length, spec.resources.length], ['slots', 'slots', '构建名额', 0, 1]);
    return spec.resources[0];
  };
  const { values: slots, buttons } = await read([host]);
  assert.deepEqual(slots.map(i => [i.label, i.value]), [['空闲', '1 / 2'], ['testflight', '占用 1 小时 15 分钟'], ['xcodebuild test · 会话乙', '排第 1 位，等了 2 分钟']]);
  assert.equal(slots[0].fraction, 0.5);
  assert.deepEqual(buttons, []);
  const cleaning = await read([{ ...host, holders: [one('r6', '清点模拟器', null, ago(1), { borrowed: false, leaving: false, exclusive: true })] }]);
  assert.deepEqual(cleaning.values.slice(0, 2).map(i => [i.label, i.value]), [['空闲', '0 / 2'], ['清点模拟器', '占满 1 分钟']]);
  assert.deepEqual((await read([])).values.map(i => [i.label, i.value]), [['空闲', '2 / 2']]);
  // No record yet: the group is Coda's own queue of one.
  answer(null);
  assert.deepEqual((await read([host])).values.slice(0, 1).map(i => [i.label, i.value]), [['空闲', '0 / 1']]);
  answer({ name: 'host', capacity: 2 });
  // As many as a resource has values: the free slots, then those holding it, then those waiting.
  const many = await read([{ ...host, queue: Array.from({ length: 12 }, (_, i) => one(`q${i}`, `job ${i}`, null, ago(1), { capacity: 2 })) }]);
  assert.deepEqual([many.values.length, many.values.at(-1).label], [8, 'job 5']);
});

test('a capacity that cannot be had fails the command with the reason, also after one that was had: the record Coda has stays', async t => {
  const now = Date.UTC(2026, 9, 13, 12);
  const one = (runId, title, since) => ({ runId, workflow: 'w', title, status: null, threadId: 't', thread: null, since, borrowed: false, leaving: false });
  const tools = temporary(t), node = await barePath(tools, tools);
  const read = async (groups, body) => {
    if (body) writeFileSync(join(tools, 'coda'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const [{ spec }] = await resourceRecords(dir, { env: env({ CODA_GROUPS_STATE: JSON.stringify({ now, groups }), PATH: node, HOME: tools }) });
    return spec.resources[0];
  };
  const waiting = { name: 'host', occupied: 1, holders: [one('r1', 'testflight', now - 60_000)], queue: [] };
  assert.deepEqual((await read([waiting], 'echo \'{"capacity":2}\'')).values[0], { label: '空闲', value: '1 / 2', fraction: 0.5 });
  // The backend does not answer.
  await assert.rejects(read([waiting], 'echo "没有后端在应答" >&2\nexit 1'), { message: '读不了名额数：没有后端在应答' });
  // An answer that is not a record.
  await assert.rejects(read([], 'echo not-json'), { message: /^读不了名额数：/ });
  await assert.rejects(read([], 'exit 127'), { message: /^读不了名额数：/ });
  // No `coda` at all.
  rmSync(join(tools, 'coda'));
  await assert.rejects(read([]), { message: /^读不了名额数：/ });
});

test('host-sim in a session points to run-held; outside Coda, or in a step holding nothing, there is no slot to take', async () => {
  const asked = await hostSim('run --kind build -- bash scripts/build.sh', { CODA_THREAD_ID: 'thread' });
  assert.equal(asked.code, 2);
  assert.match(asked.stderr, /workflow_run：workflow 为 run-held/); assert.match(asked.stderr, /bash scripts\/build\.sh/);
  assert.doesNotMatch(asked.stderr, /what 为 模拟器/);
  assert.match((await hostSim('run --kind simulator -- true', { CODA_THREAD_ID: 'thread' })).stderr, /what 为 模拟器/);
  const checked = await hostSim('check --kind build', { CODA_THREAD_ID: 'thread' });
  assert.equal(checked.code, 1); assert.match(checked.stderr, /不在构建与模拟器名额里/);
  const outside = await hostSim('run --kind build -- true');
  assert.equal(outside.code, 1); assert.match(outside.stderr, /只能在 Coda 的会话或流程步骤里用/);
  const step = await hostSim('run --kind build -- true', { CODA_GROUPS: '' });
  assert.equal(step.code, 1); assert.match(step.stderr, /调用 host-sim 的步骤写 coda:group="host"/);
});

test('inside a slot host-sim runs at once, the command told the slot is held, and a simulator bound is registered', async t => {
  const state = temporary(t), devices = join(state, 'devices');
  // A command 持锁执行 runs: its lease is kept, and what it binds goes to the step to delete as well as to the plugin's list.
  const held = await hostSim(`run --kind build -- sh -c 'echo "lease=$HOST_SIM_LEASE"; exit 3'`, { HOST_SIM_LEASE: 'coda-run:build', CODA_THREAD_ID: 'thread' });
  assert.deepEqual([held.code, held.stdout], [3, 'lease=coda-run:build\n']);
  assert.equal((await hostSim('check --kind simulator', { HOST_SIM_LEASE: 'coda-run:simulator' })).code, 0);
  assert.equal((await hostSim('bind --kind simulator FAKE-1', { HOST_SIM_LEASE: 'coda-run:simulator', HOST_SIM_DEVICES: devices, CODA_PLUGIN_STATE: state, HOST_SIM_RUN_ID: 'held-run' })).code, 0);
  assert.equal(readFileSync(devices, 'utf8'), 'FAKE-1\n');
  // A step holding the group: what it runs is told so, so that a script going through host-sim until it is runs once.
  const step = await hostSim(`run --kind build -- sh -c 'echo "lease=$HOST_SIM_LEASE"'`, { CODA_GROUPS: 'release host' });
  assert.deepEqual([step.code, step.stdout], [0, 'lease=coda-group:host\n']);
  const bound = await hostSim('bind FAKE-2', { CODA_GROUPS: 'host', CODA_PLUGIN_STATE: state, GITHUB_RUN_ID: 'step-run' });
  assert.match(bound.stderr, /模拟器 FAKE-2 由宿主资源插件定时清点时删除/);
  assert.deepEqual(registrations(state).map(({ udid, runId }) => [udid, runId]).sort(), [['FAKE-1', 'held-run'], ['FAKE-2', 'step-run']]);
});

// The host-sim of a session, as Coda starts it: the plugin's state is where the module wrote kinds.json.
const kindSim = (t, list, extra = {}) => {
  const state = temporary(t), tools = temporary(t);
  if (list) writeFileSync(join(state, 'kinds.json'), JSON.stringify(list));
  // A command of another plugin's on the PATH, as Coda puts it there: what it was given and run with.
  writeFileSync(join(tools, 'kind-sim'), '#!/bin/sh\necho "args=$* lease=$HOST_SIM_LEASE plugin=${CODA_PLUGIN_STATE:-none}"\ncat\nexit 5\n', { mode: 0o755 });
  return hostSim('run --kind iphone-testbed -- true', { CODA_THREAD_ID: 'thread', CODA_PLUGIN_STATE: state, PATH: `${tools}:${process.env.PATH}`, ...extra });
};

test('another kind goes whole to the first command of kinds.json, found on the PATH, with the session\'s environment', async t => {
  const handed = await kindSim(t, [{ plugin: 'testbed', command: 'kind-sim' }, { plugin: 'zed', command: 'absent-sim' }], { HOST_SIM_LEASE: 'coda-run:iphone-testbed' });
  assert.deepEqual([handed.code, handed.stdout], [5, 'args=run --kind iphone-testbed -- true lease=coda-run:iphone-testbed plugin=none\n']);
});

test('another kind with no kinds.json, an empty list, or a command not on the PATH is refused, 2, as none handles it', async t => {
  for (const [list, hint] of [[null, /从商店装上「测试机」插件/], [[], /从商店装上「测试机」插件/], [[{ plugin: 'testbed', command: 'absent-sim' }], /命令 absent-sim 不在 PATH 上/]]) {
    const refused = await kindSim(t, list);
    assert.equal(refused.code, 2); assert.match(refused.stderr, /没有插件处理 --kind iphone-testbed：/); assert.match(refused.stderr, hint);
  }
});

test('the module writes kinds.json: [] to begin with, then the host/kind@1 records of this machine by plugin ID, as they change', async t => {
  const { protocols } = manifest('host').contributes, state = temporary(t), file = join(state, 'kinds.json');
  const read = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const settled = async expected => { for (let i = 0; i < 100 && JSON.stringify(read()) !== JSON.stringify(expected); i++) await new Promise(done => setTimeout(done, 10)); assert.deepEqual(read(), expected); };
  const record = (plugin, command, owner = TEST_OWNER) => ({ kind: 'host/kind@1', owner, id: `${plugin}-${owner}`, plugin, spec: { command } });
  // Implementing its own kind here only lets the test write a record as another would.
  const host = createMockCoda({ plugin: { id: 'host', state, protocols, protocolImplementations: ['coda/group@1', 'host/kind@1'] }, settings: { 'host.capacity': 1 },
    records: [record('zed', 'zed-sim'), record('far', 'far-sim', 'another-machine')] });
  t.after(async () => { await deactivate(); host.close(); });
  await activate(host.coda);
  await settled([{ plugin: 'zed', command: 'zed-sim' }]);
  await host.coda.put({ kind: 'host/kind@1', key: 'devices' }, { spec: { command: 'kind-sim' } });
  await settled([{ plugin: 'host', command: 'kind-sim' }, { plugin: 'zed', command: 'zed-sim' }]);
  await host.coda.delete({ kind: 'host/kind@1', key: 'devices' });
  await settled([{ plugin: 'zed', command: 'zed-sim' }]);
});

test('a refresh of kinds.json that fails is that one\'s alone: the next notice reads and writes again', async t => {
  const state = temporary(t), file = join(state, 'kinds.json');
  const host = createMockCoda({ plugin: { id: 'host', state, protocols: manifest('host').contributes.protocols, protocolImplementations: ['coda/group@1', 'host/kind@1'] }, settings: { 'host.capacity': 1 } });
  t.after(async () => { await deactivate(); host.close(); });
  // The module's coda, its reading of the records refused while `refuse` is set.
  let refuse = true;
  await activate({ ...host.coda, list: (...args) => refuse ? Promise.reject(new Error('refused')) : host.coda.list(...args) });
  const errors = [], logged = console.error;
  console.error = message => errors.push(message);
  t.after(() => { console.error = logged; });
  await host.coda.put({ kind: 'host/kind@1', key: 'devices' }, { spec: { command: 'kind-sim' } });
  for (let i = 0; i < 100 && !errors.length; i++) await new Promise(done => setTimeout(done, 10));
  assert.match(errors[0], /kinds\.json 失败：refused/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  refuse = false;
  await host.coda.put({ kind: 'host/kind@1', key: 'more' }, { spec: { command: 'more-sim' } });
  for (let i = 0; i < 100 && JSON.parse(readFileSync(file, 'utf8')).length < 2; i++) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [{ plugin: 'host', command: 'kind-sim' }, { plugin: 'host', command: 'more-sim' }]);
});

test('with no host/kind@1 record the module leaves kinds.json an empty list; the manifest declares the protocol and no point', async t => {
  const { contributes } = manifest('host'), state = temporary(t);
  assert.equal(contributes.extensionPoints, undefined);
  assert.deepEqual(contributes.protocols.map(({ name, spec }) => [name, spec.properties.command.pattern]), [['host/kind@1', '^[a-z][a-z0-9-]{0,39}$']]);
  const host = createMockCoda({ plugin: { id: 'host', state, protocols: contributes.protocols, protocolImplementations: ['coda/group@1'] }, settings: { 'host.capacity': 1 } });
  t.after(async () => { await deactivate(); host.close(); });
  await activate(host.coda);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'kinds.json'), 'utf8')), []);
});

// The step 执行 of 持锁执行 (.coda/capabilities/run-held.bpmn), as the step runner starts it: its outputs in GITHUB_OUTPUT.
function held(t, inputs, extra = {}) {
  const at = temporary(t), output = join(at, 'output');
  writeFileSync(output, '');
  const child = spawn(process.execPath, [join(dir, 'scripts/run-held.mjs')], { detached: true, cwd: inputs.cwd ?? at,
    env: env({ HELD_COMMAND: inputs.command, HELD_WHAT: inputs.what ?? '构建', RUNNER_TEMP: at, GITHUB_OUTPUT: output,
      HELD_TIMEOUT_MINUTES: '30',
      CODA_PLUGIN_STATE: join(at, 'state'), CODA_ARTIFACTS: at, GITHUB_WORKSPACE: at, ...extra }) });
  let out = '', err = '';
  const ready = inputs.ready ? Promise.withResolvers() : null;
  child.stdout.on('data', d => { out += d; if (ready && out.includes(inputs.ready)) ready.resolve(); });
  child.stderr.on('data', d => { err += d; });
  child.on('close', () => { if (ready && !out.includes(inputs.ready)) ready.reject(new Error(`命令未就绪就退出：${err}`)); });
  const ended = new Promise(resolve => child.on('close', code => resolve({ code, out, err, outputs: readFileSync(output, 'utf8') })));
  return { at, child, ended, ready: ready?.promise };
}

test('持锁执行 runs the command in its own working directory, with the project\'s environment and the slot as its own, and deletes what it bound', async t => {
  const sims = simctl(t, ['FAKE-1']);
  const { at, ended } = held(t, { command: 'echo "lease=$HOST_SIM_LEASE in=$(basename "$PWD") plugin=${CODA_PLUGIN_PATH:-none} runner=${RUNNER_TEMP:-none} run=$HOST_SIM_RUN_ID"; echo FAKE-1 >> "$HOST_SIM_DEVICES"; exit 4' },
    { HOST_SIM_SIMCTL: sims.tool, GITHUB_RUN_ID: 'held-owner' });
  const { code, out, err, outputs } = await ended;
  // It fails as the command does; the command's status is the output.
  assert.equal(code, 1); assert.equal(outputs, 'exit_code=4\nfailure_reason=命令非零退出（退出码 4）\n');
  assert.match(out, new RegExp(`lease=coda-run:build in=${basename(at)} plugin=none runner=none run=held-owner`));
  assert.match(out, /已删除模拟器 FAKE-1/);
  assert.equal(err, '失败：命令非零退出（退出码 4）\n');
  assert.equal(sims.log(), 'shutdown FAKE-1\ndelete FAKE-1\n');
  const simulator = await held(t, { command: 'echo "$HOST_SIM_LEASE"', what: '模拟器' }).ended;
  assert.deepEqual([simulator.code, simulator.out, simulator.outputs], [0, `在 ${hostname()} 上执行\ncoda-run:simulator\n`, 'exit_code=0\n']);
});

test('持锁执行 says which machine it runs on before the command prints anything, and that line does not count as output', { timeout: 10000 }, async t => {
  const line = `在 ${hostname()} 上执行\n`;
  const ran = await held(t, { command: 'echo first' }).ended;
  assert.deepEqual([ran.code, ran.out], [0, `${line}first\n`]);
  // A command that prints nothing is still stopped as silent, with the line as its only output.
  const silent = await held(t, { command: 'exec sleep 60' }, { HELD_IDLE_MINUTES: '0.005' }).ended;
  assert.deepEqual([silent.code, silent.out], [1, line]);
  assert.equal(silent.outputs, 'exit_code=143\nfailure_reason=0.005 分钟无输出\n');
});

test('持锁执行 cancelled still deletes the simulators its command bound before it ends', async t => {
  const sims = simctl(t, ['FAKE-2']);
  const { child, ended, ready } = held(t, { command: `echo FAKE-2 >> "$HOST_SIM_DEVICES"; echo bound; exec sleep 60`, what: '模拟器', ready: 'bound\n' }, { HOST_SIM_SIMCTL: sims.tool });
  await ready;
  // As the step runner cancels a step: its whole process group is asked to stop.
  process.kill(-child.pid, 'SIGTERM');
  const result = await ended;
  const { code, outputs } = result;
  assert.equal(code, 143, JSON.stringify(result)); assert.equal(outputs, 'exit_code=143\n');
  assert.equal(sims.log(), 'shutdown FAKE-2\ndelete FAKE-2\n');
});

test('持锁执行 retains cancellation when child exit is observed before TERM during simulator cleanup', async t => {
  // The child receives TERM first. simctl then delivers TERM to the wrapper while it is cleaning up:
  // no timing luck or sleep is needed to expose a pending signal hidden by synchronous cleanup.
  const sims = simctl(t, ['FAKE-3'], { cancelDuringCleanup: true });
  const result = await held(t, { command: 'echo FAKE-3 >> "$HOST_SIM_DEVICES"; kill -TERM $$', what: '模拟器' },
    { SHELL: '/bin/sh', HOST_SIM_SIMCTL: sims.tool }).ended;
  assert.equal(result.code, 143, JSON.stringify(result));
  assert.equal(result.outputs, 'exit_code=143\n');
  assert.equal(sims.log(), 'shutdown FAKE-3\ndelete FAKE-3\n');
  assert.deepEqual(sims.devices(), []);
});

// A `coda` on the PATH standing in for Coda's: it logs what it was asked and answers `self run-finished` from the
// run states given, as the provider would from the public workflow endpoint; a run it does not know fails.
function hostStatus(t) {
  const state = temporary(t), tools = temporary(t), runs = join(tools, 'runs.json'), log = join(tools, 'coda.log');
  writeFileSync(runs, '{}');
  writeFileSync(join(tools, 'coda'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'self' || args[1] !== 'run-finished') process.exit(9);
const status = JSON.parse(fs.readFileSync(${JSON.stringify(runs)}, 'utf8'))[JSON.parse(args[2]).run];
if (!status) { console.error('运行不存在或宿主暂不可用'); process.exit(1); }
console.log(JSON.stringify({ finished: ['succeeded', 'failed', 'cancelled'].includes(status) }));
`, { mode: 0o755 });
  const known = new Map();
  return { state, tools, path: `${tools}:${process.env.PATH}`, asked: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    owner: (id, status) => { known.set(id, status); writeFileSync(runs, JSON.stringify(Object.fromEntries(known))); } };
}

test('清点模拟器 deletes only finished owners; live, cancelling, unknown and legacy registrations stay', async t => {
  const { state, owner, path, asked } = hostStatus(t);
  const sims = simctl(t, ['LEFT', 'FAILED', 'CANCELLED', 'LIVE', 'STOPPING', 'DRAIN', 'HELD', 'UNKNOWN', 'LEGACY', 'SHARED', 'OTHER']);
  for (const [id, status] of Object.entries({ done: 'succeeded', failed: 'failed', cancelled: 'cancelled', live: 'running', stopping: 'cancelling', drain: 'running', held: 'cancelling' })) owner(id, status);
  for (const [udid, runId] of [['LEFT', 'done'], ['GONE', 'done'], ['FAILED', 'failed'], ['CANCELLED', 'cancelled'], ['LIVE', 'live'], ['STOPPING', 'stopping'], ['DRAIN', 'drain'], ['HELD', 'held'], ['UNKNOWN', 'missing'], ['SHARED', 'done'], ['SHARED', 'live']]) registerSimulator(state, udid, runId);
  writeFileSync(join(state, 'simulators'), 'LEGACY\n');
  const clean = extra => run('node "$CODA_PLUGIN_PATH/scripts/clean-simulators.mjs"', env({ CODA_PLUGIN_STATE: state, HOST_SIM_SIMCTL: sims.tool, PATH: path, ...extra }));
  assert.equal((await clean({})).code, 0);
  assert.equal(sims.log(), '');
  assert.deepEqual(asked(), []);
  const own = await clean({ CODA_ARBITER: '1' });
  assert.equal(own.code, 1, own.stderr);
  assert.match(own.stderr, /运行不存在或宿主暂不可用/);
  assert.ok(asked().length && asked().every(args => args.length === 3 && args.slice(0, 2).join(' ') === 'self run-finished' && typeof JSON.parse(args[2]).run === 'string'));
  assert.deepEqual(sims.devices(), ['LIVE', 'STOPPING', 'DRAIN', 'HELD', 'UNKNOWN', 'LEGACY', 'SHARED', 'OTHER']);
  assert.deepEqual(registrations(state).map(r => r.udid).sort(), ['DRAIN', 'HELD', 'LIVE', 'SHARED', 'SHARED', 'STOPPING', 'UNKNOWN']);
  assert.doesNotMatch(sims.log(), /shutdown|delete (LIVE|STOPPING|DRAIN|HELD|UNKNOWN|LEGACY|SHARED|OTHER)/);
  assert.match(own.stdout, /旧登记没有运行标识/);
});

test('清点模拟器 skips in-use failures and preserves registrations made during deletion', async t => {
  const { state, owner, path } = hostStatus(t); owner('done', 'succeeded'); owner('live', 'running');
  registerSimulator(state, 'BUSY', 'done'); registerSimulator(state, 'LEFT', 'done');
  const tool = join(temporary(t), 'simctl'), calls = join(temporary(t), 'calls');
  writeFileSync(tool, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
const calls = ${JSON.stringify(calls)}, state = ${JSON.stringify(state)};
if (args[1] === 'list') {
  const gone = fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').includes('LEFT');
  console.log(JSON.stringify({ devices: { r: (gone ? ['BUSY'] : ['BUSY', 'LEFT']).map(udid => ({ udid, state: 'Booted' })) } }));
} else if (args[1] === 'delete') {
  if (args[2] === 'BUSY') { console.error('device is in use by another process'); process.exit(1); }
  fs.writeFileSync(calls, 'LEFT');
  fs.writeFileSync(state + '/simulator-registrations/concurrent.json', JSON.stringify({ udid: 'NEW', runId: 'live' }));
} else process.exit(9);
`, { mode: 0o755 });
  const result = await run('node "$CODA_PLUGIN_PATH/scripts/clean-simulators.mjs"', env({ CODA_PLUGIN_STATE: state, CODA_ARBITER: '1', HOST_SIM_SIMCTL: tool, PATH: path }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /跳过模拟器 BUSY.*使用中/);
  assert.match(result.stderr, /device is in use/);
  assert.deepEqual(registrations(state).map(r => r.udid).sort(), ['BUSY', 'NEW']);
});

test('清点模拟器 never deletes when the plugin module is unavailable', async t => {
  const { path } = hostStatus(t), state = join(temporary(t), 'plugins', 'host');
  registerSimulator(state, 'KEEP', 'missing');
  const sims = simctl(t, ['KEEP']);
  const result = await run('node "$CODA_PLUGIN_PATH/scripts/clean-simulators.mjs"', env({ CODA_PLUGIN_STATE: state, CODA_ARBITER: '1', HOST_SIM_SIMCTL: sims.tool, PATH: path }));
  assert.equal(result.code, 1);
  assert.equal(sims.log(), '');
  assert.equal(registrations(state).length, 1);
});

test('cleanup eligibility follows the run record read afresh, including reruns, and never guesses unknown states', async () => {
  const runs = new Map(), coda = { get: async ref => {
    assert.equal(ref.kind, 'coda/workflow-run@1');
    return runs.has(ref.id) ? { kind: ref.kind, id: ref.id, status: { state: runs.get(ref.id) } } : null;
  } };
  runs.set('run', 'succeeded');
  assert.equal(await runFinished(coda, 'run'), true);
  runs.set('run', 'failed');
  assert.equal(await runFinished(coda, 'run'), true);
  runs.set('run', 'cancelled');
  assert.equal(await runFinished(coda, 'run'), true);
  runs.set('run', 'running');
  assert.equal(await runFinished(coda, 'run'), false);
  runs.set('run', 'waiting');
  assert.equal(await runFinished(coda, 'run'), false);
  runs.set('run', 'cancelling');
  assert.equal(await runFinished(coda, 'run'), false);
  runs.set('run', 'future-state');
  assert.equal(await runFinished(coda, 'run'), false);
  assert.equal(await runFinished(coda, null), false);
  await assert.rejects(runFinished(coda, 'missing'), /运行不存在/);
});

test('the manifest asks to read workflow run records', () => {
  assert.deepEqual(manifest('host').uses, { 'coda/workflow-run@1': ['read'] });
});

test('持锁执行 fails a hung command with its idle reason once at the end', { timeout: 5000 }, async t => {
  const result = await held(t, { command: 'echo before-hang >&2; sleep 60' }, { HELD_IDLE_MINUTES: '0.005' }).ended;
  assert.equal(result.code, 1);
  assert.match(result.outputs, /failure_reason=0.005 分钟无输出/);
  assert.equal(result.err, 'before-hang\n失败：0.005 分钟无输出\n');
});

test('持锁执行 keeps resetting the idle deadline on stdout and stderr output', { timeout: 5000 }, async t => {
  const result = await held(t, { command: `"${process.execPath}" -e 'let n=0; const timer=setInterval(() => { (n++ % 2 ? process.stderr : process.stdout).write("progress\\n"); if(n===12) clearInterval(timer); }, 100)'` }, { HELD_IDLE_MINUTES: '0.01' }).ended;
  assert.equal(result.code, 0, result.err);
  assert.equal(result.outputs, 'exit_code=0\n');
  assert.doesNotMatch(result.err, /无输出/);
});

test('持锁执行 can disable the idle deadline', { timeout: 5000 }, async t => {
  const result = await held(t, { command: 'sleep 0.4' }, { HELD_IDLE_MINUTES: '0' }).ended;
  assert.equal(result.code, 0);
});
