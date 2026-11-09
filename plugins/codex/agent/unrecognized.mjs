// What of Codex the entry has not adapted, told to Coda as `_coda/unrecognized` (docs/agent-protocol.md「没适配的东西」) when
// Coda takes it (`_meta.coda.unrecognized` of its capabilities), once a session and name. Everything the locked Codex's
// app-server can say (its item types, the fields of an agent message and the values of those that change what it means, its
// notifications and requests) is in registry.json, each shown to Coda or not, and why; scripts/check-codex-protocol.mjs fails
// an upgrade of Codex until what the new one adds is there. At run time the patched codex-acp tells what reaches it
// unregistered: an item, its text shown when it has some; an agent message whose text came without deltas, shown from its text;
// a notification; a request, refused as before. Once a turn of a thread it opened has ended, the native tools Codex gave the
// model (`additional_tools` in the thread's rollout) are checked against known-tools.json, the user's MCP tools aside, until
// they are found. Fails loudly once the adapter changes.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { codexAsyncMessage } from './questions.mjs';

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const registry = json('./registry.json'), known = json('./known-tools.json');

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const registered = name => Object.hasOwn(registry, name);
// The fields of an agent message whose values are registered one by one.
export const VALUED = ['delivery', 'phase'];
// An agent message's text shown though nothing of it came as deltas, for no reason registered.
const UNSTREAMED = 'item:agentMessage.unstreamed';

// What codex-acp tells here rides on the update it says (`_meta.coda.unrecognized`), alone on a session_info_update when there
// is none; what it cannot say of a session reaches the entry's listener.
const told = (update, reports) => ({ ...update, _meta: { ...update._meta, coda: { ...update._meta?.coda, unrecognized: reports } } });
const output = (name, lost, detail) => ({ kind: 'output', name, lost, ...(detail ? { detail } : {}) });
let heard = () => {};
export const listenUnrecognized = listener => { heard = listener; };

// An item of a type codex-acp does not handle, as it completes: its text, if it has any, said as the agent's.
export function codexUnrecognizedItem(item) {
  const name = `item:${item.type}`;
  if (registered(name)) return null;
  const text = [item.text, item.message, item.summary].find(value => typeof value === 'string' && value.trim());
  if (!text) return told({ sessionUpdate: 'session_info_update' }, [output(name, true, `Codex 发来一项「${item.type}」，入口还不认识，没有显示`)]);
  return told({ sessionUpdate: 'agent_message_chunk', messageId: item.id, content: { type: 'text', text } }, [output(name, false)]);
}

// A completed agent message, after its deltas (`streamed`): an async one as questions.mjs says it; another whose text came
// without deltas said from its text; what of it is unregistered, told.
export function codexAgentMessage(item, streamed) {
  const names = [
    ...Object.keys(item).filter(field => field !== 'type' && item[field] != null && !registered(`item:agentMessage.${field}`)).map(field => `item:agentMessage.${field}`),
    ...VALUED.filter(field => typeof item[field] === 'string').map(field => `item:agentMessage.${field}=${item[field]}`).filter(name => !registered(name)),
  ];
  const async = codexAsyncMessage(item, streamed);
  if (async || streamed || !item.text) {
    return names.length ? told(async ?? { sessionUpdate: 'session_info_update' }, names.map(name => output(name, false))) : async;
  }
  return told({ sessionUpdate: 'agent_message_chunk', messageId: item.id, content: { type: 'text', text: item.text } },
    (names.length ? names : [UNSTREAMED]).map(name => output(name, false)));
}

// A notification codex-acp does not handle.
export function codexUnrecognizedNotification(method) {
  const name = `notification:${method}`;
  return registered(name) ? null : told({ sessionUpdate: 'session_info_update' }, [output(name, false)]);
}

// A request of Codex codex-acp has no handler for, still refused: of the thread it names, else of the session.
export function codexUnrecognizedRequest(method, params) {
  const name = `request:${method}`;
  if (registered(name)) return;
  heard({ sessionId: typeof params?.threadId === 'string' ? params.threadId : null,
    ...output(name, true, `Codex 请求了「${method}」，入口还不认识，回了不支持`) });
}

// Where the rollout of each thread codex-acp started or resumed is (thread/start, thread/resume, as answered), and the threads
// whose tools have been read or are being read.
const rollouts = new Map(), read = new Set();
export function codexThread(response) {
  if (typeof response?.thread?.path === 'string') rollouts.set(response.thread.id, response.thread.path);
  return response;
}
export function codexTurnCompleted(threadId) {
  const path = rollouts.get(threadId);
  if (!path || read.has(threadId)) return;
  read.add(threadId);
  readFile(path, 'utf8').then(text => {
    const tools = rolloutTools(text);
    if (!tools) { read.delete(threadId); return; }
    for (const tool of tools) if (!Object.hasOwn(known, tool)) heard({ sessionId: threadId, kind: 'tool', name: `tool:${tool}`, lost: false });
  }, () => read.delete(threadId));
}

