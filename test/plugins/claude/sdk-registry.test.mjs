// The Claude entry's registry against the SDK it locks (sdk-registry.mjs): an SDK upgrade registers what it brings first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_BLOCKS, MESSAGES, USER_BLOCKS } from '../../../plugins/claude/agent/registry.mjs';
import { declared, unregistered } from './sdk-registry.mjs';

test('every message type and subtype and every content block type the locked SDK declares is registered, each saying why', () => {
  assert.deepEqual(unregistered(), []);
  for (const table of [MESSAGES, ASSISTANT_BLOCKS, USER_BLOCKS])
    for (const [name, { shown, why }] of Object.entries(table)) assert.ok(typeof shown === 'boolean' && why, name);
});

test('one taken out of the registry fails the check, and is named', () => {
  const without = (table, name) => Object.fromEntries(Object.entries(table).filter(([key]) => key !== name));
  assert.deepEqual(unregistered({ MESSAGES: without(MESSAGES, 'system/api_retry'), ASSISTANT_BLOCKS, USER_BLOCKS }), ['MESSAGES：system/api_retry']);
  assert.deepEqual(unregistered({ MESSAGES, ASSISTANT_BLOCKS: without(ASSISTANT_BLOCKS, 'thinking'), USER_BLOCKS }), ['ASSISTANT_BLOCKS：thinking']);
  assert.deepEqual(unregistered({ MESSAGES, ASSISTANT_BLOCKS, USER_BLOCKS: without(USER_BLOCKS, 'tool_result') }), ['USER_BLOCKS：tool_result']);
});

test('the declarations are read however they are written, and what cannot be read fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coda-sdk-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = (name, text) => writeFile(join(dir, name), text);
  await Promise.all(['api.mjs', 'blocks.mjs'].map(name => write(name, '')));
  await write('api.d.mts', `export * from './blocks.mjs';\nexport interface Message { readonly content: Array<Text | Other>; role: 'assistant' }\n`);
  await write('blocks.d.mts', `/** a block */ export interface Text { type: 'text'; text: string; }\nexport type Other = { "type": "other" } & { extra?: number };
    export interface Param { content: string | Block[] }\ntype Block = Text | { type: 'image', source: { data: string } };\n`);
  await write('sdk.d.ts', `import type { Message, Param as UserParam } from './api.mjs';
    export declare type SDKMessage =
      | Assistant // the assistant's
      | User
      | (System & { subtype: 'start' | 'stop' })
      | Result;
    type Assistant = { type: 'assistant'; message: Message; uuid: string };
    interface User extends Base { type: "user"; message: UserParam }
    interface Base { parent_tool_use_id: string | null; handler(input: { a: string; b: number }): Promise<void>; [key: string]: unknown }
    type System = { type: 'system'; /* subtype: 'not this' */ at: () => void };
    type Result = Ok | Failed;
    type Ok = { type: 'result', subtype: 'ok', map: Map<string, { a: 1 }> };
    declare type Failed = { type: 'result'; subtype: 'error_a' | 'error_b'; errors: string[] };\n`);
  assert.deepEqual(declared(join(dir, 'sdk.d.ts')), {
    messages: ['assistant', 'result/error_a', 'result/error_b', 'result/ok', 'system/start', 'system/stop', 'user'],
    assistant: ['other', 'text'], user: ['image', 'text'] });
  await write('open.d.ts', `export type SDKMessage = { type: 'assistant' } | { type: string };\n`);
  assert.throws(() => declared(join(dir, 'open.d.ts')), /读不出 SDK 消息的 type/);
});
