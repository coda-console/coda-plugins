// The plugins of this repository as Coda takes them: each passes the checker's manifest level, declares in its package.json
// exactly the packages its code uses, with a package-lock.json npm ci installs from, and finds them in its own
// node_modules (Coda installs them in the plugin's version directory, with nothing above it to fall back on). A package
// one of its `extensionDependencies` declares it may use from that plugin's directory instead (CODA_PLUGIN_DEPENDENCIES).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../../check/index.mjs';
import { claudeBinary } from '../../plugins/claude/scripts/login.mjs';
import { codexCli } from '../../plugins/codex-accounts/scripts/app-server.mjs';
import { pluginDir, resolveFrom } from './plugin.mjs';
import { pluginEnv, run } from './command.mjs';

const plugins = readdirSync(fileURLToPath(new URL('../../plugins', import.meta.url))).filter(id => existsSync(join(pluginDir(id), 'package.json')));
const manifest = id => JSON.parse(readFileSync(join(pluginDir(id), 'package.json'), 'utf8'));
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' ? []
  : e.isDirectory() ? files(join(dir, e.name)) : /\.[cm]?js$/.test(e.name) ? [join(dir, e.name)] : []);

// The text of a call's arguments, from just after its opening parenthesis to the one that closes it.
function argumentsAt(source, open) {
  let depth = 1, i = open;
  for (; i < source.length && depth; i++) depth += source[i] === '(' ? 1 : source[i] === ')' ? -1 : 0;
  return source.slice(open, i - 1);
}
// Every package a file asks for by name: `import … from`, `import '…'`, `export … from`, and the names in the arguments of
// `import()`, `require()` and the module resolvers (import.meta.resolve, require.resolve, createRequire(…).resolve, and a
// name bound to a createRequire) — multi-line, conditional and fallback forms included. A name built at run time (a
// template with ${…}) is the business of the package it is resolved beside, and is left out.
export function packagesUsed(source) {
  const names = [], requires = [...source.matchAll(/\b([\w$]+)\s*=\s*createRequire\s*\(/g)].map(m => m[1]);
  const calls = new RegExp(String.raw`\b(?:import|require)\s*\(|(?:\bimport\.meta|\brequire|\)${requires.map(r => `|\\b${r}`).join('')})\.resolve\s*\(`, 'g');
  for (const m of source.matchAll(/\b(?:from|import)\s*(['"])([^'"\n]+)\1/g)) names.push(m[2]);
  for (const m of source.matchAll(calls))
    for (const s of argumentsAt(source, m.index + m[0].length).matchAll(/(['"`])((?:(?!\1)[^\\\n])*)\1/g)) if (!s[2].includes('${')) names.push(s[2]);
  return [...new Set(names.filter(n => /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/.*)?$/.test(n) && !n.startsWith('node:') && !builtinModules.includes(n.split('/')[0]))
    .map(n => n.split('/').slice(0, n.startsWith('@') ? 2 : 1).join('/')))];
}

test('a package is found however a plugin asks for it, and only a package', () => {
  assert.deepEqual(packagesUsed(`import { a,\n  b } from '@x/one';\nconst c = await import(process.env.X ? pathToFileURL(process.env.X).href : '@x/two');
    createRequire(env.Y || createRequire(import.meta.url).resolve('three/sub/file.js')); new URL(import.meta.resolve('@x/four/bin/x.js'));
    import('./local.mjs'); import { join } from 'node:path'; require('fs'); sdk.resolve(\`@x/five-\${arch}/bin\`); spawn('kimi', ['acp']);
    Promise.resolve({ action: 'cancel' }); const req = createRequire(here); req.resolve('six');`),
  ['@x/one', '@x/two', 'three', '@x/four', 'six']);
});

describe('the plugins here', () => {
  for (const id of plugins) describe(`plugins/${id}`, () => {
    const dir = pluginDir(id), { dependencies = {}, optionalDependencies = {}, overrides = {}, extensionDependencies = [] } = manifest(id);
    const declared = Object.keys({ ...dependencies, ...optionalDependencies }).sort();
    // What a plugin it depends on brings, it may use too: of those here. One Coda ships itself (review's github) is not here.
    const theirs = extensionDependencies.filter(other => plugins.includes(other)).flatMap(other => Object.keys(manifest(other).dependencies ?? {}));
    const used = [...new Set(files(dir).flatMap(file => packagesUsed(readFileSync(file, 'utf8'))))].filter(name => !theirs.includes(name)).sort();

    test('passes the checker\'s manifest level', async () => {
      const { report } = await checkPlugin(dir, { manifestOnly: true });
      assert.deepEqual(report.failures, []);
    });
    test('declares exactly the packages its code uses', () => {
      assert.deepEqual(declared, used);
    });
    if (!declared.length) return;
    test('has a package-lock.json that npm ci installs from: the same dependencies, and its overrides taken', () => {
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')), packages = lock.packages;
      assert.deepEqual(packages[''].dependencies, dependencies);
      for (const [name, version] of Object.entries(dependencies)) assert.equal(packages[`node_modules/${name}`]?.version, version, name);
      // An override to the root's own version (`$name`) leaves one copy, the root's.
      for (const [parent, nested] of Object.entries(overrides)) for (const [name, value] of Object.entries(nested)) {
        assert.equal(value, `$${name}`);
        assert.equal(packages[`node_modules/${parent}/node_modules/${name}`], undefined, `${parent} has its own ${name}`);
        assert.equal(packages[`node_modules/${name}`].version, dependencies[name]);
      }
    });
    test('finds what it uses in its own node_modules, as ES modules resolve from its directory', () => {
      const specifiers = [...new Set(files(dir).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/(['"])((@[\w.-]+\/)?[\w.-]+(\/[\w./-]+)?)\1/g)]
        .map(m => m[2]).filter(s => used.some(name => s === name || s.startsWith(`${name}/`)))))];
      let found;
      try {
        found = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
          `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(s => import.meta.resolve(s))))`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (e) { assert.fail(`plugins/${id} 的依赖没装：在 plugins/${id} 里 npm ci，或 node scripts/install-plugins.mjs（${e.stderr?.match(/Cannot find package '[^']+'/)?.[0] ?? e.message}）`); }
      assert.ok(specifiers.length >= declared.length);
      for (const [i, url] of found.entries()) {
        const path = fileURLToPath(url);
        assert.ok(!relative(join(dir, 'node_modules'), path).startsWith(`..${sep}`) && statSync(path).isFile(), `${specifiers[i]} → ${path}`);
      }
      for (const name of declared) assert.equal(JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version, dependencies[name], name);
    });
  });

  test('codex-acp runs the plugin\'s own Codex, the version the plugin pins', () => {
    const adapter = resolveFrom('codex', '@agentclientprotocol/codex-acp');
    const codex = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { createRequire } from 'node:module'; console.log(createRequire(${JSON.stringify(adapter)}).resolve('@openai/codex/package.json'))`], { encoding: 'utf8' }).trim();
    assert.equal(relative(pluginDir('codex'), codex), join('node_modules', '@openai', 'codex', 'package.json'));
    assert.equal(JSON.parse(readFileSync(codex, 'utf8')).version, manifest('codex').dependencies['@openai/codex']);
  });
  test('codex-accounts runs the Codex of the codex plugin it depends on', () => {
    const cli = codexCli({ CODA_PLUGIN_DEPENDENCIES: JSON.stringify({ codex: pluginDir('codex') }) });
    assert.equal(relative(pluginDir('codex'), cli), join('node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  });
  test('the Claude panel\'s login finds the CLI beside the plugin\'s own Claude SDK', () => {
    const binary = claudeBinary();
    assert.ok(binary && relative(join(pluginDir('claude'), 'node_modules', '@anthropic-ai'), binary).split(sep)[0].startsWith('claude-agent-sdk-'), binary);
  });
  // Where each plugin's setup finds its CLI first, and what a recent enough one says to `--version`.
  const ready = { kimi: ['.kimi-code/bin/kimi', 'kimi 2.1.1', 'Kimi CLI 2.1.1'], grok: ['.grok/bin/grok', 'grok 1.0.52', 'Grok CLI 1.0.52'],
    opencode: ['.opencode/bin/opencode', 'opencode v2.1.4', 'OpenCode CLI 2.1.4'], cursor: ['.local/bin/cursor-agent', '2026.05.09-0afadcc', 'Cursor CLI 2026.05.09-0afadcc'] };
  test('a setup, run as Coda runs it, ends well and installs nothing when the machine\'s CLI is recent enough', async t => {
    // Magpie's makes sure of a gateway, not a CLI's version: test/plugins/magpie/.
    assert.deepEqual(plugins.filter(id => manifest(id).contributes.setup && id !== 'magpie').sort(), Object.keys(ready).sort(), 'codex and claude bring theirs as npm dependencies');
    for (const [id, [binary, says, line]] of Object.entries(ready)) {
      const home = mkdtempSync(join(tmpdir(), `coda-${id}-setup-`));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      mkdirSync(join(home, dirname(binary)), { recursive: true });
      writeFileSync(join(home, binary), `#!/bin/sh\n[ "$1" = --version ] && echo '${says}'\n`, { mode: 0o755 });
      // No curl on the PATH: an install would fail rather than reach the network.
      const ran = await run(manifest(id).contributes.setup.command, pluginEnv(id, { HOME: home, CODA_NODE: process.execPath, PATH: '/bin' }));
      assert.deepEqual([ran.code, ran.stdout.trim(), ran.stderr], [0, line, ''], id);
    }
  });
});
