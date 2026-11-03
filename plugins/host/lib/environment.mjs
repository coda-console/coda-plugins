import { join } from 'node:path';

// Build from bounded protocol context and executor-owned paths, never a sender's environment snapshot.
export function executionEnvironment({ runtime, declared = {}, workflow, workspace, directory, devices, metered, files }) {
  if (Object.keys(declared).some(key => /^(CODA_|HOST_SIM_|GITHUB_OUTPUT$|GITHUB_STEP_SUMMARY$|RUNNER_)/.test(key))) {
    throw new Error('声明变量不能覆盖执行器变量');
  }
  return { PATH: runtime.PATH, HOME: runtime.HOME, TMPDIR: runtime.TMPDIR, ...declared, CI: 'true',
    ...(metered ? { HOST_SIM_LEASE: 'coda-run:build' } : {}), HOST_SIM_DEVICES: devices,
    ...(workflow ? { GITHUB_WORKFLOW: workflow.name, GITHUB_JOB: workflow.job, GITHUB_RUN_ID: workflow.runId,
      GITHUB_RUN_ATTEMPT: String(workflow.runAttempt), GITHUB_SHA: workflow.sha, GITHUB_REF: workflow.ref,
      GITHUB_REPOSITORY: workflow.repository } : {}),
    GITHUB_WORKSPACE: workspace, RUNNER_TEMP: join(directory, 'tmp'),
    GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary };
}
