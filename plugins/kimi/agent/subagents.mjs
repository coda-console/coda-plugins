import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

function toolKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (['bash', 'terminal', 'sh', 'exec', 'command'].includes(n)) return 'execute';
  if (['read', 'cat', 'view'].includes(n)) return 'read';
  if (['write', 'edit', 'replace'].includes(n)) return 'edit';
  return 'other';
}

// What one of Kimi's loop events says, as an ACP update: a thought, a reply, a tool call or a call's result; null for what
// says nothing. `messageId` names a thought or reply, `toolCallId` the call, in the session it is told in.
export function loopUpdate(event, { messageId, toolCallId }) {
  const type = event?.type;
  if (type === 'content.part' && event.part) {
    const part = event.part;
    if (part.type === 'think' && typeof part.think === 'string' && part.think.trim())
      return { sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: part.think } };
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim())
      return { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: part.text } };
  } else if (type === 'tool.call' && event.toolCallId) {
    return { sessionUpdate: 'tool_call', toolCallId, title: event.name ?? '工具', kind: toolKind(event.name), status: 'in_progress', rawInput: event.args ?? {} };
  } else if (type === 'tool.result' && event.toolCallId) {
    const isError = Boolean(event.result?.isError || event.result?.error);
    const output = typeof event.result?.output === 'string'
      ? event.result.output
      : (typeof event.result?.error === 'string' ? event.result.error : (event.result !== undefined ? JSON.stringify(event.result) : ''));
    return { sessionUpdate: 'tool_call_update', toolCallId, status: isError ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: event.result?.output ?? event.result };
  }
  return null;
}

function findTaskForTime(taskList, time) {
  if (!taskList.length) return null;
  if (!Number.isFinite(time)) {
    const running = taskList.find(t => t.status === 'running');
    return running || taskList[taskList.length - 1];
  }
  for (let i = 0; i < taskList.length; i++) {
    const task = taskList[i];
    if (Number.isFinite(task.startedAt)) {
      if (i > 0) {
        const prevTask = taskList[i - 1];
        if (Number.isFinite(prevTask.endedAt)) {
          if (time <= prevTask.endedAt) continue;
          const minBound = Math.max(task.startedAt - 5000, prevTask.endedAt + 1);
          if (time < minBound) continue;
        } else {
          if (time < task.startedAt) continue;
        }
      } else {
        const minBound = task.startedAt - 5000;
        if (time < minBound) continue;
      }

      if (Number.isFinite(task.endedAt)) {
        if (time > task.endedAt) continue;
      } else if (i + 1 < taskList.length && Number.isFinite(taskList[i + 1].startedAt)) {
        if (time >= taskList[i + 1].startedAt) continue;
      }
      return task;
    }
  }
  return null;
}

// What Kimi's subagents say in their own wires, told as updates of their own sessions (each subagent's is its agent id), a
// run (a task generation) at a time; and the runs its main agent's wire tells of without a task file. A run from before this
// agent process started (`startedAt`) is another process's: what it said is not told again.
export class KimiSubagentBridge {
  constructor({ session, root, readBounded, contained, startedAt = 0 }) {
    this.session = session;
    this.root = root;
    this.emit = () => {};
    this.readBounded = readBounded;
    this.contained = contained;
    this.startedAt = startedAt;
    // Map of agentId -> subagent state
    this.subagents = new Map();
  }

