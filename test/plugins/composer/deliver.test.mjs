import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/deliver.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/deliver.bpmn', import.meta.url), 'utf8');

function fixture(t, devices = true) {
  const root = mkdtempSync(join(tmpdir(), 'composer-deliver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'run-1', GITHUB_OUTPUT: join(root, 'outputs'), TITLE: '交付 输入框', DEVICES: String(devices), FIXTURE: root,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const commit = (file, content) => {
    writeFileSync(join(work, file), content); git('add', file); git('commit', '-qm', content);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('base', 'base');
  env.GITHUB_SHA = base;
  git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  const members = [{ url: 'https://github.com/example/coda-plugins/pull/1', headRefOid: 'a'.repeat(40), headRefName: 'lane/plugin', baseRefName: 'main' }];
  const member = (id, file, content) => {
    const branch = `lane/feature-${id}`;
    git('switch', '-C', branch, base);
    const head = commit(file, content);
    git('push', '-q', 'origin', branch);
    const pr = { url: `https://github.com/example/coda/pull/${id}`, headRefOid: head, headRefName: branch, baseRefName: 'main' };
    members.push(pr);
    return pr;
  };
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!${process.execPath}\n` + String.raw`
const { readFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
appendFileSync(join(root, 'calls'), JSON.stringify(args) + '\n');
if (process.env.GH_EXIT) { console.error('gh query failed'); process.exit(Number(process.env.GH_EXIT)); }
if (args[0] === 'repo') console.log(JSON.stringify({ nameWithOwner: 'example/coda', defaultBranchRef: { name: 'main' } }));
else console.log(JSON.stringify(JSON.parse(readFileSync(join(root, 'members'), 'utf8')).find(pr => pr.url === args[2])));
`);
  chmodSync(gh, 0o755);
  writeFileSync(join(root, 'calls'), '');
  let step = 0;
  const run = (action, extra = {}, expected = 0) => {
    // 每步换一个工作区，只有产物和远端分支保留，覆盖重验收时的重新集成。
    const cwd = join(root, `step-${++step}`);
    git('clone', '-q', '--no-hardlinks', '-b', 'main', origin, cwd);
    writeFileSync(env.GITHUB_OUTPUT, '');
    writeFileSync(join(root, 'members'), JSON.stringify(members));
    const result = spawnSync(process.execPath, [script, action], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    rmSync(cwd, { recursive: true, force: true });
    return { ...result, outputs };
  };
  const answer = (action, choice, note, extra = {}) => run(action, { RESPONSE: JSON.stringify({ choice, note }), ...extra }).outputs;
  const confirm = () => answer('confirm', 'start', members.map(pr => pr.url).join('\n'));
  const state = () => JSON.parse(readFileSync(join(artifacts, 'deliver.json'), 'utf8'));
  const calls = () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  run('init');
  return { root, work, git, commit, base, members, member, run, answer, confirm, state, calls };
}

test('交付按成员顺序记录快照，仅集成本仓库 head，从最新 base 建预览分支并推送', t => {
  const f = fixture(t);
  const one = f.member(2, 'one', 'one'), two = f.member(3, 'two', 'two');
  f.git('switch', 'main');
  const latest = f.commit('latest', 'latest'); f.git('push', '-q', 'origin', 'main');
  const confirmed = f.confirm();
  assert.equal(confirmed.route, 'integrate'); assert.equal(confirmed.round, '1'); assert.equal(confirmed.commit, two.headRefOid);
  assert.deepEqual(f.state().members, f.members);
  assert.equal(confirmed.members, f.members.map(pr => pr.url).join('\n'));
  assert.deepEqual(f.calls(), [
    ...f.members.map(pr => ['pr', 'view', pr.url, '--json', 'url,headRefOid,headRefName,baseRefName']),
    ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'],
  ]);
  // 确认后成员分支又前进，集成仍使用已记录的 head。
  f.git('switch', two.headRefName); f.commit('unconfirmed', 'unconfirmed'); f.git('push', '-q', 'origin', two.headRefName);
  const integrated = f.run('integrate').outputs;
  assert.equal(integrated.branch, 'delivery/run-1');
  assert.equal(f.git('ls-remote', 'origin', integrated.branch).split('\t')[0], integrated.head);
  f.git('fetch', 'origin', integrated.branch);
  const parents = f.git('rev-list', '--parents', '-n', '1', integrated.head).split(' ');
  assert.equal(parents[2], two.headRefOid);
  assert.equal(f.git('rev-parse', `${parents[1]}^2`), one.headRefOid);
  assert.equal(f.git('rev-parse', `${parents[1]}^1`), latest);
  assert.equal(f.git('ls-tree', '--name-only', integrated.head), 'base\nlatest\none\ntwo');
  assert.equal(f.run('context').outputs.feedback, '');
});

test('设备退回后刷新成员，从新工作区重建同一个交付分支，去掉被替换的 head', t => {
  const f = fixture(t);
  const member = f.member(2, 'one', 'old');
  f.confirm(); const first = f.run('integrate').outputs;
  assert.equal(f.answer('preview', 'installed').route, 'device');
  assert.equal(f.answer('device', 'no', '按钮没有响应').route, 'confirm');
  assert.equal(f.run('context').outputs.feedback, '按钮没有响应');
  f.git('switch', '-C', member.headRefName, f.base);
  member.headRefOid = f.commit('one', 'fixed'); f.git('push', '-q', '--force', 'origin', member.headRefName);
  assert.equal(f.confirm().round, '2');
  const second = f.run('integrate').outputs;
  assert.equal(second.branch, first.branch); assert.notEqual(second.head, first.head);
  f.git('fetch', 'origin', second.branch);
  assert.equal(f.git('show', `${second.head}:one`), 'fixed');
  assert.equal(f.git('rev-parse', `${second.head}^2`), member.headRefOid);
  assert.equal(f.answer('device', 'yes').route, 'report');
});

test('用户开启时主 Agent 写的需求：第一行需求名，其后是目标；验收不行只附截图也算附言', t => {
  const f = fixture(t);
  const brief = note => f.answer('brief', 'start', note);
  assert.deepEqual(brief('输入框\n\n能正常输入，Mac 与 iPhone 都通过'), { feedback: '', route: 'init', title: '输入框', goal: '能正常输入，Mac 与 iPhone 都通过' });
  for (const note of ['只有需求名', '']) assert.equal(brief(note).route, 'brief', note);
  assert.deepEqual(f.run('init', { TITLE: '输入框', GOAL: '能输入' }).outputs, { title: '输入框', goal: '能输入' });
  f.member(2, 'one', 'old'); f.confirm(); f.run('integrate');
  const shot = f.run('device', { RESPONSE: JSON.stringify({ choice: 'no', note: '', attachments: ['/uploads/a/shot.png'] }) }).outputs;
  assert.equal(shot.route, 'confirm');
  assert.equal(f.run('context').outputs.feedback, '附件：\n- /uploads/a/shot.png');
});

test('集成冲突保留具体原因并失败，返回确认后可以修复重集成', t => {
  const f = fixture(t);
  f.member(2, 'base', 'first'); const two = f.member(3, 'base', 'second');
  f.confirm();
  const failed = f.run('integrate', {}, 1);
  assert.match(failed.stdout, /CONFLICT/);
  const feedback = f.run('context').outputs.feedback;
  assert.ok(feedback.includes(two.url)); assert.match(feedback, /CONFLICT/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/delivery/*'), '');
  f.members.pop(); f.confirm();
  assert.ok(f.run('integrate').outputs.head);
});

test('无设备验收直接写汇报，必填备注返回原卡，批准退回与最终结论保留原文', t => {
  const f = fixture(t, false);
  f.member(2, 'one', 'one');
  assert.equal(f.confirm().route, 'report');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/delivery/*'), '');
  for (const [action, choice] of [['confirm', 'start'], ['preview', 'confirm'], ['device', 'no'], ['report', 'ready'], ['approval', 'stop'], ['merged', 'merged'], ['verify', 'no']]) {
    for (const note of [undefined, '', '  ']) {
      const result = f.answer(action, choice, note);
      assert.equal(result.route, action); assert.match(result.feedback, /必须填写备注/);
    }
  }
  assert.equal(f.answer('preview', 'confirm', '安装失败').route, 'confirm');
  assert.equal(f.run('context').outputs.feedback, '安装失败');
  const body = '交付：输入框\n交付了什么：支持交付\nEOF_body\nPR：链接';
  assert.equal(f.answer('report', 'ready', body).body, body);
  assert.equal(f.answer('approval', 'stop', '需要补充说明').route, 'confirm');
  assert.equal(f.run('context').outputs.feedback, '需要补充说明');
  assert.equal(f.answer('approval', 'merge').route, 'release');
  assert.equal(f.answer('merged', 'merged', `  ${'f'.repeat(40)}\n`).commit, 'f'.repeat(40));
  assert.equal(f.answer('verify', 'no', '真实环境仍有问题').route, 'done');
  assert.equal(f.state().feedback, '真实环境仍有问题');
  assert.equal(f.answer('verify', 'yes').route, 'done');
  const count = f.calls().length;
  assert.equal(f.answer('confirm', 'stop').route, 'stop');
  assert.equal(f.calls().length, count, '放弃不读取成员 PR');
});

test('只有插件成员时使用 coda 默认 base；gh 查询失败直接失败', t => {
  const f = fixture(t);
  assert.equal(f.confirm().commit, f.base);
  assert.equal(f.run('integrate').outputs.head, f.base);
  const result = f.run('confirm', { RESPONSE: JSON.stringify({ choice: 'start', note: f.members[0].url }), GH_EXIT: '2' }, 2);
  assert.match(result.stderr, /gh query failed/);
});

test('需求流程回路、人工任务、结果通知和合并后的流程契约', async () => {
  const { root, problem } = await readWorkflow(workflow, 'deliver'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const acceptance = process.flowElements.find(e => e.id === 'acceptance');
  // 卡片上只在走进验收后才有这一段，没开设备验收的运行照常按步骤画进度。
  assert.equal(acceptance.optional, true);
  const elements = [...process.flowElements, ...acceptance.flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  // 用户在会话里开启时什么都不必填：需求名与目标由主 Agent 写。
  assert.deepEqual(values(process).map(v => [v.name, v.required, v.default]), [['title', undefined, ''], ['devices', undefined, 'false'], ['device', undefined, '']]);
  assert.equal(values(process)[1].type, 'boolean');
  // 目标是发起时带的需求文字（run.message），需求名和它缺一样就先交主 Agent 写。
  for (const [title, message, target] of [['', '', 'brief'], ['输入框', '', 'brief'], ['', '能输入', 'brief'], ['输入框', '能输入', 'init']]) {
    assert.equal(route('brief-choice', { inputs: { title }, run: { message } }), target, `${title}|${message}`);
  }
  for (const [value, target] of [['brief', 'brief'], ['init', 'init']]) assert.equal(route('after-brief', { 'brief-result': { route: value } }), target);
  assert.deepEqual([nodes.brief.wake, nodes.brief.assignee], ['false', undefined]);
  assert.deepEqual(values(nodes.brief).map(v => [v.id, v.note]), [['start', 'required']]);
  // 成员怎样发起写在任务里：Ultra 不再讲开发流程。
  for (const text of ['workflow_run 发起 develop', '传 title、message（这个仓库要做的部分与完成标准）', 'delivery="{{run.id}}"', 'devices=false', 'project', '需求进行中', '泳道 PR', '确认达标', '待交付']) assert.ok(nodes.brief.documentation[0].text.includes(text), text);
  assert.doesNotMatch(workflow, /task（|executor/, '成员是需求运行，执行者由各泳道 PR 定');
  assert.doesNotMatch(nodes.brief.documentation[0].text, /goal/);
  for (const [field, written] of [['TITLE', 'title'], ['GOAL', 'goal']]) {
    const expression = params('init')[field].slice(1);
    for (const [title, message] of [['', ''], ['输入框', ''], ['', '能输入']]) {
      assert.equal(evaluate(expression, { inputs: { title }, run: { message }, 'brief-result': { [written]: '写的' } }).value, '写的');
    }
    assert.equal(evaluate(expression, { inputs: { title: '输入框' }, run: { message: '能输入' } }).value, field === 'TITLE' ? '输入框' : '能输入');
  }
  assert.deepEqual(values(nodes.device).map(v => [v.id, v.note]), [['yes', undefined], ['no', 'required']]);
  assert.deepEqual(values(nodes.approve).map(v => [v.id, v.note]), [['merge', undefined], ['stop', 'required']]);
  assert.equal(nodes.start.eventDefinitions, undefined);
  for (const id of ['confirm', 'preview', 'report', 'release', 'verify']) assert.equal(nodes[id].assignee, undefined);
  for (const id of ['device', 'approve']) assert.equal(nodes[id].assignee, 'user');
  for (const [id, result, paths] of [
    ['after-confirm', 'confirm-result', { confirm: 'context', stop: 'stopped', report: 'report', integrate: 'integrate' }],
    ['after-preview', 'preview-result', { preview: 'preview', confirm: 'acceptance-return', device: 'device' }],
    ['after-device', 'device-result', { device: 'device', confirm: 'acceptance-return', report: 'acceptance-passed' }],
    ['after-report', 'report-result', { report: 'report', approve: 'joiners' }],
    ['approval-note', 'approval-result', { approval: 'approve', confirm: 'after-approval', release: 'after-approval' }],
    ['after-approval', 'approval-result', { confirm: 'context', release: 'release' }],
    ['after-verify', 'verify-result', { verify: 'verify', done: 'tell-result' }],
  ]) for (const [value, target] of Object.entries(paths)) assert.equal(route(id, { [result]: { route: value } }), target);
  assert.equal(nodes['integration-failed'].attachedToRef.id, 'integrate');
  assert.equal(nodes['integration-failed'].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  assert.equal(nodes['integration-feedback'].targetRef.id, 'context');
  assert.match(nodes.confirm.documentation[0].text, /退回修改/);
  assert.match(nodes.preview.documentation[0].text, /只装改到的那一端：改了 Mac 用 workflow_run 发起 mac-preview-install，改了 iPhone 发起 ios-preview-install/);
  assert.match(nodes.preview.documentation[0].text, /commit="\{\{integrate.head\}\}"/);
  const report = nodes.report.documentation[0].text;
  for (const text of ['15 行', '3～5 条', '结构变化', '验证', '需要你知道', '不放执行者原文、测试数量、文件清单']) assert.ok(report.includes(text));
  // 批准卡只有数据：汇报和成员 PR；勾选项是项目在本项目合并提交上加入挂点 merged 的流程。
  assert.equal(nodes.approve.documentation[0].text, '{{report-result.body}}\n\n成员 PR：\n{{confirm-result.members}}\n{{if approval-result.route = "approval" then approval-result.feedback else ""}}');
  assert.equal(nodes.joiners.action, 'hook-joiners');
  assert.deepEqual(params('joiners'), { hook: 'merged', commit: '=confirm-result.commit' });
  assert.equal(nodes['joiners-approve'].targetRef.id, 'approve');
  assert.deepEqual(values(nodes.approve)[0].options.map(o => [o.$type, o.value]), [['coda:OptionList', '=joiners.list']]);
  const envs = id => Object.fromEntries(values(nodes[id]).filter(v => v.$type === 'coda:Env').map(v => [v.name, v.value]));
  assert.deepEqual(envs('approval-result'), { RESPONSE: '=approve', JOINERS: '=joiners.list' });
  for (const id of ['kinds', 'write-notes', 'notes-result', 'deploy', 'publish-preview', 'publish-release']) assert.ok(!nodes[id], id);
  const release = nodes.release.documentation[0].text;
  assert.match(release, /被依赖的仓库在前[\s\S]*合并并发布新版本[\s\S]*更新钉定的包版本[\s\S]*检查通过[\s\S]*最后放行依赖方成员/);
  assert.match(release, /退回修改/);
  assert.match(release, /没有本仓库成员时写本项目当前目标分支提交/);
  assert.match(nodes.confirm.documentation[0].text, /交付并部署它的项目/);
  assert.match(nodes.confirm.documentation[0].text, /被依赖的仓库在前/);
  assert.doesNotMatch(release + nodes.confirm.documentation[0].text, /coda 项目|coda-plugins|npm|coda 成员/);
  // 全部合并后：备注没写回到放行合并；只跑勾了的，没写的文字先交主 Agent 逐项写，之后真实环境验证。
  assert.equal(route('merged-choice', { merged: { route: 'merged' }, 'approval-result': { only: '["deploy"]', missing: '' } }), 'release');
  for (const only of ['[]', '["deploy","publish-preview"]']) for (const missing of ['', 'notes']) {
    const visited = [], context = { merged: { route: 'deploy' }, 'approval-result': { only, missing }, 'merged-inputs': { only } };
    for (let step = 'merged-choice'; step !== 'verify';) {
      const node = nodes[step];
      if (!node.$type.endsWith('Gateway')) visited.push(step);
      step = node.$type === 'bpmn:ExclusiveGateway' ? route(step, context) : process.flowElements.find(e => e.sourceRef === node).targetRef.id;
    }
    assert.deepEqual(visited, [...(missing ? ['fill'] : []), 'merged-inputs', ...(only === '[]' ? [] : ['run-merged'])], `${only}|${missing}`);
  }
  const loop = nodes.fill.loopCharacteristics;
  assert.deepEqual([loop.isSequential, loop.inputElement], [true, 'input']);
  assert.deepEqual(evaluate(loop.inputCollection.slice(1), { 'approval-result': { missing: 'notes' } }).value, ['notes']);
  assert.equal(nodes.fill.assignee, undefined, '交主 Agent');
  assert.deepEqual(values(nodes.fill).map(v => [v.id, v.note]), [['done', 'required'], ['skip', undefined]]);
  assert.deepEqual(envs('merged-inputs'), { INPUTS: '=approval-result.inputs', MISSING: '=approval-result.missing', ASKS: '=approval-result.asks', FILLS: '=fill', NEEDS: '=approval-result.needs', ONLY: '=approval-result.only', JOINERS: '=joiners.list' });
  assert.equal(route('left', { 'merged-inputs': { only: '["deploy"]' } }), 'run-merged');
  assert.deepEqual(params('run-merged'), { hook: 'merged', only: '=merged-inputs.only', commit: '=merged.commit', inputs: '=merged-inputs.inputs' });
  assert.deepEqual(process.flowElements.filter(e => e.action === 'run-workflows').map(e => e.id), ['run-merged']);
  assert.deepEqual(process.flowElements.filter(e => e.action === 'tell-session').map(e => e.id), ['tell-result']);
  assert.equal(params('tell-result').session, undefined);
  assert.equal(nodes['approval-route'].sourceRef.id, 'approval-note');
  assert.equal(nodes['approval-route'].targetRef.id, 'after-approval');
  const context = { init: { title: '输入框' }, run: { id: 'run-1' }, 'confirm-result': { round: '2' }, merged: { commit: 'merged-head' } };
  const message = (id, field, extra) => {
    const result = evaluate(params(id)[field].slice(1), { ...context, ...extra });
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
    return result.value;
  };
  for (const ran of [false, true]) for (const yes of [false, true]) {
    const extra = { 'merged-inputs': ran ? { only: '["deploy"]', picked: '部署' } : { only: '[]', picked: '' }, verify: { chose: { yes }, note: '实际验证结论' } };
    assert.equal(message('tell-result', 'text', extra), `需求「输入框」：${ran ? '已运行部署' : '没有运行合并后的流程'}，真实环境验证${yes ? '通过。' : '有问题。'}\n实际验证结论\n提交：merged-head`);
    assert.equal(message('tell-result', 'key', extra), 'run-1:verified:merged-head');
  }
  assert.equal(nodes['result-done'].targetRef.id, 'done');
});

test('批准交付记下勾了哪些合并后的流程与没写的文字；主 Agent 补写的并进 inputs', t => {
  const f = fixture(t, false);
  const joiners = JSON.stringify([
    { id: 'deploy', name: '部署', default: false },
    { id: 'publish-release', name: '发布正式版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
  ]);
  const approve = (options, inputs = {}) => f.run('approval', { RESPONSE: JSON.stringify({ choice: 'merge', options, inputs }), JOINERS: joiners }).outputs;
  assert.deepEqual(approve({ deploy: false, 'publish-release': false }), { feedback: '', route: 'release', only: '[]', picked: '', inputs: '{}', missing: '', asks: '', needs: '{}' });
  assert.deepEqual(approve({ deploy: true, 'publish-release': true }), { feedback: '', route: 'release', only: '["deploy","publish-release"]', picked: '部署、发布正式版', inputs: '{}', missing: 'notes', asks: '「发布说明」：发布正式版要', needs: '{"notes":["publish-release"]}' });
  assert.deepEqual(approve({ deploy: false, 'publish-release': true }, { notes: '新版说明' }).inputs, '{"notes":"新版说明"}');
  assert.deepEqual(f.run('inputs', { INPUTS: '{}', MISSING: 'notes', ASKS: '「发布说明」：发布正式版要', FILLS: JSON.stringify([{ result: 'completed', note: '主 Agent 的说明' }]),
    NEEDS: '{"notes":["publish-release"]}', ONLY: '["deploy","publish-release"]', JOINERS: joiners }).outputs, { inputs: '{"notes":"主 Agent 的说明"}', only: '["deploy","publish-release"]', picked: '部署、发布正式版' });
  assert.match(f.run('inputs', { INPUTS: '{}', MISSING: 'notes', ASKS: '「发布说明」：发布正式版要', FILLS: JSON.stringify([{ result: 'completed', note: ' ' }]) }, 1).stderr, /「发布说明」：发布正式版要：没有填写/);
});

// 主 Agent 选「这一项这次不跑」：要这段文字的加入者全部从 only 里去掉，其余照跑；一个不剩就不进 run-merged，直接进真实环境验证。
async function afterSkip(t, ticked, fills) {
  const f = fixture(t, false);
  const joiners = JSON.stringify([
    { id: 'deploy', name: '部署', default: false },
    { id: 'publish-preview', name: '发布预览版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
    { id: 'publish-release', name: '发布正式版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
  ]);
  const options = Object.fromEntries(ticked.map(id => [id, true]));
  const approval = f.run('approval', { RESPONSE: JSON.stringify({ choice: 'merge', options, inputs: {} }), JOINERS: joiners }).outputs;
  const merged = f.run('inputs', { INPUTS: approval.inputs, MISSING: approval.missing, ASKS: approval.asks, NEEDS: approval.needs, ONLY: approval.only, JOINERS: joiners, FILLS: JSON.stringify(fills) }).outputs;
  const { root, problem } = await readWorkflow(workflow, 'deliver'); assert.ok(!problem, problem);
  const flow = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const elements = [...flow.flowElements, ...flow.flowElements.find(e => e.id === 'acceptance').flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e])), context = { merged: { route: 'deploy' }, 'approval-result': approval, 'merged-inputs': merged }, visited = [];
  for (let step = 'merged-choice'; step !== 'verify';) {
    const node = nodes[step], flows = elements.filter(e => e.sourceRef === node);
    if (!node.$type.endsWith('Gateway')) visited.push(step);
    step = (node.$type === 'bpmn:ExclusiveGateway'
      ? flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value)?.targetRef ?? node.default.targetRef
      : flows[0].targetRef).id;
  }
  const shown = (text, extra) => evaluate(text, { init: { title: '输入框' }, merged: { commit: 'merged-head' }, verify: { chose: { yes: true }, note: '' }, 'merged-inputs': merged, ...extra });
  const verifyText = shown(/\{\{(if merged-inputs[\s\S]*?)\}\}/.exec(nodes.verify.documentation[0].text)[1]).value;
  const toldText = shown(nodes['tell-result'].extensionElements.values.find(v => v.name === 'text').value.slice(1)).value;
  return { visited, merged, verifyText, toldText };
}

test('批准交付后：主 Agent 选「这一项这次不跑」，要这段文字的加入者都不跑，其余照跑，接着真实环境验证', async t => {
  const skipped = await afterSkip(t, ['deploy', 'publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.deepEqual([skipped.merged.only, skipped.merged.inputs, skipped.visited], ['["deploy"]', '{}', ['fill', 'merged-inputs', 'run-merged']]);
  assert.match(skipped.verifyText, /已运行合并后的流程：部署。/);
  assert.match(skipped.toldText, /已运行部署，真实环境验证通过。/);
  for (const text of [skipped.verifyText, skipped.toldText]) assert.doesNotMatch(text, /发布/);
});

test('批准交付后：勾了的都被「这一项这次不跑」去掉，不进 run-merged，直接真实环境验证', async t => {
  const skipped = await afterSkip(t, ['publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.deepEqual([skipped.merged.only, skipped.visited], ['[]', ['fill', 'merged-inputs']]);
  assert.match(skipped.verifyText, /^没有运行合并后的流程/);
  assert.match(skipped.toldText, /需求「输入框」：没有运行合并后的流程，真实环境验证通过。/);
  for (const text of [skipped.verifyText, skipped.toldText]) assert.doesNotMatch(text, /发布|已运行/);
});
