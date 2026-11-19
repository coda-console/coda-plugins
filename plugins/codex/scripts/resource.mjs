#!/usr/bin/env node
// The `coda/resource@1` record of the「Codex」type, printed once. An account source owns the resources: without one, show
// Codex's own login as before. Signing in stays offered either way (the CLI comes with the plugin). A login Codex says is gone,
// expired or unreadable is one row saying so; any other failure to read (Codex not answering, the network, a server's error) fails
// the command (exit 1, the reason on the last line of its standard error), which keeps the record Coda has.
import { withAppServer } from './app-server.mjs';
import { needsSignIn, resources, unreadable } from './quota.mjs';
import { accountSource } from '../agent/account-source.mjs';

const read = accountSource() ? { resources: [] } : await withAppServer(resources).catch(error => {
  if (needsSignIn(error)) return unreadable(error);
  console.error(String(error.message).replace(/\s+/g, ' ').trim()); process.exit(1);
});
console.log(JSON.stringify([{ key: 'login', spec: { type: 'login', title: 'Codex', ...read,
  signIn: { installed: true, installable: false, note: '接入账号插件后，登录会添加或更新插件管理的账号。' } } }]));
