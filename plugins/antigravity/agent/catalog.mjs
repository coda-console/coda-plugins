// The catalog of Antigravity's models, modes and options that answers Coda's configuration probes (the protocol's
// 「配置探测」) without a native session: agy 1.5.9 cannot delete one, and each probe used to leave an empty conversation.
// It is kept in the plugin's state directory, `catalog-v1.json`, and collected when there is none or it is out of date:
// one `agy acp` of its own, initialize, session/new in a neutral directory of the state's, then each base model through
// set_config_option, and the process closed. No prompt, no delete, nothing global set. That collection does leave one
// empty conversation; its ID goes to the log, `catalog-v1.log`.
//
// Out of date: another format, another agy (path or version), another stat of ~/.gemini/antigravity-cli/settings.json, or
// marked by a real session whose options did not match. There is no age past which it is collected again: models the
// server adds under the same agy (as Gemini 4 Neon came to 1.5.9) are found by a check instead. Once an hour (`check`) after
// the collection or the last check, the entry that answers a probe asks `agy models`, which opens no conversation and takes
// two or three seconds, and holds its list of models (ID and name, sorted by ID) to the one the collection kept
// (`agyModels`). The same list is written down as checked (`catalog-v1.check.json`, for that collection) and the catalog
// answers; another list has it collected again. A catalog of an older plugin, with no list kept, is collected again once
// `agy models` answers. A check that fails (signed out, no network, a timeout) keeps the catalog and is tried again after
// the cool-down, never collecting for it; a collection a check asked for that fails keeps the catalog there was as well.
// The check is made in the probe, under the lock, before the answer, not after it: an entry may go as soon as its probe is
// answered, and what is learnt then would be lost. It is held to `models` (8 seconds) so that the version, a check and a
// collection stay inside the 60 seconds Coda gives a probe.
//
// Entries collect and check one at a time (a lock in the state directory, waited on for a while, the catalog and the last
// failure read again once it is held); a collection that fails, or answers options that do not hold together, is not tried
// again for five minutes for the same agy and settings, and leaves the catalog there was.
//
// The lock is a line of generations, `catalog-v1.lock.<n>`, each made at once with its holder in it (a hard link); the
// highest is the lock. It is free once its holder marks it `.free`, is gone, or is past a collection's time, and is then
// taken by making the next generation, which only one entry can. No entry removes a lock above its own, so taking over a
// lock left behind cannot remove another's; the holder of a generation clears those below it.
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { versionOf } from '../scripts/agy.mjs';

export const FORMAT = 1;
// `collect` stays inside the 60 seconds Coda gives a probe; `wait` is how long an entry waits for another's collection;
// `check` is how often `agy models` is asked, and `models` how long it is given.
export const LIMITS = { check: 3600_000, models: 8_000, collect: 40_000, wait: 45_000, cooldown: 5 * 60_000, poll: 200, version: 10_000 };
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
// What is wrong with a list of options agy gave, or null: each select's current value is one of its own values.
function optionsProblem(configOptions) {
  if (!Array.isArray(configOptions) || !configOptions.length) return '没有配置项';
  for (const option of configOptions) {
    if (typeof option?.id !== 'string') return '配置项没有 id';
    if (option.type === 'select' && !values(option).includes(option.currentValue)) return `配置项 ${option.id} 的当前值 ${option.currentValue} 不在它的选项里`;
  }
  return null;
}
const LOCK = /^catalog-v1\.lock\.(\d+)(\.free)?$/;
const generation = name => Number(LOCK.exec(name)?.[1] ?? 0);

