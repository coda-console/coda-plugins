// Every command a session's agent runs inherits which session it belongs to, so that a tool such as `coda-run` knows who
// is asking without being told (docs/workflows.md「从命令行调用」); a process Coda runs for no session is started without it.
export const THREAD_ENV = 'CODA_THREAD_ID';
// With it, the token the backend issued to the process doing the session's or the step's work (kernel/records/tokens.mjs):
// what the process brings back beside the session it names. A plugin's process takes its environment through `cleared`
// (components/plugins/plugin-rules.mjs), which leaves out both.
export const TOKEN_ENV = 'CODA_TOKEN';
