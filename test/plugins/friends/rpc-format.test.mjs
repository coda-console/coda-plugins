// 好友签名网关的记录格式（lib/rpc-format.mjs）：纯函数，不碰盘、不碰 Coda。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pointProblem } from '@coda-console/protocol/validate';
import {
  CLOCK_BACK_MS, FUTURE_SKEW_MS, KIND_ANSWER, KIND_CALL, KIND_GRANT, MAX_ANSWER_BYTES, MAX_CALL_BYTES, MAX_WINDOW_MS, RPC_KINDS, RPC_PREFIX,
  answerId, answerRecord, callRecord, cancelRecord, canonicalJson, clockWentBack, fitAnswer, grantRecord, idempotencyKey, isRpcKind, rebuildExecInput,
  machineOf, replayWindow, requestDigest, requestId, signerOf, verifyAnswer, verifyCall, verifyGrant,
} from '../../../plugins/friends/lib/rpc-format.mjs';

const HOLDER = `ed25519:${'a'.repeat(64)}`, CALLER = `ed25519:${'b'.repeat(64)}`, OTHER = `ed25519:${'c'.repeat(64)}`;
const GRANT = '3f2b8c1e-4d5a-4e6f-8a7b-9c0d1e2f3a4b';
const SPEC = { name: 'build-box', os: 'linux', user: 'dev', cwd: '/home/dev' };
const BYTES = value => Buffer.byteLength(JSON.stringify(value));
const execSchema = JSON.parse(await readFile(new URL('../../../plugins/remote-exec/package.json', import.meta.url), 'utf8'))
  .contributes.protocols[0].operations.exec.result;
const EXEC = { exitCode: 0, signal: null, stdout: 'hi\n', stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 5 };

const request = requestId('call-1');
const call = (more = {}) => callRecord({ caller: CALLER, holder: HOLDER, grant: GRANT, request, input: { command: 'ls' }, createdAt: 1_000_000, expiresAt: 1_000_000 + 60_000, ...more });
const answer = more => answerRecord({ holder: HOLDER, caller: CALLER, grant: GRANT, request, digest: requestDigest(call().body), state: 'completed', acceptedAt: 5, finishedAt: 9, result: EXEC, ...more });
// 把构造出的记录当成 Accord records 的一项（已验的作者、带受众）。
const received = (built, author, more = {}) => ({ author, kind: built.kind, id: built.id, version: 1, body: built.body, audience: built.audience, ...more });

test('the three kinds and the reserved prefix', () => {
  assert.deepEqual(RPC_KINDS, ['friends/rpc-grant', 'friends/rpc-call', 'friends/rpc-answer']);
  assert.equal(RPC_PREFIX, 'friends/rpc-');
  assert.deepEqual([KIND_GRANT, KIND_CALL, KIND_ANSWER], RPC_KINDS);
  for (const kind of [...RPC_KINDS, 'friends/rpc-', 'friends/rpc-other']) assert.equal(isRpcKind(kind), true);
  for (const kind of ['friends/dm', 'friends/rpc', 'friends/rpcx', 'x/friends/rpc-call', 'rpc-call', '', undefined, null, 5]) assert.equal(isRpcKind(kind), false);
});

test('a grant is built for its grantee and verified by the grantee against the holder', () => {
  const built = grantRecord({ holder: HOLDER, grantee: CALLER, grant: GRANT, spec: SPEC, available: true, grantedAt: 7 });
  assert.deepEqual(built, { kind: KIND_GRANT, id: GRANT, audience: [CALLER],
    body: { v: 1, holder: HOLDER, grantee: CALLER, grant: GRANT, protocol: 'remote-exec/machine@1', ops: ['exec'], spec: SPEC, available: true, grantedAt: 7 } });
  assert.deepEqual(verifyGrant(received(built, HOLDER), { self: CALLER, peer: HOLDER }), { ok: true, body: built.body });
  assert.throws(() => grantRecord({ holder: HOLDER, grantee: CALLER, grant: 'not-a-uuid', spec: SPEC, available: true, grantedAt: 7 }), { code: 'invalid_input' });
  assert.throws(() => grantRecord({ holder: HOLDER, grantee: CALLER, grant: GRANT, spec: { name: 'x' }, available: true, grantedAt: 7 }), { code: 'invalid_input' });
});

