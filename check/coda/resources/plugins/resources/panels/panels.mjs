// The resource types installed plugins bring to this machine's resources page (docs/plugins.md「资源」), read and acted on
// here, in the resources plugin's module: what each plugin declares comes from Coda's collection of the installed plugins
// (`coda.watch("plugins")`), and each command runs with that plugin's own environment (`coda.environment(null, { plugin })`),
// as Coda gives every process of the plugin's. A plugin declaring `resources` has those; one still declaring the panels
// before them has its panels, read as they were (`format`), for the page to take as resources (docs/plugins.md「旧的面板」).
// A type is read when a page asks (opening it, refreshing, an action), or, for a kind declaring `report`, on its period
// while this machine shows it; nothing else is read in the background, and no reading is kept on disk.
// What every type gets from here and not from its plugin: one reading at a time (a second ask joins it), the last good
// reading shown again within the type's `maxAge` and listed with it, and on failure the last good one kept and marked as
// such. The machine keeps which it shows and which not, in this plugin's state; their order is their plugins'
// (docs/resources-page.md「顺序」). Inside, a type is still called a panel, as the page's view and its messages are.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, ended, outcome } from './command.mjs';
import { PanelError, panelDeclarations, panelItems, resourceItems, actionArgs, shownItems, displayOptions, keepMissingMetrics } from './rules.mjs';
import { SignIn, authorizationLink, deviceCode } from './sign-in.mjs';

const fail = (code, message) => { throw new PanelError(code, message); };

