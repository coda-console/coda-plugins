// 好友签名网关的记录格式：三种签名记录（授权 friends/rpc-grant、调用请求 friends/rpc-call、回答 friends/rpc-answer）的正文构造与校验、
// 请求号与回答 id 与内核幂等键的派生、请求摘要、重放窗口、exec 输入的重建、按字节算的大小上限与回答截短。纯函数，不碰盘、不碰 Coda。
// 校验的结果一律是 `{ ok: true, ... }` 或 `{ ok: false, code }`：码是稳定的，持有方与调用方会把它记进操作记录。
import { createHash } from 'node:crypto';

export const KIND_GRANT = 'friends/rpc-grant', KIND_CALL = 'friends/rpc-call', KIND_ANSWER = 'friends/rpc-answer';
export const RPC_PREFIX = 'friends/rpc-';
export const RPC_KINDS = Object.freeze([KIND_GRANT, KIND_CALL, KIND_ANSWER]);
export const PROTOCOL = 'remote-exec/machine@1';

/** kind 是否落在保留的 `friends/rpc-` 前缀下（不论是不是三种之一）。 */
export const isRpcKind = kind => typeof kind === 'string' && kind.startsWith(RPC_PREFIX);

const MINUTE = 60_000;
export const MAX_WINDOW_MS = 11 * MINUTE, FUTURE_SKEW_MS = 2 * MINUTE, CLOCK_BACK_MS = 5 * MINUTE;
// 整条签名记录上限 64 KiB：请求正文至多 56 KiB，回答正文至多 60 KiB，余下留给签名与证书。
// 请求的 56 KiB 按「可取消」算：取消版本是同一正文另加 cancel、canceledAt，所以按带着这两项（canceledAt 取最长）的大小量，
// 最大的那条请求也一定发得出取消版本。
export const MAX_CALL_BYTES = 56 * 1024, MAX_ANSWER_BYTES = 60 * 1024;

const AUTHOR = /^ed25519:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST = /^c[0-9a-f]{32}$/, ANSWER = /^a[0-9a-f]{32}$/, DIGEST = /^[0-9a-f]{64}$/;
const STATES = ['running', 'completed', 'failed', 'canceled'];

const sha256 = text => createHash('sha256').update(text).digest('hex');
const bytesOf = value => Buffer.byteLength(JSON.stringify(value));
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isText = value => typeof value === 'string';

export const isAuthor = value => isText(value) && AUTHOR.test(value);

/**
 * 本机此刻替调用请求（friends/rpc-call）署名的作者（`coda/accord@1` 的 local 记录）：`{ author, person, canSign }`。
 * `status.certificate` 为 null 是没绑个人身份的后端，作者是机器钥匙，没有有效期，能签；是对象是个人作者（根），证书 `active` 才能签；
 * 其余（作者不是合法公钥、没写证书这个键）不能签。社交功能照旧看 friends.mjs 的 certStateOf。
 */
export function signerOf(accord) {
  const author = isAuthor(accord?.spec?.author) ? accord.spec.author : null, status = accord?.status;
  const certificate = isPlain(status) && Object.hasOwn(status, 'certificate') ? status.certificate : undefined;
  if (author && certificate === null) return { author, person: false, canSign: true };
  if (author && isPlain(certificate)) return { author, person: true, canSign: certificate.active === true };
  return { author, person: false, canSign: false };
}

/**
 * 本机自己的机器钥匙（授权记录与回答用它签，`coda/accord@1.publish` 的 `signer: "machine"`）：绑了个人身份是 `status.certificate.key`，
 * 没绑（`status.certificate` 为 null）就是 `spec.author`。与证书是否有效无关；读不出给 null。
 */
export function machineOf(accord) {
  const status = accord?.status;
  const certificate = isPlain(status) && Object.hasOwn(status, 'certificate') ? status.certificate : undefined;
  const machine = certificate === null ? accord?.spec?.author : certificate?.key;
  return isAuthor(machine) ? machine : null;
}

