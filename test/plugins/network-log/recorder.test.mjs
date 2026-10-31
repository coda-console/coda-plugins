// The 网络记录 plugin's recorder, its table, probes and mihomo stood in for, on a clock moved by hand: what it writes of a
// connection that hangs and how it ends, how it bounds a flood of them, its probes, and a system it cannot read.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Recorder } from '../../../plugins/network-log/lib/recorder.mjs';
import { Log } from '../../../plugins/network-log/lib/store.mjs';
import { Tracker } from '../../../plugins/network-log/lib/tracker.mjs';

const socket = (port, state = 'connecting', pid = 7) => ({ state, local: { ip: '192.168.31.120', port }, remote: { ip: '20.205.243.166', port: 443 }, process: 'git-remote-http', pid });

function recorder(t, { table = () => [], settings = {}, mihomo } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'network-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-24T03:00:00+08:00');
  const told = [], log = new Log(dir);
  const made = new Recorder({ log, now: () => now, listen: change => told.push(structuredClone(change)),
    settings: async () => ({ enabled: true, targets: {}, hangSeconds: 3, mihomo: 'http://127.0.0.1:9090', ...settings }),
    readSockets: async () => table(now), settleSocket: async s => ({ ...s, iface: s.local.ip === '198.18.0.1' ? 'utun1' : 'en0' }),
    command: async pid => `git-remote-https https://github.com/x/y.git (${pid})`, ifaceOf: ip => ip === '198.18.0.1' ? 'utun1' : 'en0',
    mihomo: mihomo ?? { tunDevice: async () => 'utun1', connectionFrom: async () => ({ taken: false }) } });
  return { made, log, told, at: () => now, after: ms => { now += ms; } };
}

test('a connection hanging past the setting is written once, with how it went out, then how it ended', async t => {
  let rows = [socket(5001), socket(5002)];
  const { made, log, told, after } = recorder(t, { table: () => rows });
  await made.refresh();
  await made.sample();
  after(2000); await made.sample();
  // One connects before the setting: nothing of it is written.
  rows = [socket(5001), socket(5002, 'connected')];
  after(1000); await made.sample();
  after(1000); await made.sample();
  assert.deepEqual(log.read().map(e => e.kind), ['hang']);
  const [hang] = log.read();
  assert.deepEqual({ ...hang, id: undefined }, { kind: 'hang', id: undefined, at: Date.parse('2026-10-24T03:00:00+08:00'), seen: Date.parse('2026-10-24T03:00:03+08:00'),
    process: 'git-remote-http', pid: 7, command: 'git-remote-https https://github.com/x/y.git (7)', local: '192.168.31.120:5001', remote: '20.205.243.166:443',
    iface: 'en0', viaTun: false, mihomo: { taken: false } });
  // Gone from the table: given up.
  rows = [];
  after(72_000); await made.sample();
  assert.deepEqual(log.read().slice(1), [{ kind: 'hang-end', id: hang.id, at: Date.parse('2026-10-24T03:01:16+08:00'), outcome: 'gone' }]);
  assert.deepEqual(told.filter(c => c.collection === 'hangs').map(c => [c.id, c.object.end?.outcome ?? null]), [[hang.id, null], [hang.id, 'gone']]);
  assert.deepEqual(made.status.tun, 'utun1');
});

test('one that connects after hanging is said to; mihomo not answering is written as it said', async t => {
  let rows = [{ ...socket(6001), local: { ip: '198.18.0.1', port: 6001 } }];
  const { made, log, after } = recorder(t, { table: () => rows, mihomo: { tunDevice: async () => 'utun1', connectionFrom: async () => { throw new Error('connect ECONNREFUSED'); } } });
  await made.refresh();
  await made.sample(); after(3000); await made.sample();
  rows = [{ ...rows[0], state: 'connected' }];
  after(1000); await made.sample();
  const [hang, end] = log.read();
  assert.equal(hang.iface, 'utun1'); assert.equal(hang.viaTun, true);
  assert.deepEqual(hang.mihomo, { error: 'connect ECONNREFUSED' });
  assert.equal(end.outcome, 'connected');
});

