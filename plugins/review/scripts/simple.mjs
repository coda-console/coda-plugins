// The steps of the simple development flow (../.coda/workflows/simple.bpmn「简易开发」) other than the review itself: the
// branch the lead agent hands its change in on, and what it hands in pushed from there to the run's own branch and opened as
// one pull request, updated by every later change. What the run has seen so far — the report, the head pushed, the review,
// what the user accepted on a device, what the agent is to change next — stays in the run's artifacts, every step's
// checkout being its own.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { json, output } from './step.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'simple.json');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const git = (...args) => run('git', args), gh = (...args) => run('gh', args);
const tryGit = (...args) => { const done = spawnSync('git', args, { encoding: 'utf8' }); return done.status === 0 ? done.stdout.trim() : null; };
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
const save = value => writeFileSync(statePath, JSON.stringify(value));
// What the agent is asked to change: kept for the next 「修改后答复」 (`problem`).
const ask = (value, text) => { save({ ...value, feedback: text }); output('feedback', text); };

const target = () => env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');

switch (action) {
  case 'lane': {
    // The agent that started the run names its branch (or works on its session's); given none, one is cut here from the
    // latest target for it, kept as it is when the run goes over this again. Only the branch: the agent opens its own
    // worktree on it, in the repository this step's checkout shares its branches with.
    if (env.BRANCH) { output('branch', env.BRANCH); output('made', 'false'); break; }
    const base = target(), branch = `agent/simple-${env.GITHUB_RUN_ID}`;
    git('fetch', '--quiet', 'origin', base);
    if (!tryGit('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) git('branch', '--no-track', branch, 'FETCH_HEAD');
    output('branch', branch);
    output('made', 'true');
    output('base', base);
    output('repo', dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir')));
    break;
  }
  case 'push': {
    // The first time, before a pull request: the report the agent wrote, which heads the pull request and the approval card.
    const now = state ?? { base: target(),
      lane: `simple/${env.GITHUB_RUN_ID}`, head: '', pr: '', reviewed: false, deviceHead: '' };
    if (!now.pr) now.report = (json('REPORT', {}).note ?? '').trim();
    const back = now.pr ? 'fix' : 'report', branch = env.BRANCH;
    git('fetch', '--quiet', 'origin', now.base);
    const head = tryGit('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`);
    if (!head) { ask(now, `读不到分支 ${branch}：请把改动提交到这个分支再答复。`); output('route', back); break; }
    if (git('rev-list', '--count', `FETCH_HEAD..${head}`) === '0') { ask(now, `分支 ${branch} 上没有比 ${now.base} 新的提交：请把改动提交到这个分支再答复。`); output('route', back); break; }
    if (head === now.head) { ask(now, `分支 ${branch} 上没有新的提交（还是 ${head}）：请修改并提交后再答复。`); output('route', 'fix'); break; }
    // The run's own branch: force, the agent may have rebased its branch onto the latest target.
    git('push', '--quiet', '--force', '--no-follow-tags', 'origin', `${head}:refs/heads/${now.lane}`);
    // The pull request is titled as the first commit of the change says.
    const title = now.title || git('log', '--reverse', '--format=%s', `FETCH_HEAD..${head}`).split('\n')[0];
    save({ ...now, head, title, feedback: '' });
    output('route', 'checks');
    output('feedback', '');
    output('head', head);
    output('lane', now.lane);
    break;
  }
  case 'failed': {
    const lines = (env.LINES ?? '').trim();
    ask(state, `${env.STEP}没通过，提交 ${state.head}。运行：coda://workflow-runs/${env.GITHUB_RUN_ID}，用 workflow_status 查看「${env.STEP}」调用的流程、失败的步骤和日志，查明原因修好。${lines ? `\n${lines}` : ''}`);
    break;
  }
  case 'problem':
    output('text', state.feedback);
    break;
  case 'reviewed': {
    const review = json('REVIEW', {});
    save({ ...state, reviewed: true, review: { line: review.line ?? '', report: review.report ?? '' } });
    break;
  }
  case 'kept':
    save({ ...state, kept: (json('ANSWER', {}).note ?? '').trim() });
    break;
  case 'pr': {
    const summary = [state.report, state.review ? `评审：${state.review.line}` : '', state.kept ? `没有照评审意见改的：\n${state.kept}` : ''].filter(Boolean).join('\n\n');
    const path = join(env.RUNNER_TEMP, 'pr.md');
    writeFileSync(path, [summary, state.review?.report ? `<details><summary>评审意见</summary>\n\n${state.review.report}\n\n</details>` : ''].filter(Boolean).join('\n\n'));
    const pr = state.pr ? (gh('pr', 'edit', state.pr, '--body-file', path), state.pr)
      : gh('pr', 'create', '--base', state.base, '--head', state.lane, '--title', state.title, '--body-file', path);
    save({ ...state, pr });
    output('url', pr);
    output('head', state.head);
    output('review', String(!state.reviewed));
    output('device', String(env.DEVICES === 'true' && state.deviceHead !== state.head));
    output('summary', summary);
    break;
  }
  case 'accepted': {
    // 「已修改」 while installing: what changed is pushed again; 「不行」 on the device: the note and the files go back to the agent.
    if (env.ROUTE === 'changed') { output('route', 'push'); break; }
    if (env.ROUTE === 'failed') {
      const { note = '', attachments = [] } = json('DEVICE', {});
      const files = attachments.length ? `附件：\n${attachments.map(path => `- ${path}`).join('\n')}` : '';
      ask(state, `设备验收不通过（提交 ${state.head}）：\n${[note.trim() && note, files].filter(Boolean).join('\n')}`);
      output('route', 'fix');
      break;
    }
    save({ ...state, deviceHead: state.head });
    output('route', 'premerge');
    break;
  }
  case 'merge': {
    // The run's own branch goes with the merge; --repo keeps gh off the local branches of the step's checkout.
    const url = new URL(state.pr), repo = `${url.host}/${url.pathname.split('/').slice(1, 3).join('/')}`;
    const method = ['merge', 'rebase', 'squash'].includes(env.METHOD) ? env.METHOD : 'squash';
    const done = spawnSync('gh', ['pr', 'merge', state.pr, '--repo', repo, `--${method}`, '--match-head-commit', state.head, '--delete-branch'], { encoding: 'utf8' });
    process.stdout.write(done.stdout ?? ''); process.stderr.write(done.stderr ?? '');
    const now = JSON.parse(gh('pr', 'view', state.pr, '--json', 'state,mergeable,mergeCommit'));
    if (now.state === 'MERGED') { output('route', 'merged'); output('commit', now.mergeCommit.oid); break; }
    if (now.state === 'OPEN' && now.mergeable === 'CONFLICTING') {
      ask(state, `PR ${state.pr} 与目标分支 ${state.base} 有冲突，没有合并。把最新的 ${state.base} 合入分支 ${env.BRANCH}，解决冲突、跑相关检查后提交；之后重跑项目检查、合并前检查，再请用户批准。`);
      output('route', 'conflict');
      break;
    }
    console.error(`没有合并 ${state.pr}：${(done.stderr || done.stdout || '').trim().split('\n').at(-1) || now.state}`);
    process.exit(done.status || 1);
  }
  default: throw new Error(`未知的简易开发步骤：${action}`);
}
