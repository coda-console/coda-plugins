// A device-code login as the `sign-in` operation of `coda/resource@1` runs it, for this machine's own login and, with「多账号」on,
// for a managed account (login.mjs): the entry says how to start the CLI that prints the device link and code (`start()`, a
// child process with its output piped),
// and this reports them (`coda progress`, awaited before the login is settled), gives the login 20 seconds to print them,
// ends it with its CLI, and settles it: `{}` when the CLI ended well and nothing failed, else one line, the first reason
// noted, else the last line the CLI said.
import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

// The device code a login prints: a verification URL that carries the code, or the code alone on a line after it. Only whole
// lines are read: output arrives in pieces, and a URL cut short would carry a code cut short.
export function deviceCode(text) {
  const plain = stripVTControlCharacters(text.slice(0, text.lastIndexOf('\n') + 1));
  const url = plain.match(/https:\/\/\S+/)?.[0] ?? null;
  let code = null;
  try { code = url && new URL(url).searchParams.get('user_code'); } catch { return null; }
  code ||= plain.match(/^\s*([A-Z0-9]{4}-[A-Z0-9]{4,5})\s*$/m)?.[1] ?? null;
  return url && code && /^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/.test(code) ? { url, code } : null;
}
const lastLine = text => stripVTControlCharacters(text).split('\n').map(line => line.trim()).filter(Boolean).at(-1);
// Coda's own command: what it prints, or why it failed (its last line).
const coda = (...args) => new Promise((done, fail) => execFile('coda', args, (error, stdout, stderr) =>
  error ? fail(new Error(stderr.trim().split('\n').at(-1) || error.message)) : done(stdout)));

export async function deviceLogin(start) {
  const child = start();
  let output = '', reported = false, reporting = Promise.resolve(), failed = null;
  // The first reason stays: what the CLI says when it is ended for it (cancelled, say) is not the reason.
  const fail = reason => { failed ??= reason; child.kill(); };
  const silent = setTimeout(() => fail(lastLine(output) || '登录没有完成，请重新登录。'), 20_000);
  const heard = chunk => {
    output = (output + chunk).slice(-8000);
    const found = !reported && deviceCode(output);
    if (!found) return;
    reported = true; clearTimeout(silent);
    reporting = coda('progress', JSON.stringify(found)).catch(error => fail(error.message));
  };
  child.stdout.on('data', heard); child.stderr.on('data', heard);
  child.on('error', () => { failed ??= '无法启动 Codex 登录'; });
  // Coda ends the whole group: the CLI is ended with it, and waited for.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(silent);
  await reporting;
  if (code === 0 && !failed) { console.log('{}'); return; }
  console.error(failed ?? lastLine(output) ?? '登录没有完成，请重新登录。');
  process.exitCode = 1;
}
