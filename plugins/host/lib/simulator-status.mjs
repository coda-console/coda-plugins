// Whether a workflow run is over, for the cleanup step to ask through the provider's `self` operation. It reads the run's
// `coda/workflow-run@1` record afresh each time (the record's ID is the run's ID; `status.state` is where the run stands),
// never caches eligibility. Coda publishes terminal run states after winding down the run and its children.
// A run Coda has no record of is an error, not an answer: cleanup never guesses.
export async function runFinished(coda, runId) {
  if (!runId || typeof runId !== 'string') return false;
  const run = await coda.get({ kind: 'coda/workflow-run@1', id: runId });
  if (!run) throw new Error('运行不存在或宿主暂不可用');
  return ['succeeded', 'failed', 'cancelled'].includes(run.status?.state);
}
