import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../check/index.mjs';

const BIN = fileURLToPath(new URL('../bin/check.mjs', import.meta.url));
const top = mkdtempSync(join(tmpdir(), 'coda-plugin-check-init-'));
after(() => rmSync(top, { recursive: true, force: true }));
const init = (...args) => spawnSync(process.execPath, [BIN, 'init', ...args], { encoding: 'utf8' });
const read = (dir, file) => readFileSync(join(top, dir, file), 'utf8');

describe('init', () => {
  test('the module template, by default, is named after the directory and passes the check', async () => {
    const made = init(join(top, 'my-notes'));
    assert.equal(made.status, 0, made.stderr);
    const manifest = JSON.parse(read('my-notes', 'package.json'));
    assert.equal(manifest.name, 'my-notes');
    assert.deepEqual(manifest.contributes.protocols.map(one => one.name), ['my-notes/note@1']);
    assert.deepEqual(manifest.contributes.protocolImplementations, ['my-notes/note@1']);
    assert.deepEqual(manifest.uses, { 'my-notes/note@1': ['watch'] });
    assert.equal(JSON.parse(read('my-notes', 'package-lock.json')).name, 'my-notes');
    assert.equal(JSON.parse(read('my-notes', 'package-lock.json')).packages[''].name, 'my-notes');
    for (const file of ['main.mjs', 'test/main.test.mjs']) assert.doesNotMatch(read('my-notes', file), /(?<![\w-])notes\/note@1/);
    assert.deepEqual(Object.keys(manifest.contributes.protocols[0].events), ['note_my_notes.added']);
    assert.deepEqual(Object.values(manifest.contributes.protocols[0].permissions)[0].events, ['note_my_notes.added']);
    assert.match(read('my-notes', 'main.mjs'), /'my-notes\/note@1'/);
    assert.match(read('my-notes', 'main.mjs'), /'note_my_notes\.added'/);
    assert.match(read('my-notes', 'test/main.test.mjs'), /'note_my_notes\.added'/);
    for (const file of ['package.json', 'main.mjs', 'test/main.test.mjs']) assert.doesNotMatch(read('my-notes', file), /(?<![\w-])notes\.added/);
    assert.match(read('my-notes', 'test/main.test.mjs'), /'my-notes\/note@1'/);
    assert.equal(existsSync(join(top, 'my-notes/node_modules')), false);
    const { report } = await checkPlugin(join(top, 'my-notes'));
    assert.deepEqual(report.failures, []);
    assert.ok(report.items.some(item => item.rule === 'module.registered' && item.status === 'pass'));
  });
  for (const template of ['module', 'agent', 'resource']) test(`--template ${template} makes a plugin that passes the manifest level`, async () => {
    const dir = `from-${template}`;
    const made = init(join(top, dir), '--template', template);
    assert.equal(made.status, 0, made.stderr);
    assert.equal(JSON.parse(read(dir, 'package.json')).name, dir);
    const { report } = await checkPlugin(join(top, dir), { manifestOnly: true });
    assert.deepEqual(report.failures, []);
  });
  test('the resource template is a record command and an act command, named after the directory, and passes the check including its record', async () => {
    const made = init(join(top, 'my-uptime'), '--template', 'resource');
    assert.equal(made.status, 0, made.stderr);
    const manifest = JSON.parse(read('my-uptime', 'package.json'));
    assert.equal(manifest.name, 'my-uptime');
    assert.deepEqual(Object.keys(manifest.contributes).sort(), ['protocolImplementations', 'records']);
    assert.deepEqual(manifest.contributes.records, [{ kind: 'coda/resource@1', command: 'scripts/resource.mjs' }]);
    assert.deepEqual(manifest.contributes.protocolImplementations, [{ kind: 'coda/resource@1', commands: { act: 'scripts/act.mjs' } }]);
    for (const file of ['scripts/resource.mjs', 'scripts/act.mjs']) assert.notEqual(statSync(join(top, 'my-uptime', file)).mode & 0o111, 0, `${file} is executable`);
    assert.equal(existsSync(join(top, 'my-uptime/scripts/mark.mjs')), false);
    const { report } = await checkPlugin(join(top, 'my-uptime'));
    assert.deepEqual(report.failures, []);
    assert.ok(report.items.some(item => item.rule === 'resource.read' && item.status === 'pass'));
  });
  test('two plugins made from the module template pass together, each with an event of its own', async () => {
    const events = [];
    for (const id of ['first-notes', 'second']) {
      assert.equal(init(join(top, id)).status, 0);
      const { report } = await checkPlugin(join(top, id));
      assert.deepEqual(report.failures, []);
      events.push(...Object.keys(JSON.parse(read(id, 'package.json')).contributes.protocols[0].events));
    }
    assert.deepEqual(events, ['note_first_notes.added', 'note_second.added']);
  });
  test('a directory with something in it is refused, and left as it was', () => {
    const dir = join(top, 'taken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'mine.txt'), 'x');
    const refused = init(dir);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /不是空目录/);
    assert.equal(existsSync(join(dir, 'package.json')), false);
  });
  for (const template of ['module', 'agent', 'resource']) test(`a plugin named user, a Coda event domain, is made from ${template} and passes the manifest level`, async () => {
    const dir = join(top, `as-user-${template}`, 'user');
    assert.equal(init(dir, '--template', template).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, 'user');
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(report.failures, []);
  });
  test('an empty directory is filled', () => {
    mkdirSync(join(top, 'empty'));
    assert.equal(init(join(top, 'empty')).status, 0);
    assert.equal(JSON.parse(read('empty', 'package.json')).name, 'empty');
  });
  test('a directory name that is no plugin ID, and an unknown template, are refused', () => {
    assert.match(init(join(top, 'Bad_Name')).stderr, /要作插件 ID/);
    assert.match(init(join(top, 'fine'), '--template', 'nope').stderr, /没有模板「nope」/);
    assert.equal(existsSync(join(top, 'fine')), false);
    assert.equal(init().status, 2);
  });
});
