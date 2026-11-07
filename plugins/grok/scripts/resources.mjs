// The「Grok」resources, printed once as `{ resources }`. No login file here shows nothing (the type is then offered under
// 「添加资源」); a CLI that cannot be asked fails the reading, which keeps the last one shown.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { grokAsk, grokHome } from './ask.mjs';
import { resources } from './quota.mjs';

try { statSync(join(grokHome(), 'auth.json')); }
catch (error) { if (error.code === 'ENOENT') { console.log('{"resources":[]}'); process.exit(0); } console.error(`读不了 Grok 的登录：${error.code}`); process.exit(1); }
try { console.log(JSON.stringify(resources(await grokAsk(['_x.ai/auth/check_subscription', '_x.ai/auth/info', '_x.ai/billing'])))); }
catch (error) { console.error(error.message); process.exit(1); }
