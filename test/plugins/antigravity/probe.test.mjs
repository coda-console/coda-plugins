// Coda's configuration probes answered by the Antigravity entry on a fake `agy acp` that counts its native session/new
// (fixture.mjs): from the catalog in the plugin's state directory, collected once through an agy of its own, and never
// with a native session of the probe's.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { askModels, createCatalog } from '../../../plugins/antigravity/agent/catalog.mjs';
import { manifest } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const FIXTURE = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
const PROBE = { _meta: { coda: { probe: true } } };

// A client of the entry, as Coda is: one JSON message a line, split at LF alone.
class Client {
  constructor(env) {
    this.next = 0; this.pending = new Map(); this.notes = []; this.errors = '';
    this.child = spawn('/bin/sh', ['-c', manifest('antigravity').contributes.agents[0].command], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.on('exit', code => resolve(code)));
    this.child.stderr.setEncoding('utf8').on('data', text => { this.errors += text; });
    let rest = '';
    this.child.stdout.setEncoding('utf8').on('data', text => {
      const lines = (rest + text).split('\n'); rest = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const m = JSON.parse(line);
        if ('id' in m && !m.method && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } else this.notes.push(m);
      }
    });
  }
  // The whole answer, `{ result }` or `{ error }`.
  request(method, params, id = `c-${this.next++}`) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} not answered`)), 15_000);
      this.pending.set(id, m => { clearTimeout(timer); resolve(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async result(method, params) {
    const m = await this.request(method, params);
    assert.ok(!m.error, `${method}: ${JSON.stringify(m.error)}`);
    return m.result;
  }
  // Once the entry has said `pattern` on its standard error: its catalog logs an event there when it is done with it.
  said(pattern) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never said ${pattern}`)), 15_000);
      const look = () => { if (pattern.test(this.errors)) { clearTimeout(timer); this.child.stderr.off('data', look); resolve(); } };
      this.child.stderr.on('data', look);
      look();
    });
  }
  init() { return this.result('initialize', { protocolVersion: 1, clientCapabilities: {} }); }
  close() { this.child.stdin.end(); return this.exited; }
  kill() { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }
}

