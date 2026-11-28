// 插件设置（contributes.configuration 里的 memory.*）与每个项目的检索引擎。
import { join } from 'node:path';
import { MnemonEngine, buildMnemonEnv, resolveMnemonBin } from './mnemon.mjs';
import { projectDir } from './queue.mjs';

const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

// raw 是宿主给的扁平设置（键为 memory.xxx），缺的补默认值。
export function readSettings(raw = {}) {
  const lazy = raw['memory.lazySyncSeconds'];
  return {
    memoryDir: text(raw['memory.memoryDir'], '.memory'),
    autoSync: raw['memory.autoSync'] !== false,
    syncSchedule: text(raw['memory.syncSchedule'], 'R/PT10M'),
    lazySyncSeconds: Number.isFinite(lazy) && lazy >= 0 ? lazy : 60,
    mnemonPath: text(raw['memory.mnemonPath'], ''),
    embeddingProvider: text(raw['memory.embeddingProvider'], 'none'),
    embeddingBaseUrl: text(raw['memory.embeddingBaseUrl'], ''),
    embeddingModel: text(raw['memory.embeddingModel'], ''),
    embeddingApiKeyEnv: text(raw['memory.embeddingApiKeyEnv'], ''),
  };
}

// 每个项目一个引擎：数据目录在项目的状态目录下。找不到 mnemon 时抛 mnemon_missing。
export function createEngine({ stateDir, projectId, settings }) {
  return new MnemonEngine({
    bin: resolveMnemonBin({ mnemonPath: settings.mnemonPath, stateDir }),
    dataDir: join(projectDir(stateDir, projectId), 'mnemon'),
    env: buildMnemonEnv(settings),
  });
}
