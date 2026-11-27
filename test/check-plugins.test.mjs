// 静态校验入口：缺 contributes 的清单、成了普通文件的 .coda/workflows 判失败，合法的最小插件通过。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginProblems } from '../scripts/check-plugins.mjs';
import { pluginDir } from './plugins/plugin.mjs';

const manifest = { name: '@coda-console/demo', id: 'demo', displayName: 'Demo', description: 'demo', version: '0.1.0', contributes: { protocolImplementations: ['coda/group@1'] } };

function plugin(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-plugins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); }
  return dir;
}

test('a valid minimal plugin passes', async t => {
  const dir = plugin(t, { 'package.json': JSON.stringify(manifest) });
  assert.deepEqual(await pluginProblems(dir, 'demo'), []);
});

test('a manifest without contributes fails', async t => {
  const { contributes, ...rest } = manifest;
  for (const body of [rest, { ...rest, contributes: {} }]) {
    const dir = plugin(t, { 'package.json': JSON.stringify(body) });
    assert.match((await pluginProblems(dir, 'demo'))[0], /contributes/);
  }
});

test('.coda/workflows being a regular file fails', async t => {
  const dir = plugin(t, { 'package.json': JSON.stringify(manifest), '.coda/workflows': 'x' });
  const problems = await pluginProblems(dir, 'demo');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\.coda\/workflows/);
});

test('every Agent plugin declares the API Level 21 modes with mutually exclusive tiers', async () => {
  const ids = ['antigravity', 'claude', 'codex', 'cursor', 'grok', 'kimi', 'opencode'];
  for (const id of ids) {
    const dir = pluginDir(id);
    assert.deepEqual(await pluginProblems(dir, id), []);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.engines.coda >= 21, true, id);
    const modes = manifest.contributes.agents[0].modes, { manual, auto, full, safe, default: fallback } = modes;
    for (const key of ['manual', 'auto', 'full']) assert.ok(key in modes && (modes[key] === null || typeof modes[key] === 'string'), `${id}.${key}`);
    const tiers = [manual, auto, full].filter(Boolean);
    assert.equal(new Set([...tiers, ...safe]).size, tiers.length + safe.length, `${id} tiers overlap`);
    assert.ok(fallback === null || ['manual', 'auto', 'full'].includes(fallback), id);
  }
});
