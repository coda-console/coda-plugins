#!/usr/bin/env node
// The actions of the buttons on the「Codex」resources (the `act` operation of `coda/resource@1`), `{ action, args }` on standard
// input. Anything but what is asked for is said in one line and fails the action, so its row shows it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withAppServer } from './app-server.mjs';
import { outcomes } from './quota.mjs';
import { accountSource } from '../agent/account-source.mjs';

// The「使用完全重置」button: redeems exactly the credit its button named (without one Codex would pick for itself), once.
async function reset({ creditId }) {
  if (accountSource()) throw new Error('额度已由账号插件接管，请在账号插件的那一行使用完全重置');
  if (typeof creditId !== 'string' || !creditId) throw new Error('没有指明用哪一次完全重置');
  let outcome;
  try { ({ outcome } = await withAppServer(server => server.request('account/rateLimitResetCredit/consume', { creditId, idempotencyKey: randomUUID() }))); }
  catch (error) { throw new Error(`使用结果未确认，请核对剩余次数：${error.message}`); }
  if (outcome !== 'reset') throw new Error(outcomes[outcome] ?? '使用结果未确认，请核对剩余次数');
}

const actions = { reset };
const { action, args } = JSON.parse(readFileSync(0, 'utf8'));
try {
  if (!Object.hasOwn(actions, action)) throw new Error(`不认识的动作：${action}`);
  await actions[action](args);
  console.log('{}');
} catch (error) { console.error(error.message); process.exitCode = 1; }