// ---- 派生 ----

/** 请求号：`c` + sha256("friends/rpc-call\0" + 调用内核的调用号) 的前 32 位十六进制。 */
export const requestId = ctxId => `c${sha256(`${KIND_CALL}\0${ctxId}`).slice(0, 32)}`;
/** 回答 id：`a` + sha256("friends/rpc-answer\0" + 调用方作者 + "\0" + 请求号) 的前 32 位；两位好友用了同一个请求号也不会撞。 */
export const answerId = (caller, request) => `a${sha256(`${KIND_ANSWER}\0${caller}\0${request}`).slice(0, 32)}`;
/** 持有方子调用的内核幂等键：`friend:` + sha256(调用方作者 + "\0" + 请求号) 的前 32 位。 */
export const idempotencyKey = (caller, request) => `friend:${sha256(`${caller}\0${request}`).slice(0, 32)}`;

// ---- 摘要 ----

// 对象键递归按字典序排，再取 JSON：键序不同的同一内容写法相同。
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export const canonicalJson = value => JSON.stringify(canonical(value));

/** 请求的摘要：去掉 `cancel`、`canceledAt` 之后正文的规范 JSON 的 sha256（十六进制），所以同一请求的取消版本与原版摘要相同。 */
export function requestDigest(body) {
  const { cancel, canceledAt, ...rest } = body;
  return sha256(canonicalJson(rest));
}

// ---- 重放窗口与时钟 ----

/**
 * 两端共用的重放窗口：`0 < expiresAt − createdAt ≤ 11 分钟`、`createdAt ≤ 现在 + 2 分钟`、`现在 < expiresAt`。
 * 码：`window_span`（跨度不合）、`window_future`（创建时刻在未来太远）、`window_expired`（已过期）。
 */
export function replayWindow(createdAt, expiresAt, now) {
  if (!isTime(createdAt) || !isTime(expiresAt) || !isTime(now)) return { ok: false, code: 'window_span' };
  const span = expiresAt - createdAt;
  if (span <= 0 || span > MAX_WINDOW_MS) return { ok: false, code: 'window_span' };
  if (createdAt > now + FUTURE_SKEW_MS) return { ok: false, code: 'window_future' };
  if (now >= expiresAt) return { ok: false, code: 'window_expired' };
  return { ok: true };
}

/** 本机时钟回拨：现在比见过的最大时刻早 5 分钟以上。 */
export const clockWentBack = (now, maxSeen) => isTime(maxSeen) && maxSeen - now >= CLOCK_BACK_MS;

// ---- exec 输入的重建 ----

const bad = (code, extra) => ({ ok: false, code, ...extra });

/**
 * 只收 `command`（非空文本）、`cwd`（绝对路径，可省）、`timeout`（1 到 600 的整数，可省）、`stdin`（文本，可省）；其余字段丢掉，
 * 不合格的给 `{ ok: false, code: 'bad_input', message }`。
 */
export function rebuildExecInput(input) {
  const fail = message => bad('bad_input', { message });
  if (!isPlain(input)) return fail('input 须是对象');
  const own = key => Object.hasOwn(input, key) ? input[key] : undefined;
  const command = own('command'), cwd = own('cwd'), timeout = own('timeout'), stdin = own('stdin');
  if (!isText(command) || !command) return fail('command 须是非空文本');
  if (cwd !== undefined && (!isText(cwd) || !cwd.startsWith('/') || cwd.includes('\0'))) return fail('cwd 须是绝对路径');
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= 600)) return fail('timeout 须是 1 到 600 的整数');
  if (stdin !== undefined && !isText(stdin)) return fail('stdin 须是文本');
  return { ok: true, input: { command, ...(cwd === undefined ? {} : { cwd }), ...(timeout === undefined ? {} : { timeout }), ...(stdin === undefined ? {} : { stdin }) } };
}

