import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SESSION_PROTOCOL } from '@coda-console/protocol/protocol';
import { WechatProvider, SESSION } from '../../../plugins/wechat/lib/provider.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';

// The provider against the synchronized host API and a fake phone bridge. The host keeps records in memory, checks spec and
// status against coda/session@1 and rejects stale revisions; storage, mirroring and calls belong to Coda's tests.
const manifest = JSON.parse(readFileSync(new URL('../../../plugins/wechat/package.json', import.meta.url), 'utf8'));
function host() {
  const types = new ProtocolTypes(), objects = new Map(), listeners = new Set(), operations = new Map(), published = [];
  types.register({ kind: SESSION, spec: SESSION_PROTOCOL.spec, status: SESSION_PROTOCOL.status, participants: () => [] });
  let revision = 0;
  const emit = event => { for (const fn of listeners) fn(structuredClone(event)); };
  const watch = async (_kind, fn) => {
    listeners.add(fn);
    for (const object of objects.values()) fn({ type: 'ADDED', id: object.id, object: structuredClone(object) });
    return { dispose: () => listeners.delete(fn) };
  };
  const call = async (method, args) => {
    const id = method === 'put' ? args[0].id : args[1], old = objects.get(id);
    if (method === 'publish') { published.push(id); return { published: args[2] }; }
    if (method === 'delete') { objects.delete(id); emit({ type: 'DELETED', id, object: old }); return true; }
    const expected = method === 'put' ? args[0].revision : args[3];
    if (old && expected !== old.revision) throw new Error('revision conflict');
    const spec = method === 'put' || method === 'update' ? (args[0].spec ?? args[2]) : old.spec;
    const status = method === 'setStatus' ? args[2] : old?.status ?? args[0].status;
    validate(types.get(SESSION).spec, spec, 'spec'); validate(types.get(SESSION).status, status, 'status');
    const object = { kind: SESSION, id, provider: 'wechat', spec, status, instance: old?.instance ?? randomUUID(), revision: String(++revision) };
    objects.set(id, object); emit({ type: old ? 'MODIFIED' : 'ADDED', id, object }); return structuredClone(object);
  };
  const coda = { protocols: providerAPI({ call, watch, plugin: { id: manifest.id, ...manifest.contributes }, operations }) };
  const read = (id, input = {}) => operations.get(JSON.stringify([SESSION, 'read']))(input, { record: { kind: SESSION, id } });
  return { coda, objects, published, read };
}

// The phone as the bridge sees it: accounts, their groups and each group's messages, and a switch for losing it.
function phone() {
  const groups = new Map(), watchers = new Set();
  const state = { lost: null };
  const me = { id: 'wxid_me', name: '我' };
  const reach = () => { if (state.lost) throw new Error(state.lost); };
  const bridge = {
    async accounts() {
      reach();
      return [{ ...me, groups: [...groups.values()].map(({ messages, ...group }) => ({ ...group, last: messages.at(-1)?.seq ?? null })) }];
    },
    async messages(account, group, { after, before, limit }) {
      reach();
      assert.equal(account, me.id);
      const all = groups.get(group).messages;
      if (after !== undefined) return all.filter(m => m.seq > after).slice(0, limit);
      return all.filter(m => before === undefined || m.seq < before).slice(-limit);
    },
    watch(listener) { watchers.add(listener); return { dispose: () => watchers.delete(listener) }; },
  };
  return {
    bridge, me, state,
    group(id, name, members) { groups.set(id, { id, name, members: [me, ...members], messages: [] }); },
    say(group, sender, senderName, text) {
      const messages = groups.get(group).messages, seq = (messages.at(-1)?.seq ?? 0) + 7;
      messages.push({ seq, id: `msg-${seq}`, sender, senderName, text });
      for (const watcher of watchers) watcher.message({ account: me.id, group, seq });
    },
    leave(id) { groups.delete(id); },
    changed() { for (const watcher of watchers) watcher.changed(); },
  };
}

async function setup(t) {
  const h = host(), p = phone();
  p.group('family@chatroom', '家里', [{ id: 'wxid_mom', name: '妈妈' }]);
  for (let i = 1; i <= 5; i++) p.say('family@chatroom', 'wxid_mom', '妈妈', `第 ${i} 条`);
  p.group('work@chatroom', '工作', [{ id: 'wxid_boss', name: '老板' }]);
  const provider = new WechatProvider(h.coda, p.bridge);
  t.after(() => provider.stop());
  await provider.start();
  return { h, p, provider };
}
const texts = page => page.messages.map(m => m.text);

test('每个群一条已发布的记录：群名、登录账号作容器，成员里 self 是这个账号，head 是最新一条', async t => {
  const { h } = await setup(t);
  assert.deepEqual(h.published, ['wxid_me:family@chatroom', 'wxid_me:work@chatroom']);
  const family = h.objects.get('wxid_me:family@chatroom');
  assert.deepEqual(family.spec, { title: '家里', container: { id: 'wxid_me', title: '我' } });
  assert.deepEqual(family.status, {
    participants: [{ id: 'wxid_me', name: '我', kind: 'person', self: true }, { id: 'wxid_mom', name: '妈妈', kind: 'person' }],
    head: '35', state: 'active',
  });
  assert.deepEqual(h.objects.get('wxid_me:work@chatroom').status, {
    participants: [{ id: 'wxid_me', name: '我', kind: 'person', self: true }, { id: 'wxid_boss', name: '老板', kind: 'person' }],
    state: 'active',
  });
});