test('a call is built for its holder, its request id is the id, and the cancel is the same request with the original fields kept', () => {
  const built = call();
  assert.deepEqual(built, { kind: KIND_CALL, id: request, audience: [HOLDER],
    body: { v: 1, caller: CALLER, holder: HOLDER, grant: GRANT, request, op: 'exec', input: { command: 'ls' }, createdAt: 1_000_000, expiresAt: 1_060_000 } });
  assert.deepEqual(verifyCall(received(built, CALLER), { self: HOLDER, peer: CALLER }), { ok: true, body: built.body });
  const cancel = cancelRecord(built.body, 1_030_000);
  assert.deepEqual([cancel.kind, cancel.id, cancel.audience], [KIND_CALL, request, [HOLDER]]);
  assert.deepEqual(cancel.body, { ...built.body, cancel: true, canceledAt: 1_030_000 });
  assert.deepEqual(verifyCall(received(cancel, CALLER, { version: 2 }), { self: HOLDER, peer: CALLER }), { ok: true, body: cancel.body });
  // cancel 与 canceledAt 要成对。
  const lone = { ...built.body, cancel: true };
  assert.equal(verifyCall(received({ ...built, body: lone }, CALLER), { self: HOLDER, peer: CALLER }).code, 'bad_body');
});

test('an answer is built for its caller under the id derived from the caller and the request, and verified by the caller against the holder', () => {
  const built = answer();
  assert.equal(built.kind, KIND_ANSWER);
  assert.equal(built.id, answerId(CALLER, request));
  assert.deepEqual(built.audience, [CALLER]);
  assert.deepEqual(built.body, { v: 1, holder: HOLDER, caller: CALLER, grant: GRANT, request, digest: requestDigest(call().body), state: 'completed', acceptedAt: 5, finishedAt: 9, result: EXEC });
  assert.deepEqual(verifyAnswer(received(built, HOLDER), { self: CALLER, peer: HOLDER }), { ok: true, body: built.body });
  const running = answer({ state: 'running', finishedAt: undefined, result: undefined });
  assert.equal('result' in running.body || 'finishedAt' in running.body, false);
  const failed = answer({ state: 'failed', result: undefined, error: { code: 'interrupted', message: '中断', effects: 'unknown' } });
  assert.equal(verifyAnswer(received(failed, HOLDER), { self: CALLER, peer: HOLDER }).ok, true);
  assert.throws(() => answer({ state: 'weird' }), { code: 'invalid_input' });
});

test('the audience must be exactly the one receiver: missing, public, several, the wrong direction and a stranger are all refused', () => {
  const built = call(), expect = { self: HOLDER, peer: CALLER };
  const code = audience => verifyCall(received(built, CALLER, { audience }), expect).code;
  assert.equal(code(undefined), 'bad_audience');
  assert.equal(code([]), 'bad_audience');
  assert.equal(code(['public']), 'bad_audience');
  assert.equal(code([HOLDER, OTHER]), 'bad_audience');
  assert.equal(code([HOLDER, HOLDER]), 'bad_audience');
  assert.equal(code([CALLER]), 'bad_audience', 'addressed to the sender, not the receiver');
  assert.equal(code([OTHER]), 'bad_audience');
  assert.equal(code(HOLDER), 'bad_audience', 'a bare string is not a list');
  assert.equal(code([HOLDER]), undefined);
  // 持有方发的回答、授权同理。
  const granted = grantRecord({ holder: HOLDER, grantee: CALLER, grant: GRANT, spec: SPEC, available: true, grantedAt: 1 });
  assert.equal(verifyGrant(received(granted, HOLDER, { audience: ['public'] }), { self: CALLER, peer: HOLDER }).code, 'bad_audience');
  assert.equal(verifyAnswer(received(answer(), HOLDER, { audience: [CALLER, OTHER] }), { self: CALLER, peer: HOLDER }).code, 'bad_audience');
});

