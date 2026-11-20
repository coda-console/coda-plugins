// From Coda's backend/test/codex-panel.test.mjs at 9ffb9911, as plain node:test.
// The codex plugin's「Codex」resources: this machine's own Codex login, as Codex's app-server says (scripts/quota.mjs, the record
// command resource.mjs), its full reset (`act`, scripts/act.mjs), and signing in (`sign-in`, scripts/sign-in.mjs, with
// scripts/cli.mjs), all run as Coda runs them, with the plugin's own Codex CLI; a `coda` stands in for Coda's own where the
// sign-in reports to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceRecords, resourceRecordsProblem } from '@coda-console/plugin-check/resources';
import { resources } from '../../../plugins/codex/scripts/quota.mjs';
import { endWait, fakeCoda, manifest, operation, pluginEnv, probed } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { substituted } from '../substitute.mjs';

// What the host finds wrong in a reading as the record of the type, or null.
const problem = value => resourceRecordsProblem([{ key: 'login', spec: { type: 'login', title: 'Codex', ...value } }]);

async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coda-codex-panel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// What the app-server answers, by method; a function answers from the request's params, an Error is refused.
const server = answers => ({ asked: [], async request(method, params) {
  this.asked.push([method, params]);
  const answer = answers[method];
  if (answer instanceof Error) throw answer;
  return typeof answer === 'function' ? answer(params) : answer;
} });
const signedIn = { account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' }, workspaceRouting: { chatgptAccountId: 'ws-personal' }, requiresOpenaiAuth: true };
// 2026-10-20 01:00 and 2026-11-02 01:00 UTC.
const [early, late] = [Date.UTC(2026, 9, 20, 1) / 1000, Date.UTC(2026, 10, 2, 1) / 1000];
const limits = { rateLimits: { primary: { usedPercent: 36, windowDurationMins: 300, resetsAt: early }, secondary: { usedPercent: null, windowDurationMins: 10080 } },
  rateLimitResetCredits: { availableCount: 3, credits: [
    { id: 'later', status: 'available', resetType: 'codexRateLimits', expiresAt: late, grantedAt: 0 },
    { id: 'used', status: 'redeemed', resetType: 'codexRateLimits', expiresAt: early - 60, grantedAt: 0 },
    { id: 'first', status: 'available', resetType: 'codexRateLimits', expiresAt: early, grantedAt: 0 },
    { id: 'never', status: 'available', resetType: 'codexRateLimits', expiresAt: null, grantedAt: 0 },
  ] } };

test('the Codex resource is the login with what is left, and offers the full reset that expires first, named in its question', async () => {
  const read = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': limits }));
  // Who signed in and in which workspace, as a hash, which Coda's group view compares across machines; no plan beside it.
  assert.deepEqual(read.resources, [{ name: 'me@example.com', identity: 'codex:4f8c8f70fdb1a82f325caca6fccb78690831f66027018f748a0c7141a6d929a3', values: [
    { label: '5 小时', value: '剩余 64%', fraction: 0.64, time: new Date(early * 1000).toISOString() },
    // Unknown stays unknown: no bar, never a zero.
    { label: '7 天', value: '—' },
    // The resets left, timed by the one to expire first.
    { label: '完全重置', value: '剩余 3 次', time: new Date(early * 1000).toISOString() },
  ], buttons: [{ label: '使用完全重置', action: 'reset', args: { creditId: 'first' },
    confirm: '使用 me@example.com 的完全重置？\n用最早到期的那一次（<t:2026-10-20T01:00:00.000Z> 到期）。成功后消耗 1 次，无法撤销。' }] }]);
  assert.equal(problem(read), null, 'a reading the host takes');
});

test('one email in two workspaces is two identities, each with its own quota; a login whose workspace is not said names none', async () => {
  const left = used => ({ rateLimits: { primary: { usedPercent: used, windowDurationMins: 300 } } });
  const personal = (await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': left(10) }))).resources[0];
  const business = (await resources(server({ 'account/read': { ...signedIn, workspaceRouting: { chatgptAccountId: 'ws-business' } }, 'account/rateLimits/read': left(90) }))).resources[0];
  assert.equal(personal.name, business.name);
  assert.notEqual(personal.identity, business.identity);
  // Two members of one workspace are two people, each with their own quota.
  const colleague = (await resources(server({ 'account/read': { ...signedIn, account: { ...signedIn.account, email: 'colleague@example.com' } }, 'account/rateLimits/read': left(90) }))).resources[0];
  assert.notEqual(personal.identity, colleague.identity);
  const unsaid = (await resources(server({ 'account/read': { account: signedIn.account }, 'account/rateLimits/read': left(10) }))).resources[0];
  assert.equal(unsaid.identity, undefined);
});

test('the Codex resources are none without a login, and say so when the quota cannot be read or there is none to read', async () => {
  const empty = server({ 'account/read': { account: null, requiresOpenaiAuth: true } });
  assert.deepEqual(await resources(empty), { resources: [] });
  assert.deepEqual(empty.asked.map(([m]) => m), ['account/read'], 'no quota asked of no one');
  assert.deepEqual(await resources(server({ 'account/read': { account: { type: 'apiKey' } } })), { resources: [{ name: '本机登录', values: [{ value: '不是 ChatGPT 登录，没有额度' }], buttons: [] }] });
  // A login Codex says is no good is a row, so its「重新登录」 stays; any other failure to read the quota throws.
  const refused = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': new Error('401 Unauthorized') }));
  assert.equal(refused.resources[0].error, '登录已失效，请重新登录：401 Unauthorized');
  assert.ok(refused.resources[0].identity, 'the account stays the one it was');
  for (const message of ['503 Service Unavailable', 'Codex 没有答复', 'failed to fetch codex rate limits: connection reset'])
    await assert.rejects(resources(server({ 'account/read': signedIn, 'account/rateLimits/read': new Error(message) })), { message });
  // A count without the credits listed offers no button: which one would be used is not known.
  const unlisted = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': { rateLimitResetCredits: { availableCount: 2, credits: null } } }));
  assert.deepEqual([unlisted.resources[0].values, unlisted.resources[0].buttons], [[{ label: '完全重置', value: '剩余 2 次' }], []]);
  // No quota at all is a reading that failed, not a row that would replace the quota shown; the resets alone are kept.
  await assert.rejects(resources(server({ 'account/read': signedIn, 'account/rateLimits/read': {} })), { message: '暂时无法获取额度：Codex 没有给出额度窗口' });
  const resetsOnly = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': { rateLimitResetCredits: { availableCount: 0, credits: [] } } }));
  assert.deepEqual([resetsOnly.resources[0].values, resetsOnly.resources[0].error], [[{ label: '完全重置', value: '剩余 0 次' }], undefined]);
  // However many limits Codex has, a resource holds 8 values, the resets left last; several limits are told apart by name.
  const many = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': {
    rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}`, { limitName: `L${i}`, primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: 0, windowDurationMins: 10080 } }])),
    rateLimitResetCredits: { availableCount: 30, credits: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, status: 'available', resetType: 'codexRateLimits', expiresAt: early + i, grantedAt: 0 })) } } }));
  const values = many.resources[0].values;
  assert.deepEqual([values.length, values[0].label, values.at(-1).label], [8, 'L0 · 5 小时', '完全重置']);
  assert.equal(problem(many), null, 'a reading the host takes');
});

// A Codex CLI standing in for the plugin's own: its app-server answers from FAKE_ANSWERS and notes what it was asked, and in
// which home.
async function cli(dir) {
  const script = join(dir, 'codex.mjs'), log = join(dir, 'asked.jsonl');
  await writeFile(script, `import { appendFileSync } from 'node:fs';
const answers = JSON.parse(process.env.FAKE_ANSWERS ?? '{}');
let buffer = '';
process.stdin.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
  const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, method: m.method, params: m.params }) + '\\n');
  if (m.id === undefined) continue;
  const answer = answers[m.method];
  process.stdout.write(JSON.stringify(answer?.error ? { id: m.id, error: answer.error } : { id: m.id, result: answer ?? {} }) + '\\n');
} });`);
  return { script, asked: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('the record and the full reset run the plugin\'s Codex CLI in the machine\'s own home, and redeem exactly the credit named', async t => {
  const dir = await root(t), { script, asked } = await cli(dir);
  const env = (answers, extra = {}) => pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir, FAKE_ANSWERS: JSON.stringify(answers), ...extra });
  const reset = (answers, args, action = 'reset') => operation(t, 'codex', 'scripts/act.mjs', env(answers), { action, args });
  const [read] = await resourceRecords(pluginDir('codex'), { env: env({ 'account/read': signedIn, 'account/rateLimits/read': limits }) });
  assert.deepEqual([read.key, read.spec.type, read.spec.title], ['login', 'login', 'Codex']);
  assert.deepEqual(read.spec.signIn, { installed: true, installable: false, note: '接入账号插件后，登录会添加或更新插件管理的账号。' });
  assert.deepEqual(read.spec.resources[0].buttons.map(b => [b.action, b.args]), [['reset', { creditId: 'first' }]]);
  const reads = await asked();
  assert.deepEqual(reads.map(a => a.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.ok(reads.every(a => a.home === dir && a.args.join(' ') === 'app-server'));

  const done = reset({ 'account/rateLimitResetCredit/consume': { outcome: 'reset' } }, { creditId: 'first' });
  assert.equal(await done.ended, 0, done.stderr);
  assert.equal(done.stdout, '{}\n');
  const consumed = (await asked()).filter(a => a.method === 'account/rateLimitResetCredit/consume');
  assert.equal(consumed.length, 1); assert.equal(consumed[0].params.creditId, 'first'); assert.match(consumed[0].params.idempotencyKey, /^[0-9a-f-]{36}$/);
  // Anything but a reset fails the action in one line its row shows; without a credit named, or for an action it has not, Codex is not asked at all.
  const spent = reset({ 'account/rateLimitResetCredit/consume': { outcome: 'noCredit' } }, { creditId: 'first' });
  assert.deepEqual([await spent.ended, spent.stderr.trim()], [1, '这次重置已不可用']);
  const unnamed = reset({}, {});
  assert.deepEqual([await unnamed.ended, unnamed.stderr.trim()], [1, '没有指明用哪一次完全重置']);
  const unknown = reset({}, {}, 'launch');
  assert.deepEqual([await unknown.ended, unknown.stderr.trim()], [1, '不认识的动作：launch']);
  assert.equal((await asked()).filter(a => a.method === 'account/rateLimitResetCredit/consume').length, 2);
});

// Codex 0.159.2's captured CLI layout, with the temporary one-time code replaced.
const codeOutput = '\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n'
  + '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n'
  + '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-12345\x1b[0m\n\n';

// The production arguments, with the CLI replaced by a controlled login that prints as Codex does, in pieces, and ends
// once `confirmed` is there (or at once, saying why, when FAKE_REFUSE says it; or saying nothing of a link, and 0 when ended,
// when FAKE_SILENT says it). `command`: the operation's file, as the manifest names it.
async function login(t, extra = {}, command = 'scripts/sign-in.mjs') {
  const dir = await root(t), script = join(dir, 'codex.mjs');
  await writeFile(script, `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.CODEX_HOME, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, color: process.env.NO_COLOR }));
