// End-to-end headers for opaque HTTP streams. Credentials and hop-by-hop framing
// belong to each hop; byte ranges and validators belong to the representation.
import { createReadStream } from 'node:fs';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ContractError } from '../domain/errors.mjs';
import { Clock } from './clock.mjs';

// How long an exchange goes on with no byte either way; streaming uploads and forwarding have no total deadline.
export const STREAM_IDLE = 120_000;

// The one inactivity limit of an HTTP exchange (docs/plugins.md「记录的流」): a byte of its body or its answer, as whoever
// carries it hands it on, renews it (`renew`); none either way for `idle` milliseconds on `clock`, `stop` is told why, a
// `timeout`, once. `end` when the exchange is over. It keeps one timer, looked at again only as it comes due.
export function idleLimit(clock, stop, idle = STREAM_IDLE) {
  let last = clock.now(), cancel;
  const look = () => {
    const left = last + idle - clock.now();
    if (left > 0) cancel = clock.after(left, look);
    else stop(new ContractError('timeout', `流连续 ${idle / 1000} 秒没有字节，已中止`));
  };
  cancel = clock.after(idle, look);
  return { renew() { last = clock.now(); }, end() { cancel(); } };
}

// The limit of a request whose body is being received, until it is: for what reads it whole. What streams the exchange has
// the limit of the whole of it, and takes over from this one (`takeOver`), so that an exchange has one at a time; answered
// with its body not all come (`takenOver`), the connection goes with the answer, as nothing receives the rest.
const receiving = new WeakMap();
export function receivingLimit(req, clock, stop, idle) {
  const limit = idleLimit(clock, stop, idle);
  const end = () => { limit.end(); req.off('data', limit.renew).off('end', end).off('close', end); };
  // Paused first: listening starts nothing, what reads the body does.
  req.pause();
  req.on('data', limit.renew).once('end', end).once('close', end);
  receiving.set(req, end);
}
export function takeOver(req) { if (receiving.has(req)) { receiving.get(req)?.(); receiving.set(req, null); } }
export const takenOver = req => receiving.get(req) === null;

export const REQUEST_HEADERS = ['content-type', 'content-length', 'content-encoding', 'accept', 'accept-encoding',
  'git-protocol', 'range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'x-coda-request'];
export const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-disposition',
  'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'expires', 'vary'];
// Says that an answer of a record's stream is the stream's own (transport/record-streams.mjs), whatever its status; what
// refuses it on the way — the backend, the holder's, a node — does not say so. Set by the backend, never by a handler.
export const ANSWERED = 'x-coda-stream';
export const pickHeaders = (headers, names) => Object.fromEntries(names.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]));

// Whether a path has a segment `.` or `..`, which would take it elsewhere where it is read: `%2e` for a dot, `\` for a
// slash, and `%2f`, `%5c` for either (a proxy on the way writes `\` as `%5c`).
export const dotted = path => path.split(/[/\\]|%2f|%5c/i).some(part => ['.', '..'].includes(part.toLowerCase().replaceAll('%2e', '.')));

// A request's body as a web stream, read from as it is read and no further. Given up, it stops reading and leaves the
// request open: its connection has the answer to carry.
export function bodyOf(req) {
  const chunks = req.iterator({ destroyOnReturn: false });
  return new ReadableStream({
    async pull(out) {
      const { done, value } = await chunks.next();
      if (done) out.close(); else out.enqueue(value);
    },
    cancel() { chunks.return().catch(() => {}); },
  }, { highWaterMark: 0 });
}

// The first of a body's bytes, past empty chunks, or its end, as its `reader` reads it (none: no body): what the head of an
// answer waits for, so that what fails before it is still answered.
export async function firstBytes(reader) {
  for (;;) {
    const read = reader ? await reader.read() : { done: true };
    if (read.done || read.value.length) return read;
  }
}

