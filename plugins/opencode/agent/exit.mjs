// How `opencode acp` ended, as the plugin's log and the turns it leaves waiting say it: its exit code or the signal that killed it,
// and the last lines it wrote to stderr. Only an end that is not a clean exit is told.
export function describeExit({ code, signal, stderr }) {
  const tail = stderr.trim().split('\n').slice(-5).join('\n').slice(-1000);
  return `OpenCode 进程意外退出（${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}）${tail ? `，stderr 末尾：\n${tail}` : ''}`;
}

// The error that ends a prompt as the process ends (docs/agent-protocol.md「原生会话已结束」): the category tells Coda the native
// session is over, not that the service failed. `input` is written only when known: `accepted` once the prompt's turn has had any output.
export const endedError = (message, accepted) => ({ code: -32603, message,
  data: { _meta: { coda: { failure: { kind: 'session_ended', ...(accepted ? { input: 'accepted' } : {}) } } } } });