test('the verified author must be the expected peer and the sender the body names', () => {
  const built = call(), expect = { self: HOLDER, peer: CALLER };
  assert.equal(verifyCall(received(built, OTHER), expect).code, 'bad_author', 'signed by someone else');
  assert.equal(verifyCall(received(built, CALLER), { self: HOLDER, peer: OTHER }).code, 'bad_author', 'not the expected peer');
  // 正文写的发出方与已验作者不是同一个人：作者就是期望的对方，正文却冒另一个人的名。
  const forged = { ...built.body, caller: OTHER };
  assert.equal(verifyCall(received({ ...built, body: forged }, CALLER), expect).code, 'bad_author');
  const answered = answer();
  assert.equal(verifyAnswer(received(answered, OTHER), { self: CALLER, peer: OTHER }).code, 'bad_author', 'the body says the holder answered');
  assert.equal(verifyAnswer(received(answered, HOLDER), { self: CALLER, peer: OTHER }).code, 'bad_author');
});

test('the receiver in the body, the record id and the kind must all agree', () => {
  const built = call(), expect = { self: HOLDER, peer: CALLER };
  assert.equal(verifyCall(received({ ...built, body: { ...built.body, holder: OTHER } }, CALLER, { audience: [OTHER] }), { self: OTHER, peer: CALLER }).ok, true);
  assert.equal(verifyCall(received({ ...built, body: { ...built.body, holder: OTHER } }, CALLER), expect).code, 'bad_recipient');
  assert.equal(verifyCall(received(built, CALLER, { id: requestId('another') }), expect).code, 'bad_id');
  assert.equal(verifyCall(received(built, CALLER, { kind: KIND_ANSWER }), expect).code, 'bad_kind');
  assert.equal(verifyCall(null, expect).code, 'bad_kind');
  const built2 = answer();
  assert.equal(verifyAnswer(received(built2, HOLDER, { id: answerId(OTHER, request) }), { self: CALLER, peer: HOLDER }).code, 'bad_id');
  assert.equal(verifyAnswer(received(built2, HOLDER, { id: request }), { self: CALLER, peer: HOLDER }).code, 'bad_id');
});

test('a body with the wrong version, an unknown field, a missing field or a wrong type is refused', () => {
  const built = call(), expect = { self: HOLDER, peer: CALLER };
  const code = body => verifyCall(received({ ...built, body }, CALLER), expect).code;
  assert.equal(code({ ...built.body, v: 2 }), 'bad_version');
  assert.equal(code({ ...built.body, v: '1' }), 'bad_version');
  assert.equal(code({ ...built.body, extra: 1 }), 'bad_body');
  const { op, ...missing } = built.body;
  assert.equal(code(missing), 'bad_body');
  assert.equal(code({ ...built.body, op: 'pull' }), 'bad_body');
  assert.equal(code({ ...built.body, input: 'ls' }), 'bad_body');
  assert.equal(code({ ...built.body, input: ['ls'] }), 'bad_body');
  assert.equal(code({ ...built.body, createdAt: '1' }), 'bad_body');
  assert.equal(code({ ...built.body, createdAt: 1.5 }), 'bad_body');
  assert.equal(code({ ...built.body, request: 'x' }), 'bad_body');
  assert.equal(code({ ...built.body, grant: 'x' }), 'bad_body');
  assert.equal(code([]), 'bad_body');
  assert.equal(code(null), 'bad_body');
  const bodyOf = more => ({ ...answer().body, ...more }), check = body => verifyAnswer(received({ ...answer(), body }, HOLDER), { self: CALLER, peer: HOLDER }).code;
  assert.equal(check(bodyOf({ state: 'done' })), 'bad_body');
  assert.equal(check(bodyOf({ digest: 'abc' })), 'bad_body');
  assert.equal(check(bodyOf({ error: { code: 'x', message: 'y' } })), 'bad_body');
  assert.equal(check(bodyOf({ cut: false })), 'bad_body');
  // 按状态核对字段组合：completed 要带合格的 exec 结果，failed 要带 effects 合法的 error，running 不带 result、error。
  const { result, ...noResult } = answer().body, failedError = { code: 'x', message: 'y', effects: 'unknown' };
  assert.equal(check(noResult), 'bad_body', 'completed without result');
  assert.equal(check(bodyOf({ result: {} })), 'bad_body', 'completed with an empty result');
  for (const field of execSchema.required) {
    const { [field]: dropped, ...partial } = EXEC;
    assert.equal(check(bodyOf({ result: partial })), 'bad_body', `completed without ${field}`);
  }
  assert.equal(check(bodyOf({ result: { ...EXEC, ms: -1 } })), 'bad_body');
  assert.equal(check(bodyOf({ result: { ...EXEC, exitCode: '0' } })), 'bad_body');
  assert.equal(check({ ...noResult, state: 'failed' }), 'bad_body', 'failed without error');
  assert.equal(check({ ...noResult, state: 'failed', error: { code: 'x', message: 'y' } }), 'bad_body', 'failed without effects');
  assert.equal(check({ ...noResult, state: 'failed', error: { ...failedError, effects: 'maybe' } }), 'bad_body', 'failed with unknown effects');
  assert.equal(check({ ...noResult, state: 'failed', error: { ...failedError, code: 5 } }), 'bad_body');
  assert.equal(check({ ...noResult, state: 'failed', error: failedError }), undefined);
  assert.equal(check(bodyOf({ state: 'running' })), 'bad_body', 'running with result');
  assert.equal(check({ ...noResult, state: 'running', error: failedError }), 'bad_body', 'running with error');
  assert.equal(check({ ...noResult, state: 'running' }), undefined);
  assert.equal(check({ ...noResult, state: 'canceled' }), undefined);
  const granted = grantRecord({ holder: HOLDER, grantee: CALLER, grant: GRANT, spec: SPEC, available: true, grantedAt: 1 }), grantCheck = body => verifyGrant(received({ ...granted, body }, HOLDER), { self: CALLER, peer: HOLDER }).code;
  assert.equal(grantCheck({ ...granted.body, ops: ['exec', 'pull'] }), 'bad_body');
  assert.equal(grantCheck({ ...granted.body, protocol: 'other/x@1' }), 'bad_body');
  assert.equal(grantCheck({ ...granted.body, spec: { ...SPEC, extra: 1 } }), 'bad_body');
  assert.equal(grantCheck({ ...granted.body, available: 'yes' }), 'bad_body');
});