  // `emit(update, sessionId, taskId)`: what a subagent said, in which run. Returns every task: those given and those its main
  // agent's wire adds.
  async sync({ agents, state, tasks, signal, emit, startedAt = this.startedAt }) {
    this.emit = emit;
    const allTasks = await this.loadAllTasks(signal, tasks);
    // Group all tasks per agentId and sort chronologically by startedAt ascending
    const tasksByAgent = new Map();
    for (const task of allTasks) {
      if (!task.agentId || task.kind !== 'agent') continue;
      if (!tasksByAgent.has(task.agentId)) tasksByAgent.set(task.agentId, []);
      tasksByAgent.get(task.agentId).push(task);
    }
    for (const list of tasksByAgent.values()) {
      list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    }

    for (const agentId of agents) {
      signal.throwIfAborted();
      if (agentId === 'main') continue;

      const agentInfo = state?.agents?.[agentId];
      if (agentInfo && agentInfo.type !== 'sub' && !tasksByAgent.has(agentId)) continue;

      const taskList = tasksByAgent.get(agentId) || [];

      let sub = this.subagents.get(agentId);
      if (!sub) {
        sub = {
          agentId,
          generations: new Map(), // taskId -> { generation, subagentSessionId, completed, hasAssistantMessage, earlier }
          linesRead: 0,
          emittedIds: new Set(),
        };
        this.subagents.set(agentId, sub);
      }

      for (let i = 0; i < taskList.length; i++) {
        const task = taskList[i];
        const genNumber = i + 1;
        if (sub.generations.has(task.taskId)) continue;
        sub.generations.set(task.taskId, {
          taskId: task.taskId,
          generation: genNumber,
          subagentSessionId: genNumber === 1 ? agentId : `${agentId}:generation:${genNumber}`,
          completed: false,
          hasAssistantMessage: false,
          earlier: !Number.isSafeInteger(task.startedAt) || task.startedAt < startedAt,
        });
      }

      // Read wire events FIRST so all tools and replies are in place before terminal settlement
      await this.syncWireEvents(agentId, sub, taskList, signal);

      // Settle terminal states and fallback output AFTER wire events are processed
      for (let i = 0; i < taskList.length; i++) {
        const task = taskList[i];
        const gen = sub.generations.get(task.taskId);
        if (!gen || gen.earlier) continue;

        if (!gen.completed && task.status && task.status !== 'running') {
          if (!gen.hasAssistantMessage) {
            await this.syncOutputFallback(gen.subagentSessionId, task, sub, gen, signal);
          }
          gen.completed = true;
        }
      }
    }
    return allTasks;
  }

