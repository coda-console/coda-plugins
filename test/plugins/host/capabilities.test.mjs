import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probe, capacityStatus } from '../../../plugins/host/lib/capabilities.mjs';

test('read-only capability probes distinguish missing Xcode and unavailable runtimes; capacity includes other ledger users', async () => {
  const calls = [];
  const discovered = await probe({ os: 'darwin', cpu: 'arm64', node: '26.8.2', run: async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'xcodebuild') throw new Error('not installed');
    if (file === 'stat') return `${process.getuid()}\n`;
    return JSON.stringify({ runtimes: [{ identifier: 'r1', name: 'iOS 26.1', version: '26.1', isAvailable: true },
      { identifier: 'r2', name: 'iOS 25.0', version: '25.0', isAvailable: false }] });
  } });
  assert.deepEqual(discovered.detectedLabels, ['arm64', 'darwin', 'gui', 'ios-26.1', 'node-26']);
  assert.equal(discovered.capabilities.xcode, undefined); assert.equal(discovered.reason.code, 'probe_incomplete');
  assert.equal(calls.some(call => call.includes('boot')), false);
  const value = capacityStatus({ capacity: { slots: 1 } }, { capacity: 3, occupied: 2, available: 1 }, discovered);
  assert.deepEqual([value.capacity, value.occupied, value.available], [{ slots: 1 }, { slots: 2 }, { slots: 0 }]);
  assert.equal(capacityStatus({ capacity: { slots: 2 } }, null, discovered).accepting, false);
});
