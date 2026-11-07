// The「Codex」resources of the managed accounts, printed once as `{ resources }`. Quota failures stay on the affected account's row.
import { list, selection, withManagedAccount } from './manager.mjs';
import { resources } from './quota.mjs';

try {
  const read = account => withManagedAccount(account.identity, server => server.request('account/rateLimits/read'));
  console.log(JSON.stringify(await resources(await list(), selection(), read)));
} catch (error) { console.error(error.message); process.exit(1); }
