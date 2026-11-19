// The one runner of a plugin's commands (docs/plugins.md「命令的约定」): the operations its commands implement
// (components/plugins/plugin-host.mjs `startCommand`), its resources' readings and actions,
// their logins and installers, its setup; and, bounded the same way, the programs Coda runs for a plugin itself (Git taking a
// plugin from its repository, components/plugins/plugin-sources.mjs; a repository's listing; what a plugin tells agents).
// A command runs in a process group of its own, and only that group is touched: once it is cancelled (`cancel`, `stop()`) or
// past its deadline on `clock` (the backend's one clock, adapters/clock.mjs; a clock of its own in a plugin's module) the
// group is asked to end (TERM), and made to (KILL) once `graceMs` has passed; once `signal` aborts (its owner closing, the
// clock with it, nothing left to wait out the grace) it is made to at once. Whatever it left in its group goes as its process
// exits of itself, not once its pipes close: what it left may hold them (`sleep 300 & …`); asked to end, what it left has
// the rest of the grace to, even once the run has settled (its pipes closed, what it left writing elsewhere). One that left
// its group still holding them (a daemon it started, `adb start-server`'s) is waited for no longer than DRAIN once its
// process has exited and nothing is left of the grace: its pipes are closed, and it ended as its exit code and what it
// said by then say.
// What it reads is `input`, written to its standard input and closed (`open`: kept open, for what a login is given later).
// Its standard output is its answer, at most `maxBytes` (an envelope's, 1 MiB), past which it is stopped; `tail` keeps the last
// of it instead, for one that may say much on its way (a setup installing what it needs). Its standard error is its log, the
// last LOG bytes of it kept, never a reason to stop it. `onOutput` is told every piece of either as it comes.
// It starts its process through `start` (the backend's registry door, adapters/process-start.mjs; a plugin's module, the
// resources plugin's, gives one that registers nothing): a command a backend starts is registered for as long as it runs,
// under `label` (docs/process-registry.md). A plugin's command is handed a token of its plugin's in CODA_TOKEN (`token`,
// docs/plugins.md「令牌」): `issue(run)` issues it for this run, as it starts, and `revoke(run)` revokes it as it ends.
// `settle` says what it came to, by the convention.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { ENVELOPE, stopped } from './call-limit.mjs';
import { Clock } from './clock.mjs';
import { failureOf } from './provider-api.mjs';
import { ContractError } from '../domain/errors.mjs';
import { TOKEN_ENV } from '../domain/session-env.mjs';
import { derivedUUID } from '../domain/values.mjs';

export const GRACE = 10_000, LOG = 64 * 1024;
// How long what a command wrote just before it exited is waited for once it has: its pipes drain at once unless a process
// outside its group holds them, which may hold them for ever. Ample for the last of its output, short beside any call.
export const DRAIN = 2_000;
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
// The last thing a failed command said, for the one line the user sees.
export const lastLine = text => text.replace(ansi, '').split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';
// A module's own: it has no backend clock to share.
const SYSTEM = new Clock();
// Whether a process group lives.
export function groupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A command line from a plugin's manifest, `sh -c` from `cwd`: the plugin's directory for those of the convention
// (docs/plugins.md「命令的约定」), a temporary one for the rest.
export const runPluginCommand = (command, options) => runBounded('/bin/sh', ['-c', command], { cwd: tmpdir(), ...options });
export const startPluginCommand = (command, options) => startBounded('/bin/sh', ['-c', command], { cwd: tmpdir(), ...options });
export const runBounded = (program, args, options) => startBounded(program, args, options).done;
// The command line that runs a plugin's file implementing an operation (docs/plugins.md「用命令实现操作」), from its directory.
export const fileCommand = file => `./'${posix.normalize(file).replaceAll("'", "'\\''")}'`;
// What a command implementing an operation is told of its call in its environment, as a module's handler is in its `ctx`
// (docs/plugins.md「用命令实现操作」): its record (`ctx.record`, its key only of one its plugin holds here), its ID (`ctx.id`)
// and, when it has one, its deadline (`ctx.deadline`, milliseconds); made from a page, who is before it (`ctx.caller`, JSON).
export const callEnv = ({ id, record, deadline, caller }) => ({ CODA_RECORD_KIND: record.kind, CODA_RECORD_ID: record.id,
  ...(record.key === undefined ? {} : { CODA_RECORD_KEY: record.key }), CODA_CALL_ID: id,
  ...(deadline === null || deadline === undefined ? {} : { CODA_DEADLINE: String(deadline) }),
  ...(caller ? { CODA_CALLER: JSON.stringify(caller) } : {}) });
