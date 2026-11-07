// The「使用完全重置」button of a managed account: redeems exactly the credit its button named, once. Anything but a reset
// is said in one line and fails the action, so its row shows it.
import { randomUUID } from 'node:crypto';
import { withManagedAccount } from './manager.mjs';
import { outcomes } from './quota.mjs';

const { account, creditId } = JSON.parse(process.env.CODA_PANEL_ARGS || '{}');
if (typeof account !== 'string' || !account || typeof creditId !== 'string' || !creditId) { console.error('没有指明用哪个账号的哪一次完全重置'); process.exit(1); }
let outcome;
try {
  ({ outcome } = await withManagedAccount(account, server => server.request('account/rateLimitResetCredit/consume', { creditId, idempotencyKey: randomUUID() })));
} catch (error) { console.error(`使用结果未确认，请核对剩余次数：${error.message}`); process.exit(1); }
if (outcome !== 'reset') { console.error(outcomes[outcome] ?? '使用结果未确认，请核对剩余次数'); process.exit(1); }
