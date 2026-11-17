// The Kimi agent as Coda starts it (the plugin's `contributes.agents`): `kimi acp` as a child in this process's group, with a relay
// between it and Coda that speaks Coda's protocol for it (relay.mjs, docs/agent-protocol.md). It ends as Kimi ends; when Kimi ends on
// its own (not as Coda's input closing or a signal to this process stops it) with a non-zero exit code, a signal or a prompt
// unanswered, the log and the prompts still waiting say how (exit.mjs).
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';
import { kimiBinary } from './binary.mjs';
import { KimiRelay } from './relay.mjs';
import { describeExit, endedError } from './exit.mjs';

const startedAt = Date.now();
const kimi = spawn(kimiBinary() ?? 'kimi', ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
kimi.stderr.on('data', chunk => { process.stderr.write(chunk); stderr = (stderr + chunk).slice(-2048); });
kimi.stdin.on('error', () => {});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true; kimi.stdin.end(); kimi.kill();
  setTimeout(() => kimi.kill('SIGKILL'), 800).unref();
};
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const relay = new KimiRelay({ startedAt, say: message => process.stdout.write(`${JSON.stringify(message)}\n`),
  tell: message => kimi.stdin.write(`${JSON.stringify(message)}\n`) });
readLines(process.stdin).on('line', line => { const message = parse(line); if (message) relay.fromCoda(message); }).on('close', () => { stopping = true; kimi.stdin.end(); });
readLines(kimi.stdout).on('line', line => { const message = parse(line); if (message) relay.fromAgent(message); });
// What Kimi said before it ended reaches Coda before this process ends.
let ended = false;
const end = code => { if (ended) return; ended = true; relay.close(); void relay.drained().then(() => process.stdout.write('', () => process.exit(code))); };
kimi.on('close', (code, signal) => {
  // Kimi's last words pass first; the prompts it leaves unanswered fail with how it ended.
  void relay.drained().then(() => {
    if (!stopping && (code !== 0 || relay.prompts.size)) {
      const message = describeExit({ code, signal, stderr });
      process.stderr.write(`${message}\n`);
      for (const id of relay.abandon()) relay.say({ jsonrpc: '2.0', id, error: endedError(message) });
    }
    end(code ?? (stopping ? 0 : 1));
  });
});
kimi.on('error', () => end(1));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
