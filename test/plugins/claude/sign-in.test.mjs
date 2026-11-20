// The「Claude」type's sign-in (scripts/sign-in.mjs, the `sign-in` operation of `coda/resource@1`) run as Coda runs it, with a
// `coda` standing in for Coda's own to note the link it reports and to answer its question for the code.
// That the CLI is found beside the plugin's own SDK is in plugins.test.mjs.
// The CLI beside the plugin's own Claude SDK, its official link passed on, and only a code bound to that link handed to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resourceRecords } from '../../../check/resources.mjs';
import { authorization, bound } from '../../../plugins/claude/scripts/sign-in.mjs';
import { endWait, fakeCoda, noted, operation, pluginEnv, probed } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { substituted } from '../substitute.mjs';

// SDK 0.3.293 / CLI 2.1.293 prints the manual-code URL even with a local callback listener.
const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=test-challenge&state=test-state';
const output = `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;

test('Claude reads only complete official authorization URLs, including terminal hyperlinks, and only a code bound to it', () => {
  assert.equal(authorization(output)?.href, url);
  assert.equal(authorization(output.slice(0, output.indexOf('state=') + 8)), null);
  assert.equal(authorization(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`)?.href, url);
  for (const bad of [url.replace('https:', 'http:'), url.replace('claude.com/', 'claude.com.evil/'),
    url.replace('/cai/oauth/authorize', '/unrelated'), url.replace('response_type=code', 'response_type=token')]) {
    assert.equal(authorization(bad + '\n'), null);
  }
  assert.equal(bound('one-time-code#test-state', new URL(url)), true);
  for (const code of ['one-time-code', 'secret#other-state', 'one-time-code#test-state\nextra']) assert.equal(bound(code, new URL(url)), false);
});

// An SDK standing in for the plugin's own, with a Claude CLI beside it that prints as the real one does, in pieces, notes how
// it was started, and keeps a credential once it is given a code (unless TEST_FAIL).
async function sdk(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-sign-in-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  const binary = join(dir, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  await mkdir(dirname(entry), { recursive: true }); await writeFile(entry, '');
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2),
  browser: process.env.BROWSER, refresh: process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ?? null }));
const output = ${JSON.stringify(output)};
// Ending before its link, or saying nothing of it and ending 0 when it is ended, as a CLI may.
if (process.env.TEST_EARLY_FAIL) { console.error(process.env.TEST_EARLY_FAIL); process.exit(1); }
if (process.env.TEST_SILENT) { console.log('Contacting claude.ai…'); process.on('SIGTERM', () => { console.log('登录已取消'); process.exit(0); }); setInterval(() => {}, 1000); }
else {
  // Ending as soon as it has said its link: 0 (TEST_LINK_EXIT), or 1 with what it says of why (TEST_LINK_FAIL).
  const ends = () => process.env.TEST_LINK_EXIT ? process.exit(0) : process.env.TEST_LINK_FAIL ? process.stderr.write('\\n' + process.env.TEST_LINK_FAIL, () => process.exit(1)) : null;
  process.stdout.write(output.slice(0, output.indexOf('state=') + 8));
  setImmediate(() => process.stdout.write(output.slice(output.indexOf('state=') + 8), ends));
}
createInterface({ input: process.stdin }).on('line', code => {
  if (process.env.TEST_FAIL) { console.error('private-upstream-secret ' + code); process.exit(1); }
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'credential'), 'test-private-token', { mode: 0o600 });
  process.exit(0);
});
`, { mode: 0o755 });
  // The machine's own environment, with a refresh token that must not be imported instead of a fresh login.
  const env = extra => pluginEnv('claude', { ...substituted({ '@anthropic-ai/claude-agent-sdk': entry }),
    CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'old-refresh', ...extra });
  return { dir, env };
}
const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
const authorizationCode = { input: 'authorizationCode' };

test('Claude reports only its official link, hands only the bound code to its CLI, and keeps no credential of its own', async t => {
  const { dir, env } = await sdk(t), coda = await fakeCoda(dir, env(), { code: 'one-time-code#test-state' });
  const login = operation(t, 'claude', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal(login.stdout, '{}\n');
  // The link alone, once the CLI said it whole; then the question for the code.
  assert.deepEqual(await coda.calls(), [{ command: 'progress', input: { url } }, { command: 'ask', input: authorizationCode }]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'invocation.json'), 'utf8')), { args: ['auth', 'login', '--claudeai'], browser: '/usr/bin/true', refresh: null },
    'no browser opens on the machine, and a refresh token in the environment is not imported instead');
  assert.equal(await readFile(join(dir, 'credential'), 'utf8'), 'test-private-token');
  assert.equal(/one-time-code|test-private-token/.test(login.stdout + login.stderr), false);
});

test('a code for another login, or a CLI that refuses it, ends the login with a line of its own, the credential before untouched', async t => {
  for (const [extra, code, error] of [[{}, 'one-time-code#other-state', '授权码不对：要贴这次登录的网页给出的完整授权码，请重新登录。'],
    [{ TEST_FAIL: '1' }, 'one-time-code#test-state', 'Claude 登录没有完成，请重新登录。']]) {
    const { dir, env } = await sdk(t), coda = await fakeCoda(dir, env(extra), { code });
    await writeFile(join(dir, 'credential'), 'previous-token');
    const login = operation(t, 'claude', 'scripts/sign-in.mjs', coda.env);
    assert.equal(await login.ended, 1);
    assert.equal(lastLine(login.stderr), error, 'the line Coda shows');
    assert.equal(login.stdout, '');
    assert.equal(await readFile(join(dir, 'credential'), 'utf8'), 'previous-token');
    assert.equal(/one-time-code|private-upstream-secret/.test(login.stdout + login.stderr), false);
  }
});

test('the record says whether the SDK\'s CLI is there, and that the login asks for the authorization code', async t => {
  const { dir, env } = await sdk(t);
  const signIn = async () => (await resourceRecords(pluginDir('claude'), { env: env({ CODA_PLUGIN_STATE: dir }) }))[0].spec.signIn;
  assert.deepEqual(await signIn(), { installed: true, installable: false, input: 'authorizationCode', note: (await signIn()).note });
  await rm(join(dir, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`), { recursive: true });
  assert.equal((await signIn()).installed, false);
});

