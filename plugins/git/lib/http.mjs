import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { git as runGit, gitEnvironment } from './git.mjs';

const isolated = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };

export const MAX_REQUEST = 32 * 1024 * 1024;
export async function readBody({ body }, limit = MAX_REQUEST) {
  const chunks = []; let length = 0;
  for await (const chunk of body ?? []) {
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

export const reply = (status, value) =>
  Response.json(typeof value.error === 'string' ? { ...value, error: { message: value.error } } : value, { status, headers: { 'cache-control': 'no-store' } });

// What was asked, as it came: an empty query or a doubled slash is not the path without it.
export const pathOf = request => request.url.slice(new URL(request.url).origin.length);

const ROUTE = /^\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/;

// The stream `transport` of a source's record. Who may read it, Coda has judged.
export function smartHTTP({ lookup }) {
  const exchanges = new Set();
  // An exchange goes on past its answer, until the answer's body is over: what it started and its directory go with it. A
  // request ending in 4xx or 5xx is logged once: status, reason, method, source (with the path if it is not one of the two),
  // and the three headers that decide it. Never the authorization header, cookies or the body.
  async function exchange(request, id, signal, respond) {
    const path = pathOf(request), match = ROUTE.exec(path);
    const refuse = (status, error) => {
      const header = name => request.headers.has(name) ? JSON.stringify(request.headers.get(name)) : '无';
      console.error('[git http]', status, error, request.method, `source=${id}`, ...(match ? [] : [`path=${JSON.stringify(path)}`]),
        `content-type=${header('content-type')}`, `content-encoding=${header('content-encoding')}`, `git-protocol=${header('git-protocol')}`);
      respond(reply(status, { error }));
    };
    const git = (cwd, args, options) => runGit(cwd, args, { ...options, extra: isolated, signal });
    let dir;
    try {
      if (!match) return refuse(path.includes('receive-pack') ? 403 : 404, '不允许的 Git 路径');
      const discovery = match[1].startsWith('info/');
      if (request.method !== (discovery ? 'GET' : 'POST')) return refuse(405, '不允许的方法');
      if (request.headers.get('git-protocol') !== 'version=2') return refuse(400, '需要 Git protocol v2');
      if (!discovery && request.headers.get('content-type') !== 'application/x-git-upload-pack-request')
        return refuse(415, '需要 upload-pack 请求');
      if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')
        return refuse(415, '不接受压缩请求体');
      const source = await lookup(id, signal);
      if (!source) return refuse(404, '源未登记或不可用');
      const body = await readBody(request);
      const requested = wants(body);
      const refs = (await git(source.path, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/']))
        .split('\n').filter(Boolean).map(line => line.split(' '));
      const tips = [...new Set(refs.map(([oid]) => oid))];
      for (const oid of requested) {
        if (tips.includes(oid)) continue;
        // Normal fetch wants commits; a reachable ancestor is allowed, an unrelated hidden commit/blob is not.
        if (await git(source.path, ['cat-file', '-t', oid], { accept: [0, 128] }) !== 'commit')
          return refuse(403, '不允许的对象');
        let reachable = false;
        for (const tip of tips) {
          const base = await git(source.path, ['merge-base', oid, tip], { accept: [0, 1] });
          if (base === oid) { reachable = true; break; }
        }
        if (!reachable) return refuse(403, '不允许的对象');
      }
      // A disposable bare view exports only approved refs, and cannot inherit repository http/uploadpack config,
      // replace refs, HEAD pointing at a hidden ref, hooks, or a repository's custom upload-pack command.
      dir = await mkdtemp(join(tmpdir(), 'coda-git-http-'));
      const format = await git(source.path, ['rev-parse', '--show-object-format']);
      await git(dir, ['init', '--bare', `--object-format=${format}`, '--template=']);
      const objects = await git(source.path, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
      if (/[\r\n]/.test(objects)) throw new Error('仓库对象路径不支持换行');
      await mkdir(join(dir, 'objects', 'info'), { recursive: true });
      await writeFile(join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
      const shallowPath = await git(source.path, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
      try { await writeFile(join(dir, 'shallow'), await readFile(shallowPath)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (refs.length) await git(dir, ['update-ref', '--stdin'], { input: refs.map(([oid, ref]) => `update ${ref} ${oid}\n`).join('') });
      const head = await git(source.path, ['symbolic-ref', '-q', 'HEAD'], { accept: [0, 1] });
      await git(dir, ['symbolic-ref', 'HEAD', refs.some(([, ref]) => ref === head) ? head : 'refs/heads/coda-unborn']);
      await bridge(request, { dir, body, discovery, signal, respond });
    } catch (error) {
      if (signal.aborted) throw error;
      refuse(error.status ?? 500, error.message);
    } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  }
  const handler = (request, { record, signal }) => new Promise((resolve, reject) => {
    const running = exchange(request, record.id, signal, resolve).catch(reject).finally(() => exchanges.delete(running));
    exchanges.add(running);
  });
  // Those under way, which its registration disposed of ends (their `signal`), over.
  handler.ended = () => Promise.all(exchanges);
  return handler;
}

async function bridge(request, { dir, body, discovery, signal, respond }) {
  signal.throwIfAborted();
  // In a process group of its own: what it runs (upload-pack, pack-objects) is stopped with it.
  const child = spawn('git', ['-c', 'http.receivepack=false', '-c', 'http.uploadpack=true',
    '-c', `http.maxRequestBuffer=${MAX_REQUEST}`, 'http-backend'], {
    detached: true,
    env: gitEnvironment(process.env, { ...isolated, GIT_DIR: dir, GIT_HTTP_EXPORT_ALL: '1',
      PATH_TRANSLATED: `${dir}/${discovery ? 'info/refs' : 'git-upload-pack'}`,
      PATH_INFO: discovery ? '/info/refs' : '/git-upload-pack', REQUEST_METHOD: request.method,
      QUERY_STRING: discovery ? 'service=git-upload-pack' : '', CONTENT_TYPE: request.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(body.length), HTTP_GIT_PROTOCOL: request.headers.get('git-protocol'), SERVER_PROTOCOL: 'HTTP/1.1' }),
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  closed.catch(() => {});
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* It did not start, or has exited. */ } };
  signal.addEventListener('abort', stop);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const fed = pipeline(Readable.from(body.length ? [body] : []), child.stdin);
  fed.catch(() => {});
  let out;
  try {
    let headers = Buffer.alloc(0);
    for await (const chunk of child.stdout) {
      let bytes = chunk;
      if (!out) {
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
        out = new PassThrough(); bytes = headers.subarray(split + 4); headers = null;
        respond(new Response(Readable.toWeb(out), { status, headers: values }));
      }
      if (bytes.length && !out.write(bytes)) await once(out, 'drain', { signal });
    }
    await fed;
    if (await closed !== 0 || !out) throw new Error(`git http-backend: ${stderr || '响应未完成'}`);
    out.end();
  } catch (error) {
    stop(); out?.destroy(error);
    throw error;
  } finally {
    await closed.catch(() => {}); signal.removeEventListener('abort', stop);
  }
}
