// @ts-check
/** @import { Coda, Json } from '@coda-console/plugin-check/types' */

const NOTE = 'notes/note@1';

/** @param {Coda} coda */
export async function activate(coda) {
  // A query: the notes this plugin holds, those whose title has `query` in it, and how many note_notes.added this module has been told of.
  let seen = 0;
  coda.handle(NOTE, 'find', async input => {
    const { query = '' } = /** @type {{ query?: string }} */ (input);
    const entries = await coda.list(NOTE, { scope: 'local' });
    return { seen, notes: entries.filter(entry => String(entry.spec.title).includes(query)).map(entry => ({ key: String(entry.key), title: String(entry.spec.title) })) };
  });

  // A doing call: the input's limits (the schema) refuse what cannot be written before anything is. Once the note is saved the call
  // does not fail: if note_notes.added cannot be published, it says so (`notified`), for the note is there. Each call publishes one.
  coda.handle(NOTE, 'add', async input => {
    const { title, body, project } = /** @type {{ title: string, body: string, project: string }} */ (input);
    const entry = await coda.put({ kind: NOTE, key: title }, { spec: { title, body } });
    /** @type {Json} */
    let result = { key: title, notified: true };
    try {
      await coda.emit('note_notes.added', { key: title, title, body }, { subject: `note:${entry.id}`, project });
    } catch (e) {
      result = { key: title, notified: false, reason: String(e) };
    }
    return result;
  });

  // The welcome note, only while there are no notes: `replace` gives every record of the kind whole, so it would wipe the others.
  if (!(await coda.list(NOTE, { scope: 'local' })).length)
    await coda.replace(NOTE, [{ key: '欢迎', spec: { title: '欢迎', body: '这是模板自带的一条便条。' } }]);

  // The event group `watch` of the protocol, in `uses`: it only reads the events.
  coda.on('note_notes.added', () => { seen++; });
}
