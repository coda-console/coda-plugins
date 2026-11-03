import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { executionEnvironment } from '../lib/environment.mjs';
import { inside, prepareWorkspace } from '../lib/workspace.mjs';

const exec = promisify(execFile), chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { command, responseFile, args, state } = JSON.parse(Buffer.concat(chunks).toString());
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => abort.abort());
try {
  if (command === 'prepare_job') {
    await prepareWorkspace({ ...args, signal: abort.signal, prepared: async workspace => {
      await writeFile(responseFile, JSON.stringify({ state: { workspace, devices: join(args.directory, 'devices') } }), { mode: 0o600 });
    } });
  } else if (command === 'run_script_step') {
    const cwd = await inside(state.workspace, args.workingDirectory);
    // Execution inherits runtime paths, never the plugin host's secrets/settings. Reserved names stay local.
    const env = executionEnvironment({ runtime: process.env, declared: args.env, workflow: args.context?.workflow,
      workspace: state.workspace, directory: process.cwd(), devices: state.devices, metered: args.metered, files: args.files });
    await mkdir(env.RUNNER_TEMP, { recursive: true });
    let program, argv;
    if (Object.hasOwn(args, 'script')) {
      const file = join(process.cwd(), 'script.sh'); await writeFile(file, args.script, { mode: 0o600 });
      program = args.shell ?? 'bash';
      if (!['bash', 'sh'].includes(program)) throw new Error('不支持的脚本 shell');
      argv = program === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail', file] : ['-e', file];
    } else { program = args.command; argv = args.args ?? []; }
    abort.signal.throwIfAborted();
    await Promise.all([writeFile(args.files.output, '', { mode: 0o600 }), writeFile(args.files.summary, '', { mode: 0o600 })]);
    const child = spawn(program, argv, { cwd, env, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
    });
  } else if (command === 'cleanup_job') {
    const devices = await readFile(state.devices, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    for (const device of new Set(devices.split('\n').filter(Boolean))) {
      await exec('xcrun', ['simctl', 'shutdown', device], { signal: abort.signal }).catch(() => {});
      await exec('xcrun', ['simctl', 'delete', device], { signal: abort.signal });
    }
  } else throw new Error(`未知 hook: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = abort.signal.aborted ? 143 : 1; }
