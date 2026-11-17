// The Antigravity entry on a fake `agy acp`, as Coda starts it: Coda is given no additional directories to pass.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { manifest } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

function start(t) {
  const messages = [];
  const home = mkdtempSync(join(tmpdir(), 'antigravity-entry-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))}\n`, { mode: 0o755 });
  const p = new AgentProcess({ onMessage: message => messages.push(message), command: manifest('antigravity').contributes.agents[0].command, cwd: home,
    env: { ...process.env, HOME: home, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('antigravity') } });
  t.after(async () => { await p.terminate(1500); p.kill(); rmSync(home, { recursive: true, force: true }); });
  return { p, messages, request: async (method, params) => (await p.request(method, params, { timeout: 5000 })).result };
}

test('the entry takes additionalDirectories out of the capabilities agy declares and out of session requests', async t => {
  const { request } = start(t);
  const { agentCapabilities } = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(agentCapabilities, { loadSession: true, sessionCapabilities: { list: {} }, session_capabilities: { list: {} }, _meta: { coda: { probe: {} } } });
  const params = { cwd: '/work', mcpServers: [], additionalDirectories: ['/b-extra', '/c-extra'] };
  const { additionalDirectories, ...rest } = params;
  assert.deepEqual((await request('session/new', params)).received, rest);
  assert.deepEqual((await request('session/load', { ...params, sessionId: 's' })).received, { ...rest, sessionId: 's' });
  assert.deepEqual((await request('session/resume', { ...params, sessionId: 's' })).received, { ...rest, sessionId: 's' });
  assert.deepEqual((await request('session/prompt', { sessionId: 's', additionalDirectories })).received, { sessionId: 's', additionalDirectories }, 'other requests are not touched');
});

const allow = { optionId: 'yes', kind: 'allow_once', name: 'allow' };
const reject = { optionId: 'no', kind: 'reject_once', name: 'deny' };
const modeOf = update => update.params.update.currentModeId;

// A session of the fake agy, in Coda's place. `reached` has agy ask for a permission and expects it to arrive at Coda within
// 3 seconds, answers it, and expects agy to get that answer; `allowed` expects agy to be answered without Coda being asked.
async function session(t) {
  const h = start(t);
  await h.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await h.request('session/new', { cwd: '/work', mcpServers: [] });
  const permission = (id = sessionId, options = [reject, allow]) => h.request('fake/permission', { sessionId: id, options });
  const arrived = async () => {
    for (const end = Date.now() + 3000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 10))) {
      const at = h.messages.findIndex(message => message.method === 'session/request_permission');
      if (at >= 0) return h.messages.splice(at, 1)[0];
    }
    throw new Error('the permission did not reach Coda');
  };
  const reached = async (id, options) => {
    const answered = permission(id, options);
    const ask = await Promise.race([arrived(), answered.then(answer => { throw new Error(`agy was answered without asking Coda: ${JSON.stringify(answer)}`); })]);
    assert.deepEqual(ask.params.options, options ?? [reject, allow]);
    h.p.respond(ask.id, { outcome: { outcome: 'selected', optionId: 'no' } });
    assert.deepEqual((await answered).answered, { outcome: { outcome: 'selected', optionId: 'no' } });
  };
  const allowed = async () => {
    const before = h.messages.length;
    assert.deepEqual((await permission()).answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
    assert.equal(h.messages.length, before, 'Coda was not asked');
  };
  return { ...h, sessionId, reached, allowed };
}

test('the entry declares full beside the modes of agy, in the session answers and in the mode option', async t => {
  const { request } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const answers = [await request('session/new', { cwd: '/work' }), await request('session/load', { cwd: '/work', sessionId: 's1' }), await request('session/resume', { cwd: '/work', sessionId: 's1' })];
  for (const { modes, configOptions } of answers) {
    assert.deepEqual(modes.availableModes.map(mode => mode.id), ['default', 'accept-edits', 'auto', 'plan', 'full']);
    assert.equal(modes.availableModes.at(-1).name, '全部放行');
    assert.equal(modes.currentModeId, 'default');
    const mode = configOptions.find(option => option.id === 'mode');
    assert.deepEqual(mode.options.map(option => option.value), ['default', 'accept-edits', 'auto', 'plan', 'full']);
    assert.equal(mode.currentValue, 'default');
    assert.equal(configOptions.find(option => option.id === 'model').options.length, 3, 'other options are not touched');
  }
});

test('switching to full gives agy default and shows Coda full, by set_mode and by set_config_option', async t => {
  const { request, messages, sessionId } = await session(t);
  const viaMode = await request('session/set_mode', { sessionId, modeId: 'full' });
  assert.deepEqual(viaMode.received, { sessionId, modeId: 'default' });
  assert.equal(modeOf(messages.at(-1)), 'full', 'the update agy sends for default is shown as full');
  await request('session/set_mode', { sessionId, modeId: 'auto' });
  assert.equal(modeOf(messages.at(-1)), 'auto');
  const viaOption = await request('session/set_config_option', { sessionId, configId: 'mode', value: 'full' });
  assert.deepEqual(viaOption.received, { sessionId, configId: 'mode', value: 'default' });
  assert.equal(modeOf(messages.at(-1)), 'full');
  const mode = viaOption.configOptions.find(option => option.id === 'mode');
  assert.equal(mode.currentValue, 'full');
  assert.ok(mode.options.some(option => option.value === 'full'));
});

test('changing another option in full keeps full, in the answer and in the permissions', async t => {
  const { request, sessionId, allowed } = await session(t);
  await request('session/set_mode', { sessionId, modeId: 'full' });
  const { configOptions } = await request('session/set_config_option', { sessionId, configId: 'model', value: 'm' });
  const mode = configOptions.find(option => option.id === 'mode');
  assert.equal(mode.currentValue, 'full');
  assert.ok(mode.options.some(option => option.value === 'full'));
  await allowed();
});

test('in full the entry allows a permission itself, with allow_once, and Coda is not asked', async t => {
  const { request, sessionId, allowed } = await session(t);
  await request('session/set_mode', { sessionId, modeId: 'full' });
  await allowed();
});

test('out of full a permission goes to Coda again, to default or to any other mode', async t => {
  const { request, sessionId, reached, allowed } = await session(t);
  for (const modeId of ['default', 'plan']) {
    await request('session/set_mode', { sessionId, modeId: 'full' });
    await allowed();
    await request('session/set_mode', { sessionId, modeId });
    await reached();
  }
});

test('when agy refuses the switch into full, the session is not in full and the error is passed on as it is', async t => {
  const { p, request, sessionId, reached } = await session(t);
  await request('fake/refuse', { sessionId });
  const refused = await p.request('session/set_mode', { sessionId, modeId: 'full' }, { timeout: 5000 });
  assert.deepEqual(refused.error, { code: -32602, message: 'invalid mode default' });
  await reached();
});

test('when agy refuses the switch out of full, the session stays in full', async t => {
  const { p, request, sessionId, allowed } = await session(t);
  await request('session/set_mode', { sessionId, modeId: 'full' });
  await request('fake/refuse', { sessionId });
  assert.equal((await p.request('session/set_mode', { sessionId, modeId: 'plan' }, { timeout: 5000 })).error.code, -32602);
  await allowed();
});

test('without an allow_once option the permission goes to Coda', async t => {
  const { request, sessionId, reached } = await session(t);
  await request('session/set_mode', { sessionId, modeId: 'full' });
  await reached(sessionId, [reject, { optionId: 'always', kind: 'allow_always', name: 'always' }]);
});

test('a mode agy announces itself other than default takes the session out of full', async t => {
  const { request, messages, sessionId, reached } = await session(t);
  await request('session/set_mode', { sessionId, modeId: 'full' });
  await request('fake/mode', { sessionId, modeId: 'plan' });
  assert.equal(modeOf(messages.at(-1)), 'plan');
  await reached();
});

test('full of one session does not reach another', async t => {
  const { request, messages, sessionId, reached, allowed } = await session(t);
  const other = (await request('session/new', { cwd: '/work' })).sessionId;
  await request('session/set_mode', { sessionId, modeId: 'full' });
  await request('session/set_mode', { sessionId: other, modeId: 'plan' });
  assert.deepEqual([messages.at(-1).params.sessionId, modeOf(messages.at(-1))], [other, 'plan'], 'the update of the other session is not rewritten');
  await reached(other);
  await allowed();
});

test('the entry ends on SIGTERM', async t => {
  const { p, request } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const started = Date.now();
  process.kill(p.pid, 'SIGTERM');
  assert.equal((await p.exited).code, 0);
  assert.ok(Date.now() - started < 2000);
});

test('the retry notice of agy does not reach Coda, the answer around it does, and the entry says it on its stderr', async t => {
  const { p, request, messages, sessionId } = await session(t);
  const text = update => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: update } });
  const notice = '\n⚠ API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded\n';
  const updates = [text(notice), { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: notice } }, text(`答案\n${notice}`), text('后续正文')];
  await request('fake/updates', { sessionId, updates });
  const arrived = messages.filter(message => message.method === 'session/update').map(message => message.params.update);
  assert.deepEqual(arrived.filter(update => update.sessionUpdate !== 'current_mode_update'), updates.slice(1));
  assert.ok(p.stderr.includes(`agy 重试模型请求，提示不转给 Coda：${notice.trim()}`), p.stderr);
});
