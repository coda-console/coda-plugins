import { readResources } from '../../../check/panel.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Provider, SESSION, recordId, messageId } from '../../../plugins/grok-bot/lib/provider.mjs';
import { NativeAuth } from '../../../plugins/grok-bot/lib/auth.mjs';
import { decode } from '../../../plugins/grok-bot/lib/transcript.mjs';
import { FakeNative } from './native-fixture.mjs';
import { temporary } from './helpers.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { SESSION_PROTOCOL } from '@coda-console/protocol/protocol';
const types = new ProtocolTypes();
// Test the 5.7.0 activity contract while Coda's synced checker still pins 5.6.0.
// coda-protocol 5114657bff89056ffe94fd8988478b0a8b2f37b4, session.json status.activity.
const sessionProtocol = structuredClone(SESSION_PROTOCOL);
sessionProtocol.status.properties.activity = {
  type: 'object',
  properties: {
    participant: { type: 'string', minLength: 1, maxLength: 2048 },
    text: { type: 'string', minLength: 1, maxLength: 200, not: { pattern: '[\\r\\n\\u2028\\u2029]' } },
  },
  required: ['participant', 'text'],
  additionalProperties: false,
};
for (const d of [sessionProtocol]) types.register({ ...d, kind: d.name, participants: () => [] });
const until = async fn => { for (let i=0; i<200; i++) { if (fn()) return; await delay(5); } assert.fail('condition timed out'); };
// The records of the new interface (`put`, `delete`, `replace`), kept whole as a plugin writes them. A record has the plugin
// that holds it: writing or deleting another plugin's is refused, and `replace` only clears the caller's own.
function host(root) {
  const records = new Map(), handlers = new Map(), writes = [], self = 'grok-bot'; let version = 0, failing = null;
  const fails = op => { if (failing === op) { failing = null; throw new Error('宿主没有收'); } };
  const key = (kind, id) => `${kind}/${id}`;
  const own = (kind, id) => { const held = records.get(key(kind, id)); if (held && held.owner !== self) throw new Error(`${held.owner} holds ${id}`); };
  const save = (kind, id, { spec, status = {} }) => {
    validate(types.get(kind).spec, spec, 'spec'); validate(types.get(kind).status, status, 'status');
    own(kind, id); writes.push(id); records.set(key(kind, id), { owner: self, kind, id, spec, status, version: String(++version) });
  };
  const coda = { plugin: { id: self, state: root },
    handle: (kind, op, fn) => { handlers.set(`${kind}/${op}`, fn); return { dispose() {} }; },
    error: (code, message, { effects } = {}) => Object.assign(new Error(message), { code, effects: effects ?? 'unknown' }),
    put: async ({ kind, id }, body) => { fails('put'); save(kind, id, body); },
    delete: async ({ kind, id }) => { own(kind, id); writes.push(id); records.delete(key(kind, id)); },
    replace: async (kind, items) => {
      fails('replace');
      for (const item of items) own(kind, item.id);
      for (const [k, held] of records) if (held.kind === kind && held.owner === self) records.delete(k);
      for (const { id, ...body } of items) save(kind, id, body);
    } };
  // What another plugin, or Coda itself, holds on this machine.
  const foreign = (owner, kind, id, spec, status = {}) => records.set(key(kind, id), { owner, kind, id, spec, status, version: String(++version) });
  return { coda, handlers, records, writes, foreign, fail: op => { failing = op; } };
}
async function fixture(t, loggedIn = true, setup = () => {}) {
  const root = temporary(t), native = new FakeNative(), h = host(root);
  if (loggedIn) writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'fixture' }));
  native.handler = async (method, params) => {
    if (method === 'GetMe') return Response.json({ authId: 'stable-account', name: '本人' });
    if (method === 'SendGrokBotUserMessage') native.emit(native.row(params.messageId, { kind: 'message', role: 'user', content: params.text, clientNonce: params.messageId, replyToId: params.replyToId }));
    if (method === 'RespondGrokBotWidget') {
      const row = native.entries.find(r => r.entryId === params.entryId);
      const event = native.row(row.entryId, { ...decode(row), respondedValue: params.value }, 3);
      event.rows.entries[0].seq = row.seq; native.emit(event);
    }
  };
  setup(native, h);
  const auth = new NativeAuth({ root, fetcher: native.fetch });
  const provider = new Provider(h.coda, { auth, stableMs: 10 });
  await provider.start(); t.after(() => provider.stop());
  if (loggedIn) await until(() => native.connections.length);
  return { ...h, provider, native, auth, root, id: () => [...provider.bots.keys()][0] };
}
// What the plugin host hands a doing handler; `progress` collects what it reports.
function call(f, id = 'call', controller = new AbortController()) {
  const progress = [];
  return { id, record: { kind: SESSION, id: f.id() }, signal: controller.signal, deadline: null, progress: text => progress.push(text), controller, reports: progress };
}

