// What agy 1.5.15 keeps of the sub-agents of a session, as plain JSON under the session's `.system_generated` (read only):
//   subagents/<child id>.json   {conversationId, subagentDescriptor: {typeName, role}, state: SUBAGENT_STATE_ALIVE | SUBAGENT_STATE_KILLED, ...}
//   messages/<id>.json          the inbox of a conversation: {sender, content, sourceMetadata: {tool: {toolCall: {name}}}, ...}
//                               the system's note that a child has nothing more to do is "Subagent <child id> has gone idle. ..."
//                               from sender "system"; the first message in a child's own inbox is its launch (the parent's
//                               `invoke_subagent` call, content = prompt). What a child itself sends to its parent (progress, a
//                               question, its report) is not told apart from one another, so it ends nothing.
// Reading those two (and not agy's SQLite database, which a launch is also written to) is what T3 Code's AntigravityChildWork.ts
// does for "detached" children, too. Whatever cannot be read is as if it was not there.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ALIVE = 'SUBAGENT_STATE_ALIVE';
export const KILLED = 'SUBAGENT_STATE_KILLED';
const ID = /^[\w-]{1,64}$/;
const IDLE = /^Subagent ([\w-]{1,64}) has gone idle\./;

const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const names = dir => { try { return readdirSync(dir); } catch { return []; } };

// The children of the session whose `.system_generated` is `dir`: id -> record.
export function children(dir) {
  const found = new Map();
  for (const name of names(join(dir, 'subagents'))) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    const record = ID.test(id) ? json(join(dir, 'subagents', name)) : null;
    if (typeof record?.state === 'string' && (record.conversationId ?? id) === id) found.set(id, record);
  }
  return found;
}

// The ids of the children the system says are idle, in the messages not in `seen` (which gains them). A message that is not whole
// yet is read again next time.
export function idled(dir, seen) {
  const from = new Set();
  for (const name of names(join(dir, 'messages'))) {
    if (!name.endsWith('.json') || name === 'read.json' || seen.has(name)) continue;
    const message = json(join(dir, 'messages', name));
    if (!message) continue;
    seen.add(name);
    if (message.sender === 'system' && typeof message.content === 'string') { const idle = IDLE.exec(message.content); if (idle) from.add(idle[1]); }
  }
  return from;
}

// What the parent asked a child to do: the content of the `invoke_subagent` message in the child's inbox (`dir` is the child's).
export function launch(dir, parent) {
  for (const name of names(join(dir, 'messages'))) {
    const message = name.endsWith('.json') && name !== 'read.json' ? json(join(dir, 'messages', name)) : null;
    if (message?.sender === parent && message.sourceMetadata?.tool?.toolCall?.name === 'invoke_subagent' && typeof message.content === 'string') return message.content;
  }
  return '';
}
