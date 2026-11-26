// 好友对话：与已绑定个人身份的好友收发 coda/accord@1 签名的消息，实现 coda/session@1（见 lib/service.mjs）。
import { startService } from './lib/service.mjs';

let service = null;

export async function activate(coda) {
  service = await startService(coda);
}

export async function deactivate() {
  await service?.stop();
  service = null;
}
