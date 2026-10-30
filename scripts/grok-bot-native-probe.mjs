#!/usr/bin/env node
// An opt-in probe of the Grok Bot 0.78.1 desktop client's private Connect protocol.
// Authenticate through the normal browser login; never read the desktop app's credential store.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api2.cursor.sh';
const SERVICE = 'aiserver.v1.GrokBotService';
const STATE = join(homedir(), '.local', 'state', 'coda-grok-native-probe');
const AUTH = join(STATE, 'auth.json');
const emit = value => console.log(JSON.stringify(value));
const USAGE = 'Usage: login | bots | history <bot-id> [output.json] | watch <bot-id> [output.ndjson] | send <bot-id> (text on stdin)';

async function privateFile(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'w', 0o600);
  await file.chmod(0o600);
  return file;
}

export function loginRequest() {
  const verifier = randomBytes(32).toString('base64url');
  const uuid = randomUUID();
  const url = new URL('https://cursor.com/loginDeepControl');
  url.search = new URLSearchParams({ challenge: createHash('sha256').update(verifier).digest('base64url'),
    uuid, mode: 'login', redirectTarget: 'sand', supportsSelectedTeamLogin: 'true' });
  return { verifier, uuid, url: url.toString() };
}

async function login() {
  const pending = loginRequest();
  emit({ state: 'waiting_for_login', url: pending.url });
  const url = new URL('/auth/poll', API);
  url.search = new URLSearchParams({ uuid: pending.uuid, verifier: pending.verifier });
  const signal = AbortSignal.timeout(15 * 60_000);
  for (;;) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, signal, redirect: 'error' });
    if (response.status === 404) { await delay(2000, undefined, { signal }); continue; }
    if (!response.ok) throw new Error(`Login failed (HTTP ${response.status}); no credential was saved`);
    const answer = await response.json();
    if (!answer.accessToken) throw new Error('The login did not return a Cursor access token; this probe does not yet support xAI-only login');
    const file = await privateFile(AUTH);
    try { await file.writeFile(JSON.stringify(answer)); } finally { await file.close(); }
    emit({ state: 'signed_in', credentialFile: AUTH, teamId: answer.selectedTeamId ?? answer.teamId ?? null });
    return;
  }
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
    const headers = { authorization: `Bearer ${this.token}`, 'connect-protocol-version': '1',
      'content-type': stream ? 'application/connect+json' : 'application/json',
      'x-request-id': randomUUID(), 'x-ghost-mode': 'true' };
    if (this.teamId != null) headers['x-cursor-team-id'] = String(this.teamId);
    const response = await this.fetcher(`${this.base}/${SERVICE}/${method}`, {
      method: 'POST', headers, body: stream ? envelope(value) : JSON.stringify(value), signal, redirect: 'error',
    });
    if (!response.ok) {
      const code = (await response.json().catch(() => ({}))).code;
      throw new Error(`${method}: HTTP ${response.status} (${errorCode(code)})`);
    }
    return stream ? frames(response.body) : response.json();
  }
}

export function entrySummary(entry) {
  return { seq: entry.seq, updatedSeq: entry.updatedSeq, entryId: entry.entryId,
    entryKind: entry.entryKind, bodyOmitted: entry.bodyOmitted ?? false,
    bodyBytes: Buffer.from(entry.body ?? '', 'base64').length };
}

function liveSummary(live) {
  return { agentId: live.agentId, sessionId: live.sessionId ?? '', isRunning: live.isRunning ?? false,
    isComposingMessage: live.isComposingMessage ?? false, isRetrying: live.isRetrying ?? false,
    activity: live.activity && { kind: live.activity.kind, tool: live.activity.tool, callId: live.activity.callId },
    awaiting: !!live.awaiting, hasRunningSubagents: live.hasRunningSubagents ?? false,
    lastTurnSettlement: live.lastTurnSettlement && { turnId: live.lastTurnSettlement.turnId,
      outcome: live.lastTurnSettlement.outcome, settledAtMs: live.lastTurnSettlement.settledAtMs } };
}

