import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { git as runGit, gitEnvironment } from './git.mjs';

const isolated = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
const git = (cwd, args, options) => runGit(cwd, args, { ...options, extra: isolated });

export const MAX_REQUEST = 32 * 1024 * 1024;
export async function readBody(req, limit = MAX_REQUEST) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Only protocol-v2 request lines, not pack bytes. Validate wants independently of Git's version-dependent
// unadvertised-object rules. A hidden ref must not become readable just by knowing its object ID.
export function wants(body) {
  const result = new Set(); let command;
  for (let offset = 0; offset < body.length;) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/i.test(header)) throw Object.assign(new Error('无效 pkt-line'), { status: 400 });
    const size = parseInt(header, 16); offset += 4;
    if (size <= 2) continue;
    if (size < 4 || offset + size - 4 > body.length) throw Object.assign(new Error('截断的 pkt-line'), { status: 400 });
    const line = body.subarray(offset, offset + size - 4).toString('utf8'); offset += size - 4;
    if (line.startsWith('command=')) {
      if (command || !/^command=(fetch|ls-refs)\n?$/.test(line)) throw Object.assign(new Error('不允许的 Git 命令'), { status: 403 });
      command = line.trim();
    }
    if (line.startsWith('want-ref ')) throw Object.assign(new Error('不支持 want-ref'), { status: 403 });
    if (line.startsWith('want ')) {
      const match = /^want ([a-f0-9]{40}|[a-f0-9]{64})\n?$/.exec(line);
      if (!match) throw Object.assign(new Error('无效 want'), { status: 400 });
      result.add(match[1]);
    }
  }
  if (body.length && !command) throw Object.assign(new Error('缺少 Git 命令'), { status: 400 });
  return result;
}

export function reply(res, status, value) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(typeof value?.error === 'string' ? { ...value, error: { message: value.error } } : value));
}

