// A plugin's panel commands as Coda runs them (Coda's backend/src/application/panels.mjs `env`, adapters/plugin-command.mjs,
// resources/sign-in.mjs): `sh -c` from a temporary directory, in a process group of its own that goes with it, given the
// plugin's directory and this Node first on the PATH.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginDir } from './plugin.mjs';

export const manifest = id => JSON.parse(readFileSync(join(pluginDir(id), 'package.json'), 'utf8'));
// A resource type (or a panel before them) as its manifest declares it (the first, unless named), its actions as Coda reads
// them: none is `{}`.
export function declaredPanel(id, panelId) {
  const { resources, panels: before } = manifest(id).contributes, panels = resources ?? before, panel = panelId ? panels.find(p => p.id === panelId) : panels[0];
  return { ...panel, actions: panel.actions ?? {} };
}

// The environment Coda gives a plugin's command: its own, the plugin's directory, and `extra` (state, arguments, and what a
// test puts in place of the machine's).
export const pluginEnv = (id, extra = {}) => {
  const inherited = { ...process.env };
  for (const key of ['CODA_PLUGIN_PATH', 'CODA_PLUGIN_STATE', 'CODA_PLUGIN_SETTINGS', 'CODA_PLUGIN_EXTENSIONS', 'CODA_PLUGIN_DEPENDENCIES', 'CODA_USER_PATH']) delete inherited[key];
  const env = { ...inherited, CODA_PLUGIN_SETTINGS: '{}', ...extra, CODA_PLUGIN_PATH: pluginDir(id) };
  env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(':');
  return env;
};

const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch {} };

// A command run once to its end (a panel's reading or action, an installer): its exit code, standard output and error.
export function run(command, env, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: tmpdir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => { killGroup(child.pid); reject(new Error(`${command} 超时`)); }, timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); killGroup(child.pid);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
  });
}

// A panel's `installed` check, as Coda asks it when the login is shown.
export const installed = (command, env) => spawnSync('/bin/sh', ['-c', command], { cwd: tmpdir(), env, stdio: 'ignore', timeout: 2000 }).status === 0;

// A panel's login (`signIn.command`) as Coda starts it: what it prints on either output read as one, and with `input`
// declared, its standard input to write the code to. Ended, with its group, when the test is.
export function signIn(t, command, env) {
  const child = spawn('/bin/sh', ['-c', command], { cwd: tmpdir(), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let output = '';
  const read = chunk => { output += chunk; };
  child.stdout.setEncoding('utf8').on('data', read); child.stderr.setEncoding('utf8').on('data', read);
  const ended = new Promise(resolve => child.on('close', code => { killGroup(child.pid); resolve(code); }));
  t.after(() => killGroup(child.pid));
  return {
    get output() { return output; },
    ended,
    write: text => child.stdin.write(text),
    // Resolves once what it printed matches `pattern`.
    async printed(pattern) {
      for (let i = 0; i < 1000; i++) { if (pattern.test(output)) return output; await delay(10); }
      throw new Error(`没等到 ${pattern}：${JSON.stringify(output)}`);
    },
  };
}

// An operation's command of a plugin (a file with a `#!`, `contributes.protocolImplementations`) as Coda runs it: from the plugin's
// directory, `input` as JSON on its standard input, its process group ended with the test (or `stop(signal)`, as Coda ends it).
// What it printed on each output, and its exit code.
export function operation(t, id, file, env, input = {}) {
  const child = spawn(join(pluginDir(id), file), [], { cwd: pluginDir(id), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(input));
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const ended = new Promise(resolve => child.on('close', code => { killGroup(child.pid); resolve(code); }));
  t.after(() => killGroup(child.pid));
  return { get stdout() { return stdout; }, get stderr() { return stderr; }, ended, stop: signal => process.kill(-child.pid, signal) };
}

// `env` for a sign-in command to be followed by (quick-start.mjs): what it does is noted in the file `ack`, and the 20 seconds
// it waits for its link are ended by the file `gate` appearing instead.
export const probed = (env, { ack, gate }) => ({ ...env, TEST_START_ACK: ack, TEST_START_GATE: gate,
  NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${JSON.stringify(new URL('./quick-start.mjs', import.meta.url).href)}`].filter(Boolean).join(' ') });
// What the login has noted in `ack`, as text.
export const noted = ack => existsSync(ack) ? readFileSync(ack, 'utf8') : '';
// Ends the login's wait for its link once it has noted `said` (it has read what its CLI said): fails, saying why, if it does not in
// 10 seconds.
export async function endWait({ ack, gate }, said) {
  for (let i = 0; !noted(ack).includes(said); i++) {
    if (i >= 1000) throw new Error(`10 秒内登录进程没有读到 CLI 说的「${said}」：${JSON.stringify(noted(ack))}`);
    await delay(10);
  }
  await writeFile(gate, '');
}

// A `coda` for an operation's command to call, as the one on its PATH: `env` with it first on the PATH. It notes each call
// (`calls()`: `{ command, input }`, in order) and answers every `ask` with `answer`. FAKE_CODA_FAIL (a command's name) in the
// environment makes that command fail, FAKE_CODA_AFTER_EXIT (the file `ack` of `probed`) makes `progress` wait until the login has dealt with the exit of its CLI.
export async function fakeCoda(dir, env, answer = {}) {
  const bin = join(dir, 'bin'), log = join(dir, 'coda-calls.jsonl');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'coda'), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [command, json] = process.argv.slice(2);
if (process.env.FAKE_CODA_AFTER_EXIT && command === 'progress') {
  for (let i = 0; !(existsSync(process.env.FAKE_CODA_AFTER_EXIT) && readFileSync(process.env.FAKE_CODA_AFTER_EXIT, 'utf8').includes('[exit]')); i++) {
    if (i >= 1000) { console.error('10 秒内登录进程没有处理完它的 CLI 的退出'); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (process.env.FAKE_CODA_FAIL === command) { console.error('coda ' + command + ' 没有成功'); process.exit(1); }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, input: JSON.parse(json) }) + '\\n');
if (command === 'ask') console.log(process.env.FAKE_CODA_ANSWER);
`, { mode: 0o755 });
  await chmod(join(bin, 'coda'), 0o755);
  await writeFile(log, '');
  return { env: { ...env, PATH: `${bin}:${env.PATH}`, FAKE_CODA_ANSWER: JSON.stringify(answer) },
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
