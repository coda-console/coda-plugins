// 跨进程锁测试的子进程：拿到项目锁后在日志里记一对 enter/exit，中间睡一会儿。
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { withProjectLock } from '../../../plugins/memory/lib/queue.mjs';

const [stateDir, projectId, log, holdMs] = process.argv.slice(2);
await withProjectLock(stateDir, projectId, async () => {
  appendFileSync(log, `enter ${process.pid}\n`);
  await delay(Number(holdMs));
  appendFileSync(log, `exit ${process.pid}\n`);
});
