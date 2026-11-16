// 泳道 PR 的小改动免主控审查（README.md「小改动免主控审查」）：资格判定。纯函数，不读写文件、不跑命令；改动与 diff 由调用方用 git 取来。
import { SLOTS } from './shared.mjs';

// 测试文件：test/ 下的任何文件（含测试夹具），或别处的 *.test.mjs、*.test.js、*Tests.swift（不在 .coda、.github、scripts、check、bin、docs 下）。
export const isTest = path => path.startsWith('test/')
  || /\.test\.m?js$|Tests\.swift$/.test(path) && !path.split('/').some(part => ['.coda', '.github', 'scripts', 'check', 'bin', 'docs'].includes(part));
// 非契约说明文档：仓库根或插件目录下的 README.md、THIRD_PARTY_NOTICES.md。其余一律不免审。
export const isMinorPath = path => isTest(path) || /^(plugins\/[^/]+\/)?(README|THIRD_PARTY_NOTICES)\.md$/.test(path);

// git diff --raw -z -M 的输出：每项 `:<旧 mode> <新 mode> <旧 sha> <新 sha> <状态>`，后跟一个路径，重命名、复制跟旧、新两个路径。
export function parseRaw(text) {
  const parts = text.split('\0'), changes = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const [oldMode, newMode, , , status] = parts[i++].slice(1).split(' ');
    const count = /^[RC]/.test(status) ? 2 : 1;
    changes.push({ status: status[0], modes: [oldMode, newMode], paths: parts.slice(i, i += count) });
  }
  return changes;
}

const SKIP = /\.(skip|todo)\b|\{\s*(skip|todo)\s*:/;

// 不能免审的原因，空数组就是可以免审。reviews 是评审子流程各份的输出，findings 是收敛账本，
// changes 是 parseRaw 的结果，patches 是每个测试文件 diff 的新增行与删除行：{ [路径]: { added: [], removed: [] } }。
export function autoLandReasons({ auto, sync, stack, head, checks, reviews, findings = [], changes, patches }) {
  const reasons = [];
  if (!auto) reasons.push('没开小改动免主控审查（autoLandMinor）');
  if (sync) reasons.push('跟上目标分支的泳道 PR 不免审');
  if (stack && !stack.restacked) reasons.push('叠放的前置泳道 PR 还没合进泳道、没有重接');
  if (checks?.head !== head) reasons.push('当前 head 的项目检查没有通过');
  const slots = reviews.filter(r => r.state !== 'skipped');
  if (!slots.length) reasons.push('没有评审者');
  for (const r of slots) {
    const who = SLOTS[r.slot];
    if (r.state !== 'done') reasons.push(`${who}没评成`);
    else if (r.reviewed !== head) reasons.push(`${who}评的不是当前 head`);
    else if (r.decision !== 'APPROVE') reasons.push(`${who}的结论是 ${r.decision}，不是 APPROVE`);
    else if (JSON.parse(r.findings).length) reasons.push(`${who}这次有发现`);
  }
  if (findings.some(f => f.status === 'open')) reasons.push('收敛账本里还有没关的发现');
  if (!changes.length) reasons.push('没有改动的文件');
  for (const { status, modes, paths } of changes) {
    if (modes.some(mode => mode === '120000' || mode === '160000')) reasons.push(`${paths.join(' → ')} 是符号链接或子模块`);
    const outside = paths.filter(path => !isMinorPath(path));
    if (outside.length) reasons.push(`改了测试与说明文档以外的文件：${outside.join('、')}`);
    else if (status === 'D' && paths.some(isTest)) reasons.push(`删了测试文件 ${paths[0]}`);
  }
  for (const [path, { added, removed }] of Object.entries(patches)) {
    if (added.some(line => SKIP.test(line))) reasons.push(`${path} 新增了 skip 或 todo`);
    if (removed.some(line => line.includes('assert.')) && !added.some(line => line.includes('assert.'))) reasons.push(`${path} 删了断言、没有新增断言`);
  }
  return reasons;
}