  async loadAllTasks(signal, initialTasks = []) {
    const tasksById = new Map();
    for (const t of initialTasks || []) {
      if (t?.taskId) tasksById.set(t.taskId, t);
    }

    if (!initialTasks || !initialTasks.length) {
      try {
        const mainAgent = await this.contained(this.session, join(this.session, 'agents/main'));
        let tasksDir;
        try { tasksDir = await this.contained(mainAgent, join(mainAgent, 'tasks')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (tasksDir) {
          const files = await readdir(tasksDir, { withFileTypes: true });
          for (const file of files) {
            signal.throwIfAborted();
            if (!file.isFile() || !file.name.endsWith('.json')) continue;
            try {
              const content = await this.readBounded(join(tasksDir, file.name), 1024 * 1024, signal);
              const task = JSON.parse(content);
              if (task?.taskId && task.agentId && task.kind === 'agent') tasksById.set(task.taskId, task);
            } catch { continue; }
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    try {
      const mainAgent = await this.contained(this.session, join(this.session, 'agents/main'));
      let wirePath;
      try { wirePath = await this.contained(mainAgent, join(mainAgent, 'wire.jsonl')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (wirePath) {
        const wireContent = await this.readBounded(wirePath, 32 * 1024 * 1024, signal);
        const lines = wireContent.split('\n');
        const activeTaskOnSubagent = new Map();
        for (const line of lines) {
          signal.throwIfAborted();
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          const type = ev?.type;
          if (type === 'subagent.spawned' && ev.subagentId) {
          const taskId = ev.taskId || `${ev.subagentId}:${ev.time}`;
          const agentId = ev.subagentId;
          activeTaskOnSubagent.set(agentId, taskId);
          const existing = tasksById.get(taskId) || {};
          const startedAt = Number.isSafeInteger(existing.startedAt)
            ? (Number.isSafeInteger(ev.time) ? Math.min(existing.startedAt, ev.time) : existing.startedAt)
            : (ev.time ?? null);
          tasksById.set(taskId, {
            taskId,
            agentId,
            kind: 'agent',
            description: ev.description || existing.description || '',
            subagentType: ev.subagentName || existing.subagentType || 'delegate',
            parentToolCallId: ev.parentToolCallId || existing.parentToolCallId,
            model: ev.model || existing.model,
            startedAt,
            status: existing.status || 'running',
            endedAt: existing.endedAt ?? null,
          });
          } else if (['subagent.completed', 'subagent.failed', 'subagent.cancelled'].includes(type) && ev.subagentId) {
            const taskId = activeTaskOnSubagent.get(ev.subagentId);
            if (taskId && tasksById.has(taskId)) {
              const task = tasksById.get(taskId);
              task.status = type === 'subagent.completed' ? 'completed' : 'failed';
              task.endedAt = ev.time || task.endedAt || Date.now();
            }
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    return [...tasksById.values()];
  }

  async syncWireEvents(agentId, sub, taskList, signal) {
    let wirePath;
    try {
      const agentDir = await this.contained(this.session, join(this.session, 'agents', agentId));
      wirePath = await this.contained(agentDir, join(agentDir, 'wire.jsonl'));
    } catch { return; }

    let content;
    try {
      content = await this.readBounded(wirePath, 32 * 1024 * 1024, signal);
    } catch { return; }

    const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
    const lines = trimmed ? trimmed.split('\n') : [];
    const limit = content.endsWith('\n') ? lines.length : Math.max(0, lines.length - 1);
    for (let i = sub.linesRead; i < limit; i++) {
      signal.throwIfAborted();
      const line = lines[i].trim();
      if (!line) {
        sub.linesRead = i + 1;
        continue;
      }
      let record;
      try { record = JSON.parse(line); } catch {
        sub.linesRead = i + 1;
        continue;
      }
      if (record?.type === 'context.append_loop_event' && record.event) {
        const matchedTask = findTaskForTime(taskList, record.time);
        if (!matchedTask) {
          // Cannot match to any known task generation; pause consumption and retain event for next sweep
          break;
        }
        const taskIndex = taskList.indexOf(matchedTask);
        const genNumber = taskIndex >= 0 ? taskIndex + 1 : 1;
        const subagentSessionId = genNumber === 1 ? agentId : `${agentId}:generation:${genNumber}`;
        const gen = sub.generations.get(matchedTask.taskId);
        if (gen && !gen.earlier) this.processLoopEvent(agentId, subagentSessionId, record.event, sub, gen);
      }
      sub.linesRead = i + 1;
    }
  }

  async syncOutputFallback(subagentSessionId, task, sub, gen, signal) {
    if (!task?.taskId) return;
    try {
      const mainAgent = await this.contained(this.session, join(this.session, 'agents/main'));
      const outputPath = await this.contained(mainAgent, join(mainAgent, 'tasks', task.taskId, 'output.log'));
      const text = await this.readBounded(outputPath, 1024 * 1024, signal);
      if (typeof text === 'string' && text.trim()) {
        const id = `${subagentSessionId}:output_fallback:${task.taskId}`;
        if (!sub.emittedIds.has(id)) {
          sub.emittedIds.add(id);
          this.emit({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text } }, sub.agentId, task.taskId);
          if (gen) gen.hasAssistantMessage = true;
        }
      }
    } catch { /* output.log is optional */ }
  }

  // `subagentSessionId` names the run, for what it said; it is said in the subagent's session, `agentId`.
  processLoopEvent(agentId, subagentSessionId, event, sub, gen) {
    const kind = event?.type === 'content.part' ? event.part?.type : undefined;
    const key = event?.type === 'tool.call' ? event.toolCallId
      : event?.type === 'tool.result' ? `${event.toolCallId}:result`
      : event.uuid || `${subagentSessionId}:${kind}:${event.step ?? ''}:${event.turnId ?? ''}`;
    const update = loopUpdate(event, { messageId: key, toolCallId: event.toolCallId });
    if (!update || sub.emittedIds.has(key)) return;
    sub.emittedIds.add(key);
    this.emit(update, agentId, gen?.taskId);
    if (gen && update.sessionUpdate === 'agent_message_chunk') gen.hasAssistantMessage = true;
  }
}
