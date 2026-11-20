// The check of `coda/resource@1` records (check/resources.mjs): what a plugin's record command prints held to the protocol's
// schema and the host's limits, as the checker reads it (checkPlugin) and as a plugin's tests do (resourceRecords).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { checkPlugin } from '../check/index.mjs';
import { ARGS, ENTRY, resourceRecords, resourceRecordsProblem } from '../check/resources.mjs';

const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

// A record of the type `type`, with the resources given.
const record = (resources, type = 'acme') => ({ key: type, spec: { type, title: 'Acme', resources } });
const resource = (extra = {}) => ({ name: 'main', values: [{ label: '额度', value: '剩余 50%', fraction: 0.5 }], buttons: [], ...extra });
const button = extra => resource({ buttons: [{ label: '切换', action: 'switch', ...extra }] });
const valid = [record([resource(), button({ args: { account: 'a' } }), button({ action: undefined, view: 'accounts' }), button({ action: undefined, url: 'https://example.com' })]),
  { key: 'bare', spec: { type: 'bare', title: 'Bare', resources: [], signIn: { installed: false, installable: true, note: '先装' } } }];

// A plugin that writes `coda/resource@1` records: its command is `source`, a Node program.
function plugin(source, manifest = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-resources-'));
  temps.push(dir);
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/resource.mjs'), `#!/usr/bin/env node\n${source}`);
  chmodSync(join(dir, 'scripts/resource.mjs'), 0o755);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme', version: '1.0.0', engines: { coda: 6 },
    contributes: { protocolImplementations: ['coda/resource@1'], records: [{ kind: 'coda/resource@1', command: 'scripts/resource.mjs' }] }, ...manifest }));
  return dir;
}
const printing = records => plugin(`console.log(${JSON.stringify(JSON.stringify(records))});`);

describe('what a resource record command printed', () => {
  test('records the protocol takes have no problem', () => {
    assert.equal(resourceRecordsProblem(valid), null);
    assert.equal(resourceRecordsProblem([]), null, 'no type signed in is no record');
  });
  test('a record without a type fails, and its type is its key', () => {
    assert.match(resourceRecordsProblem([{ key: 'acme', spec: { title: 'Acme', resources: [] } }]), /第 1 条记录（acme） spec 缺 type/);
    assert.match(resourceRecordsProblem([{ ...record([], 'other'), key: 'acme' }]), /第 1 条记录（acme）：spec.type（other）须与 key 相同/);
  });
  test('what is not an array of records written as Coda takes them fails', () => {
    assert.match(resourceRecordsProblem({ resources: [] }), /不是数组/);
    assert.match(resourceRecordsProblem([record([]), record([])]), /key 重复/);
    assert.match(resourceRecordsProblem([{ spec: record([]).spec }]), /key/);
    assert.match(resourceRecordsProblem([{ ...record([]), id: 'x' }]), /id/);
  });
  test('a resource, a reading and a button as the schema has them', () => {
    assert.match(resourceRecordsProblem([record([{ values: [], buttons: [] }])]), /spec\.resources\[0\] 缺 name/);
    assert.match(resourceRecordsProblem([record([resource({ buttons: undefined })])]), /缺 buttons/);
    assert.match(resourceRecordsProblem([record([resource({ values: [{ value: '1', fraction: 2 }] })])]), /values\[0\]\.fraction/);
    assert.match(resourceRecordsProblem([record([resource({ actions: [] })])]), /不认识的键：actions/);
  });
  test('a button is one of action, view and url', () => {
    const problem = buttons => resourceRecordsProblem([record([resource({ buttons })])]);
    assert.match(problem([{ label: '没有' }]), /buttons\[0\] 缺 action：.*三选一/);
    assert.match(problem([{ label: '两个', action: 'a', view: 'v' }]), /buttons\[0\]：.*三选一/);
    assert.match(problem([{ label: '三个', action: 'a', view: 'v', url: 'https://example.com' }]), /三选一/);
    assert.match(problem([{ label: '链接带参数', url: 'https://example.com', args: {} }]), /三选一/);
    assert.match(problem([{ label: '链接带确认', url: 'https://example.com', confirm: '确定？' }]), /三选一/);
    assert.match(problem([{ label: '明文链接', url: 'http://example.com' }]), /buttons\[0\]/);
    assert.equal(problem([{ label: '动作带参数与确认', action: 'a', args: { n: 1 }, confirm: '确定？', disabled: true }]), null);
  });
  test('args are at most 4096 bytes serialized, counted in bytes, not characters', () => {
    const at = args => resourceRecordsProblem([record([button({ args })])]);
    // `{"x":"…"}` is 8 bytes around the text.
    assert.equal(at({ x: 'a'.repeat(ARGS - 8) }), null);
    assert.match(at({ x: 'a'.repeat(ARGS - 7) }), /spec\.resources\[0\]\.buttons\[0\]\.args 序列化后 4097 字节，超过 4096 字节/);
    // A character of 汉 is three bytes: 1362 of them are 4094 bytes with the rest, 1363 are 4097.
    assert.equal(at({ x: '汉'.repeat(1362) }), null);
    assert.match(at({ x: '汉'.repeat(1363) }), /args 序列化后 4097 字节/);
    assert.match(resourceRecordsProblem([record([resource(), button({ args: { x: 'a'.repeat(ARGS) } })])]), /buttons\[0\]\.args/);
  });
  test('a record is at most 64 KiB serialized, said by its place in the array', () => {
    // Many resources of long names stay inside the schema's limits, and of arguments within theirs, but not within the host's.
    const wide = name => record(Array.from({ length: 50 }, () => button({ args: { x: name } })), 'wide');
    const size = name => Buffer.byteLength(JSON.stringify(wide(name)));
    const room = ENTRY - size('');
    assert.equal(resourceRecordsProblem([record([], 'small'), wide('a'.repeat(Math.floor(room / 50)))]), null);
    assert.match(resourceRecordsProblem([record([], 'small'), wide('a'.repeat(Math.floor(room / 50) + 1))]), /^第 2 条记录超过 64 KiB$/);
  });
});

