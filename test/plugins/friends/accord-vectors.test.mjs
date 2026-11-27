// 好友页的展示名、撞号加位与头像网格，对着协议包的测试向量（@coda-console/protocol/vectors/accord.json）逐条校验：
// Node 侧（网关、代理记录）用 @coda-console/protocol/accord，页面用 coda-view://lib/v1/accord.js，两边必须是同一份实现。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as sdk from '@coda-console/protocol/accord';
import * as view from 'coda-view://lib/v1/accord.js';
import { resolveAvatar } from '../../../plugins/friends/lib/avatar.mjs';
import { mergeFriendRows } from '../../../plugins/friends/lib/friends.mjs';

const vectors = JSON.parse(await readFile(new URL('../../../node_modules/@coda-console/protocol/vectors/accord.json', import.meta.url), 'utf8'));
const rows = (authors, titles = sdk.identityTitles(authors)) => mergeFriendRows(authors.map((author, i) => ({ node: `n${i}`, author, bound: true })), { titles, shortAuthor: sdk.shortAuthor });

test('the page library is the protocol package\'s accord module', () => {
  assert.equal(view.identityTitles, sdk.identityTitles);
  assert.equal(view.identiconPattern, sdk.identiconPattern);
});

for (const { author, short, title } of vectors.identities) {
  test(`friend row of ${author.slice(0, 16)}… carries the vector's short code and title`, () => {
    const [row] = rows([author]);
    assert.equal(row.short, short);
    assert.equal(row.title, title);
  });
}

for (const { name, minDigits, authors, titles } of vectors.identityTitles) {
  test(`friend row titles follow the identityTitles vector: ${name}`, () => {
    const valid = [...new Set(authors)].filter(sdk.isAuthor);
    assert.deepEqual(Object.fromEntries(rows(valid, sdk.identityTitles(valid, { minDigits })).map(row => [row.author, row.title])), titles);
  });
}

test('the friend avatar grid is the vector\'s identicon', () => {
  for (const { kind, input, rows: lit } of vectors.identicons.filter(one => one.kind === 'author')) {
    assert.deepEqual(resolveAvatar({ author: input }).grid.map(row => row.map(cell => (cell ? '1' : '0')).join('')), lit, input);
  }
});
