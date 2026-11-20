#!/usr/bin/env node
// The `coda/resource@1` record of the「Grok」type, printed once. No login file here shows no resource (the type is then offered
// under「添加资源」); a login file that cannot be read, or a login without a CLI that is ready (`needed`, install.mjs: it runs, and
// is new enough), is one row saying so. The record always carries the sign-in, which the page offers with an install first when
// the CLI is not ready. A CLI that cannot be asked, or whose answer cannot be understood or has no quota, fails the command
// (exit 1, the reason on the last line of its standard error), which keeps the record Coda has.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { grokAsk, grokBinary, grokHome } from './ask.mjs';
import { needed } from './install.mjs';
import { line, resources } from './quota.mjs';

const problem = reason => ({ resources: [{ name: 'Grok', values: [], buttons: [], error: line(reason) }] });
const binary = grokBinary(), ready = needed(binary);
async function read() {
  try { statSync(join(grokHome(), 'auth.json')); }
  catch (error) { return error.code === 'ENOENT' ? { resources: [] } : problem(`读不了 Grok 的登录：${error.code}`); }
  if (ready.action !== 'none') return problem(`${ready.reason}，用「···」里的「重新登录」安装`);
  // A subscription check that says no one is signed in is the answer: the rest is not asked.
  return resources(await grokAsk(['_x.ai/auth/check_subscription', '_x.ai/auth/info', '_x.ai/billing'], { binary, stop: ([subscription]) => subscription?.authenticated === false }));
}
try {
  console.log(JSON.stringify([{ key: 'account', spec: { type: 'account', title: 'Grok', ...await read(),
    signIn: { installed: ready.action === 'none', installable: true, note: '登录保存在这台机器的 Grok CLI 里，由它自己续期；可以用 X 账号确认。' } } }]));
} catch (error) { console.error(String(error.message).replace(/\s+/g, ' ').trim()); process.exit(1); }
