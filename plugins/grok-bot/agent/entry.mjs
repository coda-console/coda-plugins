import { pathToFileURL } from 'node:url';
import { Rpc } from './rpc.mjs';
import { Adapter } from './session.mjs';

export function serve(input = process.stdin, output = process.stdout, options = {}) {
  const rpc = new Rpc(input, output, (method, params) => adapter.handle(method, params));
  const adapter = new Adapter({ rpc, ...options });
  rpc.lines.on('close', () => adapter.close());
  return { rpc, adapter };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { adapter } = serve();
  process.on('SIGTERM', () => { adapter.close(); process.exit(0); });
  process.stdin.on('end', () => { adapter.close(); process.exit(0); });
}
