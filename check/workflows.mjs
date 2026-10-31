// The plugin's workflows (and capabilities: workflows too), at the manifest level: each `.coda/workflows/<name>.bpmn` read
// with Coda's dialect of BPMN, as the protocol has it (@coda-console/protocol/workflow) and Coda reads it: not BPMN, a coda:
// attribute or element the dialect does not have, an action it does not have or a parameter the action does not take, is
// a workflow Coda does not take. What each value may be Coda checks as it reads one; this check does not yet (coda#2027).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowProblem } from '@coda-console/protocol/workflow';

export async function checkWorkflows({ plugin }, say) {
  for (const name of plugin.workflows) {
    const problem = await workflowProblem(readFileSync(join(plugin.dir, '.coda/workflows', `${name}.bpmn`), 'utf8'), name);
    if (problem) say.fail('manifest.workflows', problem);
    else say.pass('manifest.workflows', `流程 ${name}：合乎 Coda 的流程方言`);
  }
}
