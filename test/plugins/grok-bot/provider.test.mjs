import { readResources } from '../../../check/panel.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
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
for (const d of [sessionProtocol, RUN_PROTOCOL]) types.register({ ...d, kind: d.name, participants: () => [] });
const until = async fn => { for (let i=0; i<200; i++) { if (fn()) return; await delay(5); } assert.fail('condition timed out'); };
function host(root) {
  const records = new Map(), watchers = [], handlers = new Map(), views = new Map(); let revision = 0;
  const key = (kind, id) => `${kind}/${id}`;
  const save = object => {
    validate(types.get(object.kind).spec, object.spec, object.kind);
    validate(types.get(object.kind).status, object.status, object.kind);
    object = { ...object, provider: 'grok-bot', revision: String(++revision) }; records.set(key(object.kind, object.id), object);
    for (const w of watchers) if (w.kind === object.kind) w.fn({ type: 'MODIFIED', id: object.id, object });
    return object;
  };
  const coda = { plugin: { id: 'grok-bot', state: root }, views: { register: (id, handler) => views.set(id, handler) }, protocols: {
    observe: async (kind, fn) => { const w = { kind, fn }; watchers.push(w); for (const o of records.values()) if (o.kind === kind) fn({ type: 'ADDED', id: o.id, object: o }); return { dispose() { watchers.splice(watchers.indexOf(w), 1); } }; },
    handle: (kind, op, fn) => { handlers.set(`${kind}/${op}`, fn); return { dispose() {} }; },
    put: async o => save(o), publish: async () => {},
    update: async (kind, id, spec, rev) => { const o=records.get(key(kind,id)); assert.equal(rev,o.revision); return save({...o,spec}); },
    setStatus: async (kind,id,status,rev) => { const o=records.get(key(kind,id)); assert.equal(rev,o.revision); return save({...o,status}); },
    delete: async (kind,id) => records.delete(key(kind,id)),
  } };
  return { coda, records, save, handlers, views };
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
  setup(native);
  const auth = new NativeAuth({ root, fetcher: native.fetch });
  const provider = new Provider(h.coda, { auth, stableMs: 10 });
  await provider.start(); t.after(() => provider.stop());
  if (loggedIn) await until(() => native.connections.length);
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

test('post uses request-derived UUID and confirms the stream echo without reading history', async t => {
  const f=await fixture(t), context=run(f);
  const reads=f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length;
  await f.provider.post({text:'hello'},context);
  const status=f.provider.runs.get(context.run.id).status; assert.equal(status.state,'completed');
  assert.equal(status.result.message.id,`0:${messageId('request',f.id(),context.parent)}`);
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
  assert.equal(f.native.requests.filter(r=>r.method==='ListGrokBotTranscriptEntries').length,reads);
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
  const reply=(await f.provider.read(f.id(),{after:'0:1'})).messages[0];
  assert.equal(reply.sender,f.provider.bots.get(f.id()).self); assert.equal(reply.replyTo,'0:widget');
  assert.deepEqual(reply.mentions,['inspector']);
});

test('ambiguous write fails unknown and is never retried, unsupported media fails before sending', async t => {
  const f=await fixture(t); const original=f.native.handler;
  f.native.handler=async (method,params)=>{if(method==='SendGrokBotUserMessage')throw new Error('lost');return original(method,params);};
  const context=run(f); await f.provider.post({text:'hello'},context);
  assert.equal(f.provider.runs.get(context.run.id).status.result.code,'unknown');
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,1);
  const input={text:'audio',parts:[{type:'audio',upload:'x'}]},other=run(f,'media',input);
  await f.provider.post(input,other); assert.equal(f.provider.runs.get(other.run.id).status.result.code,'unsupported');
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

test('restart marks an unfinished host run unknown without sending it again', async t => {
  const f=await fixture(t), context=run(f);
  await f.provider.stop();
  const restarted=new Provider(f.coda,{auth:f.auth,stableMs:10});
  t.after(()=>restarted.stop()); await restarted.start();
  assert.equal(restarted.runs.get(context.run.id).status.result.code,'unknown');
  assert.equal(f.native.requests.filter(r=>r.method==='SendGrokBotUserMessage').length,0);
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
  await f.provider.schedule(() => f.provider.flush(f.id()));
  await f.provider.schedule(() => f.provider.sync());
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
test('opening bind view sends once as the account and posts success or error to the page', async t => {
  const f = await fixture(t), issued = [];
  f.coda.protocols.remoteCode = async id => {
    issued.push(id);
    return { code: 'one-time-code', expiresAt: new Date(Date.now() + 600000).toISOString(), addresses: ['http://100.64.0.1:8080'] };
  };
  assert.equal(f.native.requests.filter(r => r.method === 'SendGrokBotUserMessage').length, 0);
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/grok-bot/package.json', import.meta.url)));
  const preload = join(f.root, 'native-preload.mjs');
  writeFileSync(preload, `import { FakeNative } from ${JSON.stringify(new URL('./native-fixture.mjs', import.meta.url).href)};
    const native = new FakeNative();
    native.handler = async method => method === 'GetMe' ? Response.json({ authId: 'stable-account', name: '本人' }) : undefined;
    globalThis.fetch = native.fetch;`);
  const resource = await promisify(execFile)(process.execPath, ['--import', preload, new URL('../../../plugins/grok-bot/scripts/resources.mjs', import.meta.url).pathname], { env: { ...process.env, CODA_PLUGIN_STATE: f.root } });
  const rows = readResources(resource.stdout, manifest.contributes.resources[0], manifest.contributes.views.map(view => view.id));
  assert.equal(rows[0].identity, f.id());
  assert.deepEqual(rows[0].actions, [{ label: '绑定', view: 'bind', args: { record: f.id() } }]);

  const results = [];
  const open = record => f.views.get('bind').open({ context: { args: { record } }, postMessage: message => results.push(message) });
  await open(rows[0].actions[0].args.record);
  assert.deepEqual(results, [{ type: 'result', text: '已发给 Bot' }]);
  assert.deepEqual(issued, [f.id()]);
  const sent = f.native.requests.find(r => r.method === 'SendGrokBotUserMessage').params;
  assert.equal(sent.agentId, 'inspector');
  assert.equal(sent.sessionId, '');
  assert.deepEqual([sent.source, sent.initiator, sent.sendSource], [1, 1, 1]);
  assert.equal(sent.text, "请运行下面的命令绑定 Coda：\nnode coda-bot.mjs bind 'http://100.64.0.1:8080' 'one-time-code'");
  await until(() => f.provider.visible(f.id()).some(m => m.text === sent.text));
  assert.equal(f.provider.visible(f.id()).find(m => m.text === sent.text).sender, f.provider.bots.get(f.id()).self);
  assert.equal(f.native.requests.filter(r => r.method === 'SendGrokBotUserMessage').length, 1);
  await open('other-record');
  assert.match(results.at(-1).text, /Bot 已不存在/);
  assert.equal(results.at(-1).type, 'result');
  assert.equal(issued.length, 1);
  f.coda.protocols.remoteCode = async () => ({ code: 'unused', addresses: [] });
  await open(f.id());
  assert.match(results.at(-1).text, /tailnet/);
  assert.equal(f.native.requests.filter(r => r.method === 'SendGrokBotUserMessage').length, 1);
});
