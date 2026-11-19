// 好友的本地备注：只存在本机插件的持久目录里（notes.json，卸载后保留），不发给好友，也不进 Accord 目录。
// 按好友的 node 记名，原子写盘（临时文件 + rename）；文件缺失或损坏时当空表。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_NOTE = 40;
const MAX_KEY = 200;
const CONTROL = /[\p{Cc}\u2028\u2029]/gu, HAS_CONTROL = /[\p{Cc}\u2028\u2029]/u;

/** 去掉控制字符、两端空白，最多 40 个字符（按码点）。 */
export function cleanNote(text) {
  if (typeof text !== 'string') return '';
  return [...text.replace(CONTROL, '').trim()].slice(0, MAX_NOTE).join('').trim();
}

function validKey(key) {
  return typeof key === 'string' && key !== '' && [...key].length <= MAX_KEY && !HAS_CONTROL.test(key);
}

/** 从磁盘读出 `{ key: 备注 }`；缺失、损坏、不是对象时为空表。 */
export async function readNotes(dir) {
  let parsed;
  try { parsed = JSON.parse(await readFile(join(dir, 'notes.json'), 'utf8')); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const notes = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    const note = cleanNote(value);
    if (validKey(key) && note) notes[key] = note;
  }
  return { ...notes };
}

let counter = 0;
async function writeNotes(dir, notes) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, 'notes.json'), temporary = join(dir, `notes.json.${process.pid}.${++counter}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(notes, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch (e) { await rm(temporary, { force: true }).catch(() => {}); throw e; }
}

// 同一目录的写入排队，读改写不会互相覆盖。
const queues = new Map();
function exclusive(dir, work) {
  const run = (queues.get(dir) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => {});
  queues.set(dir, tail);
  tail.then(() => { if (queues.get(dir) === tail) queues.delete(dir); });
  return run;
}

/** 设置一个好友的备注；清洗后为空串就是删除。返回现在的整张表。 */
export function setNote(dir, key, text) {
  if (!validKey(key)) return Promise.reject(new Error('好友标识不合法'));
  return exclusive(dir, async () => {
    const notes = await readNotes(dir), note = cleanNote(text);
    if (note) notes[key] = note; else delete notes[key];
    await writeNotes(dir, notes);
    return notes;
  });
}

/** 删除一个好友的备注。返回现在的整张表。 */
export function deleteNote(dir, key) { return setNote(dir, key, ''); }
