// The setup's decision (scripts/setup.mjs) against a stand-in `--version`, and the entry relaying Coda's instructions (the entry's own: entry.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINIMUM, needed } from '../../../plugins/antigravity/scripts/setup.mjs';
import { manifest, operation, pluginEnv, run as runCommand } from '../command.mjs';
import { relaysInstructions } from '../relay.mjs';

test('the entry relays agy acp from ~/.local/bin and forwards Coda instructions unchanged', t =>
  relaysInstructions(t, 'antigravity', '.local/bin/agy', ['acp']));

test('setup installs a missing CLI, upgrades an old one, reports one that does not run, and keeps one that is new enough', () => {
  const run = (status, stdout = '', stderr = '') => () => ({ status, stdout, stderr });
  assert.equal(MINIMUM, '1.5.9');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/agy', run(127)).action, 'broken');
  assert.match(needed('/bin/agy', run(127)).reason, /无法运行（\/bin\/agy）/);
  assert.equal(needed('/bin/agy', run(0, 'agy\n')).action, 'upgrade');
  assert.equal(needed('/bin/agy', run(0, '1.5.8\n')).action, 'upgrade');
  assert.match(needed('/bin/agy', run(0, '1.5.8\n')).reason, /1\.5\.8 低于所需的 1\.5\.9/);
  assert.equal(needed('/bin/agy', run(0, '1.4.20\n')).action, 'upgrade');
  assert.equal(needed('/bin/agy', run(0, '', '0.9.99')).action, 'upgrade', 'a version printed on standard error is read too');
  assert.deepEqual(needed('/bin/agy', run(0, '1.5.9\n')), { action: 'none', version: '1.5.9' });
  assert.deepEqual(needed('/bin/agy', run(0, '1.10.0\n')), { action: 'none', version: '1.10.0' });
});

// Google's installer in a machine's home, with a curl that serves one in place of Google's: it notes the HOME and arguments it
// runs with, edits the profiles of that HOME as `agy install` does, and puts an `agy` in --dir. `start(env)`: what runs the setup.
async function installs(t, start) {
  const home = await mkdtemp(join(tmpdir(), 'coda-antigravity-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const profile of ['.bashrc', '.zshrc', '.profile']) await writeFile(join(home, profile), `# ${profile}\n`);
  await mkdir(join(home, 'fake-bin'));
  await writeFile(join(home, 'fake-bin/curl'), `#!/bin/sh
cat <<'EOT'
echo "$HOME|$*" > "${home}/ran"
echo 'export PATH=x' >> "$HOME/.bashrc"
mkdir -p "$2" && printf '%s\\n' '#!/bin/sh' 'echo 1.5.9' > "$2/agy" && chmod +x "$2/agy"
EOT
`, { mode: 0o755 });
  const ran = await start(pluginEnv('antigravity', { HOME: home, CODA_NODE: process.execPath, PATH: `${join(home, 'fake-bin')}:/usr/bin:/bin` }));
  const [installerHome, args] = (await readFile(join(home, 'ran'), 'utf8')).trimEnd().split('|');
  assert.notEqual(installerHome, home, 'the installer runs with another HOME');
  assert.equal(args, `--dir ${join(home, '.local/bin')}`);
  assert.equal(existsSync(installerHome), false, 'and it is removed');
  for (const profile of ['.bashrc', '.zshrc', '.profile']) assert.equal(await readFile(join(home, profile), 'utf8'), `# ${profile}\n`, profile);
  return ran;
}

test('setup installs with Google\'s installer under a temporary HOME, the binary going to the real ~/.local/bin, and leaves the shell profiles alone', async t => {
  const ran = await installs(t, env => runCommand(manifest('antigravity').contributes.setup.command, env));
  assert.deepEqual([ran.code, ran.stdout.trim(), ran.stderr.trim().split('\n').at(-1)], [0, '{}', 'Antigravity CLI 1.5.9'], ran.stderr);
});

test('the `install` operation is the setup, run as a command of its own, and its result is {}', async t => {
  const { commands } = manifest('antigravity').contributes.protocolImplementations.find(one => one.kind === 'coda/resource@1');
  assert.equal(commands.install, 'scripts/setup.mjs');
  const ran = await installs(t, async env => {
    const install = operation(t, 'antigravity', commands.install, env);
    return { code: await install.ended, stdout: install.stdout, stderr: install.stderr };
  });
  assert.deepEqual([ran.code, ran.stdout], [0, '{}\n'], ran.stderr);
});
