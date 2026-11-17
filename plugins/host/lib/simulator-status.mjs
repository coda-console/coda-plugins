// Whether a workflow run is over, for the cleanup step to ask through the provider's `self` operation. Only the module
// has coda.api: it asks the supported workflow endpoint afresh, never reads Coda's storage or caches eligibility.
// Coda publishes terminal run states after winding down the run and its children.
export async function runFinished(coda, runId) {
  if (!runId || typeof runId !== 'string') return false;
  const run = await coda.api(`workflow-runs/${encodeURIComponent(runId)}`);
  return ['succeeded', 'failed', 'cancelled'].includes(run.state);
}
