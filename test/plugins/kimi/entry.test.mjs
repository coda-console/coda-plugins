// From Coda's backend/test/kimi-entry.test.mjs at ef1d2311, as plain node:test. Its case through the entry and Coda's
// backend stays in Coda.
// The Kimi entry (plugins/kimi/agent/): what Kimi's own files say of its tasks is told to Coda as waits. A task ending during
// Coda's prompt ends there; one ending outside a prompt is handled until the main agent ends a later turn of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { kimiSession } from '../../../plugins/kimi/agent/observe.mjs';
import { KimiWaits, nextFire, nextRun } from '../../../plugins/kimi/agent/waits.mjs';
import { KimiRelay } from '../../../plugins/kimi/agent/relay.mjs';
import { MINIMUM, needed } from '../../../plugins/kimi/scripts/setup.mjs';

const SESSION = 'session-test';
async function layout(t, sessionId = SESSION, cwd) {
  const root = await mkdtemp(join(tmpdir(), 'coda-kimi-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'kimi'), session = join(home, 'sessions', 'workspace', sessionId), tasks = join(session, 'agents', 'main', 'tasks');
  cwd ??= join(root, 'work');
  await mkdir(tasks, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir: session, workDir: cwd }) + '\n');
  const state = { version: 2, id: sessionId, cwd, agents: { main: {} } };
  await writeFile(join(session, 'state.json'), JSON.stringify(state));
  const wire = join(session, 'agents/main/wire.jsonl');
  await writeFile(wire, [{ type: 'metadata', protocol_version: '1.5' }, { type: 'agent.turn.started', turnId: 0, time: 1 },
    { type: 'turn.ended', turnId: 0, agentId: 'main', reason: 'completed', time: 2 }].map(e => JSON.stringify(e) + '\n').join(''));
  const task = (taskId, value) => writeFile(join(tasks, `${taskId}.json`), JSON.stringify({ taskId, kind: 'process', detached: true, ...value }));
  const turn = (turnId, from, to, kind = 'agent.turn.started') => appendFile(wire, JSON.stringify(kind === 'turn.prompt' ? { type: kind, agentId: 'main', turnId, time: from } : { type: kind, turnId, time: from }) + '\n' +
    (to ? JSON.stringify({ type: 'turn.ended', turnId, agentId: 'main', reason: 'completed', time: to }) + '\n' : ''));
  return { root, home, cwd, session, tasks, wire, state, task, turn };
}
// The entry's look: what it tells Coda, as `[waitId, state]`.
function looker(f, { version = '2.1.1', startedAt = 0 } = {}) {
  const session = kimiSession({ sessionId: SESSION, cwd: f.cwd, env: { KIMI_CODE_HOME: f.home }, version, startedAt });
  const waits = new KimiWaits({ sessionId: SESSION, startedAt });
  const look = async () => {
    const facts = await session.observe({ signal: new AbortController().signal });
    return (facts ? waits.read(facts) : waits.lost()).filter(m => m.method === '_coda/wait').map(m => [m.params.waitId, m.params.state]);
  };
  return Object.assign(look, { session });
}

test('a command Kimi ran in the background is waited on, handled once it ended, and done once a main turn ended after it', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('bash-1', { status: 'running', startedAt: 1, description: 'npm test' });
  assert.deepEqual(await look(), [['bash-1', 'waiting']]);
  await f.task('bash-1', { status: 'completed', startedAt: 1, endedAt: 3 });
  assert.deepEqual(await look(), [['bash-1', 'handling']]);
  await f.turn(1, 4);
  assert.deepEqual(await look(), []);
  await appendFile(f.wire, JSON.stringify({ type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 5 }) + '\n');
  assert.deepEqual(await look(), [['bash-1', 'done']]);
});

test('each way a task ends is told as such; one Kimi is not told of ends as it ends; a child agent\'s command is the session\'s too', async t => {
  const f = await layout(t), look = looker(f);
  f.state.agents.child = {};
  await writeFile(join(f.session, 'state.json'), JSON.stringify(f.state));
  await mkdir(join(f.session, 'agents/child/tasks'), { recursive: true });
  await writeFile(join(f.session, 'agents/child/tasks/nested.json'), JSON.stringify({ taskId: 'nested', kind: 'process', status: 'running', startedAt: 1 }));
  for (const id of ['killed', 'lost', 'timed_out']) await f.task(id, { status: 'running', startedAt: 1 });
  await f.task('quiet', { status: 'running', startedAt: 1 });
  assert.equal((await look()).length, 5);
  for (const id of ['killed', 'lost', 'timed_out']) await f.task(id, { status: id, startedAt: 1, endedAt: 1 });
  await f.task('quiet', { status: 'failed', startedAt: 1, endedAt: 3, terminalNotificationSuppressed: true });
  assert.deepEqual((await look()).sort(), [['killed', 'cancelled'], ['lost', 'failed'], ['quiet', 'failed'], ['timed_out', 'failed']]);
});