test('来一条消息 head 就推进到它，读得到这一条', async t => {
  const { h, p, provider } = await setup(t);
  const before = h.objects.get('wxid_me:work@chatroom').status;
  p.say('work@chatroom', 'wxid_boss', '老板', '开会');
  await provider.queue;
  const status = h.objects.get('wxid_me:work@chatroom').status;
  assert.deepEqual(status, { ...before, head: '7' });
  assert.deepEqual(await h.read('wxid_me:work@chatroom', {}),
    { messages: [{ id: 'msg-7', cursor: '7', sender: 'wxid_boss', senderName: '老板', text: '开会' }], cursor: '7', more: false });
});

test('read：不带游标是最新一页，before 往前翻，after 往后读，more 说那一头还有没有', async t => {
  const { h, p, provider } = await setup(t);
  const id = 'wxid_me:family@chatroom';
  const latest = await h.read(id, { limit: 2 });
  assert.deepEqual([texts(latest), latest.cursor, latest.more], [['第 4 条', '第 5 条'], '35', true]);
  assert.deepEqual(latest.messages[0], { id: 'msg-28', cursor: '28', sender: 'wxid_mom', senderName: '妈妈', text: '第 4 条' });

  const earlier = await h.read(id, { before: latest.messages[0].cursor, limit: 2 });
  assert.deepEqual([texts(earlier), earlier.more], [['第 2 条', '第 3 条'], true]);
  const earliest = await h.read(id, { before: earlier.messages[0].cursor, limit: 2 });
  assert.deepEqual([texts(earliest), earliest.more], [['第 1 条'], false]);
  assert.deepEqual(await h.read(id, { before: earliest.messages[0].cursor }), { messages: [], cursor: null, more: false });

  const forward = await h.read(id, { after: earliest.messages[0].cursor, limit: 3 });
  assert.deepEqual([texts(forward), forward.cursor, forward.more], [['第 2 条', '第 3 条', '第 4 条'], '28', true]);
  const rest = await h.read(id, { after: forward.cursor, limit: 3 });
  assert.deepEqual([texts(rest), rest.cursor, rest.more], [['第 5 条'], '35', false]);
  assert.deepEqual(await h.read(id, { after: rest.cursor }), { messages: [], cursor: '35', more: false });

  p.say('family@chatroom', 'wxid_me', '我', '收到');
  await provider.queue;
  assert.equal(h.objects.get(id).status.head, '42');
  const next = await h.read(id, { after: rest.cursor });
  assert.deepEqual([texts(next), next.messages[0].sender, next.cursor, next.more], [['收到'], 'wxid_me', '42', false]);
  assert.deepEqual(texts(await h.read(id)), ['第 1 条', '第 2 条', '第 3 条', '第 4 条', '第 5 条', '收到']);
});

test('手机桥读不到时每个群 unreachable 并写原因，接回来恢复 active', async t => {
  const { h, p, provider } = await setup(t);
  const before = h.objects.get('wxid_me:family@chatroom').status;
  p.state.lost = '手机不在线';
  p.changed();
  await provider.queue;
  for (const id of ['wxid_me:family@chatroom', 'wxid_me:work@chatroom']) {
    assert.equal(h.objects.get(id).status.state, 'unreachable');
    assert.equal(h.objects.get(id).status.reason, '手机不在线');
  }
  assert.deepEqual(h.objects.get('wxid_me:family@chatroom').status, { ...before, state: 'unreachable', reason: '手机不在线' });
  await assert.rejects(h.read('wxid_me:family@chatroom'), { message: '手机不在线' });

  p.state.lost = null;
  p.changed();
  await provider.queue;
  assert.deepEqual(h.objects.get('wxid_me:family@chatroom').status, before);
});

test('群改名、换成员、新进的群和退出的群随手机桥改变', async t => {
  const { h, p, provider } = await setup(t);
  p.group('work@chatroom', '项目组', [{ id: 'wxid_boss', name: '老板' }, { id: 'wxid_new', name: '新同事' }]);
  p.group('trip@chatroom', '出游', []);
  p.leave('family@chatroom');
  p.changed();
  await provider.queue;
  const work = h.objects.get('wxid_me:work@chatroom');
  assert.equal(work.spec.title, '项目组');
  assert.deepEqual(work.status.participants.map(m => m.name), ['我', '老板', '新同事']);
  assert.deepEqual([...h.objects.keys()], ['wxid_me:work@chatroom', 'wxid_me:trip@chatroom']);
  assert.deepEqual(h.published.at(-1), 'wxid_me:trip@chatroom');
  p.say('trip@chatroom', 'wxid_me', '我', '出发');
  await provider.queue;
  assert.equal(h.objects.get('wxid_me:trip@chatroom').status.head, '7');
});
