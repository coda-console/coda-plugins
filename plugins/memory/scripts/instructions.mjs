// 会话开场指令（contributes.instructions）：读 CODA_PLUGIN_SETTINGS 里的 memory.* 设置，打印一段说明给 Agent。
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeMemoryDir } from '../lib/repo-cards.mjs';
import { readSettings } from '../lib/settings.mjs';

export function formatInstructions(settings = readSettings()) {
  let dir;
  try { dir = normalizeMemoryDir(settings.memoryDir); } catch (error) {
    return `研究记忆的记忆目录设置有误（${error.message}），记忆工具会拒绝；请用户在插件设置里改成仓库内的相对目录，改好前不要使用 memory_engine_* 工具。`;
  }
  const sync = settings.autoSync
    ? '定时同步与读取时的惰性同步已开启'
    : '定时同步与读取时的惰性同步已关闭（已有索引不再拉取，缺索引时仍会本地初始化一次）';
  return [
    `当前目录已启用研究记忆：规范卡片在 ${dir}/items/，随仓库提交；${sync}，合并后同步由合并卡的挂点控制。`,
    '调用 memory_engine_* 工具时省略 target，即作用于当前项目。',
    '研究或回答前先 recall / search；沉淀前先 recall 查冲突，remember 必带 refs（出处）。',
    '详见 Skill research-memory。',
  ].join('\n');
}

export const settingsFromEnv = raw => {
  try { return readSettings(JSON.parse(raw || '{}') ?? {}); } catch { return readSettings(); }
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  console.log(formatInstructions(settingsFromEnv(process.env.CODA_PLUGIN_SETTINGS)));
}
