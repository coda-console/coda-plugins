// The「Kimi」panel's reading, printed once as `{ items }`. No login file here shows nothing (the panel is then offered under
// 「添加资源」). Who is signed in is asked once for each state of the login file, which the CLI rewrites as it signs in and
// renews, and kept in this plugin's state: Kimi's own upstream lookup takes seconds and gives up after 8. The quota is
// asked each reading, of the same `kimi web`.
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kimiBinary } from '../agent/binary.mjs';
import { account, card } from './quota.mjs';
import { kimiWeb } from './web.mjs';

const home = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
const print = value => console.log(JSON.stringify(value));
let changed;
try { changed = statSync(join(home, 'credentials/kimi-code.json')).mtimeMs; }
catch (error) { if (error.code === 'ENOENT') { print({ items: [] }); process.exit(0); } console.error(`读不了 Kimi 的登录：${error.code}`); process.exit(1); }
const binary = kimiBinary();
if (!binary) { print({ items: [{ type: 'card', title: 'Kimi', items: [{ type: 'error', text: '这台机器上找不到 Kimi CLI，用「···」里的「重新登录」安装' }] }] }); process.exit(0); }

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
  print({ items: who ? [card(who, usage)] : [] });
} catch (error) { console.error(error.message); process.exit(1); }
