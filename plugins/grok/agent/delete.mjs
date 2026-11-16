// `grok sessions delete <id>`, which is how Grok's history loses a session: ACP has no session/delete for it. It exits 0
// whether or not the session existed, so what it prints says which. Resolves null when it reports `Deleted session`, else
// the JSON-RPC error to answer with: -32002 for `No session found`, -32603 for anything else. Checked on 1.0.77: a session still open in an agent is deleted for good, and closing it
// or ending that agent afterwards writes nothing back.
import { spawn } from 'node:child_process';

const firstLine = text => text.split('\n').map(line => line.trim()).find(Boolean);

export function deleteSession(binary, sessionId, timeoutMs = 15000) {
  return new Promise(resolve => {
    // `--` keeps an id that starts with a dash from being read as an option.
    const child = spawn(binary, ['sessions', 'delete', '--', sessionId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); resolve(error); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: -32603, message: '删除 Grok 会话超时' }); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.on('error', error => finish({ code: -32603, message: `无法运行 Grok CLI：${error.message}` }));
    child.on('close', (code, signal) => {
      if (code !== 0) return finish({ code: -32603, message: firstLine(stderr) ?? (code === null ? `grok sessions delete 被信号 ${signal} 结束` : `grok sessions delete 退出码 ${code}`) });
      if (/^Deleted session /m.test(stdout)) return finish(null);
      const missing = stdout.split('\n').find(line => line.startsWith('No session found with id'));
      finish(missing ? { code: -32002, message: missing.trim() }
        : { code: -32603, message: `grok sessions delete 没有确认删除：${firstLine(stdout) ?? '没有输出'}` });
    });
  });
}