test('every way a main turn starts and ends counts as the turn that takes up what ended before it', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('one', { status: 'running', startedAt: 1 });
  await look();
  await f.task('one', { status: 'completed', startedAt: 1, endedAt: 3 });
  assert.deepEqual(await look(), [['one', 'handling']]);
  await appendFile(f.wire, [{ type: 'turn.prompt', agentId: 'main', turnId: 1, time: 4 }, { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'blocked', time: 5 }]
    .map(e => JSON.stringify(e) + '\n').join(''));
  assert.deepEqual(await look(), [['one', 'done']]);
});

test('what cannot be read now is looked at again; what is not laid out as understood ends what was waited on', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('one', { status: 'running', startedAt: 1 });
  await look();
  await f.task('one', { status: 'completed', startedAt: 1, endedAt: 3 });
  // A wire still being written is no answer.
  await appendFile(f.wire, '{"type":"turn.prompt","agentId":"main",');
  await assert.rejects(look());
  await appendFile(f.wire, '"turnId":1,"time":4}\n');
  assert.deepEqual(await look(), [['one', 'handling']]);
  // An ending that names no agent, or another, is not the layout understood.
  await appendFile(f.wire, JSON.stringify({ type: 'turn.ended', turnId: 1, agentId: 'child', reason: 'completed', time: 5 }) + '\n');
  assert.deepEqual(await look(), [['one', 'failed']]);
});

test('foreign sessions, links, oversized files and other versions tell nothing; unrelated index lines do not stop it', async t => {
  const f = await layout(t);
  await f.task('one', { status: 'running', startedAt: 1 });
  assert.deepEqual(await looker(f, { version: '2.2.0' })(), []);
  await appendFile(join(f.home, 'session_index.jsonl'), 'null\n{partial\n');
  assert.deepEqual(await looker(f)(), [['one', 'waiting']]);
  await writeFile(join(f.session, 'state.json'), JSON.stringify({ ...f.state, id: 'another' }));
  assert.deepEqual(await looker(f)(), []);
  await writeFile(join(f.session, 'state.json'), JSON.stringify(f.state));
  await rm(join(f.tasks, 'one.json')); const foreign = join(f.cwd, 'foreign.json');
  await writeFile(foreign, JSON.stringify({ taskId: 'one', kind: 'process', status: 'running', startedAt: 1 })); await symlink(foreign, join(f.tasks, 'one.json'));
  assert.deepEqual(await looker(f)(), []);
  await rm(join(f.tasks, 'one.json')); await writeFile(join(f.tasks, 'one.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(looker(f)());
  assert.equal(await kimiSession({ version: 'future', env: { KIMI_CODE_HOME: '/does/not/exist' } }).observe({ signal: new AbortController().signal }), null);
});

test('tasks from before this agent process are not told', async t => {
  const f = await layout(t);
  await f.task('old', { status: 'running', startedAt: 1 });
  assert.deepEqual(await looker(f, { startedAt: 10 })(), []);
});

// A cron's full wait, not only its state. `now` is the system clock the schedule is read against.
function cronLooker(f, now, env = {}) {
  const session = kimiSession({ sessionId: SESSION, cwd: f.cwd, env: { ...env, KIMI_CODE_HOME: f.home }, version: '2.1.1', startedAt: 0 });
  const waits = new KimiWaits({ sessionId: SESSION, startedAt: 0, now: () => now });
  const look = async () => {
    const facts = await session.observe({ signal: new AbortController().signal });
    return (facts ? waits.read(facts) : waits.lost()).filter(m => m.method === '_coda/wait').map(m => m.params);
  };
  return Object.assign(look, { waits });
}
const wireEvent = (f, event) => appendFile(f.wire, JSON.stringify(event) + '\n');
const at = (cron, now, noJitter = false) => new Date(nextFire(cron, now, noJitter)).toISOString();

test('a cron Kimi scheduled is a timer until it fires, then handled through that turn', async t => {
  const f = await layout(t), now = Date.parse('2026-10-16T02:15:00'), createdAt = Date.parse('2026-10-16T02:00:00'), look = cronLooker(f, now);
  const cron = { id: 'cron-1', schedule: '19 3 16 10 *', recurring: false, createdAt };
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'cron-1', cron: cron.schedule, recurring: false, createdAt,
    prompt: '检查 k 测量：`/tmp/secret`\n其余不要带出去' } });
  const waiting = await look();
  assert.deepEqual(waiting, [{ sessionId: SESSION, waitId: 'cron-1', state: 'waiting', kind: 'timer', title: '检查 k 测量', detail: '19 3 16 10 *',
    recurring: false, stoppable: false, at: at(cron, now) }]);
  assert.equal(JSON.stringify(waiting).includes('secret'), false);
  // The fire writes cron.delete and then the cron_job turn. One look that sees both is that turn, still open.
  await wireEvent(f, { type: 'cron.delete', ids: ['cron-1'], time: 20 });
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 1, time: 21, origin: { kind: 'cron_job', jobId: 'cron-1' } });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'cron-1', state: 'handling' }]);
  await wireEvent(f, { type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 30 });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'cron-1', state: 'done' }]);
});

