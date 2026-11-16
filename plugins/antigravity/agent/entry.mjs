// Starts `agy acp` and relays its ACP both ways, line for line, with two changes.
// 1. Coda gives it no additional directories: agy 1.5.9 runs a command with no Cwd in the lexicographically first
//    additional root, not in the session's cwd (observed, not promised upstream). The `initialize` answer loses the
//    additionalDirectories capability (Coda only passes the directories to an agent that declares it), and a session
//    request loses `additionalDirectories` should one come anyway.
// 2. A virtual mode `full` ("allow everything"). agy has no such mode and cannot change its permission policy once it
//    runs, so a session in `full` runs in agy's `default` and the entry answers each of its permission requests itself
//    with the allow_once option. Switching in and out is rewritten on the way: Coda sees `full` as an ordinary mode.
import { spawn } from 'node:child_process';
import { agyBinary } from '../scripts/agy.mjs';

const agy = spawn(agyBinary() ?? 'agy', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'] });
const initializing = new Set();
const sessionRequests = new Set();
const configRequests = new Map(); // request id -> { sessionId, was }: a set_config_option, whose answer lists the options; `was` for a mode switch, undone if agy refuses it
const full = new Set(); // sessions in `full`
const FULL_NAME = '全部放行';
const FULL_DESCRIPTION = 'Approve everything without asking.';
let stopping = false;

// Only LF separates JSON messages; readline would also split literal Unicode line separators inside JSON strings.
// A line that is not a JSON object passes through as it is. `change` returns false for a message that is not forwarded.
function relay(from, to, change) {
  let rest = '';
  const take = text => {
    const lines = (rest + text).split('\n'); rest = lines.pop();
    for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { message = null; }
      if (message && typeof message === 'object' && !Array.isArray(message)) { if (change(message) !== false) to.write(`${JSON.stringify(message)}\n`); } else to.write(`${line}\n`);
    }
  };
  from.setEncoding('utf8').on('data', take).on('end', () => take('\n'));
}

// The mode option of a configOptions list gains `full`; a session in `full` shows it as the current value, and a mode of
// agy's own other than `default` ends it.
function fixConfigOptions(sessionId, configOptions) {
  const mode = Array.isArray(configOptions) ? configOptions.find(option => option?.id === 'mode' && Array.isArray(option.options)) : null;
  if (!mode) return;
  mode.options.push({ value: 'full', name: FULL_NAME, description: FULL_DESCRIPTION });
  if (!full.has(sessionId)) return;
  if (mode.currentValue === 'default') mode.currentValue = 'full'; else full.delete(sessionId);
}

// The session is in `full` from the moment the switch is sent, and back where it was if agy answers with an error.
function switchMode(message, to) {
  const { sessionId } = message.params;
  configRequests.set(message.id, { sessionId, was: full.has(sessionId) });
  if (to === 'full') full.add(sessionId); else full.delete(sessionId);
}

relay(process.stdin, agy.stdin, message => {
  const { method, params, id } = message;
  if (method === 'initialize' && 'id' in message) initializing.add(id);
  if (['session/new', 'session/load', 'session/resume'].includes(method)) { delete params?.additionalDirectories; sessionRequests.add(id); }
  if (method === 'session/set_mode' && typeof params?.sessionId === 'string') {
    switchMode(message, params.modeId);
    if (params.modeId === 'full') params.modeId = 'default';
  }
  if (method === 'session/set_config_option' && typeof params?.sessionId === 'string') {
    if (params.configId !== 'mode') configRequests.set(id, { sessionId: params.sessionId });
    else {
      switchMode(message, params.value);
      if (params.value === 'full') params.value = 'default';
    }
  }
});
relay(agy.stdout, process.stdout, message => {
  const { method, params, id } = message;
  if (!method) {
    if (initializing.delete(id)) {
      for (const key of ['sessionCapabilities', 'session_capabilities']) delete message.result?.agentCapabilities?.[key]?.additionalDirectories;
    }
    if (sessionRequests.delete(id) && message.result) {
      const { modes } = message.result;
      if (Array.isArray(modes?.availableModes)) modes.availableModes.push({ id: 'full', name: FULL_NAME, description: FULL_DESCRIPTION });
      fixConfigOptions(message.result.sessionId, message.result.configOptions);
    }
    const config = configRequests.get(id);
    if (config) {
      configRequests.delete(id);
      if (!message.error) fixConfigOptions(config.sessionId, message.result?.configOptions);
      else if (config.was) full.add(config.sessionId);
      else if (config.was === false) full.delete(config.sessionId);
    }
    return;
  }
  const update = params?.update;
  if (method === 'session/update' && update?.sessionUpdate === 'current_mode_update') {
    if (!full.has(params.sessionId)) return;
    if (update.currentModeId === 'default') update.currentModeId = 'full'; else full.delete(params.sessionId);
  } else if (method === 'session/update' && update?.sessionUpdate === 'config_option_update') {
    fixConfigOptions(params.sessionId, update.configOptions);
  } else if (method === 'session/request_permission' && full.has(params?.sessionId)) {
    const allow = params.options?.find(option => option?.kind === 'allow_once');
    if (!allow) return;
    agy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } })}\n`);
    return false;
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