test('resource login followed by refresh lists stable per-bot records and person/agent participants', async t => {
  const f=await fixture(t,false); assert.equal(f.provider.records.size,0);
  f.native.pollAnswers=[{accessToken:'fixture'}];
  const login=f.auth.login(); assert.equal(new URL(login.url).hostname,'cursor.com'); await login.promise;
  await f.provider.sync(); assert.equal(f.provider.records.size,1);
  const record=f.provider.records.get(f.id());
  assert.equal(f.id(),recordId(record.spec.container.id,'inspector'));
  assert.deepEqual(record.status.participants.map(p=>[p.kind,!!p.self]),[['person',true],['agent',false]]);
  assert.deepEqual(f.records.get(`${SESSION}/${f.id()}`),{owner:'grok-bot',kind:SESSION,id:f.id(),spec:record.spec,status:record.status,version:f.records.get(`${SESSION}/${f.id()}`).version});
  await f.provider.sync(); assert.equal(f.id(),recordId(record.spec.container.id,'inspector'));
});

test('sessions of Coda and of other plugins on this machine are never written or deleted; a leftover of an earlier run is dropped', async t => {
  const session = { title: '别人的会话', container: { id: 'someone', title: '别人' } }, status = { participants: [], state: 'active' };
  const f = await fixture(t, true, (native, h) => {
    h.foreign('coda', SESSION, 'thread-1', session, status);
    h.foreign('wechat', SESSION, 'wechat:friend', session, status);
    h.foreign('grok-bot', SESSION, 'grok-bot:old:gone', session, status);
  });
  const others = () => [...f.records.values()].filter(r => r.owner !== 'grok-bot');
  const before = structuredClone(others());
  assert.equal(before.length, 2);
  assert.deepEqual([...f.records.values()].filter(r => r.owner === 'grok-bot').map(r => r.id), [f.id()]);
  // A message moves the head and a later sync finds the Bot gone: both only touch the plugin's own record.
  f.native.emit(f.native.row('a', { kind: 'send-message', message: { type: 'text', content: 'first' } }, 1));
  await until(() => f.provider.records.get(f.id()).status.head === '0:1');
  assert.equal(f.records.get(`${SESSION}/${f.id()}`).status.head, '0:1');
  const original = f.native.handler;
  f.native.handler = async (method, params) => method === 'ListGrokBotAgents' ? Response.json({ agents: [] }) : original(method, params);
  const id = f.id();
  await f.provider.sync();
  assert.equal(f.records.has(`${SESSION}/${id}`), false);
  assert.deepEqual(others(), before);
  assert.ok(f.writes.every(written => written === id), `wrote ${f.writes}`);
});

