// What the「Claude」panel shows (docs/plugins.md「内置插件：Claude」): the plan windows this machine's Claude sessions last
// reported (agent/limits.mjs). Nothing reported yet shows nothing; the panel is then offered under「添加资源」 for signing in.
export function panel(limits) {
  if (!limits.known()) return { items: [] };
  const windows = limits.quota();
  // The account the windows are of, compared across machines by Coda's group view.
  return { items: [{ type: 'card', title: 'Claude SDK', ...(limits.account ? { identity: `claude:${limits.account}` } : {}), items: windows.length
    ? windows.map(w => ({ type: 'meter', label: w.label, value: `剩余 ${w.remainingPercent}%`, fraction: w.remainingPercent / 100, time: w.resetsAt, timeLabel: '重置' }))
    // Past its reset a window is not known, neither full nor empty: what was used since is not seen from here.
    : [{ type: 'error', text: '额度记录已过期，会话再运行后更新' }] }] };
}
