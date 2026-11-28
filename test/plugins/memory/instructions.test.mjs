import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from '../../../plugins/memory/lib/settings.mjs';
import { formatInstructions, settingsFromEnv } from '../../../plugins/memory/scripts/instructions.mjs';

const PLUGIN = fileURLToPath(new URL('../../../plugins/memory/', import.meta.url));
const SCRIPT = join(PLUGIN, 'scripts/instructions.mjs');
const ON = { 'memory.enabled': true };
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
// 子进程的环境显式给定：不继承父进程的 CODA_PLUGIN_SETTINGS，settings 为 undefined 就是没设置。
const run = (settings, stateDir) => {
  const { CODA_PLUGIN_SETTINGS: _settings, CODA_PLUGIN_STATE: _state, ...env } = process.env;
  if (settings !== undefined) env.CODA_PLUGIN_SETTINGS = settings;
  if (stateDir !== undefined) env.CODA_PLUGIN_STATE = stateDir;
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
};

test('默认设置：卡片目录是 .memory/items/，提到省略 target、先查与 refs、Skill 名', () => {
  const text = formatInstructions(readSettings(ON));
  assert.match(text, /\.memory\/items\//);
  assert.match(text, /memory_engine_\*/);
  assert.match(text, /省略 target/);
  assert.match(text, /refs/);
  assert.match(text, /research-memory/);
  assert.ok(text.split('\n').length >= 3 && text.split('\n').length <= 5);
});

test('自定义 memoryDir 与关闭自动同步', () => {
  const text = formatInstructions(readSettings({ ...ON, 'memory.memoryDir': 'notes/memory/', 'memory.autoSync': false }));
  assert.match(text, /notes\/memory\/items\//);
  assert.doesNotMatch(text, /\.memory/);
  assert.match(text, /定时同步（目录设置 memory\.autoSync）已关闭，读取前的惰性同步（本机插件设置 memory\.autoSync）已关闭/);
  assert.match(text, /合并后同步由合并卡的挂点控制/);
  // 两层各报各的：目录层管定时同步，本机插件层管读前惰性同步。
  assert.match(formatInstructions(readSettings({ ...ON, 'memory.autoSync': true }), { lazySync: false }), /定时同步（[^）]*）已开启，读取前的惰性同步（[^）]*）已关闭/);
  assert.match(formatInstructions(readSettings(ON), { lazySync: true }), /定时同步（[^）]*）已关闭，读取前的惰性同步（[^）]*）已开启/);
});

test('非法 memoryDir：提示配置错误，不公布会被工具拒绝的路径', () => {
  for (const dir of ['/', '/abs/dir', '../outside', '..', '.', 'a\\b']) {
    const text = formatInstructions(readSettings({ ...ON, 'memory.memoryDir': dir }));
    assert.match(text, /记忆目录设置有误/, dir);
    assert.doesNotMatch(text, /items\//, dir);
  }
});

test('默认没启用研究记忆：不输出任何开场指令，脚本输出为空并以 0 退出', () => {
  for (const settings of [readSettings(), readSettings({ 'memory.enabled': false }), readSettings({ 'memory.enabled': 'true' })]) assert.equal(formatInstructions(settings), '');
  for (const raw of [undefined, '{}', '{"memory.enabled":false}', '{坏的']) {
    const child = run(raw);
    assert.equal(child.status, 0, String(raw));
    assert.equal(child.stdout, '', String(raw));
  }
});

test('settingsFromEnv：非法 JSON 与非对象回退默认', () => {
  for (const raw of ['{坏的', 'null', '[1]', '"x"', '']) assert.deepEqual(settingsFromEnv(raw), readSettings(), String(raw));
  assert.equal(settingsFromEnv('{"memory.memoryDir":"m"}').memoryDir, 'm');
});

test('直接执行脚本：自定义目录、非法设置各自输出并以 0 退出', () => {
  const custom = run('{"memory.enabled":true,"memory.memoryDir":"research/mem"}');
  assert.equal(custom.status, 0);
  assert.match(custom.stdout, /research\/mem\/items\//);
  const invalid = run('{"memory.enabled":true,"memory.memoryDir":"../outside"}');
  assert.equal(invalid.status, 0);
  assert.match(invalid.stdout, /记忆目录设置有误/);
});

test('直接执行脚本：定时同步取目录层 autoSync，读前惰性同步取机器层 machine-settings.json', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'memory-instructions-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, 'machine-settings.json'), JSON.stringify({ memoryDir: 'machine-mem', autoSync: true }));
  assert.match(run('{"memory.enabled":true,"memory.autoSync":false}', stateDir).stdout, /machine-mem\/items\/.*定时同步（[^）]*）已关闭，读取前的惰性同步（[^）]*）已开启/);
  assert.match(run('{"memory.enabled":true,"memory.autoSync":true}', stateDir).stdout, /定时同步（[^）]*）已开启，读取前的惰性同步（[^）]*）已开启/);
  writeFileSync(join(stateDir, 'machine-settings.json'), '{坏的');
  assert.match(run('{"memory.enabled":true,"memory.autoSync":true}', stateDir).stdout, /定时同步（[^）]*）已开启，读取前的惰性同步（[^）]*）已关闭/);
});

test('SKILL.md 的 frontmatter 完整，正文覆盖 6 个工具', () => {
  const text = readFileSync(join(PLUGIN, 'skills/research-memory/SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, '缺少 frontmatter');
  assert.match(match[1], /^name: research-memory$/m);
  assert.match(match[1], /^description: \S.{10,}$/m);
  for (const tool of ['recall', 'search', 'get', 'remember', 'link', 'archive']) assert.ok(text.includes(`memory_engine_${tool}`), tool);
  assert.match(text, /已启用研究记忆的研究仓/);
  assert.match(text, /绝不擅自创建 `\.memory\/` 目录/);
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

test('默认静默：memory.enabled 与 memory.autoSync 默认关，设置项 order 依次排开，定时流程只在 autoSync 开时登记且 enabled 没开就跳过、合并卡默认不勾选', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['memory.enabled'].default, false);
  assert.equal(properties['memory.enabled'].title, '启用研究记忆');
  assert.equal(properties['memory.autoSync'].default, false);
  assert.deepEqual(Object.values(properties).map(property => property.order), [...Object.keys(properties).keys()]);
  const workflows = join(PLUGIN, '.coda/workflows');
  assert.match(readFileSync(join(workflows, 'memory-sync.bpmn'), 'utf8'), /coda:autoRun="=vars\.memory\.autoSync"/);
  assert.match(readFileSync(join(workflows, 'memory-sync.bpmn'), 'utf8'), /name="MEMORY_REQUIRE_ENABLED" value="true"[\s\S]*name="MEMORY_ENABLED" value="=vars\.memory\.enabled"/);
  assert.match(readFileSync(join(workflows, 'memory-sync-merged.bpmn'), 'utf8'), /<coda:join hook="merged"[^>]* default="false"/);
});