test('a write the host did not take is made again, not skipped as the same', async t => {
  const f = await fixture(t), key = `${SESSION}/${f.id()}`, id = f.id();
  const status = { ...f.provider.records.get(id).status, state: 'unreachable', reason: 'x' };
  f.fail('put');
  await assert.rejects(f.provider.write(id, status), /宿主没有收/);
  assert.equal(f.records.get(key).status.state, 'active');
  await f.provider.write(id, status);
  assert.equal(f.records.get(key).status.reason, 'x');
  // The same when the failed put is found by the next sync, not by a second write of it.
  const next = { ...status, reason: 'y' };
  f.fail('put');
  await assert.rejects(f.provider.write(id, next), /宿主没有收/);
  await f.provider.sync();
  assert.equal(f.records.get(key).status.state, 'active');
  assert.equal(f.records.get(key).status.reason, undefined);
});

test('the last Bot going away is dropped from the host on a later sync even when the first replace was refused', async t => {
  const f = await fixture(t), key = `${SESSION}/${f.id()}`, original = f.native.handler;
  f.native.handler = async (method, params) => method === 'ListGrokBotAgents' ? Response.json({ agents: [] }) : original(method, params);
  f.fail('replace');
  await f.provider.sync();
  assert.ok(f.records.has(key));
  await f.provider.sync();
  assert.equal(f.records.has(key), false);
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

test('post uses call-derived UUID, reports progress and confirms the stream echo without reading history', async t => {
  const f=await fixture(t), ctx=call(f);
  const reads=f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length;
  const result=await f.provider.post({text:'hello'},ctx);
  assert.equal(result.message.id,`0:${messageId('call',f.id())}`);
  assert.deepEqual(ctx.reports,['正在发送']);
  assert.deepEqual(Object.keys(result),['message']); assert.deepEqual(Object.keys(result.message).sort(),['cursor','id']);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
  assert.equal(f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length,reads);
});

test('widget is text options; reply responds once and returns the self reply', async t => {
  const f=await fixture(t); await until(()=>f.native.connections.length);
  f.native.emit(f.native.row('widget',{kind:'send-message',message:{type:'widget',widget:{prompt:'Choose',options:[{label:'Yes',value:'yes'}]}}},1));
  await until(()=>f.provider.records.get(f.id()).status.head==='0:1');
  assert.equal((await f.provider.read(f.id())).messages[0].text,'Choose\nYes');
  const result=await f.provider.post({text:'Yes',replyTo:'0:widget'},call(f,'widget-answer'));
  assert.equal(f.native.requests.filter(r=>r.method==='RespondGrokBotWidget').length,1);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,0);
  const reply=(await f.provider.read(f.id(),{after:'0:1'})).messages[0];
  assert.equal(result.message.id,reply.id);
  assert.equal(reply.sender,f.provider.bots.get(f.id()).self); assert.equal(reply.replyTo,'0:widget');
  assert.deepEqual(reply.mentions,['inspector']);
});

test('failure before sending says effects none; once sending started it is unknown and never retried', async t => {
  const f=await fixture(t); const original=f.native.handler;
  const input={text:'audio',parts:[{type:'audio',upload:'x'}]};
  await assert.rejects(f.provider.post(input,call(f,'media')),{code:'unsupported',effects:'none'});
  await assert.rejects(f.provider.post({text:'x',replyTo:'0:missing'},call(f,'reply')),{code:'invalid',effects:'none'});
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,0);
  f.native.handler=async (method,params)=>{if(method==='SendGrokBotUserMessage')throw new Error('lost');return original(method,params);};
  await assert.rejects(f.provider.post({text:'hello'},call(f)),{code:'unknown',effects:'unknown',message:'lost'});
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
});

test('server refusing (false) says effects none; a missing field stays unknown', async t => {
  const f=await fixture(t); const original=f.native.handler;
  f.native.handler=async (method,params)=>method==='SendGrokBotUserMessage'?Response.json({dispatched:false}):original(method,params);
  await assert.rejects(f.provider.post({text:'no'},call(f,'refused')),{code:'refused',effects:'none'});
  f.native.handler=async (method,params)=>method==='SendGrokBotUserMessage'?Response.json({}):original(method,params);
  await assert.rejects(f.provider.post({text:'missing'},call(f,'missing')),{code:'unknown',effects:'unknown'});
});

