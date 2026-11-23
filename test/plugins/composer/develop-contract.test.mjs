// 契约开发（plugins/composer/.coda/workflows/develop-contract.bpmn，脚本与监督开发共用 scripts/develop.mjs）：临时 Git 仓库、假的 gh，
// 网关条件用与引擎同版本的 FEEL 求值；脚本输出先照引擎把 "true"/"false" 变成布尔值。
// 与监督开发（develop.bpmn）同一件事的节点必须保持一致，「防漂移」一条用例逐个比对。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';
import { evaluateTyped, typedOutputs } from './feel.mjs';
import { readContract, scopeViolations } from '../../../plugins/composer/scripts/shared.mjs';

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/develop.mjs', import.meta.url));
const workflowUrl = name => new URL(`../../../plugins/composer/.coda/workflows/${name}.bpmn`, import.meta.url);
const workflow = readFileSync(workflowUrl('develop-contract'), 'utf8');
const PR = 'https://github.com/example/fixture/pull/1';


function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'composer-develop-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'run-1', GITHUB_OUTPUT: join(root, 'outputs'), CODA_THREAD_ID: 'thread-1', TITLE: '输入框', GOAL: '输入框可以输入', BASE: '',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    FIXTURE: root };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'base'), 'base');
  git('add', 'base'); git('commit', '-qm', 'base');
  git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!${process.execPath}\n` + String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const calls = JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
const body = args.includes('--body-file') ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null;
calls.push({ args, body, thread: process.env.CODA_THREAD_ID ?? null }); writeFileSync(join(root, 'gh-calls'), JSON.stringify(calls));
const state = () => JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'develop.json'), 'utf8'));
if (args[0] === 'repo') console.log('main');
else if (args[1] === 'list') { if (process.env.OPEN_PR) console.log(process.env.OPEN_PR); }
else if (args[1] === 'create') console.log('${PR}');
else if (args[1] === 'merge') { if (process.env.MERGE_EXIT) { process.stderr.write(process.env.MERGE_STDERR || ''); process.exit(Number(process.env.MERGE_EXIT)); } }
else if (args[1] === 'view' && args.includes('headRefOid,statusCheckRollup')) {
  console.log(JSON.stringify({ headRefOid: process.env.PR_HEAD || state().head, statusCheckRollup: [{}] }));
  process.exit(Number(process.env.CHECKS_QUERY_EXIT || 0));
}
else if (args[1] === 'view' && (args.includes('state,headRefOid,mergeCommit') || args.includes('state,mergeable')))
  console.log(JSON.stringify({ state: process.env.PR_STATE || 'OPEN', mergeable: process.env.PR_MERGEABLE || 'MERGEABLE', headRefOid: process.env.PR_HEAD || state().head, mergeCommit: { oid: 'f'.repeat(40) } }));
else if (args[1] === 'view') console.log('f'.repeat(40));
else if (args[1] === 'checks') {
  process.stdout.write(process.env.CHECKS_STDOUT || 'checks passed\n');
  process.stderr.write(process.env.CHECKS_STDERR || '');
  process.exit(Number(process.env.CHECKS_EXIT || 0));
}
`);
  chmodSync(gh, 0o755);
  writeFileSync(join(root, 'gh-calls'), '[]');
  const state = () => JSON.parse(readFileSync(join(artifacts, 'develop.json'), 'utf8'));
  const calls = () => JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const result = spawnSync(process.execPath, [script, action], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    return { ...result, outputs };
  };
  const remote = ref => git('ls-remote', 'origin', ref).split('\t')[0];
  // 一个块合进了需求分支：在需求分支上另提交一个；message 照块（piece）合入的提交写，带 Coda-Piece: <运行 ID>。
  const land = (file, text, message = `块 ${file}`) => {
    git('fetch', '-q', 'origin', state().branch); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', message); git('push', '-q', 'origin', `HEAD:refs/heads/${state().branch}`);
    return git('rev-parse', 'HEAD');
  };
  const reason = () => run('resume').outputs.reason;
  return { root, work, origin, env, git, run, state, calls, remote, land, reason };
}


async function definition(source = workflow, name = 'develop-contract') {
  const { root, problem } = await readWorkflow(source, name); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const collect = list => list.flatMap(e => [e, ...e.flowElements ? collect(e.flowElements) : []]);
  const elements = collect(process.flowElements);
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluateTyped(e.conditionExpression.body.trim().slice(1), context)) ?? node.default).targetRef.id;
  };
  const next = id => elements.find(e => e.$type === 'bpmn:SequenceFlow' && e.sourceRef === nodes[id]).targetRef.id;
  return { root, process, elements, nodes, values, params, route, next };
}

// review-commit 的输出交给「记下整体评审结果」：发现按 level 分级。
const reviewed = (findings, extra = {}) => ({ DECISION: findings.some(f => f.level === 'must') ? 'REQUEST_CHANGES' : findings.length ? 'COMMENT' : 'APPROVE',
  FINDINGS: JSON.stringify(findings.map(f => ({ kind: 'correctness', location: '', detail: '', ...f }))), LINE: findings.some(f => f.level === 'must') ? '评审要求修改' : '评审通过', REPORT: '评审原文', ...extra });
const KICKOFF = { executor: { agent: 'codex', model: 'gpt-6.1-sol' }, executor2: { agent: 'claude-sdk' }, reviewer: { agent: 'kimi', effort: 'high' }, overallReviewer: { agent: 'grok' } };

// 从 from 走到 stops 之一：网关按 context 分流，其余走唯一的出口；返回经过的节点，最后一个是停下的。
const walk = ({ nodes, route, next }, from, context, stops) => {
  const visited = [from];
  while (!stops.includes(visited.at(-1))) {
    const step = visited.at(-1);
    visited.push(nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step));
  }
  return visited;
};

// 契约开发（README.md「契约开发」）。
const CONTRACT = JSON.stringify({ required: ['docs/a.md'], allowed: ['docs/'], approved: { skeleton: {} }, hooks: [] });
const RUNS = JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'c1' }]);
const put = (f, path, text) => { mkdirSync(join(f.work, path, '..'), { recursive: true }); writeFileSync(join(f.work, path), text); };
// 在需求分支上提交一批改动（edit 里改工作区），推到远端。
const change = (f, edit, message = 'change') => {
  f.git('fetch', '-q', 'origin', f.state().branch); f.git('switch', '-q', '--detach', 'FETCH_HEAD');
  edit(); f.git('add', '-A'); f.git('commit', '-qm', message); f.git('push', '-q', 'origin', `HEAD:refs/heads/${f.state().branch}`);
};
// 提交验收（options 是勾选项）、跟上目标分支、开 PR，env 与流程里 coda:env 一致；返回 pr 的输出。
const submitContract = (f, options = {}, contract = CONTRACT) => {
  f.run('progress', { PROGRESS: JSON.stringify({ choice: 'submit', note: '汇报', options }), CONTRACT: contract });
  f.run('sync-base', { FIXER: 'true' });
  return f.run('pr', { CONTRACT: contract }).outputs;
};
const gate = (f, pr, contract = CONTRACT, expected = 0) => f.run('gate', { CONTRACT: contract, BASE_COMMIT: pr.base, HEAD_COMMIT: pr.head }, expected).outputs;


