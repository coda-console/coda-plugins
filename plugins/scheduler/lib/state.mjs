import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Rejected offers only. Creation order is authoritative envelope data, never plugin-owned state.
export class SchedulingState {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.root = root; this.path = join(root, 'scheduling.json');
    try { this.data = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { entries: {} }; }
    if (!this.data.entries || typeof this.data.entries !== 'object' || Array.isArray(this.data.entries)) {
      throw new Error('scheduler 持久状态无效');
    }
  }
  save(data) {
    const fd = openSync(`${this.path}.tmp`, 'w', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(data)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.path}.tmp`, this.path);
    const directory = openSync(this.root, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    this.data = data;
  }
  get(object) { return Object.hasOwn(this.data.entries, object.instance) ? this.data.entries[object.instance] : undefined; }
  reject(object, executor) {
    if (this.get(object)?.lastRejected === object.spec.assignmentId) return;
    const data = structuredClone(this.data);
    if (!this.get(object)) {
      // This private copy is committed only after the complete refusal record reaches disk.
      Object.defineProperty(data.entries, object.instance, { enumerable: true, configurable: true, writable: true,
        value: { rejected: {}, lastRejected: null } });
    }
    const entry = data.entries[object.instance];
    entry.lastRejected = object.spec.assignmentId;
    // Remember before clearing the binding. A restart must not immediately pick the same rejected offer.
    Object.defineProperty(entry.rejected, object.spec.executor.id, { enumerable: true, configurable: true, writable: true,
      value: executor?.revision ?? null });
    this.save(data);
  }
  retain(instances) {
    const data = structuredClone(this.data); let changed = false;
    for (const instance of Object.keys(data.entries)) if (!instances.has(instance)) {
      delete data.entries[instance]; changed = true;
    }
    if (changed) this.save(data);
  }
}
