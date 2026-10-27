// Merges the pull request (../.coda/workflows/pull-request.bpmn「合并」) as the user approved: hands GitHub the commit that
// passed review, merged the way the plugin's setting says. With --match-head-commit GitHub refuses once the branch has
// moved on, so a version pushed since is never merged unreviewed; nothing is left to GitHub's auto-merge, which would
// merge a version pushed later. Only into the repository's default branch, as GitHub has the base now: Coda hears that a
// base changed only when it next looks, which may be after the user approved. Not merged (based elsewhere, a conflict, a
// draft, checks not passed) is no failure of the step: it is put out (`refused`, and the `reason`) for the session that
// opened the pull request to deal with. What the user chose
// to follow the merge is put out for the process (`deploy`, `release`, `releaseKinds`, `notify`).
import { spawnSync } from 'node:child_process';
import { baseOf, json, output, summary } from './step.mjs';

const approved = json('APPROVED', {}) ?? {};
const options = approved.options ?? {};
const chosen = id => options[id] === true;
const url = process.env.URL, head = process.env.HEAD, method = ['merge', 'rebase', 'squash'].includes(process.env.METHOD) ? process.env.METHOD : 'squash';
const number = /\/pull\/(\d+)/.exec(url ?? '')?.[1];
if (!number || !/^[0-9a-f]{40,64}$/.test(head ?? '')) { console.error('不知道要合并哪个 PR 的哪个提交'); process.exit(1); }
output('deploy', chosen('deploy'));
output('release', chosen('preview') || chosen('release'));
output('releaseKinds', ['preview', 'release'].filter(chosen).join(','));
output('notify', chosen('notify'));
const what = ['合并', ...[['deploy', '部署'], ['preview', '发布预览版'], ['release', '发布正式版'], ['notify', '全部完成后通知 Agent']].filter(([id]) => chosen(id)).map(([, name]) => name)].join(' · ');

const based = await baseOf(url);
const elsewhere = based.error ?? (based.base !== based.main ? `base 是 ${based.base}，不是默认分支 ${based.main}；Coda 得知 base 变了后从头再看` : null);
const done = elsewhere ? null : spawnSync('gh', ['pr', 'merge', url, `--${method}`, '--match-head-commit', head], { encoding: 'utf8' });
const merged = done?.status === 0;
const reason = elsewhere ?? ((done.stderr || done.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join('\n') || '未知原因');
output('merged', merged);
output('refused', !merged);
output('reason', merged ? '' : reason);
const text = merged ? `按你的选择「${what}」以 ${method} 方式把提交 ${head.slice(0, 12)} 交给 GitHub 合并。`
  : `没有合并提交 ${head.slice(0, 12)}：${reason}\n\n交给开 PR 的会话处理；它推送的新版本评审通过后按你的选择「${what}」合并。`;
console.log(text);
summary(`## 合并 PR #${number}\n\n${text}`);
