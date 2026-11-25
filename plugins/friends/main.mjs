// 好友插件的模块（Coda 的 docs/plugins.md「插件宿主」）。好友页自己的 Accord 读写在页面里发起（页面用自己的 coda.watch /
// coda.call）；模块只管业务无关的社交网关 friends/social@1（lib/gateway.mjs）：别的插件经它读好友、发布与撤回记录，
// 全部透传 coda/accord@1；发布策略用 `coda self policy.get|policy.setKind` 读写。
import { createGateway } from './lib/gateway.mjs';

let gateway = null;
const handles = [];

export async function activate(coda) {
  gateway = createGateway(coda, coda.plugin.state);
  for (const [name, fn] of Object.entries(gateway.policy)) handles.push(coda.self.handle(name, input => fn(input ?? {})));
  await gateway.start();
}

export function deactivate() {
  gateway?.stop();
  gateway = null;
  for (const handle of handles.splice(0)) handle?.dispose?.();
}
