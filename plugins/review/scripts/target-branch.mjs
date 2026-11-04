import { spawnSync } from 'node:child_process';
import { json } from './step.mjs';

const target = (json('CODA_PLUGIN_SETTINGS', {})['review.targetBranch'] ?? '').trim();
if (target) console.log(target);
else {
  const done = spawnSync('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { encoding: 'utf8' });
  const branch = done.stdout?.trim();
  if (done.status !== 0 || !branch || branch === 'null') {
    console.error(`读不到仓库默认分支：${done.error?.message || done.stderr?.trim() || '没有读到分支名'}`);
    process.exit(1);
  }
  console.log(branch);
}
