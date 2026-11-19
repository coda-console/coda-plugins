// Coda's own protocol of the friends of this machine and the signed records they keep, `coda/accord@1`: one record, this
// machine's (`local`), saying the key its records are signed with and the channels of its friends (components/network/friends.mjs),
// and its query `records`, the records of a kind signed by a key (AIP-01, domain/accord.mjs), this machine's and its
// friends'. What it does — publish a record, take a friend's invitation, exchange bindings, remove a friend — are doing
// operations, done by the friends' side of the call kernel (components/network/accord-operations.mjs). Nothing of a private
// key or of an invitation's `authKey` is ever said. The record is read through (Protocols.serve), nothing is kept of it, it
// is no section and not in the record directory: another machine's is not read. Its revision moves with the friends' count of
// changes too, as the records a query reads are not in the record.
// Only what a plugin's contract may carry is imported here (scripts/plugin-contract.mjs): the doing side is kept apart.
import { createHash } from 'node:crypto';
import { requireCondition as check } from '../domain/errors.mjs';
import { isAccordKind } from '../domain/accord.mjs';
import { canonical } from '../domain/values.mjs';

export const ACCORD = 'coda/accord@1';
export const ACCORD_LOCAL_ID = 'local';
export const ACCORD_SIDE = 'friends';
// What a record published says at most, as UTF-8 JSON (the signed record is bounded as a whole: domain/accord.mjs).
export const MAX_ACCORD_BODY_BYTES = 64 * 1024;
export const MAX_ACCORD_RECORDS_LIMIT = 200;
// What a read gives at most, as UTF-8 JSON: the envelope of a call is 1 MiB.
export const MAX_ACCORD_RESPONSE_BYTES = 768 * 1024;

const KEY = /^ed25519:[0-9a-f]{64}$/;
/** A key a record is signed with, `ed25519:<64 hex>`. */
export const isAccordAuthor = author => typeof author === 'string' && KEY.test(author);

const text = (schema = {}) => ({ type: 'string', minLength: 1, ...schema });
const time = { type: 'integer', minimum: 0 };

