// Records the user's approval to merge (../.coda/workflows/pull-request.bpmn「记下批准」): when (`at`: a review asking for
// changes later voids it), and what they chose to follow the merge (`deleteBranch`, `deploy`, `release`, `releaseKinds`,
// `notify`, and `what`, the choice as the merge step says it). Put out here, not by the merge step, so that the process
// follows the choice however it hears of the merge: after the merge step, or from GitHub while that step still runs.
import { json, output } from './step.mjs';

const options = (json('APPROVED', {}) ?? {}).options ?? {};
const chosen = id => options[id] === true;
output('at', Date.now());
output('deleteBranch', chosen('deleteBranch'));
output('deploy', chosen('deploy'));
output('release', chosen('preview') || chosen('release'));
output('releaseKinds', ['preview', 'release'].filter(chosen).join(','));
output('notify', chosen('notify'));
output('what', ['合并', ...[['deleteBranch', '合并后删除远程分支'], ['deploy', '部署'], ['preview', '发布预览版'], ['release', '发布正式版'], ['notify', '全部完成后通知 Agent']]
  .filter(([id]) => chosen(id)).map(([, name]) => name)].join(' · '));
