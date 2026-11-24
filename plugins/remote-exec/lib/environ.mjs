// 执行进程的环境：不继承后端的环境，从干净的环境起 shell，只带白名单里的几项（参照非交互的远程登录，sshd 给的那几样）。
import { userInfo } from 'node:os';

// 照原样带过去的变量；LC_* 另按前缀带。任何 CODA_ 开头的都不带。
export const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TZ'];
export const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';

// `source`：后端（插件进程）的环境；`user`：后端所在的系统用户（`os.userInfo()` 的形状）。
// 回一份新环境：白名单里有值的照抄；HOME、USER、LOGNAME、SHELL、PATH 缺了就按系统用户补上，和登录时一样。
export function cleanEnv(source = process.env, user = userInfo()) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || key.startsWith('CODA_')) continue;
    if (PASS.includes(key) || key.startsWith('LC_')) env[key] = value;
  }
  env.HOME ??= user.homedir;
  env.USER ??= user.username;
  env.LOGNAME ??= user.username;
  if (user.shell) env.SHELL ??= user.shell;
  env.PATH ??= FALLBACK_PATH;
  return env;
}

// 交给 `ctx.spawn` 的命令与参数：`env -i` 清空继承来的环境，再按 `env` 一项项设上，然后 exec 成 `/bin/sh -c`（进程组的根不变）。
// 变量的值原样作参数，不经 shell。
export function shellArgs(command, env) {
  return ['/usr/bin/env', ['-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), '/bin/sh', '-c', command]];
}
