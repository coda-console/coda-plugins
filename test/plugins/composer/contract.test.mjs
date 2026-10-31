import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../../../check/index.mjs';

test('composer 清单通过 plugin-check（依赖 Coda 第 2 步经 sync-plugin-check 同步）', async () => {
  const { report } = await checkPlugin(fileURLToPath(new URL('../../../plugins/composer', import.meta.url)), { manifestOnly: true });
  assert.deepEqual(report.failures, []);
});