test('契约开发的定义：流程 ID 与名字、挂点 develop（没有 order 与 default）、输入与必填、autoMerge 默认 true；没有需求交付和设备验收', async () => {
  const { root, process, elements, nodes, values } = await definition();
  assert.deepEqual([root.id, process.id, process.name], ['develop-contract-definitions', 'develop-contract', '契约开发']);
  assert.equal(process.kind, undefined); assert.equal(process.concurrency, undefined);
  for (const [title, expected] of [['', '契约开发'], ['输入框', '需求：输入框']]) assert.equal(evaluate(process.title.slice(2, -2), { inputs: { title } }).value, expected);
  const joins = values(process).filter(v => v.$type === 'coda:Join');
  assert.deepEqual(joins.map(j => j.hook), ['develop'], '和监督开发同一个挂点');
  assert.deepEqual(joins.map(j => [j.order, j.default]), [[undefined, undefined]], '不写 order、default');
  const inputs = Object.fromEntries(values(process).filter(v => v.$type === 'coda:Input').map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['title', 'executor', 'executor2', 'reviewer', 'overallReviewer', 'autoMerge', 'base', 'contract']);
  assert.deepEqual(Object.values(inputs).filter(v => v.required).map(v => v.name), ['overallReviewer', 'contract'], '只有整体评审者与契约必填');
  for (const name of ['overallReviewer', 'contract']) assert.equal(inputs[name].required, true, name);
  for (const name of ['title', 'base']) assert.equal(inputs[name].default, '', name);
  assert.deepEqual([inputs.autoMerge.type, inputs.autoMerge.default], ['boolean', 'true']);
  for (const name of ['executor', 'executor2', 'reviewer', 'overallReviewer']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].defaultFrom], ['agent', undefined, undefined], name);
  assert.deepEqual([inputs.contract.label, inputs.contract.default], ['契约', undefined]);
  for (const text of ['整份契约的 JSON', 'required', 'allowed', 'hooks', 'approved', '开工时校验']) assert.ok(inputs.contract.description.includes(text), text);
  for (const text of ['必填', 'head 不同才评']) assert.ok(inputs.overallReviewer.description.includes(text), text);
  for (const text of ['范围门禁', '当前 head', 'hooks']) assert.ok(inputs.autoMerge.description.includes(text), text);
  for (const input of Object.values(inputs)) assert.ok(!/非契约|需求交付|设备/.test(input.description), `${input.name}：${input.description}`);
  // 没有需求交付（deliver）和设备验收：没有这些输入、节点与引用。
  for (const text of ['inputs.delivery', 'inputs.devices', 'inputs.device', 'inputs.hold', 'DELIVERY', 'prebuild', 'acceptance', 'hold-group', 'resolve-testbed', 'tell-session', '设备验收', '需求交付', '待交付']) {
    assert.ok(!workflow.includes(text), text);
  }
  for (const id of ['pr-fork', 'gate-choice', 'prebuild', 'prebuilt', 'acceptance', 'acceptance-choice', 'acceptance-route', 'tell-device', 'preview', 'device', 'device-lock', 'hold-lock', 'delivery', 'delivery-choice', 'delivery-result', 'after-delivery']) {
    assert.equal(nodes[id], undefined, id);
  }
  assert.deepEqual(elements.filter(e => e.$type === 'bpmn:CallActivity').map(e => e.calledElement).sort(), ['piece', 'review-commit']);
  assert.deepEqual(elements.filter(e => e.$type === 'bpmn:SubProcess'), [], '没有设备验收的子流程');
  // 自动合并之前列出合并后的流程；整体评审往下走直接到合并前检查。
  assert.deepEqual(['overall-accept', 'review-continue'].map(id => nodes[id].targetRef.id), ['premerge', 'premerge']);
  assert.equal(nodes['github-joiners'].targetRef.id, 'joiners');
  // 判断是不是契约模式的脚本步骤都要传 CONTRACT。
  const aware = ['branch', 'progress', 'pr', 'gate', 'checks-passed', 'overall-plan', 'overall', 'approval'];
  const scripts = elements.filter(e => e.$type === 'bpmn:ScriptTask').map(e => [e.id, /develop\.mjs" (\S+)/.exec(e.script)?.[1]]);
  for (const [id, action] of scripts) assert.equal(values(nodes[id]).some(v => v.name === 'CONTRACT' && v.value === '=inputs.contract'), aware.includes(action), `${id}（${action}）`);
  for (const action of aware) assert.ok(scripts.some(([, a]) => a === action), action);
});

// 与监督开发（develop.bpmn）同一件事的元素（ID 相同）逐个比较：类型、名字、属性、扩展元素、说明文字、脚本、条件、两端。
// 有意不同的写在 DIFFERENT，每个 ID 一行理由；其余必须完全一致，改了监督开发的节点而忘了这边，这里会红。
const REFS = ['sourceRef', 'targetRef', 'default', 'attachedToRef'];
const plain = value => Array.isArray(value) ? value.map(plain)
  : value && typeof value === 'object' ? Object.fromEntries([...Object.keys(value).filter(k => !REFS.includes(k) && k !== 'flowElements').map(k => [k, plain(value[k])]),
    ...REFS.filter(k => value[k]).map(k => [k, value[k].id])])
  : value;
const DIFFERENT = {
  brief: '说明按契约开发写，去掉设备验收一行',
  req: '多传 CONTRACT、REVIEWER：开工时校验契约、必须有整体评审者',
  progress: '说明按契约开发改写（范围门禁、整体评审按 head、自动合并），去掉设备、需求交付；提交验收多一个「交用户批准」勾选项，重新整体评审的说明按 head',
  'progress-result': '多传 CONTRACT：契约模式才记「交用户批准」',
  pr: '多传 CONTRACT、多输出 withContract：项目检查带不带契约的判定',
  checks: '项目检查按 pr.withContract 把契约交给它',
  'checks-passed': '多传 CONTRACT：记下这次通过的检查带没带契约',
  'overall-plan': '多传 CONTRACT：整体评审按 head 定评不评',
  overall: '多传 CONTRACT：自动合并按契约模式判定',
  'overall-accept': '整体评审往下走直接到合并前检查，没有设备验收',
  review: '说明里的「再提交验收」按 head 重评',
  'review-continue': '继续验收直接到合并前检查，没有设备验收',
  'auto-merge-needed': '自动合并走到读取批准，由脚本合成答复，不直接合并',
  'auto-merge-skip': '不自动合并走批准卡（加入者已在前面列出）',
  approve: '说明里没有设备验收',
  'approval-result': '多传 AUTO、CONTRACT：自动合并合成答复、核对 hooks 白名单',
  'merged-only': '条件里没有需求交付的特例，只看 only 是否为空',
  fill: '说明按自动合并与人工批准分两种写法',
  'done-none': 'notify 表达式没有需求交付的分支',
  done: 'notify 表达式没有需求交付的分支',
};
const elementsOf = async name => {
  const { elements } = await definition(readFileSync(workflowUrl(name), 'utf8'), name);
  return Object.fromEntries(elements.map(e => [e.id, plain(e)]));
};

