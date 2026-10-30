// Executable fake commands for the real recovery shell. No services, network,
// privilege changes or timing waits: daemon startup/shutdown are synchronous.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const file = process.env.CODA_TEST_TAILSCALE;
const runtime = JSON.parse(readFileSync(file));
const save = () => writeFileSync(file, JSON.stringify(runtime));
const flag = key => args.find(arg => arg.startsWith(`${key}=`))?.slice(key.length + 1);
const stop = () => {
  if (runtime.failStop) throw new Error('shutdown refused');
  if (runtime.daemon) writeFileSync(runtime.daemon.state, JSON.stringify(runtime.daemon.identity));
  runtime.daemon = null;
  save();
};
if (command === 'tailscale') {
  const socket = flag('--socket') ?? 'default';
  if (!runtime.daemon || runtime.daemon.socket !== socket) process.exit(1);
  if (args.includes('up') && runtime.approveLogin) {
    runtime.daemon.identity = { BackendState: 'Running', node: 'new-login' };
    writeFileSync(runtime.daemon.state, JSON.stringify(runtime.daemon.identity));
    save();
  }
  const identity = runtime.daemon.identity;
  console.log(JSON.stringify(identity));
  process.exit(identity.BackendState === 'Running' ? 0 : 1);
} else if (command === 'systemctl') {
  if (args[0] === 'stop') stop();
  else if (args[0] !== 'cat') throw new Error(`Unexpected systemctl ${args}`);
} else if (command === 'pgrep') {
  process.exit(runtime.daemon ? 0 : 1);
} else if (command === 'pkill') {
  stop();
} else if (command === 'start-stop-daemon') {
  if (runtime.daemon) throw new Error('Existing daemon was not stopped');
  if (basename(args[args.indexOf('--exec') + 1]) !== 'tailscaled') throw new Error('Wrong executable');
  const state = flag('--state');
  if (flag('--statedir') !== state.slice(0, state.lastIndexOf('/'))) throw new Error('Nonpersistent state directory');
  runtime.daemon = { socket: flag('--socket'), state, identity: JSON.parse(readFileSync(state)) };
  runtime.starts = (runtime.starts ?? 0) + 1;
  save();
} else {
  throw new Error(`Unexpected command ${command} ${args.join(' ')}`);
}
