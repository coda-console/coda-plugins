#!/usr/bin/env node
// The actions of the buttons on the「Codex」resources (the `act` operation of `coda/resource@1`), `{ action, args }` on standard
// input: a full reset of this machine's own login, or with「多账号」on (the setting `codex.multipleAccounts`), switching to, a full
// reset of and removing a managed account. Anything but what is asked for is said in one line and fails the action, so its row
// shows it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withAppServer } from './app-server.mjs';
import { withAccount } from './codex.mjs';
import { choose, multipleAccounts, remove, tokens, withManagedAccount } from './manager.mjs';
import { outcomes } from './quota.mjs';

// Redeems exactly the credit its button named (without one Codex would pick for itself), once, with the app-server `withServer`
// runs it against.
async function redeem(withServer, creditId) {
  let outcome;
  try { ({ outcome } = await withServer(server => server.request('account/rateLimitResetCredit/consume', { creditId, idempotencyKey: randomUUID() }))); }
  catch (error) { throw new Error(`使用结果未确认，请核对剩余次数：${error.message}`); }
  if (outcome !== 'reset') throw new Error(outcomes[outcome] ?? '使用结果未确认，请核对剩余次数');
}

// The「使用完全重置」button of this machine's own login. One that names a managed account is a row left from「多账号」on: its
// credit is that account's, never to be redeemed with this login.
async function reset({ account, creditId }) {
  if (account !== undefined) throw new Error('多账号已关闭，这个账号的操作不可用');
  if (typeof creditId !== 'string' || !creditId) throw new Error('没有指明用哪一次完全重置');
  await redeem(withAppServer, creditId);
}

// The「切换使用」button checks the managed account before saving the choice. Sessions take it at their next boundary.
async function select({ account }) {
  try {
    if (typeof account !== 'string' || !account) throw new Error('没有指明切换到哪个账号');
    await withAccount(await tokens(account), async () => {});
    await choose(account);
  } catch (error) { throw new Error(`切换失败：${error.message}`); }
}

// The「使用完全重置」button of a managed account.
async function resetManaged({ account, creditId }) {
  if (typeof account !== 'string' || !account || typeof creditId !== 'string' || !creditId) throw new Error('没有指明用哪个账号的哪一次完全重置');
  await redeem(work => withManagedAccount(account, work), creditId);
}

const actions = multipleAccounts() ? { select, reset: resetManaged, remove: ({ account }) => remove(account) } : { reset };
const { action, args } = JSON.parse(readFileSync(0, 'utf8'));
try {
  if (!Object.hasOwn(actions, action)) throw new Error(`不认识的动作：${action}`);
  await actions[action](args);
  console.log('{}');
} catch (error) { console.error(error.message); process.exitCode = 1; }