// A machine of its own: a home with the fake agy, the plugin's state directory, and the file the fake counts native
// sessions in. `entry(env)` starts the entry there; `natives()` is the cwd of each native session/new so far.
function machine(t) {
  const home = mkdtempSync(join(tmpdir(), 'antigravity-probe-')), state = join(home, 'state'), log = join(home, 'natives.log');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(state);
  writeFileSync(join(home, '.local/bin/agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FIXTURE)} "$@"\n`, { mode: 0o755 });
  const clients = [];
  t.after(async () => { for (const c of clients) c.kill(); chmodSync(state, 0o755); rmSync(home, { recursive: true, force: true }); });
  const entry = (env = {}) => {
    const c = new Client({ ...process.env, HOME: home, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('antigravity'), CODA_PLUGIN_STATE: state, FAKE_AGY_LOG: log, ...env });
    clients.push(c);
    return c;
  };
  const natives = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.slice(4)) : [];
  // A probe from a new entry, as Coda makes one: initialize, then the marked session/new. Its whole answer.
  const probe = async (cwd = '/work', env) => {
    const c = entry(env);
    await c.init();
    const m = await c.request('session/new', { cwd, mcpServers: [], ...PROBE });
    return { c, m };
  };
  return { home, state, log, entry, natives, probe, catalogFile: join(state, 'catalog-v1.json'), catalogCwd: join(state, 'catalog-cwd') };
}
const option = (configOptions, id) => configOptions.find(o => o.id === id);
const choices = o => o?.options.map(x => x.value);
const withoutId = ({ sessionId, ...rest }) => rest;

test('initialize declares the probe capability beside what agy declares', async t => {
  const { entry } = machine(t);
  const { agentCapabilities } = await entry().init();
  assert.deepEqual(agentCapabilities._meta, { coda: { probe: {} } });
  assert.equal(agentCapabilities.loadSession, true);
  assert.equal(agentCapabilities.sessionCapabilities.delete, undefined, 'no native delete is claimed');
});

test('a cold catalog is collected once, in the neutral directory; warm probes from any cwd open no native session', async t => {
  const { probe, natives, catalogCwd, catalogFile } = machine(t);
  const first = await probe('/project/a');
  assert.ok(first.m.result.sessionId.startsWith('coda-probe:'));
  assert.deepEqual(natives(), [catalogCwd], 'the one native session is the collection\'s');
  const answers = [first.m.result];
  for (const cwd of ['/project/a', '/project/b', '/project/c', '/project/b', '/project/d']) answers.push((await probe(cwd)).m.result);
  assert.deepEqual(natives(), [catalogCwd]);
  for (const answer of answers.slice(1)) assert.deepEqual(withoutId(answer), withoutId(answers[0]), 'every cwd gets the same catalog');
  assert.equal(new Set(answers.map(a => a.sessionId)).size, answers.length);
  const { configOptions, modes } = answers[0];
  assert.deepEqual(choices(option(configOptions, 'model')), ['m', 'xh', 'none']);
  assert.equal(option(configOptions, 'model').options[0].name, '模型 m ☃', 'Unicode as agy said it');
  assert.deepEqual(modes.availableModes.map(m => m.id), ['default', 'accept-edits', 'auto', 'plan', 'full']);
  assert.deepEqual(choices(option(configOptions, 'mode')), ['default', 'accept-edits', 'auto', 'plan', 'full']);
  const saved = readFileSync(catalogFile, 'utf8');
  assert.doesNotMatch(saved, /"sessionId"|received/, 'neither the collection\'s session nor what it said of it is kept');
  assert.deepEqual(Object.keys(JSON.parse(saved).byModel), ['m', 'xh', 'none']);
});

test('probes arriving together at a cold catalog collect it once', async t => {
  const { probe, natives, catalogCwd } = machine(t);
  const answers = await Promise.all(['/a', '/b', '/c', '/d'].map(cwd => probe(cwd, { FAKE_AGY_DELAY: '400' })));
  for (const { m } of answers) assert.ok(m.result?.sessionId.startsWith('coda-probe:'), JSON.stringify(m.error));
  assert.deepEqual(natives(), [catalogCwd]);
});

test('another agy version, or changed settings, collects the catalog once more', async t => {
  const { probe, natives, home } = machine(t);
  await probe();
  await probe('/x', { FAKE_AGY_VERSION: '1.6.0' });
  await probe('/y', { FAKE_AGY_VERSION: '1.6.0' });
  assert.equal(natives().length, 2, 'once for the new version');
  const settings = join(home, '.gemini/antigravity-cli/settings.json');
  mkdirSync(join(settings, '..'), { recursive: true });
  writeFileSync(settings, '{}');
  await probe('/x', { FAKE_AGY_VERSION: '1.6.0' });
  await probe('/y', { FAKE_AGY_VERSION: '1.6.0' });
  assert.equal(natives().length, 3, 'once for the settings that appeared');
  utimesSync(settings, new Date(), new Date(Date.now() + 5000));
  await probe('/x', { FAKE_AGY_VERSION: '1.6.0' });
  await probe('/y', { FAKE_AGY_VERSION: '1.6.0' });
  assert.equal(natives().length, 4, 'once for the settings that changed');
});

test('a collection that fails answers the probe with an error, sends it to no native session and leaves the old catalog', async t => {
  const { probe, natives, catalogFile, catalogCwd, state } = machine(t);
  const cold = await probe('/work', { FAKE_AGY_FAIL_MODEL: 'xh' });
  assert.equal(cold.m.error.code, -32603);
  assert.match(cold.m.error.message, /invalid model xh/);
  assert.ok(!existsSync(catalogFile), 'no catalog of part of the models');
  assert.deepEqual(natives(), [catalogCwd], 'the probe itself went to no native session');
  // Within the cool-down the same agy and settings are not tried again.
  const again = await probe('/work');
  assert.match(again.m.error.message, /秒后再试：.*invalid model xh/);
  assert.equal(natives().length, 1);
  // Another version may be tried at once; it succeeds, and a failure after it leaves that catalog as it was.
  await probe('/work', { FAKE_AGY_VERSION: '1.6.0' });
  const kept = readFileSync(catalogFile, 'utf8');
  const failed = await probe('/work', { FAKE_AGY_VERSION: '1.7.0', FAKE_AGY_FAIL_MODEL: 'none' });
  assert.ok(failed.m.error);
  assert.equal(readFileSync(catalogFile, 'utf8'), kept);
  assert.deepEqual(natives(), [catalogCwd, catalogCwd, catalogCwd]);
  assert.ok(JSON.parse(readFileSync(join(state, 'catalog-v1.failure.json'), 'utf8')).reason.includes('invalid model none'));
  assert.match(readFileSync(join(state, 'catalog-v1.log'), 'utf8'), /"event":"collect.session","sessionId":"s1"/, 'the collection\'s session is logged');
});

test('signed out is -32000 and is not held back by a cool-down', async t => {
  const { probe, state } = machine(t);
  const { m } = await probe('/work', { FAKE_AGY_SIGNED_OUT: '1' });
  assert.equal(m.error.code, -32000);
  assert.ok(!existsSync(join(state, 'catalog-v1.failure.json')));
  assert.ok((await probe()).m.result, 'once signed in it is collected');
});

test('a state directory that cannot be written, or none, is an error, and no session is opened', async t => {
  const { probe, natives, state, entry } = machine(t);
  chmodSync(state, 0o500);
  const { m } = await probe();
  assert.match(m.error.message, /插件状态目录写不进去/);
  const c = entry({ CODA_PLUGIN_STATE: '' });
  await c.init();
  assert.match((await c.request('session/new', { cwd: '/w', mcpServers: [], ...PROBE })).error.message, /CODA_PLUGIN_STATE/);
  assert.deepEqual(natives(), []);
});

test('a mark other than true is refused, not sent on as an ordinary session', async t => {
  const { entry, natives } = machine(t);
  const c = entry();
  await c.init();
  for (const probe of [false, 'yes', 1, null]) {
    const { error } = await c.request('session/new', { cwd: '/w', mcpServers: [], _meta: { coda: { probe } } });
    assert.equal(error.code, -32602);
  }
  assert.deepEqual(natives(), []);
});

test('the thinking levels are each model\'s: xhigh where there is one, none where there is none, and wrong values are refused', async t => {
  const { probe } = machine(t);
  const { c, m } = await probe();
  const { sessionId } = m.result, set = (configId, value) => c.request('session/set_config_option', { sessionId, configId, value });
  assert.deepEqual(choices(option(m.result.configOptions, 'thought_level')), ['low', 'medium', 'high']);
  assert.equal((await set('thought_level', 'xhigh')).error.code, -32602, 'm has no xhigh');
  const xh = (await set('model', 'xh')).result.configOptions;
  assert.equal(option(xh, 'model').currentValue, 'xh');
  assert.deepEqual(choices(option(xh, 'thought_level')), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(option(xh, 'thought_level').currentValue, 'medium');
  assert.equal(option((await set('thought_level', 'xhigh')).result.configOptions, 'thought_level').currentValue, 'xhigh');
  const none = (await set('model', 'none')).result.configOptions;
  assert.equal(option(none, 'thought_level'), undefined);
  assert.equal((await set('thought_level', 'low')).error.code, -32602, 'a model without levels has no such option');
  assert.equal((await set('model', 'no-such-model')).error.code, -32602);
  assert.equal(option((await set('model', 'xh')).result.configOptions, 'thought_level').currentValue, 'medium', 'back to the model\'s default, not the old level');
  // The mode is the session's only: through the option or set_mode, `full` included, kept across a model switch.
  assert.equal(option((await set('mode', 'full')).result.configOptions, 'mode').currentValue, 'full');
  assert.equal(option((await set('model', 'm')).result.configOptions, 'mode').currentValue, 'full');
  assert.deepEqual((await c.request('session/set_mode', { sessionId, modeId: 'plan' })).result, {});
  assert.equal(option((await set('model', 'none')).result.configOptions, 'mode').currentValue, 'plan');
  assert.equal((await c.request('session/set_mode', { sessionId, modeId: 'yolo' })).error.code, -32602);
  // An odd value comes back in the error as it went, LF alone separating messages.
  assert.match((await set('model', 'a\u2028b ☃')).error.message, /a\u2028b ☃/);
});

test('a probe session takes no prompt, cannot be resumed, and goes with its connection', async t => {
  const { probe, entry, natives } = machine(t);
  const { c, m } = await probe();
  const { sessionId } = m.result;
  assert.deepEqual((await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })).error.code, -32602);
  assert.equal((await c.request('session/load', { sessionId, cwd: '/work', mcpServers: [] })).error.code, -32602);
  assert.equal((await c.request('session/cancel_all', { sessionId })).error.code, -32602, 'anything else is refused');
  assert.equal((await c.request('session/prompt', { sessionId: 'coda-probe:nobody', prompt: [] })).error.code, -32002);
  assert.deepEqual((await c.request('session/close', { sessionId })).result, {});
  assert.equal((await c.request('session/set_config_option', { sessionId, configId: 'model', value: 'xh' })).error.code, -32002);
  // Another connection, after this one is gone, knows nothing of it.
  const second = await probe();
  assert.equal(await c.close(), 0);
  assert.equal(await second.c.close(), 0);
  const other = entry();
  await other.init();
  for (const method of ['session/load', 'session/resume']) assert.equal((await other.request(method, { sessionId: second.m.result.sessionId, cwd: '/work', mcpServers: [] })).error.code, -32002);
  const { sessions } = (await other.result('session/list', {}));
  assert.ok(!JSON.stringify(sessions ?? []).includes('coda-probe:'));
  assert.equal(natives().length, 1, 'only the collection');
});