const output = ${JSON.stringify(codeOutput)}, splitAt = output.indexOf('12345') + 4;
let printed = false;
if (process.env.FAKE_SILENT) { console.error('Contacting OpenAI...'); process.on('SIGTERM', () => { console.error('登录已取消'); process.exit(0); }); setInterval(() => {}, 1000); }
else process.stderr.write(output.slice(0, splitAt), () => setImmediate(() => {
  process.stderr.write(output.slice(splitAt)); printed = true;
  if (process.env.FAKE_REFUSE) { console.error(process.env.FAKE_REFUSE); process.exit(1); }
}));
setInterval(() => {
  if (printed && existsSync(join(process.env.CODEX_HOME, 'confirmed'))) process.exit(0);
}, 10);`);
  // A silent login's wait for its link ends when the test says, once the login has read what the CLI said (not by the clock); one
  // whose report fails fails only after the login has dealt with the exit of its CLI.
  const watch = { ack: join(dir, 'ack'), gate: join(dir, 'gate') };
  const env = pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir, ...extra, ...(extra.FAKE_CODA_AFTER_EXIT ? { FAKE_CODA_AFTER_EXIT: watch.ack } : {}) });
  const coda = await fakeCoda(dir, extra.FAKE_SILENT || extra.FAKE_CODA_AFTER_EXIT ? probed(env, watch) : env);
  return { dir, coda, run: operation(t, 'codex', command, coda.env), endWait: () => endWait(watch, 'Contacting OpenAI...') };
}
const reported = async coda => { for (let i = 0; i < 1000; i++) { const calls = await coda.calls(); if (calls.length) return calls; await delay(10); } throw new Error('没等到登录报告'); };

test('the Codex type signs in with the plugin\'s CLI\'s device code, uncoloured, in the machine\'s own home, and reports it whole', async t => {
  const { dir, coda, run } = await login(t);
  assert.deepEqual(await reported(coda), [{ command: 'progress', input: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' } }]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'invocation.json'), 'utf8')), { args: ['login', '--device-auth'], home: dir, color: '1' });
  await writeFile(join(dir, 'confirmed'), '');
  assert.equal(await run.ended, 0, run.stderr);
  assert.equal(run.stdout, '{}\n');
  assert.equal((await coda.calls()).length, 1, 'once');
});

test('a login Codex ends without confirmation fails with the last line Codex said', async t => {
  const { run } = await login(t, { FAKE_REFUSE: 'Error logging in with device code: access_denied' });
  assert.equal(await run.ended, 1);
  assert.equal(run.stderr.trim(), 'Error logging in with device code: access_denied');
  assert.equal(run.stdout, '');
});

test('a login that prints no link in time is given up on with what Codex said then, not what it says when ended, even when it ends 0', async t => {
  const { run, coda, endWait } = await login(t, { FAKE_SILENT: '1' });
  await endWait();
  assert.equal(await run.ended, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.trim(), 'Contacting OpenAI...');
  assert.deepEqual(await coda.calls(), []);
});

test('the report of the link is waited for before the login is settled, and one that fails fails the login, the confirmed or not', async t => {
  const { dir, coda, run } = await login(t, { FAKE_CODA_FAIL: 'progress', FAKE_CODA_AFTER_EXIT: '1' });
  // Confirmed (the CLI ends 0 once it has printed all); the report of the link fails only once the login has dealt with that.
  await writeFile(join(dir, 'confirmed'), '');
  assert.equal(await run.ended, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.trim(), 'coda progress 没有成功');
  assert.deepEqual(await coda.calls(), []);
});

test('a reading that fails for any other reason, after one that went well, fails the command with the reason: the record Coda has stays', async t => {
  const dir = await root(t), { script } = await cli(dir);
  const env = answers => pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir, FAKE_ANSWERS: JSON.stringify(answers) });
  assert.equal((await resourceRecords(pluginDir('codex'), { env: env({ 'account/read': signedIn, 'account/rateLimits/read': limits }) }))[0].spec.resources[0].values.length > 0, true);
  await assert.rejects(resourceRecords(pluginDir('codex'), { env: env({ 'account/read': signedIn, 'account/rateLimits/read': { error: { code: -32000, message: 'failed to fetch codex rate limits: 503 Service Unavailable' } } }) }),
    { message: 'failed to fetch codex rate limits: 503 Service Unavailable' });
  await assert.rejects(resourceRecords(pluginDir('codex'), { env: env({ 'account/read': signedIn, 'account/rateLimits/read': {} }) }), { message: '暂时无法获取额度：Codex 没有给出额度窗口' });
  await assert.rejects(resourceRecords(pluginDir('codex'), { env: env({ 'account/read': { error: { code: -32000, message: 'something broke' } } }) }), { message: 'something broke' });
});

test('Codex saying its login cannot be read still writes the record: one row saying so, and the sign-in, entered from that record', async t => {
  const dir = await root(t), { script } = await cli(dir);
  const answers = { 'account/read': { error: { code: -32000, message: 'failed to load auth.json: expected value at line 1' } } };
  const [record] = await resourceRecords(pluginDir('codex'), { env: pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir, FAKE_ANSWERS: JSON.stringify(answers) }) });
  assert.deepEqual(record.spec.resources, [{ name: '本机登录', values: [], buttons: [], error: '登录已失效，请重新登录：failed to load auth.json: expected value at line 1' }]);
  assert.equal(record.spec.signIn.installed, true);
  const command = manifest('codex').contributes.protocolImplementations.find(one => one.kind === 'coda/resource@1').commands['sign-in'];
  const { dir: home, coda, run } = await login(t, {}, command);
  await reported(coda);
  await writeFile(join(home, 'confirmed'), '');
  assert.equal(await run.ended, 0, run.stderr);
});
