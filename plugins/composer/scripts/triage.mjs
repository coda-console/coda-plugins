// 评审意见的分流（README.md「评审回路」）：评审之后，发现先交执行者逐条修复或反驳、原评审者复评，收敛了才给主 Agent；
// 判断不了的升级给主 Agent。纯函数，不读写文件、不跑命令：泳道 PR 用它，监督开发的整体评审也要用。
import { SLOTS } from './shared.mjs';

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
// 这两类要主 Agent 判断，不自动修：对外契约变没变、任务范围对不对，不是执行者和评审者两方能说了算的。
export const ESCALATE_KINDS = { contract: '对外契约', scope: '任务范围' };
export const MAX_ROUNDS = 2;

const short = sha => String(sha ?? '').slice(0, 12) || '（没有）';

// 发现账本，泳道 PR 与整体评审共用：results 是评审子流程各份的输出（review-commit 的结果加 slot、state、reviewed：评的 head）；
// findings 是之前各轮记下的发现（每条有固定编号 id = <评审位置>:<序号>、status：open / resolved / withdrawn / superseded，执行者回应过的有 response）；
// head 是当前 head，full 表示这次是完整评审（不是增量复评）：之前没关的发现作废，由这次的结果代替。
// 返回更新后的全部发现（新发现接着各位置的序号编号，不改旧编号）、这次新编的编号 added、评审者这次对旧发现的结论 resolutions，
// 以及不论怎么分流都要升级的原因 reasons：没评成、评的不是当前 head、执行者反驳了评审者仍坚持。
function record(results, { head, findings = [], full = false }) {
  const ledger = findings.map(f => ({ ...f, status: full && f.status === 'open' ? 'superseded' : f.status }));
  const reasons = [], added = [], resolutions = [];
  for (const r of results.filter(r => r.state !== 'skipped')) {
    const who = SLOTS[r.slot];
    if (r.state === 'lost') { reasons.push(`${who}没评成：调用 review-commit 没有成功`); continue; }
    if (r.decision === 'INCOMPLETE') { reasons.push(`${who}没评成：${r.line}`); continue; }
    if (r.reviewed !== head) { reasons.push(`${who}评的是 ${short(r.reviewed)}，不是当前 head ${short(head)}，结果不算数`); continue; }
    for (const { id, status, reason } of JSON.parse(r.resolutions)) {
      const f = ledger.find(f => f.id === id);
      f.verdict = { status, reason };
      resolutions.push({ id, status, reason });
      if (status !== 'upheld') f.status = status;
      else if (f.response?.disposition === 'disputed') reasons.push(`${id}：执行者反驳了，${who}仍坚持`);
    }
    const level = SEVERITIES.indexOf(r.blocking);
    let n = Math.max(0, ...ledger.filter(f => f.slot === r.slot).map(f => Number(f.id.split(':')[1])));
    for (const f of JSON.parse(r.findings)) {
      const id = `${r.slot}:${++n}`;
      ledger.push({ id, slot: r.slot, ...f, blocking: SEVERITIES.indexOf(f.severity) <= level, status: 'open' });
      added.push(id);
    }
  }
  return { findings: ledger, reasons, added, resolutions };
}

// 泳道 PR 的分流（账本见 record），rounds 是已经交执行者修了几轮。
// 返回 route：pass（没有阻塞级发现，照常交主 Agent 审查）、fix（交执行者）、escalate（升级给主 Agent），reasons 是升级的原因，其余同 record。
export function triage(results, { head, findings = [], rounds = 0, full = false, maxRounds = MAX_ROUNDS }) {
  const result = record(results, { head, findings, full }), { reasons } = result;
  const open = result.findings.filter(f => f.status === 'open');
  for (const f of open.filter(f => ESCALATE_KINDS[f.kind])) reasons.push(`${f.id} 涉及${ESCALATE_KINDS[f.kind]}（${f.kind}），由主 Agent 判断`);
  const blocking = open.some(f => f.blocking);
  if (!reasons.length && blocking && rounds >= maxRounds) reasons.push(`自动修了 ${maxRounds} 轮仍有阻塞级发现`);
  return { ...result, route: reasons.length ? 'escalate' : blocking ? 'fix' : 'pass' };
}

// 整体评审只自动修这几类 P2：改了也不动行为和对外契约。
export const MINOR_KINDS = ['test-quality', 'documentation', 'style'];

