#!/usr/bin/env node
// The `coda/resource@1` record of the「Kimi」type, printed once. No login file here shows no resource (the type is then offered under
// 「添加资源」); a login file that cannot be read, a CLI that is gone or one that cannot be asked is one row saying so. The record always
// carries the sign-in, which the page offers with an install first when the CLI is not there. Who is signed in is asked once for each
// state of the login file, which the CLI rewrites as it signs in and renews, and kept in this plugin's state: Kimi's own upstream
// lookup takes seconds and gives up after 8. The quota is asked each reading, of the same `kimi web`.
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kimiBinary } from '../agent/binary.mjs';
import { account, line, resource } from './quota.mjs';
import { kimiWeb } from './web.mjs';

const home = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
const binary = kimiBinary();
const problem = reason => ({ resources: [{ name: 'Kimi', values: [], buttons: [], error: line(reason) }] });

async function read() {
  let changed;
  try { changed = statSync(join(home, 'credentials/kimi-code.json')).mtimeMs; }
  catch (error) { return error.code === 'ENOENT' ? { resources: [] } : problem(`读不了 Kimi 的登录：${error.code}`); }
  if (!binary) return problem('这台机器上找不到 Kimi CLI，用「···」里的「重新登录」安装');

  const seenFile = process.env.CODA_PLUGIN_STATE && join(process.env.CODA_PLUGIN_STATE, 'account.json');
  let seen = null;
  try { seen = JSON.parse(readFileSync(seenFile, 'utf8')); } catch {}
  const known = seen?.changed === changed;
  try {
    const [usage, info] = await kimiWeb(['/api/v1/oauth/usage', ...(known ? [] : ['/api/v1/oauth/userinfo'])], { binary, home });
    // The login changed and who it is could not be asked: the last name and plan stand in, but not the last ID, which is
    // the other login's and would name this one's quota as that account's.
    let who = known ? seen.account : { name: seen?.account?.name ?? '', plan: seen?.account?.plan ?? '' };
    if (!known) {
      try {
        if (info.error) throw new Error(info.error);
        who = account(info.data);
        if (seenFile) { writeFileSync(`${seenFile}.tmp`, JSON.stringify({ changed, account: who })); renameSync(`${seenFile}.tmp`, seenFile); }
      } catch { /* Not told now: the account seen last, or the kind's own name, and asked again next time. */ }
    }
    return { resources: who ? [resource(who, usage)] : [] };
  } catch (error) { return problem(`暂时无法读取 Kimi：${error.message}`); }
}
console.log(JSON.stringify([{ key: 'account', spec: { type: 'account', title: 'Kimi', ...await read(),
  signIn: { installed: binary !== null, installable: true, note: '登录保存在这台机器的 Kimi CLI 里，由它自己续期。' } } }]));
