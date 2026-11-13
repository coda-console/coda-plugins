// 需求运行（README.md「监督开发」）：一个需求一条泳道 lane/<运行 ID>，主 Agent 用泳道 PR（lane-pr）往里提改动，提交验收后泳道开 PR 进目标分支。
// 每步的工作区都会回收；反馈与汇报暂存在本次运行的产物里。进度以 GitHub 为准：泳道分支、已合并的泳道 PR 和泳道进目标分支的 PR，从头重跑也接得上。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForGitHubChecks } from './github-checks.mjs';
import { checksText, gh, git, mergedCommit, mergePr, openPr, output, outputFilled, outputPicked, reviewsText } from './shared.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'develop.json');

// 用户开启时由主 Agent 写的需求：备注第一行是需求名，其后是目标与完成标准。
if (action === 'brief') {
  const [first = '', ...rest] = (JSON.parse(env.BRIEF).note ?? '').trim().split(/\r?\n/);
  const title = first.trim(), goal = rest.join('\n').trim();
  output('feedback', title && goal ? '' : '备注第一行写需求名，空一行后写目标与完成标准，两样都要有。');
  output('route', title && goal ? 'lane' : 'brief');
  output('title', title);
  output('goal', goal);
  process.exit(0);
}

// 从目标分支最新提交建泳道；远端已有同名泳道时沿用（运行从头重跑）。
if (action === 'lane') {
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const lane = `lane/${env.GITHUB_RUN_ID}`;
  if (git('ls-remote', '--heads', 'origin', lane)) console.error(`远端已有泳道 ${lane}，沿用`);
  else {
    git('fetch', 'origin', base);
    git('push', 'origin', `FETCH_HEAD:refs/heads/${lane}`);
  }
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, goal: env.GOAL, base, lane, feedback: '', report: '' }));
  for (const [name, value] of Object.entries({ title: env.TITLE, goal: env.GOAL, base, lane })) output(name, value);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
// 回到「需求进行中」的原因，主 Agent 答复后清掉。
const back = reason => { state.feedback = reason; save(); };

// 与 PR 的 Files changed 一致：目标分支最新提交到泳道 head 的三点 diff，按 .coda/areas.json 的最长前缀归区域。
const changes = base => {
  const declared = git('ls-tree', '--name-only', state.head, '.coda/areas.json') ? JSON.parse(git('show', `${state.head}:.coda/areas.json`)) : {};
  const prefixes = Object.entries(declared).flatMap(([area, list]) => list.map(prefix => [prefix, area])).sort((a, b) => b[0].length - a[0].length);
  const fields = git('diff', '--numstat', '-z', '-M', `${base}...${state.head}`).split('\0');
  const areas = {}, total = { files: 0, added: 0, deleted: 0 };
  for (let i = 0; i < fields.length - 1; i++) {
    const [added, deleted, name] = fields[i].split('\t');
    // 改名时 -z 输出旧路径和新路径两个字段，按新路径归类。
    const file = name || fields[i += 2];
    const area = prefixes.find(([prefix]) => file.startsWith(prefix))?.[1] ?? (file.includes('/') ? file.split('/')[0] : '根目录');
    for (const group of [areas[area] ??= { files: 0, added: 0, deleted: 0 }, total]) {
      group.files++;
      group.added += added === '-' ? 0 : Number(added);
      group.deleted += deleted === '-' ? 0 : Number(deleted);
    }
  }
  const line = ({ files, added, deleted }) => `${files} 个文件 +${added} -${deleted}`;
  return [`改动：${line(total)}`, ...Object.entries(areas).sort(([, a], [, b]) => b.added + b.deleted - a.added - a.deleted).map(([area, group]) => `- ${area}：${line(group)}`)].join('\n');
};

// 合进泳道的泳道 PR，从 GitHub 读，按编号先后。
const lanePrs = () => {
  const merged = JSON.parse(gh('pr', 'list', '--base', state.lane, '--state', 'merged', '--limit', '200', '--json', 'number,title,url'));
  return merged.sort((a, b) => a.number - b.number).map(pr => `- ${pr.title}（${pr.url}）`).join('\n') || '（还没有合进泳道的泳道 PR）';
};

