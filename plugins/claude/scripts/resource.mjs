#!/usr/bin/env node
// The `coda/resource@1` record of the「Claude」type, printed once: the resources from what the sessions wrote into this
// plugin's state, and whether the CLI to sign in with is there.
import { join } from 'node:path';
import { ClaudeSessionLimits } from '../agent/limits.mjs';
import { resources } from './quota.mjs';
import { claudeBinary } from './sign-in.mjs';

const limits = new ClaudeSessionLimits({ path: process.env.CODA_PLUGIN_STATE ? join(process.env.CODA_PLUGIN_STATE, 'limits.json') : null });
console.log(JSON.stringify([{ key: 'limits', spec: { type: 'limits', title: 'Claude', ...resources(limits), signIn: { installed: claudeBinary() !== null, installable: false, input: 'authorizationCode',
  note: '登录保存在这台机器上，供 Claude SDK 使用；额度在会话运行后出现。这台机器若已配置 OAuth token、API key 或云服务商，会话仍优先用那些配置。' } } }]));
