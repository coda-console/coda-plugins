// The「Antigravity」resources, printed once as `{ resources }`. No login here shows nothing (the type is then offered under
// 「添加资源」); a keychain that cannot be asked fails the reading, which keeps the last one shown. Shown: the quota of each
// model group (the CLI's own read-only usage report, which opens no session and spends nothing; or why it is not had) and the
// CLI's version. There is no cheap, reliable place for the email, so no account is shown.
import { agyBinary, reading, signedIn } from './agy.mjs';
import { windows } from './quota.mjs';
import { MINIMUM } from './setup.mjs';

// The whole reading gets 25 of the 30 seconds Coda allows, from here, so that it is printed, with the reason, rather than
// killed by Coda with nothing (agy.mjs `reading`: the version and the quota are asked what is left of it).
const deadline = Date.now() + 25_000;
const print = value => console.log(JSON.stringify(value));
let login;
try { login = signedIn(); } catch (error) { console.error(error.message); process.exit(1); }
if (!login) { print({ resources: [] }); process.exit(0); }
const binary = agyBinary();
if (!binary) { print({ resources: [{ name: 'Antigravity', error: '这台机器上找不到 Antigravity CLI，请在运行机重新安装' }] }); process.exit(0); }
const { version, tooOld, report, failure: why } = reading(binary, deadline, MINIMUM);
if (!version) { console.error(`读不出 Antigravity CLI 的版本（${binary}）`); process.exit(1); }
const values = report ? windows(report) : [];
const failure = why ?? (report && !values.length ? 'Antigravity CLI 没有给出额度' : null);
const line = (text, max = 80) => [...text.replace(/\s+/g, ' ').trim()].slice(0, max).join('');
// A reading lists 8 values at most: the version is always the last, after at most 7 of the quota. Only the reason is cut to
// what the 80 characters leave after「暂时无法获取额度：」.
const WHY = '暂时无法获取额度：';
print({ resources: [{ name: 'Antigravity', values: [...values.slice(0, 7), { label: 'CLI 版本', value: version }],
  ...(tooOld ? { error: `Antigravity CLI 低于所需的 ${MINIMUM}，请重新安装插件或在运行机运行 agy update` }
    : failure ? { error: WHY + line(failure, 80 - WHY.length) } : {}) }] });
