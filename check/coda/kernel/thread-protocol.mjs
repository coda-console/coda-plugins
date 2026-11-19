// Coda's own protocol of its sessions, `coda/thread@1`: what a session is like, as a record. A session is called, sent to and
// archived through the orchestration on the call kernel (kernel/party.mjs, docs/product-architecture.md「经调用内核的调用」);
// a plugin asks of it where it works and what it changed there (`workspace`, `changes`, queries `threadQueries` answers), and
// adds to its composer's draft (`append-draft`, a doing operation the orchestration does, its `side`). Its directory's
// workflows (`workflows`) are a query the workflows define and answer, with a group of its own, added as the protocol is
// registered (application/assembly.mjs). Its records are the
// sessions here, read through from the `threads` table (Protocols.serve): nothing is kept of them besides, and they are no section.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { canonical } from '../domain/values.mjs';

export const THREAD = 'coda/thread@1';

const reference = {
  type: 'object',
  properties: { kind: { type: 'string' }, id: { type: 'string' } },
  required: ['kind', 'id'],
  additionalProperties: false,
};
// The payloads of its events (docs/session-contracts.md「事件」), as the kernel tells them (kernel/session-events.mjs,
// application/service.mjs sessionFacts, exited, settled) and the resumes say them (components/workflows/quota-resumes.mjs).
const string = { type: 'string' }, boolean = { type: 'boolean' }, nullable = type => ({ type: [type, 'null'] });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', required, properties });
// Opened: its project, its parent here, whether it works in a worktree, its agent.
const opened = object({ projectId: string, parentThreadId: nullable('string'), worktree: boolean, agent: string });
// What only Coda observes of it; `observing`, `quietSince`'s clock and the ledger's items as sessionFacts gives them.
const facts = object({
  input: boolean, busy: boolean, background: boolean, observing: boolean, waiting: boolean, scheduled: boolean, looping: boolean,
  live: boolean, archived: boolean, worktree: boolean, onDisk: boolean,
  waits: { type: 'array', items: object({ kind: string, key: string, actor: { enum: ['user', 'system'] }, since: { type: 'integer' },
    dueAt: nullable('integer'), input: string, holder: string, awaited: { const: false }, overdue: { const: true } }, ['kind', 'key', 'actor', 'since', 'dueAt']) },
  waitsForSystem: boolean, unread: { type: 'integer', minimum: 0 }, overdue: boolean, quietSince: nullable('integer'), pinned: boolean,
  usage: nullable('object'),
});
// A turn that failed so: its project, the turn and what it failed with — the input's quota spent (`failure` as the agent
// said it, `resetAt` kept), or its agent's process gone under it (the turn's, none when the agent said nothing).
const quotaSpent = object({ projectId: string, turnId: string, failure: { type: 'object' } });
const exited = object({ projectId: string, turnId: string, failure: nullable('object') });
// The resume of such a turn, under `key`: the failed turn's, its session, what the session is to go on with (`text`, and the
// input and how when it is sent again: domain/resume-prompt.mjs) and when (an ISO time) — always for a process gone, only when it
// resumes by itself for a quota spent — and, for a process gone, which resume in a row it is.
const resume = (key, turn, more, required) => object({ [key]: object({ ...turn.properties, threadId: string, text: string, input: string,
  how: { enum: ['original', 'verify'] }, resumeAt: string, ...more },
  [...turn.required, 'threadId', 'text', ...required]) });

