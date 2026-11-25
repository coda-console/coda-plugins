// 好友插件的模块（Coda 的 docs/plugins.md「插件宿主」）。好友页自己的 Accord 读写在页面里发起（页面用自己的 coda.watch /
// coda.call）；模块管这几样：
// - 业务无关的社交网关 friends/social@1（lib/gateway.mjs）：别的插件经它读好友、发布与撤回记录，全部透传 coda/accord@1；
//   发布策略用 `coda self policy.get|policy.setKind` 读写；
// - 签名网关的持有方（lib/rpc-holder.mjs）：把本机 remote-exec 记录的 exec 授给好友、转发好友签名的调用，
//   授权与操作记录用 `coda self grants.list|grants.grant|grants.revoke|ledger.list` 读写。持有方出错不影响社交网关。
// - 签名网关的调用方（lib/rpc-caller.mjs）：把好友授给本机的记录登记成代理记录，接住对它的 exec 转给好友签名执行。调用方出错不影响社交网关与持有方。
//   好友授给本机的代理记录用 `coda self proxies.list` 读；授予时可选的本机 remote-exec 记录用 `coda self grants.targets` 读。
// 持有方、调用方的这几样（shared）好友页也经视图消息调用。
import { createGateway } from './lib/gateway.mjs';
import { createCaller } from './lib/rpc-caller.mjs';
import { createHolder } from './lib/rpc-holder.mjs';
import { createRpcStore } from './lib/rpc-store.mjs';

const HOLDER_ACTIONS = ['grants.list', 'grants.grant', 'grants.revoke', 'ledger.list'];
const TARGET_KIND = 'remote-exec/machine@1';
let gateway = null, holder = null, caller = null, callerStart = null, callerDown = null;
const handles = [];

export async function activate(coda) {
  const dir = coda.plugin.state;
  // 好友页的「共享」一节用的：持有方的四个操作、调用方的代理记录、本机可授出的 remote-exec 记录。
  const shared = {
    ...Object.fromEntries(HOLDER_ACTIONS.map(name => [name, input => {
      if (!holder) throw new Error('这台机器没有插件状态目录，好友授权存不下');
      return holder.self[name](input);
    }])),
    'proxies.list': async input => {
      if (!caller) throw new Error('这台机器没有插件状态目录，好友授给本机的授权读不出来');
      await callerStart;
      if (callerDown) throw new Error(callerDown);
      return caller.list(input);
    },
    'grants.targets': async () => (await coda.list(TARGET_KIND, { scope: 'local' })).filter(entry => entry.local === true && entry.plugin === 'remote-exec')
      .map(entry => ({ id: entry.id, name: entry.spec?.name ?? entry.id, os: entry.spec?.os ?? '', user: entry.spec?.user ?? '', available: entry.status?.available === true })),
  };
  coda.views.register('friends', {
    open(view) {
      view.onMessage(async message => {
        const name = message?.type;
        if (!Object.hasOwn(shared, name) || typeof message.rid !== 'string') return;
        try { view.postMessage({ type: 'reply', rid: message.rid, ok: true, value: await shared[name](message) }); }
        catch (e) { view.postMessage({ type: 'reply', rid: message.rid, ok: false, error: String(e?.message ?? e), effects: e?.effects }); }
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
      caller = createCaller(coda, rpc);
      callerStart = caller.start().catch(async e => {
        // 只有协议确实不在（读它的记录报 not_found）才说没装；别的启动失败按实际原因报。
        const absent = await coda.list(TARGET_KIND, { scope: 'local' }).then(() => false, error => error?.code === 'not_found');
        callerDown = absent ? '不可用：这台没装远程执行插件，好友授给本机的远程执行用不了' : `好友授给本机的远程执行没能启动：${e?.message ?? e}`;
      });
    } catch { caller = null; }
  }
  for (const [name, fn] of Object.entries(shared)) handles.push(coda.self.handle(name, input => fn(input ?? {})));
}

export function deactivate() {
  caller?.stop();
  caller = null;
  callerStart = callerDown = null;
  holder?.stop();
  holder = null;
  gateway?.stop();
  gateway = null;
  for (const handle of handles.splice(0)) handle?.dispose?.();
}
