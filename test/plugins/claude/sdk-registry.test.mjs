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

test('the checker\'s reading: a union of aliases, intersections and imported blocks; a type or subtype not string literals fails, named', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coda-sdk-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = (name, text) => writeFile(join(dir, name), text);
  await write('blocks.d.ts', `export type Block = { type: 'text'; text: string } | { type: 'image' };\n`);
  await write('sdk.d.ts', `import type { Block } from './blocks.js';
    type Assistant = { type: 'assistant'; message: { content: Block[] } };
    type User = { type: 'user'; message: { content: string | Array<Block | { type: 'tool_result' }> } };
    type System = { type: 'system' } & { subtype: 'start' | 'stop' };
    export type SDKMessage = Assistant | User | System;
    export type Open = { type: 'system'; subtype: string };\n`);
  assert.deepEqual(declared(join(dir, 'sdk.d.ts')), { messages: ['assistant', 'system/start', 'system/stop', 'user'],
    assistant: ['image', 'text'], user: ['image', 'text', 'tool_result'] });
  await write('open.d.ts', `import type { SDKMessage as Known, Open } from './sdk.js';\nexport type SDKMessage = Known | Open;\n`);
  assert.throws(() => declared(join(dir, 'open.d.ts')), { message: 'Open 的 subtype 不全是字符串字面量：string' });
});
