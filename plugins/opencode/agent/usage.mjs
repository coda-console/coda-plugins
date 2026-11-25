import { providerId, serviceReference } from './providers.mjs';

// OpenCode's answer to a prompt carries `result.usage` from its ACP usage conversion, where `outputTokens` is `tokens.output`
// alone and the reasoning is only in `thoughtTokens` (and in its `totalTokens`). Coda's four counts treat thinking as
// part of the output (docs/agent-protocol.md「每轮的用量」), so the reasoning is folded into `outputTokens`; `thoughtTokens` stays
// as the breakdown. Only a non-negative safe-integer `outputTokens`, a positive safe-integer `thoughtTokens` and a sum that is still
// a safe integer are folded; any other receipt is forwarded as it is.
export function foldThoughtIntoOutput(message) {
  const usage = message?.result?.usage;
  const { outputTokens, thoughtTokens } = usage ?? {};
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 || !Number.isSafeInteger(thoughtTokens) || thoughtTokens <= 0 ||
    !Number.isSafeInteger(outputTokens + thoughtTokens)) return message;
  return { ...message, result: { ...message.result, usage: { ...usage, outputTokens: outputTokens + thoughtTokens } } };
}

// The model service each session runs its turns on, from the model OpenCode itself says the session has (the `model` option of the
// `configOptions` it answers `session/new`, `session/load` and `session/set_config_option` with, or tells in `config_option_update`;
// its value is `<provider ID>/<model ID>`, the provider ID that of a chosen service: providers.mjs). So a session opened on a service's
// model is known with no request to set it, and one that is refused stays as it was. A prompt takes the model the session has when it
// is sent, and is answered with the usage saying that service (the reference its injected address gives) and the model asked of it, as
// Coda's docs/plugins.md「Coda 的用量记录」 has them; a model of OpenCode's own, or a service address of another shape, says neither.
// Coda ends a session by ending this process; the only requests it sends to end one (`session/delete`, `session/close`, of a probe's
// session) clear it here as well.
export class RequestedModels {
  // `services`: the services chosen (providers.mjs), each its `ref` and `url`.
  constructor(services) { this.services = services; this.sessions = new Map(); this.prompts = new Map(); this.opening = new Map(); }
  fromCoda({ id, method, params }) {
    const sessionId = params?.sessionId;
    if (id === undefined) return;
    if (method === 'session/prompt') this.prompts.set(id, this.sessions.get(sessionId));
    else if (['session/new', 'session/load', 'session/set_config_option'].includes(method)) this.opening.set(id, sessionId);
    else if (method === 'session/close' || method === 'session/delete') this.sessions.delete(sessionId);
  }
  fromAgent(message) {
    const update = message.params?.update;
    if (message.method === 'session/update' && update?.sessionUpdate === 'config_option_update') this.learn(message.params.sessionId, update.configOptions);
    if (!('id' in message) || 'method' in message) return message;
    if (this.opening.has(message.id)) {
      const sessionId = this.opening.get(message.id) ?? message.result?.sessionId;
      this.opening.delete(message.id);
      this.learn(sessionId, message.result?.configOptions);
    }
    if (!this.prompts.has(message.id)) return message;
    const requested = this.prompts.get(message.id), usage = message.result?.usage;
    this.prompts.delete(message.id);
    return requested && usage && typeof usage === 'object' ? { ...message, result: { ...message.result, usage: { ...usage, ...requested } } } : message;
  }
  // The session's model as the options say it (none given: as it was).
  learn(sessionId, configOptions) {
    const value = Array.isArray(configOptions) ? configOptions.find(option => option?.category === 'model')?.currentValue : undefined;
    if (typeof value !== 'string') return;
    const [provider, ...model] = value.split('/');
    const chosen = this.services.find(service => providerId(service.ref) === provider), service = chosen && serviceReference(chosen.url);
    if (service) this.sessions.set(sessionId, { service, asked: model.join('/') });
    else this.sessions.delete(sessionId);
  }
}
