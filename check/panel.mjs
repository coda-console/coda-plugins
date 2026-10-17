// A panel at the handshake level: its command run once as Coda reads a panel (backend/src/application/panels.mjs `env`,
// adapters/plugin-command.mjs), what it prints held to Coda's panel output (domain/panels.mjs `panelItems`, copied here).
// Its actions are not run: a button may change things (switch an account, spend a reset), and only a person presses it.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { ARGS_LIMIT, ITEM_LIMITS, ITEM_TYPES, OUTPUT_LIMIT, PANEL_READ_LIMIT, THREAD_ENV, cleared, groupsState, pluginEnv } from './coda.mjs';
import { group, temporary } from './leftovers.mjs';

class Invalid extends Error {}
const check = (condition, message) => { if (!condition) throw new Invalid(message); };
const object = (value, where) => check(value && typeof value === 'object' && !Array.isArray(value), `${where} 须为对象`);
const keys = (value, allowed, where) => {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  check(!extra.length, `${where} 里有 Coda 不支持的键：${extra.join('、')}`);
};
const text = (value, max, where, { need = true, line = true } = {}) => {
  if (value === undefined && !need) return;
  check(typeof value === 'string' && value.trim() && [...value].length <= max && !value.includes('\0') && (!line || !/[\r\n]/.test(value)),
    `${where} 须为不超过 ${max} 字的${line ? '一行' : ''}文本`);
};

function item(raw, where, actions, inCard) {
  const L = ITEM_LIMITS;
  object(raw, where);
  check(ITEM_TYPES.includes(raw.type), `${where} 的 type 只能是 ${ITEM_TYPES.join('、')}`);
  check(!(inCard && raw.type === 'card'), `${where}：卡片里不能再放卡片`);
  switch (raw.type) {
    case 'card':
      keys(raw, ['type', 'title', 'subtitle', 'identity', 'items'], where);
      check(Array.isArray(raw.items) && raw.items.length <= L.cardItems, `${where} 的 items 须为不超过 ${L.cardItems} 项的数组`);
      text(raw.title, L.label, `${where} 的 title`); text(raw.subtitle, L.label, `${where} 的 subtitle`, { need: false });
      text(raw.identity, L.identity, `${where} 的 identity`, { need: false });
      return [raw.type, ...raw.items.flatMap((r, i) => item(r, `${where}.items[${i}]`, actions, true))];
    case 'meter':
      keys(raw, ['type', 'label', 'value', 'fraction', 'note', 'time', 'timeLabel'], where);
      check(raw.fraction === undefined || raw.fraction === null || (typeof raw.fraction === 'number' && raw.fraction >= 0 && raw.fraction <= 1),
        `${where} 的 fraction 须在 0–1 之间（还剩多少），不知道时不写`);
      check(raw.time === undefined || (typeof raw.time === 'string' && Number.isFinite(Date.parse(raw.time))), `${where} 的 time 须为 ISO 8601 时间`);
      text(raw.label, L.label, `${where} 的 label`);
      for (const key of ['value', 'note', 'timeLabel']) text(raw[key], L.label, `${where} 的 ${key}`, { need: false });
      return [raw.type];
    case 'stat':
      keys(raw, ['type', 'label', 'value'], where);
      text(raw.label, L.label, `${where} 的 label`); text(raw.value, L.label, `${where} 的 value`);
      return [raw.type];
    case 'markdown':
      keys(raw, ['type', 'text'], where);
      text(raw.text, L.markdown, `${where} 的 text`, { line: false });
      return [raw.type];
    case 'error':
      keys(raw, ['type', 'text'], where);
      text(raw.text, L.error, `${where} 的 text`, { line: false });
      return [raw.type];
    case 'button':
      keys(raw, ['type', 'label', 'action', 'args', 'disabled', 'confirm'], where);
      check(typeof raw.action === 'string' && Object.hasOwn(actions, raw.action), `${where} 的 action 须是面板声明的动作：${raw.action}`);
      check(raw.args === undefined || (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) && JSON.stringify(raw.args).length <= ARGS_LIMIT),
        `${where} 的 args 须为不超过 ${ARGS_LIMIT} 字节的对象`);
      check(raw.disabled === undefined || typeof raw.disabled === 'boolean', `${where} 的 disabled 须为开或关`);
      text(raw.label, L.label, `${where} 的 label`); text(raw.confirm, L.confirm, `${where} 的 confirm`, { need: false, line: false });
      return [raw.type];
  }
}
// The item types a reading holds, cards' items included; throws Invalid with where it went wrong.
export function panelItems(output, panel) {
  check(Buffer.byteLength(output) <= OUTPUT_LIMIT, `输出超过 ${OUTPUT_LIMIT / 1024} KiB`);
  let value;
  try { value = JSON.parse(output); } catch { check(false, '输出不是 JSON'); }
  object(value, '输出');
  keys(value, ['items'], '输出');
  check(Array.isArray(value.items) && value.items.length <= ITEM_LIMITS.items, `输出的 items 须为不超过 ${ITEM_LIMITS.items} 项的数组`);
  return value.items.flatMap((r, i) => item(r, `items[${i}]`, panel.actions, false));
}

