#!/usr/bin/env node
// The `coda/resource@1` record of the「Codex」type, printed once. An account source owns the resources: without one, show
// Codex's own login as before. Signing in stays offered either way (the CLI comes with the plugin), also when Codex cannot be read.
import { withAppServer } from './app-server.mjs';
import { resources, unreadable } from './quota.mjs';
import { accountSource } from '../agent/account-source.mjs';

const read = accountSource() ? { resources: [] } : await withAppServer(resources).catch(unreadable);
console.log(JSON.stringify([{ key: 'login', spec: { type: 'login', title: 'Codex', ...read,
  signIn: { installed: true, installable: false, note: '接入账号插件后，登录会添加或更新插件管理的账号。' } } }]));
