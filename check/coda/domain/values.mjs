// Shapes every layer checks what it is given against, and the stable serialization requests are compared by.
import { isAbsolute, normalize } from 'node:path';
import { requireCondition as check } from './errors.mjs';

// An agent's ID, as sessions, shortcuts, settings and the plugins declaring agents write it.
export const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;

export function object(value, name) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid_input', `${name} 必须是对象`);
  return value;
}

export function text(value, name, max = 200) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'),
    'invalid_input', `${name} 为空或格式无效`);
  return value;
}

export function keys(value, allowed) {
  check(Object.keys(value).every(key => allowed.includes(key)), 'invalid_input', '包含不支持的字段');
}

// Stable serialization is only for semantic request equality, never shell quoting.
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  check(encoded !== undefined, 'invalid_input', '数据必须可以编码为 JSON');
  return encoded;
}

// A path the user gave, as an absolute one.
export function absolutePath(value) {
  text(value, '路径', 4096);
  check(isAbsolute(value), 'invalid_input', '需要绝对路径');
  return normalize(value);
}
