// The 测试机 plugin's scripts, run as Coda runs them (plugins/testbed/README.md): its panel over the devices registered here
// and their groups, the steps of use-testbed that find a device and put its black screen up, its part of host-sim (plugged
// into the host plugin's point `kinds`) and the step of run-on-device. The flow around them is Coda's engine's to run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { pluginDir } from '../plugin.mjs';
import { declaredPanel, manifest, pluginEnv, run } from '../command.mjs';

const dir = pluginDir('testbed');
const phone = { id: 'iphone-testbed', name: 'iPhone13pm', udid: 'TEST-IPHONE', note: '登录着用户的 Apple 账号：不碰钱包与支付。' };
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'testbed-plugin-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
// The plugin's state with these devices registered.
function registered(t, devices) {
  const state = temporary(t);
  if (devices) writeFileSync(join(state, 'devices.json'), typeof devices === 'string' ? devices : JSON.stringify(devices));
  return state;
}
// The environment of a command of a plugin's, without what would say a device is held here: the tests may run inside one.
const env = (extra = {}, id = 'testbed') => {
  const base = pluginEnv(id, { CODA_NODE: process.execPath, ...extra });
  for (const name of ['HOST_SIM_LEASE', 'HOST_SIM_DEVICES', 'CODA_GROUPS', 'CODA_THREAD_ID', 'CODA_PLUGIN_EXTENSIONS']) if (!(name in extra)) delete base[name];
  return base;
};
// A step's script (scripts/<name>.mjs), its outputs in GITHUB_OUTPUT.
async function step(t, name, extra) {
  const output = join(temporary(t), 'output');
  writeFileSync(output, '');
  const ended = await run(`node "$CODA_PLUGIN_PATH/scripts/${name}.mjs"`, env({ GITHUB_OUTPUT: output, ...extra }));
  return { ...ended, outputs: readFileSync(output, 'utf8') };
}

test('the panel shows each device registered here, who uses it, who borrowed it and who waits; none registered, nothing', async t => {
  const state = registered(t, [phone, { id: 'ipad-testbed', name: 'iPad Air', udid: 'B' }]);
  const now = Date.UTC(2026, 9, 13, 12), ago = minutes => now - minutes * 60_000;
  const one = (runId, title, thread, since, more = {}) => ({ runId, workflow: 'w', title, status: null, threadId: 't', thread, since, ...more });
  const groups = [{ name: 'device:iphone-testbed', occupied: 1, queue: [one('r4', null, '另一个会话', ago(3), { capacity: 1 })],
    holders: [one('r5', 'iphone-testbed：xcrun devicectl', '会话甲', ago(0), { borrowed: true, leaving: false }), one('r3', 'iphone-testbed：看首页', '会话甲', ago(12), { borrowed: false, leaving: false })] },
  { name: 'host', occupied: 1, holders: [one('r1', 'testflight', null, ago(75), { borrowed: false, leaving: false })], queue: [] }];
  const read = async state => {
    const { code, stdout } = await run(declaredPanel('testbed').command, env({ CODA_PLUGIN_STATE: state, CODA_GROUPS_STATE: JSON.stringify({ now, groups }) }));
    assert.equal(code, 0);
    return JSON.parse(stdout).items;
  };
  const [iphone, ipad] = await read(state);
  assert.deepEqual([iphone.title, iphone.subtitle, ipad.title], ['iPhone13pm', 'iphone-testbed', 'iPad Air']);
  // The use that holds it first, what a session borrowed it for after.
  assert.deepEqual(iphone.items.map(i => [i.label, i.value]), [['iphone-testbed：看首页 · 会话甲', '使用中 12 分钟'],
    ['iphone-testbed：xcrun devicectl · 会话甲', '会话借用 不到 1 分钟'], ['w · 另一个会话', '排第 1 位，等了 3 分钟']]);
  assert.deepEqual(ipad.items.map(i => [i.label, i.value]), [['状态', '空闲']]);
  assert.deepEqual(await read(registered(t)), []);
  const [broken] = await read(registered(t, '{ not json'));
  assert.equal(broken.type, 'error'); assert.match(broken.text, /读不了设备登记/);
});

