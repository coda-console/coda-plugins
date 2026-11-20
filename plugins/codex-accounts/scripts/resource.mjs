#!/usr/bin/env node
// The `coda/resource@1` record of the「Codex」type of the managed accounts, printed once. An account's login that is missing, expired or unreadable is on its row, and the accounts that cannot be listed
// for want of a login are one row saying so, with the sign-in offered. Any other failure to read (the network, a timeout, a server's
// error, a damaged store) fails the command (exit 1, the reason on the last line of its standard error), which keeps the record
// Coda has.
import { list, selection, withManagedAccount } from './manager.mjs';
import { needsSignIn, resources, unreadable } from './quota.mjs';

const read = account => withManagedAccount(account.identity, server => server.request('account/rateLimits/read'));
let shown;
try { shown = await resources(await list(), selection(), read); }
catch (error) {
  if (!needsSignIn(error)) { console.error(String(error.message).replace(/\s+/g, ' ').trim()); process.exit(1); }
  shown = unreadable(error);
}
console.log(JSON.stringify([{ key: 'accounts', spec: { type: 'accounts', title: 'Codex', ...shown,
  signIn: { installed: true, installable: false, note: '登录其他账号即可添加；登录已有账号会更新其凭据。首个账号会自动选用，之后在账号那一行的「···」里切换。' } } }]));
