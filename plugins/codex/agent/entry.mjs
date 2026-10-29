// The Codex agent as Coda starts it (the plugin's `contributes.agents`): the locked codex-acp, run in this process with Coda's
// patches, which fail the start once the adapter changes. Between it and Coda the entry speaks Coda's protocol for it
// (waits.mjs, docs/agent-protocol.md), and of its own check of a call as that call's (reviews.mjs): its session instructions become the thread's developer instructions (instructions.mjs),
// and a steer that finds no turn going is answered `promptRequired` (steering.mjs); the models of the model service chosen in
// Coda join Codex's own (providers.mjs). What Coda wants of Codex beyond ACP is set here: the mode a session starts in, and
// which Codex program runs, through the account bridge when another plugin chooses the account (accounts.mjs).
import { createRequire, registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountSource } from './account-source.mjs';
import { readLines } from './lines.mjs';
import { orderedCodexTitles } from './titles.mjs';
import { continuedCodexSubagents } from './subagents.mjs';
import { followCodexProcessExit } from './process-exit.mjs';
import { networkedCodexDevelopment } from './network.mjs';
import { codexOptionsAsShown } from './options.mjs';
import { instructedCodexThreads } from './instructions.mjs';
import { promptRequiredCodexSteering } from './steering.mjs';
import { servedCodexModels } from './providers.mjs';
import { input, listen, relayedCodexStreams } from './relay.mjs';
import { CodexWaits } from './waits.mjs';
import { CodexReviews } from './reviews.mjs';
import { explainCodexError, reportedCodexFailures } from './errors.mjs';
import { reportedCodexSleeps } from './sleep.mjs';

const env = process.env;
// A session starts read-only, unless its machine's configuration says otherwise.
env.INITIAL_AGENT_MODE ??= 'read-only';
// The Codex this session runs, as the handshake's `agentInfo` names it (Coda's protocol「Agent 版本」): the connection's own
// program when it sets one, else the plugin's locked @openai/codex.
const own = env.CODEX_PATH;
function codexVersion() {
  if (own) return /\d+\.\d+\.\d+[\w.+-]*/.exec(spawnSync(own, ['--version'], { encoding: 'utf8', timeout: 3000 }).stdout ?? '')?.[0] ?? null;
  try { return JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@openai/codex/package.json'), 'utf8')).version; } catch { return null; }
}
// Another plugin plugged into Codex's `account-source` point chooses the account (accounts.mjs): codex-acp then runs the
// account bridge as its Codex, through a small program written into this plugin's state, named for what it runs. A Codex
// program of the connection's own (`CODEX_PATH`) keeps its own login.
if (!env.CODEX_PATH && accountSource(env) && env.CODA_PLUGIN_STATE) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const program = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./accounts.mjs', import.meta.url)))} "$@"\n`;
  const shim = join(env.CODA_PLUGIN_STATE, `account-bridge-${createHash('sha256').update(program).digest('hex').slice(0, 12)}`);
  if (!existsSync(shim)) { writeFileSync(`${shim}.${process.pid}`, program, { mode: 0o700 }); renameSync(`${shim}.${process.pid}`, shim); }
  env.CODEX_PATH = shim;
}

const version = codexVersion();
const waits = new CodexWaits({ agentInfo: version ? { name: 'codex', version } : null }), parse = line => { try { return JSON.parse(line); } catch { return null; } };
const reviews = new CodexReviews(), say = message => process.stdout.write(`${JSON.stringify(message)}\n`);
listen(line => { for (const message of waits.fromAgent(parse(line))) for (const each of reviews.fromAgent(message)) say(explainCodexError(each)); });
readLines(process.stdin).on('line', line => {
  const message = parse(line);
  if (!message || typeof message !== 'object') return;
  const { agent, coda } = waits.fromCoda(message);
  for (const each of agent) input.write(`${JSON.stringify(each)}\n`);
  for (const each of coda) say(each);
}).on('close', () => input.end());

// codex-acp as Node finds it from here (its package names dist/index.js as its main): the plugin's own dependency.
const adapter = new URL(import.meta.resolve('@agentclientprotocol/codex-acp'));
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== adapter.href) return loaded;
  return { ...loaded, source: reportedCodexSleeps(reportedCodexFailures(codexOptionsAsShown(relayedCodexStreams(orderedCodexTitles(followCodexProcessExit(continuedCodexSubagents(
    promptRequiredCodexSteering(instructedCodexThreads(servedCodexModels(networkedCodexDevelopment(Buffer.from(loaded.source).toString('utf8')))))))))))) };
} });
await import(adapter.href);
