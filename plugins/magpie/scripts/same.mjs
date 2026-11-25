// The rules that turn the model IDs a request can ask Magpie for (`provider/model`, `group/<id>`, `auto/<name>`) into the
// underlying model's name, by what the user told Magpie: pure, no reading of the machine (names.mjs reads it).
//
// - `provider/model`: the name the user declared for it (Magpie's `modelSameAs`, keyed by `provider/model`), else `model`
//   (everything after the first `/`: a peer Magpie is a provider, so `rig/opencode-go/x` is `opencode-go/x` until declared).
//   A group's member may carry what routes it, which is not part of the model: `:fast`, a reasoning effort (`:high`, `:low+high`)
//   and an account (`#<account>`); they are taken off, but not from an ID the gateway lists as it is (a model's own colon);
// - `auto/<name>`: `<name>`, the group Magpie made from models of the same name or declared the same;
// - `group/<id>`, one made by hand: the one name its members all have, a member being a model or another group (taken
//   to the end). Members that differ, a group that cannot be taken apart (not known, empty, a pattern such as
//   `opencode-go/*`) or one that holds itself: no name, the group stays its own.
// Nothing else is guessed: no table of models, nothing of vendors or prices.

const own = (object, key) => Object.hasOwn(object, key);
const declared = (same, id) => (own(same, id) && typeof same[id] === 'string' && same[id].trim() ? same[id].trim() : null);

const EFFORT = /:(?:none|minimal|low|medium|high|xhigh|max)(?:\+(?:none|minimal|low|medium|high|xhigh|max))*$/i;
// The model a member names: its ID without the account, `:fast` and effort it may carry (Magpie's groupaccount.go, groupfast.go,
// groupeffort.go), each only while what is left is not an ID the gateway lists as it is.
function modelOf(member, listed) {
  if (listed.has(member) || member.startsWith('group/')) return member;
  let id = member;
  const hash = id.lastIndexOf('#');
  if (hash > 0 && id.slice(hash + 1).trim() && !id.slice(hash + 1).includes('/')) id = id.slice(0, hash);
  for (const suffix of [/:fast$/i, EFFORT]) if (!listed.has(id)) id = id.replace(suffix, '');
  return id;
}

// The name of one ID, or null for none. `groups`: `{ [id]: members }` of the groups made by hand, id as agents pick it
// (`group/<id>`); `path` the groups being taken apart now.
function nameOf(id, rules, path = []) {
  const { same, groups, listed } = rules;
  if (id.startsWith('auto/')) return id.slice('auto/'.length) || null;
  if (id.startsWith('group/')) {
    if (path.includes(id) || !own(groups, id) || !groups[id].length) return null;
    const names = new Set(groups[id].map(member => nameOf(member, rules, [...path, id])));
    return names.size === 1 ? [...names][0] : null;
  }
  if (id.includes('*')) return null;
  const model = modelOf(id, listed);
  return declared(same, model) ?? (model.includes('/') ? model.slice(model.indexOf('/') + 1) || null : model);
}

/**
 * `{ [asked ID]: name }` for the IDs (`ids`, those the gateway lists, and the models declared) that have a name other than
 * themselves. `same` is Magpie's `modelSameAs`, `groups` the members of each group made by hand, as above.
 */
export function sameNames({ ids = [], same = {}, groups = {} }) {
  const listed = new Set(ids), names = {};
  for (const id of new Set([...ids, ...Object.keys(same)])) {
    const name = id ? nameOf(id, { same, groups, listed }) : null;
    if (name && name !== id) names[id] = name;
  }
  return names;
}

/**
 * `names` with what the user wrote (the plugin setting `magpie.modelNames`, `{ "<asked ID>": "<name>" }`) over it: a written ID has
 * its written name, whatever the rules gave it or none, and one written as its own name has none (the user says it is not merged).
 * An entry that is not a non-empty text of 1 to 200 characters on each side is ignored.
 */
export function withWritten(names, written) {
  const text = value => (typeof value === 'string' && value.trim().length <= 200 ? value.trim() : '');
  const entries = Object.entries(written && typeof written === 'object' ? written : {}).map(([id, name]) => [text(id), text(name)]).filter(([id, name]) => id && name);
  const ids = new Set(entries.map(([id]) => id));
  return Object.fromEntries([...Object.entries(names).filter(([id]) => !ids.has(id)), ...entries.filter(([id, name]) => id !== name)]);
}

/**
 * The members of a group as `magpie group show <ref>` lists them (`ref`: `group/<id>`), in order; null for any output that is
 * not exactly what Magpie's showGroup prints (internal/cli/groups_cli.go): the group is then not taken apart. Lines are `  <key>  <value>`
 * with the key on the first line of a section only, and 12 spaces before a later line of it. Only the `models` section is read:
 * its numbered lines, whose first word is the member (what follows it is a label). A pattern in `patterns` that matches nothing
 * now leaves the group open to any model, so the group is not taken apart; the models a pattern matches are in `models` already.
 */
export function groupMembers(text, ref) {
  const lines = String(text).split('\n');
  if (!lines[0].endsWith(`  ${ref}`)) return null;
  const members = [];
  let section = null, models = false;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const keyed = /^ {2}(\S+) *(.*)$/.exec(line);
    const value = keyed ? keyed[2] : /^ {12}(\S.*)$/.exec(line)?.[1];
    if (value === undefined) return null;
    if (keyed) section = keyed[1];
    if (section === 'models') {
      models = true;
      if (value === 'none now') continue;
      const member = /^(\d+) (\S+)(?: |$)/.exec(value);
      if (!member || Number(member[1]) !== members.length + 1 || member[2].includes('*')) return null;
      members.push(member[2]);
    } else if (section === 'patterns' && !/^\S+ +[1-9]\d* models?$/.test(value)) return null;
  }
  return models ? members : null;
}
