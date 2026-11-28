// 会话开场指令（contributes.instructions）：读 CODA_PLUGIN_SETTINGS 里的目录级设置（memory.enabled、memory.autoSync）与
// <CODA_PLUGIN_STATE>/machine-settings.json 里的机器层设置（记忆目录），打印一段说明给 Agent；没启用研究记忆就什么都不打印。
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeMemoryDir } from '../lib/repo-cards.mjs';
import { readMachineSettings, readSettings } from '../lib/settings.mjs';

// settings 是目录层（带机器层的记忆目录）；lazySync 是本机插件层的 autoSync，管会话读前的惰性同步。
export function formatInstructions(settings = readSettings(), { lazySync = false } = {}) {
  if (!settings.enabled) return '';
  let dir;
  try { dir = normalizeMemoryDir(settings.memoryDir); } catch (error) {
    return `研究记忆的记忆目录设置有误（${error.message}），记忆工具会拒绝；请用户在插件设置里改成仓库内的相对目录，改好前不要使用 memory_engine_* 工具。`;
  }
  const sync = `定时同步（目录设置 memory.autoSync）已${settings.autoSync ? '开启' : '关闭'}，读取前的惰性同步（本机插件设置 memory.autoSync）已${lazySync ? '开启' : '关闭（已有索引不再拉取，缺索引或记忆目录、向量配置变了时仍本地重建一次）'}`;
  return [
    `当前目录已启用研究记忆：规范卡片在 ${dir}/items/，随仓库提交；${sync}，合并后同步由合并卡的挂点控制。`,
    '调用 memory_engine_* 工具时省略 target，即作用于当前项目。',
    '研究或回答前先 recall / search；沉淀前先 recall 查冲突，remember 必带 refs（出处）。',
    '详见 Skill research-memory。',
  ].join('\n');
}

// 目录层设置叠上机器层的记忆目录、向量配置；autoSync 保持目录层的值。
export const settingsFromEnv = (raw, stateDir) => {
  let directory = {};
  try { directory = JSON.parse(raw || '{}') ?? {}; } catch {}
  const { 'memory.autoSync': _lazySync, ...machine } = readMachineSettings(stateDir);
  return readSettings({ ...directory, ...machine });
};

// 本机插件层的 memory.autoSync：会话读前的惰性同步跟它走。
export const lazySyncFromState = stateDir => readSettings(readMachineSettings(stateDir)).autoSync;

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const stateDir = process.env.CODA_PLUGIN_STATE;
  const text = formatInstructions(settingsFromEnv(process.env.CODA_PLUGIN_SETTINGS, stateDir), { lazySync: lazySyncFromState(stateDir) });
  if (text) console.log(text);
}
