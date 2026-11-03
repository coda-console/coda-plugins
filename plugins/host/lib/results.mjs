import { open } from 'node:fs/promises';
import { join } from 'node:path';

export async function readPart(file, limit, tail = false) {
  let handle;
  try {
    handle = await open(file, 'r'); const { size } = await handle.stat();
    const bytes = Buffer.alloc(Math.min(size, limit));
    await handle.read(bytes, 0, bytes.length, tail ? Math.max(0, size - bytes.length) : 0);
    return bytes.toString('utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
  finally { await handle?.close(); }
}

export function outputs(text) {
  const result = Object.create(null), lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; if (!line) continue;
    const multiline = /^([^=]+)<<(.+)$/.exec(line), simple = /^([^=]+)=(.*)$/.exec(line);
    let name, value;
    if (multiline) {
      name = multiline[1]; const end = lines.indexOf(multiline[2], i + 1);
      if (end < 0) throw new Error('输出缺少多行结束标记');
      value = lines.slice(i + 1, end).join('\n'); i = end;
    } else if (simple) [, name, value] = simple;
    else throw new Error('输出格式无效');
    if (name.length > 128 || value.length > 4096) throw new Error('步骤输出超出协议限制');
    result[name] = value;
    if (Object.keys(result).length > 64) throw new Error('步骤输出超过 64 项');
  }
  return result;
}

export async function resultFiles(directory, declaredNames) {
  const output = await readPart(join(directory, 'output'), 1024 * 1024 + 1);
  if (Buffer.byteLength(output) > 1024 * 1024) throw new Error('步骤输出文件过大');
  const parsed = outputs(output), names = declaredNames && new Set(declaredNames);
  return { outputs: names ? Object.fromEntries(Object.entries(parsed).filter(([name]) => names.has(name))) : parsed, summary: (await readPart(join(directory, 'summary'), 16384)).slice(0, 4096),
    outputTail: (await readPart(join(directory, 'log'), 16384, true)).slice(-16384) };
}