// A query's ID, as its handler is given it (`ctx.id`, adapters/plugin-modules.mjs): of its caller and its request's.
export const queryId = request => derivedUUID('query', request.parent, request.requestId);

// `label`: what the registry says of it, the plugin and the command by name (never the command's text or what it is given: those may carry credentials).
// `{ done, ended, write, stop, kill }`: how it ended (`{ code, stdout, stderr, timedOut, canceled, overflow, error?, started? }`);
// once its group has, nothing of it left (made to end, so the grace passed at most): `done` may come before, what it left
// still in its grace; what writes to its standard input, when kept `open`; what cancels it (TERM, then KILL past the grace);
// what ends it at once.
export function startBounded(program, args, { start, label, cwd, env, clock = SYSTEM, timeoutMs, graceMs = GRACE, signal: closing, cancel,
  maxBytes = ENVELOPE, tail = false, input = null, open = false, onOutput = () => {}, token = null }) {
  // One owner for each run: two of the same command at once are two entries, with a token each.
  const owner = { party: 'host', kind: 'plugin-command', object: randomUUID() };
  let resolve, reaped;
  const done = new Promise(r => { resolve = r; }), ended = new Promise(r => { reaped = r; });
  const handle = { done, ended, write: () => {}, stop: () => {}, kill: () => {} };
  let child;
  const handed = token ? { ...env, [TOKEN_ENV]: token.issue(owner.object) } : env;
  try { child = start.spawn(owner, { tier: 'full', claim: null, label, outlives: false }, program, args, { cwd, env: handed, stdio: [input === null && !open ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
  // The registry could not take it, and has ended its group: as good as one that did not start, but for having run a moment.
  catch (error) {
    token?.revoke(owner.object);
    reaped();
    resolve({ code: null, stdout: '', stderr: '', timedOut: false, canceled: false, overflow: false, error: error.message, started: !!error.started });
    return handle;
  }
  // A command that ends without reading all of it is no error of the writing.
  if (input !== null || open) child.stdin.on('error', () => {});
  if (input !== null) child.stdin.end(input);
  const out = [], err = [];
  let sizes = [0, 0], overflow = false, timedOut = false, canceled = false, finished = false, hard = null, drain = null;
  // `graced`: asked to end (TERM), the grace not yet run out; `exited`: its process has, with `exitCode`.
  let graced = false, exited = false, exitCode = null;
  const signal = name => { try { process.kill(-child.pid, name); } catch {} };
  // What still holds its pipes past DRAIN is no longer waited for.
  const drained = () => { drain = clock.at(clock.now() + DRAIN, () => { child.stdout.destroy(); child.stderr.destroy(); finish(exitCode); }); };
  // Its group made to end and its entry gone, nothing left to wait for it.
  const reap = () => { hard?.(); closing?.removeEventListener('abort', kill); if (child.pid) { signal('SIGKILL'); start.remove(owner); } reaped(); };
  const stop = () => {
    if (finished || hard) return;
    signal('SIGTERM'); graced = true;
    hard = clock.at(clock.now() + graceMs, () => { graced = false; if (finished) return reap(); signal('SIGKILL'); if (exited) drained(); });
  };
  // Its process made to end at once; settled already, in its grace, what it left in its group is.
  const kill = () => { const pending = graced; graced = false; if (!finished) signal('SIGKILL'); else if (pending) reap(); };
  const due = clock.at(clock.now() + timeoutMs, () => { timedOut = true; stop(); });
  const cancelled = () => { canceled = true; stop(); };
  closing?.addEventListener('abort', kill, { once: true });
  cancel?.addEventListener('abort', cancelled, { once: true });
  const keep = (chunks, i, most, last) => chunk => {
    onOutput(chunk.toString('utf8'));
    if (last) { sizes[i] += chunk.length; chunks.push(chunk); while (sizes[i] > most && chunks.length > 1) sizes[i] -= chunks.shift().length; return; }
    if (sizes[i] + chunk.length > most) { if (!overflow) { overflow = true; stop(); } return; }
    sizes[i] += chunk.length; chunks.push(chunk);
  };
  child.stdout.on('data', keep(out, 0, maxBytes, tail));
  child.stderr.on('data', keep(err, 1, LOG, true));
  const finish = (code, error) => {
    if (finished) return;
    finished = true; due(); drain?.(); cancel?.removeEventListener('abort', cancelled);
    // Whatever it left behind in its group goes with it; asked to end, once the grace has passed, if anything is left.
    if (!graced || !groupAlive(child.pid)) reap();
    token?.revoke(owner.object);
    resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, canceled, overflow, ...(error ? { error } : {}) });
  };
  child.on('error', error => finish(null, error.message));
  // Exited of itself, what it left in its group goes now; asked to end, what it left has the rest of the grace to.
  child.on('exit', code => {
    exited = true; exitCode = code;
    if (graced) return;
    signal('SIGKILL'); drained();
  });
  child.on('close', code => finish(code));
  return Object.assign(handle, { write: text => child.stdin?.write(text), stop: cancelled, kill });
}

const failure = (code, message, effects = 'unknown') => ({ error: { code, message, effects } });
// What a command that ended as `ran` came to (docs/plugins.md「命令的约定」): `{ result }`, or `{ error: { code, message,
// effects } }`. The exit code first: 0 is done, its standard output whole the result, a JSON value; anything else failed, as
// the `{ "error": … }` it printed says (checked as a module's, adapters/provider-api.mjs failureOf), or else `command_failed`.
// Stopped, by its deadline or for saying more than 1 MiB, or cancelled, it may have done anything: `unknown`. `answers`:
// false for a command whose standard output is no result but what it says on its way (a setup, a login, an action), which
// ending with 0 is all of. `what`: the command, as a failure names it.
export function settle(ran, { answers = true, what = '命令' } = {}) {
  if (ran.error) return failure('command_failed', `${what}没有开始：${ran.error}`, ran.started ? 'unknown' : 'none');
  if (ran.overflow) return failure('handler_error', `${what}的输出超过 1 MiB`);
  if (ran.timedOut) return failure('timeout', `${what}超时`);
  if (ran.canceled) return failure('canceled', `${what}已取消`);
  if (ran.code !== 0) return { error: said(ran.stdout) ?? { code: 'command_failed', effects: 'unknown',
    message: lastLine(ran.stderr) || lastLine(ran.stdout) || `${what}没有完成（退出码 ${ran.code ?? '无'}）` } };
  if (!answers) return { result: null };
  let result;
  try { result = JSON.parse(ran.stdout); } catch { return failure('command_failed', `${what}的输出不是 JSON`); }
  return Buffer.byteLength(JSON.stringify({ result })) <= ENVELOPE ? { result } : failure('handler_error', `${what}的输出超过 1 MiB`);
}
// A query a command answers (components/plugins/plugin-host.mjs `queryCommand`, the plugin test host's), given up on as `signal`
// goes off: its result, or the failure it ended with (`settle`). Given up on already, its command is not started (`start`)
// and it fails with the reason, nothing done; given up on while it runs, it fails at once with the reason, and its command,
// started with `signal` as its `cancel`, is stopped.
export async function queryCommand(start, signal) {
  if (signal.aborted) throw Object.assign(signal.reason, { effects: 'none' });
  const { result, error } = settle(await Promise.race([start().done, stopped(signal)]));
  if (error) throw new ContractError(error.code, error.message, error);
  return result;
}
// The failure a command printed as it failed, `{ "error": { code, message, effects } }`, or null for anything else.
function said(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return null; }
  const error = value?.error;
  return error && typeof error === 'object' && typeof error.message === 'string' ? failureOf(error) : null;
}
