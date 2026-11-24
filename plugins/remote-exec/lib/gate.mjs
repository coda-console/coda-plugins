// 每个操作执行前的两道关：先看开关，再过判定点，然后才执行。拒绝都是没做过任何事（effects: 'none'）。

// 判定点：所有操作（exec、pull、push）执行前都经它。第一版恒放行；以后收紧只改这一处。
//   operation：'exec' | 'pull' | 'push'
//   content：操作内容，exec 是 { command, cwd, timeout }，pull 是 { path, offset, length }，push 是 { path }
//   caller：`ctx.caller` 原样；record：`ctx.record`
// 放行回 { allow: true }，拒绝回 { allow: false, code, reason }。
export function decide({ operation, content, caller, record }) {
  return { allow: true };
}

// 开关关着时拒绝（`disabled`），否则过判定点，不放行的以判定点给的错误码拒绝；放行就返回。`judge` 供测试替换判定点。
export function admit(coda, { enabled, ...request }, judge = decide) {
  if (!enabled) throw coda.error('disabled', '这台机器没有打开远程执行：在它的插件设置里打开「允许本空间的机器在这台上执行」', { effects: 'none' });
  const verdict = judge(request);
  if (!verdict.allow) throw coda.error(verdict.code, verdict.reason, { effects: 'none' });
}