async function askVersion(binary, timeout) {
  return new Promise(resolve => execFile(binary, ['--version'], { encoding: 'utf8', timeout, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } },
    (error, stdout, stderr) => resolve(error ? null : versionOf({ stdout, stderr }))));
}
// `agy models`: the models it lists, `[id, name]` sorted by ID, from its lines `<id>\t<name>` (the rest of what it says,
// such as its progress line, goes to the standard error). A CatalogError for one that fails, times out or lists none.
export async function askModels(binary, timeout, cwd) {
  return new Promise((resolve, reject) => execFile(binary, ['models'], { cwd, encoding: 'utf8', timeout,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', NO_COLOR: '1' } }, (error, stdout, stderr) => {
    if (error) {
      const said = `${stderr ?? ''}`.trim().split('\n').filter(line => !/^Fetching available models/.test(line)).at(-1);
      return reject(new CatalogError(`agy models 失败（${error.killed ? `超过 ${timeout / 1000} 秒` : error.code ?? error.signal}）${said ? `：${said}` : ''}`));
    }
    const listed = `${stdout}`.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.includes('\t'))
      .map(line => { const at = line.indexOf('\t'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }).filter(([id]) => id)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (!listed.length) return reject(new CatalogError('agy models 没列出任何模型'));
    resolve(listed);
  }));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// `state`: the plugin's state directory; `binary`: agy's path. The clock, the file system (node:fs/promises), the process
// (node:child_process spawn) and how agy's version and models are asked are given for the tests.
export function createCatalog({ state, binary, home = homedir(), now = Date.now, fs = fsPromises, spawn = spawnProcess, version = askVersion,
  models = askModels, limits: given = {} } = {}) {
  const limits = { ...LIMITS, ...given };
  const file = name => join(state, name);
  const paths = state && { catalog: file('catalog-v1.json'), failure: file('catalog-v1.failure.json'),
    stale: file('catalog-v1.stale.json'), check: file('catalog-v1.check.json'), log: file('catalog-v1.log'), cwd: file('catalog-cwd') };
  const lockFile = n => file(`catalog-v1.lock.${n}`);
  let child = null, holding = 0, aborted = false;

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
  // Whether a catalog answers: 'fresh', 'check' when `agy models` is to be asked first, or false when it is to be collected.
  async function usable(catalog, print) {
    if (!catalog || catalog.format !== print.format || !same(catalog.agy, print.agy) || !same(catalog.settings, print.settings)) return false;
    if ((await readJson(paths.stale))?.collectedAt === catalog.collectedAt) return false;
    // One with no list of agy models is checked at once, save within the cool-down of a check that failed.
    const checked = await readJson(paths.check), last = checked?.collectedAt === catalog.collectedAt ? checked : null;
    const since = last?.at ?? catalog.collectedAt;
    const due = since + (last && !last.ok ? limits.cooldown : Array.isArray(catalog.agyModels) ? limits.check : 0);
    // A clock that went back is due as well.
    return now() >= since && now() < due ? 'fresh' : 'check';
  }
  const noteCheck = async (catalog, ok, reason) => {
    await fs.writeFile(paths.check, JSON.stringify({ collectedAt: catalog.collectedAt, at: now(), ok, ...(reason && { reason }) })).catch(() => {});
  };
  // The check of a catalog: `{ catalog }` to answer with it, or `{ listed }` (agy models' list) to collect it again.
  async function check(catalog) {
    const started = now();
    let listed;
    try { await fs.mkdir(paths.cwd, { recursive: true }); listed = await models(binary, limits.models, paths.cwd); }
    catch (error) {
      await log({ event: 'check.failed', reason: error.message, ms: now() - started });
      await noteCheck(catalog, false, error.message);
      return { catalog };
    }
    if (Array.isArray(catalog.agyModels) && same(listed, catalog.agyModels)) {
      await noteCheck(catalog, true);
      await log({ event: 'check.same', models: listed.length, ms: now() - started });
      return { catalog };
    }
    await log({ event: 'check.changed', reason: Array.isArray(catalog.agyModels) ? 'agy models 列出的模型变了' : '目录里没有 agy models 的模型清单', ms: now() - started });
    return { listed };
  }
  // The lock, or false while another live entry holds it (or took it first).
  async function lock() {
    const names = await fs.readdir(state).catch(error => { throw new CatalogError(`插件状态目录读不了（${error.code ?? error.message}）：${state}`); });
    const top = Math.max(0, ...names.filter(name => !name.endsWith('.free')).map(generation));
    if (top) {
      const holder = await readJson(lockFile(top));
      if (!names.includes(`catalog-v1.lock.${top}.free`) && holder && alive(holder.pid) && now() - holder.at <= limits.collect + 10_000) return false;
    }
    const mine = top + 1, temporary = `${lockFile(mine)}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ pid: process.pid, at: now() })); await fs.link(temporary, lockFile(mine)); }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      throw new CatalogError(`插件状态目录写不进去（${error.code ?? error.message}）：${state}`);
    } finally { await fs.rm(temporary, { force: true }); }
    // One that read an older line than there is now may have made a generation that was cleared: a higher one wins.
    const current = await fs.readdir(state);
    if (current.some(name => generation(name) > mine)) return false;
    holding = mine;
    for (const name of current) if (generation(name) && generation(name) < mine) await fs.rm(file(name), { force: true });
    return true;
  }
  const unlock = async () => { if (holding) { const n = holding; holding = 0; await fs.writeFile(`${lockFile(n)}.free`, ''); } };

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
      const problem = optionsProblem(configOptions);
      if (problem) throw new CatalogError(`agy 的 session/new 给的配置不对：${problem}`);
      if (modes && !modes.availableModes?.some?.(mode => mode?.id === modes.currentModeId)) throw new CatalogError(`agy 的当前模式 ${modes.currentModeId} 不在它的模式里`);
      const byModel = {};
      for (const value of values(model)) {
        const answer = await call('session/set_config_option', { sessionId, configId: model.id, value });
        const chosen = Array.isArray(answer?.configOptions) ? answer.configOptions.find(option => option?.id === model.id) : null;
        if (chosen?.currentValue !== value) throw new CatalogError(`切到模型 ${value} 后 agy 给的配置不是这个模型的`);
        const wrong = optionsProblem(answer.configOptions) ?? (same(values(chosen), values(model)) ? null : '模型列表与 session/new 的不同');
        if (wrong) throw new CatalogError(`切到模型 ${value} 后 agy 给的配置不对：${wrong}`);
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
  // Collects and writes the catalog, all of it or nothing; a failure is remembered. `listed`: agy models' list, when a check
  // has just asked it; else it is asked here, and a catalog whose asking failed keeps none (and is collected again once a
  // check gets one).
  async function refresh(print, listed) {
    const started = now();
    try {
      const catalog = await collect(print);
      catalog.agyModels = listed ?? await models(binary, limits.models, paths.cwd).catch(async error => {
        await log({ event: 'check.failed', reason: error.message });
        return null;
      });
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
      // `{ catalog }` if it is up to date, `{ check }` if agy models is to be asked first, null if it is to be collected; a
      // failure still cooling down is thrown.
      const settled = async () => {
        const cached = await readJson(paths.catalog), status = await usable(cached, print);
        if (status === 'fresh') return { catalog: cached };
        if (status === 'check') return { check: cached };
        const failure = await readJson(paths.failure);
        if (failure && same(failure.fingerprint, print) && now() - failure.at < limits.cooldown)
          throw new CatalogError(`读取 Antigravity 的模型目录失败，${Math.ceil((failure.at + limits.cooldown - now()) / 1000)} 秒后再试：${failure.reason}`);
        return null;
      };
      for (;;) {
        const found = await settled();
        if (found?.catalog) return found.catalog;
        if (await lock()) {
          // Another entry may have collected, checked, or failed to, between the reading and the lock.
          try {
            const again = await settled();
            if (again?.catalog) return again.catalog;
            if (!again) return await refresh(print);
            const checked = await check(again.check);
            if (checked.catalog) return checked.catalog;
            // A collection the check asked for that fails keeps the catalog there was, and the next check waits the cool-down.
            try { return await refresh(print, checked.listed); }
            catch (error) { await noteCheck(again.check, false, error.message); return again.check; }
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
      if (holding) { writeFileSync(`${lockFile(holding)}.free`, ''); holding = 0; }
    },
  };
}
