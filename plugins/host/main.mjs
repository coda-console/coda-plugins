import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFinished } from './lib/simulator-status.mjs';

const GROUP = 'coda/group@1', KIND = 'host/kind@1';
let handler, changes, kinds;
export async function activate(coda) {
  handler = await coda.self.handle('run-finished', async ({ run } = {}) => ({ finished: await runFinished(coda, run) }));
  changes = coda.settings.onChange(settings => declare(coda, settings));
  await declare(coda, await coda.settings.get());
  // host-sim is started by a session's PATH, with no plugin token: it reads this file instead of asking for the records.
  const file = join(coda.plugin.state, 'kinds.json');
  const write = list => { mkdirSync(coda.plugin.state, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(list)); renameSync(`${file}.tmp`, file); };
  const publish = async () => write((await coda.list(KIND, { scope: 'local' }))
    .map(({ plugin, spec }) => ({ plugin, command: spec.command })).sort((a, b) => a.plugin.localeCompare(b.plugin)));
  write([]);
  // One after another, so that an older reading does not land after a newer one; one that fails is that one's alone.
  let written = Promise.resolve();
  kinds = await coda.watch(KIND, () => { written = written.then(publish).catch(error => console.error(`设备种类写入 kinds.json 失败：${error.message}`)); }, { scope: 'local' });
}

// The slots of this machine's backend, replaced as this plugin's whole. No status: Coda keeps who holds them.
export async function declare(coda, settings) {
  await coda.replace(GROUP, [{ key: 'host', spec: { name: 'host', capacity: settings['host.capacity'], reach: { scope: 'machine' }, attributes: {}, unique: [] } }]);
}

export async function deactivate() { await handler?.dispose(); changes?.dispose(); kinds?.dispose(); handler = changes = kinds = null; }