// `sh -c` in its own process group from a temporary directory, stopped past the deadline or past 64 KiB of output. The
// group goes with the checker if that ends first (a Ctrl-C does not reach it).
function run(command, env, limit) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: tmpdir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = group(child.pid), out = [], err = [];
    let size = 0, overflow = false, timedOut = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} ended(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, limit);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > OUTPUT_LIMIT) { overflow = true; kill(); } else out.push(chunk); });
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout: '', stderr: '' }); });
    child.on('close', code => { clearTimeout(timer); kill();
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), overflow, timedOut }); });
  });
}
const lastLine = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map(l => l.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';

export async function checkPanel({ panel, pluginDir, settings, dependencies = {}, say, limit = PANEL_READ_LIMIT }) {
  // The plugin's state directory, which Coda keeps for it; here a temporary one, gone however the checker ends.
  const state = temporary('coda-plugin-check-state-');
  try {
    const env = { ...cleared(process.env), ...pluginEnv({ pluginDir, stateDir: state.dir, settings, dependencies }), CODA_GROUPS_STATE: groupsState(),
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':') };
    delete env[THREAD_ENV];
    const started = Date.now(), result = await run(panel.command, env, limit);
    if (result.timedOut) return say.fail('panel.read', `读取 ${limit / 1000} 秒没结束：Coda 停下这次读取`);
    if (result.overflow) return say.fail('panel.read', `标准输出超过 ${OUTPUT_LIMIT / 1024} KiB：Coda 停下这次读取`);
    if (result.code !== 0) return say.fail('panel.read', `读取命令${result.error ? `起不来：${result.error}` : `退出码 ${result.code}`}${lastLine(result.stderr || result.stdout) ? `：${lastLine(result.stderr || result.stdout)}` : ''}`);
    let types;
    try { types = panelItems(result.stdout, panel); } catch (e) { if (!(e instanceof Invalid)) throw e; return say.fail('panel.output', `输出不合面板格式：${e.message}`); }
    const counts = Object.entries(Object.groupBy(types, t => t)).map(([t, list]) => `${t} ×${list.length}`).join('，');
    if (!types.length) say.info('panel.read', `读出空的 items（${((Date.now() - started) / 1000).toFixed(1)} 秒）：资源页不显示它${panel.signIn ? '，它出现在「添加资源」里' : ''}`);
    else say.pass('panel.read', `读取 ${((Date.now() - started) / 1000).toFixed(1)} 秒，输出合面板格式：${counts}`);
    if (Object.keys(panel.actions).length) say.skip('panel.actions', `动作 ${Object.keys(panel.actions).join('、')} 不运行：按钮可能改动东西，只由人点`);
  } finally {
    state.remove();
  }
}
