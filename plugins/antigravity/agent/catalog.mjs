// The catalog of Antigravity's models, modes and options that answers Coda's configuration probes (the protocol's
// 「配置探测」) without a native session: agy 1.5.9 cannot delete one, and each probe used to leave an empty conversation.
// It is kept in the plugin's state directory, `catalog-v1.json`, and collected when there is none or it is out of date:
// one `agy acp` of its own, initialize, session/new in a neutral directory of the state's, then each base model through
// set_config_option, and the process closed. No prompt, no delete, nothing global set. That collection does leave one
// empty conversation; its ID goes to the log, `catalog-v1.log`.
//
// Out of date: a day old, another format, another agy (path or version), another stat of ~/.gemini/antigravity-cli/settings.json,
// or marked by a real session whose options did not match. Entries collect one at a time (a lock file in the state directory,
// waited on for a while, the catalog read again once it is free); a collection that fails is not tried again for five
// minutes for the same agy and settings, and leaves the catalog there was.
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { versionOf } from '../scripts/agy.mjs';

export const FORMAT = 1;
// `collect` stays inside the 60 seconds Coda gives a probe; `wait` is how long an entry waits for another's collection.
export const LIMITS = { ttl: 24 * 3600_000, collect: 40_000, wait: 45_000, cooldown: 5 * 60_000, poll: 200, version: 10_000 };
const SIGNED_OUT = -32000;

export class CatalogError extends Error {
  constructor(message, code = -32603) { super(message); this.code = code; }
}

// The values of a select option, its groups flattened.
export const values = option => (Array.isArray(option?.options) ? option.options : [])
  .flatMap(choice => Array.isArray(choice?.options) ? choice.options : [choice]).map(choice => choice?.value);