// Do not end the upload when response headers arrive: a handler may answer while
// still reading. pipe supplies backpressure in both directions, without JSON IPC.
export function pipeHttp(req, res, options, { clock = new Clock(), idle = STREAM_IDLE } = {}) {
  return new Promise(resolve => {
    let answer, over = false;
    const refuse = (status, code, message, headers = {}) => {
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify({ error: { code, message } }));
      } else res.destroy();
    };
    takeOver(req);
    const limit = idleLimit(clock, error => {
      // Answered already, what is left of the request is all there was.
      if (res.headersSent) req.destroy();
      refuse(409, error.code, error.message, { connection: 'close' });
      cancel();
    }, idle);
    const ended = () => { if (over && (req.readableEnded || req.destroyed)) limit.end(); };
    const done = () => { over = true; ended(); resolve(); };
    const out = request({ ...options, method: req.method,
      // A body of no said length is framed whatever the method is.
      headers: { ...pickHeaders(req.headers, REQUEST_HEADERS), ...(req.headers['transfer-encoding'] ? { 'transfer-encoding': 'chunked' } : {}), ...options.headers } }, incoming => {
      answer = incoming;
      res.writeHead(answer.statusCode, pickHeaders(answer.headers, RESPONSE_HEADERS));
      answer.pipe(res);
      answer.on('data', limit.renew);
      answer.on('end', done);
      answer.on('error', error => { res.destroy(error); done(); });
    });
    const cancel = () => { done(); limit.end(); req.unpipe(out); out.destroy(); answer?.destroy(); };
    req.once('aborted', cancel);
    req.once('end', ended); req.once('close', ended);
    res.once('close', () => { if (!res.writableFinished) cancel(); });
    out.on('error', () => {
      if (!over) refuse(503, 'service_unavailable', '流式服务暂时不可用');
      done();
    });
    req.pipe(out);
    req.on('data', limit.renew);
  });
}

// An exchange asked over HTTP (`options`, as `request` takes them), both bodies streamed: `body`, a web stream sent as it
// is read, or none. The answer, when it is the one asked's own (`own(res)`), as a `Response`: its status, its headers of
// `RESPONSE_HEADERS`, its body as it comes, not held. Anything else is a refusal, `refused(error)` given what its body says
// (`{ error }`), null when it says none; broken off before it is answered, `broken(error)`. Once answered, no more of the
// body is sent, and the connection goes with the answer; a break of the answer's body errors it. `options.signal`: given up
// on with it, both bodies too.
export function openHttp(options, body, { own, refused, broken }) {
  return new Promise((resolve, reject) => {
    const source = body && Readable.fromWeb(body);
    // A body of no said length is framed whatever the method is.
    const framing = source && options.headers['content-length'] === undefined ? { 'transfer-encoding': 'chunked' } : {};
    const req = request({ ...options, headers: { ...options.headers, ...framing } }, res => {
      if (source && !source.readableEnded) { source.unpipe(req); source.destroy(); res.once('close', () => req.destroy()); }
      if (own(res)) {
        const bare = [204, 205, 304].includes(res.statusCode);
        if (bare) res.resume();
        return resolve(new Response(bare ? null : Readable.toWeb(res), { status: res.statusCode, headers: pickHeaders(res.headers, RESPONSE_HEADERS) }));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let error = null;
        try { error = JSON.parse(Buffer.concat(chunks)).error; } catch { /* said below */ }
        reject(refused(error && typeof error === 'object' ? error : null));
      });
    });
    req.on('error', error => reject(error.name === 'AbortError' ? error : broken(error)));
    if (!source) return void req.end();
    // It may be answered before the first of its body comes.
    req.flushHeaders();
    req.once('error', () => source.destroy());
    source.on('error', error => req.destroy(error)).pipe(req);
  });
}

// The bytes a Range header asks for (RFC 9110 §14): the last n (`-n`), from one on (`a-`), or from one to another
// (`a-b`). One that does not parse, or several, is none, and the whole file is answered, as a server may; `start` past
// `end` is a range none of the file is in.
function byteRange(header, size) {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!asked || (!asked[1] && !asked[2])) return null;
  if (!asked[1]) return { start: Math.max(0, size - Number(asked[2])), end: size - 1 };
  const start = Number(asked[1]);
  if (asked[2] && Number(asked[2]) < start) return null;
  return { start, end: asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1 };
}

// A file as HTTP clients read one: whole, or the range a player asks for as it streams (206, or 416 for one past the
// end). `headers`: what describes it, its type and validators.
export async function sendFile(req, res, path, size, headers) {
  const range = byteRange(req.headers.range, size);
  if (range && range.start > range.end) {
    res.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` }); res.end(); return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, { ...headers, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  await pipeline(createReadStream(path, { start, end }), res);
}
