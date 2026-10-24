// The 网络记录 plugin's module as Coda's plugin host loads it (Coda's docs/plugins.md「插件宿主」): activated with its
// state directory and settings, it starts recording; a page opened gets the recorder's status in its collection, a page
// closed is given nothing more, and deactivated it stops.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/network-log/main.mjs';

test('activated it records and opens its page with the recorder\'s status; deactivated it stops', async t => {
  const state = mkdtempSync(join(tmpdir(), 'network-log-module-'));
  t.after(() => { deactivate(); rmSync(state, { recursive: true, force: true }); });
  const views = new Map();
  activate({
    plugin: { id: 'network-log', path: '/plugin', state },
    views: { register: (id, provider) => { views.set(id, provider); return { dispose() {} }; } },
    environment: async () => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'network-log.targets': {}, 'network-log.hangSeconds': 3, 'network-log.mihomo': '' }) }),
  });
  assert.deepEqual([...views.keys()], ['log']);
  const collections = new Map(), closing = [];
  const collection = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    const objects = collections.get(name);
    return { set: (id, object) => objects.set(id, structuredClone(object)), delete: id => objects.delete(id) };
  };
  views.get('log').open({ collection, onClose: fn => closing.push(fn) });
  // Once the recorder has read its settings: mihomo not asked, the table read where the system has one.
  for (let i = 0; i < 50 && collections.get('status')?.get('recorder')?.mihomo !== 'off'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const status = collections.get('status').get('recorder');
  assert.equal(status.mihomo, 'off');
  assert.equal(status.supported, true);
  assert.deepEqual([...collections.keys()].sort(), ['hangs', 'status', 'targets']);
  for (const fn of closing) fn();
  deactivate();
});