test('a one-shot that fires and ends between looks is done, and a delete seen before its turn is not a cancel', async t => {
  const f = await layout(t), now = Date.parse('2026-10-16T02:15:00'), createdAt = Date.parse('2026-10-16T02:00:00');
  const session = kimiSession({ sessionId: SESSION, cwd: f.cwd, env: { KIMI_CODE_HOME: f.home }, version: '2.1.1', startedAt: 0 });
  const waits = new KimiWaits({ sessionId: SESSION, startedAt: 0, now: () => now });
  const look = async () => {
    const facts = await session.observe({ signal: new AbortController().signal });
    return (facts ? waits.read(facts) : waits.lost()).filter(m => m.method === '_coda/wait').map(m => m.params);
  };
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'soon', cron: '19 3 16 10 *', recurring: false, createdAt, prompt: '即将' } });
  await look();
  // The scheduler writes cron.delete, then the cron_job turn. A look in between must not end it.
  await wireEvent(f, { type: 'cron.delete', ids: ['soon'], time: 20 });
  assert.deepEqual(await look(), []);
  assert.equal(waits.handling, 0);
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 1, time: 21, origin: { kind: 'cron_job', jobId: 'soon' } });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'soon', state: 'handling' }]);
  assert.equal(waits.handling, 1);
  await wireEvent(f, { type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 30 });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'soon', state: 'done' }]);
  await wireEvent(f, { type: 'cron.add', time: 40, task: { id: 'gap', cron: '19 3 16 10 *', recurring: false, createdAt, prompt: '一轮之间' } });
  await look();
  await wireEvent(f, { type: 'cron.delete', ids: ['gap'], time: 50 });
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 2, time: 51, origin: { kind: 'cron_job', jobId: 'gap' } });
  await wireEvent(f, { type: 'turn.ended', turnId: 2, agentId: 'main', reason: 'completed', time: 60 });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'gap', state: 'done' }]);
});

test('CronDelete of a cron that has not fired cancels it once that turn is open, and a later turn does not leave it handling', async t => {
  const f = await layout(t), now = Date.parse('2026-10-16T02:15:00'), createdAt = Date.parse('2026-10-16T02:00:00');
  const session = kimiSession({ sessionId: SESSION, cwd: f.cwd, env: { KIMI_CODE_HOME: f.home }, version: '2.1.1', startedAt: 0 });
  const waits = new KimiWaits({ sessionId: SESSION, startedAt: 0, now: () => now });
  const look = async () => {
    const facts = await session.observe({ signal: new AbortController().signal });
    return (facts ? waits.read(facts) : waits.lost()).filter(m => m.method === '_coda/wait').map(m => m.params);
  };
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'cron-1', cron: '19 3 16 10 *', recurring: false, createdAt, prompt: '检查' } });
  await look();
  // The tool runs inside the turn that is already going, which is not a cron_job of this id.
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 1, time: 15 });
  await wireEvent(f, { type: 'cron.delete', ids: ['cron-1'], time: 20 });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'cron-1', state: 'cancelled' }]);
  assert.equal(waits.handling, 0);
  await wireEvent(f, { type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 25 });
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 2, time: 30 });
  await wireEvent(f, { type: 'turn.ended', turnId: 2, agentId: 'main', reason: 'completed', time: 40 });
  assert.deepEqual(await look(), []);
  assert.equal(waits.handling, 0);
});

