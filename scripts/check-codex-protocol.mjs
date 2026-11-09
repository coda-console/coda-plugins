#!/usr/bin/env node
// Checks that the Codex entry has registered everything its locked Codex's app-server can say (plugins/codex/agent/registry.json,
// unrecognized.mjs): each ThreadItem type, each field of an agent message and each value of those registered one by one, each
// server notification and request. The protocol is the one the plugin's own @openai/codex generates
// (`codex app-server generate-json-schema --experimental`). Fails listing what is not registered; npm test runs it
// (test/plugins/codex/protocol.test.mjs), so a PR that upgrades @openai/codex fails until what the new Codex adds is registered.
// It needs the plugin's dependencies with the Codex binary of this platform (`node scripts/install-plugins.mjs codex`), and
// fails without them.
//
//   node scripts/check-codex-protocol.mjs [<登记表>]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALUED } from '../plugins/codex/agent/unrecognized.mjs';

const plugin = fileURLToPath(new URL('../plugins/codex/', import.meta.url));

const methods = union => union.oneOf.map(each => each.properties.method.enum[0]);
// The strings a schema allows, through references and unions.
const values = (schema, definitions) => schema.$ref ? values(definitions[schema.$ref.split('/').pop()], definitions)
  : [...(schema.enum ?? []), ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap(each => values(each, definitions))].filter(value => typeof value === 'string');

// What the generated protocol can say, by the names of the registry.
export function protocolNames({ notifications, requests, v2 }) {
  const { definitions } = v2, items = definitions.ThreadItem.oneOf;
  const message = items.find(each => each.properties.type.enum[0] === 'agentMessage').properties;
  return [
    ...items.map(each => `item:${each.properties.type.enum[0]}`),
    ...Object.keys(message).filter(field => field !== 'type').map(field => `item:agentMessage.${field}`),
    ...VALUED.flatMap(field => values(message[field], definitions).map(value => `item:agentMessage.${field}=${value}`)),
    ...methods(notifications).map(method => `notification:${method}`),
    ...methods(requests).map(method => `request:${method}`),
  ];
}

// The plugin's locked Codex, its version, and what its app-server can say.
export function codexProtocol() {
  const require = createRequire(join(plugin, 'package.json'));
  let codex;
  try { codex = require.resolve('@openai/codex/bin/codex.js'); }
  catch { throw new Error('plugins/codex 的依赖没装：node scripts/install-plugins.mjs codex'); }
  const { version } = JSON.parse(readFileSync(require.resolve('@openai/codex/package.json'), 'utf8'));
  const out = mkdtempSync(join(tmpdir(), 'codex-protocol-'));
  try {
    try {
      execFileSync(process.execPath, [codex, 'app-server', 'generate-json-schema', '--experimental', '--out', out],
        { env: { ...process.env, CODEX_HOME: out }, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      throw new Error(`锁定的 Codex ${version} 生成不了协议（这个平台的二进制是 @openai/codex 的可选依赖，在 plugins/codex 里 npm ci 时要带上 optional）：${error.stderr?.toString().trim() || error.message}`);
    }
    const read = name => JSON.parse(readFileSync(join(out, name), 'utf8'));
    return { version, names: protocolNames({ notifications: read('ServerNotification.json'), requests: read('ServerRequest.json'), v2: read('codex_app_server_protocol.v2.schemas.json') }) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export const unregistered = (names, registry) => names.filter(name => !Object.hasOwn(registry, name));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? join(plugin, 'agent/registry.json');
  const { version, names } = codexProtocol(), missing = unregistered(names, JSON.parse(readFileSync(path, 'utf8')));
  if (missing.length) {
    console.error(`Codex ${version} 的 app-server 有 ${missing.length} 项没登记，登记进 ${path}（转给 Coda 还是明确不显示，附原因）：\n${missing.join('\n')}`);
    process.exit(1);
  }
  console.log(`Codex ${version} 的 app-server 都登记了（${names.length} 项）`);
}