test('防漂移：与监督开发 ID 相同的元素完全一致，有意不同的列在白名单里且确实不同', async () => {
  const [main, contract] = [await elementsOf('develop'), await elementsOf('develop-contract')];
  const shared = Object.keys(main).filter(id => id in contract);
  assert.ok(shared.length > 100, `共有 ${shared.length} 个元素`);
  assert.deepEqual(shared.filter(id => !(id in DIFFERENT) && !isDeepStrictEqual(main[id], contract[id])), [], '不在白名单里的同 ID 元素必须一致');
  assert.deepEqual(Object.keys(DIFFERENT).filter(id => !(id in main && id in contract)), [], '白名单里的每个 ID 两边都有');
  assert.deepEqual(Object.keys(DIFFERENT).filter(id => isDeepStrictEqual(main[id], contract[id])), [], '白名单里的每个 ID 两边确实不同，没有过期的');
  // 比对的是元素的全部内容：连线的两端、条件、脚本都在里面。
  assert.equal(contract['premerge-github'].targetRef, 'github-checks');
  assert.equal(contract['overall-needed'].conditionExpression.body, '=overall-plan.review = true');
  assert.match(contract.sync.script, /develop\.mjs" sync-base/);
});


test('契约的解析与校验：必须是 JSON 对象，required、allowed、hooks 都有且是非空字符串的数组，allowed 至少一项；别的键不管', () => {
  const good = { required: ['plugins/composer/README.md'], allowed: ['plugins/composer/', 'test/plugins/composer/'], approved: { skeleton: {} }, hooks: [] };
  assert.deepEqual(readContract(JSON.stringify(good)), { contract: good });
  assert.deepEqual(readContract(JSON.stringify({ required: [], allowed: ['a'], hooks: ['deploy'], approved: 3, 别的: null })).error, undefined, '别的键不读不校验，required、hooks 可以是空数组');
  for (const [text, error] of [
    ['{', '不是合法的 JSON'], ['', '不是合法的 JSON'],
    ['[]', '必须是 JSON 对象'], ['"x"', '必须是 JSON 对象'], ['null', '必须是 JSON 对象'], ['3', '必须是 JSON 对象'],
    [JSON.stringify({ allowed: ['a'], hooks: [] }), '缺少 required'],
    [JSON.stringify({ required: [], hooks: [] }), '缺少 allowed'],
    [JSON.stringify({ required: [], allowed: ['a'] }), '缺少 hooks'],
    [JSON.stringify({ required: 'a', allowed: ['a'], hooks: [] }), 'required 必须是数组'],
    [JSON.stringify({ required: [], allowed: { a: 1 }, hooks: [] }), 'allowed 必须是数组'],
    [JSON.stringify({ required: [], allowed: ['a'], hooks: null }), 'hooks 必须是数组'],
    [JSON.stringify({ required: ['a', ''], allowed: ['a'], hooks: [] }), 'required 的第 2 项必须是非空字符串'],
    [JSON.stringify({ required: [], allowed: ['a', 3], hooks: [] }), 'allowed 的第 2 项必须是非空字符串'],
    [JSON.stringify({ required: [], allowed: ['a'], hooks: [null] }), 'hooks 的第 1 项必须是非空字符串'],
    [JSON.stringify({ required: [], allowed: [], hooks: [] }), 'allowed 至少要有一项'],
  ]) assert.deepEqual(readContract(text), { error }, text);
});


test('开工校验：契约不合规范、没填整体评审者时 branch 非零退出、不建需求分支', t => {
  const f = fixture(t);
  const statePath = join(f.root, 'artifacts', 'develop.json');
  const refused = (extra, why) => {
    const result = f.run('branch', extra, 1);
    assert.ok(result.stderr.includes(why), result.stderr);
    assert.equal(f.remote('req/run-1'), '', '没建需求分支');
    assert.equal(existsSync(statePath), false, '没写状态文件');
  };
  refused({ CONTRACT: JSON.stringify({ required: [], allowed: [], hooks: [] }), REVIEWER: 'true' }, '契约不合规范：allowed 至少要有一项');
  refused({ CONTRACT: '{', REVIEWER: 'true' }, '契约不合规范：不是合法的 JSON');
  refused({ CONTRACT: '', REVIEWER: 'true' }, '契约不合规范：不是合法的 JSON'); // 显式传空串也是契约模式，不能绕过校验
  refused({ CONTRACT, REVIEWER: 'false' }, '契约模式必须填整体评审者');
  refused({ CONTRACT }, '契约模式必须填整体评审者');
  assert.deepEqual(f.run('branch', { CONTRACT, REVIEWER: 'true' }).outputs, { title: '输入框', goal: '输入框可以输入', base: 'main', branch: 'req/run-1' });
  assert.equal(f.remote('req/run-1'), f.remote('main'));
  assert.deepEqual(Object.keys(f.state()).sort(), ['base', 'branch', 'feedback', 'goal', 'report', 'title'], '开工只写这几项，没有契约模式的字段');
});


test('范围门禁的判定：越界、没改到的必改项；区域条目与路径条目（目录前缀与完整文件路径）；仓库根 .coda/ 的文件区域条目命中不了', () => {
  const declared = { 文档: ['docs/', 'README.md'], 仓库: ['scripts/', '.coda/'], 插件: ['plugins/composer/'] };
  const check = (allowed, files, required = []) => scopeViolations({ required, allowed }, declared, files);
  assert.deepEqual(check(['docs/'], ['docs/a.md', 'scripts/x.mjs'], ['docs/a.md', 'plugins/composer/README.md']), { outside: ['scripts/x.mjs'], missing: ['plugins/composer/README.md'] });
  assert.deepEqual(check(['docs/'], []), { outside: [], missing: [] });
  assert.deepEqual(check(['docs/'], ['docs/a.md'], ['docs/']), { outside: [], missing: [] });
  // 区域条目：与区域名完全相同，命中归属这个区域的文件（最长前缀归属）；required 同样。
  assert.deepEqual(check(['文档'], ['docs/a.md', 'README.md', 'scripts/x.mjs']), { outside: ['scripts/x.mjs'], missing: [] });
  assert.deepEqual(check(['文档', '插件'], ['docs/a.md'], ['文档', '插件']), { outside: [], missing: ['插件'] });
  assert.deepEqual(check(['docs/'], ['docs/a.md'], ['文档']), { outside: [], missing: [] }, 'required 的区域条目同样按区域命中，与 allowed 无关');
  // 路径条目：以 / 结尾是目录前缀，否则是完整文件路径（不是前缀）。
  assert.deepEqual(check(['docs'], ['docs/a.md']), { outside: ['docs/a.md'], missing: [] }, '没有 / 结尾的 docs 只命中名为 docs 的文件');
  assert.deepEqual(check(['docs'], ['docs']), { outside: [], missing: [] });
  assert.deepEqual(check(['docs/a.md'], ['docs/a.md', 'docs/a.md.bak', 'docs/b.md']), { outside: ['docs/a.md.bak', 'docs/b.md'], missing: [] });
  assert.deepEqual(check(['docs/'], ['docs/x/y.md', 'docs.md', 'mydocs/a.md']), { outside: ['docs.md', 'mydocs/a.md'], missing: [] });
  assert.deepEqual(check(['scripts/'], [], ['scripts/x.mjs']), { outside: [], missing: ['scripts/x.mjs'] });
  // 都不在区域里的文件，区域条目命中不了；没有区域定义时所有条目都是路径条目。
  assert.deepEqual(check(['文档'], ['other/x']), { outside: ['other/x'], missing: [] });
  assert.deepEqual(scopeViolations({ required: ['文档'], allowed: ['文档'] }, {}, ['文档']), { outside: [], missing: [] }, '没有这个区域，「文档」就是路径条目');
  // 仓库根 .coda/：区域条目命中不了（哪怕它属于区域），以 .coda/ 开头的路径条目才行。
  assert.deepEqual(check(['仓库'], ['scripts/x.mjs', '.coda/areas.json', '.coda/workflows/a.bpmn'], ['仓库']), { outside: ['.coda/areas.json', '.coda/workflows/a.bpmn'], missing: [] });
  assert.deepEqual(check(['.coda/'], ['.coda/areas.json', '.coda/workflows/a.bpmn', 'scripts/x.mjs']), { outside: ['scripts/x.mjs'], missing: [] });
  assert.deepEqual(check(['.coda/areas.json'], ['.coda/areas.json', '.coda/other.json']), { outside: ['.coda/other.json'], missing: [] });
  assert.deepEqual(check(['仓库'], ['.coda/areas.json'], ['仓库']), { outside: ['.coda/areas.json'], missing: ['仓库'] }, '只改 .coda/ 下的文件，区域条目的必改项也算没改到');
  assert.deepEqual(check(['仓库', '.coda/'], ['.coda/areas.json'], ['.coda/']), { outside: [], missing: [] });
  // 不在仓库根的 .coda/（如 plugins/composer/.coda/）不受这条限制。
  assert.deepEqual(check(['插件'], ['plugins/composer/.coda/workflows/develop.bpmn'], ['插件']), { outside: [], missing: [] });
  assert.deepEqual(check(['插件', 'plugins/composer/.coda/'], ['plugins/composer/.coda/workflows/develop.bpmn']), { outside: [], missing: [] });
  // 路径含 U+FFFD（无法按 UTF-8 解码）：哪怕与 allowed 的完整路径条目、目录前缀条目字面相符也越界，required 的同名条目也不算命中；别的文件照旧。
  assert.deepEqual(check(['bad-\uFFFD', 'bad/', 'docs/'], ['bad-\uFFFD', 'bad/x-\uFFFD', 'docs/a.md'], ['bad-\uFFFD', 'bad/']), { outside: ['bad-\uFFFD', 'bad/x-\uFFFD'], missing: ['bad-\uFFFD', 'bad/'] });
  assert.deepEqual(check(['文档'], ['docs/a-\uFFFD.md', 'docs/b.md'], ['文档']), { outside: ['docs/a-\uFFFD.md'], missing: [] }, '区域条目同样命中不了，别的文件照常命中');
});


test('范围门禁这一步：改名两侧都算改动文件，区域定义读 base 的，违例带清单回到进行中，通过记下 head，勾「交用户批准」有违例也往下走', t => {
  const f = fixture(t);
  put(f, 'old/a.txt', 'a'); put(f, 'docs/a.md', 'doc'); put(f, '.coda/areas.json', '{ "文档": ["docs/"], "仓库": ["scripts/", ".coda/"] }');
  f.git('add', '-A'); f.git('commit', '-qm', 'seed'); f.git('push', '-q', 'origin', 'main');
  f.run('branch', { CONTRACT, REVIEWER: 'true' });
  change(f, () => {
    mkdirSync(join(f.work, 'new')); f.git('mv', 'old/a.txt', 'new/a.txt'); put(f, 'docs/b.md', 'b'); put(f, 'src/x.txt', 'x');
    put(f, '.coda/areas.json', '{ "文档": ["docs/"], "仓库": ["scripts/", ".coda/"], "源码": ["src/"] }');
  });
  const pr = submitContract(f);
  const contract = (allowed, required = []) => JSON.stringify({ required, allowed, hooks: [] });
  // 改名拆成一删一加：只放行新路径，旧路径越界；删除的文件也算改动文件。
  assert.deepEqual(gate(f, pr, contract(['new/', '文档', '源码', '.coda/'])), { route: 'progress' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['old/a.txt', 'src/x.txt'], missing: [] }, '「源码」不是 base 上的区域：head 上新加的区域不算，它按路径条目');
  assert.equal(f.reason(), `范围门禁没过，需求分支 head ${pr.head}。\n越界的改动（不在契约的 allowed 内）：\n- old/a.txt\n- src/x.txt\n处理：派块把越界的改动拿掉、把必改项补上，再提交验收；确实需要越界，提交验收时勾「交用户批准」，由用户在批准卡上决定。`);
  // 越界与没改到的必改项都写进原因；区域条目（含 head 上改了区域定义的 .coda/areas.json）不能命中仓库根 .coda/ 下的文件。
  assert.deepEqual(gate(f, pr, contract(['new/', 'old/', '文档', 'src/', '仓库'], ['docs/c.md', '仓库'])), { route: 'progress' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['.coda/areas.json'], missing: ['docs/c.md', '仓库'] });
  assert.equal(f.reason(), `范围门禁没过，需求分支 head ${pr.head}。\n越界的改动（不在契约的 allowed 内）：\n- .coda/areas.json\n没改到的必改项（契约的 required）：\n- docs/c.md\n- 仓库\n处理：派块把越界的改动拿掉、把必改项补上，再提交验收；确实需要越界，提交验收时勾「交用户批准」，由用户在批准卡上决定。`);
  assert.equal(f.calls().filter(c => c.args[1] === 'edit').length, 0, 'PR 留着不动');
  // 通过：记下这个 head 过了门禁。
  assert.deepEqual(gate(f, pr, contract(['new/', 'old/a.txt', '文档', 'src/x.txt', '.coda/areas.json'], ['new/a.txt', '文档'])), { route: 'pass' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: [], missing: [] });
  // 这次勾了「交用户批准」：违例照常算、记进状态文件，但不打回，回来的原因也清掉了。
  submitContract(f, { escalate: true });
  assert.equal(f.state().escalate, true);
  assert.deepEqual(gate(f, pr, contract(['new/'], ['docs/c.md'])), { route: 'pass' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['.coda/areas.json', 'docs/b.md', 'old/a.txt', 'src/x.txt'], missing: ['docs/c.md'] });
  assert.equal(f.reason(), '');
  // 每次提交验收重新取值：下一次不勾，有违例又打回。
  submitContract(f);
  assert.equal(f.state().escalate, false);
  assert.equal(gate(f, pr, contract(['new/'])).route, 'progress');
  // 契约坏了（流程里开工时已经校验过）：这一步也不放行。
  for (const bad of ['{', '']) assert.match(f.run('gate', { CONTRACT: bad, BASE_COMMIT: pr.base, HEAD_COMMIT: pr.head }, 1).stderr, /契约不合规范：不是合法的 JSON/);
});


test('范围门禁这一步：路径含非法 UTF-8 字节的改动一定越界、不让必改项算改到，原因里列出它并注明', t => {
  const f = fixture(t);
  f.run('branch', { CONTRACT, REVIEWER: 'true' });
  const base = f.remote('main');
  // 有的文件系统（macOS）不允许非法 UTF-8 的文件名：用 git 底层命令直接造出路径为 bad-\xFF 的提交。
  const plumbing = (args, input) => { const r = spawnSync('git', args, { cwd: f.work, env: f.env, input }); assert.equal(r.status, 0, String(r.stderr)); return r.stdout; };
  const blob = plumbing(['hash-object', '-w', '--stdin'], 'x').toString().trim();
  const tree = plumbing(['mktree', '-z'], Buffer.concat([plumbing(['ls-tree', '-z', base]), Buffer.from(`100644 blob ${blob}\tbad-`), Buffer.from([0xff, 0])])).toString().trim();
  const head = plumbing(['commit-tree', tree, '-p', base, '-m', 'bad path']).toString().trim();
  f.git('push', '-q', 'origin', `${head}:refs/heads/${f.state().branch}`);
  const contract = JSON.stringify({ required: ['bad-\uFFFD'], allowed: ['bad-\uFFFD', 'docs/'], hooks: [] });
  assert.deepEqual(f.run('gate', { CONTRACT: contract, BASE_COMMIT: base, HEAD_COMMIT: head }).outputs, { route: 'progress' });
  assert.deepEqual(f.state().gate, { head, outside: ['bad-\uFFFD'], missing: ['bad-\uFFFD'] });
  const reason = f.reason();
  assert.ok(reason.includes('越界的改动（不在契约的 allowed 内）：\n- bad-\uFFFD（路径无法按 UTF-8 解码）\n'), reason);
  assert.ok(reason.includes('没改到的必改项（契约的 required）：\n- bad-\uFFFD\n处理：'), '必改项那一行不加注明');
});


test('范围门禁在流程里的位置：开 PR 之后、项目检查之前；违例回到进行中，通过直接到复用检查', async () => {
  const flow = await definition(), { elements, nodes, values, params, route, next } = flow;
  const into = id => elements.filter(e => e.$type === 'bpmn:SequenceFlow' && e.targetRef === nodes[id]).map(e => e.sourceRef.id).sort();
  assert.equal(next('pr'), 'gate');
  assert.deepEqual([into('gate'), into('after-gate'), into('reuse-checks')], [['pr'], ['gate'], ['after-gate']], '开 PR 之后只有一条路到门禁，门禁之后才到项目检查');
  assert.deepEqual(into('pr'), ['after-sync', 'after-sync-resolve'], '跟上目标分支的两条路都经 pr');
  assert.deepEqual(params('gate'), { CONTRACT: '=inputs.contract', BASE_COMMIT: '=pr.base', HEAD_COMMIT: '=pr.head', route: undefined });
  assert.equal(nodes.gate.name, '范围门禁');
  assert.equal(route('after-gate', { gate: { route: 'progress' } }), 'resume');
  assert.equal(route('after-gate', { gate: { route: 'pass' } }), 'reuse-checks');
  const base = { 'progress-result': { route: 'submit' }, sync: { route: 'pr' }, pr: { checked: false }, gate: { route: 'pass' } };
  assert.deepEqual(walk(flow, 'pr', base, ['checks']), ['pr', 'gate', 'after-gate', 'reuse-checks', 'checks']);
  assert.equal(walk(flow, 'pr', { ...base, gate: { route: 'progress' } }, ['checks', 'resume']).at(-1), 'resume');
  // 开工校验要的输入。
  assert.deepEqual(params('req'), { TITLE: params('req').TITLE, GOAL: params('req').GOAL, BASE: '=inputs.base', CONTRACT: '=inputs.contract', REVIEWER: '=inputs.overallReviewer != null', title: undefined, goal: undefined, base: undefined, branch: undefined });
  assert.deepEqual([params('pr').CONTRACT, params('checks-passed').CONTRACT], ['=inputs.contract', '=inputs.contract']);
  assert.ok(!values(flow.process).some(v => v.$type === 'coda:Input' && v.name === 'contract' && v.default !== undefined), '契约没有默认值');
});

test('契约只交给提交验收的项目检查：没勾「交用户批准」时 inputs 是 { contract: 原文 }，勾了为空；合并前检查、块都不带', async () => {
  const { params } = await definition();
  const inputs = withContract => evaluateTyped(params('checks').inputs.slice(1), { inputs: { contract: CONTRACT }, pr: typedOutputs({ withContract }) });
  assert.deepEqual(inputs('true'), { contract: CONTRACT }, '原文原样，不重新序列化');
  assert.deepEqual(inputs('false'), {}, '勾了交用户批准：不带');
  assert.deepEqual(Object.keys(params('premerge')), ['hook', 'commit']);
  assert.ok(!JSON.stringify(params('piece')).includes('contract'), '块不传契约');
});

test('「交用户批准」：选项总是显示，说明写明范围门禁、项目检查、自动合并的变化；整体评审按 head、自动合并的说明按 autoMerge 写', async () => {
  const { nodes, values } = await definition();
  const [submit] = values(nodes.progress);
  const escalate = submit.options.find(o => o.id === 'escalate');
  assert.deepEqual([escalate.name, escalate.default, escalate.shown], ['交用户批准', 'false', undefined], '没有 shown：总是显示');
  assert.ok(escalate.detail.includes('范围门禁有违例也不打回') && escalate.detail.includes('项目检查不按契约校验') && escalate.detail.includes('不自动合并'));
  assert.deepEqual(submit.options.map(o => [o.id, o.shown]), [['again', '=inputs.overallReviewer != null'], ['escalate', undefined]]);
  assert.equal(submit.options.find(o => o.id === 'again').detail, '当前 head 已经整体评审过时，这次再评一次');
  const render = (extra = {}) => nodes.progress.documentation[0].text.replace(/{{([\s\S]*?)}}/g, (_, e) => evaluateTyped(e, { inputs: { ...KICKOFF, contract: CONTRACT, ...extra }, req: { base: 'main' }, resume: { reason: '' } }) ?? '');
  const [on, off] = [render({ autoMerge: true }), render({ autoMerge: false })];
  for (const text of ['先过范围门禁', 'allowed', 'required', '勾「交用户批准」', '不打回', '项目检查不按契约校验', '不自动合并', '卡上写明违例', '契约原文交给项目检查',
    'head 与最近一次评完的整体评审的 head 不同时', 'head 没变不重评']) assert.ok(on.includes(text) && off.includes(text), text);
  assert.ok(on.includes('范围门禁在当前 head 上没有违例、整体评审评在当前 head 上且没有必须修、这次没勾「交用户批准」时直接合并（合并提交，合并后只跑契约 hooks 里列的流程，没列的不跑）'), on);
  assert.ok(off.includes('通过后由用户批准合并（合并提交）。') && !off.includes('直接合并'), off);
  for (const text of [on, off]) assert.ok(!/设备验收|需求交付|待交付|非契约|这次运行还没整体评审过/.test(text), text);
  const review = nodes.review.documentation[0].text.replace(/{{([\s\S]*?)}}/g, (_, e) => evaluateTyped(e, { inputs: { contract: CONTRACT }, req: {}, pr: {}, overall: {} }) ?? '');
  assert.ok(review.includes('需求分支 head 变了，再提交验收会在新 head 上重评；要在 head 没变时再评就勾「重新整体评审」。') && !review.includes('不再评，要再评'), review);
});


test('交用户批准的这次提交：整理整体评审的 auto 一律为 false，汇总最前面写明并列出范围门禁的违例，PR 描述不带它；没勾照旧', t => {
  const run = (f, extra) => f.run('overall', { AUTO: 'true', CONTRACT, ...extra }).outputs;
  const prepare = (f, options, files) => {
    f.run('branch', { CONTRACT, REVIEWER: 'true' });
    for (const file of files) change(f, () => put(f, file, file), `块 ${file}\n\nCoda-Piece: piece-${file}`), f.run('piece-landed', { TITLE: file, COMMIT: 'c'.repeat(40), PIECE_RUN: `piece-${file}`, REVIEWED: 'true' });
    const pr = submitContract(f, options);
    assert.equal(gate(f, pr).route, 'pass');
    f.run('overall-plan', { REVIEWER: 'true' });
    return pr;
  };
  const banner = '【交用户批准】这次提交是主 Agent 交给用户批准的，项目检查没有按契约校验，不自动合并。\n范围门禁的违例：';
  // 勾了、有违例：auto 为 false，不管整体评审评没评成。
  const f = fixture(t), pr = prepare(f, { escalate: true }, ['one']);
  const escalated = run(f, { SUMMARY: pr.summary });
  assert.deepEqual([escalated.route, escalated.auto], ['accept', 'false']);
  assert.equal(escalated.summary, `${banner}\n越界的改动（不在契约的 allowed 内）：\n- one\n没改到的必改项（契约的 required）：\n- docs/a.md\n\n${pr.summary}`);
  f.run('overall-reviewed', reviewed([{ level: 'nit', title: '变量名', location: 'one:1' }]));
  const minor = run(f, { SUMMARY: pr.summary });
  assert.equal(minor.auto, 'false');
  assert.ok(minor.summary.startsWith(banner) && minor.summary.includes('整体评审的小问题'), minor.summary);
  const edit = f.calls().find(c => c.args[1] === 'edit');
  assert.ok(edit.body.startsWith(pr.summary) && !edit.body.includes('交用户批准'), '说明只在批准卡和待交付卡的汇总里，不进 PR 描述');
  // 勾了、没有违例：写明没有。
  const g = fixture(t), clean = prepare(g, { escalate: true }, ['docs/a.md']);
  g.run('overall-reviewed', reviewed([]));
  const ok = run(g, { SUMMARY: clean.summary });
  assert.deepEqual([ok.auto, ok.summary], ['false', `${banner}没有。\n\n${clean.summary}`]);
  // 没勾：与非契约模式一样，auto 照 autoMerge 与评审判定，汇总不加说明。
  const h = fixture(t), plain = prepare(h, {}, ['docs/a.md']);
  h.run('overall-reviewed', reviewed([]));
  assert.deepEqual([run(h, { SUMMARY: plain.summary }).auto, run(h, { SUMMARY: plain.summary }).summary], ['true', plain.summary]);
  assert.equal(run(h, { SUMMARY: plain.summary, AUTO: 'false' }).auto, 'false');
  // 非契约模式（没有 CONTRACT）即使状态里有 escalate 也不受影响。
  assert.deepEqual([run(h, { SUMMARY: plain.summary, CONTRACT: undefined }).auto, run(h, { SUMMARY: plain.summary, CONTRACT: undefined }).summary], ['true', plain.summary]);
});


test('范围门禁：.gitmodules 里写了 ignore = all 的子模块，只更新指针的提交也算改动文件', t => {
  const f = fixture(t);
  const link = sha => f.git('update-index', '--add', '--cacheinfo', `160000,${sha},vendor/lib`);
  put(f, '.gitmodules', '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib.git\n\tignore = all\n');
  f.git('add', '.gitmodules'); link('1'.repeat(40)); f.git('commit', '-qm', 'submodule'); f.git('push', '-q', 'origin', 'main');
  f.run('branch', { CONTRACT, REVIEWER: 'true' });
  // 只更新指针的提交：不经 git add -A（工作区没有检出子模块，add -A 会把它当作删除）。
  f.git('fetch', '-q', 'origin', f.state().branch); f.git('switch', '-q', '--detach', 'FETCH_HEAD');
  link('2'.repeat(40)); f.git('commit', '-qm', 'pointer'); f.git('push', '-q', 'origin', `HEAD:refs/heads/${f.state().branch}`);
  const pr = submitContract(f);
  assert.equal(f.git('ls-tree', pr.head, 'vendor/lib'), `160000 commit ${'2'.repeat(40)}\tvendor/lib`, '提交后仍是子模块（160000），指向新的提交');
  assert.equal(f.git('diff', '--name-only', `${pr.base}...${pr.head}`), '', 'ignore = all 下普通 diff 看不到指针变化');
  assert.equal(gate(f, pr, JSON.stringify({ required: [], allowed: ['docs/'], hooks: [] })).route, 'progress');
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['vendor/lib'], missing: [] });
  assert.equal(gate(f, pr, JSON.stringify({ required: ['vendor/lib'], allowed: ['vendor/lib'], hooks: [] })).route, 'pass');
});


