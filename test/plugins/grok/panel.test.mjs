// From Coda's backend/test/grok.test.mjs at 9ffb9911, as plain node:test: its login and install through Coda's panels
// driven here as Coda drives the panel's `signIn` commands. How Coda reads the device code, and fails a refused login with
// its last line, stays in Coda.
// The grok plugin's「Grok」panel: who is signed in and the plan's credits, as the CLI answers them over ACP (scripts/ask.mjs,
// quota.mjs, panel.mjs); signing in and installing with the CLI's own login and installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { panelItems } from '../../../check/panel.mjs';
import { grokAsk } from '../../../plugins/grok/scripts/ask.mjs';
import { account, panel, windows } from '../../../plugins/grok/scripts/quota.mjs';
import { declaredPanel, installed, pluginEnv, run, signIn } from '../command.mjs';

const declared = declaredPanel('grok');

test('Grok credits read as its own /usage shows them: bars of what is left', () => {
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
  const { items } = panel([subscription, { firstName: null }, {}]);
  assert.deepEqual(items, [{ type: 'card', title: 'Grok', subtitle: 'SuperGrok', items: [{ type: 'error', text: '暂时无法获取额度：Grok 没有给出额度' }] }]);
  assert.deepEqual(panelItems(JSON.stringify({ items }), declared), ['card', 'error'], 'a reading Coda takes');
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
  assert.deepEqual(panel(await ask('')).items[0], { type: 'card', title: 'Lea', subtitle: 'SuperGrok', identity: 'grok:8c2a47d3bdb8d3096a6479f53eac3b72',
    items: [{ type: 'meter', label: '7 天', value: '剩余 75%', fraction: 0.75, time: '2026-10-06T11:48:35.000Z', timeLabel: '重置' }] });
  // The name is asked for once the subscription check, which may fill it in, has answered.
  assert.equal(panel(await ask('late-name')).items[0].title, 'Lea');
  assert.deepEqual(panel(await ask('out')), { items: [] });
  await assert.rejects(ask('silent', { timeoutMs: 300 }), /没有回答/);
  await assert.rejects(grokAsk(['_x.ai/billing'], { binary: null }), /找不到 Grok CLI/);
});

test('the panel shows nothing without a login file, and the login\'s card with one', async t => {
  for (const [signedIn, expected] of [[false, []], [true, ['Lea']]]) {
    const m = await machine(t, { signedIn });
    const result = await run(declared.command, pluginEnv('grok', { HOME: m.home, GROK_HOME: '' }));
    assert.equal(result.code, 0, result.stderr);
    panelItems(result.stdout, declared);
    assert.deepEqual(JSON.parse(result.stdout).items.map(c => c.title), expected);
  }
});

test('a Grok login passes on its link and code, opens no browser, and Grok is installed by its own installer, touching no shell configuration', async t => {
  const m = await machine(t, { signedIn: false });
  await writeFile(m.binary, `#!/bin/sh
echo "$@|$BROWSER|$NO_COLOR" > "${m.home}/args"
printf '\\nTo sign in, open this URL in your browser:\\n\\n  https://accounts.x.ai/oauth2/device?user_code=ABCD-EF12\\n\\n' >&2
printf 'Confirm this code in your browser:\\n\\n  \\033[1mABCD-EF12\\033[0m\\n\\nWaiting for authorization...\\n' >&2
while [ ! -e "${m.home}/confirmed" ]; do sleep 0.02; done
`, { mode: 0o755 });
  const bin = join(m.home, 'fake-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'bash'), `#!/bin/sh\nprintf '%s\\n' "$SHELL" "$PATH" "$2" > "${m.home}/installed"\n`, { mode: 0o755 });
  const env = pluginEnv('grok', { HOME: m.home, PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/zsh' });
  assert.equal(installed(declared.signIn.installed, env), true);
  const login = signIn(t, declared.signIn.command, env);
  await login.printed(/Waiting for authorization/);
  assert.match(login.output, /^ {2}https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=ABCD-EF12$/m);
  assert.equal((await readFile(join(m.home, 'args'), 'utf8')).trim(), 'login --device-auth|/usr/bin/true|1');
  await writeFile(join(m.home, 'confirmed'), '');
  assert.equal(await login.ended, 0);

  const result = await run(declared.signIn.install, env, { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr);
  const [shell, path, script] = (await readFile(join(m.home, 'installed'), 'utf8')).trimEnd().split('\n');
  assert.equal(shell, '', 'no shell configuration to update');
  assert.equal(path.split(':')[0], join(m.home, '.grok/bin'), 'nothing to link into ~/.local/bin');
  assert.equal(script, 'set -o pipefail; curl -fsSL https://x.ai/cli/install.sh | bash');
});
