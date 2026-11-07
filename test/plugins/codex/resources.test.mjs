// From Coda's backend/test/codex-panel.test.mjs at 9ffb9911, as plain node:test: its login through Coda's resources driven
// here as Coda drives the type's `signIn` command. How Coda reads the device code from what it prints stays in Coda.
// The codex plugin's「Codex」resources: this machine's own Codex login, as Codex's app-server says (scripts/quota.mjs, resources.mjs),
// its full reset (scripts/reset.mjs), and signing in (scripts/cli.mjs), all with the plugin's own Codex CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readResources } from '../../../check/panel.mjs';
import { resources } from '../../../plugins/codex/scripts/quota.mjs';
import { declaredPanel, pluginEnv, run, signIn } from '../command.mjs';
import { substituted } from '../substitute.mjs';

const declared = declaredPanel('codex', 'login');
// What Coda takes of a reading: its resources, or a throw.
const takes = value => readResources(JSON.stringify(value), declared);

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
  ], actions: [{ label: '使用完全重置', action: 'reset', args: { creditId: 'first' },
    confirm: '使用 me@example.com 的完全重置？\n用最早到期的那一次（<t:2026-10-20T01:00:00.000Z> 到期）。成功后消耗 1 次，无法撤销。' }] }]);
  assert.deepEqual(takes(read), read.resources, 'a reading Coda takes');
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
  assert.deepEqual(await resources(server({ 'account/read': { account: { type: 'apiKey' } } })), { resources: [{ name: '本机登录', values: [{ value: '不是 ChatGPT 登录，没有额度' }] }] });
  // The row stays, so its「重新登录」 does.
  const refused = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': new Error('401 Unauthorized') }));
  assert.equal(refused.resources[0].error, '暂时无法获取额度：401 Unauthorized');
  // A count without the credits listed offers no button: which one would be used is not known.
  const unlisted = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': { rateLimitResetCredits: { availableCount: 2, credits: null } } }));
  assert.deepEqual([unlisted.resources[0].values, unlisted.resources[0].actions], [[{ label: '完全重置', value: '剩余 2 次' }], undefined]);
  const none = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': {} }));
  assert.deepEqual([none.resources[0].values, none.resources[0].error], [[], '暂时无法获取额度：Codex 没有给出额度窗口']);
  // However many limits Codex has, a resource holds 8 values, the resets left last; several limits are told apart by name.
  const many = await resources(server({ 'account/read': signedIn, 'account/rateLimits/read': {
    rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}`, { limitName: `L${i}`, primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: 0, windowDurationMins: 10080 } }])),
    rateLimitResetCredits: { availableCount: 30, credits: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, status: 'available', resetType: 'codexRateLimits', expiresAt: early + i, grantedAt: 0 })) } } }));
  const values = many.resources[0].values;
  assert.deepEqual([values.length, values[0].label, values.at(-1).label], [8, 'L0 · 5 小时', '完全重置']);
  assert.equal(takes(many).length, 1, 'a reading Coda takes');
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

test('the resources and their full reset run the plugin\'s Codex CLI in the machine\'s own home, and redeem exactly the credit named', async t => {
  const dir = await root(t), { script, asked } = await cli(dir);
  const exec = (command, answers, extra = {}) => run(command,
    pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir, FAKE_ANSWERS: JSON.stringify(answers), ...extra }));
  const read = await exec(declared.command, { 'account/read': signedIn, 'account/rateLimits/read': limits });
  assert.equal(read.code, 0, read.stderr);
  const shown = JSON.parse(read.stdout);
  takes(shown);
  assert.deepEqual(shown.resources[0].actions[0].args, { creditId: 'first' });
  const reads = await asked();
  assert.deepEqual(reads.map(a => a.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.ok(reads.every(a => a.home === dir && a.args.join(' ') === 'app-server'));

  const reset = declared.actions.reset.command;
  const done = await exec(reset, { 'account/rateLimitResetCredit/consume': { outcome: 'reset' } }, { CODA_PANEL_ARGS: JSON.stringify({ creditId: 'first' }) });
  assert.equal(done.code, 0, done.stderr);
  const consumed = (await asked()).filter(a => a.method === 'account/rateLimitResetCredit/consume');
  assert.equal(consumed.length, 1); assert.equal(consumed[0].params.creditId, 'first'); assert.match(consumed[0].params.idempotencyKey, /^[0-9a-f-]{36}$/);
  // Anything but a reset fails the action in one line its row shows; without a credit named, Codex is not asked at all.
  const spent = await exec(reset, { 'account/rateLimitResetCredit/consume': { outcome: 'noCredit' } }, { CODA_PANEL_ARGS: JSON.stringify({ creditId: 'first' }) });
  assert.deepEqual([spent.code, spent.stderr.trim()], [1, '这次重置已不可用']);
  const unnamed = await exec(reset, {}, { CODA_PANEL_ARGS: '{}' });
  assert.deepEqual([unnamed.code, unnamed.stderr.trim()], [1, '没有指明用哪一次完全重置']);
  assert.equal((await asked()).filter(a => a.method === 'account/rateLimitResetCredit/consume').length, 2);
  // Codex refusing the reading itself fails it, which keeps the last one shown.
  const refused = await exec(declared.command, { 'account/read': { error: { code: -32000, message: 'auth broken' } } });
  assert.deepEqual([refused.code, refused.stderr.trim()], [1, 'auth broken']);
});

// Codex 0.159.2's captured CLI layout, with the temporary one-time code replaced.
const codeOutput = '\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n'
  + '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n'
  + '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-12345\x1b[0m\n\n';

test('the Codex type signs in with the plugin\'s CLI\'s device code, uncoloured, in the machine\'s own home', async t => {
  const dir = await root(t), script = join(dir, 'codex.mjs');
  // The production arguments, with the CLI replaced by a controlled login that prints as Codex does, in pieces.
  await writeFile(script, `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.CODEX_HOME, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, color: process.env.NO_COLOR }));
const output = ${JSON.stringify(codeOutput)}, splitAt = output.indexOf('12345') + 4;
process.stderr.write(output.slice(0, splitAt));
setTimeout(() => process.stderr.write(output.slice(splitAt)), 30);
setInterval(() => { if (existsSync(join(process.env.CODEX_HOME, 'confirmed'))) process.exit(0); }, 10);`);
  assert.equal(declared.signIn.installed, undefined, 'the CLI comes with the plugin');
  const login = signIn(t, declared.signIn.command, pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir }));
  await login.printed(/ABCD-12345\x1b\[0m\n/);
  assert.equal(login.output, codeOutput, 'what Codex prints, passed on whole');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'invocation.json'), 'utf8')), { args: ['login', '--device-auth'], home: dir, color: '1' });
  await writeFile(join(dir, 'confirmed'), '');
  assert.equal(await login.ended, 0);
});
