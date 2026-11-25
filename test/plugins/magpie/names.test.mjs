// The Magpie plugin's operation `names` of `magpie/models@1` and the one record it is asked of, run as Coda runs them from the manifest,
// from a copy of the plugin whose model services point at a gateway the test stands in, with a magpie command and settings of its own
// in a home directory of its own: nothing of the machine's Magpie is read.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { barePath, manifest, pluginEnv, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const SECRET = 'sk-this-is-not-to-be-read';
// `magpie group show group/<id>` as Magpie prints it (see the fixtures).
const group = (id, members) => `  ${id}  group/${id}\n  routing   order\n  stays     off\n  models    ${members.map((member, i) => `${i + 1} ${member}  Some · Model`).join('\n            ')}\n`;
const GROUPS = {
  same: group('same', ['opencode-go/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash:fast', 'auto/deepseek-v4.1-flash']),
  differ: group('differ', ['opencode-go/deepseek-v4.1-flash-free', 'workbuddy/deepseek-v4.1-flash']),
  declared: group('declared', ['rig/opencode-go/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash']),
  patterns: readFileSync(new URL('../../fixtures/magpie/group-show-rules-patterns.txt', import.meta.url), 'utf8').replace('group/t1', 'group/patterns'),
};
const IDS = ['group/same', 'group/differ', 'group/declared', 'group/patterns', 'group/gone', 'auto/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash-free', 'workbuddy/deepseek-v4.1-flash'];
// What `coda resources list <api>` and `explain <ref>` say of the model services: this machine's Magpie ones, another machine's, another plugin's.
const U = n => `00000000-0000-4000-8000-00000000000${n}`;
const SERVICES = {
  'openai-completions': [[U(1), 'magpie/openai', '本机', 'Magpie · OpenAI Chat'], [U(2), 'cliproxy/cliproxy', '本机', 'CLIProxy'], [U(3), 'magpie/openai', 'macmini2，上次同步 2026-11-25 23:13', 'Magpie · OpenAI Chat'],
    [U(6), 'cliproxy/other', '本机', 'Magpie · OpenAI Chat']],   // another plugin's, however it is titled: its `ref` says
  'openai-responses': [[U(4), 'magpie/responses', '本机', 'Magpie · OpenAI Responses']],
  'anthropic-messages': [[U(5), 'magpie/anthropic', '本机', 'Magpie · Anthropic']],
};
const LOCAL = [U(1), U(4), U(5)].map((uuid, i) => `coda://${['openai-completions', 'openai-responses', 'anthropic-messages'][i]}/${uuid}`);

