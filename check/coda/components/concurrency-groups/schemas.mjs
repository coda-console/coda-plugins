import { requireCondition as check } from '../../domain/errors.mjs';

const string = { type: 'string', minLength: 1 };
// Who may line up for a group, or reach it by one of its links: the machine that owns it, some machines, or the whole
// space, a group with none the space's; the owner reaches its own whatever it says (./ownership.mjs `reaches`).
const REACH = { type: 'object',
  properties: { scope: { type: 'string', enum: ['machine', 'machines', 'space'] }, machines: { type: 'array', items: string } },
  required: ['scope'], oneOf: [
    { properties: { scope: { enum: ['machine'] } }, not: { required: ['machines'] } },
    { properties: { scope: { enum: ['machines'] } }, required: ['machines'] },
    { properties: { scope: { enum: ['space'] } }, not: { required: ['machines'] } }] };
// How long what Coda writes on a group's record may be: each field of its holder, and why its return failed (the whole of
// it on its call). Bounded so, the status takes at most STATUS_BYTES serialized, the directory's envelope with it, which
// what a plugin gives of a group leaves free of the directory's RECORD_BYTES (`checkGiven`): a status is always written.
export const HOLDER_CHARS = 256, MESSAGE_CHARS = 1000;
const RECORD_BYTES = 65536, STATUS_BYTES = 16384;
// Who holds a group lent: the instance and machine whose run it is, and the run.
const held = { type: 'string', minLength: 1, maxLength: HOLDER_CHARS };
const HOLDER = { type: 'object', properties: { owner: held, location: held, runId: held }, required: ['owner', 'location', 'runId'], additionalProperties: false };
const LENDING = { type: 'object', properties: { holder: HOLDER }, required: ['holder'], additionalProperties: false };
// A concrete group a plugin declares on this instance; its record ID is a UUID, its name `spec.name`. Who waits or holds it is in this
// component's own tables, not in the record (docs/plugins.md「声明具体组」). The record only says who owns the group: a place
// in it is asked of that instance through the call kernel (`workflows:acquire`, ./remote-groups.mjs), not of the record.
// Its spec: how many may hold it at once (`capacity`, 1–64 as `hold-group` takes one, by default 1), what it is
// (`attributes`), which of them name it alone among its plugin's (`unique`), who may line up for it (`reach`, by default
// the space), the ways to reach it (`links`, each reaching whom its own `reach` says), and whether it is lent and returned
// (`lends`, only one of capacity 1). Its status is Coda's alone: of one of capacity 1, how it is lent (`state`), to whom
// (`holder`) and why it failed (`message`); of a larger one, nothing. Its operations are Coda's alone too (`codaOnly`,
// components/protocols/types.mjs), called by Coda on the plugin that holds it: `lend` it to a holder once let in, `return`
// it once let go, each a run answering `{}`.
export const GROUP = 'coda/group@1';
// Its two operations, as the call kernel names them (./lending.mjs).
export const LEND = `${GROUP}:lend`, RETURN = `${GROUP}:return`;
export const groupType = { kind: GROUP, title: '并发组',
  permissions: { read: { title: '查看本机的并发组及其属性', trial: true, read: true } },
  spec: { type: 'object', properties: { name: string, capacity: { type: 'integer', minimum: 1, maximum: 64, default: 1 },
    attributes: { type: 'object', additionalProperties: { type: 'string' } }, unique: { type: 'array', items: string },
    reach: REACH,
    links: { type: 'array', items: { type: 'object', properties: { protocol: string, endpoint: string, reach: REACH },
      required: ['protocol', 'endpoint', 'reach'], additionalProperties: false } },
    lends: { type: 'boolean' } },
  required: ['name', 'attributes', 'unique'], additionalProperties: false },
  status: { type: 'object', additionalProperties: false, properties: { state: { enum: ['free', 'lending', 'held', 'returning', 'failed'] },
    holder: HOLDER, message: { type: 'string', maxLength: MESSAGE_CHARS } }, dependentRequired: { holder: ['state'], message: ['state'] } },
  operations: { lend: { run: true, input: LENDING, timeout: 120_000, codaOnly: true }, return: { run: true, input: LENDING, timeout: 600_000, codaOnly: true } } };
