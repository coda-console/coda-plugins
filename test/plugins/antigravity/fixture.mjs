// A stand-in for `agy acp` that declares the additionalDirectories capability in both spellings, as agy 1.5.9 does, and
// answers a session request with the params it received.
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!('id' in m)) return;
  if (m.method === 'initialize') {
    const sessionCapabilities = { list: {}, additionalDirectories: {} };
    send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities, session_capabilities: { ...sessionCapabilities } } } });
  } else send({ id: m.id, result: { received: m.params } });
}).on('close', () => process.exit(0));
