// 评审意见的分流（README.md「评审回路」）：评审之后，发现先交执行者逐条修复或反驳、原评审者复评，收敛了才给主 Agent；
// 判断不了的升级给主 Agent。纯函数，不读写文件、不跑命令：泳道 PR 用它，监督开发的整体评审也要用。
import { SLOTS } from './shared.mjs';

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
// 这两类要主 Agent 判断，不自动修：对外契约变没变、任务范围对不对，不是执行者和评审者两方能说了算的。
export const ESCALATE_KINDS = { contract: '对外契约', scope: '任务范围' };
export const MAX_ROUNDS = 2;

const short = sha => String(sha ?? '').slice(0, 12) || '（没有）';

// results 是评审子流程各份的输出（review-commit 的结果加 slot、state、reviewed：评的 head）；findings 是之前各轮记下的发现
// （每条有固定编号 id = <评审位置>:<序号>、status：open / resolved / withdrawn / superseded，执行者回应过的有 response）；
// head 是当前 head，rounds 是已经交执行者修了几轮，full 表示这次是完整评审（不是增量复评）：之前没关的发现作废，由这次的结果代替。
// 返回 route：pass（没有阻塞级发现，照常交主 Agent 审查）、fix（交执行者）、escalate（升级给主 Agent），
// reasons 是升级的原因，findings 是更新后的全部发现（新发现接着各位置的序号编号，不改旧编号），added 是这次新编的编号，
// resolutions 是评审者这次对旧发现的结论。
export function triage(results, { head, findings = [], rounds = 0, full = false, maxRounds = MAX_ROUNDS }) {
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
  const open = ledger.filter(f => f.status === 'open');
  for (const f of open.filter(f => ESCALATE_KINDS[f.kind])) reasons.push(`${f.id} 涉及${ESCALATE_KINDS[f.kind]}（${f.kind}），由主 Agent 判断`);
  const blocking = open.some(f => f.blocking);
  if (!reasons.length && blocking && rounds >= maxRounds) reasons.push(`自动修了 ${maxRounds} 轮仍有阻塞级发现`);
  return { route: reasons.length ? 'escalate' : blocking ? 'fix' : 'pass', reasons, findings: ledger, added, resolutions };
}

// 一条发现一行：编号、严重程度与类别、标题、位置；detailed 时下一行起是说明。
export const findingLine = (f, detailed) => {
  const flat = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
  return `- ${f.id} [${f.severity}·${f.kind}${f.blocking ? '·阻塞' : ''}] ${flat(f.title)}${f.location ? `（${flat(f.location)}）` : ''}${detailed && f.detail ? `\n  ${f.detail.replace(/\n/g, '\n  ')}` : ''}`;
};

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
    const conclusion = { pass: '没有阻塞级发现，交主 Agent 审查', fix: '交执行者逐条修复或反驳', escalate: `升级给主 Agent：${entry.reasons.join('；')}` }[entry.route];
    return [`${entry.full ? '评审' : '复评'}（head ${short(entry.head)}）：`,
      ...entry.resolutions.map(r => `- ${r.id} → ${r.status}${r.reason ? `：${flat(r.reason)}` : ''}`),
      ...entry.added.map(f => findingLine(f, false)), `结论：${conclusion}`].join('\n');
  }).join('\n\n');
}
