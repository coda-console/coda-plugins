import { randomUUID } from 'node:crypto';
import { lastLine, settle, startPluginCommand } from '../../../../adapters/plugin-command.mjs';
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

// Signing in from Coda through a plugin's panel (docs/plugins.md「面板的登录」, panels.mjs): `login` is the
// panel's own — its login command, whether what it signs in to is there (`installed()`), the command that installs it, and
// how the link and code are read from what the login prints (`readCode`); `input`, whether the login asks for the
// authorization code its page shows, which goes to its standard input. Coda passes the link and code on; the command writes
// and renews the credentials, which Coda never reads.
// One login or install of each at a time: any page starting it again sees the one under way, and every page is told as it
// moves (`onChange`). Neither outlives the module that started it (`close` ends it), so neither is kept for after a restart.
// Both run as every plugin command does (adapters/plugin-command.mjs, docs/plugins.md「命令的约定」), through `start`, from
// the plugin's directory: in a process group of their own, cancelled with TERM and made to end past the grace. Neither
// answers: what they print is read for the link and code, or for why they failed, and ending with 0 is all of it.
export class SignIn {
  constructor(login, { start, env = () => process.env, onChange = () => {}, onSignedIn = () => {}, onInstalled = () => {}, timeoutMs = 15 * 60 * 1000, startTimeoutMs = 20000, installTimeoutMs = 10 * 60 * 1000 }) {
    this.login = login; this.processStart = start; this.env = env; this.onChange = onChange; this.onSignedIn = onSignedIn; this.onInstalled = onInstalled;
    this.timeoutMs = timeoutMs; this.startTimeoutMs = startTimeoutMs; this.installTimeoutMs = installTimeoutMs;
    this._state = { state: 'idle' }; this.child = null;
  }
  get state() { return this._state; }
  set state(value) { this._state = value; this.onChange(); }
  get available() { return this.login.installed(); }
  view() { return { provider: this.login.provider, name: this.login.name, installed: this.available,
    ...(this.login.note ? { note: this.login.note } : {}), ...this.state }; }
  get busy() { return ['starting', 'waiting', 'installing'].includes(this.state.state); }
  spawn(command, { open = false, tail = false, timeoutMs, onOutput }) {
    const env = this.env();
    return startPluginCommand(command, { start: this.processStart, cwd: env.CODA_PLUGIN_PATH, env, open, tail, timeoutMs, onOutput });
  }
  // Starts the installer and answers at once: clients follow a download as they follow a waiting login.
  install() {
    if (this.busy) return this.view();
    if (this.available) { this.state = { state: 'idle' }; return this.view(); }
    if (!this.login.install) { this.state = { state: 'failed', error: `这台机器没有安装 ${this.login.name}，Coda 不能代为安装` }; return this.view(); }
    // An installer may say much on its way: the last of it is kept, and it is never stopped for that.
    const child = this.spawn(this.login.install, { tail: true, timeoutMs: this.installTimeoutMs });
    this.child = child;
    this.state = { state: 'installing' };
    child.done.then(ran => {
      if (this.child === child) {
        this.child = null;
        const { error } = settle(ran, { answers: false, what: '安装' });
        // Asked anew: what was there a moment ago is not what the installer left.
        this.state = !error && this.login.installed(true) ? { state: 'idle' } : { state: 'failed', error: error?.message ?? '安装没有完成' };
        if (this.state.state === 'idle') this.onInstalled();
      }
    });
    return this.view();
  }
  // Resolves once the link and code are known, or the login has failed.
  start() {
    if (this.busy) return this.ready ?? Promise.resolve(this.view());
    if (!this.available) { this.state = { state: 'failed', error: `这台机器没有安装 ${this.login.name}` }; return Promise.resolve(this.view()); }
    const attemptId = randomUUID();
    let output = '', silent = false, settleReady;
    const ready = new Promise(resolve => { settleReady = resolve; });
    const done = () => { settleReady(this.view()); if (this.ready === ready) this.ready = null; };
    const read = chunk => {
      output = (output + chunk).slice(-8000);
      const found = this.state.state === 'starting' && this.child === child && this.login.readCode(output);
      if (found) { this.state = { state: 'waiting', ...found, ...(this.login.input ? { attemptId } : {}) }; done(); }
    };
    const child = this.spawn(this.login.command, { open: this.login.input, timeoutMs: this.timeoutMs, onOutput: read });
    this.child = child;
    this.ready = ready;
    this.state = { state: 'starting' };
    const startTimer = setTimeout(() => { if (this.child === child && this.state.state === 'starting') { silent = true; child.stop(); } }, this.startTimeoutMs);
    child.done.then(ran => {
      clearTimeout(startTimer);
      if (this.child !== child) return done(); // Cancelled: the state is already idle.
      this.child = null;
      const { error } = settle(ran, { answers: false, what: '登录' });
      if (!error) { this.state = { state: 'idle' }; this.onSignedIn(); }
      else if (ran.timedOut) this.state = { state: 'expired' };
      // Stopped for printing no link in time, it failed as it says, not as one cancelled.
      else if (this.state.state !== 'idle') this.state = { state: 'failed', error: silent ? lastLine(output) || '登录没有完成' : error.message };
      done();
    });
    return ready;
  }
  submit({ attemptId, code } = {}) {
    check(this.login.input && this.child && this.state.state === 'waiting' && attemptId === this.state.attemptId,
      'invalid_input', '此登录已结束，请重新登录');
    check(typeof code === 'string' && code.length <= 4096, 'invalid_input', '请粘贴完整的授权码');
    if (!this.state.submitted) {
      this.child.write(`${code.trim()}\n`);
      this.state = { ...this.state, submitted: true };
    }
    return this.view();
  }
  cancel() {
    const child = this.child; this.child = null;
    child?.stop();
    this.state = { state: 'idle' };
    return this.view();
  }
  // `signal`: KILL as the module goes (the plugin host stopping), when nothing would end one that does not stop when asked.
  close(signal = 'SIGTERM') { if (signal === 'SIGKILL') this.child?.kill(); else this.child?.stop(); this.child = null; }
}
