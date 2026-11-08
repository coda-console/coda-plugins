import { WechatProvider } from './lib/provider.mjs';
import { unconnected } from './lib/bridge.mjs';
let provider;
export async function activate(coda) {
  provider = new WechatProvider(coda, unconnected);
  await provider.start();
}
export async function deactivate() { await provider?.stop(); provider = null; }