export const THREAD_PROTOCOL = {
  kind: THREAD,
  title: '会话',
  // A session's directory, and its parent here when it has one (a step's session reports to a run; S4c's `reported_to`).
  spec: {
    type: 'object',
    properties: { project: { type: 'string' }, parent: reference },
    additionalProperties: false,
  },
  // Its title, whether it is archived itself and whether its family's root is, its agent, and the turn of it that ended last
  // (null before any has): another one ending moves it, however soon after the next begins.
  status: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      archived: { type: 'boolean' },
      familyArchived: { type: 'boolean' },
      agent: { type: 'string' },
      lastTurn: { type: ['string', 'null'] },
    },
    additionalProperties: false,
  },
  operations: {
    // Where the session works and in which project: its checkout's state, `gone` for one ready whose directory is no more,
    // and its path only while it is ready.
    workspace: { safe: true, input: { type: 'object', additionalProperties: false }, result: {
      type: 'object',
      properties: {
        path: { type: ['string', 'null'] },
        project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
        state: { enum: ['preparing', 'ready', 'failed', 'gone'] },
      },
      required: ['path', 'project', 'state'],
      additionalProperties: false,
    } },
    // What it changed in its worktree (docs/session-contracts.md「变更」): where it works (`kind`), and in a worktree of its
    // own every file since its base commit (`base`, its ref and commit), with its lines, none cut (adapters/worktree-changes.mjs);
    // a file's diff is the stream `diff`'s.
    changes: { safe: true, input: { type: 'object', additionalProperties: false }, result: {
      type: 'object',
      properties: {
        available: { type: 'boolean' }, kind: { type: 'string' },
        base: { type: 'object', properties: { ref: { type: ['string', 'null'] }, commit: { type: 'string' } }, required: ['ref', 'commit'], additionalProperties: false },
        files: { type: 'array' }, count: { type: 'integer' }, additions: { type: 'integer' }, deletions: { type: 'integer' },
      },
      required: ['available', 'kind'],
      additionalProperties: false,
    } },
    // Text added at the end of its composer's draft: after a space, or on a line of its own (`line`), when the draft has text.
    'append-draft': { input: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 }, line: { type: 'boolean' } },
      required: ['text'],
      additionalProperties: false,
    }, result: { type: 'object', additionalProperties: false } },
  },
  // Its worktree's diff from the base as Git writes it, not cut (`text/x-diff`; ProductService.diff), or with `path` that
  // of a file `changes` lists, by its whole path (transport/record-streams.mjs).
  streams: {
    diff: { input: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, additionalProperties: false } },
  },
  // What Coda tells of its sessions (docs/session-contracts.md「事件」), each about the session (`thread:<id>`) but for the two
  // resumes, which are of the turn they go on from (components/workflows/quota-resumes.mjs). In no permission group: open to no
  // plugin's module; a workflow takes one by its name.
  events: {
    'session.opened': { payload: opened },
    'session.facts': { payload: facts },
    'session.quota_exhausted': { payload: quotaSpent },
    'session.agent_exited': { payload: exited },
    'session.quota_resume': { payload: resume('quota', quotaSpent, {}, []) },
    'session.exit_resume': { payload: resume('exit', exited, { attempt: { type: 'integer', minimum: 1 } }, ['attempt', 'resumeAt']) },
  },
  // What a plugin may ask for in its `uses` (docs/plugins.md「用到的权限」), on trial while the protocol is not stable.
  permissions: {
    read: { title: '查看你的会话：标题、所在目录、用的 Agent 与是否归档', trial: true, read: true },
    workspace: { title: '查看会话的工作目录与所在项目', trial: true, operations: ['workspace'] },
    changes: { title: '查看会话里改了哪些文件和完整改动内容', trial: true, operations: ['changes'], streams: ['diff'] },
    'append-draft': { title: '往会话的输入框末尾追加文字', trial: true, operations: ['append-draft'] },
  },
  // Its doing operations are the orchestration's, on the backend that holds the session (kernel/party.mjs).
  side: 'orchestration',
};

// The record of each session here: one per row of `threads`, its envelope from the row, and what it is like — its directory
// and parent, its title, whether it or its family's root is archived, its agent, the turn of it that ended last. Its revision is what those say.
const ROW = `SELECT t.id, t.project_id, t.parent_thread_id, t.title, t.archived, t.created_at, t.rowid AS sequence, p.agent,
    (SELECT id FROM turns WHERE thread_id = t.id AND ended_at IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1) AS last_turn
  FROM threads t JOIN participants p ON p.id = t.participant_id`;
const record = (store, row) => {
  if (!row) return null;
  const spec = { project: row.projectId, ...(row.parentThreadId ? { parent: { kind: THREAD, id: row.parentThreadId } } : {}) };
  const status = { title: row.title, archived: !!row.archived, familyArchived: !!store.familyRoot(row.id).archived, agent: row.agent, lastTurn: row.lastTurn ?? null };
  return { kind: THREAD, id: row.id, provider: 'coda', createdAt: new Date(row.createdAt).toISOString(),
    creationSequence: row.sequence, spec, status,
    revision: `${row.id}:${createHash('sha256').update(canonical([spec, status])).digest('hex').slice(0, 16)}` };
};
// All of them are read a page at a time by ID, as the table is never read whole.
export const threadRecords = store => ({
  get: id => record(store, store.one(`${ROW} WHERE t.id = ?`, id)),
  list: () => {
    const records = [];
    for (let after = ''; ;) {
      const page = store.all(`${ROW} WHERE t.id > ? ORDER BY t.id LIMIT 64`, after);
      if (!page.length) return records;
      records.push(...page.map(row => record(store, row))); after = page.at(-1).id;
    }
  },
});

// The queries of Coda's sessions here, through the unified call (components/protocols/calls.mjs `handle`): `workspace`,
// read from the session's checkout and project; `changes`, as the session's changes are read (`changes(threadId)`,
// ProductService.changes); and its stream `diff` (`calls.stream`), the same changes as the worktree's whole diff in the
// bytes Git writes it (`diff(threadId, { path }, signal)`, ProductService.diff).
export function threadQueries(calls, { store, changes, diff }) {
  calls.handle(THREAD, 'workspace', ({ held }) => {
    const thread = store.thread(held.id), checkout = store.checkout(thread.checkoutId), project = store.project(thread.projectId);
    const state = checkout.state === 'ready' && !existsSync(checkout.path) ? 'gone' : checkout.state;
    return { path: state === 'ready' ? checkout.path : null, project: { id: project.id, name: project.name }, state };
  });
  calls.handle(THREAD, 'changes', ({ held }) => changes(held.id));
  calls.stream(THREAD, 'diff', ({ record, input, signal }) => diff(record.id, input, signal));
}