test('two probe sessions do not reach each other, nor real sessions of the same connection', async t => {
  const { probe, natives } = machine(t);
  const { c, m } = await probe();
  const a = m.result.sessionId, b = (await c.result('session/new', { cwd: '/work', mcpServers: [], ...PROBE })).sessionId;
  await c.result('session/set_config_option', { sessionId: a, configId: 'model', value: 'xh' });
  await c.result('session/set_config_option', { sessionId: a, configId: 'thought_level', value: 'xhigh' });
  const own = (await c.result('session/set_config_option', { sessionId: b, configId: 'thought_level', value: 'low' })).configOptions;
  assert.equal(option(own, 'model').currentValue, 'm');
  assert.equal(option(own, 'thought_level').currentValue, 'low');
  // A real session and a probe asked for at once: each answer goes to its own request.
  const [real, virtual] = await Promise.all([c.request('session/new', { cwd: '/real', mcpServers: [] }, 7), c.request('session/new', { cwd: '/real', mcpServers: [], ...PROBE }, '7')]);
  assert.equal(real.result.sessionId, 's1');
  assert.ok(virtual.result.sessionId.startsWith('coda-probe:'));
  assert.deepEqual(natives().slice(1), ['/real']);
});

test('a real session whose options differ from the catalog has it collected again at the next probe', async t => {
  const { probe, entry, natives } = machine(t);
  await probe();
  const c = entry();
  await c.init();
  await c.result('session/new', { cwd: '/real', mcpServers: [] });
  await probe();
  assert.equal(natives().length, 2, 'a session like the catalog changes nothing');
  const changed = entry({ FAKE_AGY_EXTRA_MODEL: '1' });
  await changed.init();
  // Its answer does not wait for the catalog to be marked: the probe goes once the mark is written.
  const marked = changed.said(/"event":"stale"/);
  await changed.result('session/new', { cwd: '/real', mcpServers: [] });
  await marked;
  const { m } = await probe('/work', { FAKE_AGY_EXTRA_MODEL: '1' });
  assert.deepEqual(choices(option(m.result.configOptions, 'model')), ['m', 'xh', 'none', 'extra']);
  assert.equal(natives().length, 4);
});

