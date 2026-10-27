import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLines } from './lines.mjs';
import { configObject, literalJSON } from './providers.mjs';

export function shellEnvironment(env, socket) {
  const config = configObject(env.OPENCODE_CONFIG_CONTENT || '{}');
  const source = config.get('plugins') ?? '[]';
  const variable = /^\{env:([^}]+)\}$/.exec(source);
  const value = variable ? env[variable[1]] || '' : source;
  const array = configObject(`{"plugins":${value}}`, !!variable).get('plugins');
  if (!array?.startsWith('[')) throw new SyntaxError('OPENCODE_CONFIG_CONTENT 的 plugins 必须是数组');
  const plugin = { package: fileURLToPath(new URL('../runtime', import.meta.url)), options: { socket } };
  const appended = `${array.slice(0, -1)}${array.length > 2 ? ',' : ''}${literalJSON(plugin)}]`;
  if (!variable) return { ...env, OPENCODE_CONFIG_CONTENT: config.set('plugins', appended) };
  // Preserve OpenCode's single env interpolation pass, including literal escaped braces in existing config.
  const name = `CODA_OPENCODE_SHELL_PLUGINS_${process.pid}`;
  return { ...env, [name]: appended, OPENCODE_CONFIG_CONTENT: config.set('plugins', `{env:${name}}`) };
}

// A per-process Unix socket inside a mode-0700 temporary directory, not a listening HTTP service or a global config.
// Only the native plugin loaded into this CLI receives its path. The wire has no command execution facility.
export async function shellChannel({ event, register, disconnected }) {
  const directory = await mkdtemp(join(tmpdir(), 'coda-oc-'));
  const socket = join(directory, 'events.sock'), connections = new Set();
  const server = createServer(connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.on('close', () => { connections.delete(connection); disconnected(connection); });
    readLines(connection).on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'event') event(m.event, connection);
      if (m.type === 'background' && Number.isSafeInteger(m.id)) {
        const accepted = register(m, connection);
        connection.write(`${JSON.stringify({ id: m.id, accepted })}\n`);
      }
    });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { socket, interrupt(source, sessionId) {
    if (connections.has(source)) source.write(`${JSON.stringify({ type: 'interrupt-handling', sessionId })}\n`);
  }, async close() {
    for (const connection of connections) connection.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  } };
}
