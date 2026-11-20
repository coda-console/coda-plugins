// The plugin's setup (`contributes.setup`), which Coda runs on each machine when the user installs or updates the plugin: it
// ends well once the machine can run the agent (`needed`, install.mjs). Without a Grok CLI that runs, or with one older than
// MINIMUM, it runs Grok's own installer, which puts the latest in ~/.grok/bin, where the agent looks first, and checks again
// (`installChecked`, which is the「Grok」type's install too); a newer one is kept. `sessions delete` was checked on 1.0.77; on
// an older CLI that does not have it, the entry answers session/delete with its error. Why the machine is not ready is said in
// one line on standard error.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installChecked, needed } from './install.mjs';

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const before = needed();
  const ready = before.action === 'none' ? before : installChecked();
  if (ready.action !== 'none') { console.error(`${before.reason}，${ready.reason}`); process.exit(1); }
  console.log(`Grok CLI ${ready.version}`);
}
