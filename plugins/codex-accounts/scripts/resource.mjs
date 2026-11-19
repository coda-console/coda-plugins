#!/usr/bin/env node
// The `coda/resource@1` record of the「Codex」type of the managed accounts, printed once. Quota failures stay on the affected
// account's row; accounts that cannot be read at all are one row saying so, and the sign-in stays offered.
import { list, selection, withManagedAccount } from './manager.mjs';
import { resources, unreadable } from './quota.mjs';

const read = account => withManagedAccount(account.identity, server => server.request('account/rateLimits/read'));
let shown;
try { shown = await resources(await list(), selection(), read); } catch (error) { shown = unreadable(error); }
console.log(JSON.stringify([{ key: 'accounts', spec: { type: 'accounts', title: 'Codex', ...shown,
  signIn: { installed: true, installable: false, note: '登录其他账号即可添加；登录已有账号会更新其凭据。首个账号会自动选用，之后在账号那一行的「···」里切换。' } } }]));
