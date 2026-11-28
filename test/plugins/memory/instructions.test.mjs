import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from '../../../plugins/memory/lib/settings.mjs';
import { formatInstructions, settingsFromEnv } from '../../../plugins/memory/scripts/instructions.mjs';

const PLUGIN = fileURLToPath(new URL('../../../plugins/memory/', import.meta.url));
const SCRIPT = join(PLUGIN, 'scripts/instructions.mjs');
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
// 子进程的环境显式给定：不继承父进程的 CODA_PLUGIN_SETTINGS，settings 为 undefined 就是没设置。
const run = settings => {
  const { CODA_PLUGIN_SETTINGS: _inherited, ...env } = process.env;
  if (settings !== undefined) env.CODA_PLUGIN_SETTINGS = settings;
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
};

test('默认设置：卡片目录是 .memory/items/，提到省略 target、先查与 refs、Skill 名', () => {
  const text = formatInstructions(readSettings());
  assert.match(text, /\.memory\/items\//);
  assert.match(text, /memory_engine_\*/);
  assert.match(text, /省略 target/);
  assert.match(text, /refs/);
  assert.match(text, /research-memory/);
  assert.ok(text.split('\n').length >= 3 && text.split('\n').length <= 5);
});

test('自定义 memoryDir 与关闭自动同步', () => {
  const text = formatInstructions(readSettings({ 'memory.memoryDir': 'notes/memory/', 'memory.autoSync': false }));
  assert.match(text, /notes\/memory\/items\//);
  assert.doesNotMatch(text, /\.memory/);
  assert.match(text, /定时同步与读取时的惰性同步已关闭/);
  assert.match(text, /合并后同步由合并卡的挂点控制/);
  assert.match(formatInstructions(readSettings({})), /定时同步与读取时的惰性同步已开启/);
});

test('非法 memoryDir：提示配置错误，不公布会被工具拒绝的路径', () => {
  for (const dir of ['/', '/abs/dir', '../outside', '..', '.', 'a\\b']) {
    const text = formatInstructions(readSettings({ 'memory.memoryDir': dir }));
    assert.match(text, /记忆目录设置有误/, dir);
    assert.doesNotMatch(text, /items\//, dir);
  }
});

test('settingsFromEnv：非法 JSON 与非对象回退默认', () => {
  for (const raw of ['{坏的', 'null', '[1]', '"x"', '']) assert.deepEqual(settingsFromEnv(raw), readSettings(), String(raw));
  assert.equal(settingsFromEnv('{"memory.memoryDir":"m"}').memoryDir, 'm');
});

test('直接执行脚本：自定义目录、非法设置各自输出并以 0 退出', () => {
  const custom = run('{"memory.memoryDir":"research/mem"}');
  assert.equal(custom.status, 0);
  assert.match(custom.stdout, /research\/mem\/items\//);
  const broken = run('{坏的');
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, `${formatInstructions(readSettings())}\n`);
  const unset = run(undefined);
  assert.equal(unset.status, 0);
  assert.match(unset.stdout, /\.memory\/items\//);
  const invalid = run('{"memory.memoryDir":"../outside"}');
  assert.equal(invalid.status, 0);
  assert.match(invalid.stdout, /记忆目录设置有误/);
});

test('SKILL.md 的 frontmatter 完整，正文覆盖 6 个工具', () => {
  const text = readFileSync(join(PLUGIN, 'skills/research-memory/SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, '缺少 frontmatter');
  assert.match(match[1], /^name: research-memory$/m);
  assert.match(match[1], /^description: \S.{10,}$/m);
  for (const tool of ['recall', 'search', 'get', 'remember', 'link', 'archive']) assert.ok(text.includes(`memory_engine_${tool}`), tool);
  for (const word of ['appendToId', 'supersedes', 'contradicts', 'contested', '不要在新卡上写 `supersedes`', 'remove: true']) assert.ok(text.includes(word), word);
});

test('package.json 的 skills、instructions、files 指向真实存在的文件', () => {
  const { skills, instructions } = manifest.contributes;
  assert.deepEqual(skills, ['skills/research-memory']);
  for (const skill of skills) assert.ok(existsSync(join(PLUGIN, skill, 'SKILL.md')), skill);
  assert.equal(instructions.command, '"$CODA_NODE" "$CODA_PLUGIN_PATH/scripts/instructions.mjs"');
  assert.ok(existsSync(SCRIPT));
  assert.deepEqual(manifest.files, ['main.mjs', 'lib', 'scripts', 'skills', '.coda', 'README.md']);
  for (const file of manifest.files) assert.ok(existsSync(join(PLUGIN, file)), file);
  assert.equal(manifest.version, '0.1.0');
});