// The catalog itself, its clock given; `listed` is what agy models answers (a list, or an Error it fails with), each asking counted.
function catalogAt(t, extra = {}) {
  const { home, state, log } = machine(t);
  let clock = Date.parse('2026-11-16T00:00:00Z');
  const asked = { models: 0, listed: [['m-low', 'M (Low)'], ['xh-high', 'XH (High)']] };
  const run = (cmd, args, options) => spawn(cmd, args, { ...options, env: { ...process.env, FAKE_AGY_LOG: log } });
  const models = async () => { asked.models++; if (asked.listed instanceof Error) throw asked.listed; return structuredClone(asked.listed); };
  const catalog = createCatalog({ state, home, binary: join(home, '.local/bin/agy'), now: () => clock, spawn: run, version: async () => '1.5.9', models, ...extra });
  const natives = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
  return { catalog, natives, state, asked, tick: ms => { clock += ms; } };
}

test('the catalog has no age: agy models is asked once an hour, and the same list collects nothing', async t => {
  const { catalog, natives, asked, state, tick } = catalogAt(t);
  const first = await catalog.get();
  assert.deepEqual([natives(), asked.models], [1, 1], 'the collection asks agy models once, for the list it keeps');
  assert.deepEqual(first.agyModels, asked.listed);
  tick(59 * 60_000);
  await catalog.get();
  assert.equal(asked.models, 1, 'within the hour nothing is asked');
  for (let hour = 0; hour < 30; hour++) { tick(3600_000); assert.equal((await catalog.get()).collectedAt, first.collectedAt); }
  assert.deepEqual([natives(), asked.models], [1, 31], 'thirty hours: a check each hour, never a collection');
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'catalog-v1.check.json'), 'utf8')).ok, true);
});