export const ACCORD_PROTOCOL = {
  kind: ACCORD,
  title: '好友与 Accord',
  side: ACCORD_SIDE,
  spec: { type: 'object', properties: { author: text() }, required: ['author'], additionalProperties: false },
  status: {
    type: 'object',
    properties: {
      friends: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            node: text(), mode: text(), linkId: text(), scope: text(), peerNode: text(), author: { type: ['string', 'null'] },
            bound: { type: 'boolean' }, conflict: { type: 'boolean' }, createdAt: time, updatedAt: time,
          },
          required: ['node', 'mode', 'scope', 'author', 'bound', 'createdAt', 'updatedAt'],
          additionalProperties: false,
        },
      },
    },
    required: ['friends'],
    additionalProperties: false,
  },
  operations: {
    // The records of a kind, newest version first, of a key if given; `truncated` when more than `limit` (or than a call may
    // carry) are.
    records: { safe: true,
      input: {
        type: 'object',
        properties: { kind: text({ maxLength: 129 }), author: text({ maxLength: 80 }), limit: { type: 'integer', minimum: 1, maximum: MAX_ACCORD_RECORDS_LIMIT } },
        required: ['kind'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: { author: text(), kind: text(), id: text(), version: time, body: { type: 'object' }, local: { type: 'boolean' } },
              required: ['author', 'kind', 'id', 'version', 'body', 'local'],
              additionalProperties: false,
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['records', 'truncated'],
        additionalProperties: false,
      } },
    // A record of this machine's key written and signed, for the keys in `audience` (or `'public'`).
    publish: {
      input: {
        type: 'object',
        properties: {
          kind: text({ maxLength: 129 }), id: text({ maxLength: 200 }), body: { type: 'object' },
          audience: { type: 'array', maxItems: 500, items: text({ maxLength: 80 }) },
        },
        required: ['kind', 'id', 'body', 'audience'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { author: text(), kind: text(), id: text(), version: time, audience: { type: 'array', items: text() } },
        required: ['author', 'kind', 'id', 'version', 'audience'],
        additionalProperties: false,
      } },
    // A friend's invitation to its tailnet taken up (`Friends.joinLink`); its `authKey` is not said again.
    accept: {
      input: {
        type: 'object',
        properties: {
          linkId: text({ maxLength: 100 }), scope: text({ maxLength: 200 }), control: text({ maxLength: 500 }), authKey: text({ maxLength: 500 }),
          hostname: text({ maxLength: 100 }), peerNode: text({ maxLength: 100 }),
        },
        required: ['linkId', 'control', 'authKey'],
        additionalProperties: false,
      },
      result: { type: 'object', properties: { node: text() }, required: ['node'], additionalProperties: false } },
    // Both bindings exchanged with a friend (`Friends.handshake`).
    handshake: {
      input: { type: 'object', properties: { node: text({ maxLength: 120 }), peerNode: text({ maxLength: 100 }) }, required: ['node'], additionalProperties: false },
      result: {
        type: 'object',
        properties: { node: text(), author: text(), peerNode: text() },
        required: ['node', 'author'],
        additionalProperties: false,
      } },
    // A friend no longer followed or kept (`Friends.remove`).
    remove: {
      input: { type: 'object', properties: { node: text({ maxLength: 120 }) }, required: ['node'], additionalProperties: false },
      result: { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false } },
  },
  // What a plugin may ask for in its `uses` (docs/plugins.md「用到的权限」), on trial while the protocol is not stable.
  permissions: {
    read: { title: '查看本机的 Accord 身份、好友列表与好友发来的记录', trial: true, read: true, operations: ['records'] },
    publish: { title: '向好友发布 Accord 签名记录', trial: true, operations: ['publish'] },
    manage: { title: '接受好友邀请、完成互认或移除好友', trial: true, operations: ['accept', 'handshake', 'remove'] },
  },
};

const record = friends => {
  const spec = { author: friends.author() }, status = { friends: friends.list() };
  return { kind: ACCORD, id: ACCORD_LOCAL_ID, provider: 'coda', createdAt: new Date(0).toISOString(), creationSequence: 0, spec, status,
    revision: `local:${createHash('sha256').update(canonical([spec, status, friends.changeSeq])).digest('hex').slice(0, 16)}` };
};
export const accordRecords = friends => ({
  get: id => id === ACCORD_LOCAL_ID ? record(friends) : null,
  list: () => [record(friends)],
});

// Newest version first, then by key and ID, so that what is cut off is always the oldest.
const newest = (a, b) => b.version - a.version || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Its query through the unified call (components/protocols/calls.mjs `handle`): `records`, read from the friends, for this
// machine's callers alone: the record's ID is the same on every machine, so a call another backend sends is refused.
export function accordQueries(calls, { friends }) {
  calls.handle(ACCORD, 'records', ({ input }) => {
    check(isAccordKind(input.kind) && input.kind !== 'binding', 'invalid_input', '记录种类不合法');
    check(input.author === undefined || isAccordAuthor(input.author), 'invalid_input', 'author 须为 ed25519:<64 位十六进制>');
    const limit = input.limit ?? MAX_ACCORD_RECORDS_LIMIT;
    const all = friends.read(input.kind, input.author ? { author: input.author } : {})
      .map(({ record: one, local }) => ({ author: one.author, kind: one.kind, id: one.id, version: one.version, body: one.body ?? {}, local }))
      .sort(newest);
    // Whole the answer is at most `MAX_ACCORD_RESPONSE_BYTES` as JSON: its frame, each record and the comma before it; one
    // record is always given.
    const records = [];
    let size = Buffer.byteLength('{"records":[],"truncated":false}', 'utf8');
    for (const one of all.slice(0, limit)) {
      const next = size + (records.length > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(one), 'utf8');
      if (records.length > 0 && next > MAX_ACCORD_RESPONSE_BYTES) break;
      records.push(one);
      size = next;
    }
    return { records, truncated: records.length < all.length };
  }, { admit: ({ caller }) => check(caller === calls.self(), 'forbidden', '好友与 Accord 记录只在本机读取') });
}
