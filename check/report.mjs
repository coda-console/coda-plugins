// What a check found, in the order found: each line a level (清单, 模块, 握手, 一轮, 说明), what it is about (the plugin, an agent, a panel),
// whether it passed, failed, was skipped or is worth a look (warn, info), a rule ID the tests name, and a line of Chinese.
export const LEVELS = { manifest: '清单', module: '模块', handshake: '握手', live: '一轮', note: '说明' };
const MARKS = { pass: '✓', fail: '✗', warn: '!', skip: '-', info: '·' };

export class Report {
  constructor() { this.items = []; }
  scope(level, subject = '') {
    const add = status => (rule, message) => { this.items.push({ level, subject, status, rule, message }); };
    return { pass: add('pass'), fail: add('fail'), warn: add('warn'), skip: add('skip'), info: add('info') };
  }
  get failures() { return this.items.filter(item => item.status === 'fail'); }
  get ok() { return this.failures.length === 0; }
  count(status) { return this.items.filter(item => item.status === status).length; }
}

// Grouped by level, then by subject in the order first met; within a group, in the order found.
export function format(report, { title }) {
  const lines = [title], order = Object.keys(LEVELS), subjects = [...new Set(report.items.map(item => item.subject))];
  const rank = item => order.indexOf(item.level) * subjects.length + subjects.indexOf(item.subject);
  let heading = null;
  for (const item of report.items.toSorted((a, b) => rank(a) - rank(b))) {
    const at = `${LEVELS[item.level]}${item.subject ? ` · ${item.subject}` : ''}`;
    if (at !== heading) { lines.push('', at); heading = at; }
    lines.push(`  ${MARKS[item.status]} ${item.message}`);
  }
  lines.push('', `结果：${report.ok ? '通过' : '不通过'}（通过 ${report.count('pass')}，失败 ${report.count('fail')}，跳过 ${report.count('skip')}，提醒 ${report.count('warn')}）`);
  return lines.join('\n');
}
