// The plugin's own Codex CLI, as the sign-in runs it. With「多账号」on (the setting `codex.multipleAccounts`), its login adds to
// or updates the managed accounts instead (login.mjs).
import { multipleAccounts } from './manager.mjs';

if (multipleAccounts() && process.argv[2] === 'login') await import('./login.mjs');
else await import('@openai/codex/bin/codex.js');
