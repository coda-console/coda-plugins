import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Provider, SESSION, RUN, recordId, messageId } from '../../../plugins/grok-bot/lib/provider.mjs';
import { NativeAuth } from '../../../plugins/grok-bot/lib/auth.mjs';
import { decode } from '../../../plugins/grok-bot/lib/transcript.mjs';
import { FakeNative } from './native-fixture.mjs';
import { temporary } from './helpers.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { SESSION_PROTOCOL, RUN_PROTOCOL } from '@coda-console/protocol/protocol';
const types = new ProtocolTypes();
for (const d of [SESSION_PROTOCOL, RUN_PROTOCOL]) types.register({ ...d, kind: d.name, participants: () => [] });
const until = async fn => { for (let i=0; i<200; i++) { if (fn()) return; await delay(5); } assert.fail('condition timed out'); };
function host(root) {
  const records = new Map(), watchers = [], handlers = new Map(); let revision = 0;
  const key = (kind, id) => `${kind}/${id}`;
  const save = object => {
    validate(types.get(object.kind).spec, object.spec, object.kind);
    validate(types.get(object.kind).status, object.status, object.kind);
    object = { ...object, provider: 'grok-bot', revision: String(++revision) }; records.set(key(object.kind, object.id), object);
    for (const w of watchers) if (w.kind === object.kind) w.fn({ type: 'MODIFIED', id: object.id, object });
    return object;
  };
  const coda = { plugin: { id: 'grok-bot', state: root }, protocols: {
    observe: async (kind, fn) => { const w = { kind, fn }; watchers.push(w); for (const o of records.values()) if (o.kind === kind) fn({ type: 'ADDED', id: o.id, object: o }); return { dispose() { watchers.splice(watchers.indexOf(w), 1); } }; },
    handle: (kind, op, fn) => { handlers.set(`${kind}/${op}`, fn); return { dispose() {} }; },
    put: async o => save(o), publish: async () => {},
    update: async (kind, id, spec, rev) => { const o=records.get(key(kind,id)); assert.equal(rev,o.revision); return save({...o,spec}); },
    setStatus: async (kind,id,status,rev) => { const o=records.get(key(kind,id)); assert.equal(rev,o.revision); return save({...o,status}); },
    delete: async (kind,id) => records.delete(key(kind,id)),
  } };
  return { coda, records, save, handlers };
}
async function fixture(t, loggedIn = true) {
  const root = temporary(t), native = new FakeNative(), h = host(root);
  if (loggedIn) writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'fixture' }));
  native.handler = async (method, params) => {
    if (method === 'GetMe') return Response.json({ authId: 'stable-account', name: '本人' });
    if (method === 'SendGrokBotUserMessage') native.row(params.messageId, { kind: 'message', role: 'user', content: params.text, clientNonce: params.messageId, replyToId: params.replyToId });
    if (method === 'RespondGrokBotWidget') {
      const row = native.entries.find(r => r.entryId === params.entryId);
      const event = native.row(row.entryId, { ...decode(row), respondedValue: params.value }, 3);
      event.rows.entries[0].seq = row.seq;
    }
  };
  const auth = new NativeAuth({ root, fetcher: native.fetch });
  const provider = new Provider(h.coda, { auth, stableMs: 10 });
  await provider.start(); t.after(() => provider.stop());
  return { ...h, provider, native, auth, root, id: () => [...provider.bots.keys()][0] };
}
function run(f, requestId='request', input={text:'hello'}, id=requestId) {
  const record={kind:SESSION,id:f.id()}, parent=record;
  f.save({kind:RUN,id,spec:{record,operation:'post',input,requestId,parent,awaited:true},status:{state:'working'}});
  return {record,parent,requestId,run:{kind:RUN,id}};
}

test('resource login followed by refresh lists stable per-bot records and person/agent participants', async t => {
  const f=await fixture(t,false); assert.equal(f.provider.records.size,0);
  f.native.pollAnswers=[{accessToken:'fixture'}];
  const login=f.auth.login(); assert.equal(new URL(login.url).hostname,'cursor.com'); await login.promise;
  await f.provider.sync(); assert.equal(f.provider.records.size,1);
  const record=f.provider.records.get(f.id());
  assert.equal(record.id,recordId(record.spec.container.id,'inspector'));
  assert.deepEqual(record.status.participants.map(p=>[p.kind,!!p.self]),[['person',true],['agent',false]]);
  await f.provider.sync(); assert.equal(f.id(),record.id);
});

