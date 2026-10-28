#!/usr/bin/env node
// The plugin contract as Coda's deploy workflow `sync-plugin-check` wrote it (Coda's scripts/plugin-contract.mjs): every file
// check/coda/contract.json lists hashes to its sha256, check/coda/ holds nothing else, and each package the copy needs is a
// dependency of the check package at the very version Coda runs it with. Nothing here edits the copy; Coda's next sync
// replaces it.
//
//   node scripts/check-contract.mjs   CI：副本与 Coda 同步时一致
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)), COPY = 'check/coda';

const filesIn = (root, dir) => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? filesIn(root, `${dir}/${e.name}`) : [`${dir}/${e.name}`]);

// What is wrong with the copy in `root`, or [].
export function contractProblems(root = ROOT) {
  const contract = JSON.parse(readFileSync(join(root, COPY, 'contract.json'), 'utf8'));
  const dependencies = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {}, problems = [];
  for (const [path, sha256] of Object.entries(contract.files)) {
    if (!existsSync(join(root, path))) problems.push(`${path} 不见了`);
    else if (createHash('sha256').update(readFileSync(join(root, path))).digest('hex') !== sha256) problems.push(`${path} 与 Coda 同步的不一样：不要手改，等 Coda 的下一次同步`);
  }
  for (const path of filesIn(root, COPY)) if (path !== `${COPY}/contract.json` && !Object.hasOwn(contract.files, path)) problems.push(`${path} 不在 contract.json 里：${COPY}/ 只放 Coda 同步来的文件`);
  for (const [name, version] of Object.entries(contract.packages))
    if (dependencies[name] !== version) problems.push(`package.json 的 dependencies 要有 ${name} ${version}（Coda 用的版本），现为 ${dependencies[name] ?? '没有'}`);
  return problems;
}

// Run as a script, not imported (by the tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const problems = contractProblems(), { commit, files } = JSON.parse(readFileSync(join(ROOT, COPY, 'contract.json'), 'utf8'));
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`插件契约与 Coda ${commit.slice(0, 7)} 同步的一致：${Object.keys(files).length} 个文件，依赖的版本相同`);
}
