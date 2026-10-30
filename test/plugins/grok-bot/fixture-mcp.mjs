import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-coda', version: '1.0.0' } });
  const server = process.env.CODA_TEST_SERVER ?? 'coda';
  const names = server === 'diagnostics' ? ['machines', 'machine_diagnostics']
    : ['read_thread', 'read_tool_call', 'agents', 'status', 'workflow_status', 'workflow_list', 'spawn', 'send', 'cancel'];
  if (method === 'tools/list') {
    if (process.env.CODA_TEST_DISCOVERY) appendFileSync(process.env.CODA_TEST_DISCOVERY, `${server}\n`);
    return send(id, { tools: [...names, 'forbidden_tool'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) });
  }
  if (method === 'tools/call') {
    if (process.env.CODA_TEST_CALLS) appendFileSync(process.env.CODA_TEST_CALLS, `${JSON.stringify({ ...params, server })}\n`);
    const { name, arguments: args } = params;
    if (!names.includes(name)) return send(id, { isError: true, content: [{ type: 'text', text: `${server} does not provide ${name}` }] });
    const value = name === 'status' ? { turn: 'coda-ticket' } : { name, args };
    return send(id, { ...(args.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] });
  }
  send(id, {});
}).on('close', () => process.exit(0));