// ---- 正文的形状 ----

const specOk = spec => isPlain(spec) && Object.keys(spec).length === 4 && ['name', 'os', 'user', 'cwd'].every(key => isText(spec[key])) && spec.name !== '';
const errorOk = error => isPlain(error) && Object.keys(error).length === 3 && isText(error.code) && isText(error.message) && isText(error.effects);

// 每种正文：必有的字段与可有的字段，各配一个类型检查；多出来的字段、缺的必有字段、类型不对都拒。
const SHAPES = {
  [KIND_GRANT]: {
    required: { v: v => v === 1, holder: isAuthor, grantee: isAuthor, grant: v => isText(v) && UUID.test(v), protocol: v => v === PROTOCOL,
      ops: v => Array.isArray(v) && v.length === 1 && v[0] === 'exec', spec: specOk, available: v => typeof v === 'boolean', grantedAt: isTime },
    optional: {},
  },
  [KIND_CALL]: {
    required: { v: v => v === 1, caller: isAuthor, holder: isAuthor, grant: v => isText(v) && UUID.test(v), request: v => isText(v) && REQUEST.test(v),
      op: v => v === 'exec', input: isPlain, createdAt: isTime, expiresAt: isTime },
    optional: { cancel: v => v === true, canceledAt: isTime },
  },
  [KIND_ANSWER]: {
    required: { v: v => v === 1, holder: isAuthor, caller: isAuthor, grant: v => isText(v) && UUID.test(v), request: v => isText(v) && REQUEST.test(v),
      digest: v => isText(v) && DIGEST.test(v), state: v => STATES.includes(v), acceptedAt: isTime },
    optional: { finishedAt: isTime, result: isPlain, error: errorOk, cut: v => v === true },
  },
};

// 回答按状态核对字段组合（只在收到时核对）：running 不带 result、error；completed 带合格的 exec 结果；failed 带 error，effects 取值合法；
// canceled 照上面的形状。exec 结果的必需字段与类型照 remote-exec/machine@1 的协议定义（plugins/remote-exec/package.json）。
const EFFECTS = ['none', 'some', 'unknown'];
const EXEC_RESULT = { exitCode: v => v === null || Number.isInteger(v), signal: v => v === null || isText(v), stdout: isText, stderr: isText,
  timedOut: v => typeof v === 'boolean', truncated: v => typeof v === 'boolean', outputDir: v => v === null || isText(v), ms: v => Number.isInteger(v) && v >= 0 };
const execResultOk = result => isPlain(result) && Object.entries(EXEC_RESULT).every(([key, check]) => Object.hasOwn(result, key) && check(result[key]));
const ANSWER_STATE_OK = {
  running: body => !Object.hasOwn(body, 'result') && !Object.hasOwn(body, 'error'),
  completed: body => execResultOk(body.result),
  failed: body => EFFECTS.includes(body.error?.effects),
  canceled: () => true,
};

function shapeProblem(kind, body) {
  if (!isPlain(body)) return 'bad_body';
  const { required, optional } = SHAPES[kind];
  for (const key of Object.keys(body)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) return 'bad_body';
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(body, key)) return 'bad_body';
    if (!check(body[key])) return key === 'v' ? 'bad_version' : 'bad_body';
  }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(body, key) && !check(body[key])) return 'bad_body';
  if (kind === KIND_CALL && Object.hasOwn(body, 'cancel') !== Object.hasOwn(body, 'canceledAt')) return 'bad_body';
  return null;
}

// ---- 校验：收到的 Accord 记录 ----

// 受众必须恰好是单人、等于接收方；缺失、public、多人、方向不对都不行。
const audienceOk = (audience, self) => Array.isArray(audience) && audience.length === 1 && audience[0] === self && isAuthor(self);