test('a cron whose fire turn already ended is not registered, and a recurring one waits again after its turn', async t => {
  const f = await layout(t), now = Date.parse('2026-10-16T11:02:00'), createdAt = Date.parse('2026-10-16T10:30:00');
  const cron = { id: 'again', schedule: '0 * * * *', recurring: true, createdAt };
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'gone', cron: '19 3 16 10 *', recurring: false, createdAt, prompt: '已过' } });
  await wireEvent(f, { type: 'cron.delete', ids: ['gone'], time: 20 });
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 1, time: 21, origin: { kind: 'cron_job', jobId: 'gone' } });
  await wireEvent(f, { type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 30 });
  const look = cronLooker(f, now);
  assert.deepEqual(await look(), []);
  await wireEvent(f, { type: 'cron.add', time: 40, task: { id: 'again', cron: '0 * * * *', recurring: true, createdAt, prompt: '每小时' } });
  assert.equal((await look())[0].state, 'waiting');
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 2, time: 41, origin: { kind: 'cron_job', jobId: 'again' } });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'again', state: 'handling' }]);
  await wireEvent(f, { type: 'cron.cursor', id: 'again', lastFiredAt: Date.parse('2026-10-16T11:00:00') });
  await wireEvent(f, { type: 'turn.ended', turnId: 2, agentId: 'main', reason: 'completed', time: 50 });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'again', state: 'waiting', at: at({ ...cron, lastFiredAt: Date.parse('2026-10-16T11:00:00') }, now) }]);
});

test('a recurring round that falls between looks moves the next fire even though it is still waiting', async t => {
  const f = await layout(t), now = Date.parse('2026-10-16T11:02:00'), createdAt = Date.parse('2026-10-16T10:30:00'), look = cronLooker(f, now);
  const cron = { id: 'deadbeef', schedule: '0 * * * *', recurring: true, createdAt };
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'deadbeef', cron: '0 * * * *', recurring: true, createdAt, prompt: '每小时' } });
  const waiting = await look();
  assert.equal(waiting[0].at, at(cron, now));
  assert.notEqual(waiting[0].at, new Date(nextRun('0 * * * *', now)).toISOString());
  const fired = Date.parse('2026-10-16T11:00:00');
  await wireEvent(f, { type: 'cron.cursor', id: 'deadbeef', lastFiredAt: fired });
  await wireEvent(f, { type: 'turn.prompt', agentId: 'main', turnId: 1, time: 20, origin: { kind: 'cron_job', jobId: 'deadbeef' } });
  await wireEvent(f, { type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 30 });
  assert.deepEqual(await look(), [{ sessionId: SESSION, waitId: 'deadbeef', state: 'waiting', at: at({ ...cron, lastFiredAt: fired }, now) }]);
});

test('a cron event that is not the shape understood does not hide a background command', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('bash-1', { status: 'running', startedAt: 1, description: 'npm test' });
  await wireEvent(f, { type: 'cron.add', task: { id: 'nope' } });
  await wireEvent(f, { type: 'cron.delete', ids: 'cron-1' });
  await wireEvent(f, { type: 'cron.cursor', id: 5, lastFiredAt: 'soon' });
  assert.deepEqual(await look(), [['bash-1', 'waiting']]);
});

test('an unreadable cron expression is a timer with no time', async t => {
  const f = await layout(t), look = cronLooker(f, Date.parse('2026-10-16T02:15:00'));
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'cron-1', cron: 'every hour', recurring: true, createdAt: Date.parse('2026-10-16T02:00:00'), prompt: '不行' } });
  const waiting = await look();
  assert.equal(waiting[0].state, 'waiting');
  assert.equal('at' in waiting[0], false);
});

