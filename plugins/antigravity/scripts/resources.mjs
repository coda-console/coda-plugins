// The「Antigravity」resources, printed once as `{ resources }`. No login here shows nothing (the type is then offered under
// 「添加资源」); a keychain that cannot be asked fails the reading, which keeps the last one shown. Shown: the quota of each
// model group (the CLI's own read-only usage report, which opens no session and spends nothing; or why it is not had) and the
// CLI's version. There is no cheap, reliable place for the email, so no account is shown.
import { agyBinary, asked, older, signedIn, usageReport, versionOf } from './agy.mjs';
import { windows } from './quota.mjs';
import { MINIMUM } from './setup.mjs';

// The whole reading gets 25 of the 30 seconds Coda allows (`CODA_ANTIGRAVITY_BUDGET_MS`: for the tests), from here: the version
// and the quota are asked only what is left of it less a second to print, and no quota is asked for when too little is left,
// so that the reading is printed, with the reason, rather than killed by Coda with nothing.
const deadline = Date.now() + (Number(process.env.CODA_ANTIGRAVITY_BUDGET_MS) || 25_000), RESERVE = 1_000, LEAST = 3_000;
const left = () => deadline - Date.now() - RESERVE;
const print = value => console.log(JSON.stringify(value));
let login;
try { login = signedIn(); } catch (error) { console.error(error.message); process.exit(1); }
if (!login) { print({ resources: [] }); process.exit(0); }
const binary = agyBinary();
if (!binary) { print({ resources: [{ name: 'Antigravity', error: '这台机器上找不到 Antigravity CLI，请在运行机重新安装' }] }); process.exit(0); }
const ran = asked(binary, Math.max(left(), 1));
const version = ran.status === 0 ? versionOf(ran) : null;
if (!version) { console.error(`读不出 Antigravity CLI 的版本（${binary}）`); process.exit(1); }
const tooOld = older(version, MINIMUM);
let values = [], failure = null;
if (!tooOld) {
  if (left() < LEAST) failure = '读取超时';
  else try { values = windows(usageReport(binary, undefined, Math.min(left(), 20_000))); if (!values.length) failure = 'Antigravity CLI 没有给出额度'; }
  catch (error) { failure = error.message; }
}
const line = (text, max = 80) => [...text.replace(/\s+/g, ' ').trim()].slice(0, max).join('');
// A reading lists 8 values at most: the version is always the last, after at most 7 of the quota. Only the reason is cut to
// what the 80 characters leave after「暂时无法获取额度：」.
const WHY = '暂时无法获取额度：';
print({ resources: [{ name: 'Antigravity', values: [...values.slice(0, 7), { label: 'CLI 版本', value: version }],
  ...(tooOld ? { error: `Antigravity CLI 低于所需的 ${MINIMUM}，请重新安装插件或在运行机运行 agy update` }
    : failure ? { error: WHY + line(failure, 80 - WHY.length) } : {}) }] });
