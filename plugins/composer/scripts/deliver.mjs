// 成员快照和交付反馈跨步骤保存在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, git, output } from './shared.mjs';

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
const localMembers = () => state.members.filter(member => new URL(member.url).pathname.split('/').slice(1, 3).join('/') === state.repository);
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
    const repo = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
    state.repository = repo.nameWithOwner;
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
  case 'approval': {
    const { choice, note = '', options = {} } = JSON.parse(env.RESPONSE);
    const missing = (options.preview || options.release) && !note.trim();
    answer(choice === 'stop' ? 'confirm' : missing ? 'notes' : 'release', choice === 'stop');
    break;
  }
  case 'notes':
    if (answer('ready', true)) output('notes', JSON.parse(env.RESPONSE).note);
    break;
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
