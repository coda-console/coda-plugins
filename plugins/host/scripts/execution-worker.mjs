// A durable worker survives a plugin-host restart. Only this worker updates its running journal.
// The provider recovers by observing it; it never launches a second worker for an existing claim.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Journal } from '../lib/journal.mjs';
import { executeHooks } from '../lib/hooks.mjs';
import { resultFiles } from '../lib/results.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { root, key, source, spec, env } = JSON.parse(Buffer.concat(chunks).toString());
const journal = new Journal(root), record = journal.get(key), signal = new AbortController();
if (!record || record.phase !== 'claimed') throw new Error('没有可启动的持久执行申请');
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${record.control.token}`) { res.writeHead(403).end(); return; }
  if (req.method !== 'POST' || !['/cancel', '/status'].includes(req.url)) { res.writeHead(404).end(); return; }
  if (req.url === '/cancel') signal.abort(new Error('请求已取消'));
  res.writeHead(200).end();
});
for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => signal.abort(new Error('执行已中止')));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
record.control = { port: server.address().port, token: randomUUID() };
record.phase = 'preparing'; record.startedAt = new Date().toISOString(); journal.save(record);
let timer, timeoutHint = '';
if (spec.timeoutMs) timer = setTimeout(() => {
  if (signal.signal.aborted) return;
  if (process.platform === 'darwin' && spawnSync('pgrep', ['-x', 'SecurityAgent'], { stdio: 'ignore' }).status === 0)
    timeoutHint = '；此时屏幕上有钥匙串授权框（SecurityAgent）在等待应答，命令很可能卡在它上面；构建脚本不要读钥匙串，见 host-slots 说明';
  signal.abort(new Error('执行超时'));
}, Math.min(spec.timeoutMs, 2 ** 31 - 1));
try {
  const result = await executeHooks({ root, directory: journal.directory(key), attempt: key, source, slot: record.admission.slot,
    spec, env, signal: signal.signal, checkpoint: async patch => {
      // startedAt is the beginning of preparation, not just the script: preparation can have side effects too.
      const { startedAt, ...rest } = patch; Object.assign(record, rest); journal.save(record);
      if (patch.phase) process.stdout.write(`${JSON.stringify({ execution: key, phase: patch.phase })}\n`);
    } });
  let files = {};
  try { files = await resultFiles(journal.directory(key)); }
  catch (error) { result.outcome = 'failed'; result.reason = { code: 'invalid_outputs', message: error.message }; }
  record.result = { ...result, ...files, finishedAt: new Date().toISOString() };
} catch (error) {
  record.result = { outcome: 'failed', exitCode: null, reason: { code: 'worker_failed', message: error.message }, finishedAt: new Date().toISOString() };
} finally {
  clearTimeout(timer);
  if (timeoutHint) {
    record.result.reason ??= { code: 'cancelled', message: '执行超时' };
    record.result.reason.message += timeoutHint;
  }
  record.phase = 'finished'; record.pid = null; journal.save(record);
  await new Promise(resolve => server.close(resolve));
}
