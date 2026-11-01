import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './workspace.mjs';

export const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const identity = object => digest(canonical([object.id, object.instance, object.spec.assignmentId]));
export function taskFingerprint(spec) { const { cancel, ...frozen } = spec; return digest(canonical(frozen)); }

// The claim is durable before any admission or process launch. An unfinished claim is recovered, never rerun.
export class Journal {
  constructor(root) { this.root = join(root, 'attempts'); mkdirSync(this.root, { recursive: true }); }
  directory(key) { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('无效执行记录'); return join(this.root, key); }
  get(key) { try { return JSON.parse(readFileSync(join(this.directory(key), 'record.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
  list() { return readdirSync(this.root).filter(key => /^[a-f0-9]{64}$/.test(key)).map(key => this.get(key)).filter(Boolean); }
  save(record) {
    const directory = this.directory(record.key); mkdirSync(directory, { recursive: true });
    const temporary = join(directory, 'record.tmp'), target = join(directory, 'record.json');
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    return record;
  }
}
