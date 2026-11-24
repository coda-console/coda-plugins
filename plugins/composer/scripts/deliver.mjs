// 成员快照和交付反馈跨步骤保存在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, git, output, outputFilled, outputPicked } from './shared.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'deliver.json');

// 用户开启时由主 Agent 写的需求：备注第一行是需求名，其后是目标与完成标准。
if (action === 'brief') {
  const [first = '', ...rest] = (JSON.parse(env.RESPONSE).note ?? '').trim().split(/\r?\n/);
  const title = first.trim(), goal = rest.join('\n').trim();
  output('feedback', title && goal ? '' : '备注第一行写需求名，空一行后写目标与完成标准，两样都要有。');
  output('route', title && goal ? 'init' : 'brief');
  output('title', title);
  output('goal', goal);
  process.exit(0);
}

if (action === 'init') {
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, members: [], feedback: '', round: 0, head: '' }));
  output('title', env.TITLE);
  output('goal', env.GOAL);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const links = () => state.members.map(member => member.url).join('\n');
// 仓库身份是小写的 host/owner/repo：不同主机上的同名 owner/repo 不是同一个仓库。地址对原始字符串严格匹配，结构不对就报错，不退回到不带主机的比较。
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', SEG = '[A-Za-z0-9_.-]+';
const OWNER_REPO = new RegExp(`^(${SEG})/(${SEG})$`);
const FQDN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
const REPO_URL = new RegExp(`^[hH][tT][tT][pP][sS]://((?:${LABEL}\\.)+${LABEL})/(${SEG})/(${SEG})$`);
const PR_URL = new RegExp(`^[hH][tT][tT][pP][sS]://((?:${LABEL}\\.)+${LABEL})/(${SEG})/(${SEG})/pull/[1-9][0-9]*$`);
// origin 的 HTTPS 远端可以带 userinfo（https://git@host/...、https://token@host/...）：只取 host/owner/repo，userinfo 不进参数也不进报错；Git 远端末尾可以带一个斜线。
const ORIGIN_HTTPS = new RegExp(`^[hH][tT][tT][pP][sS]://(?:[^\\s@/?#\\x00-\\x1f\\x7f]*@)?((?:${LABEL}\\.)+${LABEL})/(${SEG})/(${SEG})\\/?$`);
const SSH_URL = /^ssh:\/\/(?:(?<user>[A-Za-z0-9_.-]+)@)?(?<host>[A-Za-z0-9][A-Za-z0-9.-]*)(?::(?<port>\d+))?\/(?<path>.*)$/;
const SCP_URL = /^(?:(?<user>[A-Za-z0-9_.-]+)@)?(?<host>[A-Za-z0-9][A-Za-z0-9.-]*):(?!\/)(?<path>.*)$/;
// 完整域名：总长不超过 253，末段标签不全是数字（排除 IPv4 字面量）。
const isFqdn = host => FQDN.test(host) && host.length <= 253 && !/^\d+$/.test(host.split('.').at(-1));
// 地址可能带凭据（https://token@host/...）：报错只说明是哪类地址要求什么格式，不回显原始字符串。
const BAD = { origin: '无法解析 origin 仓库地址，需要标准 HTTPS 或 SSH 仓库地址', repo: '无法解析仓库地址，需要标准 HTTPS 仓库地址', pr: '无法解析成员 PR 地址，需要标准 HTTPS PR 地址' };
const bad = what => { throw new Error(BAD[what]); };
// owner/repo 两段：去掉 .git 后不能为空、. 或 ..。
const pathOf = (owner, repo, what) => {
  const name = repo.replace(/\.git$/i, '');
  return [owner, name].some(part => !part || part === '.' || part === '..') ? bad(what) : `${owner}/${name}`;
};
const idOf = (host, owner, repo, what) => isFqdn(host) ? `${host}/${pathOf(owner, repo, what)}`.toLowerCase() : bad(what);
// 仓库地址：https://<host>/<owner>/<repo>(.git)。
const repoIdOf = (url, what = 'repo') => {
  const [, host, owner, repo] = url.match(REPO_URL) ?? bad(what);
  return idOf(host, owner, repo, what);
};
// PR 地址：https://<host>/<owner>/<repo>/pull/<编号>；PR 地址里的仓库名不带 .git。
const prIdOf = url => {
  const [, host, owner, repo] = url.match(PR_URL) ?? bad('pr');
  return /\.git$/i.test(repo) ? bad('pr') : idOf(host, owner, repo, 'pr');
};
// 按 shell 的引号和反斜杠把命令拆成词：单引号原样，双引号里 \ 只转义 " \ $ `，引号外 \ 转义下一个字符。
const words = command => {
  const out = [];
  let word = null, quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; }
    else if (quote === '"') { if (c === '"') quote = null; else word += c === '\\' && /["\\$`]/.test(command[i + 1] ?? '') ? command[++i] : c; }
    else if (/\s/.test(c)) { if (word !== null) out.push(word); word = null; }
    else { word ??= ''; if (c === "'" || c === '"') quote = c; else word += c === '\\' ? command[++i] ?? '' : c; }
  }
  if (word !== null) out.push(word);
  return out;
};
// OpenSSH 客户端带值的单字符选项。
const SSH_VALUED = 'bcDEeFIiJLlmOopQRSWw';
// Git 用的 SSH 参数：GIT_SSH_COMMAND（没设时 core.sshCommand）拆词后按 getopt 扫描选项（到 -- 或第一个非选项参数为止），
// 带值选项照常吃掉它的值；其中的 -F <文件> 和 -o <选项>（含连写形式）按出现顺序保留，交给 ssh -G 自己取舍（-F 有多个时取最后一个）。
const sshConfig = () => {
  const command = env.GIT_SSH_COMMAND || spawnSync('git', ['config', '--get', 'core.sshCommand'], { encoding: 'utf8' }).stdout || '';
  const parts = words(command), kept = [];
  for (let i = 1; i < parts.length && parts[i] !== '--' && /^-./.test(parts[i]); i++) {
    for (let j = 1; j < parts[i].length; j++) {
      const flag = parts[i][j];
      if (!SSH_VALUED.includes(flag)) continue;
      const value = parts[i].slice(j + 1) || parts[++i];
      if (flag === 'F' || flag === 'o') kept.push(`-${flag}`, value);
      break;
    }
  }
  return kept;
};
// SSH 主机可能是 SSH 配置里的别名：按 Git 实际的 SSH 配置和地址里的用户、端口取 ssh -G 解析出的 hostname。Host <域名> → HostName ssh.<域名> 这类走 SSH 专用入口的写法保留原主机；
// GitHub 公网的 SSH 443 入口 ssh.github.com 就是 github.com。解析后仍不是合法域名（单段别名、IP、超长、非法标签）就报错，不交给 gh 的默认仓库。
const sshHost = (host, user, port) => {
  const args = [...sshConfig(), ...user ? ['-l', user] : [], ...port ? ['-p', port] : [], '-G', '--', host];
  const done = spawnSync('ssh', args, { encoding: 'utf8' });
  // ssh -G 失败（端口不对、配置有错）或没给出 hostname 时不猜，直接报错。
  const resolved = (done.status === 0 && /^hostname (\S+)$/mi.exec(done.stdout)?.[1]) || bad('origin');
  const kept = isFqdn(host) && resolved.toLowerCase() === `ssh.${host}`.toLowerCase() ? host : resolved;
  const name = kept.toLowerCase() === 'ssh.github.com' ? 'github.com' : kept;
  return isFqdn(name) ? name : bad('origin');
};
// origin 的仓库标识：https://[userinfo@]host/owner/repo(.git)、ssh://[user@]host[:port]/owner/repo(.git) 或 [user@]host:owner/repo(.git)。
// 带协议头的和 SCP 写法（冒号前没有斜线；只有 Windows 上 X: 开头是盘符）都是网络远端，不合上面的格式就报错；只有本地路径和本机 file:// 地址返回 null。
const originIdOf = url => {
  const https = url.match(ORIGIN_HTTPS);
  if (/^file:\/\/(?:localhost)?\//i.test(url)) return null;
  if (https) return idOf(https[1], https[2], https[3], 'origin');
  const scp = /^[^/]*:/.test(url) && !(process.platform === 'win32' && /^[A-Za-z]:/.test(url));
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !scp) return null;
  const { user, host, port, path } = (url.match(SSH_URL) ?? url.match(SCP_URL) ?? bad('origin')).groups;
  const [, owner, repo] = path.match(OWNER_REPO) ?? bad('origin');
  const ownerRepo = pathOf(owner, repo, 'origin');
  return `${sshHost(host, user, port)}/${ownerRepo}`.toLowerCase();
};
const localMembers = () => state.members.filter(member => prIdOf(member.url) === state.repository);
// 人工任务的必填备注由脚本检查，缺少时回到同一张卡。用户附上的文件也算附言，路径随反馈交回主 Agent。
const answer = (route, required) => {
  const { note = '', attachments = [] } = JSON.parse(env.RESPONSE);
  const missing = required && !note.trim() && !attachments.length;
  const files = attachments.length ? `附件：\n${attachments.map(path => `- ${path}`).join('\n')}` : '';
  state.feedback = missing ? '此选项必须填写备注。' : [note.trim() && note, files].filter(Boolean).join('\n');
  save();
  output('feedback', missing ? state.feedback : '');
  output('route', missing ? action : route);
  return !missing;
};

