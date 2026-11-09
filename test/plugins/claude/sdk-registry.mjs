// The upgrade check of the Claude entry's registry (plugins/claude/agent/registry.mjs): every message type and subtype the
// locked Claude Agent SDK declares (its SDKMessage union), and every content block type of an assistant's and a user's
// message (followed from those messages' types into @anthropic-ai/sdk), is registered. npm test runs it
// (sdk-registry.test.mjs); on its own it lists what is missing:
//
//   node test/plugins/claude/sdk-registry.mjs
//
// The declarations are read as TypeScript, not line by line: comments, line breaks, `type` or `interface`, unions over lines,
// intersections, aliases of unions, imports and re-exports read the same. What it cannot read on the way (a `type` that is
// not string literals, a generic it does not follow) fails the check rather than passing unseen.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_BLOCKS, MESSAGES, USER_BLOCKS } from '../../../plugins/claude/agent/registry.mjs';
import { resolveFrom } from '../plugin.mjs';

const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1|([\w$]+)|(\S)/y;
const OPEN = { '{': '}', '(': ')', '[': ']', '<': '>' };
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'unknown', 'any', 'never', 'void', 'null', 'undefined', 'true', 'false']);

// A token: `{ string }` (a quoted literal; `template` for a backquoted one), `{ word }` or `{ punct }` (one character).
function tokenize(source) {
  const list = [];
  for (TOKEN.lastIndex = 0; TOKEN.lastIndex < source.length;) {
    const m = TOKEN.exec(source);
    if (!m) throw new Error(`读不懂第 ${TOKEN.lastIndex} 个字符`);
    if (m[1]) list.push({ string: m[2], template: m[1] === '`' });
    else if (m[3]) list.push({ word: m[3] });
    else if (m[4]) list.push({ punct: m[4] });
  }
  return list;
}
const is = (token, punct) => token?.punct === punct;
// Past the bracket that closes the one at `i`. An arrow's `>` closes nothing.
function close(tokens, i) {
  const stack = [];
  for (; i < tokens.length; i++) {
    const p = tokens[i].punct;
    if (p in OPEN) stack.push(OPEN[p]);
    else if (p === stack.at(-1) && !(p === '>' && is(tokens[i - 1], '='))) { stack.pop(); if (!stack.length) return i + 1; }
  }
  throw new Error('括号不配对');
}
// From `i` to the first of `stops` outside brackets.
function until(tokens, i, stops) {
  while (i < tokens.length && !stops.includes(tokens[i].punct)) i = tokens[i].punct in OPEN ? close(tokens, i) : i + 1;
  return i;
}

