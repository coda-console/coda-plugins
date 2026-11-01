// The 宿主资源 plugin's scripts, run as Coda runs them (plugins/host/README.md): its panel over the groups as Coda says they
// are, its command host-sim in a session, a step and a held command, the step of 持锁执行 and that of 清点模拟器. How Coda's
// engine queues them (hold-group, coda:group) is Coda's own to test; a simulator tool here is a stand-in's.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { serveSimulatorStatus, runFinished } from '../../../plugins/host/lib/simulator-status.mjs';
import { registerSimulator, registrations } from '../../../plugins/host/lib/simulators.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginDir } from '../plugin.mjs';
import { declaredPanel, manifest, pluginEnv, run } from '../command.mjs';

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
function simctl(t, devices = []) {
  const at = temporary(t), state = join(at, 'devices'), log = join(at, 'simctl.log'), tool = join(at, 'simctl');
  writeFileSync(state, devices.map(d => `${d}\n`).join(''));
  writeFileSync(tool, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2).filter(a => a !== 'simctl');
const read = () => fs.readFileSync(${JSON.stringify(state)}, 'utf8').split('\\n').filter(Boolean);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (args[0] === 'list') process.stdout.write(JSON.stringify({ devices: { r: read().map(udid => ({ udid, name: udid, state: 'Booted' })) } }));
if (args[0] === 'delete' && args[1] !== 'STUCK') fs.writeFileSync(${JSON.stringify(state)}, read().filter(u => u !== args[1]).map(u => u + '\\n').join(''));
`, { mode: 0o755 });
  return { tool, devices: () => readFileSync(state, 'utf8').split('\n').filter(Boolean), log: () => existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('the panel shows the free slots, who holds the group host and who waits; one holding it whole leaves none free', async () => {
  const now = Date.UTC(2026, 9, 13, 12), ago = minutes => now - minutes * 60_000;
  const one = (runId, title, thread, since, more = {}) => ({ runId, workflow: 'w', title, status: null, threadId: 't', thread, since, ...more });
  const host = { name: 'host', occupied: 1, holders: [one('r1', 'testflight', null, ago(75), { borrowed: false, leaving: false })],
    queue: [one('r2', 'xcodebuild test', '会话乙', ago(2), { capacity: 2 })] };
  const read = async groups => {
    const { code, stdout } = await run(declaredPanel('host').command,
      env({ CODA_GROUPS_STATE: JSON.stringify({ now, groups }), CODA_PLUGIN_SETTINGS: JSON.stringify({ 'host.capacity': 2 }) }));
    assert.equal(code, 0);
    return JSON.parse(stdout).items[0];
  };
  const slots = await read([host]);
  assert.equal(slots.subtitle, '这个实例同时允许 2 个（设置「名额数」）');
  assert.deepEqual(slots.items.map(i => [i.label, i.value]), [['空闲名额', '1 / 2'], ['testflight', '占用 1 小时 15 分钟'], ['xcodebuild test · 会话乙', '排第 1 位，等了 2 分钟']]);
  assert.equal(slots.items[0].fraction, 0.5);
  const cleaning = await read([{ ...host, holders: [one('r6', '清点模拟器', null, ago(1), { borrowed: false, leaving: false, exclusive: true })] }]);
  assert.deepEqual(cleaning.items.slice(0, 2).map(i => [i.label, i.value]), [['空闲名额', '0 / 2'], ['清点模拟器', '占满 1 分钟']]);
  assert.deepEqual((await read([])).items.map(i => [i.label, i.value]), [['空闲名额', '2 / 2']]);
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

test('another kind goes whole to the first command plugged into kinds, as that plugin\'s; none plugged in is refused', async t => {
  const other = temporary(t);
  writeFileSync(join(other, 'kind.sh'), 'echo "plugin=$CODA_PLUGIN_PATH state=$CODA_PLUGIN_STATE args=$*"\nexit 5\n');
  const kinds = { kinds: [{ command: `sh "${join(other, 'kind.sh')}"`, path: other, state: join(other, 'state') }] };
  const handed = await hostSim('run --kind iphone-testbed -- true', { CODA_THREAD_ID: 'thread', CODA_PLUGIN_EXTENSIONS: JSON.stringify(kinds) });
  assert.deepEqual([handed.code, handed.stdout], [5, `plugin=${other} state=${join(other, 'state')} args=run --kind iphone-testbed -- true\n`]);
  const none = await hostSim('run --kind iphone-testbed -- true', { CODA_THREAD_ID: 'thread' });
  assert.equal(none.code, 2); assert.match(none.stderr, /从商店装上「测试机」插件/);
});

// The step 执行 of 持锁执行 (.coda/capabilities/run-held.bpmn), as the step runner starts it: its outputs in GITHUB_OUTPUT.
function held(t, inputs, extra = {}) {
  const at = temporary(t), output = join(at, 'output');
  writeFileSync(output, '');
  const child = spawn(process.execPath, [join(dir, 'scripts/run-held.mjs')], { detached: true,
    env: env({ HELD_COMMAND: inputs.command, HELD_CWD: inputs.cwd ?? at, HELD_WHAT: inputs.what ?? '构建', RUNNER_TEMP: at, GITHUB_OUTPUT: output,
      CODA_PLUGIN_STATE: join(at, 'state'), CODA_ARTIFACTS: at, GITHUB_WORKSPACE: at, ...extra }) });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const ended = new Promise(resolve => child.on('close', code => resolve({ code, out, err, outputs: readFileSync(output, 'utf8') })));
  return { at, child, ended };
}

test('持锁执行 runs the command where it was told, with the project\'s environment and the slot as its own, and deletes what it bound', async t => {
  const sims = simctl(t, ['FAKE-1']);
  const { at, ended } = held(t, { command: 'echo "lease=$HOST_SIM_LEASE in=$(basename "$PWD") plugin=${CODA_PLUGIN_PATH:-none} runner=${RUNNER_TEMP:-none} run=$HOST_SIM_RUN_ID"; echo FAKE-1 >> "$HOST_SIM_DEVICES"; exit 4' },
    { HOST_SIM_SIMCTL: sims.tool, GITHUB_RUN_ID: 'held-owner' });
  const { code, out, outputs } = await ended;
  // It fails as the command does; the command's status is the output.
  assert.equal(code, 1); assert.equal(outputs, 'exit_code=4\n');
  assert.match(out, new RegExp(`lease=coda-run:build in=${basename(at)} plugin=none runner=none run=held-owner`));
  assert.match(out, /已删除模拟器 FAKE-1/);
  assert.equal(sims.log(), 'shutdown FAKE-1\ndelete FAKE-1\n');
  const simulator = await held(t, { command: 'echo "$HOST_SIM_LEASE"', what: '模拟器' }).ended;
  assert.deepEqual([simulator.code, simulator.out, simulator.outputs], [0, 'coda-run:simulator\n', 'exit_code=0\n']);
  // A directory that is not one: the command does not run.
  const nowhere = await held(t, { command: 'echo never', cwd: 'relative' }).ended;
  assert.deepEqual([nowhere.code, nowhere.out, nowhere.outputs], [1, '', 'exit_code=2\n']);
  assert.match(nowhere.err, /cwd 须为存在的目录的绝对路径/);
});

test('持锁执行 cancelled still deletes the simulators its command bound before it ends', async t => {
  const sims = simctl(t, ['FAKE-2']);
  const { at, child, ended } = held(t, { command: `echo FAKE-2 >> "$HOST_SIM_DEVICES"; touch bound; sleep 60`, what: '模拟器' }, { HOST_SIM_SIMCTL: sims.tool });
  for (let i = 0; i < 500 && !existsSync(join(at, 'bound')); i++) await delay(10);
  // As the step runner cancels a step: its whole process group is asked to stop.
  process.kill(-child.pid, 'SIGTERM');
  const { code, outputs } = await ended;
  assert.equal(code, 143); assert.equal(outputs, 'exit_code=143\n');
  assert.equal(sims.log(), 'shutdown FAKE-2\ndelete FAKE-2\n');
});

// Exercise the script with the real module bridge, public workflow responses and a fake simctl.
async function hostStatus(t) {
  const state = temporary(t), runs = new Map();
  const bridge = await serveSimulatorStatus({ plugin: { state }, api: async path => {
    assert.match(path, /^workflow-runs\//);
    const id = decodeURIComponent(path.slice('workflow-runs/'.length));
    if (!runs.has(id)) throw new Error('运行不存在或宿主暂不可用');
    return { runId: id, state: runs.get(id) };
  } });
  t.after(() => bridge.dispose());
  return { state, owner: (id, status) => runs.set(id, status) };
}

test('清点模拟器 deletes only finished owners; live, cancelling, unknown and legacy registrations stay', async t => {
  const { state, owner } = await hostStatus(t);
  const sims = simctl(t, ['LEFT', 'FAILED', 'CANCELLED', 'LIVE', 'STOPPING', 'DRAIN', 'HELD', 'UNKNOWN', 'LEGACY', 'SHARED', 'OTHER']);
  for (const [id, status] of Object.entries({ done: 'succeeded', failed: 'failed', cancelled: 'cancelled', live: 'running', stopping: 'cancelling', drain: 'running', held: 'cancelling' })) owner(id, status);
  for (const [udid, runId] of [['LEFT', 'done'], ['GONE', 'done'], ['FAILED', 'failed'], ['CANCELLED', 'cancelled'], ['LIVE', 'live'], ['STOPPING', 'stopping'], ['DRAIN', 'drain'], ['HELD', 'held'], ['UNKNOWN', 'missing'], ['SHARED', 'done'], ['SHARED', 'live']]) registerSimulator(state, udid, runId);
  writeFileSync(join(state, 'simulators'), 'LEGACY\n');
  const clean = extra => run('node "$CODA_PLUGIN_PATH/scripts/clean-simulators.mjs"', env({ CODA_PLUGIN_STATE: state, HOST_SIM_SIMCTL: sims.tool, ...extra }));
  assert.equal((await clean({})).code, 0);
  assert.equal(sims.log(), '');
  const own = await clean({ CODA_ARBITER: '1' });
  assert.equal(own.code, 1, own.stderr);
  assert.match(own.stderr, /运行不存在或宿主暂不可用/);
  assert.deepEqual(sims.devices(), ['LIVE', 'STOPPING', 'DRAIN', 'HELD', 'UNKNOWN', 'LEGACY', 'SHARED', 'OTHER']);
  assert.deepEqual(registrations(state).map(r => r.udid).sort(), ['DRAIN', 'HELD', 'LIVE', 'SHARED', 'SHARED', 'STOPPING', 'UNKNOWN']);
  assert.doesNotMatch(sims.log(), /shutdown|delete (LIVE|STOPPING|DRAIN|HELD|UNKNOWN|LEGACY|SHARED|OTHER)/);
  assert.match(own.stdout, /旧登记没有运行标识/);
});

test('清点模拟器 skips in-use failures and preserves registrations made during deletion', async t => {
  const { state, owner } = await hostStatus(t); owner('done', 'succeeded'); owner('live', 'running');
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
  const result = await run('node "$CODA_PLUGIN_PATH/scripts/clean-simulators.mjs"', env({ CODA_PLUGIN_STATE: state, CODA_ARBITER: '1', HOST_SIM_SIMCTL: tool }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /跳过模拟器 BUSY.*使用中/);
  assert.match(result.stderr, /device is in use/);
  assert.deepEqual(registrations(state).map(r => r.udid).sort(), ['BUSY', 'NEW']);
});

test('清点模拟器 never deletes when the plugin module is unavailable', async t => {
  const state = join(temporary(t), 'plugins', 'host');
  registerSimulator(state, 'KEEP', 'missing');
  const sims = simctl(t, ['KEEP']);
  const result = await run('node "$CODA_PLUGIN_PATH/scripts/clean-simulators.mjs"', env({ CODA_PLUGIN_STATE: state, CODA_ARBITER: '1', HOST_SIM_SIMCTL: sims.tool }));
  assert.equal(result.code, 1);
  assert.equal(sims.log(), '');
  assert.equal(registrations(state).length, 1);
});

test('cleanup eligibility follows a fresh public run state, including reruns, and never guesses unknown states', async t => {
  const { state, owner } = await hostStatus(t);
  owner('run', 'succeeded');
  assert.equal(await runFinished(state, 'run'), true);
  owner('run', 'running');
  assert.equal(await runFinished(state, 'run'), false);
  owner('run', 'cancelling');
  assert.equal(await runFinished(state, 'run'), false);
  owner('run', 'future-state');
  assert.equal(await runFinished(state, 'run'), false);
  assert.equal(await runFinished(state, null), false);
  await assert.rejects(runFinished(state, 'missing'), /运行不存在/);
});