test('the derived ids and the idempotency key', () => {
  // 照设计里的写法算出来的：sha256("friends/rpc-call\0" + ctx.id)，取前 32 位十六进制。
  assert.match(requestId('call-1'), /^c[0-9a-f]{32}$/);
  assert.equal(requestId('call-1'), requestId('call-1'));
  assert.notEqual(requestId('call-1'), requestId('call-2'));
  assert.match(answerId(CALLER, request), /^a[0-9a-f]{32}$/);
  assert.match(idempotencyKey(CALLER, request), /^friend:[0-9a-f]{32}$/);
  // 两位调用方用同一个请求号：回答 id、幂等键都不同；同一位的稳定。
  assert.notEqual(answerId(CALLER, request), answerId(OTHER, request));
  assert.notEqual(idempotencyKey(CALLER, request), idempotencyKey(OTHER, request));
  assert.equal(answerId(CALLER, request), answerId(CALLER, request));
  assert.notEqual(answerId(CALLER, request), answerId(CALLER, requestId('call-2')));
  // 分隔符不让两段拼出同一个串：(a, bc) 与 (ab, c) 不同。
  assert.notEqual(idempotencyKey('a', 'bc'), idempotencyKey('ab', 'c'));
  // 照设计里的写法另算一遍、再钉一个固定值：改了派生的写法，已发出的请求就对不上了。
  const sha = text => createHash('sha256').update(text).digest('hex');
  assert.equal(requestId('ctx-1'), `c${sha('friends/rpc-call\0ctx-1').slice(0, 32)}`);
  assert.equal(requestId('ctx-1'), 'c7abc57e941206d563e770cf49af5b4d7');
  assert.equal(answerId(CALLER, request), `a${sha(`friends/rpc-answer\0${CALLER}\0${request}`).slice(0, 32)}`);
  assert.equal(idempotencyKey(CALLER, request), `friend:${sha(`${CALLER}\0${request}`).slice(0, 32)}`);
});

