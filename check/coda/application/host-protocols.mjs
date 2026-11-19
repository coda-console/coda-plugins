// Coda's own protocols (docs/plugins.md「用到的权限」), each as its component defines it: data that nothing running changes,
// listed once. The service registers them from here, each bound by its kind to what serves it (components/protocols/protocols.mjs
// `bind`: application/assembly.mjs; a composer's and a group's own component binds that one), none left unbound once it is
// put together (server.mjs `checkBound`); and the plugins are judged against them from the first reading of the catalog on, before any is
// registered (components/plugins/plugins.mjs `protocols`). The plugin host for a plugin's tests takes Coda's events from here
// too (adapters/plugin-test-host.mjs), so nothing this imports runs. The protocol package's core protocols are not among them
// (CORE_PROTOCOLS).
import { PLUGIN_PROTOCOL } from '../kernel/plugin-protocol.mjs';
import { PROJECT_PROTOCOL } from '../kernel/project-protocol.mjs';
import { USAGE_PROTOCOL } from '../kernel/usage-protocol.mjs';
import { ACCORD_PROTOCOL } from '../kernel/accord-protocol.mjs';
import { THREAD_PROTOCOL } from '../kernel/thread-protocol.mjs';
import { composerType, submissionType } from '../components/composers/schemas.mjs';
import { groupType } from '../components/concurrency-groups/schemas.mjs';
import { WORKFLOW_PROTOCOL, WORKFLOW_RUN_PROTOCOL, withWorkflows } from '../components/workflows/workflow-protocol-definitions.mjs';

// A session's, with the workflows' query and the group that has it (workflow-protocol-definitions.mjs `withWorkflows`).
export const THREAD_DEFINITION = withWorkflows(THREAD_PROTOCOL);
export const HOST_PROTOCOLS = [THREAD_DEFINITION, PROJECT_PROTOCOL, PLUGIN_PROTOCOL, USAGE_PROTOCOL, ACCORD_PROTOCOL, WORKFLOW_PROTOCOL, WORKFLOW_RUN_PROTOCOL, composerType, submissionType, groupType];