switch (action) {
  case 'resume':
    output('reason', state.feedback);
    break;
  case 'progress': {
    const { choice, note = '' } = JSON.parse(env.PROGRESS);
    const missing = !note.trim() && { submit: '提交验收必须在备注中写给用户的改动汇报。', pause: '暂停必须在备注中写为什么暂停、等什么。' }[choice];
    if (!missing) {
      if (choice === 'submit') state.report = note;
      state.feedback = '';
      save();
    }
    output('feedback', missing || '');
    output('route', missing ? 'progress' : choice);
    break;
  }
  case 'paused': {
    const { choice, note = '' } = JSON.parse(env.PAUSED);
    if (choice === 'continue') back(`用户在「需求已暂停」选了继续。${note.trim() ? `\n用户的话：\n${note}` : ''}`);
    output('route', choice);
    break;
  }
  // 开或更新泳道进目标分支的 PR：汇报、合进泳道的泳道 PR、改动区域。已开着的 PR 从 GitHub 找，不靠运行暂存。
  case 'pr': {
    git('fetch', 'origin', state.base);
    const base = git('rev-parse', 'FETCH_HEAD');
    git('fetch', 'origin', state.lane);
    state.head = git('rev-parse', 'FETCH_HEAD');
    const summary = `${state.report}\n\n泳道 PR：\n${lanePrs()}\n\n${changes(base)}`;
    const path = join(env.RUNNER_TEMP, 'pr.md');
    writeFileSync(path, summary);
    state.pr = gh('pr', 'list', '--head', state.lane, '--base', state.base, '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url');
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = openPr('--base', state.base, '--head', state.lane, '--title', state.title, '--body-file', path);
    save();
    output('checked', String(state.checks?.head === state.head));
    output('url', state.pr);
    output('head', state.head);
    output('base', base);
    output('lane', state.lane);
    output('summary', summary);
    output('task', `需求：${state.title}\n\n目标与完成标准：\n${state.goal}\n\n主 Agent 的汇报：\n${state.report}`);
    break;
  }
  case 'checks-passed':
    state.checks = { head: state.head, runs: JSON.parse(env.RUNS) };
    save();
    break;
  case 'github-checks': {
    const status = await waitForGitHubChecks(state.pr, state.head);
    if (status !== 0) process.exit(status);
    output('evidence', `项目检查：\n${checksText(state.checks, state.head)}\n合并前检查与 GitHub 检查已通过。`);
    break;
  }
  case 'check-failed':
    back(`${env.STEP}未通过，泳道 head ${state.head}。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请用 workflow_status 查看本运行「${env.STEP}」及其调用的失败流程，读取错误和日志；提泳道 PR 修好后再提交验收。`);
    break;
  case 'reviewed':
    output('reviews', reviewsText(env.REVIEWS, state.head, '评审整条泳道'));
    break;
  case 'review': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    if (choice === 'progress') back(`整体评审后主 Agent 选了回到进行中。${note.trim() ? `\n${note}` : ''}\n评审的发现与原文：${join(env.CODA_ARTIFACTS, 'reviews.md')}`);
    output('route', choice);
    break;
  }
  case 'preview': {
    const { choice, note = '' } = JSON.parse(env.PREVIEW);
    const missing = choice === 'progress' && !note.trim();
    if (choice === 'progress' && !missing) back(`安装预览版需处理：\n${note}`);
    output('feedback', missing ? '回到进行中必须在备注中写具体意见。' : '');
    output('route', missing ? 'preview' : choice === 'progress' ? 'progress' : 'device');
    break;
  }
  case 'device': {
    // 「不行」必须附言（写意见或附截图）；截图的路径随意见交回主 Agent，它能直接看。
    const { choice, note = '', attachments = [] } = JSON.parse(env.DEVICE);
    const missing = choice === 'no' && !note.trim() && !attachments.length;
    const files = attachments.length ? `附件：\n${attachments.map(path => `- ${path}`).join('\n')}` : '';
    if (choice === 'no' && !missing) back(`设备验收不通过：\n${[note.trim() && note, files].filter(Boolean).join('\n')}`);
    output('feedback', missing ? '选择「不行」必须写验收意见或附上截图。' : '');
    output('route', missing ? 'device' : choice === 'no' ? 'progress' : 'passed');
    break;
  }
  case 'delivery': {
    const { choice, note = '' } = JSON.parse(env.DELIVERY_RESULT);
    const missing = choice === 'revise' && !note.trim();
    if (choice === 'revise' && !missing) back(`所属需求退回修改：\n${note}`);
    output('feedback', missing ? '退回修改必须在备注中写具体意见。' : '');
    output('route', missing ? 'delivery' : choice === 'revise' ? 'progress' : 'merge');
    break;
  }
  // 批准卡：「暂不合并」带着原因回到进行中；「合并」记下勾了哪些合并后的流程（shared.mjs outputPicked）。
  case 'approval': {
    const answer = JSON.parse(env.APPROVAL);
    if (answer.choice === 'stop') back(`用户选了暂不合并：\n${answer.note ?? ''}`);
    output('route', answer.choice === 'stop' ? 'stop' : 'merge');
    outputPicked(answer, env.JOINERS);
    break;
  }
  case 'inputs':
    outputFilled();
    break;
  // 用合并提交进目标分支：目标分支的 first-parent 历史里一个需求一个提交，泳道里每个泳道 PR 一个提交。
  case 'merge': {
    const commit = mergedCommit(state.pr, state.head) ?? mergePr(state.pr, state.head, 'merge');
    if (!commit) {
      back(`PR ${state.pr} 与目标分支 ${state.base} 存在合并冲突，泳道 head ${state.head}。\n请发起 sync=true 的泳道 PR，让执行者把最新目标分支合进来、解冲突、顺延撞号的迁移版本；合进泳道后再提交验收，重新跑检查、批准合并及合并后的流程。`);
      output('route', 'conflict');
      break;
    }
    output('route', 'merged');
    output('commit', commit);
    break;
  }
  default: throw new Error(`未知开发步骤：${action}`);
}
