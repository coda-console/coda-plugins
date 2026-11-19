// What a plugin's reads and writes of the records (coda#2749 3.7, `coda.get`, `list`, `put`, `replace`) are held to,
// wherever they are answered: by the backend (./mirror.mjs, ./providers.mjs, ./protocols.mjs) and by a plugin's test host
// (adapters/plugin-test-host.mjs).
import { requireCondition as check } from '../../domain/errors.mjs';
import { derivedUUID } from '../../domain/values.mjs';

// Where a kind's records are, said once for every kind (Protocols `register` reads it). The kinds only this machine keeps:
// Coda's composers and what is submitted through them, the runs of its posts to sessions, and the kinds it serves whole
// from its own tables: `coda/thread@1`, `coda/project@1`, `coda/card@1`, `coda/plugin@1` and the workflows' `coda/workflow@1`
// and `coda/workflow-run@1` (one of another backend is found by asking the space: mirror.mjs `place`). `coda/session@1` is shared (Coda's sessions are served beside
// it, a plugin's external sessions are written in the record directory). They are never in the record directory, and no
// plugin writes one. Every other kind, every one a plugin defines among them, is shared: its records are this machine's rows of
// the record directory, which the other backends of a space copy.
export const LOCAL_KINDS = new Set(['coda/composer@1', 'coda/submission@1', 'coda/run@1', 'coda/thread@1', 'coda/project@1', 'coda/card@1',
  'coda/plugin@1', 'coda/workflow@1', 'coda/workflow-run@1']);
// `list(kind, { scope?, id?, labels? })`: this machine's records (`local`) or this machine's and the others' (`available`,
// unsaid), all of them, those of an ID, or those whose labels have each of these values (`labels`, as Kubernetes' equality
// selector: nothing but equality).
export function readFilter(filter) {
  check(filter == null || (typeof filter === 'object' && !Array.isArray(filter)), 'invalid_input', '筛选须为对象');
  const { scope = 'available', id, labels, ...rest } = filter ?? {};
  check(['local', 'available'].includes(scope) && !Object.keys(rest).length && (id === undefined || (typeof id === 'string' && id)),
    'invalid_input', '筛选只认 scope（local 或 available）、id 和 labels');
  check(labels === undefined || (labels && typeof labels === 'object' && !Array.isArray(labels) && Object.values(labels).every(value => typeof value === 'string')),
    'invalid_input', '筛选的 labels 须为文本键值对象');
  return { scope, id, labels };
}
// Whether a record's labels have each value a filter's `labels` asks for (none asked, any record has).
export const labelled = (labels, asked) => asked === undefined || Object.entries(asked).every(([name, value]) => labels?.[name] === value);
// `get({ kind, id })`.
export function readRef(ref) {
  const { kind, id, ...rest } = ref ?? {};
  check(typeof id === 'string' && id && !Object.keys(rest).length, 'invalid_input', 'get 须为 { kind, id }');
  return { kind, id };
}
// Of the entries of a record's ID (`entries`, a record's ID is the space's one), the one `get` gives: this machine's, else
// the record directory's; null for none.
export const picked = entries => entries.find(({ local }) => local) ?? entries[0] ?? null;
// A record's labels, when it has any: names each with a text.
export const checkLabels = labels => check(labels === null || (labels && typeof labels === 'object' && !Array.isArray(labels)
  && Object.values(labels).every(value => typeof value === 'string')), 'invalid_input', 'labels 须为文本键值对象');
// A record a plugin writes is named by it with a key of its own (`{ kind, key }`, a device's udid, `account:group`, a
// source's name): a non-empty text of at most 256 characters without NUL (a command is given it in its environment),
// nothing else; its ID is the host's (`recordId`), never the plugin's.
export function checkKey(key) {
  check(typeof key === 'string' && key.length > 0 && key.length <= 256 && !key.includes('\0'), 'invalid_input',
    `记录 key 须为 1–256 个字符、不含 NUL 的文本，不是 ${JSON.stringify(key)}`);
  return key;
}
export function writeRef(ref) {
  const { kind, key, ...rest } = ref ?? {};
  check(!Object.hasOwn(rest, 'id'), 'invalid_input', '插件写记录只给 key，id 由宿主派生');
  check(!Object.keys(rest).length, 'invalid_input', '写记录须为 { kind, key }');
  return { kind, key: checkKey(key) };
}
// A plugin's record's ID, the space's one: the same for the same backend (`owner`), plugin, kind and key, another for any
// other, a lowercase UUID; derived as the host's other IDs are (domain/values.mjs `derivedUUID`).
export const recordId = (owner, plugin, kind, key) => derivedUUID(owner, plugin, kind, key);
// What `put` writes of a record, and `replace` of each (`{ key, …value }`): its spec, its status and its labels, nothing else.
export function checkWrite(value) {
  check(value && typeof value === 'object' && Object.keys(value).every(key => ['spec', 'status', 'labels'].includes(key)), 'invalid_input', '记录只写 { spec, status?, labels? }');
}
// `replace(kind, entries)`: every record the plugin holds of the kind, each once, by its key.
export function checkReplace(entries) {
  check(Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object'), 'invalid_input', 'replace 的记录须为 [{ key, spec, status?, labels? }]');
  check(entries.every(entry => !Object.hasOwn(entry, 'id')), 'invalid_input', '插件写记录只给 key，id 由宿主派生');
  const keys = entries.map(entry => checkKey(entry.key));
  check(new Set(keys).size === keys.length, 'invalid_input', 'replace 的记录 key 重复');
  return keys;
}
