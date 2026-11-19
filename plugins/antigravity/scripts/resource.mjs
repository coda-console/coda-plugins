#!/usr/bin/env node
// The `coda/resource@1` record of the「Antigravity」type, printed once. No login here shows no resource (the type is then offered
// under「添加资源」); a keychain that cannot be asked, a CLI that is gone or cannot say its version is one row saying so, and the
// sign-in stays offered (it is how a machine without the CLI gets it). Shown with a login: the quota of each model group (the CLI's
// own read-only usage report, which opens no session and spends nothing; or why it is not had) and the CLI's version. There is
// no cheap, reliable place for the email, so no account is shown.
import { agyBinary, asked, reading, signedIn } from './agy.mjs';
import { windows } from './quota.mjs';
import { MINIMUM, needed } from './setup.mjs';

// The whole reading gets 25 of the 30 seconds Coda allows, from here, so that it is printed, with the reason, rather than
// killed by Coda with nothing (agy.mjs `reading`: the version and the quota are asked what is left of it).
const deadline = Date.now() + 25_000;
const line = (text, max = 80) => [...text.replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const problem = error => [{ name: 'Antigravity', values: [], buttons: [], error: line(error) }];
// Whether the CLI is installed: when it is there, runs and is not older than the setup needs.
const ready = binary => needed(binary, path => asked(path, Math.max(deadline - Date.now() - 1_000, 1))).action === 'none';
const print = (resources, installed) => console.log(JSON.stringify([{ key: 'account', spec: { type: 'account', title: 'Antigravity', resources,
  signIn: { installed, installable: true, input: 'authorizationCode',
    note: '登录保存在这台机器的系统钥匙串里，由 Antigravity CLI 自己续期；用 Google 账号确认，把授权页给的授权码贴回来。' } } }]));

const binary = agyBinary();
let login;
try { login = signedIn(); } catch (error) { print(problem(error.message), ready(binary)); process.exit(0); }
if (!login) { print([], ready(binary)); process.exit(0); }
if (!binary) { print(problem('这台机器上找不到 Antigravity CLI，请在运行机重新安装'), false); process.exit(0); }
const { version, tooOld, report, failure: why } = reading(binary, deadline, MINIMUM);
if (!version) { print(problem(`读不出 Antigravity CLI 的版本（${binary}）`), false); process.exit(0); }
const values = report ? windows(report) : [];
const failure = why ?? (report && !values.length ? 'Antigravity CLI 没有给出额度' : null);
// A reading lists 8 values at most: the version is always the last, after at most 7 of the quota. Only the reason is cut to
// what the 80 characters leave after「暂时无法获取额度：」.
const WHY = '暂时无法获取额度：';
print([{ name: 'Antigravity', values: [...values.slice(0, 7), { label: 'CLI 版本', value: version }], buttons: [],
  ...(tooOld ? { error: `Antigravity CLI 低于所需的 ${MINIMUM}，请重新安装插件或在运行机运行 agy update` }
    : failure ? { error: WHY + line(failure, 80 - WHY.length) } : {}) }], !tooOld);
