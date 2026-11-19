#!/usr/bin/env node
// The `coda/resource@1` record of the「Grok」type, printed once. No login file here shows no resource (the type is then offered
// under「添加资源」); a login file that cannot be read, or a CLI that cannot be asked, is one row saying so. The record always
// carries the sign-in, which the page offers with an install first when the CLI is not there.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { grokAsk, grokBinary, grokHome } from './ask.mjs';
import { line, resources } from './quota.mjs';

const problem = reason => ({ resources: [{ name: 'Grok', values: [], buttons: [], error: line(reason) }] });
async function read() {
  try { statSync(join(grokHome(), 'auth.json')); }
  catch (error) { return error.code === 'ENOENT' ? { resources: [] } : problem(`读不了 Grok 的登录：${error.code}`); }
  try { return resources(await grokAsk(['_x.ai/auth/check_subscription', '_x.ai/auth/info', '_x.ai/billing'])); }
  catch (error) { return problem(`暂时无法读取 Grok：${error.message}`); }
}
console.log(JSON.stringify([{ key: 'account', spec: { type: 'account', title: 'Grok', ...await read(),
  signIn: { installed: grokBinary() !== null, installable: true, note: '登录保存在这台机器的 Grok CLI 里，由它自己续期；可以用 X 账号确认。' } } }]));