test('read latest/before/after, edits, stable head and no Routine mirror', async t => {
  const f=await fixture(t); await until(()=>f.native.connections.length);
  f.native.emit(f.native.row('a',{kind:'send-message',message:{type:'text',content:'first'}},1));
  await until(()=>f.provider.records.get(f.id()).status.head==='0:1');
  f.native.emit(f.native.row('b',{kind:'message',role:'user',content:'second'},2));
  await until(()=>f.provider.records.get(f.id()).status.head==='0:2');
  let page=await f.provider.read(f.id(),{limit:1}); assert.equal(page.messages[0].text,'second'); assert.equal(page.more,true);
  assert.equal((await f.provider.read(f.id(),{before:'0:2'})).messages[0].text,'first');
  const edit=f.native.row('a',{kind:'send-message',message:{type:'text',content:'edited'}},3); edit.rows.entries[0].seq='1';
  f.native.emit(edit);
  assert.equal(f.provider.records.get(f.id()).status.head,'0:2');
  assert.equal((await f.provider.read(f.id(),{after:'0:2'})).messages.length,0);
  await until(()=>f.provider.records.get(f.id()).status.head==='0:3');
  page=await f.provider.read(f.id(),{after:'0:2'});
  assert.deepEqual(page.messages[0].about,{message:'0:a',change:'edit'});
  assert.equal(page.messages[0].text,'edited');
  validate(types.get(SESSION).operations.get('read').result,page,'read');
  f.native.emit({agentStateChanged:{agentId:'inspector',families:['automations','subagents']}});
  f.native.emit(f.native.row('routine',{kind:'routine',text:'done'},4)); await delay(30);
  assert.equal(f.provider.records.get(f.id()).status.head,'0:3');
  assert.ok(!f.native.requests.some(r=>/Subagents|Automations/.test(r.method)));
});

test('post uses request-derived UUID once, confirms native echo, persists deduplication', async t => {
  const f=await fixture(t), context=run(f);
  await f.provider.post({text:'hello'},context);
  const status=f.provider.runs.get(context.run.id).status; assert.equal(status.state,'completed');
  assert.equal(status.result.message.id,`0:${messageId('request',f.id(),context.parent)}`);
  await f.provider.post({text:'hello'},context);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
  const again=new Provider(f.coda,{auth:f.auth}); again.runs=f.provider.runs;
  await again.post({text:'hello'},context);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
});

test('widget is text options; reply responds once and completes with a self reply', async t => {
  const f=await fixture(t); await until(()=>f.native.connections.length);
  f.native.emit(f.native.row('widget',{kind:'send-message',message:{type:'widget',widget:{prompt:'Choose',options:[{label:'Yes',value:'yes'}]}}},1));
  await until(()=>f.provider.records.get(f.id()).status.head==='0:1');
  assert.equal((await f.provider.read(f.id())).messages[0].text,'Choose\nYes');
  const input={text:'Yes',replyTo:'0:widget'},context=run(f,'widget-answer',input);
  await f.provider.post(input,context);
  assert.equal(f.provider.runs.get(context.run.id).status.state,'completed');
  assert.equal(f.native.requests.filter(r=>r.method==='RespondGrokBotWidget').length,1);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,0);
  await f.provider.stable(f.id(),f.provider.controller.signal);
  const reply=(await f.provider.read(f.id(),{after:'0:1'})).messages[0];
  assert.equal(reply.sender,f.provider.bots.get(f.id()).self); assert.equal(reply.replyTo,'0:widget');
  assert.deepEqual(reply.mentions,['inspector']);
});

test('ambiguous write fails unknown and is never retried, unsupported media fails before sending', async t => {
  const f=await fixture(t); const original=f.native.handler;
  f.native.handler=async (method,params)=>{if(method==='SendGrokBotUserMessage')throw new Error('lost');return original(method,params);};
  const context=run(f); await f.provider.post({text:'hello'},context); await f.provider.post({text:'hello'},context);
  assert.equal(f.provider.runs.get(context.run.id).status.result.code,'unknown');
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
  const input={text:'audio',parts:[{type:'audio',upload:'x'}]},other=run(f,'media',input);
  await f.provider.post(input,other); assert.equal(f.provider.runs.get(other.run.id).status.result.code,'unsupported');
});

test('a changing body does not advance head until a subsequent stable observation', async t => {
  const f=await fixture(t); await until(()=>f.native.connections.length);
  const original=f.native.handler; let changing=true, seq=0;
  f.native.handler=async (method,params)=>{
    if(method==='ListGrokBotTranscriptEntries' && changing) {
      const e=f.native.row('stream',{kind:'send-message',message:{type:'text',content:`part ${++seq}`}},seq); e.rows.entries[0].seq='1';
    }
    return original(method,params);
  };
  f.native.emit({rows:{agentId:'inspector',entries:[]}});
  await delay(45); assert.equal(f.provider.records.get(f.id()).status.head,undefined);
  changing=false;
  await until(()=>f.provider.records.get(f.id()).status.head===`0:${seq}`);
});

test('concurrent duplicate post does not race past the persistent request claim', async t => {
  const f=await fixture(t), context=run(f);
  await Promise.all([f.provider.post({text:'hello'},context),f.provider.post({text:'hello'},context)]);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
  assert.equal(f.provider.runs.get(context.run.id).status.state,'completed');
});

test('updatedSeq without a body change does not manufacture an edit', async t => {
  const f=await fixture(t); await until(()=>f.native.connections.length);
  f.native.emit(f.native.row('a',{kind:'send-message',message:{type:'text',content:'same'}},1));
  await until(()=>f.provider.records.get(f.id()).status.head==='0:1');
  const row={...f.native.entries[0],updatedSeq:'2'}; f.native.entries=[row];
  f.native.emit({rows:{agentId:'inspector',entries:[row]}}); await delay(30);
  assert.equal((await f.provider.read(f.id(),{after:'0:1'})).messages.length,0);
  assert.equal(f.provider.records.get(f.id()).status.head,'0:1');
});