test('a list agy models changes collects the catalog again, once', async t => {
  const { catalog, natives, asked, tick } = catalogAt(t);
  await catalog.get();
  tick(3600_000);
  asked.listed = [...asked.listed, ['neon-high', 'Neon (High)']];
  const fresh = await catalog.get();
  assert.deepEqual([natives(), asked.models], [2, 2], 'the check\'s list is the one kept: agy models is not asked again');
  assert.deepEqual(fresh.agyModels, asked.listed);
  assert.equal(fresh.collectedAt, Date.parse('2026-11-16T01:00:00Z'));
  tick(10 * 60_000);
  await catalog.get();
  assert.deepEqual([natives(), asked.models], [2, 2]);
});

test('agy models failing keeps the catalog, collects nothing, and is asked again after the cool-down', async t => {
  const { catalog, natives, asked, state, tick } = catalogAt(t);
  const first = await catalog.get();
  tick(3600_000);
  asked.listed = new Error('agy models 失败（1）：Error: not signed in');
  assert.equal((await catalog.get()).collectedAt, first.collectedAt);
  assert.deepEqual([natives(), asked.models], [1, 2]);
  tick(4 * 60_000);
  await catalog.get();
  assert.equal(asked.models, 2, 'not within the cool-down');
  tick(61_000);
  asked.listed = [['m-low', 'M (Low)'], ['xh-high', 'XH (High)']];
  await catalog.get();
  assert.deepEqual([natives(), asked.models], [1, 3], 'asked again, the same list, still no collection');
  assert.match(readFileSync(join(state, 'catalog-v1.log'), 'utf8'), /"event":"check.failed","reason":"agy models 失败（1）：Error: not signed in"/);
});

