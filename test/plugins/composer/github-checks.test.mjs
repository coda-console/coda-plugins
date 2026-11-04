import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForGitHubChecks } from '../../../plugins/composer/scripts/github-checks.mjs';

for (const [name, snapshots, exit, waits] of [
  ['先空，随后出现并失败', [[], [], [{}]], 1, 2],
  ['没有 CI', Array(13).fill([]), 0, 12],
  ['检查通过', [[{}]], 0, 0],
]) test(name, async () => {
  let reads = 0, slept = 0, watched = 0;
  const result = await waitForGitHubChecks('pr', 'head', {
    query: (...args) => {
      assert.deepEqual(args, ['pr', 'view', 'pr', '--json', 'headRefOid,statusCheckRollup']);
      return JSON.stringify({ headRefOid: 'head', statusCheckRollup: snapshots[Math.min(reads++, snapshots.length - 1)] });
    },
    sleep: async ms => { assert.equal(ms, 10_000); slept++; },
    watch: () => { watched++; return exit; },
  });
  assert.equal(result, exit);
  assert.equal(slept, waits);
  assert.equal(watched, name === '没有 CI' ? 0 : 1);
});

for (const changedAt of [0, 1]) test(`head 在${changedAt ? '等待结束后' : '登记前'}变化时失败`, async () => {
  let reads = 0, watched = 0;
  await assert.rejects(waitForGitHubChecks('pr', 'head', {
    query: () => JSON.stringify({ headRefOid: reads++ === changedAt ? 'other' : 'head', statusCheckRollup: [{}] }),
    watch: () => { watched++; return 0; },
  }), /PR head 不一致/);
  assert.equal(watched, changedAt);
});