// 监督开发整体评审的分流：同一本账（record），路由按严重程度与类别，不看 review 设置的阻塞级别。
// 没开的 P0、P1，契约或范围类（任何级别），类别不在 MINOR_KINDS 的 P2 都升级；只剩 MINOR_KINDS 的 P2 交执行者（fixer 为 false 即没填执行者、
// 或已修满 maxRounds 轮时升级）；只有 P3 或没有发现时 accept：直接进验收，P3 写进汇报。返回 route：accept / fix / escalate，其余同 record。
export function triageOverall(results, { head, findings = [], rounds = 0, full = false, maxRounds = MAX_ROUNDS, fixer = true }) {
  const result = record(results, { head, findings, full }), { reasons } = result;
  const open = result.findings.filter(f => f.status === 'open');
  for (const f of open) {
    if (ESCALATE_KINDS[f.kind]) reasons.push(`${f.id} 涉及${ESCALATE_KINDS[f.kind]}（${f.kind}），由主 Agent 判断`);
    else if (f.severity === 'P0' || f.severity === 'P1') reasons.push(`${f.id} 是 ${f.severity}，由主 Agent 判断`);
    else if (f.severity === 'P2' && !MINOR_KINDS.includes(f.kind)) reasons.push(`${f.id} 是 ${f.kind} 类的 P2，由主 Agent 判断`);
  }
  const fix = open.some(f => f.severity === 'P2');
  if (!reasons.length && fix && !fixer) reasons.push('有 P2 发现，但没填开工执行者，不能自动修');
  if (!reasons.length && fix && rounds >= maxRounds) reasons.push(`自动修了 ${maxRounds} 轮仍有 P2 发现`);
  return { ...result, route: reasons.length ? 'escalate' : fix ? 'fix' : 'accept' };
}

// 一条发现一行：编号、严重程度与类别、标题、位置；detailed 时下一行起是说明。
export const findingLine = (f, detailed) => {
  const flat = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
  return `- ${f.id} [${f.severity}·${f.kind}${f.blocking ? '·阻塞' : ''}] ${flat(f.title)}${f.location ? `（${flat(f.location)}）` : ''}${detailed && f.detail ? `\n  ${f.detail.replace(/\n/g, '\n  ')}` : ''}`;
};

// 交给执行者的发现（泳道 PR 与整体评审共用）：编号固定，逐条修复（fixed）或反驳（disputed），结构化交回。
export const fixText = (head, findings) => `评审者对这次交付（提交 ${head}）提了下面这些发现，编号固定，之后几轮沿用。逐条处理：
- 成立的：修好并提交，回 fixed，附修复它的提交号；
- 不成立的：不要改，回 disputed，写明理由和证据（代码位置、命令与输出、文档出处）。原评审者会复评核实，你说不成立不等于关闭。
标了「阻塞」的必须处理，其余能修的一并修。只处理这些发现，不做清单之外的事；流程会在新提交上重跑项目检查。

${findings.map(f => findingLine(f, true)).join('\n')}

回复的最后，单独给出一个代码块：开头一行是三个反引号加 responses，结尾一行是三个反引号，中间是一个 JSON 对象，只有 responses 一个字段，是数组，每个编号一条：id（编号）、disposition（fixed 或 disputed）、commit（fixed 时修复它的提交号）、reason（怎么修的，或为什么不成立）、evidence（证据：跑了什么、结果，或代码与文档出处）。`;

// 执行者的回应：回复末尾 responses 代码块里的 {"responses":[{id, disposition: fixed|disputed, commit, reason, evidence}]}。
// 只收交给它的编号、合法的 disposition；没回应或不合格式的那条就是没有回应，交评审者照样核实。
export function readResponses(answer, ids) {
  const block = [...String(answer ?? '').matchAll(/^```responses[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm)].at(-1);
  let list = [];
  try { list = JSON.parse(block?.[1] ?? 'null')?.responses ?? []; } catch {}
  const text = value => typeof value === 'string' ? value.trim() : '';
  const responses = {};
  for (const r of Array.isArray(list) ? list : []) if (ids.includes(r?.id) && ['fixed', 'disputed'].includes(r.disposition) && !responses[r.id])
    responses[r.id] = { disposition: r.disposition, commit: text(r.commit), reason: text(r.reason), evidence: text(r.evidence) };
  return responses;
}

// 收敛经过：每轮评审的新发现与结论、交执行者的那轮回应、分流的结论，给主 Agent 的审查卡。
export function historyText(history) {
  const flat = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
  return history.map(entry => {
    if (entry.kind === 'fix') return [`交执行者修第 ${entry.round} 轮（${short(entry.from)} → ${short(entry.head)}）：`,
      ...entry.ids.map(id => { const r = entry.responses[id];
        return `- ${id}：${!r ? '没有按格式回应' : r.disposition === 'fixed' ? `fixed${r.commit ? ` ${short(r.commit)}` : ''}${r.reason ? `，${flat(r.reason)}` : ''}` : `disputed：${flat(r.reason)}${r.evidence ? `；证据：${flat(r.evidence)}` : ''}`}`; }),
      ...entry.note ? [`结论：${entry.note}`] : []].join('\n');
    const conclusion = { pass: '没有阻塞级发现，交主 Agent 审查', accept: '只有 P3 或没有发现，直接进验收', fix: '交执行者逐条修复或反驳', escalate: `升级给主 Agent：${entry.reasons.join('；')}` }[entry.route];
    return [`${entry.full ? '评审' : '复评'}（head ${short(entry.head)}）：`,
      ...entry.resolutions.map(r => `- ${r.id} → ${r.status}${r.reason ? `：${flat(r.reason)}` : ''}`),
      ...entry.added.map(f => findingLine(f, false)), `结论：${conclusion}`].join('\n');
  }).join('\n\n');
}