// Unknown frame bodies, message text, tool details and client previews stay out of stdout.
export function eventSummary(event) {
  const result = { types: Object.keys(event) };
  if (event.rows) result.rows = { agentId: event.rows.agentId, sessionId: event.rows.sessionId ?? '',
    generation: event.rows.generation ?? 0, replay: event.rows.replay ?? false,
    entries: (event.rows.entries ?? []).map(entrySummary), deletes: event.rows.deletes?.length ?? 0 };
  if (event.agentState) result.agentState = { snapshot: event.agentState.snapshot ?? false,
    live: (event.agentState.live ?? []).map(liveSummary), clients: event.agentState.client?.length ?? 0 };
  if (event.turnFailed) result.turnFailed = { agentId: event.turnFailed.agentId,
    sessionId: event.turnFailed.sessionId, turnId: event.turnFailed.turnId, code: event.turnFailed.code };
  return result;
}

export function cursor(agentId, history) {
  // Protocol uint64 values are JSON strings, and can exceed Number's safe range.
  const afterUpdatedSeq = (history.entries ?? []).reduce((last, entry) => {
    const seq = BigInt(entry.updatedSeq ?? 0);
    return seq > last ? seq : last;
  }, 0n).toString();
  return { agentId, sessionId: '', generation: history.generation ?? 0, afterUpdatedSeq };
}

export async function sendMessage(client, agentId, text) {
  if (!text.trim()) throw new Error('send requires nonempty text on stdin');
  const messageId = randomUUID();
  const result = await client.request('SendGrokBotUserMessage', { agentId, messageId, text,
    sentAtMs: String(Date.now()), sessionId: '', source: 1, initiator: 1, sendSource: 1 });
  // Delivery acceptance is not turn completion. No retries or report instructions.
  return { messageId, dispatched: result.dispatched ?? false, mode: result.mode, delivery: result.delivery };
}

export async function main([command, bot, output]) {
  if (!['login', 'bots', 'history', 'watch', 'send'].includes(command)
    || (['history', 'watch', 'send'].includes(command) && !bot)
    || (['login', 'bots'].includes(command) && bot) || (command === 'send' && output)) throw new Error(USAGE);
  if (output && resolve(output) === AUTH) throw new Error('Output must not overwrite the login credential file');
  if (command === 'login') return login();
  const auth = JSON.parse(await readFile(AUTH, 'utf8').catch(() => { throw new Error('Run login first'); }));
  const client = new NativeClient({ token: auth.accessToken, teamId: auth.selectedTeamId ?? auth.teamId });
  if (command === 'bots') {
    const result = await client.request('ListGrokBotAgents', {});
    emit({ bots: result.agents?.map(({ id, agentId, name, title, viewerSessionId }) => ({ id, agentId, name, title, viewerSessionId })), truncated: result.truncated ?? false });
    return;
  }
  if (command === 'send') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return emit(await sendMessage(client, bot, Buffer.concat(chunks).toString('utf8')));
  }
  const history = await client.request('ListGrokBotTranscriptEntries', { agentId: bot, limit: 30, sessionId: '' });
  emit({ generation: history.generation ?? 0, entries: (history.entries ?? []).map(entrySummary) });
  if (command === 'history') {
    if (output) {
      const file = await privateFile(resolve(output));
      try { await file.writeFile(JSON.stringify(history)); } finally { await file.close(); }
    }
    return;
  }
  const file = output ? await privateFile(resolve(output)) : null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
  try {
    const stream = await client.request('WatchGrokBotTranscripts', {
      cursors: [cursor(bot, history)], includeUnlistedAgents: false, inlineBodyMaxBytes: 262144,
    }, { stream: true, signal });
    for await (const event of stream) {
      if (file) await file.write(`${JSON.stringify(event)}\n`);
      emit({ event: eventSummary(event) });
      if (event.cleared || event.cursorTooOld) throw new Error('Transcript cursor reset; reload history and restart watch');
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    emit({ state: 'watch_stopped', reason: controller.signal.aborted ? 'signal' : 'five_minute_limit' });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await file?.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
