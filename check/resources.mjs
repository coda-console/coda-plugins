// A plugin's resource records (`coda/resource@1`, written by the command its `contributes.records` names for the kind) at the
// handshake level: the command run as Coda's host runs a record command (cwd the plugin's directory, its own environment,
// `{}` on standard input, `CODA_RECORD_KIND`, 30 seconds), and what it printed held to what the host holds it to before it
// writes the plugin's whole set of the kind (backend components/plugins/record-commands.mjs, components/protocols/providers.mjs):
// an array of `{ key, spec }`, each at most 64 KiB, each key once, the spec the protocol's schema, `spec.type` the key; and a
// button's `args` at most 4096 bytes, which no schema can say. Its operations (`act`, `sign-in`, `install`) are not run: a button
// may change things, and only a person presses it.
//
// For the tests of a plugin's resources: `resourceRecords(dir, { env })` runs the command and gives the records it printed, and
// throws what is wrong; `resourceRecordsProblem(output)` judges what is already at hand.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RESOURCE_PROTOCOL } from '@coda-console/protocol/protocol';
import { pointProblem } from '@coda-console/protocol/validate';
import { fileCommand, runPluginCommand, settle } from './coda/adapters/plugin-command.mjs';
import { checkLabels, checkReplace, checkWrite } from './coda/components/protocols/record-rules.mjs';
import { cleared } from './coda/components/plugins/plugin-rules.mjs';
import { group, temporary } from './leftovers.mjs';

export const RESOURCE = RESOURCE_PROTOCOL.name;
// A record as the host takes it (at most, as JSON), and a button's `args` (as JSON, in bytes).
export const ENTRY = 64 * 1024, ARGS = 4096;
// How long the host gives a record command.
const TIMEOUT = 30_000;
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// What is wrong with what a resource record command printed (`output`, parsed), as the host takes it, or null: the first thing
// found, naming the record by its place in the array.
export function resourceRecordsProblem(output) {
  if (!Array.isArray(output)) return '命令的输出不是数组';
  const big = output.findIndex(one => bytes(one) > ENTRY);
  if (big >= 0) return `第 ${big + 1} 条记录超过 ${ENTRY / 1024} KiB`;
  try { checkReplace(output); } catch (error) { return error.message; }
  for (const [i, { key, ...value }] of output.entries()) {
    const at = `第 ${i + 1} 条记录（${key}）`;
    try { checkWrite(value); checkLabels(value.labels ?? null); } catch (error) { return `${at}：${error.message}`; }
    const problem = pointProblem(RESOURCE_PROTOCOL.spec, value.spec, `${at} spec`)
      ?? (Object.hasOwn(value, 'status') ? pointProblem(RESOURCE_PROTOCOL.status, value.status, `${at} status`) : null);
    if (problem) return problem;
    if (value.spec.type !== key) return `${at}：spec.type（${value.spec.type}）须与 key 相同`;
    for (const [r, resource] of value.spec.resources.entries()) for (const [b, { args }] of resource.buttons.entries())
      if (args !== undefined && bytes(args) > ARGS) return `${at}：spec.resources[${r}].buttons[${b}].args 序列化后 ${bytes(args)} 字节，超过 ${ARGS} 字节`;
  }
  return null;
}

// What starts a command: a child of the checker's, in a group of its own, which goes however the checker ends.
const ends = new Map();
const start = {
  spawn: (owner, _entry, file, args, options) => {
    const child = spawn(file, args, { ...options, detached: true });
    ends.set(owner, group(child.pid));
    return child;
  },
  remove: owner => { ends.get(owner)?.(); ends.delete(owner); },
};

// The plugin's resource record command `command` (a file in `dir`) run, as `{ result }`, the array it printed, or `{ error }`,
// the message of why it gave none. `env`: the environment of the plugin's processes, as the host gives it.
export async function runResourceCommand(dir, command, env) {
  const ran = await runPluginCommand(fileCommand(command), { start, cwd: dir, env: { ...env, CODA_RECORD_KIND: RESOURCE }, input: '{}', timeoutMs: TIMEOUT });
  const { result, error } = settle(ran, { what: '记录命令' });
  return error ? { error: error.message } : { result };
}

// The records the plugin in `dir` gives of `coda/resource@1`: its manifest's command for the kind run (`env`: the environment of
// its processes, for a test that puts its own in place of the machine's, as the host gives it; by default this process's, with
// `CODA_PLUGIN_PATH` the plugin's directory and this Node first on the PATH), and what it printed, `[{ key, spec }]`, held to the
// host's limits. Throws what is wrong: the command's failure, or the first problem of its output (`resourceRecordsProblem`).
export async function resourceRecords(dir, { env = { ...process.env, CODA_PLUGIN_PATH: dir, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':') } } = {}) {
  const { contributes } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), found = contributes?.records?.find(one => one.kind === RESOURCE);
  if (!found) throw new Error(`清单的 contributes.records 里没有 ${RESOURCE}`);
  const { error, result } = await runResourceCommand(dir, found.command, env);
  if (error) throw new Error(error);
  const problem = resourceRecordsProblem(result);
  if (problem) throw new Error(problem);
  return result;
}

// The check of the plugin `checked` (the manifest level's reading, manifest.mjs checkManifest) that writes `coda/resource@1`
// records: its command run once in the environment Coda gives its processes, what it printed judged as the tests judge it.
export async function checkResources({ checked, say }) {
  const { plugin } = checked, { command } = plugin.records.find(one => one.kind === RESOURCE);
  // The plugin's state directory, which Coda keeps for it; here a temporary one, gone however the checker ends.
  const state = temporary('coda-plugin-check-state-');
  try {
    const env = { ...cleared(process.env), ...checked.env(state.dir) };
    delete env.CODA_THREAD_ID;
    env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(':');
    env.CODA_GROUPS_STATE = JSON.stringify({ now: Date.now(), groups: [] });
    const started = Date.now(), { error, result } = await runResourceCommand(plugin.dir, command, env), took = ((Date.now() - started) / 1000).toFixed(1);
    if (error) return say.fail('resource.read', `读取没成功：${error}`);
    const problem = resourceRecordsProblem(result);
    if (problem) return say.fail('resource.output', `输出不合 ${RESOURCE}：${problem}`);
    const resources = result.flatMap(record => record.spec.resources), count = key => resources.reduce((n, resource) => n + resource[key].length, 0);
    say.pass('resource.read', `读取 ${took} 秒，输出合 ${RESOURCE}：${result.length} 条记录，${resources.length} 个资源，读数 ${count('values')} 个，按钮 ${count('buttons')} 个`);
  } finally { state.remove(); }
}