switch (action) {
  case 'context':
    output('feedback', state.feedback);
    output('members', links());
    break;
  case 'confirm': {
    const { choice, note } = JSON.parse(env.RESPONSE);
    if (!answer(choice === 'stop' ? 'stop' : env.DEVICES === 'true' ? 'integrate' : 'report', choice === 'start') || choice === 'stop') break;
    // 先校验成员地址再交给 gh：非法地址（可能带凭据）既不传出去，也不进报错。
    state.members = note.trim().split(/\r?\n/).map(url => (prIdOf(url.trim()), JSON.parse(gh('pr', 'view', url.trim(), '--json', 'url,headRefOid,headRefName,baseRefName'))));
    // 集成向 origin 取提交，本仓库必须是 origin 指的那个；origin 是本地路径时用 gh 的默认仓库。
    const origin = originIdOf(git('remote', 'get-url', 'origin'));
    const repo = JSON.parse(gh('repo', 'view', ...origin ? [origin] : [], '--json', 'url,nameWithOwner,defaultBranchRef'));
    state.repository = repoIdOf(repo.url);
    if (origin && state.repository.split('/')[0] !== origin.split('/')[0]) throw new Error(`gh 的仓库 ${state.repository} 与 origin 不在同一主机：${origin}`);
    const local = localMembers();
    state.base = local[0]?.baseRefName ?? repo.defaultBranchRef.name;
    state.round += 1;
    state.feedback = '';
    save();
    output('members', links());
    output('round', state.round);
    output('commit', local.at(-1)?.headRefOid ?? env.GITHUB_SHA);
    break;
  }
  case 'integrate': {
    state.feedback = `集成失败，请用 workflow_status 读取本运行「集成」步骤的错误和日志：coda://workflow-runs/${env.GITHUB_RUN_ID}`;
    save();
    const branch = `delivery/${env.GITHUB_RUN_ID}`;
    git('fetch', 'origin', `+refs/heads/${state.base}:refs/remotes/origin/${state.base}`);
    git('switch', '-C', branch, `origin/${state.base}`);
    for (const member of localMembers()) {
      git('fetch', 'origin', member.headRefOid);
      const result = spawnSync('git', ['merge', '--no-ff', '--no-edit', member.headRefOid], { encoding: 'utf8' });
      if (result.error) throw result.error;
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.status !== 0) {
        state.feedback = `集成 ${member.url} 失败：\n${result.stdout}${result.stderr}`;
        save();
        process.exit(result.status ?? 1);
      }
    }
    // 退回后的新一轮从最新 base 重新集成，替换本运行的预览分支。
    git('push', `--force-with-lease=refs/heads/${branch}:${state.head}`, 'origin', `HEAD:refs/heads/${branch}`);
    state.head = git('rev-parse', 'HEAD');
    state.feedback = '';
    save();
    output('head', state.head);
    output('branch', branch);
    break;
  }
  case 'preview': {
    const { choice } = JSON.parse(env.RESPONSE);
    answer(choice === 'confirm' ? 'confirm' : 'device', choice === 'confirm');
    break;
  }
  case 'device': {
    const { choice } = JSON.parse(env.RESPONSE);
    answer(choice === 'no' ? 'confirm' : 'report', choice === 'no');
    break;
  }
  case 'report':
    if (answer('approve', true)) output('body', JSON.parse(env.RESPONSE).note);
    break;
  // 批准卡：「暂不合并」带着原因回到确认；「批准合并」记下勾了哪些合并后的流程（shared.mjs outputPicked）。
  case 'approval': {
    const response = JSON.parse(env.RESPONSE);
    if (answer(response.choice === 'stop' ? 'confirm' : 'release', response.choice === 'stop')) outputPicked(response, env.JOINERS);
    break;
  }
  // 验证说明和结果通知说的合并后流程按这里实际要运行的（only）算，不按批准时勾的。
  case 'inputs': {
    const only = outputFilled();
    output('picked', JSON.parse(env.JOINERS).filter(joiner => only.includes(joiner.id)).map(joiner => joiner.name).join('、'));
    break;
  }
  case 'merged':
    if (answer('deploy', true)) output('commit', JSON.parse(env.RESPONSE).note.trim());
    break;
  case 'verify': {
    const { choice } = JSON.parse(env.RESPONSE);
    answer('done', choice === 'no');
    break;
  }
  default: throw new Error(`未知交付步骤：${action}`);
}
