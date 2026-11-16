// 瞬时故障的原地重试（coda:retry）：只加在重跑安全的、做幂等网络操作的脚本步骤上。静态读三个流程的 BPMN。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';

// 声明了 coda:retry 的脚本步骤，重跑都安全：
// lane-pr 的 gate 同一个提交强推同一个分支、PR 先从 GitHub 找；land、develop 的 merge 先认 PR 终态，已合并直接交出原合并提交；abandon 关已关的 PR 不改结果；
// stack-status 只读 gh；restack 推送前记下这次推送、推成功才记下结果（远端已是记下的新 head 就直接收尾，否则在新工作区从头变基、推送；改 PR 时失败，重跑不再推送，只改 PR），改 base 与转正幂等；
// develop 的 lane 远端已有同名泳道就沿用、pr 已开着的 PR 只更新正文、github-checks 只读；deliver 的 confirm-result 只读 gh，全部成功后才记下成员。
const RETRIED = { 'lane-pr': ['gate', 'land', 'abandon', 'stack-status', 'restack'], develop: ['lane', 'pr', 'github-checks', 'merge'], deliver: ['confirm-result'] };
// 会开执行会话、或强推后重跑会撞租约（integrate 的 --force-with-lease 在推送成功但响应丢了时，重跑必然被拒）的步骤：不加。
const NOT_RETRIED = { 'lane-pr': ['execute', 'swap', 'revise', 'restack-revise'], deliver: ['integrate'] };

async function scriptTasks(name) {
  const { root, problem } = await readWorkflow(readFileSync(new URL(`../../../plugins/composer/.coda/workflows/${name}.bpmn`, import.meta.url), 'utf8'), name);
  assert.ok(!problem, problem);
  const collect = elements => elements.flatMap(e => e.$type === 'bpmn:ScriptTask' ? [e] : e.flowElements ? collect(e.flowElements) : []);
  return Object.fromEntries(collect(root.rootElements.find(e => e.$type === 'bpmn:Process').flowElements).map(e => [e.id, e]));
}

test('coda:retry 只加在幂等的网络步骤上，值是 3；开执行会话和非幂等的步骤不加', async () => {
  for (const name of Object.keys(RETRIED)) {
    const tasks = await scriptTasks(name);
    assert.deepEqual(Object.keys(tasks).filter(id => tasks[id].retry !== undefined).sort(), RETRIED[name].toSorted(), name);
    for (const id of RETRIED[name]) assert.equal(tasks[id].retry, '3', `${name}/${id}`);
    for (const id of NOT_RETRIED[name] ?? []) assert.ok(tasks[id], `${name}/${id} 存在`), assert.equal(tasks[id].retry, undefined, `${name}/${id}`);
  }
});
