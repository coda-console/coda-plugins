import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createTestHost } from '@coda-console/plugin-check/test-host';
import { activate } from '../main.mjs';

const { contributes, uses } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const NOTE = 'notes/note@1';

async function started() {
  const host = createTestHost({ plugin: { protocols: contributes.protocols, protocolImplementations: contributes.protocolImplementations, uses } });
  await activate(host.coda);
  return host;
}
const note = { kind: NOTE, id: 'any' };

test('find lists the welcome note the module wrote on activation', async () => {
  const host = await started();
  assert.deepEqual(await host.call(note, 'find'), { seen: 0, notes: [{ key: '欢迎', title: '欢迎' }] });
  assert.deepEqual(await host.call(note, 'find', { query: '没有' }), { seen: 0, notes: [] });
  await host.close();
});

test('activating over notes already there leaves them as they are', async () => {
  const host = createTestHost({ plugin: { protocols: contributes.protocols, protocolImplementations: contributes.protocolImplementations, uses } });
  await host.coda.put({ kind: NOTE, key: '旧的' }, { spec: { title: '旧的', body: '先前记的' } });
  await activate(host.coda);
  assert.deepEqual((await host.call(note, 'find')).notes, [{ key: '旧的', title: '旧的' }]);
  await host.close();
});

test('add makes the note and publishes note_notes.added each time; the module counts the events it is given', async () => {
  const host = await started();
  const input = { title: '买牛奶', body: '两盒', project: 'p1' };
  assert.deepEqual(await host.call(note, 'add', input), { key: '买牛奶', notified: true });
  await host.call(note, 'add', input);
  assert.equal(host.emitted.length, 2);
  const [event] = host.emitted;
  assert.equal(event.name, 'note_notes.added');
  assert.equal(event.kind, NOTE);
  assert.deepEqual(event.data, { key: '买牛奶', title: '买牛奶', body: '两盒' });
  assert.deepEqual((await host.call(note, 'find', { query: '牛奶' })).notes, [{ key: '买牛奶', title: '买牛奶' }]);
  await host.emit({ ...event, publisher: 'notes' });
  assert.equal((await host.call(note, 'find')).seen, 1);
  await host.close();
});

test('an input over the limits is refused before anything is written or published', async () => {
  const host = await started();
  await assert.rejects(host.call(note, 'add', { title: '长', body: 'x'.repeat(10001), project: 'p1' }), { code: 'invalid_input' });
  assert.deepEqual((await host.call(note, 'find')).notes.map(entry => entry.key), ['欢迎']);
  assert.deepEqual(host.emitted, []);
  await host.close();
});

test('add that cannot publish still saves the note, and says it did not tell anyone', async () => {
  const host = createTestHost({ plugin: { protocols: contributes.protocols, protocolImplementations: contributes.protocolImplementations, uses } });
  const coda = { ...host.coda, emit: async () => { throw host.coda.error('invalid_input', '项目 nope 不存在'); } };
  await activate(coda);
  const added = await host.call(note, 'add', { title: '买牛奶', body: '两盒', project: 'nope' });
  assert.deepEqual(added, { key: '买牛奶', notified: false, reason: added.reason });
  assert.match(String(added.reason), /项目 nope 不存在/);
  assert.deepEqual((await host.call(note, 'find')).notes.map(entry => entry.key).sort(), ['买牛奶', '欢迎']);
  await host.close();
});
