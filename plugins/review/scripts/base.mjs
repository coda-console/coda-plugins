// Whether the pull request is stacked (../.coda/workflows/pull-request.bpmn「看 base」): based on another branch than its
// repository's default one, which the workflow does not merge into. Not read, the step fails.
import { baseOf, output, summary } from './step.mjs';

const read = await baseOf(process.env.URL);
if (read.error) { console.error(read.error); process.exit(1); }
const stacked = read.base !== read.main;
output('stacked', stacked);
output('base', read.base);
output('main', read.main);
if (stacked) summary(`## 叠放\n\nbase 是 ${read.base}，不是默认分支 ${read.main}，只合并进默认分支：等下层 PR 合并、base 改到 ${read.main} 后接着走。` +
  `仓库开了合并后删分支时 GitHub 会自己改；没开就用 \`gh pr edit ${read.url} --base ${read.main}\` 改。`);
