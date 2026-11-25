// The Magpie plugin's `coda/resource@1` record of the type「Magpie」, run as Coda runs it from its manifest, from a copy of the
// plugin whose model services point at a gateway the test stands in.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { barePath, manifest, pluginEnv } from '../command.mjs';
import { resourceRecords } from '../../helpers/resources.mjs';
import { pluginDir } from '../plugin.mjs';

// The gateway's answer to /v1/magpie/quotas, as Magpie gives it (internal/provider/quotas.go).
const quotas = [
  { provider: 'codex', name: 'Codex', kind: 'subscription', plan: 'pro', user: 'a@example.com',
    windows: [{ name: '5 hours', used: 0, remaining: 100 }, { name: '7 days', used: 37.4, remaining: 62.6, resetsAt: '2026-10-30T01:13:02+08:00' }],
    balance: '62033.82 credits', resets: { count: 2, until: '2026-10-29T18:44:32Z' } },
  { provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', plan: 'Free', user: 'leavan', alias: '我的',
    windows: [{ name: 'Credits', used: 25, remaining: 75, display: '500 / 2000', limit: 2000, unit: 'credits' }] },
  { provider: 'kimi', name: 'Kimi', kind: 'plan', windows: [{ name: 'Monthly', used: 0, remaining: 100, unlimited: true }] },
];

// The plugin, its model services moved to a gateway answering `answer` (none: nothing listens there; `hang`: it never answers, and
// the reading's 20 seconds end when the gateway has the request in hand, which a stand-in for its clock is told of, so that it
// ends with the request on its way whatever the machine is doing). Nothing of the machine is on the PATH or
// in the home directory but this Node. The record it prints, as the host takes it: `{ resources, title }` of its one record. `answer`
// may be a list, the gateway's answers to the reads in turn (the last again after), of which `reads` are made; the last one's is given.
async function record(t, answer, reads = 1) {
  const answers = [answer].flat(), sequence = { at: 0 };
  let address = '127.0.0.1:9';
  const home = mkdtempSync(join(tmpdir(), 'coda-magpie-quotas-')), gate = join(home, 'gate');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (answer) {
    const server = createServer((req, res) => {
      if (req.url !== '/v1/magpie/quotas') { res.statusCode = 404; res.end(); return; }
      const answer = answers[Math.min(sequence.at++, answers.length - 1)];
      if (answer.hang) { writeFileSync(gate, ''); return; }
      res.statusCode = answer.status ?? 200; res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    address = `127.0.0.1:${server.address().port}`;
  }
  const copy = join(home, 'plugin'), preload = join(home, 'preload.mjs');
  cpSync(pluginDir('magpie'), copy, { recursive: true });
  const changed = manifest('magpie');
  for (const provider of changed.contributes.modelProviders) provider.url = provider.url.replace('127.0.0.1:3425', address);
  writeFileSync(join(copy, 'package.json'), JSON.stringify(changed));
  // The reading's time is a signal of the test's: it ends once the gateway has noted the request (the file `gate`).
  writeFileSync(preload, `import { existsSync } from 'node:fs';
const timeout = AbortSignal.timeout, budget = new AbortController();
AbortSignal.timeout = ms => ms === 20_000 ? budget.signal : timeout.call(AbortSignal, ms);
setInterval(() => { if (existsSync(process.env.TEST_GATE)) budget.abort(new DOMException('', 'TimeoutError')); }, 10).unref();
`);
  const env = { ...pluginEnv('magpie', { CODA_NODE: process.execPath }), CODA_PLUGIN_PATH: copy, HOME: home, PATH: await barePath(home),
    ...answers.some(one => one?.hang) ? { TEST_GATE: gate, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {} };
  let records;
  for (let i = 0; i < reads; i++) records = await resourceRecords(copy, { env });
  assert.deepEqual(records.map(({ key, spec }) => [key, spec.type, spec.title]), [['quotas', 'quotas', 'Magpie']]);
  return records[0].spec.resources;
}

test('the manifest has the record command and no resource declaration, and the type has no timer', () => {
  const { contributes, engines } = manifest('magpie');
  assert.deepEqual(contributes.records.filter(one => one.kind === 'coda/resource@1'), [{ kind: 'coda/resource@1', command: 'scripts/quotas.mjs' }]);
  assert.ok(contributes.protocolImplementations.includes('coda/resource@1'));
  assert.equal(contributes.resources, undefined);
  assert.equal(engines.coda, 6);
});

test('each subscription Magpie serves is a resource: what is left of each window as the other plugins say it, its balance and resets', async t => {
  // Whose it is beside the service (its alias, else the user); no plan.
  assert.deepEqual(await record(t, { body: { object: 'list', data: quotas } }), [
    { name: 'Codex · a@example.com', values: [
      { label: '5 小时', value: '剩余 100%', fraction: 1 },
      { label: '7 天', value: '剩余 63%', fraction: 0.63, time: '2026-10-30T01:13:02+08:00' },
      { label: '余额', value: '62033.82 credits' },
      { label: '可用重置', value: '2 次' }], buttons: [] },
    { name: 'WorkBuddy · 我的', values: [{ label: 'Credits', value: '剩余 75%', fraction: 0.75 }], buttons: [] },
    { name: 'Kimi', values: [{ label: '月度', value: '不限' }], buttons: [] },
  ]);
});

test('with none, the type has nothing to show', async t => {
  assert.deepEqual(await record(t, { body: { object: 'list', data: [] } }), []);
});

test('a gateway that does not answer, cannot say, answers what is not understood or never answers fails the command with the reason, keeping the last record', async t => {
  const fails = (answer, message) => assert.rejects(record(t, answer), { message });
  await fails(null, 'Magpie 网关没有在 http://127.0.0.1:9 应答');
  await fails({ status: 500 }, 'Magpie 网关没能读出额度（HTTP 500）');
  await fails({ raw: 'not json' }, /^Magpie 网关的答复读不了：/);
  await fails({ body: {} }, 'Magpie 网关的答复读不了：没有额度列表');
  await fails({ hang: true }, '读取超时');
});

test('a subscription the gateway could not read is its row\'s error, one line, and the others are as they are: the command still ends 0', async t => {
  const failed = { ...quotas[2], error: 'the usage endpoint\nanswered 502' }, other = { provider: 'opencode-zen', name: 'OpenCode Zen', kind: 'plan', error: 'balance is not offered' };
  const [first, second, third, fourth] = await record(t, { body: { data: [quotas[0], other, quotas[1], failed] } });
  assert.deepEqual([first.name, first.error, second.name, third.name, third.error, fourth.name], ['Codex · a@example.com', undefined, 'OpenCode Zen', 'WorkBuddy · 我的', undefined, 'Kimi']);
  assert.deepEqual(second, { name: 'OpenCode Zen', values: [], buttons: [], error: 'balance is not offered' });
  assert.deepEqual(fourth, { name: 'Kimi', values: [{ label: '月度', value: '不限' }], buttons: [], error: 'the usage endpoint answered 502' });
});

test('a gateway that fails after a read that went well fails the command, with the reason', async t => {
  await assert.rejects(record(t, [{ body: { data: quotas } }, { status: 503 }], 2), { message: 'Magpie 网关没能读出额度（HTTP 503）' });
});
