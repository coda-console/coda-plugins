// A plugin's panel commands as Coda runs them (Coda's backend/src/application/panels.mjs `env`, adapters/plugin-command.mjs,
// resources/sign-in.mjs): `sh -c` from a temporary directory, in a process group of its own that goes with it, given the
// plugin's directory and this Node first on the PATH.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
