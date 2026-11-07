// Which Kimi CLI runs: the one its installer puts in ~/.kimi-code/bin, else the first `kimi` on the PATH; the same the
// 「Kimi」resource type signs in and reads the quota with (scripts/).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function kimiBinary(env = process.env) {
  const installed = join(homedir(), '.kimi-code/bin/kimi');
  if (existsSync(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'kimi')).find(path => existsSync(path)) ?? null;
}
