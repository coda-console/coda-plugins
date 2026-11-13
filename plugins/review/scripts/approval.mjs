// Records the user's approval to merge (../.coda/workflows/pull-request.bpmn「记下批准」, simple.bpmn): when (`at`: a review
// asking for changes later voids it), and what they chose to follow the merge: `deleteBranch`, `notify`, and the workflows
// joining the hook `merged` they ticked (JOINERS is the list hook-joiners gave the card): `only`, their names as JSON for
// run-workflows; `inputs`, the text the card took for them; `missing`, the ids (comma separated) of the inputs they ask
// for that the card left empty, and `asks`, a line for each, in the same order, saying which of them asks. `what` is the
// choice as the merge step says it. Put out here, not by the merge step, so that the process follows the choice however it
// hears of the merge: after the merge step, or from GitHub while that step still runs.
//
// With `inputs`, after the merge: what run-workflows gives them, the card's text and what the session wrote for each of
// `missing` (FILLS, one task each, in order); one written with no text fails the step, naming it.
import { json, output } from './step.mjs';

if (process.argv[2] === 'inputs') {
  const inputs = json('INPUTS', {}), ids = (process.env.MISSING || '').split(',').filter(Boolean);
  const fills = json('FILLS', []), asks = (process.env.ASKS || '').split('\n');
  ids.forEach((id, i) => {
    const text = String(fills[i]?.note ?? '').trim();
    if (!text) { console.error(`${asks[i] || id}：没有填写，不运行合并后的流程`); process.exit(1); }
    inputs[id] = text;
  });
  output('inputs', JSON.stringify(inputs));
  process.exit(0);
}

const answer = json('APPROVED', {}), options = answer.options ?? {}, written = answer.inputs ?? {};
const chosen = id => options[id] === true;
const ticked = json('JOINERS', []).filter(joiner => chosen(joiner.id)), inputs = {}, missing = new Map();
for (const joiner of ticked) for (const { id, label } of joiner.inputs ?? []) {
  const text = String(written[id] ?? '').trim();
  if (text) inputs[id] = text;
  else (missing.get(id) ?? missing.set(id, { label, for: [] }).get(id)).for.push(joiner.name);
}
output('at', Date.now());
output('deleteBranch', chosen('deleteBranch'));
output('notify', chosen('notify'));
output('only', JSON.stringify(ticked.map(joiner => joiner.id)));
output('inputs', JSON.stringify(inputs));
output('missing', [...missing.keys()].join(','));
output('asks', [...missing.values()].map(m => `「${m.label}」：${m.for.join('、')}要`).join('\n'));
output('what', ['合并', ...(chosen('deleteBranch') ? ['合并后删除远程分支'] : []), ...ticked.map(joiner => joiner.name),
  ...(chosen('notify') ? ['全部完成后通知 Agent'] : [])].join(' · '));