test('the next fire follows the id, the cursor and the schedule config', async t => {
  const f = await layout(t), createdAt = Date.parse('2026-10-16T10:30:00'), now = Date.parse('2026-10-16T11:02:00');
  const cron = { id: 'deadbeef', schedule: '0 * * * *', recurring: true, createdAt };
  await wireEvent(f, { type: 'cron.add', time: 10, task: { id: 'deadbeef', cron: '0 * * * *', recurring: true, createdAt, prompt: '每小时' } });
  // A config with no [cron] table, however quoted its other tables, keeps the default offset.
  await writeFile(join(f.home, 'config.toml'), '[models."kimi-code/k3"]\nmodel = "k3"\n');
  assert.equal((await cronLooker(f, now)())[0].at, at(cron, now));
  await writeFile(join(f.home, 'config.toml'), '[cron]\nno_jitter = true # pinned\n');
  assert.equal((await cronLooker(f, now)())[0].at, at(cron, now, true));
  await writeFile(join(f.home, 'config.toml'), '[cron]\nno_jitter = false\n');
  assert.equal((await cronLooker(f, now, { KIMI_CRON_NO_JITTER: '1' })())[0].at, at(cron, now, true));
  assert.equal((await cronLooker(f, now, { KIMI_CRON_NO_JITTER: 'true' })())[0].at, at(cron, now));
  await writeFile(join(f.home, 'config.toml'), '[cron]\ndisabled = true\n');
  assert.equal('at' in (await cronLooker(f, now)())[0], false);
  await writeFile(join(f.home, 'config.toml'), '[cron]\nclock = "file:clock"\n');
  assert.equal('at' in (await cronLooker(f, now)())[0], false);
  const fileNow = Date.parse('2026-10-16T10:40:00'), cursor = Date.parse('2026-10-16T11:00:00');
  const clockPath = join(f.root, 'clock');
  await writeFile(clockPath, `${fileNow}\n`);
  await writeFile(join(f.home, 'config.toml'), `[cron]\nclock = ${JSON.stringify(`file:${clockPath}`)}\n`);
  await wireEvent(f, { type: 'cron.cursor', id: 'deadbeef', lastFiredAt: cursor });
  const held = (await cronLooker(f, Date.parse('2026-10-16T11:30:00'))())[0].at;
  assert.equal(held, at(cron, fileNow));
  assert.notEqual(held, at({ ...cron, lastFiredAt: cursor }, Date.parse('2026-10-16T11:30:00')));
});

test('a five-field cron matches the next local minute, and Kimi offsets that minute from the cursor', () => {
  assert.equal(nextRun('19 3 16 10 *', Date.parse('2026-10-16T02:15:00')), Date.parse('2026-10-16T03:19:00'));
  assert.equal(nextRun('0 0 31 2 *'), null);
  assert.equal(nextRun('every hour'), null);
  const fraction = 0xdeadbeef / 4294967296;
  const createdAt = Date.parse('2026-10-16T10:30:00'), now = Date.parse('2026-10-16T11:02:00');
  const hourly = { id: 'deadbeef', schedule: '0 * * * *', recurring: true, createdAt };
  assert.equal(nextFire(hourly, now, false), Date.parse('2026-10-16T11:00:00') + 3_600_000 * 0.1 * fraction);
  assert.equal(nextRun('0 * * * *', now), Date.parse('2026-10-16T12:00:00'));
  assert.equal(nextFire({ ...hourly, lastFiredAt: Date.parse('2026-10-16T11:00:00') }, now, false), Date.parse('2026-10-16T12:00:00') + 3_600_000 * 0.1 * fraction);
  assert.equal(nextFire(hourly, now, true), Date.parse('2026-10-16T11:00:00'));
  assert.equal(nextFire({ ...hourly, lastFiredAt: Date.parse('2026-10-16T11:00:00') }, Date.parse('2026-10-16T10:40:00'), false), nextFire(hourly, Date.parse('2026-10-16T10:40:00'), false));
  const daily = { id: 'deadbeef', schedule: '0 0 * * *', recurring: true, createdAt: Date.parse('2026-10-16T01:00:00') };
  assert.equal(nextFire(daily, daily.createdAt, false), Date.parse('2026-10-17T00:00:00') + 15 * 60_000 * fraction);
  const onceAt = Date.parse('2026-10-16T04:00:00'), once = { id: 'deadbeef', schedule: '0 4 16 10 *', recurring: false, createdAt: Date.parse('2026-10-16T02:00:00') };
  assert.equal(nextFire(once, Date.parse('2026-10-16T04:00:30'), false), onceAt - 90_000 * fraction);
  assert.equal(nextRun('0 4 16 10 *', Date.parse('2026-10-16T04:00:30')), Date.parse('2027-10-16T04:00:00'));
  assert.equal(nextFire({ id: 'deadbeef', schedule: '19 3 16 10 *', recurring: false, createdAt: Date.parse('2026-10-16T02:00:00') }, Date.parse('2026-10-16T02:15:00'), false), Date.parse('2026-10-16T03:19:00'));
  assert.equal(nextFire({ id: 'ffffffff', schedule: '0 4 16 10 *', recurring: false, createdAt: onceAt - 1000 }, onceAt - 1000, false), onceAt);
  assert.equal(nextFire({ id: 'deadbeef', schedule: 'every hour', recurring: true, createdAt: 1 }, 1, false), null);
  // An id that is not eight hex digits takes the same fraction Kimi hashes.
  let hash = 5381;
  for (const ch of 'cron-1') hash = (hash << 5) + hash + ch.charCodeAt(0) | 0;
  const hashed = { id: 'cron-1', schedule: '0 * * * *', recurring: true, createdAt };
  assert.equal(nextFire(hashed, now, false), Date.parse('2026-10-16T11:00:00') + 3_600_000 * 0.1 * ((hash >>> 0) / 4294967296));
});

