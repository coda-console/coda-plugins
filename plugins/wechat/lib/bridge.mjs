// The phone bridge: how the plugin reaches WeChat on the phone. The plugin only ever asks it these three things, and a bridge
// that cannot reach the phone throws from `accounts` and `messages` with a reason a person can read.
//
//   accounts() → [{ id, name, groups: [{ id, name, last, members: [{ id, name }] }] }]
//     The logged-in accounts and their groups. `last` is the position of the group's newest message, null before any;
//     `members` includes the account itself.
//   messages(account, group, { after?, before?, limit }) → [{ seq, id, sender, senderName, text, createdAt? }]
//     At most `limit` messages of one group, oldest first. `seq` is the message's position in the group, an integer that
//     only grows. With `after`: the first ones past it; otherwise the newest ones, before `before` when it is given.
//   watch({ message({ account, group, seq }), changed() }) → { dispose() }
//     `message` for each new message; `changed` when accounts, groups or members change, or the phone is lost or back.

import { createHash, pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// The plugin runs in a Debian chroot on the phone node, as root, where Android's /data is not mounted. We reach it by
// entering init's mount namespace. We only ever read: the WeChat database is never opened or touched in place — each read
// copies it out through this namespace into a private temp directory and works on the copy.
const NSENTER = ['-t', '1', '-m', '--'];
const android = (args, text = false) => execFileSync('nsenter', [...NSENTER, ...args], { maxBuffer: 1 << 30, encoding: text ? 'utf8' : 'buffer' });

// WeChat and SQLCipher constants — the same in every install, not tied to this account. The account's own values (its uin,
// and from it the data directory and the database key) are read from the phone at runtime and kept only in memory.
const PKG = 'com.tencent.mm';
const SEED = '1234567890ABCDEF';          // WeChat's device-id fallback; the DB key is the first 7 hex of md5(SEED + uin).
const PAGE = 1024, RESERVE = 16, KDF_ITER = 4000;  // SQLCipher cipher_compatibility=1: AES-256-CBC, per-page IV, no HMAC.
const md5 = s => createHash('md5').update(s).digest('hex');

// Where this account's database lives and how to open it, all derived from the phone. Throws a readable reason when the
// phone is out of reach or no account is logged in.
function locate() {
  let prefs;
  try { prefs = android(['cat', `/data/data/${PKG}/shared_prefs/system_config_prefs.xml`], true); }
  catch { throw new Error('手机不在线或微信没装'); }
  const uin = prefs.match(/name="default_uin" value="(\d+)"/)?.[1];
  if (!uin) throw new Error('微信没有登录的账号');
  const db = `/data/data/${PKG}/MicroMsg/${md5('mm' + uin)}/EnMicroMsg.db`;
  return { uin, db, key: md5(SEED + uin).slice(0, 7) };
}

// Decrypt one 1024-byte SQLCipher page. Page 1 keeps its 16-byte salt in the clear and its header is replaced on decrypt;
// every page carries its AES IV in the last 16 bytes, which stay as the page's (ignored) reserved tail.
function decryptPage(key, page, first) {
  const d = createDecipheriv('aes-256-cbc', key, page.subarray(PAGE - RESERVE, PAGE));
  d.setAutoPadding(false);
  const body = Buffer.concat([d.update(page.subarray(first ? 16 : 0, PAGE - RESERVE)), d.final()]);
  const out = Buffer.alloc(PAGE);
  if (first) Buffer.from('SQLite format 3\0', 'latin1').copy(out, 0);
  body.copy(out, first ? 16 : 0);
  page.subarray(PAGE - RESERVE, PAGE).copy(out, PAGE - RESERVE);
  return out;
}

// A fresh message lands in the -wal first, so the plaintext we hand to SQLite must have the WAL's committed frames applied
// over the main pages — newest commit wins per page. Frames past the last commit, or from an older WAL (salt mismatch), are
// a half-written tail and left out.
function withWal(base, wal, key) {
  if (!wal || wal.length < 32 || wal.readUInt32BE(8) !== PAGE) return base;
  const salt0 = wal.readUInt32BE(16), salt1 = wal.readUInt32BE(20), span = 24 + PAGE;
  const committed = new Map(); let pending = new Map();
  for (let off = 32; off + span <= wal.length; off += span) {
    if (wal.readUInt32BE(off + 8) !== salt0 || wal.readUInt32BE(off + 12) !== salt1) break;
    pending.set(wal.readUInt32BE(off), wal.subarray(off + 24, off + 24 + PAGE));
    if (wal.readUInt32BE(off + 4) !== 0) { for (const [p, d] of pending) committed.set(p, d); pending = new Map(); }
  }
  let pages = base.length / PAGE;
  for (const p of committed.keys()) pages = Math.max(pages, p);
  const out = Buffer.alloc(pages * PAGE); base.copy(out);
  for (const [p, enc] of committed) decryptPage(key, enc, p === 1).copy(out, (p - 1) * PAGE);
  return out;
}

// Copy the database (and its WAL) out of Android, decrypt into a private temp file, and open it read-only. The temp
// directory holds only this account's own data and is removed on dispose.
function snapshot(loc) {
  const enc = android(['cat', loc.db]);
  let wal = null;
  try { wal = android(['cat', `${loc.db}-wal`]); } catch { /* no uncheckpointed WAL */ }
  const key = pbkdf2Sync(Buffer.from(loc.key), enc.subarray(0, 16), KDF_ITER, 32, 'sha1');
  const pages = Math.floor(enc.length / PAGE);
  let plain = Buffer.alloc(pages * PAGE);
  for (let i = 0; i < pages; i++) decryptPage(key, enc.subarray(i * PAGE, i * PAGE + PAGE), i === 0).copy(plain, i * PAGE);
  plain = withWal(plain, wal, key);
  const dir = mkdtempSync(join(tmpdir(), 'wxbridge-'));
  const file = join(dir, 'db');
  writeFileSync(file, plain, { mode: 0o600 });
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); db.prepare('SELECT 1 FROM userinfo LIMIT 1').get(); }
  catch { rmSync(dir, { recursive: true, force: true }); throw new Error('解不开微信本地库（账号或密钥变了）'); }
  return { db, dispose() { try { db.close(); } finally { rmSync(dir, { recursive: true, force: true }); } } };
}
const withSnapshot = (loc, fn) => { const s = snapshot(loc); try { return fn(s.db); } finally { s.dispose(); } };

