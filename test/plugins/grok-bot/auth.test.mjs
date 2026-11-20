import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeAuth } from '../../../plugins/grok-bot/lib/auth.mjs';
import { temporary, fakeClock } from './helpers.mjs';

test('concurrent authentication rejection refreshes once, persists rotated tokens privately, then retries rejected reads', async t => {
  const root = temporary(t), file = join(root, 'native-auth.json');
  writeFileSync(file, JSON.stringify({ accessToken: 'expired', refreshToken: 'old-refresh' }));
  let refreshes = 0, successful = 0;
  const auth = new NativeAuth({ root, clock: fakeClock(), fetcher: async (url, options) => {
    if (new URL(url).pathname === '/oauth/token') {
      refreshes++;
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, 'refresh_token'); assert.equal(body.refresh_token, 'old-refresh');
      return Response.json({ access_token: 'renewed', refresh_token: 'rotated' });
    }
    if (options.headers.authorization === 'Bearer expired') return new Response('{}', { status: 401 });
    assert.equal(options.headers.authorization, 'Bearer renewed'); successful++;
    return Response.json({ agents: [] });
  } });
  await Promise.all([auth.client.request('ListGrokBotAgents', {}), auth.client.request('ListGrokBotAgents', {})]);
  assert.equal(refreshes, 1); assert.equal(successful, 2);
  assert.equal(JSON.parse(readFileSync(file)).refreshToken, 'rotated');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('failed refresh asks for login; network failure never retries an ambiguous write', async t => {
  const root = temporary(t);
  writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'expired', refreshToken: 'refresh' }));
  let calls = 0;
  const auth = new NativeAuth({ root, clock: fakeClock(), fetcher: async url => {
    calls++;
    return new Response('{}', { status: new URL(url).pathname === '/oauth/token' ? 400 : 401 });
  } });
  await assert.rejects(auth.client.request('ListGrokBotAgents', {}), /资源页/);
  assert.equal(calls, 2);
  auth.transport.fetcher = async () => { calls++; throw new Error('connection lost'); };
  await assert.rejects(auth.client.request('SendGrokBotUserMessage', {}), /connection lost/);
  assert.equal(calls, 3);
});

test('a caller that gives up its wait for a renewal does not end it for the others: both Bots wait on one renewal, one is cancelled, the other gets its token', async t => {
  const root = temporary(t);
  writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'expired', refreshToken: 'old-refresh' }));
  let rejected = 0, renewals = 0, answer, started;
  const renewing = new Promise(resolve => { started = resolve; });
  const auth = new NativeAuth({ root, clock: fakeClock(), fetcher: async (url, options) => {
    if (new URL(url).pathname === '/oauth/token') {
      renewals++; started();
      // The renewal answers when the test says, and ends if its own signal does, as a real request would.
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        answer = () => resolve(Response.json({ access_token: 'renewed', refresh_token: 'rotated' }));
      });
    }
    if (options.headers.authorization === 'Bearer expired') { rejected++; return new Response('{}', { status: 401 }); }
    return Response.json({ agents: [] });
  } });
  const cancelled = new AbortController(), staying = new AbortController();
  const first = auth.client.request('ListGrokBotAgents', {}, { signal: cancelled.signal });
  const second = auth.client.request('ListGrokBotAgents', {}, { signal: staying.signal });
  const outcomes = Promise.allSettled([first, second]);
  await renewing;
  // Both have been refused and joined the one renewal (the settling of their refusals is behind them).
  while (rejected < 2) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  cancelled.abort(new Error('cancelled'));
  await assert.rejects(first, /cancelled/);
  answer();
  assert.deepEqual(await second, { agents: [] });
  assert.equal(renewals, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'native-auth.json'))).accessToken, 'renewed');
  await outcomes;
});

test('a Bot removed while the refusal of its request is read starts no renewal; one that then fails is told its own, and the process and the other Bots go on', async t => {
  const root = temporary(t);
  writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'expired', refreshToken: 'old-refresh' }));
  let renewals = 0, renewing = false, reading;
  const auth = new NativeAuth({ root, clock: fakeClock(), fetcher: async (url, options) => {
    if (new URL(url).pathname === '/oauth/token') {
      renewals++;
      return renewing ? Response.json({ access_token: 'renewed' }) : new Response('{}', { status: 503 });
    }
    if (options.headers.authorization !== 'Bearer expired') return Response.json({ agents: [] });
    if (JSON.parse(options.body).bot !== 'removed') return new Response('{}', { status: 401 });
    // The refusal's headers are in; its body is still coming when the Bot is removed, and ends with the request, as a real one does.
    const body = new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    } });
    reading();
    return new Response(body, { status: 401 });
  } });
  // An unhandled rejection would fail this test (and, in the plugin, end its process); this says which it was.
  const unhandled = [];
  const note = reason => unhandled.push(reason);
  process.on('unhandledRejection', note); t.after(() => process.off('unhandledRejection', note));
  const removed = new AbortController(), read = new Promise(resolve => { reading = resolve; });
  const first = auth.client.request('WatchGrokBotTranscripts', { bot: 'removed' }, { signal: removed.signal });
  await read;
  removed.abort(new Error('removed'));
  await assert.rejects(first, /removed/);
  // Another Bot's request is refused too, and its renewal fails: it is told, with the failure marked as the renewal's.
  await assert.rejects(auth.client.request('ListGrokBotAgents', { bot: 'other' }), e => e.renewalFailed && e.status === 503 && e.message === 'Grok 登录续期失败：HTTP 503');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(renewals, 1, 'the removed Bot\'s request renewed nothing');
  // The next goes on as ever: renewed, then answered.
  renewing = true;
  assert.deepEqual(await auth.client.request('ListGrokBotAgents', { bot: 'other' }), { agents: [] });
  assert.equal(renewals, 2);
});