test('a catalog with no list of agy models (an older plugin\'s) is collected again once agy models answers', async t => {
  const { catalog, natives, asked, state, tick } = catalogAt(t);
  await catalog.get();
  const file = join(state, 'catalog-v1.json'), old = JSON.parse(readFileSync(file, 'utf8'));
  delete old.agyModels;
  writeFileSync(file, JSON.stringify(old));
  asked.listed = new Error('agy models 失败（1）');
  assert.equal((await catalog.get()).collectedAt, old.collectedAt, 'a check that fails keeps it');
  assert.deepEqual([natives(), asked.models], [1, 2]);
  tick(5 * 60_000);
  asked.listed = [['m-low', 'M (Low)']];
  const fresh = await catalog.get();
  assert.deepEqual([natives(), asked.models], [2, 3]);
  assert.deepEqual(fresh.agyModels, asked.listed);
});

test('a collection a check asked for that fails keeps the catalog there was', async t => {
  let fail = false;
  const { catalog, natives, asked, tick } = catalogAt(t, { spawn: (cmd, args, options) => spawn(cmd, args, { ...options, env: { ...process.env, ...(fail && { FAKE_AGY_FAIL_MODEL: 'xh' }) } }) });
  const first = await catalog.get();
  tick(3600_000);
  fail = true; asked.listed = [['other', 'Other']];
  assert.equal((await catalog.get()).collectedAt, first.collectedAt);
  tick(60_000);
  await catalog.get();
  assert.equal(asked.models, 2, 'the next check waits the cool-down');
  tick(5 * 60_000);
  fail = false;
  assert.deepEqual((await catalog.get()).agyModels, [['other', 'Other']]);
});

test('agy models is read from its lines as agy prints them, and a failing one says why', async t => {
  const { home } = machine(t);
  const binary = join(home, '.local/bin/agy');
  const listed = await askModels(binary, 5_000, home);
  assert.deepEqual(listed.map(([id]) => id), ['m-high', 'm-low', 'm-medium', 'none', 'xh-high', 'xh-low', 'xh-medium', 'xh-xhigh']);
  assert.deepEqual(listed.find(([id]) => id === 'xh-xhigh'), ['xh-xhigh', '模型 xh (xhigh)']);
  process.env.FAKE_AGY_MODELS_FAIL = '1';
  try { await assert.rejects(askModels(binary, 5_000, home), /agy models 失败（1）：Error: not signed in/); }
  finally { delete process.env.FAKE_AGY_MODELS_FAIL; }
});

test('an entry\'s collection keeps agy models\' list, which a probe does not ask again within the hour', async t => {
  const { probe, home, state } = machine(t);
  const counted = join(home, 'models.log');
  await probe('/a', { FAKE_AGY_LOG_MODELS: counted });
  await probe('/b', { FAKE_AGY_LOG_MODELS: counted });
  assert.equal(readFileSync(counted, 'utf8'), 'models\n');
  assert.ok(JSON.parse(readFileSync(join(state, 'catalog-v1.json'), 'utf8')).agyModels.some(([id]) => id === 'xh-xhigh'));
});

test('a failure is waited out for five minutes of the clock', async t => {
  let fail = true;
  const { catalog, tick } = catalogAt(t, { version: async () => '1.5.9', spawn: (cmd, args, options) => spawn(cmd, args, { ...options, env: { ...process.env, ...(fail && { FAKE_AGY_FAIL_MODEL: 'm' }) } }) });
  await assert.rejects(catalog.get(), /invalid model m/);
  fail = false;
  tick(4 * 60_000);
  await assert.rejects(catalog.get(), /秒后再试/);
  tick(61_000);
  assert.ok((await catalog.get()).byModel.m);
});