// `sender` 是正文里写的发出方字段，`receiver` 是接收方字段；`id` 给这条正文应有的记录 id；`size` 是算上限用的字节数。
const callSize = body => bytesOf({ ...body, cancel: true, canceledAt: Number.MAX_SAFE_INTEGER });
const VERIFY = {
  [KIND_GRANT]: { sender: 'holder', receiver: 'grantee', id: body => body.grant, size: bytesOf, limit: Infinity },
  [KIND_CALL]: { sender: 'caller', receiver: 'holder', id: body => body.request, size: callSize, limit: MAX_CALL_BYTES },
  [KIND_ANSWER]: { sender: 'holder', receiver: 'caller', id: body => answerId(body.caller, body.request), size: bytesOf, limit: MAX_ANSWER_BYTES },
};

/** 一种记录的正文里写着「发出方」的字段名：grant、answer 是 `holder`，call 是 `caller`。 */
export const senderField = kind => VERIFY[kind]?.sender;

/**
 * 校验 Accord `records` 的一项 `{ author, kind, id, version, body, audience }`（查询须带 `includeAudience: true`）。
 * `self` 是接收方（本机此刻的作者），`peer` 是期望的对方（发出方）。通过给 `{ ok: true, body }`，否则 `{ ok: false, code }`：
 * `bad_kind`、`bad_audience`（缺失、public、多人、方向不对）、`bad_author`（已验作者不是期望的对方，或不是正文写的发出方）、
 * `bad_body`（多出未知字段、缺字段、类型不对；回答的字段组合与状态不合）、`bad_version`（v 不是 1）、`bad_recipient`（正文写的接收方不是本机）、
 * `bad_id`（记录 id 与正文对不上）、`too_large`。
 */
function verify(kind, record, { self, peer } = {}) {
  if (!isPlain(record) || record.kind !== kind) return bad('bad_kind');
  if (!audienceOk(record.audience, self)) return bad('bad_audience');
  if (!isAuthor(peer) || record.author !== peer) return bad('bad_author');
  const problem = shapeProblem(kind, record.body);
  if (problem) return bad(problem);
  const { body } = record, rule = VERIFY[kind];
  if (kind === KIND_ANSWER && !ANSWER_STATE_OK[body.state](body)) return bad('bad_body');
  if (body[rule.sender] !== record.author) return bad('bad_author');
  if (body[rule.receiver] !== self) return bad('bad_recipient');
  if (record.id !== rule.id(body)) return bad('bad_id');
  if (rule.size(body) > rule.limit) return bad('too_large');
  return { ok: true, body };
}

export const verifyGrant = (record, expect) => verify(KIND_GRANT, record, expect);
export const verifyCall = (record, expect) => verify(KIND_CALL, record, expect);
export const verifyAnswer = (record, expect) => verify(KIND_ANSWER, record, expect);

// ---- 构造：给发布用，得到 `{ kind, id, body, audience }` ----

const invalid = message => Object.assign(new Error(message), { code: 'invalid_input', effects: 'none' });
function build(kind, body) {
  const problem = shapeProblem(kind, body), rule = VERIFY[kind];
  if (problem) throw invalid(`${kind} 的正文不合格：${problem}`);
  if (rule.size(body) > rule.limit) throw invalid(`${kind} 的正文超过 ${rule.limit} 字节${kind === KIND_CALL ? '（含取消版本多出的字段）' : ''}`);
  return { kind, id: rule.id(body), body, audience: [body[rule.receiver]] };
}

/** 授权：id 是授权号，受众是被授权者。`spec`、`available` 只用于展示。 */
export const grantRecord = ({ holder, grantee, grant, spec, available, grantedAt }) =>
  build(KIND_GRANT, { v: 1, holder, grantee, grant, protocol: PROTOCOL, ops: ['exec'], spec, available, grantedAt });

