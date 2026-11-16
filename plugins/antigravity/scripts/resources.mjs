// The「Antigravity」resources, printed once as `{ resources }`. No login here shows nothing (the type is then offered under
// 「添加资源」); a keychain that cannot be asked fails the reading, which keeps the last one shown. Only the CLI's version is
// shown: it has no call for the account or the quota that does not open a session (which would join the user's history),
// and no cheap, reliable place for the email.
import { spawnSync } from 'node:child_process';
import { agyBinary, older, signedIn, versionIn } from './agy.mjs';
import { MINIMUM } from './setup.mjs';

const print = value => console.log(JSON.stringify(value));
let login;
try { login = signedIn(); } catch (error) { console.error(error.message); process.exit(1); }
if (!login) { print({ resources: [] }); process.exit(0); }
const binary = agyBinary();
if (!binary) { print({ resources: [{ name: 'Antigravity', error: '这台机器上找不到 Antigravity CLI，用「···」里的「重新登录」安装' }] }); process.exit(0); }
const ran = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
const version = ran.status === 0 ? versionIn(ran.stdout) : null;
if (!version) { console.error(`读不出 Antigravity CLI 的版本（${binary}）`); process.exit(1); }
print({ resources: [{ name: 'Antigravity', values: [{ label: 'CLI 版本', value: version }],
  ...(older(version, MINIMUM) ? { error: `Antigravity CLI 低于所需的 ${MINIMUM}，用「···」里的「重新登录」升级` } : {}) }] });
