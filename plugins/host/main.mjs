import { HostProvider } from './lib/provider.mjs';

let provider;
export async function activate(coda) {
  provider = new HostProvider(coda);
  try { await provider.start(); } catch (error) { await provider.stop(); throw error; }
}
export async function deactivate() { await provider?.stop(); provider = null; }