// How many a group lets in at once: one when its record does not say, as one written before groups said it (kept
// through v255 until its plugin gives it again) does not.
export const capacityOf = spec => spec.capacity ?? 1;
// What Coda reads of a group's record besides its schemas, held to as each is written (Protocols `register`'s `checkWrite`,
// and the plugin test host's). The plugin that holds a record (its entry's `plugin`) is the one whose `lend` and `return`
// Coda calls (./lending.mjs) and whose going takes its records (./ownership.mjs `forget`). A group is named
// by `spec.name` (1–100 characters, none of them whitespace), as a step asks for it (`hold-group`, `coda:group`); and it marks
// unique only attributes it has, not empty (./ownership.mjs `groupOwner`); one lent is of capacity 1, and only one of
// capacity 1 has a status. Of any other kind, nothing.
export function checkHeld({ kind, spec, status = {} }) {
  if (kind !== GROUP) return;
  check(/^\S{1,100}$/.test(spec.name), 'invalid_input', `组名：1–100 个非空白字符，不是 ${JSON.stringify(spec.name)}`);
  const missing = spec.unique.find(key => !Object.hasOwn(spec.attributes, key) || !spec.attributes[key]);
  check(missing === undefined, 'invalid_input', `组 ${spec.name} 的 unique 列了 attributes 里没有或为空的属性 ${missing}`);
  check(!spec.lends || spec.capacity === 1, 'invalid_input', `组 ${spec.name} 写了 lends，容量须为 1，不是 ${spec.capacity}`);
  check(spec.capacity === 1 || Object.keys(status).length === 0, 'invalid_input', `组 ${spec.name} 的容量大于 1，没有 status`);
}
// What a plugin gives of a group (`put`, each of a `replace`: `{ spec, status?, labels? }`), as it gives it: its
// status is Coda's (its lending), never the plugin's. Given at all, even empty,
// the write is refused, so that one given again as it was read cannot clear it.
// A group's of capacity 1 as given leaves its status room on the record (STATUS_BYTES); a larger one's status is empty,
// and it is held to the directory's RECORD_BYTES alone.
export function checkGiven(kind, value) {
  check(kind !== GROUP || !Object.hasOwn(value, 'status'), 'invalid_input', `${kind} 的 status 归 Coda 维护，插件只写 spec`);
  if (kind !== GROUP || (value.spec?.capacity ?? 1) !== 1) return;
  const bytes = Buffer.byteLength(JSON.stringify({ spec: value.spec, labels: value.labels ?? null }));
  check(bytes <= RECORD_BYTES - STATUS_BYTES, 'invalid_input', `组 ${value.spec?.name} 的记录有 ${bytes} 字节，超过 ${RECORD_BYTES - STATUS_BYTES}：要给 Coda 写的借还状态留出 ${STATUS_BYTES} 字节`);
}
// A group's lending not settled: being lent, held, being returned or failed to be returned.
const UNSETTLED = ['lending', 'held', 'returning', 'failed'];
// The status Coda writes a record of these kinds with as its plugin gives it (`spec`), first or again (`before`, the
// record as it was, null for a new one): a group's of capacity 1 says how it is lent, `free` unless its lending is not
// settled; a larger one's is empty. Another kind's is kept as it was. A group lent whose lending is not settled keeps its
// name, capacity and `lends` until it is: given otherwise, it is refused, as what it holds is still to be returned by
// what it is (given as it was, its return is tried again, ../lending.mjs `retry`).
export function keptStatus(kind, spec, before) {
  const status = before?.status ?? {};
  if (kind !== GROUP) return status;
  if (before?.spec.lends && UNSETTLED.includes(status.state))
    check(spec.name === before.spec.name && (spec.capacity ?? 1) === before.spec.capacity && spec.lends === true, 'conflict',
      `组 ${before.spec.name} 的借出还没结清（${status.state}），不能改名、改容量或关掉 lends；归还之后再改`);
  if ((spec.capacity ?? 1) !== 1) return {};
  return UNSETTLED.includes(status.state) ? status : { state: 'free' };
}
// What a write of a kind leaves on this machine (`records`, its records here, each `{ id, spec, plugin }`, whichever plugin
// holds them), in the write's
// transaction: a group's name is one group's, as the queue and the owner are found by it. Held to by what the write
// leaves, not by each record as it is written: a replace swapping two of its groups' names is taken.
export function checkKept(kind, records) {
  if (kind !== GROUP) return;
  const named = new Map();
  for (const group of records) {
    const other = named.get(group.spec.name);
    check(!other, 'conflict', `本机已有组 ${group.spec.name}（${other?.plugin} 的 ${other?.id}，又给了 ${group.plugin} 的 ${group.id}）`);
    named.set(group.spec.name, group);
  }
}
