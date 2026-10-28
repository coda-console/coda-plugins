// What a panel is (docs/plugins.md「面板」): how a plugin declares one (`contributes.panels`) and what its command may
// print, checked here, where the panels are read, the way a task's card is drawn from its fields. Nothing here knows what
// a panel is about: CPU, an account's quota and a disk are all meters and figures.

// What is not as it must be: the panel says so where it would show.
export class PanelError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function check(condition, code, message) {
  if (!condition) throw new PanelError(code, message);
  return condition;
}
// An ISO 8601 duration as panels write their `maxAge` (`PT5M`, `P1D`): weeks, days and time, not years or months.
const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
export function isDuration(text) {
  const m = typeof text === 'string' && text.length <= 200 && DURATION.exec(text);
  return !!m && text !== 'P' && !text.endsWith('T');
}
export function durationMs(text) {
  const [, w = 0, d = 0, h = 0, min = 0, s = 0] = DURATION.exec(text);
  return ((((+w * 7 + +d) * 24 + +h) * 60 + +min) * 60 + +s) * 1000;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const ITEM_TYPES = ['card', 'meter', 'stat', 'markdown', 'button', 'error'];
// What a panel's command may print: past these, the reading fails rather than being cut short.
export const OUTPUT_LIMIT = 64 * 1024;
export const ARGS_LIMIT = 4 * 1024;
const ITEMS = 50, CARD_ITEMS = 20, TITLE = 40, LABEL = 80, IDENTITY = 200, MARKDOWN = 4000, ERROR = 500, CONFIRM = 200;
const fail = (code, message) => check(false, code, message);
const keys = (value, allowed, where, code) => {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  check(!extra.length, code, `${where} 里有 Coda 不支持的键：${extra.join('、')}`);
};
const text = (value, max, where, code, { need = true, line = true } = {}) => {
  if (value === undefined && !need) return undefined;
  check(typeof value === 'string' && value.trim() && [...value].length <= max && !value.includes('\0') && (!line || !/[\r\n]/.test(value)), code,
    `${where} 须为不超过 ${max} 字的${line ? '一行' : ''}文本`);
  return value;
};
const object = (value, where, code) => check(value && typeof value === 'object' && !Array.isArray(value), code, `${where} 须为对象`);

// ---- Declarations (`contributes.panels`) ----
// One panel as the plugin declares it: what it is called, the command that reads it, how long a reading may be shown
// again without asking, the actions its buttons may take, each a command of its own with what to ask first, and how to
// sign in to what it shows from Coda.
function declaration(raw, where) {
  const code = 'invalid_plugin';
  object(raw, where, code);
  keys(raw, ['id', 'title', 'command', 'maxAge', 'actions', 'signIn', 'displaySetting'], where, code);
  check(typeof raw.id === 'string' && NAME.test(raw.id), code, `${where} 的 id 只能用小写字母、数字和「-」，以字母开头`);
  const at = `面板 ${raw.id}`;
  check(raw.maxAge === undefined || (typeof raw.maxAge === 'string' && isDuration(raw.maxAge)), code, `${at} 的 maxAge 须为 ISO 8601 时长，如 PT5M`);
  const actions = {};
  if (raw.actions !== undefined) {
    object(raw.actions, `${at} 的 actions`, code);
    for (const [name, action] of Object.entries(raw.actions)) {
      check(NAME.test(name), code, `${at} 的动作名只能用小写字母、数字和「-」，以字母开头：${name}`);
      object(action, `${at} 的动作 ${name}`, code);
      keys(action, ['command', 'confirm'], `${at} 的动作 ${name}`, code);
      actions[name] = { command: text(action.command, 4000, `${at} 的动作 ${name} 的 command`, code),
        ...(action.confirm !== undefined ? { confirm: text(action.confirm, CONFIRM, `${at} 的动作 ${name} 的 confirm`, code, { line: false }) } : {}) };
    }
  }
  return { id: raw.id, title: text(raw.title, TITLE, `${at} 的 title`, code), command: text(raw.command, 4000, `${at} 的 command`, code),
    ...(raw.maxAge !== undefined ? { maxAge: raw.maxAge, maxAgeMs: durationMs(raw.maxAge) } : {}), actions,
    ...(raw.displaySetting !== undefined ? { displaySetting: text(raw.displaySetting, LABEL, `${at} 的 displaySetting`, code) } : {}),
    ...(raw.signIn !== undefined ? { signIn: signIn(raw.signIn, `${at} 的 signIn`) } : {}) };
}
// Signing in from Coda (adapters/sign-in.mjs): a login command that prints a link to
// confirm on any device (with a code, or asking for the authorization code the page shows, which goes to its standard
// input), and where Coda may install what it needs, a quick check that it is there and the command that installs it.
function signIn(raw, where) {
  const code = 'invalid_plugin';
  object(raw, where, code);
  keys(raw, ['command', 'installed', 'install', 'input', 'note'], where, code);
  check(raw.input === undefined || raw.input === 'authorizationCode', code, `${where} 的 input 只能是 authorizationCode`);
  check(raw.install === undefined || raw.installed !== undefined, code, `${where}：写了 install 就要写 installed，Coda 才知道装没装好`);
  return { command: text(raw.command, 4000, `${where} 的 command`, code),
    ...(raw.installed !== undefined ? { installed: text(raw.installed, 4000, `${where} 的 installed`, code) } : {}),
    ...(raw.install !== undefined ? { install: text(raw.install, 4000, `${where} 的 install`, code) } : {}),
    ...(raw.input ? { input: raw.input } : {}),
    ...(raw.note !== undefined ? { note: text(raw.note, CONFIRM, `${where} 的 note`, code, { line: false }) } : {}) };
}
// A plugin's panels as it declares them, each on its own: one Coda cannot read is kept with why, under the id and title it
// wrote (or its place and the plugin's name), for the page to say so where it would show.
export function panelEntries(raw, pluginName) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [{ invalid: { id: 'panels', title: pluginName, error: 'contributes.panels 须为数组' } }];
  const seen = new Set();
  return raw.map((item, i) => {
    // An ID is the first one's that writes it, read or not; one whose ID is not one, or another's, goes by its place.
    const named = typeof item?.id === 'string' && NAME.test(item.id), again = named && seen.has(item.id);
    const id = named && !again ? item.id : `#${i + 1}`;
    if (named) seen.add(item.id);
    try {
      check(!again, 'invalid_plugin', `contributes.panels 里有重复的 id：${item.id}`);
      return { panel: declaration(item, `contributes.panels[${i}]`) };
    } catch (e) {
      if (!(e instanceof PanelError)) throw e;
      return { invalid: { id, title: typeof item?.title === 'string' && item.title.trim() ? item.title.slice(0, 40) : pluginName, error: e.message } };
    }
  });
}
export function panelDeclarations(raw) {
  if (raw === undefined) return [];
  check(Array.isArray(raw), 'invalid_plugin', 'contributes.panels 须为数组');
  const panels = raw.map((p, i) => declaration(p, `contributes.panels[${i}]`));
  check(new Set(panels.map(p => p.id)).size === panels.length, 'invalid_plugin', 'contributes.panels 里有重复的 id');
  return panels;
}

