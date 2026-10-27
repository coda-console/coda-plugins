// From Coda's backend/test/codex-panel.test.mjs at 9ffb9911, as plain node:test: its login through Coda's panels driven here
// as Coda drives the panel's `signIn` command. How Coda reads the device code from what it prints stays in Coda.
// The codex plugin's「Codex」panel: this machine's own Codex login, as Codex's app-server says (scripts/quota.mjs, panel.mjs),
// its full reset (scripts/reset.mjs), and signing in (scripts/cli.mjs), all with the plugin's own Codex CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { panelItems } from '../../../check/panel.mjs';
import { panel } from '../../../plugins/codex/scripts/quota.mjs';
import { declaredPanel, pluginEnv, run, signIn } from '../command.mjs';
import { substituted } from '../substitute.mjs';

const declared = declaredPanel('codex', 'login');
// What Coda takes of a reading: the item types, or a throw.
const takes = value => panelItems(JSON.stringify(value), declared);

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

test('the Codex panel shows the login with what is left, and offers the full reset that expires first, named in its question', async () => {
  const { items } = await panel(server({ 'account/read': signedIn, 'account/rateLimits/read': limits }));
  // Who signed in and in which workspace, as a hash, which Coda's group view compares across machines.
  assert.deepEqual(items, [{ type: 'card', title: 'me@example.com', subtitle: 'pro', identity: 'codex:4f8c8f70fdb1a82f325caca6fccb78690831f66027018f748a0c7141a6d929a3', items: [
    { type: 'button', label: '使用完全重置', action: 'reset', args: { creditId: 'first' },
      confirm: '使用 me@example.com 的完全重置？\n用最早到期的那一次（<t:2026-10-20T01:00:00.000Z> 到期）。成功后消耗 1 次，无法撤销。' },
    { type: 'meter', label: '5 小时', value: '剩余 64%', fraction: 0.64, time: new Date(early * 1000).toISOString(), timeLabel: '重置' },
    // Unknown stays unknown: no bar, never a zero.
    { type: 'meter', label: '7 天' },
    { type: 'stat', label: '完全重置', value: '剩余 3 次' },
    { type: 'stat', label: '第 1 次', value: '<t:2026-10-20T01:00:00.000Z> 到期' },
    { type: 'stat', label: '第 2 次', value: '<t:2026-11-02T01:00:00.000Z> 到期' },
    { type: 'stat', label: '第 3 次', value: '不会过期' },
  ] }]);
  assert.deepEqual(takes({ items }), ['card', 'button', 'meter', 'meter', 'stat', 'stat', 'stat', 'stat'], 'a reading Coda takes');
});

test('one email in two workspaces is two identities, each with its own quota; a login whose workspace is not said names none', async () => {
  const left = used => ({ rateLimits: { primary: { usedPercent: used, windowDurationMins: 300 } } });
  const personal = (await panel(server({ 'account/read': signedIn, 'account/rateLimits/read': left(10) }))).items[0];
  const business = (await panel(server({ 'account/read': { ...signedIn, workspaceRouting: { chatgptAccountId: 'ws-business' } }, 'account/rateLimits/read': left(90) }))).items[0];
  assert.equal(personal.title, business.title);
  assert.notEqual(personal.identity, business.identity);
  // Two members of one workspace are two people, each with their own quota.
  const colleague = (await panel(server({ 'account/read': { ...signedIn, account: { ...signedIn.account, email: 'colleague@example.com' } }, 'account/rateLimits/read': left(90) }))).items[0];
  assert.notEqual(personal.identity, colleague.identity);
  const unsaid = (await panel(server({ 'account/read': { account: signedIn.account }, 'account/rateLimits/read': left(10) }))).items[0];
  assert.equal(unsaid.identity, undefined);
});

