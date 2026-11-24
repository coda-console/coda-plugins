// 登记的记录里 spec 的内容：目标机上执行进程看到的环境，由插件自己算，不从通用的机器记录推。
import { readFileSync } from 'node:fs';
import { homedir, hostname, release, type, userInfo } from 'node:os';

// /etc/os-release 里 PRETTY_NAME 的值（去掉引号与反斜杠转义）；没有这一行是 null。
export function prettyName(text) {
  const line = text.split('\n').find(one => one.startsWith('PRETTY_NAME='));
  if (line === undefined) return null;
  const value = line.slice('PRETTY_NAME='.length).trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\\(.)/g, '$1');
  return value || null;
}

// Linux 上取发行版名（安卓机的 chroot 里读到的就是 Debian，正是执行进程看到的）；读不到或别的平台用系统类型加内核版本。
export function osName({ platform = process.platform, read = file => readFileSync(file, 'utf8') } = {}) {
  if (platform === 'linux') {
    try { return prettyName(read('/etc/os-release')) ?? `${type()} ${release()}`; } catch { /* 没有 os-release：用下面的 */ }
  }
  return `${type()} ${release()}`;
}

// `name`：本机 Coda 机器记录里的名字，没有就用主机名。
export const hostSpec = name => ({ name: name || hostname(), os: osName(), user: userInfo().username, cwd: homedir() });