/** 调用请求：id 是请求号（`requestId` 派生），受众是持有方。 */
export const callRecord = ({ caller, holder, grant, request, input, createdAt, expiresAt }) =>
  build(KIND_CALL, { v: 1, caller, holder, grant, request, op: 'exec', input, createdAt, expiresAt });

/** 取消：同一请求号的更高版本，正文保留原来的各项，另加 `cancel: true`、`canceledAt`。`original` 是请求的正文。 */
export const cancelRecord = (original, canceledAt) => build(KIND_CALL, { ...original, cancel: true, canceledAt });

/**
 * 回答：id 由调用方作者与请求号共同派生，受众是调用方。`finishedAt`、`result`、`error` 没有就不写；
 * 序列化后超过 60 KiB 的先 `fitAnswer` 截短（超不过的 `cut: true`）。
 */
export const answerRecord = ({ holder, caller, grant, request, digest, state, acceptedAt, finishedAt, result, error }) =>
  build(KIND_ANSWER, fitAnswer({ v: 1, holder, caller, grant, request, digest, state, acceptedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }), ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }));

// ---- 回答的截短 ----

const codePoints = text => [...text];
// 一路输出只留头尾各约一半 `keep` 个码点，中间一行注明省略了多少字节（写法照 remote-exec 的输出截短）；不够长就原样。
function shorten(text, keep) {
  const chars = codePoints(text);
  if (chars.length <= keep) return text;
  const head = chars.slice(0, Math.ceil(keep / 2)), tail = chars.slice(chars.length - Math.floor(keep / 2));
  const omitted = Buffer.byteLength(text) - Buffer.byteLength(head.join('')) - Buffer.byteLength(tail.join(''));
  return `${head.join('')}\n[… 省略了 ${omitted} 字节，回答超出大小上限 …]\n${tail.join('')}`;
}

/**
 * 回答正文序列化后（UTF-8 字节，含转义）不超过 60 KiB：超了就把 `result` 里的 stdout、stderr 各留头尾、中间注明省略的字节数，
 * `result.truncated` 置 true，`cut: true` 放在回答外层（不进 result）。`result` 的其余各项不动（remote-exec 自己截短过的，`outputDir` 照给）。
 * 失败回答截 `error.message`（同样留头尾），`code`、`effects` 不动；截到最短仍超限的，消息换成一句固定的话，终态总签得出。
 * 没有 `result` 可截、或截到最短仍超限的，抛 `too_large`。没超限的原样返回。
 */
export function fitAnswer(body) {
  if (bytesOf(body) <= MAX_ANSWER_BYTES) return body;
  const { result, error } = body;
  if (isPlain(error) && isText(error.message)) {
    const cut = keep => ({ ...body, error: { ...error, message: shorten(error.message, keep) }, cut: true });
    if (bytesOf(cut(0)) > MAX_ANSWER_BYTES) return { ...body, error: { code: error.code, message: '错误消息超出回答的大小上限，已略去', effects: error.effects }, cut: true };
    return cut(largestFit(cut, codePoints(error.message).length));
  }
  const cut = keep => ({ ...body, result: { ...result, stdout: shorten(result.stdout, keep), stderr: shorten(result.stderr, keep), truncated: true }, cut: true });
  if (!isPlain(result) || !isText(result.stdout) || !isText(result.stderr) || bytesOf(cut(0)) > MAX_ANSWER_BYTES)
    throw Object.assign(new Error('回答超过大小上限，截短也放不下'), { code: 'too_large', effects: 'none' });
  return cut(largestFit(cut, Math.max(codePoints(result.stdout).length, codePoints(result.stderr).length)));
}

// 保留的码点数越多正文越大：二分找出 `cut(keep)` 还放得下的最大 keep（`cut(0)` 须已放得下）。
function largestFit(cut, high) {
  let low = 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytesOf(cut(middle)) <= MAX_ANSWER_BYTES) low = middle; else high = middle - 1;
  }
  return low;
}
