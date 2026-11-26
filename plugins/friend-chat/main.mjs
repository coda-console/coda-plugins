// 占位：会话 Provider 的 read、post、draft 在下一块接入，此前都回「尚未实现」。
const SESSION = 'coda/session@1';
const unimplemented = () => { throw Object.assign(new Error('好友对话尚未实现'), { code: 'unavailable', effects: 'none' }); };

export function activate(coda) {
  for (const name of ['read', 'post', 'draft']) coda.handle(SESSION, name, unimplemented);
}
