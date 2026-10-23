// The Magpie plugin's panel「Magpie 额度」, run as Coda runs it from its manifest, from a copy of the plugin whose model
// services point at a gateway the test stands in.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaredPanel, manifest, pluginEnv, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const declared = declaredPanel('magpie', 'quotas');

// The gateway's answer to /v1/magpie/quotas, as Magpie gives it (internal/provider/quotas.go).
const quotas = [
  { provider: 'codex', name: 'Codex', kind: 'subscription', plan: 'pro', user: 'a@example.com',
    windows: [{ name: '7 days', used: 37.4, remaining: 62.6, resetsAt: '2026-10-30T01:13:02+08:00' }],
    balance: '62033.82 credits', resets: { count: 2, until: '2026-10-29T18:44:32Z' } },
  { provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', plan: 'Free', user: 'leavan', alias: '我的',
    windows: [{ name: 'Credits', used: 25, remaining: 75, display: '500 / 2000', limit: 2000, unit: 'credits' }] },
  { provider: 'kimi', name: 'Kimi', kind: 'plan', windows: [{ name: 'Monthly', used: 0, remaining: 100, unlimited: true }],
    error: 'the usage endpoint answered 502' },
];

// The plugin, its model services moved to a gateway answering `answer` (none: nothing listens there).
async function panel(t, answer) {
  let address = '127.0.0.1:9';
  if (answer) {
    const server = createServer((req, res) => {
      if (req.url !== '/v1/magpie/quotas') { res.statusCode = 404; res.end(); return; }
      res.statusCode = answer.status ?? 200; res.end(JSON.stringify(answer.body ?? {}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    address = `127.0.0.1:${server.address().port}`;
  }
  const home = mkdtempSync(join(tmpdir(), 'coda-magpie-quotas-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const copy = join(home, 'plugin');
  cpSync(pluginDir('magpie'), copy, { recursive: true });
  const changed = manifest('magpie');
  for (const provider of changed.contributes.modelProviders) provider.url = provider.url.replace('127.0.0.1:3425', address);
  writeFileSync(join(copy, 'package.json'), JSON.stringify(changed));
  return run(declared.command, { ...pluginEnv('magpie', { CODA_NODE: process.execPath }), CODA_PLUGIN_PATH: copy });
}

test('each subscription Magpie serves is a card: what is left of each window, its balance and resets, and why a reading failed', async t => {
  const ran = await panel(t, { body: { object: 'list', data: quotas } });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout).items, [
    { type: 'card', title: 'Codex', subtitle: 'pro · a@example.com', items: [
      { type: 'meter', label: '7 days', value: '已用 37%', fraction: 0.626, time: '2026-10-30T01:13:02+08:00', timeLabel: '重置' },
      { type: 'stat', label: '余额', value: '62033.82 credits' },
      { type: 'stat', label: '可用重置', value: '2 次' }] },
    { type: 'card', title: 'WorkBuddy', subtitle: 'Free · 我的', items: [
      { type: 'meter', label: 'Credits', value: '500 / 2000', fraction: 0.75 }] },
    { type: 'card', title: 'Kimi', items: [
      { type: 'meter', label: 'Monthly', value: '不限' },
      { type: 'error', text: 'the usage endpoint answered 502' }] },
  ]);
});

test('with none, the panel has nothing to show', async t => {
  const ran = await panel(t, { body: { object: 'list', data: [] } });
  assert.deepEqual([ran.code, JSON.parse(ran.stdout)], [0, { items: [] }]);
});

test('a gateway that does not answer, or cannot say, fails the reading with why', async t => {
  const down = await panel(t, null);
  assert.equal(down.code, 1);
  assert.match(down.stderr, /Magpie 网关没有在 http:\/\/127\.0\.0\.1:9 应答/);
  const refused = await panel(t, { status: 500 });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Magpie 网关没能读出额度（HTTP 500）/);
});
