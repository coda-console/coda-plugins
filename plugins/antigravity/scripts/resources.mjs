// The「Antigravity」resources, printed once as `{ resources }`. No login here shows nothing (the type is then offered under
// 「添加资源」); a keychain that cannot be asked fails the reading, which keeps the last one shown. Only the CLI's version is
// shown: it has no call for the account or the quota that does not open a session (which would join the user's history),
// and no cheap, reliable place for the email.
import { agyBinary, asked, older, signedIn, versionOf } from './agy.mjs';
import { MINIMUM } from './setup.mjs';

const print = value => console.log(JSON.stringify(value));
let login;
try { login = signedIn(); } catch (error) { console.error(error.message); process.exit(1); }
if (!login) { print({ resources: [] }); process.exit(0); }
const binary = agyBinary();
if (!binary) { print({ resources: [{ name: 'Antigravity', error: '这台机器上找不到 Antigravity CLI，请在运行机重新安装' }] }); process.exit(0); }
const ran = asked(binary);
const version = ran.status === 0 ? versionOf(ran) : null;
if (!version) { console.error(`读不出 Antigravity CLI 的版本（${binary}）`); process.exit(1); }
print({ resources: [{ name: 'Antigravity', values: [{ label: 'CLI 版本', value: version }],
  ...(older(version, MINIMUM) ? { error: `Antigravity CLI 低于所需的 ${MINIMUM}，请重新安装插件或在运行机运行 agy update` } : {}) }] });