test('authentication rejected (401/403, or refresh failed) says effects none; other statuses stay unknown', async t => {
  const f=await fixture(t); const original=f.native.handler;
  const reply=status=>(method,params)=>method==='SendGrokBotUserMessage'?new Response('{}',{status}):original(method,params);
  f.native.handler=reply(401);
  await assert.rejects(f.provider.post({text:'a'},call(f,'a')),{code:'unauthorized',effects:'none',message:/请在资源页重新登录.*HTTP 401/});
  f.native.handler=reply(403);
  await assert.rejects(f.provider.post({text:'b'},call(f,'b')),{code:'unauthorized',effects:'none',message:/^(?!.*重新登录)/s});
  for (const status of [400,429,500]) {
    f.native.handler=reply(status);
    await assert.rejects(f.provider.post({text:'c'},call(f,`c${status}`)),{code:'unknown',effects:'unknown'});
  }
  f.auth.use({accessToken:'fixture',refreshToken:'refresh'});
  f.native.handler=async (method,params)=>method==='token'?Response.json({},{status:400}):reply(401)(method,params);
  await assert.rejects(f.provider.post({text:'d'},call(f,'d')),{code:'unauthorized',effects:'none'});
});

test('renewal failing after a 401 says effects none whether offline or timed out; after renewal, only 401/403 is none', async t => {
  const f=await fixture(t); const original=f.native.handler;
  const rejected=(method,params)=>method==='SendGrokBotUserMessage'?new Response('{}',{status:401}):original(method,params);
  f.auth.use({accessToken:'fixture',refreshToken:'refresh'});
  f.native.handler=async (method,params)=>{if(method==='token')throw new TypeError('fetch failed');return rejected(method,params);};
  await assert.rejects(f.provider.post({text:'a'},call(f,'offline')),{code:'unauthorized',effects:'none',message:/^(?!.*重新登录).*续期失败.*fetch failed/s});
  f.native.handler=async (method,params)=>{if(method==='token')throw new DOMException('timed out','TimeoutError');return rejected(method,params);};
  await assert.rejects(f.provider.post({text:'b'},call(f,'timeout')),{code:'unauthorized',effects:'none',message:/续期失败/});
  // Renewed: the resend is a new request, so a lost connection is unknown, a rejection is none.
  const renew=resend=>{
    let sends=0;
    return async (method,params)=>{
      if(method==='token')return Response.json({access_token:'renewed'});
      if(method==='SendGrokBotUserMessage')return ++sends===1?new Response('{}',{status:401}):resend();
      return original(method,params);
    };
  };
  f.auth.use({accessToken:'fixture',refreshToken:'refresh'});
  f.native.handler=renew(()=>{throw new Error('lost');});
  await assert.rejects(f.provider.post({text:'c'},call(f,'lost')),{code:'unknown',effects:'unknown',message:'lost'});
  f.auth.use({accessToken:'fixture',refreshToken:'refresh'});
  f.native.handler=renew(()=>new Response('{}',{status:401}));
  await assert.rejects(f.provider.post({text:'d'},call(f,'again')),{code:'unauthorized',effects:'none',message:/请在资源页重新登录/});
});

test('the Bot list loop shows the original error when renewal fails offline, and asks for login when it is rejected', async t => {
  const f=await fixture(t); const original=f.native.handler;
  const reason=()=>f.provider.records.get(f.id()).status.reason;
  // sync reloads the credentials file, so the refresh token must be on disk.
  writeFileSync(join(f.root,'native-auth.json'),JSON.stringify({accessToken:'fixture',refreshToken:'refresh'}));
  f.native.handler=async (method,params)=>{
    if(method==='token')throw new TypeError('fetch failed');
    return method==='GetMe'?new Response('{}',{status:401}):original(method,params);
  };
  await f.provider.sync();
  assert.equal(reason(),'fetch failed');
  f.native.handler=async (method,params)=>{
    if(method==='token')return Response.json({},{status:400});
    return method==='GetMe'?new Response('{}',{status:401}):original(method,params);
  };
  await f.provider.sync();
  assert.equal(reason(),'请在资源页重新登录');
});

