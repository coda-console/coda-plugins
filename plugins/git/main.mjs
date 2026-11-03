import { GitProvider } from './lib/provider.mjs';

// Coda uses the same provider in process; plugin-host activation is the external-module entry.
export async function startGitProvider(coda, options) {
  const provider = new GitProvider(coda, options);
  try { await provider.start(); return provider; }
  catch (error) { await provider.stop(); throw error; }
}
let provider;
export async function activate(coda) { provider = await startGitProvider(coda); }
export async function deactivate() { await provider?.stop(); provider = null; }
