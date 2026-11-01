// Each registration has its own immutable file: cleanup never rewrites a list that bind may be appending to.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function registerSimulator(state, udid, runId) {
  const directory = join(state, 'simulator-registrations');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${randomUUID()}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ udid, runId: runId || null }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function registrations(state) {
  const directory = join(state, 'simulator-registrations');
  let names;
  try { names = readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.json')).flatMap(name => {
    const file = join(directory, name);
    try { return [{ ...JSON.parse(readFileSync(file, 'utf8')), file }]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

// CODA_PLUGIN_STATE is <instance root>/plugins/host. Read only this instance's ledger; a missing
// run, an unreadable database, or a changed schema is never evidence that its simulators are idle.
export function runFinished(state, runId) {
  if (!runId || typeof runId !== 'string') return false;
  const db = new DatabaseSync(join(state, '..', '..', 'product.sqlite'), { readOnly: true });
  try {
    const run = db.prepare('SELECT state FROM workflow_runs WHERE id = ?').get(runId);
    if (!['succeeded', 'failed', 'cancelled'].includes(run?.state)) return false;
    // Even a terminal run can still be draining an interrupted command or hold.
    return !db.prepare("SELECT 1 FROM workflow_jobs WHERE run_id = ? AND state IN ('queued', 'running') LIMIT 1").get(runId)
      && !db.prepare("SELECT 1 FROM group_holds WHERE run_id = ? AND state IN ('held', 'leaving') LIMIT 1").get(runId);
  } finally { db.close(); }
}
