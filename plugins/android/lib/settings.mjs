// Copied from testbed/scripts/android.mjs; plugins ship independently.
export const NAMESPACES = ['system', 'secure', 'global'];

// `settings list <namespace>` as an object; a line without `=` goes on the value before it.
export function parseList(text) {
  const table = {};
  let last;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) table[last = line.slice(0, at)] = line.slice(at + 1);
    else if (last !== undefined && line) table[last] += `\n${line}`;
  }
  return table;
}

// What puts `now` back to `before`, one change per key: a value changed or gone is put back, one added is deleted (value
// null). A value listed as null is one no one set, so it is deleted rather than written as the text "null".
export function changes(before, now) {
  const list = [];
  for (const name of NAMESPACES) {
    const was = before[name] ?? {}, is = now[name] ?? {};
    for (const key of Object.keys(is)) if (!(key in was) && is[key] !== 'null') list.push({ name, key, value: null });
    for (const [key, value] of Object.entries(was)) {
      if (is[key] === value) continue;
      if (value !== 'null') list.push({ name, key, value });
      else if (key in is) list.push({ name, key, value: null });
    }
  }
  return list;
}
// Of these changes, those `now` does not have yet.
export const notDone = (wanted, now) => wanted.filter(({ name, key, value }) => (now[name]?.[key] ?? null) !== value && !(value === null && now[name]?.[key] === 'null'));

const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
export const command = ({ name, key, value }) => value === null ? `settings delete ${name} ${quote(key)}` : `settings put ${name} ${quote(key)} ${quote(value)}`;

