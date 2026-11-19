// Preloaded into the sign-in process of a plugin (`probed` in command.mjs), which a test then follows by what it notes in the file
// TEST_START_ACK, each noted once the login has dealt with it (after the listeners of what happened have run), not by the clock:
// what its CLI printed, `[exit]` when its CLI has ended, and `[run <command> <first argument>]` when it starts a command (`coda
// progress`, `coda ask`). The 20 seconds it waits for its link end when the file TEST_START_GATE appears instead.
import childProcess from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv[1]?.endsWith('sign-in.mjs')) {
  const note = text => appendFileSync(process.env.TEST_START_ACK, text);
  const { spawn, execFile } = childProcess, set = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== 20_000) return set(fn, ms, ...args);
    const timer = setInterval(() => { if (existsSync(process.env.TEST_START_GATE)) { clearInterval(timer); fn(...args); } }, 20);
    return timer;
  };
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => setImmediate(() => note(chunk)));
    child.on('exit', () => setImmediate(() => note('\n[exit]\n')));
    return child;
  };
  childProcess.execFile = (file, args, ...rest) => { note(`\n[run ${file} ${args[0]}]\n`); return execFile(file, args, ...rest); };
  syncBuiltinESMExports();
}
