#!/usr/bin/env node
// The operation `names` of `magpie/models@1` (a safe query, run as Coda runs it from the manifest): for each model ID a
// request can ask the gateway for, the underlying model's name by the rules of same.mjs, those that have one other than
// themselves, and the model services this machine's Magpie plugin provides (the references the usage rows name them by):
// `{ names: { "<asked ID>": "<name>" }, services: ["coda://<api>/<UUID>"] }`. The services are asked of Coda (`coda resources`,
// the ones of this plugin's own `ref`s that this machine holds): a row of a service that is not one of them went through
// another machine's Magpie, whose groups are its own. Read from Magpie, read-only: the IDs from the gateway's model list, the
// user's declarations (`modelSameAs`) from its settings.json, the members of each group made by hand from
// `magpie group show group/<id>`. Magpie's providers.json holds the keys, so this plugin does not open it, and reads and prints no key.
// What the user wrote (the setting `magpie.modelNames`) is over what the rules give, and needs no Magpie. The whole reading has 8
// seconds, the settings and the commands included: without Magpie (not installed, not running) or when it does not end in time, the
// rules give none, not a part of what was read, and not an error; the services are asked apart, and none when they are not had.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { groupMembers, sameNames, withWritten } from './same.mjs';
import { GATEWAY, magpieBinary } from './setup.mjs';

const run = promisify(execFile);
const budget = AbortSignal.timeout(8_000);
const { id: PLUGIN, contributes: { modelProviders } } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
// A command that fails is a thing not read; the budget ending is the whole reading's end.
const asked = async (command, args, env) => { try { return (await run(command, args, { signal: budget, env })).stdout; } catch (error) { budget.throwIfAborted(); return null; } };

// The model services of this plugin that this machine holds: of each interface a provider of the manifest speaks, the references
// Coda lists under that provider's title (to ask about those only) whose `ref` is `<plugin>/<id>` of one of them and whose source is
// this machine.
async function services() {
  const ours = new Map(modelProviders.map(provider => [`${PLUGIN}/${provider.id}`, provider.api]));
  const listed = await Promise.all([...new Set(ours.values())].map(async api => {
    const titles = modelProviders.filter(provider => provider.api === api).map(provider => provider.title);
    return ((await asked('coda', ['resources', 'list', api])) ?? '').split('\n').filter(line => titles.some(title => line.includes(`  ${title} · `))).flatMap(line => /coda:\/\/[a-z-]+\/[0-9a-f-]{36}/.exec(line) ?? []);
  }));
  const found = await Promise.all(listed.flat().map(async ref => {
    const text = await asked('coda', ['resources', 'explain', ref]);
    return text && /^来源：本机$/m.test(text) && ref.startsWith(`coda://${ours.get(/^ +ref +(\S+)$/m.exec(text)?.[1])}/`) ? ref : null;
  }));
  return found.filter(Boolean);
}

async function read() {
  const body = await (await fetch(`http://${GATEWAY}/v1/models`, { signal: budget })).json();
  const ids = body.data.map(model => model.id).filter(id => typeof id === 'string');
  // Magpie's own settings: no keys in it. Not there or not readable: nothing declared.
  const settings = await readFile(join(homedir(), '.config/magpie/settings.json'), { encoding: 'utf8', signal: budget }).then(JSON.parse, () => ({}));
  const same = settings?.modelSameAs && typeof settings.modelSameAs === 'object' ? settings.modelSameAs : {};
  // `magpie` is run with the agents' own sign-ins unread (MAGPIE_NO_ACCOUNTS): showing a group needs none.
  const binary = magpieBinary(), groups = {}, env = { ...process.env, MAGPIE_NO_ACCOUNTS: '1' };
  if (binary) await Promise.all(ids.filter(id => id.startsWith('group/')).map(async id => {
    const members = groupMembers(await asked(binary, ['group', 'show', id], env), id);
    if (members) groups[id] = members;
  }));
  budget.throwIfAborted();
  return sameNames({ ids, same, groups });
}

// The user's own: a setting that is not a table of texts is none written.
const written = (() => { try { return JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}')['magpie.modelNames']; } catch { return {}; } })();
const [names, held] = await Promise.all([read().catch(() => ({})), services().catch(() => [])]);
console.log(JSON.stringify({ names: withWritten(names, written), services: held }));
