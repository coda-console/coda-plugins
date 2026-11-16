// 泳道 PR 的小改动免主控审查（README.md「小改动免主控审查」）：资格判定。纯函数，不读写文件、不跑命令；改动与 diff 由调用方用 git 取来。
import { SLOTS } from './shared.mjs';

// 测试文件：先排除 AGENTS.md、CLAUDE.md、package.json、package-lock.json 与 .coda、.github、scripts、check、bin、docs 下的路径（test/ 下也一样），
// .bpmn 只认 test/ 下 fixtures 里的测试夹具；其余 test/ 下的文件，或别处的 *.test.mjs、*.test.js、*Tests.swift。
export const isTest = path => {
  const parts = path.split('/');
  if (['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json'].includes(parts.at(-1))
    || parts.some(part => ['.coda', '.github', 'scripts', 'check', 'bin', 'docs'].includes(part))) return false;
  if (path.endsWith('.bpmn')) return path.startsWith('test/') && parts.includes('fixtures');
  return path.startsWith('test/') || /\.test\.m?js$|Tests\.swift$/.test(path);
};
// 测试运行器会发现、执行的测试文件（*.test.mjs、*.test.js、*Tests.swift）；isTest 里其余的是测试辅助模块与夹具。
export const isRunnableTest = path => isTest(path) && /\.test\.m?js$|Tests\.swift$/.test(path);
// 非契约说明文档：仓库根的 README.md，仓库根或插件目录下的 THIRD_PARTY_NOTICES.md。
// 插件目录下的 README.md 记载流程输入输出、状态机与兼容契约，不免审；其余一律不免审。
export const isMinorPath = path => isTest(path) || path === 'README.md' || /^(plugins\/[^/]+\/)?THIRD_PARTY_NOTICES\.md$/.test(path);

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

// 测试文件新增的行（去掉行首 +）里跳过或独占用例的写法：test.skip、it.todo、test.only、describe.only；行首或 {、, 之后的 skip:、todo:
// （含多行选项对象里单独一行的 `  skip: true,`）；行首或 {、, 之后的 only: true（`{ only: '[]' }` 这类测试数据不算）；
// Swift 的 XCTSkip、XCTSkipIf、XCTSkipUnless；.swift 测试里的 .disabled(（Swift Testing 的 @Test、@Suite 特性，单行或多行写法都认；
// 只认 .swift，JS 测试里 DOM 的 .disabled() 不算）。
const SKIP = [/\.(skip|todo|only)\b/, /(?:^|[{,])\s*(skip|todo)\s*:/, /(?:^|[{,])\s*only\s*:\s*true\b/, /\bXCTSkip(?:If|Unless)?\b/];
const skips = (line, swift) => SKIP.some(pattern => pattern.test(line.slice(1))) || (swift && /\.disabled\s*\(/.test(line.slice(1)));
// 断言：JS 的 assert.，XCTest 的 XCTAssert…，Swift Testing 的 #expect(、#require(。
const asserts = line => line.includes('assert.') || /\bXCTAssert|#(?:expect|require)\s*\(/.test(line);

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
    // 重命名、移动成非测试文件（如 test/a.test.mjs → README.md），原测试同样不再被发现。
    else if (isTest(paths[0]) && !isTest(paths.at(-1))) reasons.push(`把测试文件 ${paths[0]} 改成了非测试文件 ${paths.at(-1)}`);
    // 改名成测试运行器不再发现的文件（如 test/a.test.mjs → test/a.disabled.mjs），原测试同样不再执行。
    else if (isRunnableTest(paths[0]) && !isRunnableTest(paths.at(-1))) reasons.push(`把测试文件 ${paths[0]} 改成了不会被执行的 ${paths.at(-1)}`);
  }
  for (const [path, { added, removed }] of Object.entries(patches)) {
    if (added.some(line => skips(line, path.endsWith('.swift')))) reasons.push(`${path} 新增了 skip、todo 或 only`);
    if (removed.some(asserts) && !added.some(asserts)) reasons.push(`${path} 删了断言、没有新增断言`);
  }
  return reasons;
}
