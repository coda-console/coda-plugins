// Starts `agy acp` and relays its ACP both ways, line for line, with two things taken out so Coda gives it no additional
// directories: agy 1.5.9 runs a command with no Cwd in the lexicographically first additional root, not in the session's
// cwd (observed, not promised upstream). The `initialize` answer loses the additionalDirectories capability (Coda only
// passes the directories to an agent that declares it), and a session request loses `additionalDirectories` should one come anyway.
import { spawn } from 'node:child_process';
import { agyBinary } from '../scripts/agy.mjs';

const agy = spawn(agyBinary() ?? 'agy', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'] });
const initializing = new Set();
let stopping = false;

// Only LF separates JSON messages; readline would also split literal Unicode line separators inside JSON strings.
// A line that is not a JSON object passes through as it is.
function relay(from, to, change) {
  let rest = '';
  const take = text => {
    const lines = (rest + text).split('\n'); rest = lines.pop();
    for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { message = null; }
      if (message && typeof message === 'object' && !Array.isArray(message)) { change(message); to.write(`${JSON.stringify(message)}\n`); } else to.write(`${line}\n`);
    }
  };
  from.setEncoding('utf8').on('data', take).on('end', () => take('\n'));
}
relay(process.stdin, agy.stdin, message => {
  if (message.method === 'initialize' && 'id' in message) initializing.add(message.id);
  if (['session/new', 'session/load', 'session/resume'].includes(message.method)) delete message.params?.additionalDirectories;
});
relay(agy.stdout, process.stdout, message => {
  if (!message.method && initializing.delete(message.id)) {
    for (const key of ['sessionCapabilities', 'session_capabilities']) delete message.result?.agentCapabilities?.[key]?.additionalDirectories;
  }
});
const stop = () => {
  if (stopping) return;
  stopping = true; agy.stdin.end(); agy.kill();
  setTimeout(() => agy.kill('SIGKILL'), 800).unref();
};
agy.stdin.on('error', () => {});
agy.on('error', () => process.exit(1));
agy.on('close', code => process.exit(stopping ? 0 : code ?? 1));
process.stdin.on('end', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