test('a CLI that ends before its link says why, in its last line; one that never prints it is given up on, whatever it says and how it ends', async t => {
  // Before there is a link what the CLI said is the reason: it has not seen a code.
  const early = await sdk(t), earlyCoda = await fakeCoda(early.dir, early.env({ TEST_EARLY_FAIL: 'Error: cannot reach claude.ai' }));
  const ended = operation(t, 'claude', 'scripts/sign-in.mjs', earlyCoda.env);
  assert.equal(await ended.ended, 1);
  assert.equal(lastLine(ended.stderr), 'Error: cannot reach claude.ai');
  assert.deepEqual(await earlyCoda.calls(), []);
  // No link in time: the reason is what the CLI said then, not what it says when ended (「登录已取消」, with the exit code 0).
  const silent = await sdk(t), watch = { ack: join(silent.dir, 'ack'), gate: join(silent.dir, 'gate') };
  const silentCoda = await fakeCoda(silent.dir, probed(silent.env({ TEST_SILENT: '1' }), watch));
  const given = operation(t, 'claude', 'scripts/sign-in.mjs', silentCoda.env);
  await endWait(watch, 'Contacting claude.ai…');
  assert.equal(await given.ended, 1);
  assert.equal(given.stdout, '');
  assert.equal(lastLine(given.stderr), 'Contacting claude.ai…');
  assert.deepEqual(await silentCoda.calls(), []);
});

test('the link is reported before the login is settled, and a report that fails fails the login, whatever the CLI does', async t => {
  // The CLI ends 0 as soon as it has printed its link; the report fails only once the login has dealt with that: it is waited for.
  const { dir, env } = await sdk(t), ack = join(dir, 'ack');
  const coda = await fakeCoda(dir, probed(env({ TEST_LINK_EXIT: '1', FAKE_CODA_AFTER_EXIT: ack, FAKE_CODA_FAIL: 'progress' }), { ack, gate: join(dir, 'gate') }));
  const login = operation(t, 'claude', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'coda progress 没有成功');
  assert.deepEqual(await coda.calls(), [], 'no question for the code of a login that failed');
});

test('a CLI that has ended by the time its link is reported is not asked for a code: its last line is the reason', async t => {
  // The CLI says its link and ends 1 with why; the report is made only once the login has dealt with that.
  const { dir, env } = await sdk(t), ack = join(dir, 'ack');
  const coda = await fakeCoda(dir, probed(env({ TEST_LINK_FAIL: 'Error: session expired', FAKE_CODA_AFTER_EXIT: ack }), { ack, gate: join(dir, 'gate') }));
  const login = operation(t, 'claude', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'Error: session expired');
  assert.deepEqual((await coda.calls()).map(call => call.command), ['progress']);
  assert.ok(noted(ack).includes('[run coda progress]') && !noted(ack).includes('[run coda ask]'), 'no question for the code was even started');
});