// ---- What a panel's command prints ----
// `{ items: [...] }`, each item one of ITEM_TYPES; a card holds the others. A button names one of the panel's actions,
// or one of its plugin's views for the client to open (docs/plugins.md「视图」). `scope`: `{ actions, views }`, what the
// panel declares and the ids of its plugin's views. Returned as the clients get it: only the keys each type has.
function item(raw, where, scope, inCard) {
  object(raw, where, 'invalid_panel');
  const { display, ...content } = raw;
  const out = plainItem(content, where, scope, inCard);
  if (display !== undefined) {
    object(display, `${where}.display`, 'invalid_panel');
    keys(display, ['id', 'default'], `${where}.display`, 'invalid_panel');
    check(['meter', 'stat'].includes(out.type), 'invalid_panel', '只有数值项可以声明 display');
    check(typeof display.default === 'boolean', 'invalid_panel', 'display.default 须为开或关');
    out.display = { id: text(display.id, 200, 'display.id', 'invalid_panel'), default: display.default };
  }
  return out;
}
function plainItem(raw, where, scope, inCard) {
  const code = 'invalid_panel';
  object(raw, where, code);
  check(ITEM_TYPES.includes(raw.type), code, `${where} 的 type 只能是 ${ITEM_TYPES.join('、')}`);
  check(!(inCard && raw.type === 'card'), code, `${where}：卡片里不能再放卡片`);
  switch (raw.type) {
    case 'card': {
      keys(raw, ['type', 'title', 'subtitle', 'identity', 'items'], where, code);
      check(Array.isArray(raw.items) && raw.items.length <= CARD_ITEMS, code, `${where} 的 items 须为不超过 ${CARD_ITEMS} 项的数组`);
      // The outside identity it shows (an account), compared and nothing else: a group view shows cards naming the same
      // one once for the machines that have them.
      return { type: 'card', title: text(raw.title, LABEL, `${where} 的 title`, code),
        ...(raw.subtitle !== undefined ? { subtitle: text(raw.subtitle, LABEL, `${where} 的 subtitle`, code) } : {}),
        ...(raw.identity !== undefined ? { identity: text(raw.identity, IDENTITY, `${where} 的 identity`, code) } : {}),
        items: raw.items.map((r, i) => item(r, `${where}.items[${i}]`, scope, true)) };
    }
    case 'meter': {
      keys(raw, ['type', 'label', 'value', 'fraction', 'note', 'time', 'timeLabel'], where, code);
      // Unknown is said by leaving the fraction out, never by a zero.
      check(raw.fraction === undefined || raw.fraction === null || (typeof raw.fraction === 'number' && raw.fraction >= 0 && raw.fraction <= 1), code,
        `${where} 的 fraction 须在 0–1 之间，不知道时不写`);
      check(raw.time === undefined || (typeof raw.time === 'string' && Number.isFinite(Date.parse(raw.time))), code, `${where} 的 time 须为 ISO 8601 时间`);
      return { type: 'meter', label: text(raw.label, LABEL, `${where} 的 label`, code),
        ...(raw.value !== undefined ? { value: text(raw.value, LABEL, `${where} 的 value`, code) } : {}),
        ...(typeof raw.fraction === 'number' ? { fraction: raw.fraction } : {}),
        ...(raw.note !== undefined ? { note: text(raw.note, LABEL, `${where} 的 note`, code) } : {}),
        ...(raw.time !== undefined ? { time: new Date(raw.time).toISOString() } : {}),
        ...(raw.timeLabel !== undefined ? { timeLabel: text(raw.timeLabel, LABEL, `${where} 的 timeLabel`, code) } : {}) };
    }
    case 'stat':
      keys(raw, ['type', 'label', 'value'], where, code);
      return { type: 'stat', label: text(raw.label, LABEL, `${where} 的 label`, code), value: text(raw.value, LABEL, `${where} 的 value`, code) };
    case 'markdown':
      keys(raw, ['type', 'text'], where, code);
      return { type: 'markdown', text: text(raw.text, MARKDOWN, `${where} 的 text`, code, { line: false }) };
    case 'error':
      keys(raw, ['type', 'text'], where, code);
      return { type: 'error', text: text(raw.text, ERROR, `${where} 的 text`, code, { line: false }) };
    case 'button': {
      keys(raw, ['type', 'label', 'action', 'view', 'args', 'disabled', 'confirm'], where, code);
      // What it does: run one of the panel's actions here, or open one of its plugin's views in the client.
      const opens = raw.view !== undefined;
      check(opens !== (raw.action !== undefined), code, `${where} 须有 action 或 view 之一`);
      if (opens) check(typeof raw.view === 'string' && scope.views.includes(raw.view), code, `${where} 的 view 须是插件声明的视图：${raw.view}`);
      else check(typeof raw.action === 'string' && Object.hasOwn(scope.actions, raw.action), code, `${where} 的 action 须是面板声明的动作：${raw.action}`);
      check(raw.args === undefined || (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) && JSON.stringify(raw.args).length <= ARGS_LIMIT), code,
        `${where} 的 args 须为不超过 ${ARGS_LIMIT} 字节的对象`);
      check(raw.disabled === undefined || typeof raw.disabled === 'boolean', code, `${where} 的 disabled 须为开或关`);
      // Its own question, for what this one button does (which account, which credit), in place of its action's.
      return { type: 'button', label: text(raw.label, LABEL, `${where} 的 label`, code), ...(opens ? { view: raw.view } : { action: raw.action }),
        ...(raw.args ? { args: raw.args } : {}), ...(raw.disabled ? { disabled: true } : {}),
        ...(raw.confirm !== undefined ? { confirm: text(raw.confirm, CONFIRM, `${where} 的 confirm`, code, { line: false }) } : {}) };
    }
  }
  return fail(code, `${where} 的 type 不受支持`);
}
// A panel's reading from what its command printed. Anything it cannot be fails the reading, with where. `views`: the ids
// of its plugin's views, which a button may open.
export function panelItems(output, panel, views = []) {
  const code = 'invalid_panel';
  check(Buffer.byteLength(output) <= OUTPUT_LIMIT, code, `输出超过 ${OUTPUT_LIMIT / 1024} KiB`);
  let value;
  try { value = JSON.parse(output); } catch { return fail(code, '输出不是 JSON'); }
  object(value, '输出', code);
  keys(value, ['items'], '输出', code);
  check(Array.isArray(value.items) && value.items.length <= ITEMS, code, `输出的 items 须为不超过 ${ITEMS} 项的数组`);
  const items = value.items.map((r, i) => item(r, `items[${i}]`, { actions: panel.actions, views }, false));
  const ids = items.flatMap(i => i.type === 'card' ? i.items : [i]).filter(i => i.display).map(i => i.display.id);
  check(!ids.length || panel.displaySetting, code, '数值项的 display 需要面板声明 displaySetting');
  check(new Set(ids).size === ids.length, code, 'display.id 不能重复');
  return items;
}
// What a button sends: an object the action's command reads as JSON.
export function actionArgs(value) {
  if (value === undefined || value === null) return {};
  check(typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= ARGS_LIMIT, 'invalid_input', `args 须为不超过 ${ARGS_LIMIT} 字节的对象`);
  return value;
}

