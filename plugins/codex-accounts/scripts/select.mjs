// The「切换使用」button checks the owned account before saving the choice. Sessions take it at their next boundary.
import { withAccount } from './codex.mjs';
import { choose, tokens } from './manager.mjs';

const { account } = JSON.parse(process.env.CODA_PANEL_ARGS || '{}');
try {
  if (typeof account !== 'string' || !account) throw new Error('没有指明切换到哪个账号');
  await withAccount(await tokens(account), async () => {});
  await choose(account);
} catch (error) { console.error(`切换失败：${error.message}`); process.exit(1); }
