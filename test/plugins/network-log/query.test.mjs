// The 网络记录 plugin's log and its command `network-log`, run as Coda runs a plugin's command from its manifest (`sh -c`,
// the arguments after it, the plugin's state directory in CODA_PLUGIN_STATE), over a log the test writes.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Log, dayOf } from '../../../plugins/network-log/lib/store.mjs';
import { manifest, pluginEnv, run } from '../command.mjs';

const declared = manifest('network-log').contributes.commands.find(c => c.name === 'network-log');
function state(t) {
  const dir = mkdtempSync(join(tmpdir(), 'network-log-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const command = (dir, args = '') => run(`${declared.command} ${args}`, pluginEnv('network-log', { CODA_NODE: process.execPath, CODA_PLUGIN_STATE: dir }));

test('the log: a file a day, a while read across days, a broken line left out, the days past those kept removed', t => {
  const dir = join(state(t), 'log'), log = new Log(dir, { days: 2 });
  const day = 86_400_000, start = Date.parse('2026-10-20T12:00:00+08:00');
  for (let i = 0; i < 4; i++) log.append({ kind: 'probe', at: start + i * day, n: i });
  writeFileSync(join(dir, `${dayOf(start + day)}.jsonl`), '{ broken\n', { flag: 'a' });
  assert.deepEqual(log.read({ from: start + day, to: start + 2 * day }).map(e => e.n), [1, 2]);
  log.prune(start + 3 * day);
  assert.deepEqual(readdirSync(dir).sort(), [`${dayOf(start + 2 * day)}.jsonl`, `${dayOf(start + 3 * day)}.jsonl`]);
});

test('network-log says what hung and which probes failed over the while, in words; --json gives the records', async t => {
  const dir = state(t), log = new Log(join(dir, 'log')), now = Date.now();
  log.append({ kind: 'hang', id: 'h1', at: now - 3_600_000, seen: now - 3_597_000, process: 'git-remote-http', pid: 71758,
    command: 'git-remote-https https://github.com/x/y.git', local: '192.168.31.120:51882', remote: '20.205.243.166:443', iface: 'en0', viaTun: false, mihomo: { taken: false } });
  log.append({ kind: 'hang-end', id: 'h1', at: now - 3_525_000, outcome: 'gone' });
  log.append({ kind: 'probe', at: now - 600_000, target: 'GitHub', url: 'https://github.com', ok: true, status: 200, ms: { dns: 3, connect: 5, tls: 300, firstByte: 420, total: 420 } });
  log.append({ kind: 'probe', at: now - 60_000, target: 'GitHub', url: 'https://github.com', ok: false, phase: 'connect', error: 'ETIMEDOUT', ms: { dns: 3, total: 15000 },
    address: '20.205.243.166', iface: 'en0', viaTun: false });
  log.append({ kind: 'probe', at: now - 3 * 86_400_000, target: 'GitHub', url: 'https://github.com', ok: false, phase: 'dns', error: 'ENOTFOUND', ms: { total: 4 } });

  const said = await command(dir, '--since 2h');
  assert.equal(said.code, 0, said.stderr);
  const text = said.stdout;
  assert.match(text, /建连卡住 1 次/);
  assert.match(text, /git-remote-http（pid 71758） → 20\.205\.243\.166:443/);
  assert.match(text, /网卡 en0，没经过 mihomo；mihomo 没收到这条连接；75 秒后放弃了/);
  assert.match(text, /git-remote-https https:\/\/github\.com\/x\/y\.git/);
  assert.match(text, /GitHub（https:\/\/github\.com）：2 次，失败 1 次，最慢 15 秒/);
  assert.match(text, /建连阶段失败：ETIMEDOUT，共 15 秒（解析 3 ms），20\.205\.243\.166，网卡 en0，没经过 mihomo/);
  assert.doesNotMatch(text, /ENOTFOUND/, 'three days ago is past the while asked');
  // Every probe, the ones that went through too, each phase as long as it took.
  assert.match((await command(dir, '--probes --since 2h')).stdout, /通（200），共 420 ms（解析 3 ms，建连 2 ms，TLS 295 ms，首字节 120 ms）/);
  const lines = (await command(dir, '--json --since 2h')).stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(e => e.kind), ['hang', 'hang-end', 'probe', 'probe']);
});

test('network-log says how it is used, and why it does not run', async t => {
  const dir = state(t);
  assert.match((await command(dir, '--help')).stdout, /用法：network-log/);
  const wrong = await command(dir, '--since soon');
  assert.equal(wrong.code, 2); assert.match(wrong.stderr, /时长写成 30m、2h 或 3d/);
  const empty = await command(dir, '--hangs');
  assert.equal(empty.code, 0); assert.match(empty.stdout, /建连卡住：没有/);
});
