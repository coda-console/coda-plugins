// 研究记忆：在本机登记一条 memory/engine@1 记录，处理六个工具；工具只允许本机的会话调用，按会话的工作区定位研究仓。
// 主分支合并（pull_request.closed）后立即同步这个项目的索引。
import { hostname } from 'node:os';
import * as service from './lib/service.mjs';
import { createEngine, readSettings } from './lib/settings.mjs';
import { resolveMnemonBin } from './lib/mnemon.mjs';
import { syncProject } from './lib/sync.mjs';

const ENGINE = 'memory/engine@1', MACHINE = 'coda/machine@1', THREAD = 'coda/thread@1', KEY = 'local';
const OPERATIONS = ['recall', 'search', 'get', 'remember', 'link', 'archive'];
// 只有读取要同步索引、要 mnemon；写操作只改工作树里的卡片。
const READS = new Set(['recall', 'search', 'get']);
const RETRY_FIRST = 5_000, RETRY_MAX = 300_000;

const report = what => error => console.error(`研究记忆：${what}：${error?.message ?? error}`);
let disposables = [];

// `schedule`、`cancel` 只为测试里不真等：重试的计时器可以换掉。
export async function activate(coda, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  const stateDir = coda.plugin.state, knownProjects = new Map();
  let settings = readSettings(), machineId = null, machineName = null;
  let started = false, stopped = false, pending = false, inFlight = false, timer = null, delay = RETRY_FIRST, notified = false;
  disposables.push({ dispose() { stopped = true; cancel(timer); timer = null; } });

  const mnemonReady = () => {
    try { resolveMnemonBin({ mnemonPath: settings.mnemonPath, stateDir }); return true; } catch { return false; }
  };
  // 只有一个待发布状态：发布时读的是当时最新的设置、机器名和项目数；失败按退避重试。
  const flush = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      while (pending && !stopped) {
        pending = false;
        const ready = mnemonReady();
        try {
          await coda.replace(ENGINE, [{ key: KEY, spec: { name: machineName || hostname(), status: ready ? '就绪' : '缺少 mnemon', projects: knownProjects.size }, status: { ready } }]);
          delay = RETRY_FIRST;
        } catch (error) {
          pending = true;
          report('登记记录失败')(error);
          if (!stopped && !timer) {
            timer = schedule(() => { timer = null; flush(); }, delay);
            delay = Math.min(delay * 2, RETRY_MAX);
          }
          return;
        }
      }
    } finally { inFlight = false; }
  };
  const publishLater = () => { pending = true; if (started && !timer) flush(); };

  const requireLocal = async ctx => {
    const caller = ctx?.caller?.machine;
    if (!caller) return;
    let id = machineId;
    if (!id) {
      try { id = (await coda.list(MACHINE, { scope: 'local' })).find(entry => entry?.local)?.id; } catch {}
    }
    if (id !== caller) throw coda.error('forbidden', '记忆引擎只允许本机的会话调用', { effects: 'none' });
  };
  const workspaceOf = async ctx => {
    const parent = ctx?.caller?.parent;
    if (parent?.kind !== THREAD || !parent.id) throw coda.error('no_session', '记忆工具只能在会话里调用：要靠会话的工作区找到研究仓', { effects: 'none' });
    const { path, project, state } = await coda.query(parent, 'workspace');
    if (state !== 'ready' || !path || !project?.id) throw coda.error('workspace_unavailable', `会话的工作区还没就绪（${state ?? '未知'}）`, { effects: 'none' });
    return { path, projectId: project.id };
  };
  const handle = operation => async (input, ctx) => {
    await requireLocal(ctx);
    const { path, projectId } = await workspaceOf(ctx);
    if (knownProjects.get(projectId) !== path) {
      const added = !knownProjects.has(projectId);
      knownProjects.set(projectId, path);
      if (added) publishLater();
    }
    try {
      return await service[operation]({ projectId, repoDir: path, stateDir, settings, ...(READS.has(operation) && { engine: createEngine({ stateDir, projectId, settings }) }) }, input);
    } catch (error) {
      throw /^[a-z_]+$/.test(error?.code ?? '') && !error.effects ? coda.error(error.code, error.message) : error;
    }
  };
  for (const operation of OPERATIONS) disposables.push(coda.handle(ENGINE, operation, handle(operation)));

  // 缺 GitHub 插件时订阅被拒，静默降级：只剩读取时的惰性同步和定时同步。
  try {
    disposables.push(coda.on('pull_request.closed', event => {
      const path = knownProjects.get(event?.project);
      if (event?.data?.pull_request?.merged !== true || !path) return;
      (async () => syncProject({
        projectId: event.project, repoDir: path, stateDir, memoryDir: settings.memoryDir,
        engine: createEngine({ stateDir, projectId: event.project, settings }), fetchRemote: true,
      }))().catch(report('合并后同步失败'));
    }));
  } catch {}

  disposables.push(coda.settings.onChange(next => { notified = true; settings = readSettings(next); publishLater(); }));
  const snapshot = await coda.settings.get();
  if (!notified) settings = readSettings(snapshot);
  try {
    disposables.push(await coda.watch(MACHINE, ({ type, entry }) => {
      machineId = type === 'DELETED' ? null : entry?.id ?? null;
      machineName = type === 'DELETED' ? null : entry?.spec?.name ?? null;
      publishLater();
    }, { scope: 'local' }));
  } catch (error) { report('读不到本机的机器名，用主机名')(error); }
  started = true;
  pending = true;
  await flush();
}

export function deactivate() {
  for (const disposable of disposables.splice(0)) disposable.dispose();
}