test('找测试机 gives the registered device\'s name, UDID and note; one not registered fails, saying which are', async t => {
  const state = registered(t, [phone]);
  const found = await step(t, 'device', { CODA_PLUGIN_STATE: state, DEVICE: phone.id });
  assert.equal(found.code, 0);
  assert.equal(found.outputs, `name=${phone.name}\nudid=${phone.udid}\nnote<<CODA_NOTE\n${phone.note}\nCODA_NOTE\n`);
  const missing = await step(t, 'device', { CODA_PLUGIN_STATE: state, DEVICE: 'ipad-testbed' });
  assert.equal(missing.code, 1); assert.match(missing.stderr, /本机没有登记设备 ipad-testbed.*登记了：iphone-testbed/);
  const none = await step(t, 'device', { CODA_PLUGIN_STATE: registered(t), DEVICE: phone.id });
  assert.equal(none.code, 1); assert.match(none.stderr, /一台也没有登记/);
  const list = await step(t, 'device', { CODA_PLUGIN_STATE: registered(t, '{}'), DEVICE: phone.id });
  assert.equal(list.code, 1); assert.match(list.stderr, /须为设备数组/);
  // One device under two names would be held by two groups at once: the registration is refused whichever is asked for.
  const twice = registered(t, [phone, { ...phone, id: 'iphone-b' }]);
  for (const name of [phone.id, 'iphone-b']) {
    const found = await step(t, 'device', { CODA_PLUGIN_STATE: twice, DEVICE: name });
    assert.equal(found.code, 1); assert.match(found.stderr, /udid 重复：TEST-IPHONE/);
  }
  const named = await step(t, 'device', { CODA_PLUGIN_STATE: registered(t, [phone, { ...phone, udid: 'OTHER' }]), DEVICE: phone.id });
  assert.equal(named.code, 1); assert.match(named.stderr, /id 重复：iphone-testbed/);
});

test('切黑屏 launches the black screen app over devicectl, or runs the device\'s own line from the setting, its UDID in UDID', async t => {
  const tools = temporary(t);
  writeFileSync(join(tools, 'xcrun'), '#!/bin/sh\necho "xcrun $*"\nexit 3\n', { mode: 0o755 });
  const black = extra => step(t, 'blackscreen', { CODA_PLUGIN_STATE: registered(t), DEVICE: phone.id, UDID: phone.udid, ...extra,
    PATH: `${tools}:${process.env.PATH}` });
  const launched = await black({});
  assert.equal(launched.code, 3);
  assert.match(launched.stdout, /xcrun devicectl device process launch --terminate-existing --device TEST-IPHONE com\.leavan\.blackscreen/);
  const own = await black({ COMMANDS: JSON.stringify({ [phone.id]: 'echo "own $UDID"', other: 'exit 9' }) });
  assert.deepEqual([own.code, own.stdout], [0, '切黑屏：echo "own $UDID"\nown TEST-IPHONE\n']);
});

test('the black screen build takes a build slot through host-sim: a command on a test device is not in one', async t => {
  const tools = temporary(t);
  writeFileSync(join(tools, 'host-sim'), `#!/bin/sh\nexec "${process.execPath}" "${join(pluginDir('host'), 'scripts/host-sim.mjs')}" "$@"\n`, { mode: 0o755 });
  const build = extra => run('sh "$CODA_PLUGIN_PATH/blackscreen/build.sh" out profile', env({ CODA_THREAD_ID: 'thread', HOME: tools,
    PATH: `${tools}:${process.env.PATH}`, ...extra }));
  const device = await build({ HOST_SIM_LEASE: `coda-run:${phone.id}` });
  assert.equal(device.code, 2); assert.match(device.stderr, /run-held/);
  // In a slot it goes on to build: here it stops at the provisioning profile, there being none.
  const slot = await build({ HOST_SIM_LEASE: 'coda-run:build' });
  assert.equal(slot.code, 1); assert.match(slot.stderr, /找不到描述文件：profile/);
});

// The testbed's host-sim, as the host plugin's host-sim hands a device kind to what is plugged into its point `kinds`.
const kinds = () => JSON.stringify({ kinds: [{ command: manifest('testbed').contributes.extensions['host/kinds'].command, path: dir }] });
const hostCommand = manifest('host').contributes.commands.find(c => c.name === 'host-sim').command;
const hostSim = (args, extra) => run(`${hostCommand} ${args}`, env({ ...extra, CODA_PLUGIN_EXTENSIONS: kinds() }, 'host'));

