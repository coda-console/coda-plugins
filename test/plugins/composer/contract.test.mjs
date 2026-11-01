import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../../../check/index.mjs';
import { OFF } from '../../../plugins/composer/ultra.mjs';

test('composer 清单通过 plugin-check（依赖 Coda 第 2 步经 sync-plugin-check 同步）', async () => {
  const { report } = await checkPlugin(fileURLToPath(new URL('../../../plugins/composer', import.meta.url)), { manifestOnly: true });
  assert.deepEqual(report.failures, []);
});

test('真实清单被识别为启动激活：恢复已有 Ultra 后直接退出，不需新发送', async () => {
  const dir = new URL('../../../plugins/composer/', import.meta.url);
  const { report, plugin: checked } = await checkPlugin(fileURLToPath(dir), { manifestOnly: true });
  assert.deepEqual(report.failures, []);
  const plugin = checked.plugin;
  assert.equal(plugin.startup, true, 'Coda 读取清单后须将此插件列入启动加载名单');
  const restored = { kind: 'composers', id: 'restored', revision: 5,
    spec: { thread: 'restored', modes: [{ mode: 'composer/ultra', values: {} }] },
    status: { modes: [{ mode: 'composer/ultra', sent: 3, changedSinceSent: false, presets: {} }] } };
  let changed;
  const told = [];
  // 使用契约读取器产出的 startup 和 main 加载真实入口；只替代宿主 watch/tell 传输。
  // 不开视图、不调用任何 submissions handler，初始 ADDED 代表宿主重新 list 后交回的对象。
  if (plugin.startup) await (await import(new URL(plugin.main, dir))).activate({
    protocols: { register() {} },
    watch: async (kind, handler) => {
      assert.equal(kind, 'composers');
      changed = handler;
      await handler({ type: 'ADDED', id: restored.id, object: restored });
      return { dispose() {} };
    },
    tell: async (thread, text) => { told.push([thread, text]); },
  });
  assert.deepEqual(told, [], '恢复仍开启的输入框不能误发关闭');
  await changed({ type: 'MODIFIED', id: restored.id, object: { ...restored, revision: 6,
    spec: { thread: restored.id, modes: [] }, status: { modes: [] } } });
  assert.deepEqual(told, [['restored', OFF]]);
});
