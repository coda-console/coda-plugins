// host 6.0.0 and testbed 4.0.0 reached one at a time, from the versions before them, as the backend judges a catalog (API Level 6:
// one plugin installed at a time, the whole installed catalog checked each time): the compatibility of Coda's own, mirrored in check/coda.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compatibility, checkCatalog } from '../../../check/coda/components/plugins/plugin-extensions.mjs';
import { HOST_PROTOCOLS } from '../../../check/coda/application/host-protocols.mjs';
import { readPlugin } from '../../../check/coda/components/plugins/plugin-rules.mjs';
import { pluginDir } from '../plugin.mjs';

const here = { level: 6, channel: 'preview', defined: kind => HOST_PROTOCOLS.find(one => (one.kind ?? one.name) === kind) ?? null };
const base = { engines: { coda: 6 }, coda: { channels: ['preview'] } };
const protocolImplementations = ['coda/group@1', 'coda/resource@1'];

// A version of the two before this one, as their manifests said (host 5.1.0, testbed 3.1.0).
function earlier(t, id, manifest) {
  const dir = mkdtempSync(join(tmpdir(), `upgrade-${id}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@coda-console/${id}`, id, ...base, ...manifest }));
  return withoutOffers(readPlugin(dir, null));
}
// The mirror in check/coda knows fewer keys of `contributes` than Coda does, and reads the rest as offers to others' points (checkCatalog
// offerProblem): this is about protocols and points, so none are offered.
const withoutOffers = ({ offers, ...plugin }) => plugin;
const current = id => withoutOffers(readPlugin(pluginDir(id), null));

// What the backend does installing `next` over what is installed: the catalog with it in, checked whole; the problem, or null.
function install(installed, next) {
  const catalog = new Map(installed).set(next.id, next);
  try { checkCatalog(catalog); } catch (error) { return error.message; }
  for (const plugin of catalog.values()) {
    const found = compatibility(plugin, { ...here, catalog });
    if (found) return `${plugin.id}：${found.error}`;
  }
  return null;
}

test('host and testbed upgrade one at a time from the versions before: host first passes, testbed first is refused until host is up', t => {
  const oldHost = earlier(t, 'host', { version: '5.1.0', contributes: { protocolImplementations, extensionPoints: { kinds: { description: 'host-sim 的其他 --kind' } } } });
  const oldTestbed = earlier(t, 'testbed', { version: '3.1.0', extensionDependencies: ['host'],
    contributes: { protocolImplementations, extensions: { 'host/kinds': { command: 'testbed-sim' } } } });
  const [host, testbed] = [current('host'), current('testbed')];
  const installed = new Map([[oldHost.id, oldHost], [oldTestbed.id, oldTestbed]]);
  assert.equal(install(new Map(), oldHost), null);
  assert.equal(install(new Map([[oldHost.id, oldHost]]), oldTestbed), null);

  // The old testbed still plugged into `kinds`: host 6.0.0 keeps the point, so it passes.
  assert.equal(install(installed, host), null);
  // The new testbed with the old host, which has no host/kind@1: refused, until host is up.
  assert.match(install(installed, testbed), /host\/kind@1 不在这台机器上/);
  assert.equal(install(new Map([[host.id, host], [oldTestbed.id, oldTestbed]]), testbed), null);
  // Both new ones, in the order they may come.
  assert.equal(install(new Map([[host.id, host]]), testbed), null);
});

test('without the transitional point, host 6.0.0 would be refused while the old testbed is installed', t => {
  const oldTestbed = earlier(t, 'testbed', { version: '3.1.0', extensionDependencies: ['host'],
    contributes: { protocolImplementations, extensions: { 'host/kinds': { command: 'testbed-sim' } } } });
  const host = current('host');
  assert.deepEqual(Object.keys(host.extensionPoints), ['kinds']);
  assert.deepEqual(host.protocols.map(one => one.name), ['host/kind@1']);
  assert.match(install(new Map([[oldTestbed.id, oldTestbed]]), { ...host, extensionPoints: {} }), /不是 host 声明的扩展点/);
});