// The native tools a rollout gave the model, `namespace.name` (Codex's own namespace for one outside any is `functions`; a
// hosted tool, which has no name, by its type); none before it gave any. MCP tools (`mcp__<server>`) are the user's.
export function rolloutTools(text) {
  let tools = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"additional_tools"')) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'response_item' || entry.payload?.type !== 'additional_tools' || !Array.isArray(entry.payload.tools)) continue;
    tools ??= new Set();
    for (const tool of entry.payload.tools) {
      if (tool.type !== 'namespace') tools.add(tool.name ? `functions.${tool.name}` : tool.type);
      else if (!tool.name.startsWith('mcp__')) for (const each of tool.tools ?? []) tools.add(`${tool.name}.${each.name}`);
    }
  }
  return tools;
}

const patches = [
  // Each item type codex-acp knows has its case; one it does not falls through.
  ['      case "enteredReviewMode":\n        return null;\n    }\n  }\n  rememberAgentMessagePhase(item) {',
    before => before.replace('    }\n  }', '      default:\n        return codexUnrecognizedItem(event.item);\n    }\n  }')],
  ['      case "autoApprovalReview/strictReviewRequired":\n        return null;\n    }\n  }\n  createCodexSessionInfoUpdate(codexMetadata) {',
    before => before.replace('    }\n  }', '      default:\n        return codexUnrecognizedNotification(notification.method);\n    }\n  }')],
  ['      case "turn/completed":\n        await this.flushPendingPlanUpdates();\n', before => `${before}        codexTurnCompleted(notification.params.threadId);\n`],
  // vscode-jsonrpc refuses a request nobody handles with MethodNotFound: so does this handler of the rest.
  ['      return await handler.handleUserInput(params);\n    });\n  }\n', before => before.replace('    });\n  }\n', `    });
    this.connection.onRequest((method, params) => {
      codexUnrecognizedRequest(method, params);
      throw new import_node2.ResponseError(import_node2.ErrorCodes.MethodNotFound, \`Unhandled method \${method}\`);
    });
  }\n`)],
  ...['thread/start', 'thread/resume'].map(method => [`    return await this.sendRequest({ method: "${method}", params });`,
    before => before.replace('await this.sendRequest', 'codexThread(await this.sendRequest').replace(');', '));')]),
];
export function reportedCodexUnrecognized(source) {
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp unrecognized output patch no longer matches the locked adapter');
    source = source.replace(before, after(before));
  }
  return `import { codexUnrecognizedItem, codexUnrecognizedNotification, codexUnrecognizedRequest, codexThread, codexTurnCompleted } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}

export class CodexUnrecognized {
  constructor() {
    // Whether Coda takes reports, and what it has been told, by session and name.
    this.taken = false; this.said = new Set();
  }
  // What Coda says: its handshake says whether it takes them.
  fromCoda(message) {
    if (message.method === 'initialize') this.taken = record(message.params?.clientCapabilities?._meta?.coda?.unrecognized);
  }
  // A report, as said to Coda: once, and only to a Coda that takes them.
  report({ sessionId, kind, name, lost, detail }) {
    name = name.slice(0, 200);
    const key = `${sessionId}\n${name}`;
    if (!this.taken || !sessionId || this.said.has(key)) return [];
    this.said.add(key);
    return [{ jsonrpc: '2.0', method: '_coda/unrecognized', params: { sessionId, kind, name, lost, ...(detail ? { detail: detail.slice(0, 2000) } : {}) } }];
  }
  // What codex-acp says, without what it tells here, which follows it.
  fromAgent(message) {
    const u = message?.params?.update, reports = u?._meta?.coda?.unrecognized;
    if (message?.method !== 'session/update' || !Array.isArray(reports)) return [message];
    const { unrecognized, ...coda } = u._meta.coda, { coda: _, ...meta } = u._meta;
    if (Object.keys(coda).length) meta.coda = coda;
    const { _meta, ...update } = u;
    if (Object.keys(meta).length) update._meta = meta;
    const reported = reports.flatMap(each => this.report({ sessionId: message.params.sessionId, ...each }));
    if (update.sessionUpdate === 'session_info_update' && !update._meta) return reported;
    return [{ ...message, params: { ...message.params, update } }, ...reported];
  }
}