test('a session\'s host-sim for a device hands the command to run-on-device with what to run, where and with what', async t => {
  const tools = temporary(t), log = join(tools, 'coda-run.log');
  // coda-run, standing in for Coda's: what it was asked, and the command the spec says, as run-on-device would read it.
  writeFileSync(join(tools, 'coda-run'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\ncp "\${2#spec=}" "${tools}/spec.json"\nexit 6\n`, { mode: 0o755 });
  const temp = join(tools, 'tmp');
  mkdirSync(temp);
  const asked = await hostSim(`run --kind ${phone.id} -- xcrun devicectl list`, { CODA_THREAD_ID: 'thread', HOST_SIM_DEVICES: 'stale', TMPDIR: temp, PATH: `${tools}:${process.env.PATH}` });
  // What coda-run says is what host-sim says.
  assert.equal(asked.code, 6, asked.stderr);
  const [name, spec, device, label] = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual([name, device, label], ['run-on-device', `device=${phone.id}`, 'label=xcrun devicectl list']);
  assert.match(spec, new RegExp(`^spec=${join(temp, 'coda-host-sim')}/`));
  const handed = JSON.parse(readFileSync(join(tools, 'spec.json'), 'utf8'));
  assert.deepEqual([handed.argv, handed.kind, handed.env.HOST_SIM_DEVICES, handed.env.CODA_PLUGIN_PATH], [['xcrun', 'devicectl', 'list'], phone.id, undefined, undefined]);
  assert.equal(handed.env.CODA_THREAD_ID, 'thread');
});

test('inside a command on the device, or a step holding its group, host-sim runs at once; elsewhere it says how to get the device', async () => {
  const lease = await hostSim(`run --kind ${phone.id} -- sh -c 'echo "$HOST_SIM_LEASE"'`, { CODA_THREAD_ID: 'thread', HOST_SIM_LEASE: `coda-run:${phone.id}` });
  assert.deepEqual([lease.code, lease.stdout], [0, `coda-run:${phone.id}\n`]);
  const group = await hostSim(`run --kind ${phone.id} -- sh -c 'echo "$HOST_SIM_LEASE"'`, { CODA_GROUPS: `host device:${phone.id}` });
  assert.deepEqual([group.code, group.stdout], [0, `coda-group:device:${phone.id}\n`]);
  assert.equal((await hostSim(`check --kind ${phone.id}`, { HOST_SIM_LEASE: `coda-run:${phone.id}` })).code, 0);
  // Holding another device, or a build slot, is not holding this one.
  const other = await hostSim(`check --kind ${phone.id}`, { CODA_THREAD_ID: 'thread', HOST_SIM_LEASE: 'coda-run:ipad-testbed' });
  assert.equal(other.code, 1); assert.match(other.stderr, /不在测试机 iphone-testbed 里/);
  const step = await hostSim(`run --kind ${phone.id} -- true`, { CODA_GROUPS: 'host' });
  assert.equal(step.code, 1); assert.match(step.stderr, /这一步没有占着组 device:iphone-testbed：测试机调用能力 use-testbed/);
  const outside = await hostSim(`run --kind ${phone.id} -- true`, {});
  assert.equal(outside.code, 1); assert.match(outside.stderr, /只能在 Coda 的会话或流程步骤里用/);
});

test('在测试机上执行 runs the command handed over in the session\'s directory and environment, the device as its own, and says its status', async t => {
  const at = temporary(t), spec = join(at, 'spec.json');
  const handed = (argv, cwd = at) => writeFileSync(spec, JSON.stringify({ argv, cwd, env: { PATH: process.env.PATH, MINE: 'yes' }, kind: phone.id }));
  handed(['sh', '-c', 'echo "lease=$HOST_SIM_LEASE mine=$MINE in=$(basename "$PWD") plugin=${CODA_PLUGIN_PATH:-none}"; exit 7']);
  const ran = await step(t, 'run-on-device', { SPEC: spec });
  // The step succeeds whatever the command did: its status goes back to host-sim as the output.
  assert.deepEqual([ran.code, ran.stdout, ran.outputs], [0, `lease=coda-run:${phone.id} mine=yes in=${basename(at)} plugin=none\n`, 'exit_code=7\n']);
  assert.equal(existsSync(spec), false, 'the spec is gone once read');
  handed(['no-such-command-here']);
  const missing = await step(t, 'run-on-device', { SPEC: spec });
  assert.deepEqual([missing.code, missing.outputs], [0, 'exit_code=127\n']);
  assert.deepEqual(readdirSync(at), []);
});

test('run-on-device cancelled ends as cancelled, its command stopped with it', async t => {
  const at = temporary(t), spec = join(at, 'spec.json'), output = join(at, 'output');
  writeFileSync(output, '');
  writeFileSync(spec, JSON.stringify({ argv: ['sh', '-c', 'touch started; sleep 60'], cwd: at, env: { PATH: process.env.PATH }, kind: phone.id }));
  const child = spawn(process.execPath, [join(dir, 'scripts/run-on-device.mjs')], { detached: true, env: env({ SPEC: spec, GITHUB_OUTPUT: output }) });
  const ended = new Promise(resolve => child.on('close', code => resolve(code)));
  for (let i = 0; i < 500 && !existsSync(join(at, 'started')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  process.kill(-child.pid, 'SIGTERM');
  assert.equal(await ended, 143);
  assert.equal(readFileSync(output, 'utf8'), 'exit_code=143\n');
});
