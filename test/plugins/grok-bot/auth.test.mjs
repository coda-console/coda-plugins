import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeAuth } from '../../../plugins/grok-bot/agent/auth.mjs';
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
  await assert.rejects(auth.client.request('ListGrokBotAgents', {}), /\/login/);
  assert.equal(calls, 2);
  auth.transport.fetcher = async () => { calls++; throw new Error('connection lost'); };
  await assert.rejects(auth.client.request('SendGrokBotUserMessage', {}), /connection lost/);
  assert.equal(calls, 3);
});
