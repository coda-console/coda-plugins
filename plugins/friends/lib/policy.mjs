// 网关的本机策略：哪些 kind 暂停外发。存在插件状态目录的 policy.json（卸载后保留）；缺失或损坏时当 `{ pausedKinds: [] }`。
import { readJson, writeJson } from './json-file.mjs';
import { checkKind, validKind } from './outbox.mjs';

const NAME = 'policy.json';

/** 读出 `{ pausedKinds }`：只留合法且非保留的 kind，去重排序。 */
export async function readPolicy(dir) {
  const parsed = await readJson(dir, NAME);
  const kinds = Array.isArray(parsed?.pausedKinds) ? parsed.pausedKinds.filter(validKind) : [];
  return { pausedKinds: [...new Set(kinds)].sort() };
}

/** 暂停或恢复一个 kind 的外发；kind 不合法或是保留类型就抛错。`beforeWrite` 在写第一个字节前调用（它抛错就不写）。返回现在的策略。 */
export async function setKindPaused(dir, kind, paused, beforeWrite) {
  checkKind(kind);
  const { pausedKinds } = await readPolicy(dir), next = new Set(pausedKinds);
  if (paused) next.add(kind); else next.delete(kind);
  const policy = { pausedKinds: [...next].sort() };
  await writeJson(dir, NAME, policy, beforeWrite);
  return policy;
}
