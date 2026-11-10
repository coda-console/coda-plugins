import { recordId } from '../lib/provider.mjs';
import { NativeAuth } from '../lib/auth.mjs';
import { account } from '../lib/account.mjs';
const auth = new NativeAuth({ root: process.env.CODA_PLUGIN_STATE });
try {
  if (!auth.client) console.log(JSON.stringify({ resources: [] }));
  else {
    const who = await account(auth);
    const { agents = [] } = await auth.client.request('ListGrokBotAgents', {});
    console.log(JSON.stringify({ resources: agents.map(bot => ({
      name: bot.name || bot.agentId, identity: recordId(who.id, bot.agentId), values: [],
      actions: [{ label: '绑定', view: 'bind', args: { record: recordId(who.id, bot.agentId) } }],
    })) }));
  }
} catch (error) {
  console.log(JSON.stringify({ resources: [{ name: 'Grok Bot', values: [], error: error.status === 401 ? '请重新登录' : error.message }] }));
}
