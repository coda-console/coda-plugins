import { runFinished } from './lib/simulator-status.mjs';

let handler;
export async function activate(coda) {
  handler = await coda.self.handle('run-finished', async ({ run } = {}) => ({ finished: await runFinished(coda, run) }));
}
export async function deactivate() { await handler?.dispose(); handler = null; }
