// The OpenCode agent as Coda starts it (the plugin's `contributes.agents`): `opencode acp` as a child in this process's group,
// its ACP passed on a message at a time both ways, but for Coda's session instructions, which this entry declares and puts in
// front of a new session's first prompt (instructions.mjs), its models, which it groups by provider (groups.mjs), and a
// model service's long wait, which ends the turn instead (retries.mjs), native child sessions (children.mjs), and native
// background shell lifecycle facts supplied by the per-process observer (shells.mjs, runtime/server.mjs).
// It ends as OpenCode ends, once what it said has reached Coda.
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';
import { opencodeBinary } from './binary.mjs';
import { SessionInstructions } from './instructions.mjs';
import { groupedModels } from './groups.mjs';
import { chosenServices, providerEnvironment, serviceNames } from './providers.mjs';
import { LongRetries } from './retries.mjs';
import { OpenCodeChildren } from './children.mjs';
import { OpenCodeShells } from './shells.mjs';
import { shellChannel, shellEnvironment } from './shell-channel.mjs';

const services = chosenServices(), names = serviceNames(services);
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const say = message => process.stdout.write(`${JSON.stringify(message)}\n`), tell = message => cli.stdin.write(`${JSON.stringify(message)}\n`);
const instructions = new SessionInstructions();
const children = new OpenCodeChildren();
const shells = new OpenCodeShells({ owns: id => children.roots.has(id) || children.children.has(id), say,
  interrupt: (source, sessionId) => channel.interrupt(source, sessionId) });
const channel = await shellChannel({
  event(event, source) {
    // The native event feed can beat ACP's child_created to the socket. Register the same native child first, then
    // let ACP deliver its transcript and terminal status as usual. Unknown ancestry is never adopted.
    if (event?.type === 'session.created') {
      const d = event.data, root = children.roots.has(d?.parentID) ? d.parentID : children.children.get(d?.parentID)?.root;
      if (root) {
        const reports = [];
        children.child({ rootSessionId: root, childSessionId: d.sessionID, parentSessionId: d.parentID, title: d.title }, reports);
        reports.forEach(say);
      }
    }
    shells.event(event, source);
  },
  register: (message, source) => shells.register({ ...message, toolCallId: children.children.has(message.sessionId)
    ? `${message.sessionId}:${message.toolCallId}` : message.toolCallId }, source),
  disconnected: source => shells.disconnected(source),
});
const cli = spawn(opencodeBinary() ?? 'opencode', ['acp'], {
  env: shellEnvironment(await providerEnvironment(process.env, fetch, services), channel.socket), stdio: ['pipe', 'pipe', 'inherit'],
});
cli.stdin.on('error', () => {});
const retries = new LongRetries(sessionId => tell({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
readLines(process.stdin).on('line', line => {
  const message = parse(line);
  if (!message) return;
  const { agent, coda } = instructions.fromCoda(message);
  if (coda) { say(coda); return; }
  const next = children.fromCoda(agent);
  if (next.coda) { say(next.coda); return; }
  retries.toAgent(next.agent);
  if (shells.fromCoda(next.agent)) return;
  tell(next.agent);
}).on('close', () => cli.stdin.end());
readLines(cli.stdout).on('line', line => {
  const message = parse(line);
  if (message) for (const next of children.fromAgent(retries.fromAgent(message))) {
    shells.fromAgent(next);
    say(groupedModels(instructions.fromAgent(next), names));
  }
});
let ended = false;
const end = code => { if (ended) return; ended = true; void channel.close().then(() => process.stdout.write('', () => process.exit(code))); };
cli.on('close', code => end(code ?? 1));
cli.on('error', () => end(1));
