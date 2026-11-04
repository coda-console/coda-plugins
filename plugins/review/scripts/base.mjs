import { baseOf, output, summary } from './step.mjs';

const read = await baseOf(process.env.URL, process.env.TARGET);
if (read.error) { console.error(read.error); process.exit(1); }
const stacked = read.base !== read.target;
output('stacked', stacked);
output('base', read.base);
output('target', read.target);
if (stacked) summary(`## 叠放\n\n当前 base 为 ${read.base}，等待改到合并目标分支 ${read.target} 后接着走；流程不会自动修改 PR 的 base。`);
