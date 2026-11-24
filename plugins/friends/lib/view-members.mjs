// 好友页按「视图里的每台电脑」读数据的纯逻辑：成员列表、按身份归组、按电脑分节。不碰 Coda 的 Node API；页面和单测都加载它。
// 页面不自己选机器：App 的全局视图里有哪几台，页面就读哪几台。

import { certStateOf, mergeFriendRows } from './friends.mjs';

/** 视图里的成员（去重、保持 coda.machines 的顺序）；`unreachable` 是读不到的原因，可达的为 null。 */
export function listMembers(coda) {
  const list = Array.isArray(coda?.machines) ? coda.machines : [coda?.machine];
  const seen = new Set();
  return list.filter(m => typeof m?.id === 'string' && m.id && !seen.has(m.id) && seen.add(m.id))
    .map(m => ({ id: m.id, name: m.name || m.id, unreachable: m.unreachable ? (m.unreachable === true ? '暂时连不上' : String(m.unreachable)) : null }));
}

/**
 * 按 `author` 把读到了的成员分组（没有身份的电脑归在 author 为 null 一组；Accord 没读到的成员不参与），组的顺序是成员第一次出现的顺序。
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
 * 好友按电脑分节：每个成员一节，顺序同视图；节里是这台自己的好友通道（行的内容见 mergeFriendRows），不同电脑上的同一个好友各出现一次。
 * 只有一个成员时 `title` 为 null（不出节标题）；读不到的成员（宿主标了 `unreachable`，或 Accord 读失败 `accordProblem`）`unreachable` 写明原因，没有行。
 */
export function friendSections(members) {
  return members.map(member => ({
    member,
    title: members.length > 1 ? member.name : null,
    unreachable: member.unreachable || member.accordProblem || null,
    rows: member.unreachable || member.accordProblem ? [] : mergeFriendRows(member.friends),
  }));
}