// 契约模式的整体评审按 head 走（README.md「整体评审」）：round 在需求分支上提一个改动（change 为 false 时 head 不变），提交验收、过门禁、定整体评审。
const contracted = (t, hooks = []) => {
  const contract = JSON.stringify({ required: ['docs/a.md'], allowed: ['docs/'], hooks });
  const f = fixture(t); f.run('branch', { CONTRACT: contract, REVIEWER: 'true' });
  let n = 0;
  const round = (options = {}, change_ = true) => {
    if (change_) change(f, () => put(f, 'docs/a.md', `v${n++}`));
    const pr = submitContract(f, options, contract);
    assert.equal(gate(f, pr, contract).route, 'pass');
    return { pr, plan: (extra = {}) => f.run('overall-plan', { REVIEWER: 'true', CONTRACT: contract, ...extra }).outputs.review };
  };
  const overall = (pr, extra = {}) => f.run('overall', { SUMMARY: pr.summary, AUTO: 'true', CONTRACT: contract, ...extra }).outputs;
  return { f: Object.assign(f, { contract }), contract, round, overall };
};

test('契约模式定整体评审按 head：head 变了就评，没变不评，勾「重新整体评审」一定评；没评成不算评过；只合进一块且它评成过也评', t => {
  const { f, round } = contracted(t);
  mkdirSync(join(f.work, 'docs'));
  f.land('docs/b.md', 'x', '块一\n\nCoda-Piece: piece-1');
  f.run('piece-landed', { TITLE: '块一', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-1', REVIEWED: 'true' });
  let { plan } = round();
  assert.deepEqual(f.state().landed, ['piece-1']);
  assert.equal(plan(), 'true', '只合进了一块且它评成过：契约模式照样评');
  assert.equal(plan({ REVIEWER: 'false' }), 'false', '没填整体评审者不评');
  // 没评成（调用没成、没评完）：最近一次评完的还没有，照样评；评完后同一 head 不评。
  f.run('overall-lost');
  ({ plan } = round({}, false));
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成：没有合格的 review 代码块', FINDINGS: '[]', REPORT: '' }));
  ({ plan } = round({}, false));
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([]));
  ({ plan } = round({}, false));
  assert.equal(plan(), 'false', '同一个 head 已评完：不重评');
  ({ plan } = round({ again: true }, false));
  assert.equal(plan(), 'true', '勾了「重新整体评审」：同一个 head 也评');
  ({ plan } = round({}, false));
  assert.equal(plan(), 'false', '勾选只管这一次提交');
  // head 变了：评；评完了那一个 head 又不评。又一次没评成不动最近一次评完的 head，仍然评。
  ({ plan } = round());
  assert.equal(plan(), 'true', 'head 变了');
  f.run('overall-lost');
  ({ plan } = round({}, false));
  assert.equal(plan(), 'true', '新 head 上没评成：最近一次评完的仍是旧 head');
  f.run('overall-reviewed', reviewed([]));
  ({ plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.equal(f.state().overall.head, f.state().head);
});

test('契约模式的 auto：开了 autoMerge、没勾「交用户批准」、门禁在当前 head 上无违例、最近一次评完的整体评审就是当前 head 且没有必须修；旧提交上出过的必须修不再粘住', t => {
  const { f, round, overall } = contracted(t);
  const must = [{ level: 'must', title: '登录后停在空白页', location: 'app.mjs:3' }];
  const verdict = (pr, extra) => { const { route, auto } = overall(pr, extra); return [route, auto]; };
  // 第一个 head：评出必须修，交主 Agent，不自动合并。
  let { pr, plan } = round();
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed(must));
  assert.deepEqual(verdict(pr), ['review', 'false']);
  assert.equal(f.state().overallMust, true);
  // 修好后新 head 上重评、没有必须修：自动合并（不再粘住）。
  ({ pr, plan } = round());
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([]));
  assert.deepEqual(verdict(pr), ['accept', 'true']);
  assert.equal(overall(pr, { AUTO: 'false' }).auto, 'false', '没开 autoMerge');
  // 同一个 head 再提交验收（不重评）：评审与门禁都还是当前 head，照样自动合并。
  ({ pr, plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.equal(overall(pr).auto, 'true');
  // 勾了「交用户批准」：不自动合并。
  ({ pr, plan } = round({ escalate: true }, false));
  plan();
  assert.equal(overall(pr).auto, 'false');
  // 同一个 head 已有评完且没有必须修的整体评审：没发起重评，照旧复用，auto 为 true；勾「重新整体评审」再评但没评成（调用没成、没评完），auto 为 false，route 仍是 review。
  ({ pr, plan } = round());
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([]));
  ({ pr, plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.deepEqual(verdict(pr), ['accept', 'true'], '没发起重评：复用同一个 head 上评完的结果');
  ({ pr, plan } = round({ again: true }, false));
  assert.equal(plan(), 'true');
  f.run('overall-lost');
  assert.deepEqual(verdict(pr), ['review', 'false'], '重评的调用没成功');
  ({ pr, plan } = round({ again: true }, false));
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成', FINDINGS: '[]', REPORT: '' }));
  assert.deepEqual(verdict(pr), ['review', 'false'], '重评没评完');
  assert.equal(f.state().overall.head, f.state().head, '最近一次评完的还是同一个 head 上的那份');
  // 下一次不重评的提交：outcome 清掉，又复用那份，auto 为 true。
  ({ pr, plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.deepEqual(verdict(pr), ['accept', 'true']);
  // 评审是旧 head 的：新 head 上没评成（调用没成、没评完）。
  ({ pr, plan } = round());
  assert.equal(plan(), 'true');
  f.run('overall-lost');
  assert.equal(overall(pr).auto, 'false', '新 head 上没评成：最近一次评完的是旧 head');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成', FINDINGS: '[]', REPORT: '' }));
  assert.deepEqual(verdict(pr), ['review', 'false'], '没评完不算评完');
  // 当前 head 有必须修。
  f.run('overall-reviewed', reviewed(must));
  assert.deepEqual(verdict(pr), ['review', 'false']);
  // 门禁是旧 head 算的：新 head 评好了，但没有对新 head 跑过门禁。
  const oldGate = f.state().gate;
  change(f, () => put(f, 'docs/a.md', 'newer'));
  const next = submitContract(f, {}, f.contract);
  assert.notEqual(next.head, oldGate.head);
  f.run('overall-plan', { REVIEWER: 'true', CONTRACT });
  f.run('overall-reviewed', reviewed([]));
  assert.equal(overall(next).auto, 'false', '门禁记的是旧 head');
  assert.deepEqual(f.state().gate, oldGate);
  // 门禁在当前 head 上有违例：不自动合并（正常走到这里只有勾了交用户批准，这里直接改状态核对判定本身）。
  assert.equal(gate(f, next, f.contract).route, 'pass');
  assert.equal(overall(next).auto, 'true');
  for (const violation of [{ outside: ['x'], missing: [] }, { outside: [], missing: ['docs/b.md'] }]) {
    const state = f.state(); writeFileSync(join(f.env.CODA_ARTIFACTS, 'develop.json'), JSON.stringify({ ...state, gate: { ...state.gate, ...violation } }));
    assert.equal(overall(next).auto, 'false', JSON.stringify(violation));
  }
});


test('提交验收的顺序：跟上目标分支、开 PR、范围门禁、项目检查、整体评审、合并前检查、GitHub 检查，之后列出合并后的流程，最后批准', async () => {
  const flow = await definition();
  const order = ['sync', 'pr', 'gate', 'checks', 'overall-plan', 'overall-call', 'overall', 'premerge', 'github-checks', 'joiners'];
  const context = { 'progress-result': { route: 'submit' }, sync: { route: 'pr' }, pr: { checked: false }, gate: { route: 'pass' }, 'overall-plan': { review: true }, overall: { route: 'accept', auto: false }, inputs: {} };
  const visited = walk(flow, 'after-progress', context, ['approve', 'merge']);
  assert.deepEqual(visited.filter(id => order.includes(id)), order, visited.join(' → '));
  assert.equal(visited.at(-1), 'approve');
  // 同一 head 的项目检查复用，评审时检查已有结论；没评也一样往下走。
  const reused = walk(flow, 'pr', { ...context, pr: { checked: true }, 'overall-plan': { review: false } }, ['approve']);
  assert.deepEqual(reused.filter(id => order.includes(id)), ['pr', 'gate', 'overall-plan', 'overall', 'premerge', 'github-checks', 'joiners']);
  // 有必须修：先交主 Agent，继续验收才接着走合并前检查；回到进行中就不跑。
  const escalated = { ...context, overall: { route: 'review', auto: false } };
  assert.deepEqual(walk(flow, 'overall', { ...escalated, 'review-result': { route: 'continue' } }, ['approve']).filter(id => [...order, 'review'].includes(id)),
    ['overall', 'review', 'premerge', 'github-checks', 'joiners']);
  assert.deepEqual(walk(flow, 'overall', { ...escalated, 'review-result': { route: 'progress' } }, ['resume', 'premerge']).at(-1), 'resume');
});

test('自动合并：满足条件（overall.auto）就在合并前检查和 GitHub 检查、列出合并后的流程之后不出批准卡，直接到「读取批准」合成答复再合并；其余照常出批准卡', async () => {
  const flow = await definition(), { nodes, values, route } = flow;
  const at = auto => walk(flow, 'overall-route', { overall: { route: 'accept', auto }, 'approval-result': { route: 'merge' }, inputs: {} }, ['merge', 'approve']);
  const merged = at(true);
  assert.deepEqual([merged.at(-1), merged.includes('premerge'), merged.includes('github-checks'), merged.includes('approve')], ['merge', true, true, false]);
  assert.deepEqual(merged.slice(merged.indexOf('github-checks')), ['github-checks', 'joiners', 'auto-merge-choice', 'approval-result', 'after-approval', 'merge'], '先列出加入者，再分流，自动合并不经批准卡');
  const manual = at(false);
  assert.deepEqual(manual.slice(manual.indexOf('github-checks')), ['github-checks', 'joiners', 'auto-merge-choice', 'approve'], '不自动合并：照旧出批准卡');
  // 判定只在「整理整体评审」的 auto；收尾各处只引用它。
  for (const text of [nodes['auto-merge-needed'].conditionExpression.body, nodes.done.notify, values(nodes.done).find(v => v.name === 'notify').value]) {
    assert.ok(text.includes('overall.auto = true') && !text.includes('inputs.autoMerge'), text);
  }
  assert.equal(nodes['merged-only'].conditionExpression.body, '=approval-result.only = "[]"');
  // 自动合并时白名单非空照样到 run-merged；留着之前批准卡的答复不影响，照常通知。
  const stale = { approve: { options: { notify: false } }, inputs: {}, overall: { auto: true } };
  assert.equal(route('merged-choice', { ...stale, 'approval-result': { only: '["deploy"]', missing: '' } }), 'fill-choice');
  assert.equal(route('merged-choice', { ...stale, 'approval-result': { only: '[]', missing: '' } }), 'done-none');
  for (const expression of ['done', 'done-none'].flatMap(id => [nodes[id].notify, values(nodes[id]).find(v => v.name === 'notify').value])) {
    assert.equal(evaluate(expression.slice(1), stale).value, true);
    assert.equal(evaluate(expression.slice(1), { ...stale, overall: { auto: false } }).value, false, '批准卡上没勾通知');
  }
});

// 自动路径上批准卡没有执行过，读它得到空值：自动路径会求值的表达式在上下文里不给 approve（也不给 fill 等没执行的节点）时不抛错、结果正确。
test('自动路径上没执行过的节点读到空值：approval-result 的环境变量、merged-choice 条件、结束事件的 notify、fill 的说明都不出错', async () => {
  const flow = await definition(), { nodes, values, params, route } = flow;
  const expect = (expression, context) => { const result = evaluate(expression.slice(1), context); assert.deepEqual(result.problems ?? [], [], expression); return result.value; };
  const joiners = { list: [{ id: 'deploy', name: '部署' }] };
  const context = { inputs: { contract: CONTRACT, autoMerge: true }, overall: { auto: true }, joiners, pr: { head: 'h', url: PR }, req: { title: '输入框' }, run: { id: 'run-1' }, merge: { commit: 'm' } };
  assert.equal(context.approve, undefined);
  const envs = params('approval-result');
  assert.equal(expect(envs.AUTO, context), true);
  assert.equal(expect(envs.CONTRACT, context), CONTRACT);
  assert.deepEqual(expect(envs.JOINERS, context), joiners.list);
  assert.equal(expect(envs.APPROVAL, context), null, '没有批准卡：空值，脚本在自动路径上不读它');
  for (const only of ['[]', '["deploy"]']) for (const missing of ['', 'notes']) {
    const ctx = { ...context, 'approval-result': { only, missing, asks: '「发布说明」：部署要' } };
    assert.equal(route('merged-choice', ctx), only === '[]' ? 'done-none' : 'fill-choice');
    assert.equal(route('fill-choice', ctx), missing ? 'fill' : 'merged-inputs');
  }
  for (const id of ['done', 'done-none']) for (const expression of [nodes[id].notify, values(nodes[id]).find(v => v.name === 'notify').value]) {
    assert.equal(expect(expression, context), true, '自动路径视为勾上「全部完成后通知 Agent」');
  }
  assert.equal(expect(values(nodes.done).find(v => v.name === 'pr').value, context), PR);
  // fill 的说明：按 overall.auto 分两种写法，自动路径读 approval-result 和 loopCounter 不出错。
  const doc = nodes.fill.documentation[0].text;
  const render = ctx => doc.replace(/{{([\s\S]*?)}}/g, (_, e) => { const r = evaluate(e, ctx); assert.deepEqual(r.problems ?? [], [], e); return r.value ?? ''; });
  const filled = { ...context, 'approval-result': { asks: '「发布说明」：部署要' }, loopCounter: 1 };
  const auto = render(filled), manual = render({ ...filled, overall: { auto: false } });
  assert.ok(auto.startsWith('契约的 hooks 里列的流程要一段文字') && !auto.includes('用户批准合并时勾的') && auto.includes('「发布说明」：部署要'), auto);
  assert.ok(manual.startsWith('用户批准合并时勾的流程要一段文字，批准卡上没有写：') && !manual.includes('契约的 hooks'), manual);
  assert.equal(auto.split('\n').slice(1).join('\n'), manual.split('\n').slice(1).join('\n'), '除第一句外两种写法一样');
});


// hook-joiners 的列表：lint 声明了默认勾选，但不在任何白名单里。
const LIST = JSON.stringify([
  { id: 'deploy', name: '部署', default: false },
  { id: 'lint', name: '代码检查', default: true },
  { id: 'publish-preview', name: '发布预览版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
]);

test('自动合并在「读取批准」里合成答复：只勾契约 hooks 白名单里的加入者，没写的不勾（含默认勾选的）；白名单为空 only 是 []；批准卡留着旧答复也不读；没有契约时一律读批准卡', t => {
  const f = fixture(t); f.run('branch');
  const contract = hooks => JSON.stringify({ required: [], allowed: ['a'], hooks });
  const auto = (hooks, extra = {}) => f.run('approval', { AUTO: 'true', CONTRACT: hooks ? contract(hooks) : undefined, JOINERS: LIST, ...extra }).outputs;
  assert.deepEqual(auto(['deploy']), { route: 'merge', only: '["deploy"]', picked: '部署', inputs: '{}', missing: '', asks: '', needs: '{}' });
  assert.equal(auto(['deploy', 'publish-preview']).only, '["deploy","publish-preview"]', '按列表的顺序');
  assert.deepEqual([auto([]).route, auto([]).only], ['merge', '[]'], '白名单为空');
  // 白名单里的加入者要文字：卡上没有写，交主 Agent 补填（missing、asks、needs 照旧）。
  assert.deepEqual([auto(['publish-preview']).missing, auto(['publish-preview']).asks, auto(['publish-preview']).needs], ['notes', '「发布说明」：发布预览版要', '{"notes":["publish-preview"]}']);
  // 早先出过批准卡、用户选过「暂不合并」：之后自动路径不读那份旧答复。
  const stale = JSON.stringify({ choice: 'stop', note: '先别合', options: { lint: true } });
  assert.deepEqual([auto(['deploy'], { APPROVAL: stale }).route, auto(['deploy'], { APPROVAL: stale }).only], ['merge', '["deploy"]']);
  assert.equal(auto(['deploy'], { APPROVAL: 'null' }).only, '["deploy"]', '这条路上没有批准卡');
  assert.equal(f.reason(), '', '没有回到进行中');
  // 没有契约（监督开发共用这个脚本）：开了 AUTO 也不合成答复，一律读批准卡的答复。
  const card = JSON.stringify({ choice: 'merge', options: { lint: true } });
  assert.deepEqual([auto(null, { APPROVAL: card }).route, auto(null, { APPROVAL: card }).only], ['merge', '["lint"]']);
  assert.equal(auto(null, { APPROVAL: stale }).route, 'stop');
  assert.match(f.reason(), /用户选了暂不合并：\n先别合/);
  // 人工路径（没有 AUTO）不受 hooks 约束，照旧按用户在卡上的勾选。
  const manual = f.run('approval', { AUTO: 'false', CONTRACT: contract(['deploy']), JOINERS: LIST, APPROVAL: JSON.stringify({ choice: 'merge', options: { lint: true, 'publish-preview': true }, inputs: { notes: '说明' } }) }).outputs;
  assert.deepEqual([manual.route, manual.only, manual.inputs], ['merge', '["lint","publish-preview"]', '{"notes":"说明"}']);
  assert.match(f.run('approval', { AUTO: 'false', CONTRACT: contract(['deploy']), JOINERS: LIST, APPROVAL: JSON.stringify({ choice: 'stop', note: '再等等' }) }).outputs.route, /stop/);
  assert.match(f.reason(), /用户选了暂不合并：\n再等等/);
});

test('自动合并时白名单里有不是当前 head 上挂点 merged 加入者的名字：不合并，带着原因回到进行中，原因写明名字和当前有哪些加入者', t => {
  const f = fixture(t); f.run('branch');
  const out = f.run('approval', { AUTO: 'true', CONTRACT: JSON.stringify({ required: [], allowed: ['a'], hooks: ['deploy', 'ghost', 'phantom'] }), JOINERS: LIST }).outputs;
  assert.deepEqual([out.route, out.only, out.picked], ['stop', '[]', '']);
  const reason = f.reason();
  assert.match(reason, /自动合并没有合并/);
  assert.ok(reason.includes('不是需求分支 head 上挂点 merged 的加入者：ghost、phantom。'), reason);
  assert.ok(reason.includes('当前 head 上挂点 merged 的加入者：deploy、lint、publish-preview'), reason);
  assert.match(reason, /交用户批准/);
  // 没有任何加入者。
  f.run('approval', { AUTO: 'true', CONTRACT: JSON.stringify({ required: [], allowed: ['a'], hooks: ['deploy'] }), JOINERS: '[]' });
  assert.ok(f.reason().includes('当前 head 上挂点 merged 的加入者：没有'), f.reason());
});


test('项目检查结果的复用区分带不带契约：同一个 head，不带契约通过的不能当带契约通过用，反过来也不行；同一模式照常复用', t => {
  const f = fixture(t); f.run('branch', { CONTRACT, REVIEWER: 'true' }); change(f, () => put(f, 'docs/a.md', 'doc'));
  const passed = () => f.run('checks-passed', { RUNS, CONTRACT });
  const checked = options => submitContract(f, options).checked;
  assert.equal(checked({}), 'false');
  passed();
  assert.equal(f.state().checks.contract, true, '记下这次通过时带了契约');
  assert.equal(checked({}), 'true', '同一个 head、同样带契约：复用');
  assert.equal(checked({ again: true }), 'true');
  assert.equal(checked({ escalate: true }), 'false', '带契约通过的不能当作不带契约通过');
  passed();
  assert.equal(f.state().checks.contract, false, '勾了交用户批准：这次的项目检查没带契约');
  assert.equal(checked({ escalate: true }), 'true', '同一个 head、同样不带契约：复用');
  assert.equal(checked({}), 'false', '不带契约通过的不能当作带契约通过');
  passed();
  assert.equal(checked({}), 'true');
  change(f, () => put(f, 'docs/b.md', 'more'));
  assert.equal(checked({}), 'false', 'head 变了照旧重跑');
});

test('pr 输出的 withContract 是带不带契约的唯一判定：没勾为 true，勾了为 false，每次提交验收重新取值', t => {
  const f = fixture(t); f.run('branch', { CONTRACT, REVIEWER: 'true' }); change(f, () => put(f, 'docs/a.md', 'doc'));
  assert.equal(submitContract(f).withContract, 'true');
  assert.equal(submitContract(f, { again: true }).withContract, 'true');
  assert.equal(submitContract(f, { escalate: true }).withContract, 'false');
  assert.equal(submitContract(f).withContract, 'true', '每次提交验收重新取值');
});

// 脚本与监督开发共用：没有 CONTRACT（监督开发的流程不传）时，每一步的输出和写进状态文件的内容与监督开发一样，契约模式的字段都不出现。
test('没有 CONTRACT 时脚本与监督开发一样：状态里没有契约模式的字段，pr 不输出 withContract，批准一律读批准卡的答复', t => {
  const f = fixture(t); f.run('branch');
  assert.equal('CONTRACT' in f.env, false, '夹具没有设 CONTRACT（空串也算设了）');
  f.land('one', 'first');
  f.run('progress', { PROGRESS: JSON.stringify({ choice: 'submit', note: '汇报', options: { again: false, escalate: true } }) });
  assert.deepEqual(Object.keys(f.state()).sort(), ['again', 'base', 'branch', 'feedback', 'goal', 'report', 'title'], '勾了 escalate 也不记');
  f.run('sync-base', { FIXER: 'true' });
  const pr = f.run('pr').outputs;
  assert.deepEqual(Object.keys(pr).sort(), ['base', 'branch', 'checked', 'head', 'summary', 'task', 'url']);
  f.run('checks-passed', { RUNS });
  assert.deepEqual(f.state().checks, { head: pr.head, runs: JSON.parse(RUNS) });
  assert.equal(f.run('pr').outputs.checked, 'true', '按 head 复用');
  assert.equal(f.run('overall-plan', { REVIEWER: 'true' }).outputs.review, 'true');
  f.run('overall-reviewed', reviewed([]));
  const overall = f.run('overall', { AUTO: 'true', SUMMARY: pr.summary }).outputs;
  assert.deepEqual([overall.route, overall.summary], ['accept', pr.summary], '汇总不加「交用户批准」的说明');
  assert.equal(f.state().gate, undefined);
  const card = JSON.stringify({ choice: 'merge', options: { lint: true } });
  assert.equal(f.run('approval', { AUTO: 'true', JOINERS: JSON.stringify([{ id: 'lint', name: '代码检查' }]), APPROVAL: card }).outputs.only, '["lint"]');
});


// 假宿主：照流程定义从开始走到结束。网关按 FEEL 分流，脚本步骤真跑 develop.mjs（env 照 coda:env 求值、输出照引擎转布尔），
// 人工任务按引擎展开文字后交给 answers 里的函数答，调用的流程和服务步骤也由 answers 给结果（没给的服务步骤当作成功、没有输出）。
async function host(f, inputs, message, answers) {
  const { nodes, values, route, next } = await definition();
  // 走到结束事件为止（不执行它），end 是结束事件的 ID。
  const context = { inputs, run: { id: 'run-1', message } }, visited = [], cards = [];
  const value = v => (v.startsWith('=') ? evaluateTyped(v.slice(1), context) : v);
  const render = text => text.replace(/{{([\s\S]*?)}}/g, (_, e) => { const v = evaluateTyped(e, context); return v === null || v === undefined ? '' : String(v); });
  let step = 'start';
  while (nodes[step].$type !== 'bpmn:EndEvent') {
    const node = nodes[step], type = node.$type;
    visited.push(step);
    if (type === 'bpmn:ScriptTask') {
      const env = Object.fromEntries(values(node).filter(v => v.$type === 'coda:Env').map(v => [v.name, value(v.value)]).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v ?? null)]));
      context[step] = typedOutputs(f.run(/develop\.mjs" (\S+)/.exec(node.script)[1], env).outputs);
    } else if (type === 'bpmn:UserTask') {
      const text = render(node.documentation[0].text);
      cards.push({ step, text });
      context[step] = answers[step](text);
    } else if (type === 'bpmn:CallActivity' || type === 'bpmn:ServiceTask') context[step] = answers[step]?.() ?? {};
    step = type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
  }
  return { visited, cards, context, end: step };
}

// 契约开发的需求：一块、提交验收、门禁与整体评审都在当前 head 上，自动合并；hooks 是契约的白名单，joiners 是 head 上挂点 merged 的加入者。
async function autoRun(t, hooks, joiners) {
  const f = fixture(t);
  const contract = JSON.stringify({ required: ['one'], allowed: ['one'], approved: { skeleton: {} }, hooks });
  const progress = [{ choice: 'piece', note: '块一\n做第一块' }, { choice: 'submit', note: '做了什么\n- 输入框能输入\n需要你知道：无', options: { again: false, escalate: false } }];
  const reviews = [];
  const run = await host(f, { title: '输入框', executor: { agent: 'codex' }, executor2: null, reviewer: { agent: 'kimi' }, overallReviewer: { agent: 'grok' }, autoMerge: true, base: '', contract }, '输入框可以输入', {
    progress: () => progress.shift(),
    piece: () => ({ commit: f.land('one', 'first', '块一\n\nCoda-Piece: piece-1'), run: 'piece-1', reviewed: true }),
    checks: () => ({ runs: [{ workflow: 'test', state: 'succeeded', runId: 'c1' }] }),
    'overall-call': () => { reviews.push(f.state().head); return { decision: 'APPROVE', line: '评审通过', report: '评审原文', findings: '[]', head: f.state().head }; },
    joiners: () => ({ list: joiners }),
    'run-merged': () => ({ runs: hooks.map(id => ({ workflow: id, runId: `r-${id}`, state: 'succeeded' })) }),
  });
  return { f, contract, reviews, ...run };
}

test('假宿主走一遍契约开发加自动合并加非空白名单：门禁、带契约的项目检查、当前 head 的整体评审、列出加入者后不出批准卡，合并后只跑白名单里的，结束时 afterMerge 逐项列出、notify 为 true', async t => {
  const { nodes, values, params } = await definition();
  const { f, contract, reviews, visited, cards, context, end } = await autoRun(t, ['deploy'], [{ id: 'deploy', name: '部署', default: false }, { id: 'lint', name: '代码检查', default: true }]);
  const at = id => visited.indexOf(id);
  const steps = ['pr', 'gate', 'checks', 'checks-passed', 'overall-plan', 'overall-call', 'overall-reviewed', 'overall', 'premerge', 'github-checks', 'joiners', 'auto-merge-choice', 'approval-result', 'merge', 'merged-inputs', 'run-merged', 'after-run'];
  assert.deepEqual(visited.filter(id => steps.includes(id)), steps);
  assert.ok(at('gate') < at('checks') && at('github-checks') < at('joiners') && at('joiners') < at('auto-merge-choice'), '门禁在项目检查前，加入者在是否自动合并前');
  assert.ok(!visited.includes('approve') && !cards.some(c => c.step === 'approve'), '不出批准卡');
  assert.equal(end, 'done');
  assert.deepEqual(evaluateTyped(params('checks').inputs.slice(1), context), { contract }, '项目检查带契约');
  assert.deepEqual([reviews.length, reviews[0], f.state().overall.head], [1, f.state().head, f.state().head], '整体评审评在当前 head 上');
  assert.deepEqual(f.state().gate, { head: f.state().head, outside: [], missing: [] });
  assert.deepEqual([context.overall.auto, context['approval-result'].route, context['approval-result'].only], [true, 'merge', '["deploy"]'], '只勾白名单里的，默认勾选的 lint 不跑');
  assert.equal(context['merged-inputs'].only, '["deploy"]');
  assert.ok(f.calls().some(c => c.args[1] === 'merge' && c.args.includes('--match-head-commit') && c.args.includes(f.state().head)), '合并了需求分支 head');
  const out = name => evaluateTyped(values(nodes.done).find(v => v.name === name).value.slice(1), context);
  assert.equal(out('afterMerge'), '合并后的流程已全部结束，不用再等：部署：成功');
  assert.equal(out('notify'), true);
  assert.equal(evaluateTyped(nodes.done.notify.slice(1), context), true);
});

test('假宿主走一遍契约开发加自动合并加空白名单：同样不出批准卡直接合并，没有要跑的合并后流程，结束在「已完成」且 afterMerge 写没有运行', async t => {
  const { nodes, values } = await definition();
  const { f, visited, cards, context, end } = await autoRun(t, [], [{ id: 'lint', name: '代码检查', default: true }]);
  assert.ok(!visited.includes('approve') && !cards.some(c => c.step === 'approve'), '不出批准卡');
  assert.deepEqual(visited.slice(visited.indexOf('approval-result')), ['approval-result', 'after-approval', 'merge', 'after-merge', 'merged-choice'], '合并后直接判定没有要跑的');
  assert.deepEqual([context['approval-result'].route, context['approval-result'].only], ['merge', '[]'], '默认勾选的 lint 也不跑');
  assert.equal(end, 'done-none');
  assert.ok(!visited.includes('run-merged'));
  assert.ok(f.calls().some(c => c.args[1] === 'merge'), '照常合并');
  assert.equal(values(nodes['done-none']).find(v => v.name === 'afterMerge').value, '没有运行合并后的流程，没有什么要再等的');
  assert.equal(nodes['done-none'].status, '已完成，没有要跑的合并后流程');
});
