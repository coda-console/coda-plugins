// The「Claude」resource type's login (`signIn`): `claude auth login --claudeai` of the CLI that comes with the plugin's own Claude
// SDK (the one its sessions run), never another on the PATH. Coda shows the authorization link this prints
// and writes the code the page gave back to its input, once (docs/plugins.md「资源的登录」). Only the official link is
// passed on, and only a code bound to it is handed to the CLI, which does the exchange, keeps and renews the credentials.
// What the CLI says otherwise is not passed on: it may carry the code. `--installed` says whether that CLI is there.
import { spawn } from 'node:child_process';
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = claudeBinary();
  if (process.argv[2] === '--installed') process.exit(binary ? 0 : 1);
  if (!binary) { console.error('找不到 Claude SDK 自带的 CLI'); process.exit(1); }
  const env = { ...process.env, BROWSER: '/usr/bin/true', NO_COLOR: '1' };
  // auth login otherwise silently imports this token instead of opening a fresh browser login.
  delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN; delete env.CLAUDE_CODE_OAUTH_SCOPES;
  const child = spawn(binary, ['auth', 'login', '--claudeai'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let output = '', url = null, failed = null;
  const heard = chunk => {
    if (url) return;
    output += chunk;
    url = authorization(output);
    if (url) console.log(url.href);
  };
  child.stdout.on('data', heard); child.stderr.on('data', heard);
  // Coda writes the code once, ending it with a newline.
  let typed = '';
  process.stdin.setEncoding('utf8').on('data', chunk => {
    typed += chunk;
    const end = typed.indexOf('\n');
    if (end < 0) return;
    const code = typed.slice(0, end).trim();
    process.stdin.pause();
    if (url && bound(code, url)) return child.stdin.write(`${code}\n`);
    failed = '授权码不对：要贴这次登录的网页给出的完整授权码，请重新登录。';
    child.kill();
  });
  child.on('error', () => { failed ??= 'Claude CLI 没能启动'; });
  // Coda ends the whole group; one ended alone takes its CLI along.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(); process.exit(1); });
  child.on('close', code => {
    if (code === 0 && !failed) process.exit(0);
    console.error(failed ?? 'Claude 登录没有完成，请重新登录。');
    process.exit(1);
  });
}