// The relay, with Kimi and its files stood in for.
function relay({ env = {}, facts = () => null } = {}) {
  const said = [], told = [];
  const session = { observe: async () => facts(), watch: () => ({ close() {} }) };
  const r = new KimiRelay({ say: m => said.push(m), tell: m => told.push(m), env, startedAt: 0, every: 50, hold: 200, session: () => session });
  const ready = async () => {
    r.fromCoda({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    r.fromAgent({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } } });
    r.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work', mcpServers: [] } });
    r.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } });
    await r.drained(); await delay(10);
  };
  return { r, said, told, ready };
}
const running = { tasks: [{ taskId: 'job', kind: 'process', status: 'running', startedAt: 1 }], turnEndedAt: 2 };

for (const plain of [false, true]) test(`the relay ${plain ? 'passes through' : 'classifies'} a five-hour quota failure without retrying`, async t => {
  const { r, said, told, ready } = relay({ env: plain ? { CODA_DISABLE_RUNTIME_PATCHES: 'kimi' } : {} });
  t.after(() => r.close());
  await ready();
  const reason = "403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
  const reply = { jsonrpc: '2.0', id: 2, error: { code: -32000, message: `Authentication required: ${reason}` } };
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: '继续' }] } });
  r.fromAgent(reply);
  await r.drained();
  if (plain) assert.equal(said.at(-1), reply);
  else {
    assert.equal(said.at(-1).id, 2);
    assert.equal(said.at(-1).error.code, -32603);
    assert.equal(said.at(-1).error.message, reason);
    assert.deepEqual(said.at(-1).error.data._meta.coda.failure, { kind: 'quota_exhausted' });
  }
  assert.equal(told.filter(message => message.method === 'session/prompt').length, 1);
});

test('quota adaptation leaves session creation errors and content notifications unchanged', async t => {
  const { r, said } = relay();
  t.after(() => r.close());
  const reason = "Authentication required: 403 You've reached your 5-hour usage limit.";
  r.fromCoda({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: { cwd: '/work', mcpServers: [] } });
  const reply = { jsonrpc: '2.0', id: 'new', error: { code: -32000, message: reason } };
  const notification = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reason } } } };
  r.fromAgent(reply); r.fromAgent(notification);
  await r.drained();
  assert.equal(said[0], reply);
  assert.equal(said[1], notification);
});

test('the relay says it reports waits, and before Kimi\'s answer to a prompt is passed on, what that turn took up is told', async t => {
  let facts = running;
  const { r, said, told, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready();
  assert.deepEqual(said[0].result.agentCapabilities, { sessionCapabilities: { systemPrompt: {} }, _meta: { coda: { waits: {} } } });
  assert.deepEqual(said.filter(m => m.method === '_coda/wait').map(m => m.params.state), ['waiting']);
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [] } });
  assert.equal(told.at(-1).id, 2);
  facts = { tasks: [{ ...running.tasks[0], status: 'completed', endedAt: 3 }], turnEndedAt: 4 };
  r.fromAgent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.deepEqual(said.slice(-2).map(m => m.method ?? m.result.stopReason), ['_coda/wait', 'end_turn']);
  assert.equal(said.at(-2).params.state, 'done');
});

test('a subagent ending during a Coda prompt is done while the parent keeps working', async t => {
  const child = { taskId: 'child', kind: 'agent', agentId: 'agent-1', status: 'running', startedAt: 1 };
  let facts = { tasks: [child], turnEndedAt: 2 };
  const { r, said, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready();
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [] } });
  facts = { tasks: [{ ...child, status: 'completed', endedAt: 3 }], turnEndedAt: 2 };
  await r.look({ fresh: true });
  assert.deepEqual(said.filter(m => m.method === '_coda/wait').map(m => m.params.state), ['waiting', 'done']);
});