// The plugin and the machine it runs on: the gateway's model list (`answer`: none, nothing listens; `hang`: it never answers), the
// settings Magpie keeps, the magpie command (`binary`: false for none, and nothing of the machine's /Applications is found either) and
// what it is asked, `coda` and what it says of the services. Runs `file` of the plugin once. `slow`: `magpie group show` never ends, after
// the gateway's model list has been read, which the reading's 8 seconds (a signal of the test's) end.
async function ran(t, { answer = { data: IDS.map(id => ({ id })) }, settings = {}, binary = true, slow = false, file = 'scripts/names.mjs' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'coda-magpie-names-')), gate = join(home, 'gate'), asked = join(home, 'asked');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let address = '127.0.0.1:9';
  if (answer) {
    const server = createServer((req, res) => {
      if (req.url !== '/v1/models') { res.statusCode = 404; res.end(); return; }
      if (answer.hang) { writeFileSync(gate, ''); return; }
      res.end(JSON.stringify(answer));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    address = `127.0.0.1:${server.address().port}`;
  }
  const copy = join(home, 'plugin'), preload = join(home, 'preload.mjs'), bin = join(home, 'bin');
  cpSync(pluginDir('magpie'), copy, { recursive: true });
  const changed = manifest('magpie');
  for (const provider of changed.contributes.modelProviders) provider.url = provider.url.replace('127.0.0.1:3425', address);
  writeFileSync(join(copy, 'package.json'), JSON.stringify(changed));
  mkdirSync(join(home, '.config/magpie'), { recursive: true });
  writeFileSync(join(home, '.config/magpie/settings.json'), JSON.stringify({ theme: 'dark', apiKey: SECRET, ...settings }));
  mkdirSync(bin, { recursive: true });
  if (binary) {
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/magpie'), `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const [command, verb, id, ...rest] = process.argv.slice(2), groups = ${JSON.stringify(GROUPS)};
appendFileSync(${JSON.stringify(asked)}, JSON.stringify([command, verb, id, rest.length, process.env.MAGPIE_NO_ACCOUNTS]) + '\\n');
if (${JSON.stringify(slow)}) { writeFileSync(${JSON.stringify(gate)}, ''); setInterval(() => {}, 1000); } else {
  const name = String(id).replace('group/', '');
  if (command !== 'group' || verb !== 'show' || !Object.hasOwn(groups, name)) { console.error('magpie: no group ' + id); process.exit(1); }
  process.stdout.write(groups[name]);
}
`);
    chmodSync(join(home, '.local/bin/magpie'), 0o755);
  }
  writeFileSync(join(bin, 'coda'), `#!${process.execPath}
const [command, verb, target] = process.argv.slice(2), services = ${JSON.stringify(SERVICES)};
if (command !== 'resources') process.exit(2);
if (verb === 'list') {
  const rows = services[target] ?? [];
  console.log(target + '（' + target + '）\\n' + rows.map(([uuid, , source, title]) => '  coda://' + target + '/' + uuid + '  ' + title + ' · ' + source).join('\\n'));
} else {
  const [kind, uuid] = target.slice('coda://'.length).split('/'), row = (services[kind] ?? []).find(one => one[0] === uuid);
  if (!row) { console.error('这台找不到 ' + target); process.exit(1); }
  console.log('Title：x\\n字段：\\n  name  models/s-x\\n  ref  ' + row[1] + '\\n  title  Title\\n来源：' + row[2]);
}
`);
  chmodSync(join(bin, 'coda'), 0o755);
  // The reading's 8 seconds are a signal of the test's: it ends once the gateway has the request in hand, or magpie has (the file `gate`).
  // Nothing under /Applications is an executable, so that no magpie.app of the machine is found.
  writeFileSync(preload, `import fs, { appendFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const access = fs.accessSync, timeout = AbortSignal.timeout, budget = new AbortController();
fs.accessSync = (path, ...rest) => { if (String(path).startsWith('/Applications/')) { appendFileSync(process.env.TEST_GATE + '.refused', path + '\\n'); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } return access(path, ...rest); };
syncBuiltinESMExports();
AbortSignal.timeout = ms => ms === 8_000 ? budget.signal : timeout.call(AbortSignal, ms);
setInterval(() => { if (existsSync(process.env.TEST_GATE)) budget.abort(new DOMException('', 'TimeoutError')); }, 10).unref();
`);
  const env = { ...pluginEnv('magpie', { CODA_NODE: process.execPath }), CODA_PLUGIN_PATH: copy, HOME: home, PATH: await barePath(home, bin), TEST_GATE: gate, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const result = await run(join(copy, file), env);
  return { ...result, refused: existsSync(`${gate}.refused`) ? readFileSync(`${gate}.refused`, 'utf8').trim().split('\n') : [], asked: existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}

test('the manifest defines the protocol, a safe query of it run by a command, and its one record', () => {
  const { contributes } = manifest('magpie');
  const protocol = contributes.protocols.find(one => one.name === 'magpie/models@1');
  assert.equal(protocol.operations.names.safe, true);
  assert.deepEqual(protocol.permissions.read.operations, ['names']);
  assert.equal(protocol.permissions.read.read, true);
  assert.deepEqual(contributes.protocolImplementations.find(one => one.kind === 'magpie/models@1'), { kind: 'magpie/models@1', commands: { names: 'scripts/names.mjs' } });
  assert.deepEqual(contributes.records.find(one => one.kind === 'magpie/models@1'), { kind: 'magpie/models@1', command: 'scripts/models.mjs' });
  assert.equal(manifest('token-board').optionalUses['magpie/models@1'][0], 'read');
});

test('the record is one per machine', async t => {
  const { code, stdout } = await ran(t, { file: 'scripts/models.mjs' });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [{ key: 'local', spec: { version: 1 } }]);
});

test('names: by the gateway\'s models, the user\'s declarations and the members of the groups made by hand, read-only and without a key', async t => {
  const settings = { modelSameAs: { 'rig/opencode-go/deepseek-v4.1-flash': 'deepseek-v4.1-flash' } };
  const { code, stdout, stderr, asked } = await ran(t, { settings });
  assert.equal(code, 0, stderr);
  const { names } = JSON.parse(stdout);
  assert.deepEqual(names, {
    'auto/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash-free': 'deepseek-v4.1-flash-free',
    'workbuddy/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'group/same': 'deepseek-v4.1-flash', 'group/declared': 'deepseek-v4.1-flash', 'rig/opencode-go/deepseek-v4.1-flash': 'deepseek-v4.1-flash' });
  for (const id of ['group/differ', 'group/patterns', 'group/gone']) assert.equal(names[id], undefined, `${id} stays its own: members of different models, a pattern that matches nothing, no output`);
  assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET));
  // Only `magpie group show group/<id>` for each group, with the agents' sign-ins unread.
  assert.deepEqual(asked.map(([command, verb, id]) => [command, verb, id]).sort(), ['declared', 'differ', 'gone', 'patterns', 'same'].map(id => ['group', 'show', `group/${id}`]));
  assert.ok(asked.every(([, , , rest, accounts]) => rest === 0 && accounts === '1'));
});

test('the services are this machine\'s own of this plugin\'s, by the `ref` Coda says and where it is held: none of another machine\'s Magpie or another plugin\'s', async t => {
  const { code, stdout, stderr } = await ran(t);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).services.sort(), [...LOCAL].sort());
});

test('without a declaration, a peer\'s model is what follows its first provider: its group does not merge', async t => {
  const { names } = JSON.parse((await ran(t)).stdout);
  assert.equal(names['group/declared'], undefined);
  assert.equal(names['rig/opencode-go/deepseek-v4.1-flash'], undefined, 'not listed by the gateway nor declared: not asked for');
});

test('no magpie command (and no magpie.app found): what needs no group is still named', async t => {
  const { code, stdout, refused } = await ran(t, { binary: false });
  assert.equal(code, 0);
  assert.ok(refused.includes('/Applications/magpie.app/Contents/MacOS/magpie'), 'the lookup got to the app, and found none there');
  const { names, services } = JSON.parse(stdout);
  assert.equal(names['opencode-go/deepseek-v4.1-flash'], 'deepseek-v4.1-flash');
  assert.equal(names['auto/deepseek-v4.1-flash'], 'deepseek-v4.1-flash');
  assert.equal(Object.keys(names).some(id => id.startsWith('group/')), false);
  assert.equal(services.length, 3);
});

test('a gateway that does not answer, answers what is not a model list or never answers: none, not an error', async t => {
  for (const answer of [null, { data: 'no' }, { hang: true }]) {
    const { code, stdout, stderr } = await ran(t, { answer });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { names: {}, services: [] }, JSON.stringify(answer));
  }
});

test('one reading has one deadline: a command that does not end by it makes the whole answer none, not what was read before', async t => {
  const { code, stdout, stderr } = await ran(t, { slow: true });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { names: {}, services: [] });
});

test('settings that cannot be read declare nothing', async t => {
  const { code, stdout } = await ran(t, { settings: { modelSameAs: 'nope' } });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).names['group/declared'], undefined);
  assert.equal(JSON.parse(stdout).names['group/same'], 'deepseek-v4.1-flash');
});
