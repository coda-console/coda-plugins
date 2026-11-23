#!/usr/bin/env node
// 无宿主的静态校验：plugins/* 各插件的 package.json 对协议 schema，.coda/workflows 与 .coda/capabilities 的 BPMN 对 Coda 的方言。
// 握手与一轮要 Coda 宿主，在那里用 `coda plugin check <dir>`。
//   node scripts/check-plugins.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestProblem } from '@coda-console/protocol/validate';
import { workflowProblem } from '@coda-console/protocol/workflow';

const PLUGINS = fileURLToPath(new URL('../plugins', import.meta.url));

export async function pluginProblems(dir, id) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) { return [`plugins/${id}/package.json：${e.message}`]; }
  const problem = manifestProblem(manifest, dir);
  if (problem) problems.push(`plugins/${id}/package.json：${problem}`);
  for (const kind of ['workflows', 'capabilities']) {
    const folder = join(dir, '.coda', kind);
    let files;
    try { files = readdirSync(folder).filter(file => file.endsWith('.bpmn')).sort(); } catch (e) {
      if (e.code !== 'ENOENT') problems.push(`plugins/${id}/.coda/${kind}：${e.message}`);
      continue;
    }
    for (const file of files) {
      const found = await workflowProblem(readFileSync(join(folder, file), 'utf8'), file.slice(0, -'.bpmn'.length));
      if (found) problems.push(`plugins/${id}/.coda/${kind}/${file}：${found}`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ids = readdirSync(PLUGINS).sort(), problems = [];
  for (const id of ids) problems.push(...await pluginProblems(join(PLUGINS, id), id));
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`${ids.length} 个插件的清单与工作流都通过静态校验`);
}
