// codex-acp 1.12.0 outlives its Codex app-server. When that child exits on its own, the adapter only
// fails background tasks: a started turn keeps waiting for a completion that never comes, and every
// later request fails against the dead child. Follow the child out instead, so the session host reports
// an agent exit. A deliberate provider restart moves the generation first, and stays unaffected. How the child exited (code or
// signal, and the end of its stderr) is told to the entry first, which logs it and answers the turns still waiting with it, so
// the backend settles them with that error. Fails loudly once the adapter changes.
const before = `.once("exit", () => {
      if (generation !== this.codexProcessGeneration) return;
      void this.finishAllAsyncTasks("failed", "after the Codex process exited");`;
// Exit only after stdout has flushed the failed background tasks.
const after = `.once("exit", (code, signal) => {
      if (generation !== this.codexProcessGeneration) return;
      codaProcessExit.exited({ code, signal, stderr: this.getRecentStderr() });
      void this.finishAllAsyncTasks("failed", "after the Codex process exited").finally(() => {
        logger.log("Codex process exited; ending the adapter with it");
        process.stdout.write("", () => process.exit(1));
      });`;
export function followCodexProcessExit(source) {
  if (source.split(before).length !== 2) throw new Error('codex-acp process exit patch no longer matches the locked adapter');
  return `import * as codaProcessExit from ${JSON.stringify(import.meta.url)};\n${source.replace(before, after)}`;
}

let heard = () => {};
export const listenExit = listener => { heard = listener; };
export const exited = exit => heard(exit);
// What Coda's turn error and the log say of it: how the Codex process ended, and the last lines it wrote to stderr.
export function describeExit({ code, signal, stderr }) {
  const tail = stderr.trim().split('\n').slice(-5).join('\n').slice(-1000);
  return `Codex 进程意外退出（${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}）${tail ? `，stderr 末尾：\n${tail}` : ''}`;
}
