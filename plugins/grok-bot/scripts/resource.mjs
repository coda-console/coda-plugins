#!/usr/bin/env node
// The `coda/resource@1` record of the「Grok Bot」type, printed once: a row for each Bot of the login, none without one (the type is
// then offered under「添加资源」). A login that cannot be read or renewed, or a Bot list that cannot be had, is one row saying so; the
// sign-in is in the record either way.
import { recordKey } from '../lib/provider.mjs';
import { NativeAuth } from '../lib/auth.mjs';
import { account } from '../lib/account.mjs';

// The whole reading (the account, the Bots, a renewal and the retry after it: each waits for it, the renewal's own time apart) has
// 20 of the 30 seconds Coda allows, so that the record is printed, with the reason, rather than the reading killed by Coda with nothing.
const budget = AbortSignal.timeout(20_000);
async function read() {
  try {
    const auth = new NativeAuth({ root: process.env.CODA_PLUGIN_STATE });
    if (!auth.client) return [];
    const who = await account(auth, budget);
    const { agents = [] } = await auth.client.request('ListGrokBotAgents', {}, { signal: budget });
    return agents.map(bot => ({ name: bot.name || bot.agentId, identity: recordKey(who.id, bot.agentId), values: [], buttons: [] }));
  } catch (error) { return [{ name: 'Grok Bot', values: [], buttons: [], error: budget.aborted ? '读取超时' : error.status === 401 ? '请重新登录' : error.message }]; }
}
// A renewal or request the time ran out on is still on its way: the record is printed, and that is all this ran for, so this
// ends once it is all written (a pipe takes what it has room for; what is still queued is lost to an exit before then).
process.stdout.write(`${JSON.stringify([{ key: 'account', spec: { type: 'account', title: 'Grok Bot', resources: await read(),
  signIn: { installed: true, installable: false, note: '打开官方登录链接确认；手机可能需要点 Continue。' } } }])}\n`, () => process.exit(0));