test('the request digest is the sha256 of the canonical JSON without the cancel fields, so the cancel has the original digest', () => {
  const built = call(), cancel = cancelRecord(built.body, 1_030_000);
  assert.equal(requestDigest(cancel.body), requestDigest(built.body));
  assert.match(requestDigest(built.body), /^[0-9a-f]{64}$/);
  // 键序不影响摘要，内容变了就变。
  const shuffled = Object.fromEntries(Object.entries(built.body).reverse());
  assert.equal(requestDigest(shuffled), requestDigest(built.body));
  assert.notEqual(requestDigest({ ...built.body, input: { command: 'ls -l' } }), requestDigest(built.body));
  assert.notEqual(requestDigest({ ...built.body, expiresAt: built.body.expiresAt + 1 }), requestDigest(built.body));
});

test('the canonical JSON sorts keys at every depth, and the digest is pinned', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  // 固定的输入 → 固定的摘要：规范化写法变了，这里就红。
  const body = { v: 1, caller: 'c', holder: 'h', grant: 'g', request: 'r', op: 'exec', input: { timeout: 3, command: 'ls' }, createdAt: 1, expiresAt: 2, cancel: true, canceledAt: 9 };
  assert.equal(requestDigest(body), '3ab45edcd22670617dd5c47b246f16e6afae9aeb68e8875fff88e875004c1a5c');
});

test('the replay window: every edge', () => {
  const now = 10_000_000;
  const check = (createdAt, expiresAt, at = now) => replayWindow(createdAt, expiresAt, at);
  assert.deepEqual(check(now, now + 60_000), { ok: true });
  // 0 < 跨度 ≤ 11 分钟
  assert.equal(check(now, now).code, 'window_span');
  assert.equal(check(now, now - 1).code, 'window_span');
  assert.equal(check(now, now + 1).ok, true);
  assert.equal(check(now, now + MAX_WINDOW_MS).ok, true);
  assert.equal(check(now, now + MAX_WINDOW_MS + 1).code, 'window_span');
  // createdAt ≤ 现在 + 2 分钟
  assert.equal(check(now + FUTURE_SKEW_MS, now + FUTURE_SKEW_MS + 60_000).ok, true);
  assert.equal(check(now + FUTURE_SKEW_MS + 1, now + FUTURE_SKEW_MS + 60_000).code, 'window_future');
  // 现在 < expiresAt
  assert.equal(check(now - 60_000, now + 1).ok, true);
  assert.equal(check(now - 60_000, now).code, 'window_expired');
  assert.equal(check(now - 60_000, now - 1).code, 'window_expired');
  // 不是时间的都按跨度不合拒绝。
  assert.equal(check('1', now + 5).code, 'window_span');
  assert.equal(check(now, NaN).code, 'window_span');
  assert.equal(replayWindow(now, now + 5, undefined).code, 'window_span');
  assert.equal(MAX_WINDOW_MS, 11 * 60_000);
  assert.equal(FUTURE_SKEW_MS, 2 * 60_000);
});

test('a clock that went back by 5 minutes or more than the latest time seen', () => {
  const seen = 50_000_000;
  assert.equal(clockWentBack(seen, seen), false);
  assert.equal(clockWentBack(seen + 1, seen), false);
  assert.equal(clockWentBack(seen - CLOCK_BACK_MS + 1, seen), false);
  assert.equal(clockWentBack(seen - CLOCK_BACK_MS, seen), true);
  assert.equal(clockWentBack(seen - CLOCK_BACK_MS - 1, seen), true);
  assert.equal(clockWentBack(seen, undefined), false, 'nothing seen yet');
  assert.equal(CLOCK_BACK_MS, 5 * 60_000);
});

