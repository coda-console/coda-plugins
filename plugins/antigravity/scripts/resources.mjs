// The「Antigravity」resources, printed once as `{ resources }`. No login here shows nothing (the type is then offered under
// 「添加资源」); a keychain that cannot be asked fails the reading, which keeps the last one shown. Shown: the quota of each
// model group (the CLI's own read-only usage report, which opens no session and spends nothing; or why it is not had) and the
// CLI's version. There is no cheap, reliable place for the email, so no account is shown.
import { agyBinary, asked, older, signedIn, usageReport, versionOf } from './agy.mjs';
import { windows } from './quota.mjs';
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
const tooOld = older(version, MINIMUM);
let values = [], failure = null;
if (!tooOld) {
  try { values = windows(usageReport(binary)); if (!values.length) failure = 'Antigravity CLI 没有给出额度'; }
  catch (error) { failure = error.message; }
}
const line = text => [...text.replace(/\s+/g, ' ').trim()].slice(0, 80).join('');
print({ resources: [{ name: 'Antigravity', values: [...values, { label: 'CLI 版本', value: version }],
  ...(tooOld ? { error: `Antigravity CLI 低于所需的 ${MINIMUM}，请重新安装插件或在运行机运行 agy update` }
    : failure ? { error: line(`暂时无法获取额度：${failure}`) } : {}) }] });
