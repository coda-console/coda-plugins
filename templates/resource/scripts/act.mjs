#!/usr/bin/env node
// 资源上按钮的动作（`coda/resource@1` 的 `act` 操作，contributes.protocolImplementations 里的 commands.act）：
// Coda 在点按钮（并确认）后运行它，`{ action, args }` 在标准输入里（args 是按钮带的参数，这个按钮没带，是 {}）。
// 退出码 0 且标准输出是 `{}` 就算成功；失败就退出 1，标准错误的最后一行是按钮旁显示的原因。
// 不认识的动作要让调用失败，不要悄悄成功。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 「记下此刻」：存在插件的状态目录里（CODA_PLUGIN_STATE，跨读取、跨版本保留），记录命令下次运行时读它。
function mark() {
  writeFileSync(join(process.env.CODA_PLUGIN_STATE, 'mark.json'), JSON.stringify({ at: new Date().toISOString() }));
}

const actions = { mark };
const { action } = JSON.parse(readFileSync(0, 'utf8'));
try {
  if (!Object.hasOwn(actions, action)) throw new Error(`不认识的动作：${action}`);
  actions[action]();
  console.log('{}');
} catch (error) { console.error(error.message); process.exitCode = 1; }
