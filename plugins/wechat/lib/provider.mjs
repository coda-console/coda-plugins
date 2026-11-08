// Each WeChat group is a coda/session@1 record, published to the space: the group's name, the account it is read through as
// the container, its members and the cursor of its newest message. `read` pages its messages from the phone bridge.
//
// A cursor is a message's `seq` in its group, in decimal. The record ID is `<account>:<group>`, and the account is the
// record's container, so a read finds the group from the record alone.
export const SESSION = 'coda/session@1';
// The host stamps each published object with this plugin's id; we only react to our own. It tells us that id through
// `coda.plugin.id`, so we follow whatever it calls us and fall back to our manifest id only when it says nothing.
const PLUGIN = 'wechat';
const LIMIT = 50;
const cursor = seq => String(seq);
const position = value => value === undefined ? undefined : Number(value);
const recordId = (account, group) => `${account}:${group}`;

export class WechatProvider {
  constructor(coda, bridge) {
    this.coda = coda; this.bridge = bridge;
    this.plugin = coda.plugin?.id ?? PLUGIN;
    this.records = new Map(); this.queue = Promise.resolve();
  }
  async start() {
    this.observation = await this.coda.protocols.observe(SESSION, ({ type, id, object }) => {
      if (object.provider !== this.plugin) return;
      if (type === 'DELETED') this.records.delete(id); else this.records.set(id, object);
    }, 'local');
    this.reading = this.coda.protocols.handle(SESSION, 'read', (input, { record }) => this.read(record, input));
    this.watching = this.bridge.watch({
      message: ({ account, group, seq }) => this.schedule(() => this.advance(recordId(account, group), seq)),
      changed: () => this.schedule(() => this.sync()),
    });
    await this.schedule(() => this.sync());
  }
  async stop() {
    this.watching?.dispose(); this.reading?.dispose(); await this.observation?.dispose();
    await this.queue;
  }
  schedule(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(error => console.error('[wechat]', error.message));
    return next;
  }
  // Only write when the status actually moved: `changed` fires for every list change, so re-pushing an identical status
  // would hand every group a fresh revision each time.
  async write(id, status) {
    const record = this.records.get(id);
    if (JSON.stringify(record.status) === JSON.stringify(status)) return;
    this.records.set(id, await this.coda.protocols.setStatus(SESSION, id, status, record.revision));
  }
  async sync() {
    let accounts;
    try { accounts = await this.bridge.accounts(); } catch (error) {
      for (const [id, record] of this.records) await this.write(id, { ...record.status, state: 'unreachable', reason: error.message });
      return;
    }
    const listed = new Set();
    for (const account of accounts) for (const group of account.groups) {
      const id = recordId(account.id, group.id), held = this.records.get(id);
      const spec = { title: group.name, container: { id: account.id, title: account.name } };
      const status = {
        participants: group.members.map(member => member.id === account.id
          ? { id: member.id, name: member.name, kind: 'person', self: true } : { id: member.id, name: member.name, kind: 'person' }),
        ...(group.last === null ? {} : { head: cursor(group.last) }), state: 'active',
      };
      listed.add(id);
      if (!held) {
        this.records.set(id, await this.coda.protocols.put({ kind: SESSION, id, spec, status }));
        await this.coda.protocols.publish(SESSION, id);
        continue;
      }
      if (JSON.stringify(held.spec) !== JSON.stringify(spec)) this.records.set(id, await this.coda.protocols.update(SESSION, id, spec, held.revision));
      await this.write(id, status);
    }
    for (const id of this.records.keys()) if (!listed.has(id)) {
      await this.coda.protocols.delete(SESSION, id); this.records.delete(id);
    }
  }
  async advance(id, seq) {
    const record = this.records.get(id);
    if (!record) return this.sync();
    await this.write(id, { ...record.status, head: cursor(seq) });
  }
  // One more than asked shows whether there are more: past the page going forward, before it otherwise.
  async read(record, { after, before, limit = LIMIT }) {
    const account = record.spec.container.id, group = record.id.slice(account.length + 1);
    const found = await this.bridge.messages(account, group, { after: position(after), before: position(before), limit: limit + 1 });
    const more = found.length > limit, page = !more ? found : after === undefined ? found.slice(1) : found.slice(0, limit);
    const messages = page.map(({ seq, ...message }) => ({ ...message, cursor: cursor(seq) }));
    return { messages, cursor: messages.at(-1)?.cursor ?? after ?? null, more };
  }
}