test('waiting for another entry\'s collection has a limit', async t => {
  const { state, home } = machine(t);
  writeFileSync(join(state, 'catalog-v1.lock.1'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const catalog = createCatalog({ state, home, binary: join(home, '.local/bin/agy'), version: async () => '1.5.9', limits: { wait: 300, poll: 50 } });
  await assert.rejects(catalog.get(), /等另一个进程读取模型目录超过/);
  // One whose holder is gone is taken over, by the next generation; it is freed, and the older ones are cleared.
  writeFileSync(join(state, 'catalog-v1.lock.1'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  assert.ok((await catalog.get()).byModel.xh);
  assert.deepEqual(readdirSync(state).filter(name => name.includes('lock')), ['catalog-v1.lock.2', 'catalog-v1.lock.2.free']);
});

// Two catalogs of one state directory, as two entries are; `gated(path)` holds the second's reads of matching files until
// `open()`. `collections` counts the agy collections both started, and the most at once.
function twoEntries(t, gated, env = {}) {
  const { state, home } = machine(t);
  let open, reached;
  const gate = new Promise(resolve => { open = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  const counted = { collections: 0, running: 0, most: 0 };
  let started;
  const collecting = new Promise(resolve => { started = resolve; });
  const run = (cmd, args, options) => {
    counted.collections++; counted.most = Math.max(counted.most, ++counted.running); started();
    const child = spawn(cmd, args, { ...options, env: { ...process.env, FAKE_AGY_DELAY: '200', ...env } });
    child.on('close', () => { counted.running--; });
    return child;
  };
  const make = fs => createCatalog({ state, home, binary: join(home, '.local/bin/agy'), version: async () => '1.5.9', spawn: run, fs, limits: { poll: 20 } });
  const held = { ...fsPromises };
  for (const name of ['readdir', 'readFile']) held[name] = async (path, ...rest) => { if (gated(name, `${path}`)) { reached(); await gate; } return fsPromises[name](path, ...rest); };
  return { first: make(fsPromises), second: make(held), arrived, open, collecting, counted, state };
}

test('an entry that takes the lock after another\'s collection failed keeps to the cool-down that failure left', async t => {
  const { first, second, arrived, open, counted } = twoEntries(t, name => name === 'readdir', { FAKE_AGY_FAIL_MODEL: 'xh' });
  // The second has read that there is no catalog and no failure, and waits at the lock while the first fails.
  const waiting = second.get();
  await arrived;
  await assert.rejects(first.get(), /invalid model xh/);
  open();
  await assert.rejects(waiting, /秒后再试：.*invalid model xh/);
  assert.equal(counted.collections, 1);
});

test('two entries taking over the same lock left behind do not both collect', async t => {
  const { first, second, arrived, open, collecting, counted, state } = twoEntries(t, (name, path) => name === 'readFile' && path.endsWith('catalog-v1.lock.1'));
  writeFileSync(join(state, 'catalog-v1.lock.1'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  // Both read the dead holder; the first takes the lock over and collects before the second goes on.
  const waiting = second.get();
  await arrived;
  const collected = first.get();
  await collecting;
  open();
  const [a, b] = await Promise.all([collected, waiting]);
  assert.equal(a.collectedAt, b.collectedAt);
  assert.deepEqual([counted.collections, counted.most], [1, 1]);
});

test('options agy answers that do not hold together fail the collection and leave the catalog there was', async t => {
  const { state, home } = machine(t);
  let version = '1.5.9', bad = {};
  const catalog = createCatalog({ state, home, binary: join(home, '.local/bin/agy'), version: async () => version,
    spawn: (cmd, args, options) => spawn(cmd, args, { ...options, env: { ...process.env, ...bad } }) });
  await catalog.get();
  const kept = readFileSync(join(state, 'catalog-v1.json'), 'utf8');
  version = '1.6.0'; bad = { FAKE_AGY_BAD_LEVEL: 'xh' };
  await assert.rejects(catalog.get(), /切到模型 xh 后 agy 给的配置不对：配置项 thought_level 的当前值 ultra 不在它的选项里/);
  assert.equal(readFileSync(join(state, 'catalog-v1.json'), 'utf8'), kept);
  assert.match(readFileSync(join(state, 'catalog-v1.failure.json'), 'utf8'), /ultra/);
});
