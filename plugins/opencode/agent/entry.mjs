// The OpenCode agent as Coda starts it (the plugin's `contributes.agents`): `opencode acp` as a child in this process's group,
// its ACP passed on a message at a time both ways, but for Coda's session instructions, which this entry declares and puts in
// front of a new session's first prompt (instructions.mjs), its models, which it groups by provider (groups.mjs), and a
// model service's long wait, which ends the turn instead (retries.mjs), and native child sessions (children.mjs).
// It ends as OpenCode ends, once what it said has reached Coda.
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';
import { opencodeBinary } from './binary.mjs';
import { SessionInstructions } from './instructions.mjs';
import { groupedModels } from './groups.mjs';
import { chosenServices, providerEnvironment, serviceNames } from './providers.mjs';
import { LongRetries } from './retries.mjs';
import { OpenCodeChildren } from './children.mjs';

const services = chosenServices(), names = serviceNames(services);
const cli = spawn(opencodeBinary() ?? 'opencode', ['acp'], { env: await providerEnvironment(process.env, fetch, services), stdio: ['pipe', 'pipe', 'inherit'] });
cli.stdin.on('error', () => {});
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const say = message => process.stdout.write(`${JSON.stringify(message)}\n`), tell = message => cli.stdin.write(`${JSON.stringify(message)}\n`);
const instructions = new SessionInstructions();
const children = new OpenCodeChildren();
const retries = new LongRetries(sessionId => tell({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
readLines(process.stdin).on('line', line => {
  const message = parse(line);
  if (!message) return;
  const { agent, coda } = instructions.fromCoda(message);
  if (coda) { say(coda); return; }
  const next = children.fromCoda(agent);
  if (next.coda) { say(next.coda); return; }
  retries.toAgent(next.agent);
  tell(next.agent);
}).on('close', () => cli.stdin.end());
readLines(cli.stdout).on('line', line => {
  const message = parse(line);
  if (message) for (const next of children.fromAgent(retries.fromAgent(message))) say(groupedModels(instructions.fromAgent(next), names));
});
let ended = false;
const end = code => { if (ended) return; ended = true; process.stdout.write('', () => process.exit(code)); };
cli.on('close', code => end(code ?? 1));
cli.on('error', () => end(1));
