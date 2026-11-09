import { WechatProvider } from './lib/provider.mjs';
import { phoneBridge } from './lib/bridge.mjs';
let provider;
export async function activate(coda) {
  provider = new WechatProvider(coda, phoneBridge());
  await provider.start();
}
export async function deactivate() { await provider?.stop(); provider = null; }
