import { Scheduler } from './lib/scheduler.mjs';

// Both the in-process Coda assembly and plugin activation use this implementation.
export async function startScheduler(coda, options) {
  const instance = new Scheduler(coda, options);
  try { await instance.start(); return instance; }
  catch (error) { await instance.stop(); throw error; }
}

let scheduler;
export async function activate(coda) {
  scheduler = await startScheduler(coda);
}
export async function deactivate() { await scheduler?.stop(); scheduler = null; }