// What a list of options offers, without what is chosen: compared with the catalog's for the same model.
const shape = configOptions => JSON.stringify(configOptions.map(option => [option?.id, option?.category, option?.type, values(option)]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function askVersion(binary, timeout) {
  return new Promise(resolve => execFile(binary, ['--version'], { encoding: 'utf8', timeout, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } },
    (error, stdout, stderr) => resolve(error ? null : versionOf({ stdout, stderr }))));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// `state`: the plugin's state directory; `binary`: agy's path. The clock, the file system (node:fs/promises), the process
// (node:child_process spawn) and how agy's version is asked are given for the tests.
export function createCatalog({ state, binary, home = homedir(), now = Date.now, fs = fsPromises, spawn = spawnProcess, version = askVersion,
  limits: given = {} } = {}) {
  const limits = { ...LIMITS, ...given };
  const file = name => join(state, name);
  const paths = state && { catalog: file('catalog-v1.json'), lock: file('catalog-v1.lock'), failure: file('catalog-v1.failure.json'),
    stale: file('catalog-v1.stale.json'), log: file('catalog-v1.log'), cwd: file('catalog-cwd') };
  let child = null, holding = false, aborted = false;

  const readJson = async path => { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return null; } };
  const log = async event => {
    const line = JSON.stringify({ at: new Date(now()).toISOString(), ...event });
    process.stderr.write(`antigravity catalog: ${line}\n`);
    try { await fs.appendFile(paths.log, `${line}\n`); } catch {}
  };
  // What a catalog is valid for: this agy and these settings.
  async function fingerprint() {
    const settings = await fs.stat(join(home, '.gemini/antigravity-cli/settings.json')).then(
      s => ({ exists: true, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino }), () => ({ exists: false }));
    return { format: FORMAT, agy: { path: binary, version: await version(binary, limits.version) }, settings };
  }
  async function usable(catalog, print) {
    if (!catalog || catalog.format !== print.format || !same(catalog.agy, print.agy) || !same(catalog.settings, print.settings)) return false;
    const age = now() - catalog.collectedAt;
    if (!(age >= 0 && age < limits.ttl)) return false;
    return (await readJson(paths.stale))?.collectedAt !== catalog.collectedAt;
  }
  // The lock, or false while another live entry holds it. One whose holder is gone, or past a collection's time, is taken over.
  async function lock() {
    try {
      const handle = await fs.open(paths.lock, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() })); } finally { await handle.close(); }
      holding = true;
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new CatalogError(`插件状态目录写不进去（${error.code ?? error.message}）：${state}`);
    }
    const holder = await readJson(paths.lock);
    const gone = holder ? !alive(holder.pid) || now() - holder.at > limits.collect + 10_000
      : await fs.stat(paths.lock).then(s => Date.now() - s.mtimeMs > limits.collect + 10_000, () => true);
    if (gone) await fs.rm(paths.lock, { force: true });
    return false;
  }
  const unlock = async () => { if (holding) { holding = false; await fs.rm(paths.lock, { force: true }); } };

  // One collection, through an agy of its own: the catalog, or a CatalogError.
  async function collect(print) {
    await fs.mkdir(paths.cwd, { recursive: true });
    const proc = child = spawn(binary, ['acp'], { cwd: paths.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let next = 0, rest = '', said = '', timer;
    const send = message => { if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
    const ended = new Promise((_, reject) => {
      proc.on('error', error => reject(new CatalogError(`无法运行 Antigravity CLI：${error.code ?? error.message}`)));
      proc.on('close', code => reject(new CatalogError(`agy acp 提前退出了（${code ?? '信号'}）${said.trim() ? `：${said.trim().split('\n').at(-1)}` : ''}`)));
      timer = setTimeout(() => reject(new CatalogError(`读取模型目录超过 ${limits.collect / 1000} 秒`)), limits.collect);
    });
    ended.catch(() => {});
    proc.stdin.on('error', () => {});
    proc.stderr.setEncoding('utf8').on('data', text => { said = (said + text).slice(-2000); });
    proc.stdout.setEncoding('utf8').on('data', text => {
      const lines = (rest + text).split('\n'); rest = lines.pop();
      for (const line of lines) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!m || typeof m !== 'object') continue;
        if ('id' in m && !m.method) { pending.get(m.id)?.(m); pending.delete(m.id); }
        else if ('id' in m) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
    });
    const call = (method, params) => Promise.race([ended, new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, m => m.error ? reject(new CatalogError(`${method}：${m.error.message}`, m.error.code === SIGNED_OUT ? SIGNED_OUT : undefined)) : resolve(m.result));
      send({ id, method, params });
    })]);
    try {
      await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const opened = await call('session/new', { cwd: paths.cwd, mcpServers: [] });
      await log({ event: 'collect.session', sessionId: opened?.sessionId });
      const { sessionId, models, modes, configOptions } = opened ?? {};
      const model = Array.isArray(configOptions) ? configOptions.find(option => option?.category === 'model' && option.type === 'select') : null;
      if (!model) throw new CatalogError('agy 的 session/new 没给 category 为 model 的配置项');
      const byModel = {};
      for (const value of values(model)) {
        const answer = await call('session/set_config_option', { sessionId, configId: model.id, value });
        const chosen = Array.isArray(answer?.configOptions) ? answer.configOptions.find(option => option?.id === model.id) : null;
        if (chosen?.currentValue !== value) throw new CatalogError(`切到模型 ${value} 后 agy 给的配置不是这个模型的`);
        byModel[value] = answer.configOptions;
      }
      if (!Object.keys(byModel).length) throw new CatalogError('agy 没给任何模型');
      return { format: FORMAT, collectedAt: now(), agy: print.agy, settings: print.settings, initial: { models, modes, configOptions }, byModel };
    } finally {
      clearTimeout(timer);
      child = null;
      proc.stdin.end(); proc.kill();
      setTimeout(() => proc.kill('SIGKILL'), 800).unref();
    }
  }
  // Collects and writes the catalog, all of it or nothing; a failure is remembered.
  async function refresh(print) {
    const started = now();
    try {
      const catalog = await collect(print);
      const temporary = `${paths.catalog}.${process.pid}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(catalog)); await fs.rename(temporary, paths.catalog); }
      catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw new CatalogError(`写不了模型目录（${error.code ?? error.message}）：${state}`); }
      await fs.rm(paths.failure, { force: true });
      await log({ event: 'collect.done', models: Object.keys(catalog.byModel).length, ms: now() - started });
      return catalog;
    } catch (error) {
      const reason = error.message;
      await log({ event: 'collect.failed', reason, ms: now() - started });
      // Signed out is not remembered: signing in changes nothing a catalog is checked against; nor is a collection the
      // entry stopped as it went.
      if (error.code !== SIGNED_OUT && !aborted) await fs.writeFile(paths.failure, JSON.stringify({ at: now(), reason, fingerprint: print })).catch(() => {});
      throw error instanceof CatalogError ? error : new CatalogError(reason);
    }
  }

  return {
    // The catalog, up to date: read, or collected. A CatalogError says why there is none.
    async get() {
      if (!state) throw new CatalogError('没有插件状态目录（CODA_PLUGIN_STATE），存不了模型目录');
      const print = await fingerprint(), deadline = now() + limits.wait;
      for (;;) {
        const cached = await readJson(paths.catalog);
        if (await usable(cached, print)) return cached;
        const failure = await readJson(paths.failure);
        if (failure && same(failure.fingerprint, print) && now() - failure.at < limits.cooldown)
          throw new CatalogError(`读取 Antigravity 的模型目录失败，${Math.ceil((failure.at + limits.cooldown - now()) / 1000)} 秒后再试：${failure.reason}`);
        if (await lock()) {
          try {
            // Another entry may have finished between the reading and the lock.
            const again = await readJson(paths.catalog);
            return await usable(again, print) ? again : await refresh(print);
          } finally { await unlock(); }
        }
        if (now() >= deadline) throw new CatalogError(`等另一个进程读取模型目录超过 ${limits.wait / 1000} 秒`);
        await delay(limits.poll);
      }
    },
    // What a real session offers (its configOptions, and modes when it says them), held to the catalog's for its current model:
    // one that differs marks the catalog to be collected again. Nothing else is learnt from it.
    observe({ configOptions, modes } = {}) {
      if (!state || !Array.isArray(configOptions)) return;
      const model = configOptions.find(option => option?.category === 'model'), seen = shape(configOptions);
      const modeIds = Array.isArray(modes?.availableModes) ? modes.availableModes.map(mode => mode?.id) : null;
      if (!model) return;
      void (async () => {
        const catalog = await readJson(paths.catalog);
        if (!catalog?.byModel) return;
        const known = catalog.byModel[model.currentValue];
        const reason = !known ? `目录里没有模型 ${model.currentValue}` : shape(known) !== seen ? `模型 ${model.currentValue} 的配置项与目录不同`
          : modeIds && !same(modeIds, catalog.initial?.modes?.availableModes?.map(mode => mode?.id)) ? '模式与目录不同' : null;
        if (!reason || (await readJson(paths.stale))?.collectedAt === catalog.collectedAt) return;
        await fs.writeFile(paths.stale, JSON.stringify({ collectedAt: catalog.collectedAt, at: now(), reason }));
        await log({ event: 'stale', reason });
      })().catch(() => {});
    },
    // The entry is going: its collection, if any, and its lock go with it.
    abort() {
      aborted = true;
      child?.kill('SIGKILL');
      if (holding) { holding = false; rmSync(paths.lock, { force: true }); }
    },
  };
}