// The logged-in account: its wxid and nickname live in userinfo (2 and 4).
const readSelf = db => ({ id: db.prepare('SELECT value FROM userinfo WHERE id=2').get()?.value, name: db.prepare('SELECT value FROM userinfo WHERE id=4').get()?.value ?? '' });

// A member's current name: their remark or nickname from rcontact, the account's own name for itself, the in-room display
// name by position when WeChat has nothing else, and finally the raw wxid.
function nameResolver(db, self) {
  const stmt = db.prepare('SELECT conRemark, nickname FROM rcontact WHERE username=?');
  const cache = new Map([[self.id, self.name]]);
  return (wxid, fallback) => {
    if (!cache.has(wxid)) { const r = stmt.get(wxid); cache.set(wxid, (r?.conRemark || r?.nickname || '')); }
    return cache.get(wxid) || fallback || wxid;
  };
}

// The groups the account is in: chatrooms whose member list still contains it. The title is the room's nickname; members
// keep the stored order and include the account itself.
function readAccounts(db) {
  const self = readSelf(db);
  const nameOf = nameResolver(db, self);
  const rooms = db.prepare(`SELECT c.chatroomname id, c.memberlist ml, c.displayname dn, NULLIF(r.nickname,'') nick
    FROM chatroom c LEFT JOIN rcontact r ON r.username = c.chatroomname`).all()
    .filter(g => (';' + (g.ml || '') + ';').includes(';' + self.id + ';'));
  const groups = rooms.map(g => {
    const ids = (g.ml || '').split(';').filter(Boolean), display = (g.dn || '').split('、');
    const last = db.prepare('SELECT max(msgId) m FROM message WHERE talker=?').get(g.id).m;
    return {
      id: g.id, name: g.nick || g.dn || g.id, last: last ?? null,
      members: ids.map((wxid, i) => ({ id: wxid, name: nameOf(wxid, display[i]) })),
    };
  });
  return [{ id: self.id, name: self.name, groups }];
}

