import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-coda', version: '1.0.0' } });
  if (method === 'tools/call') {
    if (process.env.CODA_TEST_CALLS) appendFileSync(process.env.CODA_TEST_CALLS, `${JSON.stringify(params)}\n`);
    const { name, arguments: args } = params;
    const value = name === 'status' ? { turn: 'coda-ticket' } : { name, args };
    return send(id, { ...(args.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] });
  }
  send(id, {});
}).on('close', () => process.exit(0));
