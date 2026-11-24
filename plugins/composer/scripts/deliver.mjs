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
const SSH_URL = /^ssh:\/\/(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::\d+)?\/(.*)$/;
const SCP_URL = /^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/)(.*)$/;
const bad = url => { throw new Error(`无法从地址解析 host/owner/repo：${url}`); };
const idOf = (host, owner, repo, url) => {
  const name = repo.replace(/\.git$/i, '');
  return [owner, name].some(part => !part || part === '.' || part === '..') ? bad(url) : `${host}/${owner}/${name}`.toLowerCase();
};
// 仓库地址：https://<host>/<owner>/<repo>(.git)。
const repoIdOf = url => {
  const [, host, owner, repo] = url.match(REPO_URL) ?? bad(url);
  return idOf(host, owner, repo, url);
};
// PR 地址：https://<host>/<owner>/<repo>/pull/<编号>；PR 地址里的仓库名不带 .git。
const prIdOf = url => {
  const [, host, owner, repo] = url.match(PR_URL) ?? bad(url);
  return /\.git$/i.test(repo) ? bad(url) : idOf(host, owner, repo, url);
};
// SSH 主机可能是 ~/.ssh/config 里的别名：取 ssh -G 解析出的 hostname。Host github.com → HostName ssh.github.com 这类走 SSH 专用入口的写法保留原主机；
// 解析后仍不是完整域名（单段别名）就返回 null，交给 gh 自己处理。
const sshHost = host => {
  const resolved = /^hostname (\S+)$/mi.exec(spawnSync('ssh', ['-G', host], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? host;
  const name = FQDN.test(host) && resolved.toLowerCase() === `ssh.${host}`.toLowerCase() ? host : resolved;
  return FQDN.test(name) ? name : null;
};
// origin 的仓库标识：https://、ssh://[user@]host[:port]/owner/repo(.git) 或 [user@]host:owner/repo(.git)；本地路径和解析不出域名的 SSH 别名返回 null。
const originIdOf = url => {
  if (/^https:\/\//i.test(url)) return repoIdOf(url);
  const ssh = url.match(SSH_URL) ?? url.match(SCP_URL);
  if (!ssh) return null;
  const [, owner, repo] = ssh[2].match(OWNER_REPO) ?? bad(url);
  const host = sshHost(ssh[1]);
  return host && idOf(host, owner, repo, url);
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
    state.members = note.trim().split(/\r?\n/).map(url => JSON.parse(gh('pr', 'view', url.trim(), '--json', 'url,headRefOid,headRefName,baseRefName')));
    // 集成向 origin 取提交，本仓库必须是 origin 指的那个；origin 是本地路径时用 gh 的默认仓库。
    const origin = originIdOf(git('remote', 'get-url', 'origin'));
    const repo = JSON.parse(gh('repo', 'view', ...origin ? [origin] : [], '--json', 'url,nameWithOwner,defaultBranchRef'));
    state.repository = repoIdOf(repo.url);
    if (origin && state.repository.split('/')[0] !== origin.split('/')[0]) throw new Error(`gh 的仓库 ${repo.url} 与 origin 不在同一主机：${origin}`);
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
