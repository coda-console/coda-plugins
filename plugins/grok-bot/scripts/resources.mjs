import { NativeAuth } from '../lib/auth.mjs';
import { account } from '../lib/account.mjs';
const auth = new NativeAuth({ root: process.env.CODA_PLUGIN_STATE });
try {
  if (!auth.client) console.log(JSON.stringify({ resources: [] }));
  else {
    const who = await account(auth);
    console.log(JSON.stringify({ resources: [{ name: who.title, identity: `grok-bot:${who.id}`, values: [] }] }));
  }
} catch (error) {
  console.log(JSON.stringify({ resources: [{ name: 'Grok Bot', values: [], error: error.status === 401 ? '请重新登录' : error.message }] }));
}
