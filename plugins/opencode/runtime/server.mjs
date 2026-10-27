// Native OpenCode 2 plugin, loaded only through this ACP process's inline config. Public plugin API, checked with 2.1.4.
// ACP omits shell events. Subscribe before exposing the tool hook; acknowledge registration before the shell tool can
// return to ACP, so a fast prompt response cannot make Coda retire an apparently idle process.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const events = new Set(['shell.created', 'shell.exited', 'session.created', 'session.inbox.enqueued',
  'session.inbox.delivered', 'session.inbox.cancelled', 'session.execution.started', 'session.execution.succeeded',
  'session.execution.failed', 'session.execution.interrupted']);

export default {
  id: 'coda.background-shells',
  async setup(ctx) {
    if (typeof ctx.options.socket !== 'string') throw new Error('Coda shell event socket is missing');
    const socket = createConnection(ctx.options.socket), pending = new Map(), abort = new AbortController();
    let sequence = 0;
    const created = new Set(), awaitingCreation = new Map(), sessions = new Set();
    const send = message => socket.write(`${JSON.stringify(message)}\n`);
    socket.on('error', () => {});
    socket.on('close', () => {
      abort.abort();
      for (const resolve of pending.values()) resolve(false);
      for (const resolve of awaitingCreation.values()) resolve();
      pending.clear(); awaitingCreation.clear();
    });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const lines = createInterface({ input: socket });
    lines.on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m?.type === 'interrupt-handling' && sessions.has(m.sessionId)) {
        void ctx.session.interrupt({ sessionID: m.sessionId }).catch(() => {
          console.error('[coda.background-shells] 无法停止 OpenCode 的结果处理');
        });
        return;
      }
      const resolve = pending.get(m?.id);
      if (resolve) { pending.delete(m.id); resolve(m.accepted === true); }
    });
    // Invoking next() starts the native subscription now, before setup completes and any session can execute a shell.
    const iterator = ctx.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]();
    const first = iterator.next();
    const pump = (async () => {
      for (let next = await first; !next.done; next = await iterator.next()) {
        const event = next.value;
        if (!events.has(event.type)) continue;
        // A shell belongs to its original Location. Its session may move before the completion notification, so
        // session lifecycle events remain visible from every observer; the adapter matches them to their shell owner.
        if (event.type.startsWith('shell.') && event.location && (event.location.directory !== ctx.location.directory
          || event.location.workspaceID !== ctx.location.workspaceID)) continue;
        // Only lifecycle/identity crosses the socket. Synthetic text and prompts may contain private material and are
        // unnecessary: the notifier's structured source/shellID is sufficient to associate delivery with the wait.
        let data = event.data;
        if (event.type === 'session.inbox.enqueued') {
          const meta = data.item.type === 'synthetic' ? data.item.payload?.metadata : null;
          if (meta?.source !== 'shell') continue;
          data = { sessionID: data.sessionID, inboxID: data.inboxID,
            item: { type: 'synthetic', payload: { metadata: { source: 'shell', shellID: meta.shellID } } } };
        } else if (event.type === 'session.created') {
          data = { sessionID: data.sessionID, parentID: data.parentID, title: data.title };
        }
        send({ type: 'event', event: { type: event.type, data } });
        if (event.type === 'shell.created') {
          created.add(data.info.id);
          if (created.size > 512) created.delete(created.values().next().value);
          awaitingCreation.get(data.info.id)?.();
        }
      }
    })().catch(() => { socket.destroy(); });
    const hook = await ctx.tool.hook('execute.after', async event => {
      const meta = event.status === 'completed' ? event.result?.metadata : null;
      if (!['shell', 'bash'].includes(event.tool) || meta?.status !== 'running' || typeof meta.shellID !== 'string') return;
      sessions.add(event.sessionID);
      if (socket.destroyed) return;
      // The after hook can run before the event subscriber consumes shell.created. Keep the wire in native order.
      if (!created.has(meta.shellID)) await new Promise(resolve => {
        const timer = setTimeout(() => { awaitingCreation.delete(meta.shellID); socket.destroy(); resolve(); }, 5000);
        awaitingCreation.set(meta.shellID, () => { clearTimeout(timer); awaitingCreation.delete(meta.shellID); resolve(); });
      });
      if (socket.destroyed) return;
      const id = sequence++;
      let timer;
      const accepted = await new Promise(resolve => {
        pending.set(id, accepted => { clearTimeout(timer); resolve(accepted); });
        // Never wedge the tool if the adapter is gone. Coda marks already registered waits as unconfirmed on disconnect.
        timer = setTimeout(() => { pending.delete(id); socket.destroy(); resolve(false); }, 5000);
        send({ type: 'background', id, shellId: meta.shellID, sessionId: event.sessionID, toolCallId: event.id });
      });
      if (!accepted) console.error('[coda.background-shells] 无法登记后台命令，Coda 不能跟踪其结果');
    });
    const instructions = await ctx.session.hook('context', event => {
      if (event.tools.shell) event.tools.shell.description += ' For a finite background job, use background=true and keep the actual command in the foreground inside that shell. Do not add nohup, disown, or &; the completion notification tracks the shell, not detached descendants.';
    });
    return async () => { await hook.dispose(); await instructions.dispose(); abort.abort(); socket.destroy(); lines.close(); await pump; };
  },
};
