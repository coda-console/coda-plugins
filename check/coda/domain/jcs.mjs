// RFC 8785 (JCS): the one byte-exact serialization a signature covers. Input is JSON data only — anything that has no JSON
// form is refused rather than dropped, since a silently dropped field would sign something other than what was meant.

const plain = value => { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; };

function text(value) {
  if (!value.isWellFormed()) throw new TypeError('JCS 不接受孤立的 UTF-16 代理项');
  return JSON.stringify(value);
}

function scalar(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return String(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS 不接受 NaN 与 Infinity');
      return String(value); // ECMAScript Number::toString: shortest round-trip form; -0 is "0"
    case 'string': return text(value);
    default: throw new TypeError(`JCS 不接受 ${typeof value}`);
  }
}

// Walks with an explicit stack, so nesting depth is bounded by memory and not by the call stack. Each work item is a
// value still to write, a piece of punctuation (`{ text }`) to write as it is, or the end of a container (`{ leave }`);
// items are pushed in reverse. `active` holds the containers being written, so a cycle is refused where a shared
// child, reached again after its first visit is done, is not.
export function jcs(root) {
  const out = [], work = [{ value: root }], active = new Set();
  while (work.length) {
    const item = work.pop();
    if (Object.hasOwn(item, 'text')) { out.push(item.text); continue; }
    if (Object.hasOwn(item, 'leave')) { active.delete(item.leave); continue; }
    const { value } = item;
    if (value === null || typeof value !== 'object') { out.push(scalar(value)); continue; }
    if (active.has(value)) throw new TypeError('JCS 不接受循环引用');
    if (Array.isArray(value)) {
      active.add(value);
      out.push('[');
      work.push({ leave: value }, { text: ']' });
      for (let i = value.length - 1; i >= 0; i--) {
        work.push({ value: value[i] });
        if (i > 0) work.push({ text: ',' });
      }
      continue;
    }
    if (!plain(value)) throw new TypeError('JCS 只接受普通对象与数组');
    // Default string comparison orders by UTF-16 code units, as RFC 8785 requires.
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    active.add(value);
    out.push('{');
    work.push({ leave: value }, { text: '}' });
    for (let i = keys.length - 1; i >= 0; i--) {
      work.push({ value: value[keys[i]] }, { text: `${text(keys[i])}:` });
      if (i > 0) work.push({ text: ',' });
    }
  }
  return out.join('');
}