export function smartHTTP({ lookup, environment }) {
  const children = new Set();
  const handler = async (req, res, caller) => {
    let dir;
    try {
      if (!caller?.local && !['client', 'backend'].includes(caller?.role)) return reply(res, 403, { error: '需要 Coda 鉴权身份' });
      // Match the raw URL. Do not normalize encoded slashes, dot segments, extra queries or absolute paths.
      const match = /^\/repos\/([a-zA-Z0-9_-]{1,100})\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/.exec(req.url);
      if (!match) return reply(res, req.url.includes('receive-pack') ? 403 : 404, { error: '不允许的 Git 路径' });
      const discovery = match[2].startsWith('info/');
      if (req.method !== (discovery ? 'GET' : 'POST')) return reply(res, 405, { error: '不允许的方法' });
      if (req.headers['git-protocol'] !== 'version=2') return reply(res, 400, { error: '需要 Git protocol v2' });
      if (!discovery && req.headers['content-type'] !== 'application/x-git-upload-pack-request')
        return reply(res, 415, { error: '需要 upload-pack 请求' });
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
        return reply(res, 415, { error: '不接受压缩请求体' });
      const source = await lookup(match[1]);
      if (!source) return reply(res, 404, { error: '源未登记或不可用' });
      const env = await environment();
      const body = await readBody(req);
      if (discovery && body.length) return reply(res, 400, { error: 'GET 不接受请求体' });
      const requested = wants(body);
      const refs = (await git(source.path, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/coda/snapshots/'], { env }))
        .split('\n').filter(Boolean).map(line => line.split(' '))
        .filter(([, ref]) => ref.startsWith('refs/heads/') || source.refs.has(ref));
      const tips = [...new Set(refs.map(([oid]) => oid))];
      for (const oid of requested) {
        if (tips.includes(oid)) continue;
        // Normal fetch wants commits; a reachable ancestor is allowed, an unrelated hidden commit/blob is not.
        if (await git(source.path, ['cat-file', '-t', oid], { env, accept: [0, 128] }) !== 'commit')
          return reply(res, 403, { error: '不允许的对象' });
        let reachable = false;
        for (const tip of tips) {
          const base = await git(source.path, ['merge-base', oid, tip], { env, accept: [0, 1] });
          if (base === oid) { reachable = true; break; }
        }
        if (!reachable) return reply(res, 403, { error: '不允许的对象' });
      }
      // A disposable bare view exports only approved refs, and cannot inherit repository http/uploadpack config,
      // replace refs, HEAD pointing at a hidden ref, hooks, or a repository's custom upload-pack command.
      dir = await mkdtemp(join(tmpdir(), 'coda-git-http-'));
      const format = await git(source.path, ['rev-parse', '--show-object-format'], { env });
      await git(dir, ['init', '--bare', `--object-format=${format}`, '--template='], { env });
      const objects = await git(source.path, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { env });
      if (/[\r\n]/.test(objects)) throw new Error('仓库对象路径不支持换行');
      await mkdir(join(dir, 'objects', 'info'), { recursive: true });
      await writeFile(join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
      const shallowPath = await git(source.path, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow'], { env });
      try { await writeFile(join(dir, 'shallow'), await readFile(shallowPath)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (refs.length) await git(dir, ['update-ref', '--stdin'], { env, input: refs.map(([oid, ref]) => `update ${ref} ${oid}\n`).join('') });
      const head = await git(source.path, ['symbolic-ref', '-q', 'HEAD'], { env, accept: [0, 1] });
      await git(dir, ['symbolic-ref', 'HEAD', refs.some(([, ref]) => ref === head) ? head : 'refs/heads/coda-unborn'], { env });
      await bridge(req, res, { dir, env, body, discovery, children });
    } catch (error) {
      if (!res.destroyed) reply(res, error.status ?? 500, { error: error.message });
    } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  };
  handler.dispose = () => { for (const child of children) child.kill('SIGKILL'); };
  return handler;
}

async function bridge(req, res, { dir, env, body, discovery, children }) {
  const child = spawn('git', ['-c', 'http.receivepack=false', '-c', 'http.uploadpack=true',
    '-c', `http.maxRequestBuffer=${MAX_REQUEST}`, 'http-backend'], {
    env: gitEnvironment(env, { ...isolated, GIT_DIR: dir, GIT_HTTP_EXPORT_ALL: '1',
      PATH_TRANSLATED: `${dir}/${discovery ? 'info/refs' : 'git-upload-pack'}`,
      PATH_INFO: discovery ? '/info/refs' : '/git-upload-pack', REQUEST_METHOD: req.method,
      QUERY_STRING: discovery ? 'service=git-upload-pack' : '', CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(body.length), HTTP_GIT_PROTOCOL: req.headers['git-protocol'], SERVER_PROTOCOL: 'HTTP/1.1' }),
  });
  children.add(child);
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  closed.catch(() => {});
  const abort = () => { if (!res.writableFinished) child.kill('SIGKILL'); };
  res.on('close', abort);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const fed = pipeline(Readable.from(body.length ? [body] : []), child.stdin);
  fed.catch(() => {});
  try {
    let headers = Buffer.alloc(0), started = false;
    for await (const chunk of child.stdout) {
      let bytes = chunk;
      if (!started) {
        headers = Buffer.concat([headers, chunk]);
        const split = headers.indexOf('\r\n\r\n');
        if (split < 0) { if (headers.length > 16384) throw new Error('CGI 响应头过大'); continue; }
        // CGI emits headers before consuming a POST. Forwarding them early can cut off long uploads.
        await fed;
        const values = {}; let status = 200;
        for (const line of headers.subarray(0, split).toString().split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon < 1) throw new Error('无效 CGI 响应头');
          const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
          if (key === 'status') status = Number(value.split(' ')[0]);
          else if (['content-type', 'cache-control', 'expires', 'pragma'].includes(key)) values[key] = value;
        }
        res.writeHead(status, values); started = true; bytes = headers.subarray(split + 4); headers = null;
      }
      if (bytes.length && !res.write(bytes)) await drained(res);
    }
    await fed;
    if (await closed !== 0 || !started) throw new Error(`git http-backend: ${stderr || '响应未完成'}`);
    res.end();
  } finally {
    child.kill('SIGKILL'); await closed.catch(() => {}); children.delete(child); res.off('close', abort);
  }
}

function drained(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drain); res.off('close', close); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new Error('连接已关闭')); };
    res.once('drain', drain); res.once('close', close);
    if (res.destroyed) close();
  });
}
