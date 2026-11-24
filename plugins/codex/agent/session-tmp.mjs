import { isAbsolute } from 'node:path';

// Coda gives each session's Agent process its own temporary directory (`CODA_SESSION_TMP`, `<state>/session-tmp/<session>`), where
// files the session pulls from other machines land, to be edited in place and pushed back. codex-acp's workspace-write sandbox
// allows only the working directory, `$TMPDIR`, `/tmp` and the ACP additional directories, so the session's own directory joins
// those roots, the same way the additional directories do: in each turn's sandbox policy and in the session config. It is that
// one directory, never `session-tmp/` itself (sessions would write each other's). A read-only or full-access policy is left as it
// is: codex-acp widens only workspace-write policies. Without an absolute `CODA_SESSION_TMP` nothing changes.
export function withSessionTmp(directories, env = process.env) {
  const own = env.CODA_SESSION_TMP;
  return typeof own === 'string' && isAbsolute(own) && !directories.includes(own) ? [...directories, own] : directories;
}

const patches = [
  ['    const configWithWorkspaceRoots = mergeSandboxWorkspaceWriteRoots(mergedConfig, additionalDirectories);',
    '    const configWithWorkspaceRoots = mergeSandboxWorkspaceWriteRoots(mergedConfig, withSessionTmp(additionalDirectories));'],
  ['      sandboxPolicy: addAdditionalDirectoriesToSandboxPolicy(agentMode.sandboxPolicy, additionalDirectories),',
    '      sandboxPolicy: addAdditionalDirectoriesToSandboxPolicy(agentMode.sandboxPolicy, withSessionTmp(additionalDirectories)),'],
];
export function writableCodexSessionTmp(source) {
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp session temporary directory patch no longer matches the locked adapter');
    source = source.replace(before, after);
  }
  return `import { withSessionTmp } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