test('the exec input is rebuilt from four fields only, and what does not fit is refused with a reason', () => {
  assert.deepEqual(rebuildExecInput({ command: 'ls', cwd: '/tmp', timeout: 600, stdin: 'x', extra: 1, env: { A: 'b' } }), { ok: true, input: { command: 'ls', cwd: '/tmp', timeout: 600, stdin: 'x' } });
  assert.deepEqual(rebuildExecInput({ command: 'ls', __proto__: { cwd: '/x' } }), { ok: true, input: { command: 'ls' } });
  assert.deepEqual(rebuildExecInput({ command: ' ', timeout: 1, stdin: '' }), { ok: true, input: { command: ' ', timeout: 1, stdin: '' } });
  const refused = input => rebuildExecInput(input);
  for (const input of [undefined, null, 'ls', ['ls'], {}, { command: '' }, { command: 5 }, { command: ['ls'] },
    { command: 'ls', cwd: 'relative' }, { command: 'ls', cwd: '' }, { command: 'ls', cwd: 5 }, { command: 'ls', cwd: '/a\0b' },
    { command: 'ls', timeout: 0 }, { command: 'ls', timeout: 601 }, { command: 'ls', timeout: 1.5 }, { command: 'ls', timeout: '5' }, { command: 'ls', timeout: null },
    { command: 'ls', stdin: 5 }, { command: 'ls', stdin: null }]) {
    const result = refused(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.code, 'bad_input');
    assert.equal(typeof result.message, 'string');
  }
});

// 请求按「可取消」算：取消版本多出 cancel、canceledAt（canceledAt 取最长），整份不超过 56 KiB。
const makeCall = command => callRecord({ caller: CALLER, holder: HOLDER, grant: GRANT, request, input: { command }, createdAt: 1, expiresAt: 2 });
const cancelSize = command => BYTES({ ...makeCall('').body, input: { command }, cancel: true, canceledAt: Number.MAX_SAFE_INTEGER });

test('a call is limited by the bytes of its serialized body, not its length, and the biggest one can still be cancelled with the same digest', () => {
  // 刚好到上限：带着取消字段正好 56 KiB，多一个字节拒。
  const exact = 'a'.repeat(MAX_CALL_BYTES - cancelSize(''));
  assert.equal(cancelSize(exact), MAX_CALL_BYTES);
  const built = makeCall(exact);
  assert.ok(BYTES(built.body) < MAX_CALL_BYTES, 'the room for the cancel fields is kept back');
  assert.throws(() => makeCall(`${exact}a`), { code: 'invalid_input' });
  // 收到的原请求：通过；取消版本（构造出来、再校验）也通过，且两个版本的摘要相同。
  const expect = { self: HOLDER, peer: CALLER };
  assert.equal(verifyCall(received(built, CALLER), expect).ok, true);
  for (const canceledAt of [1_500, Number.MAX_SAFE_INTEGER]) {
    const cancel = cancelRecord(built.body, canceledAt);
    assert.ok(BYTES(cancel.body) <= MAX_CALL_BYTES);
    const checked = verifyCall(received(cancel, CALLER, { version: 2 }), expect);
    assert.equal(checked.ok, true);
    assert.equal(requestDigest(checked.body), requestDigest(built.body));
  }
  // 只在不带取消字段时放得下的请求：构造与接收都拒，免得发出去之后取消不了。
  const tight = 'a'.repeat(MAX_CALL_BYTES - BYTES(makeCall('').body));
  assert.equal(BYTES({ ...makeCall('').body, input: { command: tight } }), MAX_CALL_BYTES);
  assert.throws(() => makeCall(tight), { code: 'invalid_input' });
  const raw = { ...built.body, input: { command: tight } };
  assert.equal(verifyCall(received({ ...built, body: raw }, CALLER), expect).code, 'too_large');
  // 取消版本本身超出也拒（正文里夹带的超长字段）。
  assert.throws(() => cancelRecord({ ...built.body, input: { command: `${exact}aaaaaaaa` } }, 1), { code: 'invalid_input' });
});

test('the byte limit of a call counts multi-byte text and escapes by what is written', () => {
  const han = '好'.repeat(Math.ceil(MAX_CALL_BYTES / 3));
  assert.ok(han.length < MAX_CALL_BYTES);
  assert.throws(() => makeCall(han), { code: 'invalid_input' });
  // 要转义的字符：一个换行写成两个字节、一个控制字符写成六个字节，也按写出来的算。
  assert.ok(BYTES({ s: '\n' }) - BYTES({ s: '' }) === 2 && BYTES({ s: '\u0001' }) - BYTES({ s: '' }) === 6);
  const controls = '\u0001'.repeat(Math.ceil(MAX_CALL_BYTES / 6));
  assert.ok(controls.length < MAX_CALL_BYTES / 5);
  assert.throws(() => makeCall(controls), { code: 'invalid_input' });
  // 收到的也按字节拒：一条合法形状但太大的请求。
  const big = { ...makeCall('x').body, input: { command: controls } }, built = { kind: KIND_CALL, id: request, body: big, audience: [HOLDER] };
  assert.equal(verifyCall(received(built, CALLER), { self: HOLDER, peer: CALLER }).code, 'too_large');
});

