// Coda's own protocol of the directories registered here, `coda/project@1`: a directory as a record, its ID the project's,
// what is asked of a directory and not of a session or a workflow in it (#2749 3.5) its queries — its branches. Its records
// are read through from the `projects` table (Protocols.serve), as `coda/thread@1`'s are from `threads`: one for each
// directory not deleted, by its name, never its path; nothing is kept of them besides, they are no section and not in the
// record directory (one of another machine is not read).
import { createHash } from 'node:crypto';
import { canonical } from '../domain/values.mjs';

export const PROJECT = 'coda/project@1';

export const PROJECT_PROTOCOL = {
  kind: PROJECT,
  title: '目录',
  spec: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  status: { type: 'object', additionalProperties: false },
  operations: {
    // Its branches, the default first and the rest by latest commit, as a new session reads them (for a `branch` input):
    // `pending` while they are first read, `error` why they could not be.
    branches: { safe: true, input: { type: 'object', additionalProperties: false }, result: {
      type: 'object',
      properties: { branches: { type: 'array', items: { type: 'string', minLength: 1 } }, default: { type: 'string' }, pending: { type: 'boolean' },
        error: { type: 'string', minLength: 1 } },
      required: ['branches', 'default'],
      additionalProperties: false,
    } },
  },
  // What a plugin may ask for in its `uses` (docs/plugins.md「用到的权限」), on trial while the protocol is not stable.
  permissions: {
    read: { title: '查看目录名与分支', trial: true, read: true, operations: ['branches'] },
  },
};

const ROW = 'SELECT id, name, created_at, rowid AS sequence FROM projects WHERE deleted = 0';
const record = row => {
  if (!row) return null;
  const spec = { name: row.name }, status = {};
  return { kind: PROJECT, id: row.id, provider: 'coda', createdAt: new Date(row.createdAt).toISOString(), creationSequence: row.sequence, spec, status,
    revision: `${row.id}:${createHash('sha256').update(canonical([spec, status])).digest('hex').slice(0, 16)}` };
};
export const projectRecords = store => ({
  get: id => record(store.one(`${ROW} AND id = ?`, id)),
  list: () => store.all(`${ROW} ORDER BY created_at, rowid`).map(record),
});

// Its query through the unified call (components/protocols/calls.mjs `handle`): `branches`, read as the clients read them
// (`branches(projectId)`, SessionConfigService.branches, the same `GET /v1/projects/<id>/branches` answers with).
export function projectQueries(calls, { branches }) {
  calls.handle(PROJECT, 'branches', async ({ held }) => {
    const read = await branches(held.id);
    return { branches: read.branches, default: read.defaultRef ?? '', ...(read.pending ? { pending: true } : {}), ...(read.error ? { error: String(read.error.message ?? read.error) } : {}) };
  });
}
