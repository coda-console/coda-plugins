import { createServer, request } from 'node:http';
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { writePrivate } from './auth.mjs';

// A short, private socket path also works when the plugin state path exceeds
// macOS's Unix socket path limit. Only the endpoint is persisted, never a code.
export async function bindingServer(root, bind) {
  const directory = await mkdtemp('/tmp/grok-bind-');
  const socketPath = join(directory, 'socket');
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/bind') throw new Error('未知绑定动作');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await bind(JSON.parse(Buffer.concat(chunks)).record);
      res.end(JSON.stringify({ message: '绑定指令已发给 Bot' }));
    } catch (error) {
      res.writeHead(400); res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  writePrivate(root, join(root, 'binding.json'), { socketPath });
  return async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(join(root, 'binding.json'), { force: true });
    await rm(directory, { recursive: true, force: true });
  };
}

export async function requestBinding(root, record) {
  const { socketPath } = JSON.parse(await readFile(join(root, 'binding.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/bind', method: 'POST' }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const result = JSON.parse(Buffer.concat(chunks));
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(JSON.stringify({ record }));
  });
}
