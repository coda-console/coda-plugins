#!/usr/bin/env node
// coda-plugin-check <插件目录> [--agent <id>] [--manifest] [--live] [--prompt "…"]
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { ACP_PROTOCOL_VERSION } from '../check/agent.mjs';
import contract from '../check/coda/contract.json' with { type: 'json' };
import { checkPlugin } from '../check/index.mjs';
import { format } from '../check/report.mjs';

const USAGE = `用法：coda-plugin-check <插件目录> [--agent <id>] [--manifest] [--live] [--prompt "…"]

  清单（总是查）  package.json 能不能被 Coda 读懂，从仓库安装的限制（带 npm 依赖要有 package-lock.json）
  握手（默认查）  照 Coda 的样子启动每个 Agent，发 initialize、session/new（要声明会话指令 systemPrompt）；SIGTERM 后 5 秒内要退出（关标准输入后不退出只提醒）；读每个面板一次
  一轮（--live）  每个 Agent 先问会话指令里的检查词，再发一轮提示词（默认「只回复 ok」）、再发一轮并取消（读到取消后要回 cancelled）、核对 _coda/wait；
                 声明插话的，一轮结束后与一轮进行中各插话一次；声明 loadSession 的再开进程 session/load，并在新进程里再跑一轮

  --agent <id>   只查这一个 Agent（面板不读）
  --manifest     只查清单，什么也不运行
  --live         查一轮：会真的发提示词，可能要登录、花额度
  --prompt "…"   一轮用的提示词`;

let options;
try {
  options = parseArgs({ allowPositionals: true, options: {
    agent: { type: 'string' }, manifest: { type: 'boolean' }, live: { type: 'boolean' }, prompt: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
} catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
const { values, positionals } = options;
if (values.help) { console.log(USAGE); process.exit(0); }
if (positionals.length !== 1 || (values.manifest && values.live)) { console.error(USAGE); process.exit(2); }

// Detached agents and panels, and temporary directories, go with the checker (check/leftovers.mjs).
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
const dir = resolve(positionals[0]);
const { report, plugin } = await checkPlugin(dir, { agent: values.agent ?? null, manifestOnly: !!values.manifest, live: !!values.live, prompt: values.prompt });
const shown = positionals[0];
console.log(format(report, { title: `coda-plugin-check ${pkg.version} · 插件 ${plugin?.id ?? '?'}（${shown}）· 规则是 Coda ${contract.commit.slice(0, 7)} 的代码 · ACP 协议版本 ${ACP_PROTOCOL_VERSION}` }));
console.log('清单照一台刚装好的 Coda 读（只有它自带与默认装的插件）；装进别的 Coda 时，版本或已装的插件不同，以那台「设置 › 插件 › 从仓库添加…」的读取为准。');
process.exit(report.ok ? 0 : 1);
