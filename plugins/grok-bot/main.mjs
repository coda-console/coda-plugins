import { Provider } from './lib/provider.mjs';
let provider;
export async function activate(coda) {
  provider = new Provider(coda);
  await provider.start();
}
export async function deactivate() { await provider?.stop(); provider = null; }
