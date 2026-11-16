// The sessions of Coda's configuration probes (the protocol's「配置探测」): `session/new` marked `_meta.coda.probe: true`
// opens one in this connection alone, answered from the catalog (catalog.mjs) and never sent to agy. Each has its own copy
// of the catalog's options; switching the model takes that model's whole list. It takes no prompt, cannot be loaded or
// resumed, and goes with the connection.
import { randomUUID } from 'node:crypto';
import { values } from './catalog.mjs';

export const PREFIX = 'coda-probe:';
const INVALID = -32602, UNKNOWN = -32002;
const refuse = (code, message) => ({ error: { code, message } });

// Whether `session/new` params ask for a probe: undefined for an ordinary session, else whether the mark is right (`true`).
export function probeMark(params) {
  const coda = params?._meta?.coda;
  return coda && typeof coda === 'object' && 'probe' in coda ? coda.probe === true : undefined;
}

// `extraMode`: a mode of the entry's own ({ id, name, description }), offered beside agy's.
export class Probes {
  constructor({ extraMode } = {}) { this.extraMode = extraMode; this.sessions = new Map(); }

  // Adds the entry's mode to the mode option and sets it to the session's mode.
  withMode(configOptions, modeId) {
    const mode = configOptions.find(option => option?.category === 'mode' || option?.id === 'mode');
    if (!mode) return configOptions;
    if (this.extraMode && Array.isArray(mode.options)) mode.options.push({ value: this.extraMode.id, name: this.extraMode.name, description: this.extraMode.description });
    if (modeId) mode.currentValue = modeId;
    return configOptions;
  }

  // A new session from the catalog: what `session/new` answers.
  open(catalog) {
    const sessionId = `${PREFIX}${randomUUID()}`, { models, modes, configOptions } = structuredClone(catalog.initial);
    if (this.extraMode && Array.isArray(modes?.availableModes)) modes.availableModes.push({ ...this.extraMode });
    const session = { catalog, models, modes, configOptions: this.withMode(configOptions) };
    this.sessions.set(sessionId, session);
    return structuredClone({ sessionId, ...(models && { models }), ...(modes && { modes }), configOptions: session.configOptions });
  }

  // The answer to a request about a session of this namespace, `{ result }` or `{ error }`; nothing goes to agy.
  handle(method, params) {
    const { sessionId } = params;
    const session = this.sessions.get(sessionId);
    if (!session) return refuse(UNKNOWN, `配置探测会话 ${sessionId} 不存在或已失效`);
    if (method === 'session/load' || method === 'session/resume') return refuse(INVALID, '配置探测会话不能恢复');
    if (method === 'session/prompt') return refuse(INVALID, '配置探测会话不接受 prompt');
    if (method === 'session/close') { this.sessions.delete(sessionId); return { result: {} }; }
    if (method === 'session/set_config_option') return this.configure(session, params);
    if (method === 'session/set_mode') {
      if (!session.modes?.availableModes?.some(mode => mode?.id === params.modeId)) return refuse(INVALID, `没有模式 ${params.modeId}`);
      this.setMode(session, params.modeId);
      return { result: {} };
    }
    return refuse(INVALID, `配置探测会话不支持 ${method}`);
  }

  setMode(session, modeId) {
    if (session.modes) session.modes.currentModeId = modeId;
    for (const option of session.configOptions) if (option?.category === 'mode' || option?.id === 'mode') option.currentValue = modeId;
  }

  configure(session, { configId, value }) {
    const option = session.configOptions.find(o => o?.id === configId);
    if (!option) return refuse(INVALID, `当前模型没有配置项 ${configId}`);
    if (!values(option).includes(value)) return refuse(INVALID, `配置项 ${configId} 没有值 ${value}`);
    if (option.category === 'model') {
      const options = session.catalog.byModel[value];
      if (!options) return refuse(-32603, `模型目录里没有模型 ${value} 的配置`);
      session.configOptions = this.withMode(structuredClone(options), session.modes?.currentModeId);
    } else if (option.category === 'mode' || option.id === 'mode') this.setMode(session, value);
    else option.currentValue = value;
    return { result: { configOptions: structuredClone(session.configOptions) } };
  }

  clear() { this.sessions.clear(); }
}