describe('the records of a plugin, run as its tests run them', () => {
  test('give what its command printed', async () => {
    assert.deepEqual(await resourceRecords(printing(valid)), JSON.parse(JSON.stringify(valid)));
  });
  test('the command is run as Coda runs it: in the plugin\'s directory, told its kind, given {} to read, in the environment the test gives', async () => {
    const dir = plugin(`import { readFileSync, writeFileSync } from 'node:fs';
      writeFileSync('seen.json', JSON.stringify({ cwd: process.cwd(), input: readFileSync(0, 'utf8'), kind: process.env.CODA_RECORD_KIND, seen: process.env.SEEN, path: process.env.CODA_PLUGIN_PATH }));
      console.log('[]');`);
    assert.deepEqual(await resourceRecords(dir, { env: { PATH: process.env.PATH, CODA_PLUGIN_PATH: dir, SEEN: '测试给的环境' } }), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')), { cwd: realpathSync(dir), input: '{}', kind: 'coda/resource@1', seen: '测试给的环境', path: dir });
  });
  test('fail with why: no command for the kind, a command that fails, output that is no JSON, output the host would refuse', async () => {
    await assert.rejects(resourceRecords(plugin('', { contributes: { records: [] } })), /里没有 coda\/resource@1/);
    await assert.rejects(resourceRecords(plugin('console.error("读不到账号"); process.exit(3);')), /读不到账号/);
    await assert.rejects(resourceRecords(plugin('console.log("not json");')), /记录命令的输出不是 JSON/);
    await assert.rejects(resourceRecords(printing([{ key: 'acme', spec: { title: 'Acme', resources: [] } }])), /缺 type/);
    await assert.rejects(resourceRecords(printing([record([button({ args: { x: 'a'.repeat(ARGS) } })])])), /超过 4096 字节/);
  });
});

describe('the checker', () => {
  const read = async dir => (await checkPlugin(dir, { agent: null })).report;
  test('passes a plugin whose command prints records the protocol takes', async () => {
    const report = await read(printing(valid));
    assert.deepEqual(report.failures, []);
    const item = report.items.find(one => one.rule === 'resource.read');
    assert.equal(item.status, 'pass');
    assert.match(item.message, /输出合 coda\/resource@1：2 条记录，4 个资源，读数 4 个，按钮 3 个/);
  });
  test('fails a command that does not finish, and output the host would refuse', async () => {
    const failing = await read(plugin('console.error("读不到账号"); process.exit(3);'));
    assert.deepEqual(failing.failures.map(f => f.rule), ['resource.read']);
    assert.match(failing.failures[0].message, /读取没成功：读不到账号/);
    for (const [records, message] of [
      [[{ key: 'acme', spec: { title: 'Acme', resources: [] } }], /缺 type/],
      [[record([button({ args: { x: 'a'.repeat(ARGS) } })])], /超过 4096 字节/],
      [[record([resource({ buttons: [{ label: '两个', action: 'a', view: 'v' }] })])], /三选一/],
    ]) {
      const report = await read(printing(records));
      assert.deepEqual(report.failures.map(f => f.rule), ['resource.output']);
      assert.match(report.failures[0].message, message);
    }
  });
  test('does not run the command when only the manifest is read', async () => {
    const dir = plugin('process.exit(1);');
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(report.failures, []);
    assert.ok(report.items.some(item => item.rule === 'options.manifest' && item.status === 'skip'));
  });
});
