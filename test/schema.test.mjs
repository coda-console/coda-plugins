// The checker's stable v1 schema and the Claude entry's default request parsers must keep Coda's metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemas } from '../check/schema.mjs';

test('stable v1 request schemas preserve Coda metadata and session fields', () => {
  const _meta = { coda: { review: { id: 'r' } }, codaHostSeq: 42 };
  const sessionId = 'session', prompt = [{ type: 'text', text: 'hello', _meta }];
  const session = { cwd: '/tmp', additionalDirectories: ['/tmp/other'], mcpServers: [{ name: 'coda', command: 'node', args: ['shim.mjs'], env: [{ name: 'A', value: 'B' }], _meta }],
    systemPrompt: { mode: 'append', content: prompt }, _meta };
  for (const [schema, params] of [
    [schemas.zInitializeRequest, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false }, _meta: { coda: { unrecognized: {} } } }, _meta }],
    [schemas.zNewSessionRequest, session], [schemas.zLoadSessionRequest, { ...session, sessionId }],
    [schemas.zPromptRequest, { sessionId, prompt, _meta }],
    [schemas.zSetSessionModeRequest, { sessionId, modeId: 'auto', _meta }],
    [schemas.zSetSessionConfigOptionRequest, { sessionId, configId: 'effort', value: 'high', _meta }],
  ]) assert.deepEqual(schema.parse(params), params);
});
