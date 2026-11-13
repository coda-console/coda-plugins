// Whether a pull request is the one the account gh asks as wrote (../.coda/workflows/pull-request.bpmn「看 PR 是谁的」, the manual
// entry): GraphQL `PullRequest.viewerDidAuthor`, asked as the GitHub plugin asks it for the repository (GH_REPO selects the account the repository's
// owner uses; GraphQL names no repository). Not answered, the step fails and says why: nothing is guessed.
import { spawnSync } from 'node:child_process';
import { output, summary } from './step.mjs';

const url = process.env.URL ?? '';
const [, owner, name, number] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i.exec(url);
const asked = spawnSync('gh', ['api', 'graphql', '-f', 'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { viewerDidAuthor } } }',
  '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '--jq', '.data.repository.pullRequest.viewerDidAuthor'],
{ encoding: 'utf8', timeout: 30_000, env: { ...process.env, GH_REPO: `${owner}/${name}` } });
const answer = asked.status === 0 ? asked.stdout.trim() : null;
if (answer !== 'true' && answer !== 'false') {
  const why = asked.status === 0 ? `gh api graphql 的回答是 ${JSON.stringify(answer)}` : asked.error?.message || asked.stderr?.trim().split('\n').at(-1) || `gh api graphql 以退出码 ${asked.status} 结束`;
  console.error(`GitHub 没有回答 PR ${url} 的作者：${why}`);
  summary(`没能确认 PR ${url} 是不是自己的：${why}`);
  process.exit(1);
}
output('mine', answer === 'true');
