// The components' contribution points (components/plugins/contribution-points.mjs), defined as this module loads: what
// puts Coda together (application/service.mjs, the tests, the plugin contract) imports it once, before any plugin is read.
// In this order what only one plugin may declare is said (plugin-source-rules.mjs claims): sessions', workflows', Git's,
// the composer's.
import '../components/session-config/contributions.mjs';
import '../components/workflows/contributions.mjs';
import '../components/plugins/model-contributions.mjs';
import '../components/plugins/git-contributions.mjs';
import '../components/composers/contributions.mjs';