const check = result => assert.equal(pointProblem(execSchema, result, 'result'), null);
const shortenedOf = body => body.result;

test('an answer within 60 KiB is kept as it is; one over it is cut to fit with truncated and the outer cut set, and still passes the exec result schema', () => {
  const small = answer();
  assert.equal('cut' in small.body, false);
  check(small.body.result);

  const big = { ...EXEC, stdout: 'o'.repeat(100_000), stderr: 'e'.repeat(100_000), ms: 3 };
  const cut = answer({ result: big });
  assert.equal(cut.body.cut, true);
  assert.equal('cut' in cut.body.result, false, 'cut is outside the result');
  assert.ok(BYTES(cut.body) <= MAX_ANSWER_BYTES && BYTES(cut.body) > MAX_ANSWER_BYTES - 200, `fills the room: ${BYTES(cut.body)}`);
  assert.equal(shortenedOf(cut.body).truncated, true);
  assert.equal(shortenedOf(cut.body).ms, 3);
  check(shortenedOf(cut.body));
  assert.match(shortenedOf(cut.body).stdout, /^o+\n\[… 省略了 \d+ 字节[^\n]*…\]\no+$/);
  assert.equal(verifyAnswer(received(cut, HOLDER), { self: CALLER, peer: HOLDER }).ok, true);
  // 省略的字节数是对的：留下的加省略的等于原来的。
  const kept = shortenedOf(cut.body).stdout.split('\n'), omitted = Number(/省略了 (\d+) 字节/.exec(kept[1])[1]);
  assert.equal(kept[0].length + kept[2].length + omitted, 100_000);
  // 小的一路不动，大的一路被截。
  const lopsided = answer({ result: { ...EXEC, stdout: 'o'.repeat(200_000), stderr: 'short' } });
  assert.equal(shortenedOf(lopsided.body).stderr, 'short');
  assert.ok(shortenedOf(lopsided.body).stdout.length < 200_000);
  assert.ok(BYTES(lopsided.body) <= MAX_ANSWER_BYTES);
  // remote-exec 自己截短过的，outputDir 照给。
  const kept2 = answer({ result: { ...big, truncated: true, outputDir: '/tmp/coda-remote-exec-1' } });
  assert.equal(shortenedOf(kept2.body).outputDir, '/tmp/coda-remote-exec-1');
});

test('the cut counts bytes after escaping and for multi-byte text: Han, emoji, control characters and quotes all end within 60 KiB and stay valid', () => {
  for (const unit of ['好', '😀', '\u0001', '"', '\n', '\\', 'é']) {
    const text = unit.repeat(120_000), result = { ...EXEC, stdout: text, stderr: unit.repeat(50_000) };
    const cut = answer({ result });
    assert.ok(BYTES(cut.body) <= MAX_ANSWER_BYTES, `${JSON.stringify(unit)}: ${BYTES(cut.body)}`);
    assert.equal(cut.body.cut, true);
    check(cut.body.result);
    // 不把一个字符切成两半（emoji 是代理对）：截出的正文是合法的 UTF-16。
    assert.equal(cut.body.result.stdout.isWellFormed(), true);
    assert.equal(JSON.parse(JSON.stringify(cut.body)).result.stdout, cut.body.result.stdout);
    assert.ok(BYTES(cut.body) > MAX_ANSWER_BYTES - 700, `${JSON.stringify(unit)} fills the room: ${BYTES(cut.body)}`);
  }
});

