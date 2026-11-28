#!/usr/bin/env node
// The `coda/resource@1` record of the「Claude」type, printed once: the way to sign in, and whether the CLI to sign in with is
// there. The quota is not in it: the sessions tell it to Coda as `_coda/quota` (agent/limits.mjs).
import { claudeBinary } from './sign-in.mjs';

console.log(JSON.stringify([{ key: 'limits', spec: { type: 'limits', title: 'Claude', resources: [], signIn: { installed: claudeBinary() !== null, installable: false, input: 'authorizationCode',
  note: '登录保存在这台机器上，供 Claude SDK 使用；额度在会话运行后出现。这台机器若已配置 OAuth token、API key 或云服务商，会话仍优先用那些配置。' } } }]));
