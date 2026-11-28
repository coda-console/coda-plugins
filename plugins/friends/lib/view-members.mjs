// 好友页按「视图里的每台电脑」显示数据的纯逻辑：成员列表、目录记录按 owner 对到成员、离线标记、按身份归组、按电脑分节。不碰 Coda 的 Node API；页面和单测都加载它。
// 页面不自己选机器：App 的全局视图里有哪几台，页面就显示哪几台；数据是目录里的 friends/machine@1，没有这条记录的成员（没装插件、旧版）不出节。

import { identityTitles, shortAuthor } from 'coda-view://lib/v1/accord.js';
import { certStateOf, mergeFriendRows } from './friends.mjs';

/** 页面上全部成员的本人 author 与全部好友的 author 一起算的展示名（author → 标题）：跨电脑的同昵称同尾号撞号时向左加位。 */
const authorsOf = members => members.flatMap(m => [m.author, ...m.friends.map(friend => friend.author)]);
export const memberTitles = members => identityTitles(authorsOf(members));

/** 视图里的成员（去重、保持 coda.machines 的顺序）。`offline` 由 applyOffline 按机器记录填，读到它的记录之前不算离线。 */
export function listMembers(coda) {
  const list = Array.isArray(coda?.machines) ? coda.machines : [coda?.machine];
  const seen = new Set();
  return list.filter(m => typeof m?.id === 'string' && m.id && !seen.has(m.id) && seen.add(m.id))
    .map(m => ({ id: m.id, name: m.name || m.id, offline: false }));
}

/** 目录条目的 `owner`（机器 ID，不分大小写）对到的成员；不在视图里的机器没有。 */
export const memberOf = (members, owner) => typeof owner === 'string' ? members.find(m => m.id.toLowerCase() === owner.toLowerCase()) : undefined;

/** 把一条 friends/machine@1 条目放进它的成员（成员读到了）；`entry` 为 null 是这条记录没了。 */
export function applyEntry(member, entry) {
  member.entry = entry;
  member.author = entry?.spec?.author ?? null;
  member.friends = entry?.status?.friends ?? [];
  member.loaded = Boolean(entry);
}

/** 按 `coda/machine@1` 的条目（`status.offline`）标各成员是否离线；返回有没有变化。没有机器记录的成员不算离线。 */
export function applyOffline(members, machines) {
  let changed = false;
  for (const member of members) {
    const offline = machines.some(entry => entry?.id?.toLowerCase() === member.id.toLowerCase() && entry.status?.offline === true);
    if (offline !== member.offline) { member.offline = offline; changed = true; }
  }
  return changed;
}

/**
 * 按 `author` 把读到了的成员分组（没有身份的电脑归在 author 为 null 一组；没有记录的成员不参与），组的顺序是成员第一次出现的顺序。
 * `signer` 是代表这个身份证书状态的那一台：组里第一台能签名（证书可用）的，没有就是组里第一台。
 */
export function identities(members) {
  const groups = new Map();
  for (const member of members.filter(m => m.loaded)) {
    if (!groups.has(member.author)) groups.set(member.author, []);
    groups.get(member.author).push(member);
  }
  return [...groups].map(([author, group]) => ({ author, members: group, signer: group.find(m => certStateOf(m.entry) === 'active') ?? group[0] }));
}

/**
 * 好友按电脑分节：读到记录的成员一节，顺序同视图；没有记录的成员不出节。节里是这台自己的好友通道（行的内容见 mergeFriendRows，标题用 `titles`，默认按页面上所有身份一起算一次），不同电脑上的同一个好友各出现一次。
 * 只有一个成员时 `title` 为 null（不出节标题）；离线的成员照样出节，`offline` 为 true，内容是它最后写下的。
 */
export function friendSections(members, titles = memberTitles(members)) {
  return members.filter(member => member.loaded).map(member => ({
    member,
    title: members.length > 1 ? member.name : null,
    offline: member.offline,
    rows: mergeFriendRows(member.friends, { titles, shortAuthor }),
  }));
}
