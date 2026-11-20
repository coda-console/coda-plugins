#!/usr/bin/env node
// The `coda/resource@1` record of the「Grok Bot」type, printed once: a row for each Bot of the login, none without one (the type is
// then offered under「添加资源」). A login that cannot be read, or that Grok refuses (its renewal refused too), is one row saying
// so; the sign-in is in the record either way. Any other failure (the time running out, the network, a server's error, a renewal
// the server could not give or whose answer is not understood) fails the command (exit 1, the reason on the last line of its
// standard error), which keeps the record Coda has.
import { recordKey } from '../lib/provider.mjs';
import { NativeAuth } from '../lib/auth.mjs';
import { account } from '../lib/account.mjs';

// The whole reading (the account, the Bots, a renewal and the retry after it: each waits for it) has 20 of the 30 seconds Coda
// allows, so that it ends with the reason rather than killed by Coda with nothing. A renewal sent in that time is not ended with
// the reading: it may rotate the refresh token, and only what it writes keeps the login. It has until 28 seconds (`renewBy`).
const budget = AbortSignal.timeout(20_000), renewBy = AbortSignal.timeout(28_000);
const problem = error => [{ name: 'Grok Bot', values: [], buttons: [], error }];
let auth;
async function read() {
  try { auth = new NativeAuth({ root: process.env.CODA_PLUGIN_STATE, renewBy }); } catch (error) { return problem(error.message); }
  if (!auth.client) return [];
  try {
    const who = await account(auth, budget);
    const { agents = [] } = await auth.client.request('ListGrokBotAgents', {}, { signal: budget });
    return agents.map(bot => ({ name: bot.name || bot.agentId, identity: recordKey(who.id, bot.agentId), values: [], buttons: [] }));
  } catch (error) {
    if (error.status === 401 && !budget.aborted) return problem('请重新登录');
    throw new Error(budget.aborted ? '读取超时' : error.message);
  }
}
// A request the time ran out on is still on its way: the record (or the reason) is printed, a renewal on its way has written
// what it got, and that is all this ran for, so this ends once it is all written (a pipe takes what it has room for; what is
// still queued is lost to an exit before then).
const written = (stream, text) => new Promise(resolve => stream.write(text, resolve));
let code = 0;
try {
  await written(process.stdout, `${JSON.stringify([{ key: 'account', spec: { type: 'account', title: 'Grok Bot', resources: await read(),
    signIn: { installed: true, installable: false, note: '打开官方登录链接确认；手机可能需要点 Continue。' } } }])}\n`);
} catch (error) { code = 1; await written(process.stderr, `${String(error.message).replace(/\s+/g, ' ').trim()}\n`); }
await auth?.renewing;
process.exit(code);
