#!/usr/bin/env node
// The「Claude」resource type's sign-in (the `sign-in` operation of `coda/resource@1`): `claude auth login --claudeai` of the CLI
// that comes with the plugin's own Claude SDK (the one its sessions run), never another on the PATH. It reports the
// authorization link this prints (`coda progress`) and asks for the code the page gave (`coda ask`), once. Only the official
// link is passed on, and only a code bound to it is handed to the CLI, which does the exchange, keeps and renews the
// credentials. What the CLI says otherwise is not passed on: it may carry the code.
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Resolved beside the SDK, as its query() resolves it.
export function claudeBinary() {
  const sdk = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  const platform = process.platform, arch = process.arch;
  const musl = platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
  for (const suffix of platform === 'linux' ? (musl ? ['-musl', ''] : ['', '-musl']) : ['']) {
    try { return sdk.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}${suffix}/claude${platform === 'win32' ? '.exe' : ''}`); }
    catch {}
  }
  return null;
}
// The official authorization link among whole lines of what the CLI printed, terminal hyperlinks included.
export function authorization(output) {
  const lines = stripVTControlCharacters(output.slice(0, output.lastIndexOf('\n') + 1));
  for (const match of lines.matchAll(/https:\/\/[^\s]+/g)) {
    try {
      const url = new URL(match[0]);
      if (((url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize') ||
           (url.origin === 'https://claude.com' && url.pathname === '/cai/oauth/authorize')) &&
          url.searchParams.get('state') && url.searchParams.get('code_challenge') && url.searchParams.get('response_type') === 'code') return url;
    } catch {}
  }
  return null;
}
// The code the page gives is `<code>#<state>`: one for another login is not handed over.
export const bound = (code, url) => /^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/.test(code) && code.split('#')[1] === url.searchParams.get('state');

// Coda's own command: what it prints, or why it failed (its last line).
const coda = (...args) => new Promise((done, fail) => execFile('coda', args, (error, stdout, stderr) =>
  error ? fail(new Error(stderr.trim().split('\n').at(-1) || error.message)) : done(stdout)));
const lastLine = text => stripVTControlCharacters(text).split('\n').map(line => line.trim()).filter(Boolean).at(-1);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = claudeBinary();
  if (!binary) { console.error('找不到 Claude SDK 自带的 CLI'); process.exit(1); }
  const env = { ...process.env, BROWSER: '/usr/bin/true', NO_COLOR: '1' };
  // auth login otherwise silently imports this token instead of opening a fresh browser login.
  delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN; delete env.CLAUDE_CODE_OAUTH_SCOPES;
  const child = spawn(binary, ['auth', 'login', '--claudeai'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let output = '', url = null, reporting = Promise.resolve(), exited = false, submitted = false, failed = null;
  // The first reason stays: what the CLI says when it is ended for it is not the reason.
  const fail = message => { failed ??= message; child.kill(); };
  // Without a link in 20 seconds, the login is over with what the CLI said last.
  const silent = setTimeout(() => fail(lastLine(output) || 'Claude 登录没有完成，请重新登录。'), 20_000);
  // What the CLI says is kept until the code is given to it: after that it may carry the code.
  const heard = chunk => {
    if (submitted) return;
    output += chunk;
    if (url) return;
    url = authorization(output);
    if (!url) return;
    clearTimeout(silent);
    reporting = coda('progress', JSON.stringify({ url: url.href })).catch(error => fail(error.message));
    reporting.then(async () => {
      // A CLI that has ended is not asked for a code: its last line is the reason.
      if (failed || exited) return;
      const code = JSON.parse(await coda('ask', JSON.stringify({ input: 'authorizationCode' }))).code.trim();
      if (!bound(code, url)) return fail('授权码不对：要贴这次登录的网页给出的完整授权码，请重新登录。');
      submitted = true;
      child.stdin.write(`${code}\n`);
    }).catch(error => fail(error.message));
  };
  child.stdout.on('data', heard); child.stderr.on('data', heard);
  child.on('error', () => { failed ??= 'Claude CLI 没能启动'; });
  child.on('exit', () => { exited = true; });
  // Coda ends the whole group; one ended alone takes its CLI along.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(); process.exit(1); });
  child.on('close', async code => {
    clearTimeout(silent);
    await reporting;
    if (code === 0 && !failed) { console.log('{}'); process.exit(0); }
    console.error(failed ?? (submitted ? null : lastLine(output)) ?? 'Claude 登录没有完成，请重新登录。');
    process.exit(1);
  });
}
