import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { jcs } from './jcs.mjs';

// Accord records (AIP-01) and bindings (AIP-02): formats, signing and verification. Pure: keys are node:crypto KeyObjects.

export const MAX_RECORD_BYTES = 65536;
const KEY = /^ed25519:[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const KIND = /^[a-z0-9-]{1,64}(\/[a-z0-9-]{1,64})?$/;
// RFC 8410: SubjectPublicKeyInfo of an Ed25519 key is this prefix followed by the 32 raw bytes.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RECORD_DOMAIN = 'accord:record:1\n';
const CERT_DOMAIN = 'accord:cert:1\n';
const CERT_FIELDS = ['key', 'from', 'until', 'sig'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const bytes = text => Buffer.byteLength(text, 'utf8');

export const isAccordKind = kind => typeof kind === 'string' && KIND.test(kind);

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { author: publicKeyToAuthor(publicKey), publicKey, privateKey };
}

export function publicKeyToAuthor(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  if (der.length !== SPKI_PREFIX.length + 32 || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new TypeError('不是 Ed25519 公钥');
  }
  return `ed25519:${der.subarray(SPKI_PREFIX.length).toString('hex')}`;
}

export function authorToPublicKey(author) {
  if (typeof author !== 'string' || !KEY.test(author)) throw new TypeError('钥匙格式不合法');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(author.slice(8), 'hex')]), format: 'der', type: 'spki' });
}

const isEd25519 = privateKey => privateKey?.type === 'private' && privateKey.asymmetricKeyType === 'ed25519';
const signed = (domain, value, privateKey) => {
  if (!isEd25519(privateKey)) throw new TypeError('签名须用 Ed25519 私钥');
  return sign(null, Buffer.from(domain + jcs(value), 'utf8'), privateKey).toString('hex');
};
const verified = (domain, value, signature, key) => verify(null, Buffer.from(domain + jcs(value), 'utf8'), authorToPublicKey(key), Buffer.from(signature, 'hex'));

function certBodyProblem({ key, from, until }) {
  if (typeof key !== 'string' || !KEY.test(key)) return '证书钥匙格式不合法';
  if (!isTime(from) || !isTime(until) || from > until) return '证书有效期不合法';
  return null;
}

function certProblem(cert) {
  if (!isObject(cert)) return '证书不是对象';
  if (Object.keys(cert).length !== CERT_FIELDS.length || !CERT_FIELDS.every(name => Object.hasOwn(cert, name))) return '证书字段不符';
  if (typeof cert.sig !== 'string' || !SIGNATURE.test(cert.sig)) return '证书签名格式不合法';
  return certBodyProblem(cert);
}

/// A certificate: the author's signature over the key that may sign for them during [from, until].
export function signCert({ key, from, until }, authorPrivateKey) {
  const body = { key, from, until };
  const problem = certBodyProblem(body);
  if (problem) throw new TypeError(problem);
  return { ...body, sig: signed(CERT_DOMAIN, body, authorPrivateKey) };
}

export function verifyCert(cert, author) {
  const problem = certProblem(cert);
  if (problem) return { ok: false, reason: problem };
  if (typeof author !== 'string' || !KEY.test(author)) return { ok: false, reason: '作者钥匙格式不合法' };
  const { key, from, until, sig } = cert;
  return verified(CERT_DOMAIN, { key, from, until }, sig, author) ? { ok: true } : { ok: false, reason: '证书签名不符' };
}

function recordProblem(record) {
  if (!isObject(record)) return '记录不是对象';
  if (Object.hasOwn(record, 'gone')) return '记录顶层不能有 gone';
  if (typeof record.author !== 'string' || !KEY.test(record.author)) return '作者钥匙格式不合法';
  if (typeof record.id !== 'string' || bytes(record.id) < 1 || bytes(record.id) > 256) return 'id 须为 1 到 256 字节';
  if (!isAccordKind(record.kind)) return '种类不合法';
  if (!isTime(record.version)) return 'version 须为安全非负整数';
  if (Object.hasOwn(record, 'body') && !isObject(record.body)) return 'body 须为对象';
  return null;
}

export function signRecord(record, signerPrivateKey) {
  if (isObject(record) && Object.hasOwn(record, 'sig')) throw new TypeError('待签记录不能已有 sig');
  const problem = recordProblem(record);
  if (problem) throw new TypeError(problem);
  const full = { ...record, sig: signed(RECORD_DOMAIN, record, signerPrivateKey) };
  const checked = verifyRecord(full);
  if (!checked.ok) throw new TypeError(checked.reason);
  return full;
}

export function verifyRecord(record) {
  const problem = recordProblem(record);
  if (problem) return { ok: false, reason: problem };
  if (typeof record.sig !== 'string' || !SIGNATURE.test(record.sig)) return { ok: false, reason: '签名格式不合法' };
  const { sig, ...rest } = record;
  let whole;
  try { whole = jcs(record); } catch (error) { return { ok: false, reason: `记录不能规范化：${error.message}` }; }
  if (bytes(whole) > MAX_RECORD_BYTES) return { ok: false, reason: '记录超过 64 KiB' };
  let signer = record.author;
  if (Object.hasOwn(record, 'cert')) {
    const certified = verifyCert(record.cert, record.author);
    if (!certified.ok) return certified;
    if (record.version < record.cert.from || record.version > record.cert.until) return { ok: false, reason: 'version 不在证书有效期内' };
    signer = record.cert.key;
  }
  return verified(RECORD_DOMAIN, rest, sig, signer) ? { ok: true } : { ok: false, reason: '签名不符' };
}

/// AIP-02: the record by which an author says that `endpoint` speaks for them in `scope`.
const bindingProblem = (scope, endpoint) => {
  if (typeof scope !== 'string' || scope === '') return 'scope 须为非空字符串';
  if (typeof endpoint !== 'string' || endpoint === '') return 'endpoint 须为非空字符串';
  return null;
};

export function signBinding({ author, id, version, scope, endpoint, cert }, signerPrivateKey) {
  const problem = bindingProblem(scope, endpoint);
  if (problem) throw new TypeError(problem);
  const record = { author, id, kind: 'binding', version, body: { scope, endpoint } };
  if (cert !== undefined) record.cert = cert;
  return signRecord(record, signerPrivateKey);
}

export function verifyBinding(record, { scope, endpoint, now = Date.now(), clockSkewMs = 5 * 60_000 }) {
  const expected = bindingProblem(scope, endpoint);
  if (expected) return { ok: false, reason: `期望的${expected}` };
  const checked = verifyRecord(record);
  if (!checked.ok) return checked;
  if (record.kind !== 'binding') return { ok: false, reason: '不是绑定记录' };
  const stated = bindingProblem(record.body?.scope, record.body?.endpoint);
  if (stated) return { ok: false, reason: `记录的${stated}` };
  if (record.body?.scope !== scope) return { ok: false, reason: 'scope 不符' };
  if (record.body?.endpoint !== endpoint) return { ok: false, reason: 'endpoint 不符' };
  if (record.cert && !(now >= record.cert.from - clockSkewMs && now <= record.cert.until + clockSkewMs)) {
    return { ok: false, reason: '证书不在有效期内' };
  }
  return { ok: true, author: record.author };
}
