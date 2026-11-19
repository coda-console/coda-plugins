// From Coda's backend/test/grok.test.mjs at 9ffb9911, as plain node:test.
// The grok plugin's「Grok」resources: who is signed in and the plan's credits, as the CLI answers them over ACP
// (scripts/ask.mjs, quota.mjs, the record command resource.mjs). Signing in and installing: sign-in.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resourceRecords, resourceRecordsProblem } from '../../../check/resources.mjs';
import { grokAsk } from '../../../plugins/grok/scripts/ask.mjs';
import { account, resources, windows } from '../../../plugins/grok/scripts/quota.mjs';
import { barePath, pluginEnv } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

test('Grok credits read as its own /usage shows them: values of what is left', () => {
  const values = config => windows({ config }).map(m => [m.label, m.value, m.time ?? null]);
  // As SuperGrok answers at the start of a week: protobuf JSON leaves the zero share out.
  assert.deepEqual(values({ currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-06T11:48:35.429865+00:00' },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true }), [['7 天', '剩余 100%', '2026-10-06T11:48:35.429Z']]);
  assert.deepEqual(values({ creditUsagePercent: 25.4, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-10-31T00:00:00Z' },
    onDemandCap: { val: 5000 }, onDemandUsed: { val: -355 } }), [['月度', '剩余 75%', '2026-10-31T00:00:00.000Z'], ['按需用量', '剩余 93%', null]]);
  // The older shape: an allowance in cents and what was used of it.
  assert.deepEqual(values({ monthlyLimit: { val: 1000 }, used: { val: 910 }, billingPeriodEnd: '2026-10-31T00:00:00Z' }), [['额度', '剩余 9%', '2026-10-31T00:00:00.000Z']]);
  // The older shape leaves on-demand spending out: it is what went past the allowance, partly or wholly.
  const older = used => values({ monthlyLimit: { val: 1000 }, used: { val: used }, onDemandCap: { val: 500 } }).map(([label, value]) => [label, value]);
  assert.deepEqual(older(1200), [['额度', '剩余 0%'], ['按需用量', '剩余 60%']]);
  assert.deepEqual(older(1500), [['额度', '剩余 0%'], ['按需用量', '剩余 0%']]);
  assert.deepEqual(older(900), [['额度', '剩余 10%'], ['按需用量', '剩余 100%']]);
  // An explicit zero (`{}`) is spent nothing, whatever the allowance says.
  assert.equal(values({ monthlyLimit: { val: 1000 }, used: { val: 1200 }, onDemandCap: { val: 500 }, onDemandUsed: {} })[1][1], '剩余 100%');
  assert.deepEqual(windows({}), []);
  // The name given to xAI and the plan, never the email; none when no one is signed in.
  const subscription = { authenticated: true, meta: { email: 'me@example.com', subscription_tier: 'SuperGrok' } };
  // The account Coda's group view compares across machines is a hash of the email, never the email.
  assert.deepEqual(account(subscription, { email: ' Me@example.com', firstName: 'Lea', lastName: null }), { name: 'Lea', plan: 'SuperGrok', id: '8c2a47d3bdb8d3096a6479f53eac3b72' });
  assert.deepEqual(account(subscription, { firstName: 'Lea' }), { name: 'Lea', plan: 'SuperGrok' });
  assert.equal(account({ authenticated: false }, {}), null);
  assert.throws(() => account({}, {}), /没有说明登录状态/, 'a passing fault is not a sign-out');
  const read = resources([subscription, { firstName: null }, {}]);
  assert.deepEqual(read.resources, [{ name: 'Grok', values: [], buttons: [], error: '暂时无法获取额度：Grok 没有给出额度' }]);
  assert.equal(resourceRecordsProblem([{ key: 'account', spec: { type: 'account', title: 'Grok', ...read } }]), null, 'a reading the host takes');
});

// A machine's home with a Grok CLI where its installer puts it, speaking ACP as the real one does. FAKE_GROK: `out` says no
// one is signed in, `silent` never answers, `late-name` fills in the name only as the subscription check answers.
async function machine(t, { signedIn = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-grok-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binary = join(home, '.grok/bin/grok');
  await mkdir(join(home, '.grok/bin'), { recursive: true });
  await writeFile(binary, `#!${process.execPath}
const mode = process.env.FAKE_GROK ?? '';
let named = mode !== 'late-name', buffer = '';
process.stdin.on('data', chunk => {
  if (mode === 'silent') return;
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\\n')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const answer = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') answer({ protocolVersion: 1 });
    else if (message.method === '_x.ai/auth/info') answer({ email: 'me@example.com', firstName: named ? 'Lea' : null, lastName: null });
    else if (message.method === '_x.ai/billing') answer({ config: { creditUsagePercent: 25, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-06T11:48:35Z' } } });
    else if (mode === 'out') answer({ authenticated: false });
    else setTimeout(() => { named = true; answer({ authenticated: true, meta: { email: 'me@example.com', subscription_tier: 'SuperGrok' } }); }, mode === 'late-name' ? 150 : 0);
  }
});
`, { mode: 0o755 });
  if (signedIn) await writeFile(join(home, '.grok/auth.json'), '{}');
  return { home, binary };
}

test('who is signed in and the credits are asked of one Grok, in order, and a CLI that does not answer fails the reading', async t => {
  const m = await machine(t);
  const ask = (mode, extra = {}) => grokAsk(['_x.ai/auth/check_subscription', '_x.ai/auth/info', '_x.ai/billing'], { binary: m.binary, env: { ...process.env, FAKE_GROK: mode }, ...extra });
  assert.deepEqual(resources(await ask('')).resources[0], { name: 'Lea', identity: 'grok:8c2a47d3bdb8d3096a6479f53eac3b72',
    values: [{ label: '7 天', value: '剩余 75%', fraction: 0.75, time: '2026-10-06T11:48:35.000Z' }], buttons: [] });
  // The name is asked for once the subscription check, which may fill it in, has answered.
  assert.equal(resources(await ask('late-name')).resources[0].name, 'Lea');
  assert.deepEqual(resources(await ask('out')), { resources: [] });
  await assert.rejects(ask('silent', { timeoutMs: 300 }), /没有回答/);
  await assert.rejects(grokAsk(['_x.ai/billing'], { binary: null }), /找不到 Grok CLI/);
});

const records = (home, extra = {}) => resourceRecords(pluginDir('grok'), { env: pluginEnv('grok', { HOME: home, GROK_HOME: '', ...extra }) });

test('the type shows nothing without a login file, and the login with one; its sign-in says whether the CLI is there, and that it can be installed', async t => {
  for (const [signedIn, expected] of [[false, []], [true, ['Lea']]]) {
    const m = await machine(t, { signedIn });
    const [record] = await records(m.home);
    assert.deepEqual([record.key, record.spec.type, record.spec.title], ['account', 'account', 'Grok']);
    assert.deepEqual(record.spec.resources.map(r => r.name), expected);
    assert.deepEqual(record.spec.signIn, { installed: true, installable: true, note: record.spec.signIn.note });
  }
});

test('a login that cannot be read or a CLI that is not there is one row saying so, and the sign-in is still in the record', async t => {
  // No CLI: the sign-in is the way to get it.
  const gone = await machine(t);
  await rm(gone.binary);
  const [none] = await records(gone.home, { PATH: await barePath(join(gone.home, 'bare')) });
  assert.deepEqual(none.spec.resources, [{ name: 'Grok', values: [], buttons: [], error: '暂时无法读取 Grok：这台机器上找不到 Grok CLI' }]);
  assert.equal(none.spec.signIn.installed, false);
  // A login file that cannot even be looked at.
  const odd = await machine(t, { signedIn: false });
  await writeFile(join(odd.home, 'file'), '');
  const [unreadable] = await records(odd.home, { GROK_HOME: join(odd.home, 'file') });
  assert.deepEqual(unreadable.spec.resources, [{ name: 'Grok', values: [], buttons: [], error: '读不了 Grok 的登录：ENOTDIR' }]);
  assert.equal(unreadable.spec.signIn.installed, true);
});