export class Panels {
  // `onChange(key)`: a panel moved (its reading, its login, whether it is hidden); none for the list as a whole.
  // `run`: how a command runs (panels/command.mjs runCommand); `now()`: the time, as readings are dated by it.
  constructor(coda, { run = runCommand, now = Date.now, readTimeoutMs = 30_000, actionTimeoutMs = 10 * 60_000, timer = true } = {}) {
    this.coda = coda; this.run = run; this.now = now; this.readTimeoutMs = readTimeoutMs; this.actionTimeoutMs = actionTimeoutMs; this.timerOn = timer;
    // `last`: each panel's last good items, for a failed reading to show again; `shown`: what its last reading answered.
    this.plugins = new Map(); this.last = new Map(); this.shown = new Map(); this.reading = new Map(); this.acting = new Map(); this.failures = new Map();
    this.logins = new Map(); this.envs = new Map(); this.listeners = new Set(); this.closing = new AbortController();
    this.file = join(coda.plugin.state ?? tmpdir(), 'hidden.json');
    this.hides = Promise.resolve();
    // The kind types this module reported, by kind (`{ plugin, type }`), and why an upload last failed, said once.
    this.reportedKinds = new Map(); this.reportSaid = new Map(); this.reportedAt = new Map(); this.timer = null;
  }
  listen(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  // Nothing is told before the plugins' environments are there (`ready`): what a login says of whether its program is
  // installed is checked with its plugin's own.
  changed(key = null) { if (this.ready) for (const fn of this.listeners) try { fn(key); } catch {} }
  // Once: the installed plugins watched, what this machine shows and hides, and the environment of each plugin whose panels sign in.
  start() {
    this.started ??= (async () => {
      this.choices = this.readHidden();
      const watched = await this.coda.watch('plugins', ({ type, id, object }) => {
        if (type === 'DELETED') this.plugins.delete(id); else this.plugins.set(id, object);
        // Another version (another directory, another environment): what was checked with the last is checked again.
        this.envs.delete(id);
        for (const [key, login] of this.logins) if (key.startsWith(`${id}/`)) login.recheck();
        // A login of a panel gone (its plugin removed, or a version without it) goes with it.
        const keys = new Set(this.installed().map(e => e.key));
        for (const [key, login] of this.logins) if (!keys.has(key)) { login.close(); this.logins.delete(key); }
        if (this.ready) this.prepare().then(() => { this.dropMissing(); this.forgetHidden(); this.changed(); });
      });
      this.unwatch = () => watched.dispose();
      await this.prepare();
      this.ready = true;
      // A kind declaring a report is read on its own period while this machine shows it (none before it is chosen).
      this.forgetHidden();
      if (this.timerOn) { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); }
    })();
    return this.started;
  }
  // What the machine was told to hide or show, by panel: none when nothing is, or what is cannot be read. Kept before as
  // the list of those hidden.
  readHidden() {
    try {
      const kept = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(kept) ? Object.fromEntries(kept.map(key => [key, true])) : kept && typeof kept === 'object' ? kept : {};
    } catch { return {}; }
  }
  keepHidden(choices) {
    const next = `${this.file}.next`;
    writeFileSync(next, JSON.stringify(Object.fromEntries(Object.entries(choices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
    renameSync(next, this.file);
  }
  // Whether the machine hides it: as it was told, else as its type says (`hidden`, shown only once chosen).
  hiddenOf({ key, panel }) { return this.choices[key] ?? !!panel.hidden; }
  // The installed plugins' types, by plugin id, each plugin's in the order it declares them: its resource types, or the
  // panels of one that declares none. A project disabling a plugin does not take them away: the page is the machine's,
  // not a project's.
  installed() {
    return [...this.plugins.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).flatMap(plugin => {
      const format = plugin.contributes?.resources ? 'resources' : 'panels';
      return panelDeclarations(plugin.contributes?.[format]).map(panel => ({ plugin, panel, key: `${plugin.id}/${panel.id}`, format }));
    });
  }
  find(key) {
    return this.installed().find(e => e.key === key) ?? fail('not_found', `没有面板 ${key}`);
  }
  // Before a list is shown: the environment of each plugin whose panels sign in, for whether what they sign in to is there.
  async prepare() {
    const plugins = new Set(this.installed().filter(e => e.panel.signIn && !this.envs.has(e.plugin.id)).map(e => e.plugin.id));
    await Promise.all([...plugins].map(id => this.env(id).catch(() => {})));
  }
  // What a page shows of a panel: what it is, whether the machine hides it, what was last read and how that stands now.
  view(entry, index) {
    const { plugin, panel, key, format } = entry, shown = this.shown.get(key), acting = this.acting.get(key);
    return { plugin: plugin.id, pluginName: plugin.name, panel: panel.id, title: panel.title, format, version: plugin.version ?? '', source: plugin.source ?? { kind: 'builtin' },
      ...(panel.kind ? { kind: panel.kind } : {}),
      actions: Object.fromEntries(Object.entries(panel.actions ?? {}).map(([name, a]) => [name, a.confirm ? { confirm: a.confirm } : {}])),
      configurable: !!panel.displaySetting, signsIn: !!panel.signIn, hidden: this.hiddenOf(entry), index,
      signIn: panel.signIn ? this.login(entry).view() : null,
      reading: shown ? this.present(entry, shown) : null,
      busy: this.reading.has(key), failure: this.failures.get(key) ?? null,
      // The action under way, by its button; or why the last one did not go through, with the button it was.
      acting: acting && !acting.error ? acting.button : null, actionError: acting?.error ?? null, failedButton: acting?.error ? acting.button : null };
  }
  list() { return this.installed().map((entry, index) => [entry.key, this.view(entry, index)]); }
  // One panel's, as `list` has it; none for one no longer installed.
  viewOf(key) {
    const listed = this.installed(), index = listed.findIndex(e => e.key === key);
    return index < 0 ? null : this.view(listed[index], index);
  }
  // The plugin's environment, as Coda gives every process of it, read again for each command: what it holds (its
  // settings, the concurrency groups now) is of the moment.
  async env(plugin, extra = {}) {
    const env = { ...(await this.coda.environment(null, { plugin })), ...extra };
    this.envs.set(plugin, env);
    return env;
  }
  settingsOf(plugin) {
    try { return JSON.parse(this.envs.get(plugin)?.CODA_PLUGIN_SETTINGS ?? '{}'); } catch { return {}; }
  }
  present({ plugin, panel }, reading) {
    if (!panel.displaySetting) return reading;
    const values = this.settingsOf(plugin.id)[panel.displaySetting] ?? {};
    return { ...reading, items: shownItems(reading.items, values), display: { setting: panel.displaySetting, options: displayOptions(reading.items, values) } };
  }
  // `{ resources, readAt }` (a panel's `{ items, readAt }`), or with `error` when this reading failed: then the last good
  // one with `stale`, or none.
  read(key, { force = false } = {}) {
    const entry = this.find(key);
    const pending = this.reading.get(key);
    if (pending) return pending;
    const last = this.last.get(key);
    if (!force && last && entry.panel.maxAgeMs && this.now() - last.at < entry.panel.maxAgeMs && !this.shown.get(key)?.error) return Promise.resolve(this.present(entry, { ...last.content, readAt: last.at }));
    const reading = this.fetch(entry).finally(() => { this.reading.delete(key); this.changed(key); });
    this.reading.set(key, reading);
    this.changed(key);
    return reading;
  }
  async fetch(entry) {
    const { plugin, panel, key } = entry;
    if (panel.reportMs) this.reportedAt.set(key, this.now());
    let failure;
    try {
      const result = await this.run(panel.command, { env: await this.env(plugin.id), timeoutMs: this.readTimeoutMs, signal: this.closing.signal });
      if (ended(result)) {
        const content = this.content(entry, result.stdout), at = this.now();
        this.last.set(key, { content, at }); this.failures.delete(key);
        this.shown.set(key, { ...content, readAt: at });
        // A kind's reading is what this machine reports of it: a failed one reports nothing, so the last good objects stay.
        if (entry.panel.kind) await this.report(entry, content.resources, at);
        return this.present(entry, { ...content, readAt: at });
      }
      failure = outcome(result, '读取');
    } catch (e) {
      if (!(e instanceof PanelError)) { this.failures.set(key, e.message); throw e; }
      failure = `输出无效：${e.message}`;
    }
    const last = this.last.get(key);
    const reading = last ? { ...last.content, readAt: last.at, stale: true, error: failure } : { [entry.format === 'resources' ? 'resources' : 'items']: [], error: failure };
    this.shown.set(key, reading);
    return this.present(entry, reading);
  }
  // What a command printed, as its format has it: resources, or a panel's items (those it chooses among keeping their places).
  content({ plugin, panel, key, format }, output) {
    if (format === 'resources') return { resources: resourceItems(output, panel, plugin.views ?? []) };
    const items = panelItems(output, panel, plugin.views ?? []);
    return { items: panel.displaySetting ? keepMissingMetrics(items, this.last.get(key)?.content.items ?? []) : items };
  }
  // A kind's reading reported to this machine's backend (GET /v1/resources gives it back to the page and explain): the
  // fields Coda keeps are the name, the outside identity it is, its values, what is wrong, and when it was read. Buttons
  // and what they send stay here; a failure reports nothing, so the last good objects stay.
  async report(entry, resources, at) {
    const { plugin, panel } = entry;
    const body = { plugin: plugin.id, type: panel.id, kind: panel.kind, observedAt: new Date(at).toISOString(),
      resources: resources.map(({ name, identity, values, error }) => ({ ...(name !== undefined ? { name } : {}), ...(identity !== undefined ? { identity } : {}),
        values: values ?? [], ...(error !== undefined ? { error } : {}) })) };
    try {
      await this.coda.api('resource-reports', body);
      this.reportedKinds.set(panel.kind, { plugin: plugin.id, type: panel.id });
      this.reportSaid.delete(entry.key);
    } catch (e) {
      if (this.reportSaid.get(entry.key) === e.message) return;
      this.reportSaid.set(entry.key, e.message);
      console.error(`[资源] ${panel.title} 没有上报读数：${e.message}`);
    }
  }
  // This machine no longer shows or has the type: its objects go, and it is not read on its period.
  // This machine no longer shows or has the type: its objects go, and it is not read on its period. Asked whether this
  // module reported it or not: after a restart neither it nor the backend remembers, while the kernel still has them.
  forgetKind(kind) {
    if (!kind) return Promise.resolve();
    return this.coda.api('resource-reports/forget', { kind }).then(() => { this.reportedKinds.delete(kind); }, e => {
      const said = `forget ${kind}`;
      if (this.reportSaid.get(said) === e.message) return;
      this.reportSaid.set(said, e.message);
      console.error(`[资源] ${kind} 没有停止上报：${e.message}`);
    });
  }
  // The kinds this machine hides now: their objects go once the module starts (and when they are hidden), even when this
  // module has no memory of reading them.
  forgetHidden() {
    for (const entry of this.installed()) if (entry.panel.kind && this.hiddenOf(entry)) void this.forgetKind(entry.panel.kind);
  }
  // Kinds no longer declared by an installed plugin: their objects go.
  dropMissing() {
    const kinds = new Set(this.installed().filter(entry => entry.panel.kind).map(entry => entry.panel.kind));
    for (const kind of [...this.reportedKinds.keys()]) if (!kinds.has(kind)) void this.forgetKind(kind);
  }
  // The kinds due to report now: each shown one with a report period, read again (and so reported once it ends).
  tick() {
    if (!this.ready) return;
    const now = this.now();
    for (const entry of this.installed()) {
      const { panel } = entry;
      if (!panel.kind || !panel.reportMs || this.hiddenOf(entry)) continue;
      const last = this.reportedAt.get(entry.key);
      if (last !== undefined && now - last < panel.reportMs) continue;
      this.reportedAt.set(entry.key, now);
      this.read(entry.key, { force: true }).catch(() => {});
    }
  }
  // Runs one of a panel's actions with what its button sent, then reads the panel again. One action of a panel at a time;
  // one under way goes on to its end even when whoever asked has gone.
  async act(key, name, args, button = name) {
    const entry = this.find(key), { plugin, panel } = entry, now = this.acting.get(key);
    if (now && !now.error) fail('panel_busy', `${panel.title} 正在进行另一项操作`);
    // What went wrong is said under the panel, whatever it was.
    try {
      const action = panel.actions?.[name] ?? fail('not_found', `面板 ${panel.title} 没有动作 ${name}`);
      const given = actionArgs(args);
      this.acting.set(key, { button }); this.changed(key);
      const result = await this.run(action.command, { env: await this.env(plugin.id, { CODA_PANEL_ARGS: JSON.stringify(given) }),
        timeoutMs: this.actionTimeoutMs, signal: this.closing.signal });
      if (!ended(result)) fail('action_failed', outcome(result, '操作'));
      this.acting.delete(key);
    } catch (e) {
      this.acting.set(key, { button, error: e.message }); this.changed(key);
      throw e;
    }
    // A reading that began before the action ended may not show what it did.
    await this.reading.get(key);
    return this.read(key, { force: true });
  }
  // One type hidden or shown on this machine, the others as they were: one change at a time.
  hide(key, hidden) {
    const entry = this.installed().find(e => e.key === key);
    const change = this.hides.then(async () => {
      const next = { ...this.choices, [key]: !!hidden };
      this.keepHidden(next);
      this.choices = next;
      // Hidden, a kind is neither read nor reported: what it gave the kernel goes.
      if (hidden && entry?.panel.kind) await this.forgetKind(entry.panel.kind);
      this.changed(key);
    });
    this.hides = change.catch(() => {});
    return change;
  }
  // A panel's login from Coda (docs/plugins.md「面板的登录」), one per panel at a time. Signed in, the panel is read anew;
  // its CLI installed, the plugin's setup is run again (docs/plugins.md「准备运行环境」), which done well has Coda read its
  // agents again: what they offer may be readable now.
  login(entry) {
    const { plugin, panel, key } = entry, known = this.logins.get(key);
    const declared = panel.signIn ?? fail('not_found', `${panel.title} 不能从 Coda 登录`);
    if (known?.declared === JSON.stringify(declared)) return known;
    known?.close();
    const env = () => this.envs.get(plugin.id) ?? process.env;
    // Whether it is there: a quick check with the plugin's own environment, asked again after a moment at most. Without
    // one, it always is; without the environment yet, it is not checked, and nothing is kept of it.
    let checkedAt = 0, there = false;
    const installed = (fresh = false) => {
      if (!declared.installed) return true;
      const given = this.envs.get(plugin.id);
      if (!given) return false;
      if (fresh || Date.now() - checkedAt > 2000) { there = spawnSync('/bin/sh', ['-c', declared.installed], { cwd: tmpdir(), env: given, stdio: 'ignore', timeout: 2000 }).status === 0; checkedAt = Date.now(); }
      return there;
    };
    const login = new SignIn({ provider: key, name: panel.title, command: declared.command, installed, install: declared.install ?? null,
      readCode: declared.input ? authorizationLink : deviceCode, input: !!declared.input, note: declared.note ?? null },
    { env, onChange: () => this.changed(key),
      onSignedIn: () => { this.read(key, { force: true }).catch(() => {}); },
      onInstalled: () => { checkedAt = 0; this.coda.api(`plugins/${encodeURIComponent(plugin.id)}/setup`, {}).catch(() => {}); } });
    login.declared = JSON.stringify(declared);
    login.recheck = () => { checkedAt = 0; };
    this.logins.set(key, login);
    return login;
  }
  async signIn(key, what, body = {}) {
    const entry = this.find(key);
    // The command runs with the plugin's environment as it is now.
    await this.env(entry.plugin.id);
    const login = this.login(entry);
    switch (what) {
      case 'signIn': return login.start();
      case 'install': return login.install();
      case 'cancelSignIn': return login.cancel();
      case 'submitSignIn': return login.submit(body);
      default: return login.view();
    }
  }
  // The module going (the plugin host stopping): what runs in a process group of its own is made to end, as nothing would later.
  close() { this.closing.abort(); clearInterval(this.timer); this.unwatch?.(); for (const login of this.logins.values()) login.close('SIGKILL'); }
}