// A declaration file: its tokens, the types it declares (`{ alias: [from, to] }` or `{ body: [from, to], bases }`, as token
// ranges), what it imports (`{ name, from }` by local name) and re-exports (`{ names, from }`, `names` null for all).
const units = new Map();
function unit(file) {
  if (units.has(file)) return units.get(file);
  const tokens = tokenize(readFileSync(file, 'utf8')), types = new Map(), imports = new Map(), reexports = [];
  // The names in braces from `from` to `to`, each as declared and as named here (`a as b`, `type a`).
  const names = (from, to, each) => {
    for (let i = from; i < to; i = until(tokens, i, [',', '}']) + 1) {
      const words = tokens.slice(i, Math.min(to, until(tokens, i, [',', '}']))).map(t => t.word).filter(w => w && w !== 'type');
      if (words.length) each(words[0], words.at(-1));
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const [a, b, c] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if ((a.word === 'type' || a.word === 'interface') && b?.word && (is(c, '=') || is(c, '<') || is(c, '{') || c?.word === 'extends')) {
      const j = is(c, '<') ? close(tokens, i + 2) : i + 2;
      if (types.has(b.word)) continue;
      if (a.word === 'type') {
        if (is(tokens[j], '=')) types.set(b.word, { alias: [j + 1, until(tokens, j + 1, [';'])] });
      } else {
        const open = until(tokens, j, ['{']), bases = [];
        if (tokens[j]?.word === 'extends') for (let k = j + 1; k < open; k = until(tokens, k, [',', '{']) + 1) bases.push([k, until(tokens, k, [',', '{'])]);
        types.set(b.word, { body: [open + 1, close(tokens, open) - 1], bases });
      }
    } else if ((a.word === 'import' || a.word === 'export') && (is(b, '{') || (b?.word === 'type' && is(c, '{')))) {
      const open = is(b, '{') ? i + 1 : i + 2, end = close(tokens, open), from = tokens[end]?.word === 'from' ? tokens[end + 1]?.string : undefined;
      if (from === undefined) continue;
      if (a.word === 'import') names(open + 1, end - 1, (name, local) => imports.set(local, { name, from }));
      else { const map = new Map(); names(open + 1, end - 1, (name, exported) => map.set(exported, name)); reexports.push({ names: map, from }); }
    } else if (a.word === 'export' && is(b, '*') && c?.word === 'from') reexports.push({ names: null, from: tokens[i + 3].string });
  }
  const read = { file, tokens, types, imports, reexports };
  units.set(file, read);
  return read;
}
// The declaration file beside a module's file, and that of a module named from `file`.
function typesOf(js) {
  const base = js.replace(/\.[cm]?js$/, '');
  const found = [js.endsWith('.mjs') ? `${base}.d.mts` : `${base}.d.ts`, `${base}.d.ts`].find(existsSync);
  if (!found) throw new Error(`${js} 旁边没有类型声明`);
  return found;
}
const moduleFile = (specifier, file) => typesOf(createRequire(file).resolve(specifier));
// Where `name` is declared, as seen from `file`: there, or through what it imports or re-exports.
function declaration(name, file, seen = new Set()) {
  if (seen.has(`${file}#${name}`)) return null;
  seen.add(`${file}#${name}`);
  const u = unit(file);
  if (u.types.has(name)) return { unit: u, ...u.types.get(name) };
  const imported = u.imports.get(name);
  if (imported) return declaration(imported.name, moduleFile(imported.from, file), seen);
  for (const { names, from } of u.reexports) {
    if (names && !names.has(name)) continue;
    const found = declaration(names ? names.get(name) : name, moduleFile(from, file), seen);
    if (found) return found;
  }
  return null;
}

// A type read from tokens: `{ union }`, `{ inter }`, `{ object: [from, to] }`, `{ literal }`, `{ ref, args }`, `{ array }` or
// `{ other }` (what this check does not follow: functions, tuples, keyof, conditional, indexed and mapped types).
function parse(tokens) {
  let i = 0;
  const at = () => tokens[i];
  const expect = p => { if (!is(at(), p)) throw new Error(`这里应是 ${p}`); i++; };
  const list = (p, next) => {
    if (is(at(), p)) i++;
    const parts = [next()];
    while (is(at(), p)) { i++; parts.push(next()); }
    return parts;
  };
  const union = () => { const parts = list('|', inter); return parts.length > 1 ? { union: parts } : parts[0]; };
  const inter = () => { const parts = list('&', postfix); return parts.length > 1 ? { inter: parts } : parts[0]; };
  function type() {
    const node = union();
    if (at()?.word !== 'extends') return node;
    i++; union(); expect('?'); type(); expect(':'); type();
    return { other: true };
  }
  function postfix() {
    let node = primary();
    while (is(at(), '[')) {
      if (is(tokens[i + 1], ']')) { i += 2; node = { array: node }; } else { i = close(tokens, i); node = { other: true }; }
    }
    return node;
  }
  function primary() {
    const token = at();
    if (!token) throw new Error('类型不完整');
    if (is(token, '(') || is(token, '<') || token.word === 'new') {
      if (token.word === 'new') i++;
      if (is(at(), '<')) i = close(tokens, i);
      const end = close(tokens, i);
      if (is(tokens[end], '=') && is(tokens[end + 1], '>')) { i = end + 2; type(); return { other: true }; }
      i++; const node = type(); expect(')');
      return node;
    }
    if (is(token, '{')) { const end = close(tokens, i), node = { object: [i + 1, end - 1] }; i = end; return node; }
    if (is(token, '[')) { i = close(tokens, i); return { other: true }; }
    if (token.string !== undefined) { i++; return token.template ? { other: true } : { literal: token.string }; }
    if (['keyof', 'typeof', 'unique', 'readonly', 'infer', 'asserts'].includes(token.word)) { i++; postfix(); return { other: true }; }
    if (is(token, '-') || /^\d/.test(token.word ?? '')) { i += is(token, '-') ? 2 : 1; return { other: true }; }
    if (!token.word) throw new Error(`读不懂 ${token.punct}`);
    let ref = token.word; i++;
    while (is(at(), '.') && tokens[i + 1]?.word) { ref += `.${tokens[i + 1].word}`; i += 2; }
    const args = [];
    if (is(at(), '<')) { i++; args.push(...list(',', type)); expect('>'); }
    return { ref, args };
  }
  const node = type();
  if (i < tokens.length) throw new Error('类型后面还有读不懂的');
  return node;
}

// What a type (as tokens, in `file`) can be: each alternative an object (`get`: a property's type, as `[tokens, file]`), a
// string literal, an array (`element`) or something else.
const alternatives = (tokens, file) => shapes(parse(tokens), tokens, file);
function shapes(node, tokens, file) {
  if (node.union) return node.union.flatMap(part => shapes(part, tokens, file));
  if (node.inter) return node.inter.map(part => shapes(part, tokens, file)).reduce((left, right) => left.flatMap(l => right.map(r =>
    l.get && r.get ? { get: name => r.get(name) ?? l.get(name) } : { other: true })));
  if (node.object) return [{ get: members(tokens.slice(...node.object), file) }];
  if (node.literal !== undefined) return [{ literal: node.literal }];
  if (node.other) return [{ other: true }];
  if (node.array || (['Array', 'ReadonlyArray'].includes(node.ref) && node.args.length === 1))
    return [{ element: () => shapes(node.array ?? node.args[0], tokens, file) }];
  if (PRIMITIVES.has(node.ref)) return [{ other: true }];
  const found = declaration(node.ref, file);
  if (!found) throw new Error(`找不到 ${node.ref}（${file}）`);
  const { tokens: theirs, file: where } = found.unit;
  if (found.alias) return alternatives(theirs.slice(...found.alias), where);
  const own = members(theirs.slice(...found.body), where);
  return [{ get: name => own(name) ?? found.bases.map(range => object(alternatives(theirs.slice(...range), where), node.ref).get(name)).find(Boolean) }];
}
// The properties of an object type's body by name, each one's type as `[tokens, file]`. Methods, index signatures and the
// like are not properties here.
function members(tokens, file) {
  const props = new Map();
  for (let i = 0; i < tokens.length;) {
    const end = until(tokens, i, [';', ',']);
    let j = tokens[i].word === 'readonly' && (tokens[i + 1]?.word || tokens[i + 1]?.string !== undefined) ? i + 1 : i;
    const name = tokens[j].word ?? tokens[j].string;
    if (is(tokens[j + 1], '?')) j++;
    if (name !== undefined && is(tokens[j + 1], ':') && !props.has(name)) props.set(name, [tokens.slice(j + 2, end), file]);
    i = end + 1;
  }
  return name => props.get(name);
}
function object(list, what) {
  if (list.length !== 1 || !list[0].get) throw new Error(`${what} 不是一个对象类型`);
  return list[0];
}
// The string literals a property of an object can be.
function literals(shape, name, what) {
  const prop = shape.get(name);
  if (!prop) throw new Error(`${what}没有 ${name}`);
  const values = alternatives(...prop);
  if (!values.every(v => v.literal !== undefined)) throw new Error(`读不出 ${what}的 ${name}：不全是字符串字面量`);
  return values.map(v => v.literal);
}
// The content block types of the messages of type `role`: the elements of their `message`'s `content` arrays.
function blocks(messages, role) {
  const types = new Set();
  for (const m of messages.filter(m => literals(m, 'type', 'SDK 消息').includes(role))) {
    const message = m.get('message');
    if (!message) throw new Error(`${role} 消息没有 message`);
    for (const shape of alternatives(...message).filter(alt => alt.get)) {
      const content = shape.get('content');
      if (!content) throw new Error(`${role} 消息的 message 没有 content`);
      const arrays = alternatives(...content).filter(alt => alt.element);
      if (!arrays.length) throw new Error(`读不出 ${role} 消息的内容块：content 不是数组`);
      for (const block of arrays.flatMap(array => array.element())) {
        if (!block.get) throw new Error(`${role} 消息的内容块不全是对象类型`);
        for (const type of literals(block, 'type', `${role} 消息的内容块`)) types.add(type);
      }
    }
  }
  return [...types].sort();
}

// What the SDK whose declarations are `file` declares: its messages' names (type, and type/subtype where it has subtypes), and
// the content block types of its assistant's and user's messages.
export function declared(file) {
  const messages = alternatives([{ word: 'SDKMessage' }], file);
  if (!messages.every(m => m.get)) throw new Error('SDKMessage 的成员不全是对象类型');
  const names = messages.flatMap(m => {
    const types = literals(m, 'type', 'SDK 消息');
    const subtypes = m.get('subtype') ? literals(m, 'subtype', `SDK 消息（${types.join('|')}）`) : [null];
    return types.flatMap(type => subtypes.map(subtype => subtype === null ? type : `${type}/${subtype}`));
  });
  return { messages: [...new Set(names)].sort(), assistant: blocks(messages, 'assistant'), user: blocks(messages, 'user') };
}
// The declarations of the SDK plugins/claude installs.
export const sdkDeclarations = () => typesOf(resolveFrom('claude', '@anthropic-ai/claude-agent-sdk'));

// What the SDK declares that `registry` does not have, by the registry's table.
export function unregistered(registry = { MESSAGES, ASSISTANT_BLOCKS, USER_BLOCKS }, file = sdkDeclarations()) {
  const { messages, assistant, user } = declared(file);
  return [...messages.filter(name => !Object.hasOwn(registry.MESSAGES, name)).map(name => `MESSAGES：${name}`),
    ...assistant.filter(type => !Object.hasOwn(registry.ASSISTANT_BLOCKS, type)).map(type => `ASSISTANT_BLOCKS：${type}`),
    ...user.filter(type => !Object.hasOwn(registry.USER_BLOCKS, type)).map(type => `USER_BLOCKS：${type}`)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = unregistered();
  if (missing.length) {
    console.error(`锁定的 Claude Agent SDK 有这些没登记（plugins/claude/agent/registry.mjs）：\n${missing.map(m => `  ${m}`).join('\n')}`);
    process.exit(1);
  }
  console.log('锁定的 Claude Agent SDK 的消息与内容块类型都登记了');
}