// A plain-text label for the message kinds we do not render verbatim, so a cursor still lands on every row.
const LABEL = { 3: '[图片]', 34: '[语音]', 42: '[名片]', 43: '[视频]', 47: '[表情]', 48: '[位置]', 49: '[链接]', 50: '[通话]' };
const textOf = (type, body) => type === 1 ? body : (LABEL[type] ?? '[系统消息]');

// One stored row as a bridge message. A group row is `"<sender>:\n<text>"`; the account's own rows have no prefix, and a
// system row is prefixed with the room id and has no personal sender.
function shape(m, self, nameOf) {
  let sender = null, body = m.content ?? '';
  if (m.isSend) sender = self.id;
  else {
    // A group row names its sender before the first colon (`wxid:` for text, `wxid:0:0:…` for stickers and the like); a
    // room-id prefix marks a system row with no personal sender. Text payload follows a `:\n`.
    const colon = body.indexOf(':'), head = colon > 0 ? body.slice(0, colon) : '';
    if (head && !head.includes('@chatroom')) sender = head;
    const nl = body.indexOf(':\n');
    if (nl > 0) body = body.slice(nl + 2);
  }
  return {
    seq: m.msgId,
    id: m.msgSvrId && m.msgSvrId !== '0' ? m.msgSvrId : String(m.msgId),
    sender,
    senderName: sender ? nameOf(sender) : '',
    text: textOf(m.type, body),
    createdAt: m.createTime ?? undefined,
  };
}

function readMessages(db, group, { after, before, limit }) {
  const self = readSelf(db), nameOf = nameResolver(db, self);
  const rows = after != null
    ? db.prepare('SELECT msgId, CAST(msgSvrId AS TEXT) msgSvrId, type, isSend, createTime, content FROM message WHERE talker=? AND msgId>? ORDER BY msgId ASC LIMIT ?').all(group, after, limit)
    : before != null
      ? db.prepare('SELECT msgId, CAST(msgSvrId AS TEXT) msgSvrId, type, isSend, createTime, content FROM message WHERE talker=? AND msgId<? ORDER BY msgId DESC LIMIT ?').all(group, before, limit).reverse()
      : db.prepare('SELECT msgId, CAST(msgSvrId AS TEXT) msgSvrId, type, isSend, createTime, content FROM message WHERE talker=? ORDER BY msgId DESC LIMIT ?').all(group, limit).reverse();
  return rows.map(m => shape(m, self, nameOf));
}

// Cheap reachability/liveness token: the database and WAL mtime+size. When it moves we take a snapshot and diff.
function probe(loc) {
  try { return android(['sh', '-c', `stat -c '%Y %s' '${loc.db}' '${loc.db}-wal' 2>/dev/null`], true).trim(); }
  catch { return null; }
}

export function phoneBridge({ interval = 1000 } = {}) {
  return {
    accounts: async () => withSnapshot(locate(), readAccounts),
    messages: async (_account, group, opts) => withSnapshot(locate(), db => readMessages(db, group, opts)),
    watch(handlers) {
      let loc = null, token = null, heads = new Map(), signature = null, reachable = false, started = false;
      const setReach = ok => { const was = reachable; reachable = ok; if (started && was !== ok) handlers.changed(); };
      const tick = () => {
        if (!loc) { try { loc = locate(); } catch { setReach(false); return; } }
        const now = probe(loc);
        if (now === null) { setReach(false); loc = null; return; }
        if (started && now === token) return;
        token = now;
        let seen;
        try {
          seen = withSnapshot(loc, db => {
            const [account] = readAccounts(db);
            const fresh = [];
            if (started && reachable) for (const g of account.groups) {
              const base = heads.get(g.id);
              if (base != null) for (const r of db.prepare('SELECT msgId FROM message WHERE talker=? AND msgId>? ORDER BY msgId').all(g.id, base))
                fresh.push({ account: account.id, group: g.id, seq: r.msgId });
            }
            return { account, fresh };
          });
        } catch { setReach(false); loc = null; return; }
        for (const m of seen.fresh) handlers.message(m);
        const next = JSON.stringify(seen.account.groups.map(g => [g.id, g.name, g.members]));
        const moved = started && reachable && next !== signature;
        heads = new Map(seen.account.groups.map(g => [g.id, g.last]));
        signature = next;
        setReach(true);
        if (moved) handlers.changed();
        started = true;
      };
      const timer = setInterval(tick, interval);
      tick();
      return { dispose() { clearInterval(timer); } };
    },
  };
}