test('past thirty hangs a minute they are counted, and the count written as the next minute starts', async t => {
  let rows = Array.from({ length: 35 }, (_, i) => socket(7000 + i));
  const { made, log, after } = recorder(t, { table: () => rows });
  await made.refresh();
  await made.sample(); after(3000); await made.sample();
  assert.equal(log.read().filter(e => e.kind === 'hang').length, 30);
  rows = [socket(8000)];
  after(60_000); await made.sample(); after(3000); await made.sample();
  // The minute settled before the reading: the count of the five not written, the thirty written ending, the next minute's hang.
  assert.deepEqual(log.read().map(e => e.kind).slice(30), ['dropped', ...Array(30).fill('hang-end'), 'hang']);
  assert.equal(log.read().find(e => e.kind === 'dropped').count, 5);
});

test('a hang still waiting when the page\'s summary lets it go has its end written all the same', async t => {
  const waiting = socket(1);
  let rows = [waiting];
  const { made, log, after } = recorder(t, { table: () => rows });
  await made.refresh();
  await made.sample(); after(1000);
  // Each minute 29 more hang, and those of the minute before end: past 300 hangs, the one still waiting is the oldest.
  for (let minute = 0; minute < 11; minute++) {
    rows = [waiting, ...Array.from({ length: 29 }, (_, i) => socket(1000 + minute * 100 + i))];
    await made.sample(); after(3000); await made.sample(); after(57_000);
  }
  const first = log.read().find(e => e.kind === 'hang');
  assert.equal(first.local, '192.168.31.120:1');
  assert.equal(log.read().filter(e => e.kind === 'hang').length, 320);
  await made.probeAll();
  assert.equal(made.summary.hangs.has(first.id), false, 'let go of by the summary');
  rows = [];
  await made.sample();
  assert.deepEqual(log.read().filter(e => e.kind === 'hang-end' && e.id === first.id).map(e => e.outcome), ['gone']);
});

test('the count of a minute past the bound is written though nothing hangs after it', async t => {
  let rows = Array.from({ length: 35 }, (_, i) => socket(7000 + i));
  const { made, log, after } = recorder(t, { table: () => rows });
  await made.refresh();
  await made.sample(); after(3000); await made.sample();
  rows = [];
  after(1000); await made.sample();
  assert.equal(log.read().filter(e => e.kind === 'dropped').length, 0, 'the minute is not over');
  after(60_000); await made.sample();
  assert.deepEqual(log.read().filter(e => e.kind === 'dropped').map(e => e.count), [5]);
});

test('a hang the last recorder did not see end is written as ended without knowing how, once, as it starts again', async t => {
  const { made, log, told } = recorder(t);
  log.append({ kind: 'hang', id: 'open', at: Date.parse('2026-10-24T02:50:00+08:00'), process: 'git-remote-http', local: '192.168.31.120:1', remote: '20.205.243.166:443' });
  log.append({ kind: 'hang', id: 'closed', at: Date.parse('2026-10-24T02:51:00+08:00'), process: 'curl', local: '192.168.31.120:2', remote: '10.255.255.1:443' });
  log.append({ kind: 'hang-end', id: 'closed', at: Date.parse('2026-10-24T02:51:10+08:00'), outcome: 'gone' });
  await made.start();
  made.stop();
  const ends = log.read().filter(e => e.kind === 'hang-end');
  assert.deepEqual(ends.map(e => [e.id, e.outcome]), [['closed', 'gone'], ['open', 'unknown']]);
  assert.equal(made.summary.hangs.get('open').end.outcome, 'unknown');
  assert.equal(told.find(c => c.id === 'open').object.end.outcome, 'unknown');
  // Started again, it is not written again.
  await made.start();
  made.stop();
  assert.equal(log.read().filter(e => e.kind === 'hang-end').length, 2);
});

test('a hang left open by a recorder stopped longer than the page\'s week is ended without knowing how, as it starts again', async t => {
  const { made, log, at } = recorder(t);
  log.append({ kind: 'hang', id: 'old', at: at() - 8 * 86_400_000, process: 'git-remote-http', local: '192.168.31.120:1', remote: '20.205.243.166:443' });
  await made.start();
  made.stop();
  assert.deepEqual(log.read().filter(e => e.kind === 'hang-end').map(e => [e.id, e.outcome, e.at]), [['old', 'unknown', at()]]);
  assert.equal(made.summary.hangs.has('old'), false, 'past the page\'s week');
});