test('outside a prompt, with nothing handled, what Kimi says waits for a look: what it handles is told first', async t => {
  let facts = running;
  const { r, said, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready(); await delay(60);
  facts = { tasks: [{ ...running.tasks[0], status: 'completed', endedAt: 3 }], turnEndedAt: 2 };
  r.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '接着做' } } } });
  await r.drained();
  assert.deepEqual(said.slice(-2).map(m => m.method), ['_coda/wait', 'session/update']);
  assert.equal(said.at(-2).params.state, 'handling');
});

test('CODA_DISABLE_RUNTIME_PATCHES=kimi leaves a plain relay, but for the session instructions', async t => {
  let looked = 0;
  const { r, said, ready } = relay({ env: { CODA_DISABLE_RUNTIME_PATCHES: 'kimi' }, facts: () => { looked++; return running; } });
  t.after(() => r.close());
  await ready();
  assert.deepEqual([said.length, said[0].result.agentCapabilities, looked], [2, { sessionCapabilities: { systemPrompt: {} } }, 0]);
});

test('Coda\'s session instructions go in front of a new session\'s first prompt only, never to Kimi as a parameter', async t => {
  const { r, said, told } = relay();
  t.after(() => r.close());
  const systemPrompt = { mode: 'append', content: [{ type: 'text', text: '# Coda client' }] };
  const prompt = (id, sessionId, text) => { r.fromCoda({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }); return told.at(-1).params.prompt; };
  r.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work', mcpServers: [], systemPrompt } });
  assert.deepEqual(told.at(-1).params, { cwd: '/work', mcpServers: [] });
  r.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } });
  // A slash command is Kimi's to read as one: the instructions wait.
  assert.deepEqual(prompt(2, SESSION, '/compact'), [{ type: 'text', text: '/compact' }]);
  const [instructions, input] = prompt(3, SESSION, '你好');
  assert.equal(instructions.type, 'text');
  assert.match(instructions.text, /^<coda-session-instructions>\n[^]*\n\n# Coda client\n<\/coda-session-instructions>\n$/);
  assert.deepEqual(input, { type: 'text', text: '你好' });
  assert.deepEqual(prompt(4, SESSION, '再来'), [{ type: 'text', text: '再来' }]);
  // A loaded session has had them.
  r.fromCoda({ jsonrpc: '2.0', id: 5, method: 'session/load', params: { sessionId: 'other', cwd: '/work', mcpServers: [], systemPrompt } });
  assert.deepEqual(told.at(-1).params, { sessionId: 'other', cwd: '/work', mcpServers: [] });
  r.fromAgent({ jsonrpc: '2.0', id: 5, result: {} });
  assert.deepEqual(prompt(6, 'other', '继续'), [{ type: 'text', text: '继续' }]);
  // What cannot be applied opens no session.
  const count = told.length;
  r.fromCoda({ jsonrpc: '2.0', id: 7, method: 'session/new', params: { cwd: '/work', mcpServers: [], systemPrompt: { mode: 'override', content: [] } } });
  await r.drained();
  assert.equal(told.length, count);
  assert.deepEqual([said.at(-1).id, said.at(-1).error.code], [7, -32602]);
});

test('a title Kimi took from the instructions in front of the first prompt is not passed on; its own titles are', async t => {
  const { r, said } = relay();
  t.after(() => r.close());
  const info = update => r.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'session_info_update', ...update } } });
  info({ title: '<coda-session-instructions> Instructions from Coda, the client this session runs in', updatedAt: '2026-10-14T00:00:00Z' });
  info({ title: '修好登录页' });
  await r.drained();
  const titles = said.filter(m => m.params?.update?.sessionUpdate === 'session_info_update').map(m => m.params.update);
  assert.deepEqual(titles, [{ sessionUpdate: 'session_info_update', updatedAt: '2026-10-14T00:00:00Z' }, { sessionUpdate: 'session_info_update', title: '修好登录页' }]);
});

