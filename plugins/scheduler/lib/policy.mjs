const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const queued = (code, message) => ({ action: 'queue', reason: { code, message } });

// Only a terminal answer for this exact assignment proves it will not start.
// queued, absent startedAt, disappearance and an old answer are not such proof.
export function disposition({ spec, status }) {
  if (!spec.executor) {
    if (status.phase === 'finished' && status.assignmentId === null) return 'done';
    return spec.cancel ? 'cancel' : 'schedule';
  }
  if (status.assignmentId !== spec.assignmentId) return 'observe';
  if (status.phase !== 'finished') return 'observe';
  if (status.outcome === 'rejected' && !status.startedAt) return 'release';
  return 'done';
}

export function inOrder(entries) {
  return [...entries].sort((a, b) => compare(a.order, b.order) || compare(a.object.id, b.object.id));
}

// Consume only reported facts. This is a scheduling estimate, never an admission lease.
// Pending local assignments reduce the estimate until the executor reports admission.
export function budget(executors, executions) {
  const remaining = new Map(executors.map(e => [e.id, e.status.available?.slots ?? 0]));
  const admitted = new Map(), pending = new Map(), exclusive = new Set();
  for (const object of executions) {
    const { spec, status } = object;
    if (!spec.executor || disposition(object) === 'done' || disposition(object) === 'release') continue;
    const id = spec.executor.id;
    if (spec.exclusiveResources?.includes('slots')) exclusive.add(id);
    const counts = status.assignmentId === spec.assignmentId && status.admission ? admitted : pending;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const e of executors) remaining.set(e.id, exclusive.has(e.id) ? 0 : Math.max(0,
    Math.min(remaining.get(e.id), (e.status.capacity?.slots ?? 0) - (admitted.get(e.id) ?? 0)) - (pending.get(e.id) ?? 0)));
  return remaining;
}

export function choose(spec, executors, { local = new Set(), remaining = budget(executors, []), rejected = {} } = {}) {
  if (Object.keys(spec.resources).length !== 1 || spec.resources.slots !== 1 ||
      (spec.exclusiveResources ?? []).some(key => key !== 'slots')) {
    return queued('unsupported_resources', '首版只支持 slots: 1，可独占 slots');
  }
  if (!executors.length) return queued('no_executor', '等待可见的运行器');
  const matching = executors.filter(e => {
    const labels = new Set([...e.spec.labels, ...e.status.detectedLabels ?? []]);
    return spec.requirements.labels.every(label => labels.has(label));
  });
  if (!matching.length) return queued('labels_unavailable', '没有运行器满足全部需求标签');
  const accepting = matching.filter(e => e.spec.enabled && e.status.accepting === true);
  if (!accepting.length) return queued('not_accepting', '满足标签的运行器尚未报告接活或已停止接活');
  const exclusive = spec.exclusiveResources?.includes('slots');
  const supported = accepting.filter(e => !exclusive || e.status.executionFeatures?.exclusive === true);
  if (!supported.length) return queued('exclusive_unsupported', '满足标签的运行器不支持 slots 独占');
  const fresh = supported.filter(e => !Object.hasOwn(rejected, e.id) || rejected[e.id] !== e.revision);
  if (!fresh.length) return queued('admission_rejected', '运行器已拒绝本次分配，等待新的容量状态');
  const candidates = fresh.filter(e => {
    const available = remaining.get(e.id) ?? 0;
    return available >= 1 && (!exclusive || (e.status.occupied?.slots === 0 && available === e.status.capacity?.slots));
  });
  if (!candidates.length) return queued('capacity', exclusive ? '等待可独占的空闲运行器' : '满足条件的运行器没有空闲名额');
  candidates.sort((a, b) => Number(local.has(b.id)) - Number(local.has(a.id)) ||
    remaining.get(b.id) - remaining.get(a.id) || compare(a.id, b.id));
  return { action: 'bind', executor: { kind: 'executor', id: candidates[0].id } };
}
