// What the「Claude」resource type shows (docs/plugins.md「内置插件：Claude」): the plan windows this machine's Claude sessions
// last reported (agent/limits.mjs), each a value of what is left and when it resets. Nothing reported yet shows nothing;
// the type is then offered under「添加资源」 for signing in.
export function resources(limits) {
  if (!limits.known()) return { resources: [] };
  const windows = limits.quota();
  // The account the windows are of, compared across machines by Coda's group view; its email is not kept, so it has no name.
  const identity = limits.account ? { identity: `claude:${limits.account}` } : {};
  if (!windows.length) return { resources: [{ name: 'Claude', ...identity, error: '额度记录已过期，会话再运行后更新' }] };
  // Past its reset a window is not known, neither full nor empty: what was used since is not seen from here.
  return { resources: [{ ...identity, values: windows.map(w => ({ label: w.label, value: `剩余 ${w.remainingPercent}%`, fraction: w.remainingPercent / 100, time: w.resetsAt })) }] };
}
