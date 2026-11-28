// 插件设置（contributes.configuration 里的 memory.*）与每个项目的检索引擎。
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MnemonEngine, buildMnemonEnv, resolveMnemonBin } from './mnemon.mjs';
import { projectDir } from './queue.mjs';

const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

// raw 是宿主给的扁平设置（键为 memory.xxx），缺的补默认值。
export function readSettings(raw = {}) {
  const lazy = raw['memory.lazySyncSeconds'];
  return {
    enabled: raw['memory.enabled'] === true,
    memoryDir: text(raw['memory.memoryDir'], '.memory'),
    autoSync: raw['memory.autoSync'] === true,
    syncSchedule: text(raw['memory.syncSchedule'], 'R/PT10M'),
    lazySyncSeconds: Number.isFinite(lazy) && lazy >= 0 ? lazy : 60,
    mnemonPath: text(raw['memory.mnemonPath'], ''),
    embeddingProvider: text(raw['memory.embeddingProvider'], 'none'),
    embeddingBaseUrl: text(raw['memory.embeddingBaseUrl'], ''),
    embeddingModel: text(raw['memory.embeddingModel'], ''),
    embeddingApiKeyEnv: text(raw['memory.embeddingApiKeyEnv'], ''),
  };
}

// 机器层设置（不含密钥）落在 <stateDir>/machine-settings.json：会话工具、合并事件、定时流程与开场说明读同一份，
// 不会因为某个目录覆盖了这些设置而各写各的卡片目录、各用各的向量配置。
// 其中 autoSync 是本机插件层的值（会话读前惰性同步用它）；目录层的 autoSync 只管定时同步，调用方不要用它覆盖目录层。
const MACHINE_KEYS = ['memoryDir', 'autoSync', 'lazySyncSeconds', 'mnemonPath', 'embeddingProvider', 'embeddingBaseUrl', 'embeddingModel', 'embeddingApiKeyEnv'];
const MACHINE_FILE = 'machine-settings.json';

export async function writeMachineSettings(stateDir, settings) {
  const file = join(stateDir, MACHINE_FILE), temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await mkdir(stateDir, { recursive: true });
  try {
    await writeFile(temp, JSON.stringify(Object.fromEntries(MACHINE_KEYS.map(key => [key, settings[key]]))), 'utf8');
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// 返回扁平的 memory.xxx 设置，可直接叠在目录级设置上；文件不存在或损坏时返回空对象。
export function readMachineSettings(stateDir) {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, MACHINE_FILE), 'utf8'));
    return Object.fromEntries(MACHINE_KEYS.filter(key => saved?.[key] !== undefined).map(key => [`memory.${key}`, saved[key]]));
  } catch { return {}; }
}

// 每个项目一个引擎：数据目录在项目的状态目录下。找不到 mnemon 时抛 mnemon_missing。
export function createEngine({ stateDir, projectId, settings, env = process.env }) {
  return new MnemonEngine({
    bin: resolveMnemonBin({ mnemonPath: settings.mnemonPath, stateDir, env }),
    dataDir: join(projectDir(stateDir, projectId), 'mnemon'),
    env: buildMnemonEnv(settings, env),
    embedding: settings,
  });
}
