// The interfaces a model service may speak (docs/plugins.md「模型服务」): a closed table. A plugin providing a service names
// one of these (`api`), and so does one choosing services by what it speaks (`modelApis`). Each is a kind of resource of its
// own (model-services.mjs): a service speaking OpenAI's is nothing like one speaking Anthropic's, whoever provides them. The
// node delivers a service with its key where its interface carries it (model-services.mjs), Coda lists its models as a
// client of it would (model-check.mjs), and what an agent is told of calling one is its kind's definition, from here
// (coda-resources explain). A new interface is a row here: the node would not know where its key goes otherwise.
// Each: what it is called and where it is defined; how its clients send a key (`key`) and what else (`also`); how the node
// hands a key on to the service (`delivered`); how it is called and an example, templates of `{base}` (the service's
// address), `{v1}` (that with `/v1` once: Anthropic's clients take the API's root and add `/v1` themselves, and a service
// whose address is its versioned base has it already) and `{model}`.
export const MODEL_PROTOCOLS = {
  'openai-completions': {
    title: 'OpenAI Chat', spec: 'https://platform.openai.com/docs/api-reference/chat',
    description: '讲 OpenAI Chat Completions 接口的服务',
    key: key => ({ Authorization: `Bearer ${key}` }), also: {},
    delivered: key => ({ authorization: `Bearer ${key}` }),
    call: 'POST {base}/chat/completions，body 带 model 与 messages',
    example: `curl -s {base}/chat/completions -H 'Authorization: Bearer coda' -H 'Content-Type: application/json' \\\n  -d '{"model": "{model}", "messages": [{"role": "user", "content": "你好"}]}'`,
  },
  'openai-responses': {
    title: 'OpenAI Responses', spec: 'https://platform.openai.com/docs/api-reference/responses',
    description: '讲 OpenAI Responses 接口的服务',
    key: key => ({ Authorization: `Bearer ${key}` }), also: {},
    delivered: key => ({ authorization: `Bearer ${key}` }),
    call: 'POST {base}/responses，body 带 model 与 input',
    example: `curl -s {base}/responses -H 'Authorization: Bearer coda' -H 'Content-Type: application/json' \\\n  -d '{"model": "{model}", "input": "你好"}'`,
  },
  'anthropic-messages': {
    title: 'Anthropic', spec: 'https://docs.anthropic.com/en/api/messages',
    description: '讲 Anthropic Messages 接口的服务',
    key: key => ({ 'x-api-key': key }), also: { 'anthropic-version': '2023-06-01' },
    // Some of its clients send the key as a bearer token: the node sends it both ways.
    delivered: key => ({ 'x-api-key': key, authorization: `Bearer ${key}` }),
    call: 'POST {v1}/messages，body 带 model、max_tokens 与 messages；带请求头 anthropic-version',
    example: `curl -s {v1}/messages -H 'x-api-key: coda' -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \\\n  -d '{"model": "{model}", "max_tokens": 256, "messages": [{"role": "user", "content": "你好"}]}'`,
  },
};
export const MODEL_APIS = Object.keys(MODEL_PROTOCOLS);
export const isModelApi = api => typeof api === 'string' && Object.hasOwn(MODEL_PROTOCOLS, api);
