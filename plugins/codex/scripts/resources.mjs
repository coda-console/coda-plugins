// An account source owns the「Codex」resources. Without one, show Codex's own login as before.
import { withAppServer } from './app-server.mjs';
import { resources } from './quota.mjs';
import { accountSource } from '../agent/account-source.mjs';

try { console.log(JSON.stringify(accountSource() ? { resources: [] } : await withAppServer(resources))); }
catch (error) { console.error(error.message); process.exit(1); }
