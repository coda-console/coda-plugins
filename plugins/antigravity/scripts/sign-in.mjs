#!/usr/bin/env node
// The「Antigravity」resource type's sign-in (the `sign-in` operation of `coda/resource@1`): `agy acp --login`, which prints
// the Google authorization link and waits for the code the page gives. This reports the link (`coda progress`), asks for the
// code (`coda ask`), once, and gives it to the CLI, which does the exchange and keeps and renews the credentials in the
// keychain. What the CLI says after the code is given is not passed on: it may carry the code.
import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { agyBinary } from './agy.mjs';

// The authorization link a stream printed: the first on a whole line (output arrives in pieces, and a link cut short is not
// the link), terminal hyperlinks included.
export function authorizationLink(output) {
  const lines = stripVTControlCharacters(output.slice(0, output.lastIndexOf('\n') + 1));
  try { return new URL(lines.match(/https:\/\/[^\s]+/)?.[0]); } catch { return null; }
}

// Coda's own command: what it prints, or why it failed (its last line).
const coda = (...args) => new Promise((done, fail) => execFile('coda', args, (error, stdout, stderr) =>
  error ? fail(new Error(stderr.trim().split('\n').at(-1) || error.message)) : done(stdout)));
const lastLine = text => stripVTControlCharacters(text).split('\n').map(line => line.trim()).filter(Boolean).at(-1);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = agyBinary();
  if (!binary) { console.error('找不到 Antigravity CLI'); process.exit(1); }
  const child = spawn(binary, ['acp', '--login'], { env: { ...process.env, BROWSER: '/usr/bin/true', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  // What each stream said, kept apart (a line is read from one stream only), and which spoke last.
  const said = { stdout: '', stderr: '' };
  let latest = 'stdout', url = null, reporting = Promise.resolve(), exited = false, submitted = false, failed = null;
  // The first reason stays: what the CLI says when it is ended for it is not the reason.
  const fail = message => { failed ??= message; child.kill(); };
  // Without a link in 20 seconds, the login is over with what the CLI said last.
  const silent = setTimeout(() => fail(lastLine(said[latest]) || '登录没有完成，请重新登录。'), 20_000);
  // What the CLI says is kept until the code is given to it: after that it may carry the code.
  const heard = name => chunk => {
    if (submitted) return;
    said[name] = (said[name] + chunk).slice(-8000); latest = name;
    if (url) return;
    url = authorizationLink(said[name]);
    if (!url) return;
    clearTimeout(silent);
    reporting = coda('progress', JSON.stringify({ url: url.href })).catch(error => fail(error.message));
    reporting.then(async () => {
      // A CLI that has ended is not asked for a code: its last line is the reason.
      if (failed || exited) return;
      const { code } = JSON.parse(await coda('ask', JSON.stringify({ input: 'authorizationCode' })));
      submitted = true;
      child.stdin.write(`${code.trim()}\n`);
    }).catch(error => fail(error.message));
  };
  for (const name of ['stdout', 'stderr']) child[name].setEncoding('utf8').on('data', heard(name));
  child.on('error', () => { failed ??= 'Antigravity CLI 没能启动'; });
  child.on('exit', () => { exited = true; });
  // Coda ends the whole group; one ended alone takes its CLI along.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(); process.exit(1); });
  child.on('close', async code => {
    clearTimeout(silent);
    await reporting;
    if (code === 0 && !failed) { console.log('{}'); process.exit(0); }
    console.error(failed ?? (submitted ? null : lastLine(said[latest])) ?? '登录没有完成，请重新登录。');
    process.exit(1);
  });
}
