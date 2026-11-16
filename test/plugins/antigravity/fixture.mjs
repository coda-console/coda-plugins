// A stand-in for `agy acp` that declares the additionalDirectories capability in both spellings, as agy 1.5.9 does, and
// answers a session request with the params it received. It also keeps a mode per session like agy (default, accept-edits,
// auto, plan; anything else is -32602), and has three test-only methods: `fake/mode` has it announce a mode of its own,
// `fake/refuse` has it refuse the next mode change of a session, and `fake/permission` has it ask the client for a
// permission and answer with what comes back.
import { createInterface } from 'node:readline';

const MODES = ['default', 'accept-edits', 'auto', 'plan'];
const modes = new Map();
const asking = new Map();
const refusing = new Set();
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const announce = (sessionId, modeId) => { modes.set(sessionId, modeId); send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } } }); };
const configOptions = sessionId => [{ id: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] },
  { id: 'mode', type: 'select', currentValue: modes.get(sessionId) ?? 'default', options: MODES.map(value => ({ value, name: value })) }];
const sessionResult = (m, sessionId) => {
  modes.set(sessionId, 'default');
  return { sessionId, received: m.params, modes: { currentModeId: 'default', availableModes: MODES.map(id => ({ id, name: id })) }, configOptions: configOptions(sessionId) };
};
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method && asking.has(m.id)) { send({ id: asking.get(m.id), result: { answered: m.result } }); asking.delete(m.id); return; }
  if (!('id' in m)) return;
  const sessionId = m.params?.sessionId;
  if (m.method === 'initialize') {
    const sessionCapabilities = { list: {}, additionalDirectories: {} };
    send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities, session_capabilities: { ...sessionCapabilities } } } });
  } else if (m.method === 'session/new') send({ id: m.id, result: sessionResult(m, `s${modes.size + 1}`) });
  else if (m.method === 'session/load' || m.method === 'session/resume') send({ id: m.id, result: { ...sessionResult(m, sessionId), sessionId: undefined } });
  else if (m.method === 'session/set_mode' || (m.method === 'session/set_config_option' && m.params.configId === 'mode')) {
    const modeId = m.params.modeId ?? m.params.value;
    if (refusing.delete(sessionId) || !MODES.includes(modeId)) { send({ id: m.id, error: { code: -32602, message: `invalid mode ${modeId}` } }); return; }
    announce(sessionId, modeId);
    send({ id: m.id, result: { received: m.params, ...(m.method === 'session/set_config_option' && { configOptions: configOptions(sessionId) }) } });
  } else if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: configOptions(sessionId) } });
  else if (m.method === 'fake/refuse') { refusing.add(sessionId); send({ id: m.id, result: {} }); }
  else if (m.method === 'fake/mode') { announce(sessionId, m.params.modeId); send({ id: m.id, result: {} }); }
  else if (m.method === 'fake/permission') { asking.set(`perm-${m.id}`, m.id); send({ id: `perm-${m.id}`, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't' }, options: m.params.options } }); }
  else send({ id: m.id, result: { received: m.params } });
}).on('close', () => process.exit(0));
