#!/usr/bin/env node
// Default: publish versions not on npm yet. --bootstrap: reserve missing names at 0.0.0 and configure trusted publishing.
// Run bootstrap only after publish.yml is on main, then dispatch it within npm's two-day validation window.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REGISTRY = 'https://registry.npmjs.org';
const REPO = 'coda-console/coda-plugins';
const WORKFLOW = 'publish.yml';

export function packages(root = ROOT) {
  return ['.', ...readdirSync(join(root, 'plugins')).sort().map(id => `plugins/${id}`)].map(path => {
    const dir = resolve(root, path), manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!/^@coda-console\/[a-z][a-z0-9-]*$/.test(manifest.name) || manifest.publishConfig?.access !== 'public')
      throw new Error(`${path} 没有公开的 @coda-console 包名`);
    return { dir, manifest };
  });
}

// Only a registry 404 means absent; authentication, network and server failures must stop the release.
export function published(spec, run = spawnSync) {
  const result = run('npm', ['view', spec, 'version', '--json', `--registry=${REGISTRY}`], { encoding: 'utf8' });
  if (result.status === 0) return true;
  let error;
  try { error = JSON.parse(result.stdout).error; } catch {}
  if (error?.code === 'E404') return false;
  throw new Error(`读取 ${spec} 失败：${result.error?.message ?? result.stderr ?? result.stdout}`);
}

// npm's own words for a version that is already there; a bare E403 may be missing permission and must still fail.
const EXISTS = /Cannot publish over previously staged version|You cannot publish over the previously published versions?/;

// The registry can lag behind a version published moments ago, so `published` says absent. If npm then refuses it as existing,
// it is published; any other failure stops the release.
export function publish(spec, cwd, run = spawnSync) {
  const result = run('npm', ['publish', '--access=public', '--ignore-scripts', `--registry=${REGISTRY}`], { cwd, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) return false;
  const exists = EXISTS.exec(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  if (!exists) throw new Error(`发布 ${spec} 失败：${result.error?.message ?? `npm 退出码 ${result.status}`}`);
  console.log(`${spec} 已在 npm 上（${exists[0]}），当作已发布`);
  return true;
}

const npm = (args, cwd) => execFileSync('npm', [...args, `--registry=${REGISTRY}`], { cwd, stdio: 'inherit' });

async function main() {
  const { values: { bootstrap, 'dry-run': dryRun } } = parseArgs({ options: { bootstrap: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  for (const { dir, manifest } of packages()) {
    const { name, version } = manifest;
    if (dryRun) {
      console.log(`${name}@${version}`);
      npm(['pack', '--dry-run', '--ignore-scripts'], dir);
      continue;
    }
    if (!bootstrap) {
      if (published(`${name}@${version}`)) { console.log(`${name}@${version} 已发布，跳过`); continue; }
      publish(`${name}@${version}`, dir);
      continue;
    }
    if (!published(name)) {
      const stage = mkdtempSync(join(tmpdir(), 'coda-npm-bootstrap-'));
      try {
        writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', description: 'Reserved for the first Coda plugin release.',
          license: 'MIT', repository: manifest.repository, publishConfig: { access: 'public' } }, null, 2)}\n`);
        writeFileSync(join(stage, 'README.md'), `# ${name}\n\nBootstrap placeholder. The usable release will be published by ${REPO}.\n`);
        writeFileSync(join(stage, 'LICENSE'), readFileSync(join(ROOT, 'LICENSE')));
        npm(['publish', '--access=public', '--tag=bootstrap', '--ignore-scripts'], stage);
      } finally { rmSync(stage, { recursive: true, force: true }); }
    }
    // npm trust list --json prints nothing when empty and one JSON object per existing connection.
    const trust = execFileSync('npm', ['trust', 'list', name, '--json', `--registry=${REGISTRY}`], { encoding: 'utf8' }).trim();
    if (!trust) {
      npm(['trust', 'github', name, '--repo', REPO, '--file', WORKFLOW, '--allow-publish', '--yes'], dir);
    } else {
      // Do not replace an existing trust connection automatically.
      console.log(`${name} 已有可信发布配置，请核对：${trust}`);
    }
    await delay(2000);
  }
  if (bootstrap && !dryRun) console.log('首发占位与配置已处理。请核对所有可信发布配置，再立即运行 gh workflow run publish.yml --repo coda-console/coda-plugins --ref main。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