test('widget answer refused (false) says effects none; a missing field stays unknown', async t => {
  const f=await fixture(t); await until(()=>f.native.connections.length); const original=f.native.handler;
  f.native.emit(f.native.row('widget',{kind:'send-message',message:{type:'widget',widget:{prompt:'Choose',options:[{label:'Yes',value:'yes'}]}}},1));
  await until(()=>f.provider.records.get(f.id()).status.head==='0:1');
  f.native.handler=async (method,params)=>method==='RespondGrokBotWidget'?Response.json({accepted:false}):original(method,params);
  await assert.rejects(f.provider.post({text:'Yes',replyTo:'0:widget'},call(f,'refused')),{code:'refused',effects:'none'});
  f.native.handler=async (method,params)=>method==='RespondGrokBotWidget'?Response.json({}):original(method,params);
  await assert.rejects(f.provider.post({text:'Yes',replyTo:'0:widget'},call(f,'missing')),{code:'unknown',effects:'unknown'});
});

test('cancel before sending throws the signal reason and sends nothing; cancel after sending started still returns the message', async t => {
  const f=await fixture(t), before=call(f,'before');
  before.controller.abort();
  await assert.rejects(f.provider.post({text:'never'},before),e=>e===before.controller.signal.reason&&e.name==='AbortError');
  assert.deepEqual(before.reports,[]);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,0);
  const original=f.native.handler, after=call(f,'after');
  f.native.handler=async (method,params)=>{if(method==='SendGrokBotUserMessage')after.controller.abort();return original(method,params);};
  const result=await f.provider.post({text:'already out'},after);
  assert.equal(result.message.id,`0:${messageId('after',f.id())}`);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
});

