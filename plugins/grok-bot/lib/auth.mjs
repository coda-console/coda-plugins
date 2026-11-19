import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { API, NativeClient, loginRequest, clientHeaders } from './native.mjs';

export function pause(clock, ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clock.clearTimeout(timer); reject(new Error('Stopped')); };
    const timer = clock.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
export function writePrivate(root, file, value) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}
// A caller's wait for work that is shared: its own signal ends its own wait, never the work, which the others are waiting for too.
// The work does not reject (see `refresh`), so a wait given up leaves nothing unhandled behind it.
const waiting = (work, signal) => !signal ? work : new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const abandon = () => reject(signal.reason);
  signal.addEventListener('abort', abandon, { once: true });
  work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abandon));
});
export class NativeAuth {
  constructor({ root, fetcher = fetch, clock = { setTimeout, clearTimeout } }) {
    Object.assign(this, { root, fetcher, clock });
    this.file = root && join(root, 'native-auth.json');
    if (this.file) {
      try { this.use(JSON.parse(readFileSync(this.file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  use(auth) {
    if (typeof auth.accessToken !== 'string' || !auth.accessToken) throw new Error('登录响应缺少 accessToken');
    this.credentials = auth;
    this.transport = new NativeClient({ token: auth.accessToken, teamId: auth.selectedTeamId ?? auth.teamId, fetcher: this.fetcher });
    this.client ??= { request: (...args) => this.request(...args) };
  }
  async request(method, value, options) {
    const auth = this.credentials;
    try { return await this.transport.request(method, value, options); }
    catch (error) {
      // Only a rejected authentication is retried. Never retry an ambiguous
      // transport failure for a message or widget response.
      if (error.status !== 401 || !auth.refreshToken) throw error;
      // A request its caller has given up (as when it went while the refusal's body was read, and the refusal came all the same)
      // is over: it neither starts a renewal nor waits for one.
      options?.signal?.throwIfAborted();
      if (this.credentials === auth) {
        const failure = await waiting(this.refresh(auth), options?.signal);
        if (failure) throw failure;
      }
      return this.transport.request(method, value, options);
    }
  }
  // The renewal shared by the requests the token was refused for, settling to its failure (null once renewed) rather than
  // rejecting: every one of them may have given up its wait, and a failure no one is left to hear must not end the process. The
  // send was already rejected, so a failure (rejected, offline, timed out, unwritable) is marked for callers; its status and
  // message stay as they are.
  refresh(auth) {
    this.renewing ??= (async () => {
      const response = await this.fetcher(`${API}/oauth/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { ...clientHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB', grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
      });
      const renewed = await response.json().catch(() => ({}));
      if (!response.ok || renewed.shouldLogout || typeof renewed.access_token !== 'string' || !renewed.access_token)
        throw Object.assign(new Error('Grok 登录续期失败，请在资源页重新登录'), { status: 401 });
      if (this.credentials !== auth) return; // A completed login supersedes an old refresh.
      const next = { ...auth, accessToken: renewed.access_token, refreshToken: renewed.refresh_token ?? auth.refreshToken };
      writePrivate(this.root, this.file, next);
      this.use(next);
    })().then(() => null, error => Object.assign(error, { renewalFailed: true })).finally(() => { this.renewing = null; });
    return this.renewing;
  }
  // `report(url)`: told the link before anything is polled for or kept; one that fails ends the login with its error.
  login(report) {
    if (this.pending) return this.pending;
    if (!this.file) throw new Error('缺少 CODA_PLUGIN_STATE，无法保存登录');
    const request = loginRequest(), controller = new AbortController();
    const url = new URL('/auth/poll', API);
    url.search = new URLSearchParams({ uuid: request.uuid, verifier: request.verifier });
    const timer = this.clock.setTimeout(() => controller.abort(), 15 * 60_000);
    const promise = (async () => {
      try {
        await report?.(request.url);
        for (;;) {
          const response = await this.fetcher(url, { headers: clientHeaders(), redirect: 'error', signal: controller.signal });
          if (response.status === 404) { await pause(this.clock, 2000, controller.signal); continue; }
          if (!response.ok) throw new Error(`登录失败 HTTP ${response.status}；请在资源页重试`);
          const auth = await response.json();
          if (typeof auth.accessToken !== 'string' || !auth.accessToken) throw new Error('登录响应缺少 accessToken');
          writePrivate(this.root, this.file, auth);
          this.use(auth);
          return;
        }
      } finally { this.clock.clearTimeout(timer); this.pending = null; }
    })();
    this.pending = { url: request.url, promise, controller };
    return this.pending;
  }
  close() { this.pending?.controller.abort(); }
}