test('what the log does not take (the disk full) waits in turn, is shown meanwhile, and is written once the log takes it', async t => {
  let rows = [socket(9001), socket(9002)];
  const { made, log, after } = recorder(t, { table: () => rows });
  // A full disk takes part of a line, then refuses.
  let full = false;
  log.appendFile = (file, text) => {
    if (!full) return appendFileSync(file, text);
    appendFileSync(file, text.slice(0, 20));
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  };
  await made.refresh();
  await made.sample(); after(3000); await made.sample();
  assert.equal(log.read().filter(e => e.kind === 'hang').length, 2);
  // Both end while the disk is full: neither is lost, both are shown ended, the status says why.
  full = true; rows = [];
  after(1000); await made.sample();
  assert.equal(log.read().filter(e => e.kind === 'hang-end').length, 0);
  assert.deepEqual([...made.summary.hangs.values()].map(h => h.end?.outcome), ['gone', 'gone']);
  assert.deepEqual(made.status.unwritten, { count: 2, error: 'ENOSPC' });
  // Room again: local maintenance writes them, in turn.
  full = false;
  await made.refresh({ network: false });
  assert.deepEqual(log.read().filter(e => e.kind === 'hang-end').map(e => e.at), [Date.parse('2026-10-24T03:00:04+08:00'), Date.parse('2026-10-24T03:00:04+08:00')]);
  assert.equal(made.status.unwritten, null);
});

for (const failedAt of ['hang', 'hang-end']) test(`history retries while collection is off after writing ${failedAt} failed`, async t => {
  const settings = { enabled: true };
  const { made, log, after } = recorder(t, { settings, table: () => [socket(9001)] });
  let full = failedAt === 'hang';
  log.appendFile = (file, text) => {
    if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    appendFileSync(file, text);
  };
  await made.refresh();
  await made.sample(); after(3000); await made.sample();
  full = true;
  settings.enabled = false;
  await made.refresh({ network: false });
  assert.equal(made.status.enabled, false);
  assert.deepEqual(made.status.unwritten, { count: failedAt === 'hang' ? 2 : 1, error: 'ENOSPC' });
  assert.equal(log.read().length, failedAt === 'hang' ? 0 : 1);

  // The disk recovers with collection still off. Local maintenance saves both the history and its interrupted end.
  const unexpected = async () => assert.fail('collection must remain off');
  made.readSockets = made.request = unexpected;
  made.mihomo = { tunDevice: unexpected, connectionFrom: unexpected };
  full = false;
  await made.refresh({ network: false });
  const saved = log.read();
  assert.deepEqual(saved.map(event => event.kind), ['hang', 'hang-end']);
  assert.equal(saved[1].id, saved[0].id);
  assert.equal(saved[1].outcome, 'unknown');
  assert.equal(made.status.unwritten, null);
  assert.equal(made.status.enabled, false);
  await made.refresh({ network: false });
  await made.sample();
  await made.probeAll();
  assert.deepEqual(log.read(), saved, 'subsequent maintenance neither duplicates history nor collects new records');
});

test('probes are written with the interface they went out of; a system without a table is said once, its probes go on', async t => {
  const { made, log, told } = recorder(t, { table: () => null, settings: { targets: { GitHub: 'https://github.com' } } });
  made.request = async url => ({ ok: false, phase: 'connect', error: 'ETIMEDOUT', ms: { dns: 3, total: 15000 }, address: '20.205.243.166', local: '198.18.0.1', url });
  await made.refresh();
  await made.sample();
  assert.equal(made.status.supported, false);
  await made.probeAll();
  const [probe] = log.read();
  assert.deepEqual({ ...probe, at: undefined }, { kind: 'probe', at: undefined, target: 'GitHub', url: 'https://github.com', ok: false, phase: 'connect', error: 'ETIMEDOUT',
    ms: { dns: 3, total: 15000 }, address: '20.205.243.166', local: '198.18.0.1', iface: 'utun1', viaTun: true });
  const target = told.findLast(c => c.collection === 'targets').object;
  assert.deepEqual([target.buckets.length, target.buckets[0][1], target.buckets[0][2], target.failures.length], [1, 1, 1, 1]);
});

