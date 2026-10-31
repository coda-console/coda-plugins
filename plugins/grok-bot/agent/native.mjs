// Grok Bot 0.78.1 private Connect protocol; no vendor source or desktop credentials.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
export const CLIENT_VERSION = '0.78.1';
export const clientHeaders = () => ({ 'x-cursor-client-version': CLIENT_VERSION, 'x-cursor-client-type': 'sand',
  'x-cursor-client-source': 'sand-desktop', 'x-cursor-client-os': 'darwin', 'x-sand-box-namespace': 'prod' });
export const API = 'https://api2.cursor.sh';
const SERVICE = 'aiserver.v1.GrokBotService';
export function loginRequest() {
  const verifier = randomBytes(32).toString('base64url');
  const uuid = randomUUID();
  const url = new URL('https://cursor.com/loginDeepControl');
  url.search = new URLSearchParams({ challenge: createHash('sha256').update(verifier).digest('base64url'),
    uuid, mode: 'login', redirectTarget: 'sand', supportsSelectedTeamLogin: 'true' });
  return { verifier, uuid, url: url.toString() };
}

export function envelope(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

export async function* frames(body) {
  let buffered = Buffer.alloc(0);
  for await (const chunk of body) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 5) {
      const flags = buffered[0], length = buffered.readUInt32BE(1);
      if (length > 32 * 1024 * 1024) throw new Error('Connect frame exceeds 32 MiB');
      if (flags & ~3) throw new Error('Unknown Connect frame flags');
      if (buffered.length < 5 + length) break;
      const bytes = buffered.subarray(5, 5 + length);
      buffered = buffered.subarray(5 + length);
      if (flags & 1) throw new Error('Unexpected compressed Connect frame');
      let message;
      try { message = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error('Invalid Connect JSON frame'); }
      if (flags & 2) {
        if (message.error) throw new Error(`Connect stream failed: ${errorCode(message.error.code)}`);
        return;
      }
      yield message;
    }
  }
  if (buffered.length) throw new Error('Incomplete Connect frame');
  throw new Error('Connect stream ended without its terminal frame');
}

function errorCode(value) {
  return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown';
}

export class NativeClient {
  constructor({ token, teamId, fetcher = fetch, base = API }) {
    Object.assign(this, { token, teamId, fetcher, base });
  }
  async request(method, value, { stream = false, signal = AbortSignal.timeout(30_000) } = {}) {
    const headers = { ...clientHeaders(), authorization: `Bearer ${this.token}`, 'connect-protocol-version': '1',
      'content-type': stream ? 'application/connect+json' : 'application/json',
      ...(stream ? { accept: 'application/connect+json', 'connect-accept-encoding': 'identity' } : {}),
      'x-request-id': randomUUID(), 'x-ghost-mode': 'true' };
    if (this.teamId != null) headers['x-cursor-team-id'] = String(this.teamId);
    const response = await this.fetcher(`${this.base}/${SERVICE}/${method}`, {
      method: 'POST', headers, body: stream ? envelope(value) : JSON.stringify(value), signal, redirect: 'error',
    });
    if (!response.ok) {
      const code = (await response.json().catch(() => ({}))).code;
      throw Object.assign(new Error(`${method}: HTTP ${response.status} (${errorCode(code)})`), { status: response.status });
    }
    return stream ? frames(response.body) : response.json();
  }
}
