#!/usr/bin/env node
// The `coda/resource@1` records of the「Codex」type, printed once: this machine's own login, and with「多账号」on (the setting
// `codex.multipleAccounts`) the managed accounts, a type of their own, while this machine's own login shows none. Signing in
// stays offered either way (the CLI comes with the plugin). A login that is gone, expired or unreadable is a row saying so; so is,
// with several accounts, one whose quota cannot be read while another's was. Any other failure to read (Codex not answering, the
// network, a server's error, a damaged store, no account's quota had) fails the command (exit 1, the reason on the last line of
// its standard error), which keeps the records Coda has.
import { withAppServer } from './app-server.mjs';
import { list, multipleAccounts, selection, withManagedAccount } from './manager.mjs';
import { managedResources, managedUnreadable, needsSignIn, resources, unreadable } from './quota.mjs';

const fail = error => { console.error(String(error.message).replace(/\s+/g, ' ').trim()); process.exit(1); };
const multiple = multipleAccounts();
const own = multiple ? { resources: [] } : await withAppServer(resources).catch(error => needsSignIn(error) ? unreadable(error) : fail(error));
const records = [{ key: 'login', spec: { type: 'login', title: 'Codex', ...own,
  signIn: { installed: true, installable: false, note: '打开「多账号」后，登录会添加或更新多账号里的账号。' } } }];
if (multiple) {
  const read = account => withManagedAccount(account.identity, server => server.request('account/rateLimits/read'));
  let managed;
  try { managed = await managedResources(await list(), selection(), read); }
  catch (error) { managed = needsSignIn(error) ? managedUnreadable(error) : fail(error); }
  records.push({ key: 'accounts', spec: { type: 'accounts', title: 'Codex', ...managed,
    signIn: { installed: true, installable: false, note: '登录其他账号即可添加；登录已有账号会更新其凭据。首个账号会自动选用，之后在账号那一行的「···」里切换。' } } });
}
console.log(JSON.stringify(records));