test('without explicit opt-in no socket table, probe or mihomo is read, while history stays available', async t => {
  const { made, log, at } = recorder(t, { settings: { enabled: undefined, targets: { GitHub: 'https://github.com' } } });
  t.after(() => made.stop());
  const unexpected = async () => assert.fail('collection is off');
  made.readSockets = made.request = unexpected;
  made.mihomo = { tunDevice: unexpected, connectionFrom: unexpected };
  log.append({ kind: 'probe', at: at(), target: 'GitHub', url: 'https://github.com', ok: true, ms: { total: 10 } });
  await made.start();
  await made.sample();
  await made.probeAll();
  assert.equal(made.status.enabled, false);
  assert.equal(made.summary.targets.get('GitHub').buckets[0][1], 1);
  assert.equal(log.read().length, 1);
});

test('switching off ends observation, stops all collection and resumes with a fresh table when enabled again', async t => {
  const settings = { enabled: true, targets: { GitHub: 'https://github.com' } };
  const { made, log, after } = recorder(t, { settings, table: () => [socket(5001)] });
  let reads = 0, probes = 0, mihomo = 0;
  made.readSockets = async () => { reads++; return [socket(5001)]; };
  made.request = async () => { probes++; return { ok: true, ms: { total: 10 } }; };
  made.mihomo.tunDevice = async () => { mihomo++; return 'utun1'; };
  await made.refresh();
  await made.sample(); after(3000); await made.sample();
  await made.probeAll();
  assert.equal(log.read().filter(e => e.kind === 'hang').length, 1);
  const counts = [reads, probes, mihomo];
  settings.enabled = false;
  await made.refresh({ network: false });
  await made.sample();
  await made.probeAll();
  assert.equal(made.status.enabled, false);
  assert.deepEqual([reads, probes, mihomo], counts);
  assert.equal(log.read().at(-1).outcome, 'unknown');
  const length = log.read().length;
  after(60_000); await made.sample(); await made.probeAll();
  assert.equal(log.read().length, length);
  settings.enabled = true;
  await made.refresh({ network: false });
  await made.sample();
  assert.equal(made.status.enabled, true);
  assert.equal(log.read().length, length, 'time while off does not count toward a new hang');
  after(3000); await made.sample();
  assert.equal(log.read().filter(e => e.kind === 'hang').length, 2);
});

test('a probe returning after collection is stopped cannot write into a later capture', async t => {
  const settings = { enabled: true, targets: { GitHub: 'https://github.com' } };
  const { made, log } = recorder(t, { settings });
  const requested = Promise.withResolvers(), response = Promise.withResolvers();
  made.request = () => { requested.resolve(); return response.promise; };
  const pending = made.probeAll();
  await requested.promise;
  settings.enabled = false;
  await made.refresh({ network: false });
  settings.enabled = true;
  await made.refresh({ network: false });
  response.resolve({ ok: true, ms: { total: 10 } });
  await pending;
  assert.deepEqual(log.read(), []);
});

test('the settings loop can turn collection off while a socket reading is still pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settings = { enabled: true };
  const { made, log } = recorder(t, { settings });
  t.after(() => made.stop());
  const reading = Promise.withResolvers(), result = Promise.withResolvers(), off = Promise.withResolvers(), sampled = Promise.withResolvers();
  made.readSockets = () => { reading.resolve(); return result.promise; };
  made.listen = change => { if (change.collection === 'status' && change.object.enabled === false) off.resolve(); };
  const sample = made.sample.bind(made);
  made.sample = async () => { await sample(); sampled.resolve(); };
  await made.start();
  t.mock.timers.tick(made.sampleMs);
  await reading.promise;
  // Let the completed settings callback schedule its next reading; the socket callback is still pending.
  await new Promise(setImmediate);
  settings.enabled = false;
  t.mock.timers.tick(made.sampleMs);
  await off.promise;
  result.resolve([socket(5001)]);
  await sampled.promise;
  assert.equal(made.status.enabled, false);
  assert.deepEqual(log.read(), []);
});

test('the tracker: a socket waiting less than the setting is nothing; one waiting past it is said once', () => {
  const tracker = new Tracker({ hangMs: 3000 });
  assert.deepEqual(tracker.read([socket(1)], 0).began, []);
  assert.equal(tracker.read([socket(1)], 3000).began.length, 1);
  assert.deepEqual(tracker.read([socket(1)], 4000), { began: [], ended: [] });
  assert.deepEqual(tracker.read([], 5000).ended.map(e => [e.outcome, e.since]), [['gone', 0]]);
  assert.deepEqual(tracker.read([socket(2)], 6000), { began: [], ended: [] });
  assert.deepEqual(tracker.read([socket(2, 'connected')], 7000), { began: [], ended: [] });
});
