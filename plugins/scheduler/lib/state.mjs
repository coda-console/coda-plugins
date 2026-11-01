import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Scheduling metadata only. Execution status and admission remain owned by their providers.
export class SchedulingState {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.root = root; this.path = join(root, 'scheduling.json');
    try { this.data = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { next: 0, entries: {} }; }
    if (!Number.isSafeInteger(this.data.next) || this.data.next < 0 || !this.data.entries || typeof this.data.entries !== 'object') {
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
  remember(object) {
    if (!this.get(object)) {
      const data = structuredClone(this.data);
      Object.defineProperty(data.entries, object.instance, { enumerable: true, configurable: true, writable: true,
        value: { order: ++data.next, rejected: {}, lastRejected: null } });
      this.save(data);
    }
    return this.get(object);
  }
  reject(object, executor) {
    if (this.remember(object).lastRejected === object.spec.assignmentId) return;
    const data = structuredClone(this.data), entry = data.entries[object.instance];
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
