// 好友插件的模块（Coda 的 docs/plugins.md「插件宿主」）。好友页自己的 Accord 读写在页面里发起（页面用自己的 coda.query /
// coda.call / coda.watch）；模块管两件事：
// - 好友的本地备注：存在插件自己的持久目录 notes.json 里，不外发，页面通过视图消息读写，
//   也能用 `coda self notes.list|notes.set|notes.delete` 读写；
// - 业务无关的社交网关 friends/social@1（lib/gateway.mjs）：别的插件经它读好友、发布与撤回记录，全部透传 coda/accord@1；
//   发布策略用 `coda self policy.get|policy.setKind` 读写；
// - 签名网关的持有方（lib/rpc-holder.mjs）：把本机 remote-exec 记录的 exec 授给好友、转发好友签名的调用，
//   授权与操作记录用 `coda self grants.list|grants.grant|grants.revoke|ledger.list` 读写。持有方出错不影响社交网关。
// - 签名网关的调用方（lib/rpc-caller.mjs）：把好友授给本机的记录登记成代理记录，接住对它的 exec 转给好友签名执行。调用方出错不影响社交网关与持有方。
import { createGateway } from './lib/gateway.mjs';
import { deleteNote, readNotes, setNote } from './lib/notes.mjs';
import { createCaller } from './lib/rpc-caller.mjs';
import { createHolder } from './lib/rpc-holder.mjs';
import { createRpcStore } from './lib/rpc-store.mjs';

const HOLDER_ACTIONS = ['grants.list', 'grants.grant', 'grants.revoke', 'ledger.list'];
let dir = null, gateway = null, holder = null, caller = null;
const handles = [];

export async function activate(coda) {
  dir = coda.plugin.state;
  const actions = {
    'notes.list': () => readNotes(dir),
    'notes.set': ({ node, note } = {}) => setNote(dir, node, note),
    'notes.delete': ({ node } = {}) => deleteNote(dir, node),
  };
  const run = (name, input) => {
    if (!dir) throw new Error('这台机器没有插件状态目录，备注存不下');
    return actions[name](input);
  };
  for (const name of Object.keys(actions)) handles.push(coda.self.handle(name, input => run(name, input ?? {})));
  coda.views.register('friends', {
    open(view) {
      view.onMessage(async message => {
        const name = message?.type;
        if (!Object.hasOwn(actions, name) || typeof message.rid !== 'string') return;
        try { view.postMessage({ type: 'reply', rid: message.rid, ok: true, value: await run(name, message) }); }
        catch (e) { view.postMessage({ type: 'reply', rid: message.rid, ok: false, error: String(e?.message ?? e) }); }
      });
    },
  });
  gateway = createGateway(coda, dir);
  for (const [name, fn] of Object.entries(gateway.policy)) handles.push(coda.self.handle(name, input => fn(input ?? {})));
  await gateway.start();
  if (dir) {
    const store = createRpcStore(dir), rpc = { store, signRpc: gateway.signRpc, retractRpc: gateway.retractRpc, onAccord: gateway.onAccord, pages: gateway.pages };
    try {
      holder = createHolder(coda, rpc);
      holder.start().catch(() => {});
    } catch { holder = null; }
    try {
      caller = createCaller(coda, { ...rpc, dir });
      caller.start().catch(() => {});
    } catch { caller = null; }
  }
  for (const name of HOLDER_ACTIONS) handles.push(coda.self.handle(name, input => {
    if (!holder) throw new Error('这台机器没有插件状态目录，好友授权存不下');
    return holder.self[name](input ?? {});
  }));
}

export function deactivate() {
  caller?.stop();
  caller = null;
  holder?.stop();
  holder = null;
  gateway?.stop();
  gateway = null;
  for (const handle of handles.splice(0)) handle?.dispose?.();
  dir = null;
}
