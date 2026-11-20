#!/usr/bin/env node
// The actions of the buttons on the「Codex」resources of the managed accounts (the `act` operation of `coda/resource@1`),
// `{ action, args }` on standard input. Anything that fails is said in one line, so the row shows it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withAccount } from './codex.mjs';
import { choose, remove, tokens, withManagedAccount } from './manager.mjs';
import { outcomes } from './quota.mjs';

// The「切换使用」button checks the owned account before saving the choice. Sessions take it at their next boundary.
async function select({ account }) {
  try {
    if (typeof account !== 'string' || !account) throw new Error('没有指明切换到哪个账号');
    await withAccount(await tokens(account), async () => {});
    await choose(account);
  } catch (error) { throw new Error(`切换失败：${error.message}`); }
}

// The「使用完全重置」button of a managed account: redeems exactly the credit its button named, once.
async function reset({ account, creditId }) {
  if (typeof account !== 'string' || !account || typeof creditId !== 'string' || !creditId) throw new Error('没有指明用哪个账号的哪一次完全重置');
  let outcome;
  try {
    ({ outcome } = await withManagedAccount(account, server => server.request('account/rateLimitResetCredit/consume', { creditId, idempotencyKey: randomUUID() })));
  } catch (error) { throw new Error(`使用结果未确认，请核对剩余次数：${error.message}`); }
  if (outcome !== 'reset') throw new Error(outcomes[outcome] ?? '使用结果未确认，请核对剩余次数');
}

const actions = { select, reset, remove: ({ account }) => remove(account) };
const { action, args } = JSON.parse(readFileSync(0, 'utf8'));
try {
  if (!Object.hasOwn(actions, action)) throw new Error(`不认识的动作：${action}`);
  await actions[action](args);
  console.log('{}');
} catch (error) { console.error(error.message); process.exitCode = 1; }
