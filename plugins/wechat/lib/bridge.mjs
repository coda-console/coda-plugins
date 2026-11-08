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

// Until the bridge on the phone is in, there is nothing to reach.
const away = async () => { throw new Error('还没有接上手机桥'); };
export const unconnected = { accounts: away, messages: away, watch: () => ({ dispose() {} }) };
