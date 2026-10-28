// What a step needs of where it runs, written as labels (`coda:runsOn`, GitHub's runs-on; components/workflows/workflow-executors.mjs).
import { requireCondition as check } from '../../domain/errors.mjs';

// One label: what a machine lists of itself is held to it too (workflow-executors.mjs).
export const LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;
// Labels as one set: each as written, once, in order — the key a binding is kept under. `code`: what is wrong when they
// are not labels (a workflow's, or a request's).
export function executorLabels(value, where, code = 'invalid_input') {
  const labels = (Array.isArray(value) ? value : String(value ?? '').split(',')).map(label => String(label).trim());
  check(labels.length <= 10 && labels.every(label => LABEL.test(label)), code,
    `${where} 写逗号分隔的标签（小写字母、数字与 . _ -，至多 10 个），如 linux,x64`);
  return [...new Set(labels)].sort();
}
