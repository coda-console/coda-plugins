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

test('add makes the note, same title the same note; the module counts the events it is given', async () => {
  const host = await started();
  const input = { title: '买牛奶', body: '两盒' };
  assert.deepEqual(await host.call(note, 'add', input), { key: '买牛奶' });
  await host.call(note, 'add', input);
  assert.deepEqual((await host.call(note, 'find', { query: '牛奶' })).notes, [{ key: '买牛奶', title: '买牛奶' }]);
  // An event is published by the command line or a workflow, not by the module: the test hands one to its `coda.on` handler.
  await host.emit({ name: 'note_notes.added', kind: NOTE, subject: 'note:any', project: 'p1', data: { key: '买牛奶', title: '买牛奶', body: '两盒' }, publisher: 'notes' });
  assert.equal((await host.call(note, 'find')).seen, 1);
  await host.close();
});

test('an input over the limits is refused before anything is written', async () => {
  const host = await started();
  await assert.rejects(host.call(note, 'add', { title: '长', body: 'x'.repeat(10001) }), { code: 'invalid_input' });
  assert.deepEqual((await host.call(note, 'find')).notes.map(entry => entry.key), ['欢迎']);
  await host.close();
});
