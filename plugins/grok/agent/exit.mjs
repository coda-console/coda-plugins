// How `grok agent` ended, as the plugin's log and the turns it leaves waiting say it: its exit code or the signal that killed it,
// and the last lines it wrote to stderr. Only an end that is not a clean exit is told.
export function describeExit({ code, signal, stderr }) {
  const tail = stderr.trim().split('\n').slice(-5).join('\n').slice(-1000);
  return `Grok 进程意外退出（${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}）${tail ? `，stderr 末尾：\n${tail}` : ''}`;
}