test('the Codex panel is empty without a login, and says so when the quota cannot be read or there is none to read', async () => {
  const empty = server({ 'account/read': { account: null, requiresOpenaiAuth: true } });
  assert.deepEqual(await panel(empty), { items: [] });
  assert.deepEqual(empty.asked.map(([m]) => m), ['account/read'], 'no quota asked of no one');
  assert.deepEqual(await panel(server({ 'account/read': { account: { type: 'apiKey' } } })), { items: [{ type: 'card', title: '本机登录', subtitle: 'apiKey',
    items: [{ type: 'markdown', text: '不是用 ChatGPT 账号登录的，没有额度可显示' }] }] });
  // The card stays, so its「重新登录」 does.
  const refused = await panel(server({ 'account/read': signedIn, 'account/rateLimits/read': new Error('401 Unauthorized') }));
  assert.deepEqual(refused.items[0].items, [{ type: 'error', text: '暂时无法获取额度：401 Unauthorized' }]);
  // A count without the credits listed offers no button: which one would be used is not known.
  const unlisted = await panel(server({ 'account/read': signedIn, 'account/rateLimits/read': { rateLimitResetCredits: { availableCount: 2, credits: null } } }));
  assert.deepEqual(unlisted.items[0].items, [{ type: 'stat', label: '完全重置', value: '剩余 2 次' }]);
  const none = await panel(server({ 'account/read': signedIn, 'account/rateLimits/read': {} }));
  assert.deepEqual(none.items[0].items, [{ type: 'error', text: '暂时无法获取额度：Codex 没有给出额度窗口' }]);
  // However many limits and credits Codex has, the card holds 20 items; several limits are told apart by name.
  const many = await panel(server({ 'account/read': signedIn, 'account/rateLimits/read': {
    rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`l${i}`, { limitName: `L${i}`, primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: 0, windowDurationMins: 10080 } }])),
    rateLimitResetCredits: { availableCount: 30, credits: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, status: 'available', resetType: 'codexRateLimits', expiresAt: early + i, grantedAt: 0 })) } } }));
  assert.equal(many.items[0].items.length, 20); assert.equal(many.items[0].items[1].label, 'L0 · 5 小时');
  assert.equal(takes(many).length, 21, 'a reading Coda takes');
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

test('the panel and its full reset run the plugin\'s Codex CLI in the machine\'s own home, and redeem exactly the credit named', async t => {
  const dir = await root(t), { script, asked } = await cli(dir);
  const exec = (command, answers, extra = {}) => run(command,
    pluginEnv('codex', { ...substituted({ '@openai/codex/bin/codex.js': script }), CODEX_HOME: dir, FAKE_ANSWERS: JSON.stringify(answers), ...extra }));
  const read = await exec(declared.command, { 'account/read': signedIn, 'account/rateLimits/read': limits });
  assert.equal(read.code, 0, read.stderr);
  const shown = JSON.parse(read.stdout);
  takes(shown);
  assert.deepEqual(shown.items[0].items[0].args, { creditId: 'first' });
  const reads = await asked();
  assert.deepEqual(reads.map(a => a.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.ok(reads.every(a => a.home === dir && a.args.join(' ') === 'app-server'));

  const reset = declared.actions.reset.command;
  const done = await exec(reset, { 'account/rateLimitResetCredit/consume': { outcome: 'reset' } }, { CODA_PANEL_ARGS: JSON.stringify({ creditId: 'first' }) });
  assert.equal(done.code, 0, done.stderr);
  const consumed = (await asked()).filter(a => a.method === 'account/rateLimitResetCredit/consume');
  assert.equal(consumed.length, 1); assert.equal(consumed[0].params.creditId, 'first'); assert.match(consumed[0].params.idempotencyKey, /^[0-9a-f-]{36}$/);
  // Anything but a reset fails the action in one line the panel shows; without a credit named, Codex is not asked at all.
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

test('the Codex panel signs in with the plugin\'s CLI\'s device code, uncoloured, in the machine\'s own home', async t => {
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