test('only changed stream rows wait for stability; reads and settling never fetch history', async t => {
  const f=await fixture(t);
  const reads=f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length;
  for(let seq=1;seq<=5;seq++) {
    const event=f.native.row('stream',{kind:'send-message',message:{type:'text',content:`part ${seq}`}},seq);
    event.rows.entries[0].seq='1'; f.native.emit(event);
    await delay(3);
    assert.equal(f.provider.records.get(f.id()).status.head,undefined);
    assert.equal((await f.provider.read(f.id())).messages.length,0);
  }
  await until(()=>f.provider.records.get(f.id()).status.head==='0:5');
  const page=await f.provider.read(f.id());
  assert.equal(page.messages[0].id,'0:stream'); assert.equal(page.messages[0].about,undefined);
  assert.equal(f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length,reads);
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

test('a completed stream in the baseline is ordinary; only changes after exposure become edits', async t => {
  const f=await fixture(t,true,native=>{
    const event=native.row('finished',{kind:'send-message',message:{type:'text',content:'finished before startup'}},9);
    event.rows.entries[0].seq='5';
  });
  await until(()=>f.provider.records.get(f.id()).status.head==='0:9');
  let page=await f.provider.read(f.id());
  assert.equal(page.messages.length,1);
  assert.equal(page.messages[0].id,'0:finished');
  assert.equal(page.messages[0].cursor,'0:9');
  assert.equal(page.messages[0].about,undefined);
  const event=f.native.row('finished',{kind:'send-message',message:{type:'text',content:'changed after exposure'}},10);
  event.rows.entries[0].seq='5'; f.native.emit(event);
  await until(()=>f.provider.records.get(f.id()).status.head==='0:10');
  page=await f.provider.read(f.id());
  assert.equal(page.messages.length,2);
  assert.equal(page.messages[0].text,'finished before startup');
  assert.deepEqual(page.messages[1].about,{message:'0:finished',change:'edit'});
  assert.equal(page.messages[1].id,'0:finished:edit:10');
  assert.equal((await f.provider.read(f.id(),{after:'0:9'})).messages.length,1);
});

test('reconnect and cursor resets rebuild once, then resume incremental rows', async t => {
  const f=await fixture(t);
  // Keep the production reconnect delay out of this focused fake-server test.
  const realTimeout=f.provider.clock.setTimeout;
  f.provider.clock.setTimeout=(fn,ms)=>realTimeout(fn,ms===2000?1:ms);
  const reads=()=>f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length;
  assert.equal(reads(),1);
  f.native.row('offline',{kind:'send-message',message:{type:'text',content:'during disconnect'}},1);
  f.native.drop();
  await until(()=>f.native.connections.length===2 && f.provider.records.get(f.id()).status.head==='0:1');
  assert.equal(reads(),2);
  f.native.emit({cursorTooOld:{agentId:'inspector',sessionId:''}});
  await until(()=>f.native.connections.length===3); assert.equal(reads(),3);
  f.native.generation=1; f.native.entries=[];
  f.native.emit({cleared:{agentId:'inspector',sessionId:''}});
  await until(()=>f.native.connections.length===4); assert.equal(reads(),4);
  assert.equal(f.provider.records.get(f.id()).status.head,undefined);
  assert.deepEqual((await f.provider.read(f.id())).messages,[]);
  await assert.rejects(f.provider.read(f.id(),{after:'0:1'}),/重置/);
  f.native.emit(f.native.row('new',{kind:'send-message',message:{type:'text',content:'new generation'}},1));
  await until(()=>f.provider.records.get(f.id()).status.head==='1:1');
  assert.equal((await f.provider.read(f.id())).messages[0].id,'1:new');
  assert.equal(reads(),4);
});

const liveEvent = live => ({ agentState: { live: [{ agentId: 'inspector', sessionId: '', ...live }] } });
const settlement = { turnId: 'turn', outcome: 'success', settledAtMs: '100' };

test('Watch live activity changes status only; busy work ignores old settlement and idle settlement clears it', async t => {
  const f = await fixture(t), status = () => f.provider.records.get(f.id()).status;
  f.native.emit(f.native.row('reply', { kind: 'send-message', message: { type: 'text', content: 'hello' } }, 1));
  await until(() => status().head === '0:1');
  const page = await f.provider.read(f.id()), requests = f.native.requests.length;
  f.native.emit(liveEvent({ isRunning: true, activity: { kind: 'thinking' } }));
  await until(() => status().activity?.text === 'Grok 正在思考');
  assert.equal(status().activity.participant, status().participants.find(p => p.kind === 'agent').id);
  f.native.emit(liveEvent({ isRunning: true, activity: { kind: 'tool', tool: 'SetStatus', detail: '检查机器' }, lastTurnSettlement: settlement }));
  await until(() => status().activity?.text === '检查机器');
  assert.equal(status().head, '0:1');
  assert.deepEqual(await f.provider.read(f.id()), page);
  assert.equal(f.native.requests.length, requests);
  // Neither transcript flush nor the periodic Bot list refresh loses activity.
  await f.provider.flush(f.id());
  await f.provider.sync();
  assert.equal(status().activity.text, '检查机器');
  f.native.emit(liveEvent({ hasRunningSubagents: true, lastTurnSettlement: settlement }));
  await until(() => !Object.hasOwn(status(), 'activity'));
  assert.equal(status().head, '0:1');
  assert.deepEqual(await f.provider.read(f.id()), page);
});

test('activity uses a readable first line bounded to 200 characters and ignores other sessions', async t => {
  const f = await fixture(t), status = () => f.provider.records.get(f.id()).status;
  f.native.emit(liveEvent({ activity: { kind: 'tool', tool: 'ReadFile\r\nignored' } }));
  await until(() => status().activity?.text === 'ReadFile');
  const text = '思😀'.repeat(150);
  f.native.emit(liveEvent({ activity: { kind: 'thinking', detail: `  ${text}\u2028ignored` } }));
  await until(() => status().activity?.text === [...text].slice(0, 200).join(''));
  assert.equal([...status().activity.text].length, 200);
  assert.doesNotMatch(status().activity.text, /[\r\n\u2028\u2029]/u);
  assert.equal(status().head, undefined);
  assert.deepEqual((await f.provider.read(f.id())).messages, []);
  f.native.emit(liveEvent({ agentId: 'other', lastTurnSettlement: settlement }));
  f.native.emit(liveEvent({ sessionId: 'subagent', lastTurnSettlement: settlement }));
  // A following main-session update is a barrier for the ignored events.
  f.native.emit(liveEvent({ activity: { kind: 'tool', tool: 'Next' } }));
  await until(() => status().activity?.text === 'Next');
  f.native.emit(liveEvent({ lastTurnSettlement: { ...settlement, outcome: 'cancelled' } }));
  await until(() => !Object.hasOwn(status(), 'activity'));
});

test('rebuilding the transcript mirror also rebuilds live state', async t => {
  const f = await fixture(t), status = () => f.provider.records.get(f.id()).status;
  const realTimeout = f.provider.clock.setTimeout;
  f.provider.clock.setTimeout = (fn, ms) => realTimeout(fn, ms === 2000 ? 1 : ms);
  f.native.emit(liveEvent({ activity: { kind: 'tool', tool: 'Before reconnect' } }));
  await until(() => status().activity);
  f.native.drop();
  await until(() => f.native.connections.length === 2);
  assert.equal(status().activity, undefined);
  assert.equal(f.provider.mirrors.get(f.id()).live, undefined);
  f.native.emit({ agentState: { ...liveEvent({ activity: { kind: 'tool', tool: 'After reconnect' } }).agentState, snapshot: true } });
  await until(() => status().activity?.text === 'After reconnect');
  f.native.generation = 1; f.native.entries = [];
  f.native.emit({ cleared: { agentId: 'inspector', sessionId: '' } });
  await until(() => f.native.connections.length === 3);
  assert.equal(status().activity, undefined);
  assert.equal(status().head, undefined);
});
test('session read, draft and post answer through the registered handlers and the resource list has no actions', async t => {
  const f = await fixture(t), handle = (op, input, ctx) => f.handlers.get(`${SESSION}/${op}`)(input, ctx);
  assert.deepEqual([...f.handlers.keys()].sort(), [`${SESSION}/draft`, `${SESSION}/post`, `${SESSION}/read`]);
  // post is registered as a function, not an object carrying `resume`: a registered `resume` would change what users see after a restart.
  assert.equal(typeof f.handlers.get(`${SESSION}/post`), 'function');
  assert.deepEqual(await handle('draft', { text: 'unsent' }), {});
  const ctx = call(f, 'handler-call');
  const result = await handle('post', { text: 'via handler' }, ctx);
  assert.equal(f.native.requests.filter(r => r.method === 'SendGrokBotUserMessage').length, 1);
  const read = await handle('read', {}, ctx);
  assert.equal(read.messages.at(-1).text, 'via handler');
  assert.equal(read.messages.at(-1).id, result.message.id);
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/grok-bot/package.json', import.meta.url)));
  const preload = join(f.root, 'native-preload.mjs');
  writeFileSync(preload, `import { FakeNative } from ${JSON.stringify(new URL('./native-fixture.mjs', import.meta.url).href)};
    const native = new FakeNative();
    native.handler = async method => method === 'GetMe' ? Response.json({ authId: 'stable-account', name: '本人' }) : undefined;
    globalThis.fetch = native.fetch;`);
  const resource = await promisify(execFile)(process.execPath, ['--import', preload, new URL('../../../plugins/grok-bot/scripts/resources.mjs', import.meta.url).pathname], { env: { ...process.env, CODA_PLUGIN_STATE: f.root } });
  const rows = readResources(resource.stdout, manifest.contributes.resources[0], []);
  assert.equal(rows[0].identity, f.id());
  assert.deepEqual(rows[0].actions, []);
  assert.deepEqual(manifest.coda, { channels: ['preview'] });
  assert.equal(manifest.contributes.views, undefined);
  assert.deepEqual(manifest.contributes.protocolImplementations, [SESSION]);
});
