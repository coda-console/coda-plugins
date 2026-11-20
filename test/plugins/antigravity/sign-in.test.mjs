// The「Antigravity」type's sign-in (scripts/sign-in.mjs, the `sign-in` operation of `coda/resource@1`) run as Coda runs it, with an
// `agy` and a `coda` standing in for the real ones: the `coda` notes the link it is told of and answers the question for the code.
// What the sign-in waits for is never the clock: the CLI waits for the login to have dealt with what it printed (a file the login
// notes it in), the login's 20 seconds for a link end when the test says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationLink } from '../../../plugins/antigravity/scripts/sign-in.mjs';
import { endWait, fakeCoda, noted, operation, pluginEnv, probed } from '../command.mjs';

// What `agy acp --login` prints with no terminal, with made-up state and challenge.
const url = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1.apps.googleusercontent.com&code_challenge=FAKE-challenge&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&response_type=code&scope=openid+email&state=FAKE-state';
const prompt = `Open this link in a browser to log in with Google:\n\n  ${url}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`;
const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
const authorizationCode = { input: 'authorizationCode' };

test('the link is the first one on a whole line, terminal hyperlinks included; a line cut short has none', () => {
  assert.equal(authorizationLink(prompt).href, url);
  assert.equal(authorizationLink(prompt.slice(0, prompt.indexOf('state=') + 8)), null, 'a line cut short is not read');
  assert.equal(authorizationLink(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`).href, url);
  assert.equal(authorizationLink('Contacting Google…\n'), null);
});

// A machine's home with an `agy` where its installer puts it, printing as the real one does, the first piece ending inside the
// link, and keeping the code it is given. TEST_EARLY_FAIL: ends 1 with that line before any link; TEST_SILENT: says nothing of a link,
// and 0 when it is ended; TEST_LINK_EXIT: ends 0 as soon as it has said the link; TEST_LINK_FAIL: ends 1 with that line then;
// TEST_FAIL: refuses the code, saying it back; TEST_OTHER_STREAM: says a whole line on the other stream between the pieces.
async function machine(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-antigravity-sign-in-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await writeFile(join(home, '.local/bin/agy'), `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const home = process.env.HOME, ack = process.env.TEST_START_ACK;
writeFileSync(join(home, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), browser: process.env.BROWSER, color: process.env.NO_COLOR }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const heard = () => existsSync(ack) ? readFileSync(ack, 'utf8') : '';
const write = (stream, text) => new Promise(resolve => process[stream].write(text, resolve));
// Waits until the login has dealt with what was printed.
const until = async text => { while (!heard().includes(text)) await sleep(10); };
const prompt = ${JSON.stringify(prompt)}, cut = prompt.indexOf('state=') + 8;
if (process.env.TEST_EARLY_FAIL) { console.error(process.env.TEST_EARLY_FAIL); process.exit(1); }
if (process.env.TEST_SILENT) { console.log('Contacting Google…'); process.on('SIGTERM', () => { console.log('登录已取消'); process.exit(0); }); setInterval(() => {}, 1000); }
else {
  await write('stdout', prompt.slice(0, cut));
  await until('state=FA');
  writeFileSync(join(home, 'reported-early'), String(heard().includes('[run coda')));
  if (process.env.TEST_OTHER_STREAM) { await write('stderr', 'Checking the network...\\n'); await until('Checking the network...'); }
  await write('stdout', prompt.slice(cut));
  if (process.env.TEST_LINK_EXIT) process.exit(0);
  if (process.env.TEST_LINK_FAIL) { await write('stderr', process.env.TEST_LINK_FAIL); process.exit(1); }
  createInterface({ input: process.stdin }).on('line', code => {
    if (process.env.TEST_FAIL) { console.error('private-upstream-secret ' + code); process.exit(1); }
    writeFileSync(join(home, 'code'), code);
    console.log('Logged in as me@example.com.');
    process.exit(0);
  });
}
`, { mode: 0o755 });
  const watch = { ack: join(home, 'ack'), gate: join(home, 'gate') };
  const env = pluginEnv('antigravity', { HOME: home, ...extra, ...(extra.FAKE_CODA_AFTER_EXIT ? { FAKE_CODA_AFTER_EXIT: watch.ack } : {}) });
  const coda = await fakeCoda(home, probed(env, watch), { code: '4/0AFAKE-code' });
  return { home, coda, watch, login: operation(t, 'antigravity', 'scripts/sign-in.mjs', coda.env) };
}

test('the sign-in reports the whole link, asks for the code once, hands it to the CLI, opens no browser, and ends well once the CLI does', async t => {
  const { home, coda, login } = await machine(t);
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal(login.stdout, '{}\n');
  assert.deepEqual(await coda.calls(), [{ command: 'progress', input: { url } }, { command: 'ask', input: authorizationCode }]);
  assert.equal(await readFile(join(home, 'reported-early'), 'utf8'), 'false', 'nothing was reported of a link cut short');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'invocation.json'), 'utf8')), { args: ['acp', '--login'], browser: '/usr/bin/true', color: '1' });
  assert.equal(await readFile(join(home, 'code'), 'utf8'), '4/0AFAKE-code');
  assert.equal(/FAKE-code|me@example/.test(login.stdout + login.stderr), false, 'nothing of what was said after the code');
});

test('a line is read from one stream only: the other stream speaking in the middle of the link does not cut it', async t => {
  const { coda, login } = await machine(t, { TEST_OTHER_STREAM: '1' });
  assert.equal(await login.ended, 0, login.stderr);
  assert.deepEqual((await coda.calls())[0], { command: 'progress', input: { url } });
});

test('a CLI that refuses the code ends the login with a line of its own, not what the CLI said', async t => {
  const { login } = await machine(t, { TEST_FAIL: '1' });
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), '登录没有完成，请重新登录。');
  assert.equal(/private-upstream-secret|FAKE-code/.test(login.stderr), false);
});

test('a CLI that ends before its link says why, in its last line; one that never prints it is given up on, whatever it says and how it ends', async t => {
  const early = await machine(t, { TEST_EARLY_FAIL: 'Error: cannot reach Google' });
  assert.equal(await early.login.ended, 1);
  assert.equal(lastLine(early.login.stderr), 'Error: cannot reach Google');
  assert.deepEqual(await early.coda.calls(), []);
  // No link in time: the reason is what the CLI said then, not what it says when ended (「登录已取消」, with the exit code 0).
  const silent = await machine(t, { TEST_SILENT: '1' });
  await endWait(silent.watch, 'Contacting Google…');
  assert.equal(await silent.login.ended, 1);
  assert.equal(silent.login.stdout, '');
  assert.equal(lastLine(silent.login.stderr), 'Contacting Google…');
  assert.deepEqual(await silent.coda.calls(), []);
});

test('the link is reported before the login is settled, and a report that fails fails the login, whatever the CLI does', async t => {
  // The CLI ends 0 as soon as it has said its link; the report fails only once the login has dealt with that exit.
  const { login, coda } = await machine(t, { TEST_LINK_EXIT: '1', FAKE_CODA_AFTER_EXIT: '1', FAKE_CODA_FAIL: 'progress' });
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'coda progress 没有成功');
  assert.deepEqual(await coda.calls(), [], 'no question for the code of a login that failed');
});

test('a CLI that has ended by the time its link is reported is not asked for a code: its last line is the reason', async t => {
  const { home, login, coda } = await machine(t, { TEST_LINK_FAIL: 'Error: session expired', FAKE_CODA_AFTER_EXIT: '1' });
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'Error: session expired');
  assert.deepEqual((await coda.calls()).map(call => call.command), ['progress']);
  assert.ok(!noted(join(home, 'ack')).includes('[run coda ask]'), 'no question for the code was even started');
});

test('without an Antigravity CLI the sign-in says so', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-antigravity-sign-in-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const login = operation(t, 'antigravity', 'scripts/sign-in.mjs', pluginEnv('antigravity', { HOME: home, PATH: '/usr/bin:/bin' }));
  assert.equal(await login.ended, 1);
  assert.equal(login.stderr.trim(), '找不到 Antigravity CLI');
});
