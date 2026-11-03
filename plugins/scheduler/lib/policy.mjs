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
  return [...entries].sort((a, b) => compare(a.creationSequence, b.creationSequence));
}

// Demand is empty or a single resource unit. Named groups have no remote mapping in this version.
const demand = spec => {
  const entries = Object.entries(spec.resources ?? {});
  if (entries.length > 1 || entries.some(([key, value]) => value !== 1 ||
    !(key === 'slots' || /^group:(?!host$)[^\s\u0000-\u001f\u007f]{1,100}$/.test(key)))) return null;
  const resource = entries[0]?.[0] ?? null;
  if ((spec.exclusiveResources ?? []).some(key => key !== resource)) return null;
  return { resource, exclusive: (spec.exclusiveResources ?? []).length > 0 };
};

// A scheduling estimate, never an admission lease. Pending assignments consume their one resource only;
// unmetered work (including a proven scope borrow) takes no extra slot.
export function budget(executors, executions) {
  const remaining = new Map(), admitted = new Map(), pending = new Map(), exclusive = new Set();
  const key = (id, resource) => JSON.stringify([id, resource]);
  for (const object of executions) {
    const { spec, status } = object, requested = demand(spec);
    if (!spec.executor || !requested?.resource || ['done', 'release'].includes(disposition(object))) continue;
    const k = key(spec.executor.id, requested.resource);
    if (requested.exclusive) exclusive.add(k);
    const counts = status.assignmentId === spec.assignmentId && status.admission ? admitted : pending;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const e of executors) {
    remaining.set(e.id, Object.fromEntries(Object.keys(e.status.capacity ?? {}).map(resource => {
      const k = key(e.id, resource);
      return [resource, exclusive.has(k) ? 0 : Math.max(0, Math.min(e.status.available?.[resource] ?? 0,
        (e.status.capacity?.[resource] ?? 0) - (admitted.get(k) ?? 0)) - (pending.get(k) ?? 0))];
    })));
  }
  return remaining;
}

export function choose(spec, executors, { local = new Set(), remaining = budget(executors, []), rejected = {} } = {}) {
  const requested = demand(spec);
  if (!requested) return queued('unsupported_resources', '只支持无资源或一个资源的一单位，可独占该资源');
  if (!executors.length) return queued('no_executor', '等待可见的运行器');
  const { resource, exclusive } = requested;
  const placed = executors.filter(e => (spec.placement?.locality !== 'local' || local.has(e.id)) &&
    (!spec.placement?.executor || (spec.placement.executor.kind === 'executor' && spec.placement.executor.id === e.id)));
  if (!placed.length) return queued('placement_unavailable', '指定执行环境不可用，保持原定位约束排队');
  const mapped = resource?.startsWith('group:') ? placed.filter(e => local.has(e.id)) : placed;
  if (!mapped.length) return queued('named_resource_local_only', '命名资源组目前只支持本机执行');
  const matching = mapped.filter(e => {
    const labels = new Set([...e.spec.labels, ...e.status.detectedLabels ?? []]);
    return spec.requirements.labels.every(label => labels.has(label));
  });
  if (!matching.length) return queued('labels_unavailable', '没有运行器满足全部需求标签');
  const accepting = matching.filter(e => e.spec.enabled && e.status.accepting === true);
  if (!accepting.length) return queued('not_accepting', '满足标签的运行器尚未报告接活或已停止接活');
  const capable = accepting.filter(e => (resource !== null || e.status.executionFeatures?.noResources === true) &&
    (!resource?.startsWith('group:') || e.status.executionFeatures?.namedResources === true) &&
    (!Object.keys(spec.context ?? {}).length || e.status.executionFeatures?.context === true));
  if (!capable.length) return queued('execution_features_unavailable', '运行器尚未声明支持这份请求的资源或运行上下文');
  const supported = capable.filter(e => !exclusive || e.status.executionFeatures?.exclusive === true);
  if (!supported.length) return queued('exclusive_unsupported', '满足标签的运行器不支持资源独占');
  const fresh = supported.filter(e => !Object.hasOwn(rejected, e.id) || rejected[e.id] !== e.revision);
  if (!fresh.length) return queued('admission_rejected', '运行器已拒绝本次分配，等待新的容量状态');
  const available = e => resource === null ? 0 : remaining.get(e.id)?.[resource] ?? 0;
  const candidates = fresh.filter(e => resource === null || (available(e) >= 1 &&
    (!exclusive || (e.status.occupied?.[resource] === 0 && available(e) === e.status.capacity?.[resource]))));
  if (!candidates.length) return queued('capacity', exclusive ? '等待可独占的空闲运行器' : '满足条件的运行器没有空闲名额');
  candidates.sort((a, b) => Number(local.has(b.id)) - Number(local.has(a.id)) || available(b) - available(a) || compare(a.id, b.id));
  return { action: 'bind', executor: { kind: 'executor', id: candidates[0].id } };
}