// The relay over Kimi's files as `layout` leaves them (and `change` changes them), Kimi saying it is `version`, Coda taking
// what is not adapted when `taken`: all it said, and what of it said Kimi's files are not as understood.
async function reported(t, { version = '2.1.1', taken = true, change = async () => {} } = {}) {
  const f = await layout(t);
  await f.task('job', { status: 'running', startedAt: 1 });
  await change(f);
  const said = [];
  const r = new KimiRelay({ say: m => said.push(m), tell: () => {}, env: { KIMI_CODE_HOME: f.home }, startedAt: 0, every: 10, hold: 500 });
  t.after(() => r.close());
  r.fromCoda({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientCapabilities: taken ? { _meta: { coda: { unrecognized: {} } } } : {} } });
  r.fromAgent({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'Kimi Code CLI', version } } });
  r.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: f.cwd, mcpServers: [] } });
  r.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } });
  await r.drained();
  // Looked at three times in all: what is not understood stays so.
  await r.look({ fresh: true }); await r.look({ fresh: true });
  return { said, told: said.filter(m => m.method === '_coda/unrecognized').map(m => m.params) };
}
const UNSEEN = '后台任务、子 Agent、定时看不见，失败的一轮可能显示成成功';

// Red if a version or layout that matches were reported, or reporting changed anything else Coda is told: the waits
// capability, the task's wait.
test('a Kimi of the version checked, its files as understood, is relayed as before and reports nothing unadapted', async t => {
  const taken = await reported(t), before = await reported(t, { taken: false });
  assert.deepEqual(taken.told, []);
  assert.deepEqual(taken.said, before.said);
  assert.deepEqual(taken.said[0].result.agentCapabilities._meta, { coda: { waits: {} } });
  assert.deepEqual(taken.said.filter(m => m.method === '_coda/wait').map(m => [m.params.waitId, m.params.state]), [['job', 'waiting']]);
});

// Red if another version's reason were dropped again (observe.mjs `unread`), said each look, said to a Coda that does not take
// it, said without the version or the sentence the user reads, or if it now read the files or declared waits.
test('another version of Kimi is relayed plainly and said once, by name, with its version and what goes unseen', async t => {
  const { said, told } = await reported(t, { version: '2.6.0' });
  assert.equal(told.length, 1);
  assert.deepEqual({ ...told[0], detail: undefined }, { sessionId: SESSION, kind: 'output', name: 'files:version', lost: true, detail: undefined });
  assert.match(told[0].detail, /^Kimi 2\.6\.0：这个版本的 Kimi 没有核对过（核对过的是 2\.1\.1），/);
  assert.ok(told[0].detail.endsWith(UNSEEN), told[0].detail);
  assert.equal(said[0].result.agentCapabilities._meta, undefined);
  assert.deepEqual(said.filter(m => m.method === '_coda/wait'), []);
  assert.deepEqual((await reported(t, { version: '2.6.0', taken: false })).told, []);
});

// Red if one of the three layout checks lost its reason, or they were told by one name: each is counted apart.
test('Kimi 2.1.1 files not laid out as understood are said once each, by which way they differ', async t => {
  const state = (await reported(t, { change: f => writeFile(join(f.session, 'state.json'), JSON.stringify({ ...f.state, version: 3 })) })).told;
  assert.deepEqual(state.map(p => p.name), ['files:state.version']);
  assert.match(state[0].detail, /^Kimi 2\.1\.1：会话的 state\.json 版本对不上/);
  const wire = (await reported(t, { change: f => writeFile(f.wire, JSON.stringify({ type: 'metadata', protocol_version: '1.6' }) + '\n') })).told;
  assert.deepEqual(wire.map(p => p.name), ['files:wire.protocol_version']);
  const task = (await reported(t, { change: f => f.task('job', { kind: 'thread', status: 'running', startedAt: 1 }) })).told;
  assert.deepEqual(task.map(p => [p.name, p.lost]), [['files:layout', true]]);
});

test('setup installs a missing or broken Kimi CLI, upgrades one older than the file layout the relay reads, and keeps a newer one', () => {
  const run = (status, stdout = '', stderr = '') => () => ({ status, stdout, stderr });
  assert.equal(MINIMUM, '2.1.1');
  assert.deepEqual(needed(null), { action: 'install', reason: '这台机器上没有 Kimi CLI' });
  assert.equal(needed('/bin/kimi', run(1)).action, 'install');
  assert.deepEqual(needed('/bin/kimi', run(0, 'kimi, version 1.6.0\n')), { action: 'upgrade', reason: 'Kimi CLI 1.6.0 低于所需的 2.1.1' });
  assert.deepEqual(needed('/bin/kimi', run(0, '', 'kimi 2.1.1\n')), { action: 'none', version: '2.1.1' });
  assert.deepEqual(needed('/bin/kimi', run(0, 'kimi 2.10.0\n')), { action: 'none', version: '2.10.0' });
  assert.equal(needed('/bin/kimi', run(0, 'kimi\n')).action, 'upgrade');
});
