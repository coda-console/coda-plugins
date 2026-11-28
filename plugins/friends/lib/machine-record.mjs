// 好友页读的目录记录 friends/machine@1：把本机 Accord 记录（coda/accord@1 的 local）里页面要用的身份与好友摘要写成一条（key `local`），
// 好友页是目录聚合视图，按条目的 owner 对到各台，别台离线时照样读得到它最后写下的。Accord 不给私钥、authKey 与证书的 sig，这里再按字段挑一遍，
// 记录里只有下面列出的。纯逻辑（machineRecord）与写记录的 createMachineRecord 都在这里，单测直接用。

export const MACHINE_RECORD_KIND = 'friends/machine@1';
const FRIEND_FIELDS = ['node', 'mode', 'scope', 'author', 'bound', 'machine', 'certified', 'createdAt', 'updatedAt', 'linkId', 'peerNode', 'peerPort', 'conflict'];
const CERTIFICATE_FIELDS = ['key', 'root', 'active', 'from', 'until'];
const REMOVAL_FIELDS = ['node', 'since'];

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const listOf = (value, keys) => (Array.isArray(value) ? value : []).filter(item => item && typeof item === 'object').map(item => pick(item, keys));

/**
 * Accord 记录的条目 → 这台的记录 `{ spec, status }`：`spec.author`，`status.friends`、`status.certificate`（Accord 状态里有这个键才有；没绑个人身份是 null）、
 * `status.networkRemovals`。形状同 Accord 条目，页面用同一套 certStateOf、accordStatusSummary 读它。
 */
export function machineRecord(accord) {
  const status = accord?.status ?? {};
  return {
    spec: { author: accord?.spec?.author ?? null },
    status: {
      friends: listOf(status.friends, FRIEND_FIELDS),
      ...(Object.hasOwn(status, 'certificate') ? { certificate: status.certificate === null ? null : pick(status.certificate ?? {}, CERTIFICATE_FIELDS) } : {}),
      networkRemovals: listOf(status.networkRemovals, REMOVAL_FIELDS),
    },
  };
}

export const RETRY_MS = 30_000;

/**
 * 跟着 Accord 的变化写这条记录：`onAccord({ type, entry })` 接网关转来的事件（启动时的第一次也是它），内容和上次写成的一样就不重写。
 * 只记最新一份还没写成的：写失败（写一行警告）后隔 `RETRY_MS` 重写这一份，直到写成或 `stop`；期间来了新变化就换成新的，同一时间只有一个定时器。
 * 没有 Accord 记录（没读到、被删）就不写。写按顺序做，`stop` 之后不再写。
 */
export function createMachineRecord(coda) {
  let latest = null, written = null, chain = Promise.resolve(), stopped = false, timer = null;
  const flush = () => {
    chain = chain.then(async () => {
      if (stopped || !latest || latest.text === written) return;
      const { record, text } = latest;
      try {
        await coda.put({ kind: MACHINE_RECORD_KIND, key: 'local' }, record);
        written = text;
      } catch (e) {
        console.warn(`好友页的目录记录写不进去，${RETRY_MS / 1000} 秒后重试：${e?.message ?? e}`);
        timer ??= setTimeout(() => { timer = null; flush(); }, RETRY_MS);
        timer.unref?.();
      }
    });
  };
  return {
    onAccord({ type, entry } = {}) {
      if (type === 'DELETED' || !entry) return;
      const record = machineRecord(entry);
      latest = { record, text: JSON.stringify(record) };
      clearTimeout(timer);
      timer = null;
      flush();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}
