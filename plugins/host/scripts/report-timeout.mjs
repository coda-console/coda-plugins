import { appendFileSync } from 'node:fs';
import { keychainPromptSuffix } from '../lib/keychain-prompt.mjs';

const reason = `执行超过总时限${keychainPromptSuffix()}`;
appendFileSync(process.env.GITHUB_OUTPUT, `failure_reason=${reason}\n`);
process.stderr.write(`失败：${reason}\n`);
process.exitCode = 1;
