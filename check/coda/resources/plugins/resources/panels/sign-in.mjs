import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PanelError } from './rules.mjs';

const check = (condition, code, message) => { if (!condition) throw new PanelError(code, message); };

const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
// A device-code login prints a verification URL that carries the code (`grok login --device-auth`, `kimi login`), or the
// code alone on a line after it. Only whole lines are read: output arrives in pieces, and a URL cut short would carry a
// code cut short. Codex uses a 4-5 code; Grok and Kimi use 4-4.
const codeFormat = /^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/;
export function deviceCode(text) {
  const plain = text.slice(0, text.lastIndexOf('\n') + 1).replace(ansi, '');
  const url = plain.match(/https:\/\/\S+/)?.[0] ?? null;
  let code = null;
  try { code = url && new URL(url).searchParams.get('user_code'); } catch { return null; }
  code ||= plain.match(/^\s*([A-Z0-9]{4}-[A-Z0-9]{4,5})\s*$/m)?.[1] ?? null;
  return url && code && codeFormat.test(code) ? { url, code } : null;
}
// A login that asks for the authorization code its page shows prints the page's link and waits: the first whole line's
// link is it. Checking that the code belongs to this login is the login's own job.
export function authorizationLink(text) {
  const url = text.slice(0, text.lastIndexOf('\n') + 1).replace(ansi, '').match(/https:\/\/\S+/)?.[0];
  try { return url ? { url: new URL(url).href, input: 'authorizationCode' } : null; } catch { return null; }
}
const lastLine = output => output.replace(ansi, '').split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200);
// A command runs through a shell in its own process group (an installer pipes a download into a shell): ending it ends the
// whole group, asked (TERM) or, as the module goes and nothing is left to ask again, made to (KILL).
function end(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

// Signing in from Coda through a plugin's panel (docs/plugins.md「面板的登录」, panels.mjs): `login` is the
// panel's own — its login command, whether what it signs in to is there (`installed()`), the command that installs it, and
// how the link and code are read from what the login prints (`readCode`); `input`, whether the login asks for the
// authorization code its page shows, which goes to its standard input. Coda passes the link and code on; the command writes
// and renews the credentials, which Coda never reads.
// One login or install of each at a time: any page starting it again sees the one under way, and every page is told as it
// moves (`onChange`). Neither outlives the module that started it (`close` ends it), so neither is kept for after a restart.
export class SignIn {
  constructor(login, { env = () => process.env, onChange = () => {}, onSignedIn = () => {}, onInstalled = () => {}, timeoutMs = 15 * 60 * 1000, startTimeoutMs = 20000, installTimeoutMs = 10 * 60 * 1000 }) {
    this.login = login; this.env = env; this.onChange = onChange; this.onSignedIn = onSignedIn; this.onInstalled = onInstalled;
    this.timeoutMs = timeoutMs; this.startTimeoutMs = startTimeoutMs; this.installTimeoutMs = installTimeoutMs;
    this._state = { state: 'idle' }; this.child = null;
  }
  get state() { return this._state; }
  set state(value) { this._state = value; this.onChange(); }
  get available() { return this.login.installed(); }
  view() { return { provider: this.login.provider, name: this.login.name, installed: this.available,
    ...(this.login.note ? { note: this.login.note } : {}), ...this.state }; }
  get busy() { return ['starting', 'waiting', 'installing'].includes(this.state.state); }
  spawn(command, stdin) {
    return spawn('/bin/sh', ['-c', command], { cwd: tmpdir(), env: this.env(), detached: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  }
  // Starts the installer and answers at once: clients follow a download as they follow a waiting login.
  install() {
    if (this.busy) return this.view();
    if (this.available) { this.state = { state: 'idle' }; return this.view(); }
    if (!this.login.install) { this.state = { state: 'failed', error: `这台机器没有安装 ${this.login.name}，Coda 不能代为安装` }; return this.view(); }
    const child = this.spawn(this.login.install, false);
    this.child = child;
    let output = '';
    this.state = { state: 'installing' };
    const due = setTimeout(() => { if (this.child === child) end(child); }, this.installTimeoutMs);
    const read = chunk => { output = (output + chunk).slice(-8000); };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', error => { output += `\n${error.message}`; });
    child.on('close', code => {
      clearTimeout(due);
      if (this.child === child) {
        this.child = null;
        // Asked anew: what was there a moment ago is not what the installer left.
        this.state = code === 0 && this.login.installed(true) ? { state: 'idle' } : { state: 'failed', error: lastLine(output) || '安装没有完成' };
        if (this.state.state === 'idle') this.onInstalled();
      }
    });
    return this.view();
  }
  // Resolves once the link and code are known, or the login has failed.
  start() {
    if (this.busy) return this.ready ?? Promise.resolve(this.view());
    if (!this.available) { this.state = { state: 'failed', error: `这台机器没有安装 ${this.login.name}` }; return Promise.resolve(this.view()); }
    const child = this.spawn(this.login.command, this.login.input);
    child.stdin?.on('error', () => {});
    const attemptId = randomUUID();
    this.child = child;
    let output = '', expired = false, settle;
    const ready = new Promise(resolve => { settle = resolve; });
    const done = () => { settle(this.view()); if (this.ready === ready) this.ready = null; };
    this.ready = ready;
    this.state = { state: 'starting' };
    const startTimer = setTimeout(() => { if (this.child === child && this.state.state === 'starting') end(child); }, this.startTimeoutMs);
    const due = setTimeout(() => { if (this.child === child) { expired = true; end(child); } }, this.timeoutMs);
    const read = chunk => {
      output = (output + chunk).slice(-8000);
      const found = this.state.state === 'starting' && this.child === child && this.login.readCode(output);
      if (found) { this.state = { state: 'waiting', ...found, ...(this.login.input ? { attemptId } : {}) }; done(); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', error => { output += `\n${error.message}`; });
    child.on('close', code => {
      clearTimeout(startTimer); clearTimeout(due);
      if (this.child !== child) return done(); // Cancelled: the state is already idle.
      this.child = null;
      if (code === 0) { this.state = { state: 'idle' }; this.onSignedIn(); }
      else if (expired) this.state = { state: 'expired' };
      else if (this.state.state !== 'idle') this.state = { state: 'failed', error: lastLine(output) || '登录没有完成' };
      done();
    });
    return ready;
  }
  submit({ attemptId, code } = {}) {
    check(this.login.input && this.child && this.state.state === 'waiting' && attemptId === this.state.attemptId,
      'invalid_input', '此登录已结束，请重新登录');
    check(typeof code === 'string' && code.length <= 4096, 'invalid_input', '请粘贴完整的授权码');
    if (!this.state.submitted) {
      this.child.stdin.write(`${code.trim()}\n`);
      this.state = { ...this.state, submitted: true };
    }
    return this.view();
  }
  cancel() {
    const child = this.child; this.child = null;
    if (child) end(child);
    this.state = { state: 'idle' };
    return this.view();
  }
  // `signal`: KILL as the module goes (the plugin host stopping), when nothing would end one that does not stop when asked.
  close(signal = 'SIGTERM') { if (this.child) end(this.child, signal); this.child = null; }
}
