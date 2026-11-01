// Each registration has its own immutable file: cleanup never rewrites a list that bind may be appending to.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
