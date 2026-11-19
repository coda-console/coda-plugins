import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanNote, deleteNote, readNotes, setNote } from '../../../plugins/friends/lib/notes.mjs';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'friends-notes-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('a missing file reads as an empty table', async t => {
  assert.deepEqual(await readNotes(join(await temp(t), 'nope')), {});
});

test('setNote writes atomically and a later read sees it; an empty note deletes', async t => {
  const dir = join(await temp(t), 'state');
  assert.deepEqual(await setNote(dir, 'node-1', '  老王\u0000 '), { 'node-1': '老王' });
  await setNote(dir, 'node-2', 'B');
  assert.deepEqual(await readNotes(dir), { 'node-1': '老王', 'node-2': 'B' });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'notes.json'), 'utf8')), { 'node-1': '老王', 'node-2': 'B' });
  assert.deepEqual(await readdir(dir), ['notes.json'], 'no temporary file is left behind');
  assert.deepEqual(await setNote(dir, 'node-1', '   '), { 'node-2': 'B' });
  assert.deepEqual(await deleteNote(dir, 'node-2'), {});
  assert.deepEqual(await readNotes(dir), {});
});

test('a note is cut to 40 characters and a bad key is refused', async t => {
  const dir = await temp(t);
  assert.equal(cleanNote('字'.repeat(60)).length, 40);
  assert.equal((await setNote(dir, 'n', 'x'.repeat(100))).n.length, 40);
  await assert.rejects(setNote(dir, '', 'x'), /不合法/);
  await assert.rejects(setNote(dir, 'a\nb', 'x'), /不合法/);
  await assert.rejects(setNote(dir, 5, 'x'), /不合法/);
});

test('a damaged file reads as empty and is replaced by the next write', async t => {
  const dir = await temp(t);
  for (const bad of ['{not json', '[1,2]', 'null', '"text"']) {
    await writeFile(join(dir, 'notes.json'), bad);
    assert.deepEqual(await readNotes(dir), {});
  }
  await writeFile(join(dir, 'notes.json'), JSON.stringify({ ok: '好', bad: 5, empty: '  ' }));
  assert.deepEqual(await readNotes(dir), { ok: '好' });
  await writeFile(join(dir, 'notes.json'), '{broken');
  assert.deepEqual(await setNote(dir, 'a', 'A'), { a: 'A' });
});

test('concurrent writes do not lose each other', async t => {
  const dir = await temp(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => setNote(dir, `n${i}`, `note ${i}`)));
  assert.equal(Object.keys(await readNotes(dir)).length, 20);
});
