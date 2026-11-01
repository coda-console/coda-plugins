// The workflow script reaches this plugin's module over a local read-only channel. Only the module
// has coda.api: it asks the supported workflow endpoint afresh, never reads Coda's storage or caches
// eligibility. Coda publishes terminal run states after winding down the run and its children.
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const connection = state => join(state, 'simulator-status.json');

export async function serveSimulatorStatus(coda) {
  const path = connection(coda.plugin.state), token = randomUUID();
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      const match = /^\/runs\/([^/?]+)$/.exec(req.url);
      if (req.method !== 'GET' || !match) { res.writeHead(404).end(); return; }
      const run = await coda.api(`workflow-runs/${encodeURIComponent(decodeURIComponent(match[1]))}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ finished: ['succeeded', 'failed', 'cancelled'].includes(run.state) }));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  // Same loopback + per-process token pattern as the execution worker; no Unix socket path-length limit.
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ port: server.address().port, token }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch (error) { server.close(); throw error; }
  return { dispose: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } };
}

export async function runFinished(state, runId) {
  if (!runId || typeof runId !== 'string') return false;
  const { port, token } = JSON.parse(readFileSync(connection(state), 'utf8'));
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, headers: { authorization: `Bearer ${token}` },
      path: `/runs/${encodeURIComponent(runId)}`, timeout: 5000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200) throw new Error(value.error ?? `运行状态查询失败：${res.statusCode}`);
          resolve(value.finished === true);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('运行状态查询超时')));
    req.on('error', reject); req.end();
  });
}
