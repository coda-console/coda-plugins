import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, arch, versions } from 'node:process';

const exec = promisify(execFile);
const command = async (file, args) => (await exec(file, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 ** 20 })).stdout;
const label = value => String(value).toLowerCase().replace(/[^a-z0-9._-]/g, '-');

// Discovery never boots a simulator. An unavailable probe is unknown, not a made-up capability.
export async function probe({ os = platform, cpu = arch, node = versions.node, run = command } = {}) {
  const capabilities = { os, arch: cpu, nodeVersion: node, graphicalSession: null };
  const labels = new Set([os, cpu, `node-${node.split('.')[0]}`]), failures = [];
  if (os === 'darwin') {
    await Promise.all([
      (async () => {
        try {
          const value = await run('xcodebuild', ['-version']);
          const version = /^Xcode (\S+)/m.exec(value)?.[1], build = /^Build version (\S+)/m.exec(value)?.[1];
          if (!version || !build) throw new Error('Xcode 版本输出无效');
          capabilities.xcode = { version, build }; labels.add(`xcode-${label(version)}`);
        } catch (error) { failures.push(`xcode: ${error.message}`); }
      })(),
      (async () => {
        try {
          const { runtimes } = JSON.parse(await run('xcrun', ['simctl', 'list', 'runtimes', '--json']));
          if (!Array.isArray(runtimes)) throw new Error('runtime 输出无效');
          capabilities.simulatorRuntimes = runtimes.slice(0, 256).map(r => ({ id: r.identifier, version: r.version, available: r.isAvailable === true }));
          for (const r of runtimes) if (r.isAvailable === true) {
            const family = /^(iOS|tvOS|watchOS|visionOS)\b/.exec(r.name)?.[1];
            if (family) labels.add(`${family.toLowerCase()}-${label(r.version)}`);
          }
        } catch (error) { failures.push(`runtimes: ${error.message}`); }
      })(),
      (async () => {
        try {
          const owner = (await run('stat', ['-f', '%u', '/dev/console'])).trim();
          capabilities.graphicalSession = owner === String(process.getuid());
          if (capabilities.graphicalSession) labels.add('gui');
        } catch (error) { failures.push(`graphicalSession: ${error.message}`); }
      })(),
    ]);
  }
  return { capabilities, detectedLabels: [...labels].slice(0, 64).sort(), ...(failures.length ? { reason: { code: 'probe_incomplete', message: failures.join('; ').slice(0, 4096) } } : {}) };
}

export function capacityStatus(spec, group, discovered) {
  const configured = spec.capacity.slots;
  const capacity = Number.isInteger(group?.capacity) ? Math.min(configured, group.capacity) : 0;
  const occupied = Math.max(0, group?.occupied ?? 0);
  const available = group?.exclusive ? 0 : Math.max(0, Math.min(capacity - occupied, group?.available ?? 0));
  return { ...discovered, capacity: { slots: capacity }, occupied: { slots: occupied }, available: { slots: available },
    accepting: spec.enabled && capacity > 0 && !!group,
    executionFeatures: { multiResource: false, multiUnit: false, exclusive: true, noResources: true, namedResources: true, context: true } };
}
