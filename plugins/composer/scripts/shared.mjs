import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const output = (name, value) => {
  const end = randomUUID();
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${end}\n${value}\n${end}\n`);
};
export const command = (bin, args, env = process.env) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
};
export const git = (...args) => command('git', args);
export const gh = (...args) => command('gh', args);

// 退回意见、整体评审结论的备注里单独一行写的「#编号 不改」，后面可以接理由：返回 [{ id, reason }]。
// 行首只允许空白或列表符号 -、*，「不改」后面是行尾，或「：」「:」「，」「,」接理由；句子中间提到的不算。
export const declinedIn = note => [...note.matchAll(/^[^\S\n]*(?:[-*][^\S\n]*)?(#\d+)[^\S\n]*不改[^\S\n]*(?:$|[：:，,][^\S\n]*(.*))/gm)].map(([, id, reason = '']) => ({ id, reason: reason.trim() }));

// 执行者的固定说明，放在每个交给执行者的任务前面：块的执行与修改、监督开发提交验收时的解冲突都用它。
export const instructions = `你是这次开发流程的执行者，自己完成这一项任务，不继承主 Agent 的协调职责，不再委派。
只做这一项，在当前分支提交，不推送、不开 PR、不合并、不部署。
遵守仓库的 AGENTS.md。只改必需的地方，不写防御性、冗余的代码，不顺手重构。
只跑与改动直接相关的快检查；流程会在审查前自己跑项目检查，构建、全套和界面检查不在这里重复，不必再用 run-held 跑整套编译。
只跑改动直接涉及的测试文件；不跑无文件参数的 \`check.sh backend\`、\`--all\`、完整 workflows 套件、客户端编译，任务明确要求的除外。
验证命令必须把原始检查的退出码传出去：默认直接执行检查命令；要看日志尾部就用 \`rc=0; <检查> > "$log" 2>&1 || rc=$?; tail -n 80 "$log"; exit "$rc"\`；不能只 echo 退出码，不能让最后一条 tail / grep / cmp 决定成败。
改坏验证（故意改错看测试红）只跑命中的那个用例，沿用默认时限；挂住了先定位原因，不要调大时限重跑。
run-held 和流程运行的结果会自己送回，不要另起 Monitor 或后台任务去盯日志。
回报改了什么、为什么、实际跑了哪些验证及未验证部分。`;

// 执行步骤失败后重跑、接回已开的执行会话时的开头：现场可能已经做了一部分，先看清再接着做。
export const resumeText = `这一项之前已经交给你，上一次没有正常结束（流程恢复或重试）。先核对现场：工作区状态（git status）、git log 里已有的提交、上次做到哪；再接着完成原任务，不要从头重做，已经做好的不要丢。`;

// 交执行者一次（任务前面带固定说明）：失败时 coda-agent 仍在标准输出给出会话 ID，由调用方记下，这一步再跑才接得回。
// fields 是回复必须有的字段：退出 0 但缺了也按失败，免得后面的步骤读执行者时才崩、恢复也一直重复同一个错。
export const talk = (args, text, fields = ['session', 'head']) => {
  const prompt = join(process.env.RUNNER_TEMP, 'task.md');
  writeFileSync(prompt, `${instructions}\n\n${text}\n`);
  const result = spawnSync('coda-agent', [...args, '--json', '--prompt-file', prompt], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { /* 失败时可以没有会话信息 */ }
  return { result, reply, fields, failed: result.status !== 0 || fields.some(field => !reply?.[field]) };
};
// 执行失败：调用方记下会话后保留退出码退出；退出 0 但回复不全也按失败。
export const fail = ({ result, fields }) => {
  if (result.status === 0) console.error(`coda-agent 退出 0，但输出不是含 ${fields.join('、')} 的 JSON：${result.stdout.slice(0, 300)}`);
  process.exit(result.status || 1);
};

// 一组 Agent 选择（流程参数的 agent 类型）转成 coda-agent 开新会话的参数：没选的模型、强度、模式用 Agent 的默认值。
export const agentArgs = ({ options = {}, ...chosen }) => {
  const args = [];
  for (const key of ['agent', 'model', 'effort', 'mode']) if (chosen[key]) args.push(`--${key}`, chosen[key]);
  for (const [id, value] of Object.entries(options)) args.push('--option', `${id}=${value}`);
  return args;
};

// 流程步骤替运行所属的会话说话（CODA_THREAD_ID），GitHub 插件的 gh 会把它开的 PR 报给「PR 观察」，
// 进而启动 review 插件的 PR 生命流程。监督开发开的 PR 由流程自己检查、评审、合并，开的时候不带会话，不上报。
export const openPr = (...args) => {
  const { CODA_THREAD_ID: _thread, ...env } = process.env;
  return command('gh', ['pr', 'create', ...args], env);
};

// 一次交付的项目检查结果，每个检查一行：审查卡的「项目检查结果」和交给评审者的已有验证是同一段。
export const checksText = (record, head) => record?.head === head
  ? record.runs.map(r => `${r.workflow}: ${r.state} coda://workflow-runs/${r.runId}`).join('\n') || '此提交未声明项目检查流程。'
  : '此提交项目检查未通过。';

// 区域声明（README.md「改动区域」）：commit 上 .coda/areas.json 的内容，没有这个文件就是没有区域。
export const areasAt = commit => git('ls-tree', '--name-only', commit, '.coda/areas.json') ? JSON.parse(git('show', `${commit}:.coda/areas.json`)) : {};
// 文件归入的区域：所有区域的前缀里最长的匹配，都不匹配是 undefined。PR 汇总的改动区域与契约的范围门禁用同一个归法。
export const areaOf = (file, declared) => Object.entries(declared).flatMap(([area, list]) => list.map(prefix => [prefix, area]))
  .filter(([prefix]) => file.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];

// 改动区域（README.md「改动区域」）：base...head 的三点 diff（与 PR 的 Files changed 一致），按 head 上 .coda/areas.json 的最长前缀归区域。
// 监督开发的 PR 汇总与块的审查卡用同一份。
export const changes = (base, head) => {
  const declared = areasAt(head);
  const fields = git('diff', '--numstat', '-z', '-M', `${base}...${head}`).split('\0');
  const areas = {}, total = { files: 0, added: 0, deleted: 0 };
  for (let i = 0; i < fields.length - 1; i++) {
    const [added, deleted, name] = fields[i].split('\t');
    // 改名时 -z 输出旧路径和新路径两个字段，按新路径归类。
    const file = name || fields[i += 2];
    const area = areaOf(file, declared) ?? (file.includes('/') ? file.split('/')[0] : '根目录');
    for (const group of [areas[area] ??= { files: 0, added: 0, deleted: 0 }, total]) {
      group.files++;
      group.added += added === '-' ? 0 : Number(added);
      group.deleted += deleted === '-' ? 0 : Number(deleted);
    }
  }
  const line = ({ files, added, deleted }) => `${files} 个文件 +${added} -${deleted}`;
  return [`改动：${line(total)}`, ...Object.entries(areas).sort(([, a], [, b]) => b.added + b.deleted - a.added - a.deleted).map(([area, group]) => `- ${area}：${line(group)}`)].join('\n');
};

// 契约（README.md「契约开发」）：契约开发开工时锁定的 JSON。只读也只校验 composer 用到的三个键 required、allowed、hooks（别的键如 approved 不管）：
// 都得有，各是数组、元素是非空字符串；allowed 至少一项。返回 { contract }，不合规范返回 { error }（一句原因，写明哪个键、哪里不对）。
export const readContract = text => {
  let contract;
  try { contract = JSON.parse(text); } catch { return { error: '不是合法的 JSON' }; }
  if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) return { error: '必须是 JSON 对象' };
  for (const key of ['required', 'allowed', 'hooks']) {
    if (!(key in contract)) return { error: `缺少 ${key}` };
    if (!Array.isArray(contract[key])) return { error: `${key} 必须是数组` };
    const bad = contract[key].findIndex(item => typeof item !== 'string' || item === '');
    if (bad >= 0) return { error: `${key} 的第 ${bad + 1} 项必须是非空字符串` };
  }
  if (!contract.allowed.length) return { error: 'allowed 至少要有一项' };
  return { contract };
};

// 范围门禁的判定（README.md「范围门禁」），不碰 Git：条目与 declared（base 上 .coda/areas.json 的区域）里某个区域名完全相同的是区域条目，命中归属这个区域的文件；
// 否则是路径条目，以 / 结尾的是目录前缀，其余是完整文件路径。仓库根 .coda/ 下的文件不能被区域条目命中，只能被以 .coda/ 开头的路径条目命中。
// 路径含 U+FFFD（git 输出的路径不是合法 UTF-8，被替换了字节）的改动文件不命中任何条目：一定越界，也不让任何 required 条目算改到。
// 返回越界的改动文件（没被 allowed 任何一条命中）和没改到的 required 条目（没命中任何改动文件）。
export const scopeViolations = ({ required, allowed }, declared, files) => {
  const hit = (entry, file) => !file.includes('\uFFFD') && (Object.hasOwn(declared, entry) ? !file.startsWith('.coda/') && areaOf(file, declared) === entry
    : entry.endsWith('/') ? file.startsWith(entry) : file === entry);
  return { outside: files.filter(file => !allowed.some(entry => hit(entry, file))), missing: required.filter(entry => !files.some(file => hit(entry, file))) };
};

// PR 地址里的 host/owner/repo：给 gh 显式 --repo，它就只删除远端分支，不碰本地分支，分离 HEAD 也能用。
export const repoOf = url => { const { host, pathname } = new URL(url); return `${host}/${pathname.split('/').slice(1, 3).join('/')}`; };

// PR 的终态，合并前先认它，从失败处继续时不重新改一个已经合并的 PR：已合并且 head 一致时返回原合并提交；
// 已合并但 head 不一致、已关闭未合并时报错；还开着返回 undefined。
export function mergedCommit(url, head) {
  const pr = JSON.parse(gh('pr', 'view', url, '--json', 'state,headRefOid,mergeCommit'));
  if (pr.state === 'MERGED') {
    if (pr.headRefOid !== head) throw new Error(`PR 已合并，但 head 不一致：预期 ${head}，实际 ${pr.headRefOid}`);
    return pr.mergeCommit.oid;
  }
  if (pr.state === 'CLOSED') throw new Error(`PR 已关闭但未合并：${url}`);
}

// 合并开着的 PR，返回合并提交。合并命令失败后查一次 PR：仍开着且与 base 冲突时返回 null，交给调用方带反馈回去；
// 其余失败保留原退出码，不按错误文案判断。head 由 --match-head-commit 校验。
export function mergePr(url, head, method) {
  const result = spawnSync('gh', ['pr', 'merge', url, '--repo', repoOf(url), `--${method}`, '--match-head-commit', head, '--delete-branch'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const failed = JSON.parse(gh('pr', 'view', url, '--json', 'state,mergeable'));
    if (failed.state === 'OPEN' && failed.mergeable === 'CONFLICTING') return null;
    process.exit(result.status ?? 1);
  }
  return gh('pr', 'view', url, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid');
}

// 合并后的挂点 merged（README「合并后的流程」）。批准卡用 hook-joiners 的列表（JOINERS）展开勾选项；从卡的答复读出勾了哪些加入者、
// 卡上写了的文字，以及勾上的加入者要、卡上没写的输入（每个输入一项：标签和要它的加入者）。`missing` 是这些输入的 ID（逗号分隔，
// 给多实例的 split）；`asks` 每个一行，与 `missing` 同序，任务按 loopCounter 取自己那一行；
// `needs` 是每个输入对应的加入者 ID（JSON）。
export function outputPicked(answer, joiners) {
  const list = joiners ? JSON.parse(joiners) : [], options = answer.options ?? {}, written = answer.inputs ?? {};
  const ticked = list.filter(joiner => options[joiner.id] === true), inputs = {}, missing = new Map();
  for (const joiner of ticked) for (const { id, label } of joiner.inputs ?? []) {
    const text = String(written[id] ?? '').trim();
    if (text) inputs[id] = text;
    else (missing.get(id) ?? missing.set(id, { label, for: [] }).get(id)).for.push(joiner);
  }
  output('only', JSON.stringify(ticked.map(joiner => joiner.id)));
  output('picked', ticked.map(joiner => joiner.name).join('、'));
  output('inputs', JSON.stringify(inputs));
  output('missing', [...missing.keys()].join(','));
  output('asks', [...missing.values()].map(m => `「${m.label}」：${m.for.map(joiner => joiner.name).join('、')}要`).join('\n'));
  output('needs', JSON.stringify(Object.fromEntries([...missing].map(([id, m]) => [id, m.for.map(joiner => joiner.id)]))));
}

// 自动合并不出批准卡，合成「合并」的答复（README「合并后的流程」）：只勾 hooks 白名单里的加入者，没写进白名单的一律不勾，即使它声明了默认勾选；
// 没有要卡上文字的输入。unknown 是白名单里不是当前 head 上挂点 merged 加入者的名字（joiners 是 hook-joiners 的列表 JSON），known 是现有加入者的 ID。
export function autoApproval(hooks, joiners) {
  const known = (joiners ? JSON.parse(joiners) : []).map(joiner => joiner.id);
  return { known, unknown: hooks.filter(id => !known.includes(id)), answer: { choice: 'merge', options: Object.fromEntries(hooks.map(id => [id, true])) } };
}

// 交给 run-workflows 的 inputs：卡上写了的，加主 Agent 在「填写合并后流程要的文字」里写的（FILLS，多实例按 MISSING 的顺序各一份）。
// 任务要求必须附言，只附文件、没写字的这里失败并写明是哪一项。选了「这一项这次不跑」（skip）的输入不写，要它的加入者
// 全部从 only 里去掉（ONLY、NEEDS）；输出的 only 是接着要运行的，空就是 `[]`，也作为返回值。
export function outputFilled() {
  const inputs = JSON.parse(process.env.INPUTS || '{}'), ids = (process.env.MISSING || '').split(',').filter(Boolean);
  const fills = ids.length ? JSON.parse(process.env.FILLS || '[]') : [], asks = (process.env.ASKS || '').split('\n'), dropped = new Set();
  ids.forEach((id, i) => {
    if (fills[i]?.choice === 'skip') { JSON.parse(process.env.NEEDS)[id].forEach(joiner => dropped.add(joiner)); return; }
    const text = String(fills[i]?.note ?? '').trim();
    if (!text) { console.error(`${asks[i] || id}：没有填写，不运行合并后的流程`); process.exit(1); }
    inputs[id] = text;
  });
  output('inputs', JSON.stringify(inputs));
  const only = JSON.parse(process.env.ONLY || '[]').filter(id => !dropped.has(id));
  output('only', JSON.stringify(only));
  return only;
}
