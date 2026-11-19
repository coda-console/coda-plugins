// Which Kimi CLI runs: the one its installer puts in ~/.kimi-code/bin, else the first `kimi` on the PATH; the same the
// 「Kimi」resource type signs in and reads the quota with (scripts/).
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A file that can be run: a leftover that cannot is not the CLI, and does not hide the one further on the PATH.
const runnable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
export function kimiBinary(env = process.env) {
  const installed = join(homedir(), '.kimi-code/bin/kimi');
  if (runnable(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'kimi')).find(runnable) ?? null;
}