test('a failed answer with an overlong message is cut to fit: code and effects kept, cut set; past the limit even when cut, a fixed message stands in', () => {
  const failed = message => answer({ state: 'failed', result: undefined, error: { code: 'ENAMETOOLONG', message, effects: 'none' } });
  const cut = failed(`ENAMETOOLONG: ${'/d'.repeat(35_000)}`);
  assert.ok(BYTES(cut.body) <= MAX_ANSWER_BYTES, `${BYTES(cut.body)}`);
  assert.ok(BYTES(cut.body) > MAX_ANSWER_BYTES - 700, `fills the room: ${BYTES(cut.body)}`);
  assert.equal(cut.body.cut, true);
  assert.deepEqual([cut.body.error.code, cut.body.error.effects], ['ENAMETOOLONG', 'none']);
  assert.match(cut.body.error.message, /^ENAMETOOLONG: \/d[\s\S]*省略了 \d+ 字节[\s\S]*\/d$/);
  // 一条短消息不动，也不设 cut。
  assert.equal(failed('short').body.cut, undefined);
  // 其他字段已占满上限（这里拿超长的 code 来占），截消息也放不下：换成固定的一句，code、effects 照留。
  const fixed = fitAnswer({ ...answer().body, state: 'failed', result: undefined, error: { code: 'c'.repeat(MAX_ANSWER_BYTES), message: 'm'.repeat(70_000), effects: 'unknown' } });
  assert.deepEqual([fixed.cut, fixed.error.code.length, fixed.error.effects, fixed.error.message], [true, MAX_ANSWER_BYTES, 'unknown', '错误消息超出回答的大小上限，已略去']);
});

test('an answer that cannot be cut to fit is refused', () => {
  assert.throws(() => fitAnswer({ ...answer().body, result: { ...EXEC, outputDir: '/'.repeat(70_000) } }), { code: 'too_large' });
  // 收到的整条超过 60 KiB 也拒。
  const built = answer(), body = { ...built.body, error: { code: 'x', message: 'm'.repeat(70_000), effects: 'none' } };
  assert.equal(verifyAnswer(received({ ...built, body }, HOLDER), { self: CALLER, peer: HOLDER }).code, 'too_large');
});

test('the signer: with no personal identity the machine key signs with no expiry; a personal author signs only with an active certificate; anything else cannot sign', () => {
  const local = (author, status) => ({ kind: 'coda/accord@1', id: 'local', spec: { author }, ...(status === undefined ? {} : { status }) });
  assert.deepEqual(signerOf(local(HOLDER, { certificate: null })), { author: HOLDER, person: false, canSign: true });
  assert.deepEqual(signerOf(local(HOLDER, { certificate: { active: true, until: 1_900_000_000 } })), { author: HOLDER, person: true, canSign: true });
  for (const certificate of [{ active: false }, { active: false, until: 1_000 }, {}, { active: 'yes' }])
    assert.deepEqual(signerOf(local(HOLDER, { certificate })), { author: HOLDER, person: true, canSign: false }, JSON.stringify(certificate));
  // 作者不是合法公钥、没写证书这个键（旧宿主）、证书不是对象：都不能签。
  for (const accord of [local(null, { certificate: null }), local('someone', { certificate: null }), local(HOLDER, {}), local(HOLDER),
    local(HOLDER, { certificate: 'x' }), local(HOLDER, { certificate: [] }), null, undefined])
    assert.equal(signerOf(accord).canSign, false, JSON.stringify(accord));
  assert.equal(signerOf(local('someone', { certificate: null })).author, null);
});

test('the machine key: the certificate\'s key when a personal identity is bound, whether or not the certificate is active; the author when none is bound; null otherwise', () => {
  const local = (author, status) => ({ kind: 'coda/accord@1', id: 'local', spec: { author }, ...(status === undefined ? {} : { status }) });
  assert.equal(machineOf(local(HOLDER, { certificate: null })), HOLDER);
  for (const certificate of [{ active: true, until: 1_900_000_000, key: OTHER }, { active: false, key: OTHER }])
    assert.equal(machineOf(local(HOLDER, { certificate })), OTHER, JSON.stringify(certificate));
  for (const accord of [local(HOLDER, { certificate: { active: true } }), local(HOLDER, { certificate: { active: true, key: 'x' } }), local('someone', { certificate: null }),
    local(HOLDER, {}), local(HOLDER), null, undefined])
    assert.equal(machineOf(accord), null, JSON.stringify(accord));
});
