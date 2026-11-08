// The commands of the call protocol (docs/subagent-design.md「完成唤醒契约」) that carry nothing of how a session runs: what a
// session sends to a child it called, here or through an extension.
import { createHash } from 'node:crypto';
import { canonical, keys, object, text } from '../domain/values.mjs';

// The resource kinds Coda's own resources are named by until they are protocols (components/protocols/core-operations.mjs).
export const AGENTS = 'agents';
export const THREADS = 'threads';
export const GROUPS = 'groups';

// A delivery `d` (an SQL alias) that is a parent's call of its child — not a message another session sent it (store
// acceptSessionMessage, #1904「回复权」), which is a call too, though its sender is no parent of it: what a child's card and
// runs, the count of children at work and the ledger's wait on a child are read from.
export const PARENTS_CALL = d => `${d}.message = 0`;

// A UUID derived from the parts that name a call: the same parts make the same one, so a retry finds its call and the
// child it opened, and two parents naming the same request are two calls.
export function derivedUUID(...parts) {
  const hex = createHash('sha256').update(canonical(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// The input of `agents`/`spawn`, as the operation takes it (components/protocols/core-operations.mjs) and as a call here and
// one to another backend are made with: the child's project and worktree, its agent's settings, title and first task, and
// how its parent is shown. `parentUnattended`: the parent's own approval is unattended, which the callee hands on.
export function spawnInput({ projectId, threadId, title, text, settings, checkout, parentTitle, parentUnattended }) {
  return { projectId, threadId, title, text, ...(settings === undefined ? {} : { settings }),
    ...(checkout === undefined ? {} : { checkout }), parentTitle, parentUnattended };
}

// A session elsewhere is named by an extension's reference, which may end in a message anchor (docs/peers.md「引用」):
// longer than an ID.
export function childSend(value) {
  object(value, 'send');
  keys(value, ['turn', 'requestId', 'childId', 'prompt']);
  return { turn: text(value.turn, 'turn', 100), requestId: text(value.requestId, 'requestId', 100),
    childId: text(value.childId, 'childId', 300), prompt: text(value.prompt, 'prompt', 100_000) };
}

// How a call to a child on another machine stands, as the backend that holds the child writes it in the run's `progress`
// (components/protocols/calls.mjs): what its session does (`activity`), the card it waits on for the call (`input`, or
// null) and when what it waits on is due (`dueAt`). Of the card, whether that session has given it its turn and handed it
// up (`passed`, kernel/waits.mjs heldBy): until it has, nobody above sees to it. What does not read is left out: kept as it
// is said, it is read the same way on both machines.
export function standingSaid(value) {
  const on = value?.input;
  const input = on && typeof on === 'object' && ['requestId', 'threadId', 'kind', 'title', 'answers'].every(key => typeof on[key] === 'string')
    ? { requestId: on.requestId, threadId: on.threadId, kind: on.kind, title: on.title, answers: on.answers, passed: on.passed === true,
      ...(on.card && typeof on.card === 'object' ? { card: on.card } : {}) } : null;
  return { activity: typeof value?.activity === 'string' ? value.activity : null,
    input, dueAt: Number.isSafeInteger(value?.dueAt) ? value.dueAt : null };
}
