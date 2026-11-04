import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { gh } from './shared.mjs';

export async function waitForGitHubChecks(pr, head, { query = gh, sleep = setTimeout, watch = () => {
  const result = spawnSync('gh', ['pr', 'checks', pr, '--watch'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
} } = {}) {
  const read = () => {
    const snapshot = JSON.parse(query('pr', 'view', pr, '--json', 'headRefOid,statusCheckRollup'));
    if (snapshot.headRefOid !== head) throw new Error(`PR head 不一致：预期 ${head}，实际 ${snapshot.headRefOid}`);
    return snapshot.statusCheckRollup;
  };
  // 空 rollup 可能只是尚未登记；给 Actions 和外部 CI 同样的登记窗口。
  for (let elapsed = 0; ; elapsed += 10) {
    if (read().length) {
      const status = watch();
      read();
      return status;
    }
    if (elapsed === 120) {
      console.log(`提交 ${head} 连续 120 秒无 GitHub 检查，按无 CI 通过。`);
      return 0;
    }
    console.log(`提交 ${head} 尚无 GitHub 检查，等待登记（${elapsed}/120 秒）。`);
    await sleep(10_000);
  }
}