// A reading keeps all measurements in memory; display choices are ordinary plugin settings, applied at read time.
export function shownItems(items, choices = {}) {
  return items.flatMap(({ display, ...item }) => {
    if (display && !(choices[display.id] ?? display.default)) return [];
    if (item.type === 'card') {
      item.items = shownItems(item.items, choices);
      if (!item.items.length) return [];
    }
    return [item];
  });
}
export function displayOptions(items, values = {}) {
  return items.flatMap(item => (item.type === 'card' ? item.items : [item]).filter(i => i.display).map(i => ({
    id: i.display.id, label: i.label, group: item.type === 'card' ? item.title : '',
    enabled: values[i.display.id] ?? i.display.default, default: i.display.default,
  })));
}

// A disconnected device keeps its place for this backend's lifetime, with no old number presented as current.
export function keepMissingMetrics(items, previous) {
  const ids = new Set(items.flatMap(i => i.type === 'card' ? i.items : [i]).flatMap(i => i.display ? [i.display.id] : []));
  const result = [...items];
  for (const old of previous) {
    const missing = (old.type === 'card' ? old.items : [old]).filter(i => i.display && !ids.has(i.display.id))
      .map(i => ({ type: 'stat', label: i.label, value: '暂不可读', display: i.display }));
    if (!missing.length) continue;
    if (old.type === 'card') {
      const same = result.find(i => i.type === 'card' && i.title === old.title);
      if (same) same.items = [...same.items, ...missing].slice(0, 20);
      else if (result.length < 50) result.push({ ...old, items: missing });
    } else if (result.length < 50) result.push(...missing);
  }
  return result;
}
