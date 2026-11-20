// host 6.0.1 and testbed 4.0.0 reached one at a time, from the versions before them, as the backend judges a catalog (API Level 6:
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

test('from the versions before, on this Coda: host 6.0.1 waits for the old testbed to go, the new testbed for host; both new ones pass', t => {
  const oldHost = earlier(t, 'host', { version: '5.1.0', contributes: { protocolImplementations, extensionPoints: { kinds: { description: 'host-sim 的其他 --kind' } } } });
  const oldTestbed = earlier(t, 'testbed', { version: '3.1.0', extensionDependencies: ['host'],
    contributes: { protocolImplementations, extensions: { 'host/kinds': { command: 'testbed-sim' } } } });
  const [host, testbed] = [current('host'), current('testbed')];
  const installed = new Map([[oldHost.id, oldHost], [oldTestbed.id, oldTestbed]]);
  // host 6.0.1 no longer has the point the old testbed plugs into: refused while it is installed (both stay as they were, working).
  assert.match(install(installed, host), /不是 host 声明的扩展点/);
  // The new testbed with the old host, which has no host/kind@1: refused, until host is up.
  assert.match(install(installed, testbed), /host\/kind@1 不在这台机器上/);
  // Both new ones, in the order they may come.
  assert.equal(install(new Map([[host.id, host]]), testbed), null);
  assert.equal(install(new Map([[testbed.id, testbed], [host.id, host]]), host), null);
});

test('from host 6.0.0, which kept the point for the upgrade, with testbed 4.0.0 installed: host 6.0.1 passes', t => {
  const transitional = earlier(t, 'host', { version: '6.0.0', contributes: { protocolImplementations, extensionPoints: { kinds: { description: '过渡' } },
    protocols: current('host').protocols } });
  const testbed = current('testbed');
  assert.equal(install(new Map([[transitional.id, transitional]]), testbed), null);
  const host = current('host');
  assert.equal(host.extensionPoints?.kinds, undefined);
  assert.deepEqual(host.protocols.map(one => one.name), ['host/kind@1']);
  assert.equal(install(new Map([[transitional.id, transitional], [testbed.id, testbed]]), host), null);
});
