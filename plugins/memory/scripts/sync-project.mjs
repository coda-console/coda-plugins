// 流程步骤：把一个项目主分支的卡片同步进检索索引（项目级定时同步、合并后同步共用）。
// 输入来自环境变量：MEMORY_PROJECT_ID（list-projects 的 here）、MEMORY_PROJECTS_JSON（list-projects 的 projects）、
// CODA_PLUGIN_STATE、CODA_PLUGIN_SETTINGS；MEMORY_* 里非空的设置覆盖 CODA_PLUGIN_SETTINGS。参数 --no-fetch 不拉远端。
// 没有这个项目、不是 Git 仓库、没启用过记忆（没有卡片也没建过索引）都只打印一行跳过的说明，退出码 0。
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, readSettings } from '../lib/settings.mjs';
import { syncProject } from '../lib/sync.mjs';

const ENV_SETTINGS = {
  MEMORY_DIR: 'memory.memoryDir',
  MEMORY_MNEMON_PATH: 'memory.mnemonPath',
  MEMORY_EMBEDDING_PROVIDER: 'memory.embeddingProvider',
  MEMORY_EMBEDDING_BASE_URL: 'memory.embeddingBaseUrl',
  MEMORY_EMBEDDING_MODEL: 'memory.embeddingModel',
  MEMORY_EMBEDDING_API_KEY_ENV: 'memory.embeddingApiKeyEnv',
};

// 返回 { line }：流程卡片上的一行摘要；deps 只为测试里换掉同步与引擎。
export async function runSyncScript(env, { argv = [], sync = syncProject, makeEngine = createEngine } = {}) {
  const projectId = env.MEMORY_PROJECT_ID, stateDir = env.CODA_PLUGIN_STATE;
  if (!stateDir) throw new Error('缺少 CODA_PLUGIN_STATE');
  const project = JSON.parse(env.MEMORY_PROJECTS_JSON || '[]').find(item => item.id === projectId);
  if (!project?.path) return { line: `跳过：本机没有这个项目（${projectId || '未指定'}）` };
  const repoDir = project.path;
  if (!existsSync(join(repoDir, '.git'))) return { line: `跳过：${project.name ?? repoDir} 不是 Git 仓库` };

  const raw = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
  for (const [name, key] of Object.entries(ENV_SETTINGS)) if (env[name]) raw[key] = env[name];
  const settings = readSettings(raw);
  // 拉远端、判断有没有记忆卡片、同步在同一把项目锁里完成：别的机器刚推上来的第一批卡片拉到了才看得见。
  const result = await sync({
    projectId, repoDir, stateDir, memoryDir: settings.memoryDir, engine: () => makeEngine({ stateDir, projectId, settings }),
    fetchRemote: !argv.includes('--no-fetch'), skipIfNoCards: true,
  });
  if (result.action === 'skipped') return { line: `跳过：${project.name ?? repoDir} 没有研究记忆卡片` };
  const parts = [`同步研究记忆：${result.action}`];
  if (result.indexed !== undefined) parts.push(`已索引 ${result.indexed} 张`);
  if (result.fetchError) parts.push('没拉到远端');
  return { line: parts.join('，'), result };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runSyncScript(process.env, { argv: process.argv.slice(2) }).then(({ line }) => {
    console.log(line);
    const output = process.env.GITHUB_OUTPUT || process.env.CODA_OUTPUT;
    if (output) appendFileSync(output, `line=${line}\n`);
  }, error => { console.error(error.message); process.exit(1); });
}
