import { Scheduler } from './lib/scheduler.mjs';

let scheduler;
export async function activate(coda) {
  scheduler = new Scheduler(coda);
  await scheduler.start();
}
export async function deactivate() { await scheduler?.stop(); scheduler = null; }
