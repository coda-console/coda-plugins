// Waits for the pull request's checks on GitHub (../.coda/workflows/pull-request.bpmn「等 GitHub 检查」): what GitHub has on
// its head commit, commit statuses and check runs alike, whoever ran them. The project's own checks (workflows joining hook check)
// have ended by now, and wrote what they found as statuses if they do; others (GitHub Actions) are waited for until each
// has a result. Then it says whether all passed (`passed`) and each check in a line (`lines`, for the reviewer and the
// approval card). Asked every `EVERY` seconds; it gives up when the step times out.
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { output, summary } from './step.mjs';

const url = process.env.URL, every = (Number(process.env.EVERY) || 10) * 1000;
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url ?? '')) { console.error(`不是 GitHub 上的 PR：${url}`); process.exit(1); }

// The checks as GitHub has them now; null when GitHub could not be asked. gh exits 8 while some are pending and 1 when
// one failed or none is reported, saying so.
function read() {
  const done = spawnSync('gh', ['pr', 'checks', url, '--json', 'name,state,bucket,description,link'], { encoding: 'utf8' });
  try { const list = JSON.parse(done.stdout); if (Array.isArray(list)) return list; } catch {}
  return /no checks reported/i.test(done.stderr ?? '') ? [] : null;
}
let checks, unread = 0;
for (;;) {
  checks = read();
  if (checks === null) {
    if (++unread >= 5) { console.error('读不到 PR 的检查'); process.exit(1); }
  } else {
    unread = 0;
    const pending = checks.filter(c => c.bucket === 'pending');
    if (!pending.length) break;
    console.log(`等检查：${pending.map(c => c.name).join('、')}`);
  }
  await delay(every);
}

const VERDICT = { pass: '通过', fail: '没通过', cancel: '取消了', skipping: '跳过' };
const failed = checks.filter(c => ['fail', 'cancel'].includes(c.bucket));
const line = c => `  - ${c.name}：${VERDICT[c.bucket] ?? c.state}${c.description ? `，${c.description}` : ''}`;
const lines = checks.length ? `\n${checks.map(line).join('\n')}` : '';
output('passed', !failed.length);
output('lines', lines);
summary(`## 检查：${!checks.length ? '没有检查' : failed.length ? `${failed.length} 项没通过` : '都通过了'}${lines}`);
