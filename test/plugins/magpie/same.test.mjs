// The Magpie plugin's rules for the model a request asked for (scripts/same.mjs): the underlying model's name by the user's declarations
// (`modelSameAs`) and groups, and how the members of a group are read from `magpie group <id>`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { groupMembers, sameNames } from '../../../plugins/magpie/scripts/same.mjs';

test('provider/model: the declared name, else the model without its provider; a name equal to the ID is not an entry', () => {
  const ids = ['deepseek/deepseek-v4', 'workbuddy/deepseek-v4.1-flash', 'rig/opencode-go/deepseek-v4.1-flash', 'bare-model', 'x/same-as-itself'];
  assert.deepEqual(sameNames({ ids }), {
    'deepseek/deepseek-v4': 'deepseek-v4', 'workbuddy/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'rig/opencode-go/deepseek-v4.1-flash': 'opencode-go/deepseek-v4.1-flash',
    'x/same-as-itself': 'same-as-itself' });
  // A declaration wins, also for a peer's model, and a declared model that the gateway does not list is still named.
  const same = { 'workbuddy/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'rig/opencode-go/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'gone/model': ' trimmed ', 'x/empty': '  ', 'x/not-text': 5 };
  assert.deepEqual(sameNames({ ids, same }), {
    'deepseek/deepseek-v4': 'deepseek-v4', 'workbuddy/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'rig/opencode-go/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
    'x/same-as-itself': 'same-as-itself', 'gone/model': 'trimmed', 'x/empty': 'empty', 'x/not-text': 'not-text' });
  assert.deepEqual(sameNames({ ids: ['a/model'], same: { 'a/model': 'a/model' } }), {}, 'the declared name is the ID itself');
});

test('auto/<name> is <name>, whatever its members', () => {
  assert.deepEqual(sameNames({ ids: ['auto/deepseek-v4.1-flash', 'auto/gpt-5', 'auto/'] }), { 'auto/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'auto/gpt-5': 'gpt-5' });
});

test('a group made by hand: the one name all its members have, else it stays its own', () => {
  const groups = {
    'group/same': ['opencode-go/m', 'workbuddy/m', 'auto/m'],
    'group/declared': ['a/x', 'b/y', 'c/z'],
    'group/differ': ['opencode-go/m', 'workbuddy/other'],
    'group/one': ['opencode-go/solo'],
    'group/peer': ['opencode-go/m', 'rig/opencode-go/m'],
    'group/empty': [],
    'group/pattern': ['opencode-go/*', 'workbuddy/m'],
    'group/unknown-member': ['opencode-go/m', 'group/not-made'],
  };
  const ids = [...Object.keys(groups), 'opencode-go/m'];
  const names = sameNames({ ids, groups, same: { 'a/x': 'N', 'b/y': 'N', 'c/z': 'N' } });
  assert.deepEqual(names, { 'group/same': 'm', 'group/declared': 'N', 'group/one': 'solo', 'opencode-go/m': 'm', 'a/x': 'N', 'b/y': 'N', 'c/z': 'N' });
  for (const id of ['group/differ', 'group/peer', 'group/empty', 'group/pattern', 'group/unknown-member']) assert.equal(Object.hasOwn(names, id), false, `${id} is not merged`);
});

test('a member\'s routing (:fast, an effort, an account) is not part of its model; an ID the gateway lists as it is keeps its colon', () => {
  const groups = { 'group/routed': ['pc/gpt-6.1-sol:high:fast', 'pa/gpt-6.1-sol:low+high', 'pb/gpt-6.1-sol#acct-1', 'pb/gpt-6.1-sol:FAST#acct-2'], 'group/colon': ['or/deepseek-r1:free', 'x/deepseek-r1:free'],
    'group/own-high': ['pa/m:high', 'pb/m'], 'group/mixed': ['pa/m:high', 'pb/m:free'] };
  const names = sameNames({ ids: [...Object.keys(groups), 'pa/m:high', 'pa/m'], groups });
  assert.equal(names['group/routed'], 'gpt-6.1-sol');
  assert.equal(names['group/colon'], 'deepseek-r1:free', 'a last part that is no level or fast is the model\'s own');
  assert.equal(names['pa/m:high'], 'm:high', 'listed as it is: a model of its own, not m at high effort');
  assert.equal(names['group/own-high'], undefined, 'pa/m:high is that model, pb/m another');
  assert.equal(names['group/mixed'], undefined);
  // Declarations are of the model, whatever the member carries.
  assert.equal(sameNames({ ids: ['group/g'], groups: { 'group/g': ['a/x:fast', 'b/y:high#acct'] }, same: { 'a/x': 'N', 'b/y': 'N' } })['group/g'], 'N');
});

test('nested groups are taken apart to the end; a group that holds itself, directly or through others, has no name', () => {
  const groups = {
    'group/outer': ['group/inner', 'opencode-go/m'], 'group/inner': ['workbuddy/m', 'group/deep'], 'group/deep': ['auto/m'],
    'group/mixed': ['group/inner', 'opencode-go/other'],
    'group/self': ['group/self', 'opencode-go/m'],
    'group/a': ['group/b', 'opencode-go/m'], 'group/b': ['group/a', 'opencode-go/m'],
    'group/empty-inside': ['group/nothing', 'opencode-go/m'], 'group/nothing': [],
  };
  const names = sameNames({ ids: [...Object.keys(groups), 'opencode-go/m'], groups });
  assert.deepEqual([names['group/outer'], names['group/inner'], names['group/deep']], ['m', 'm', 'm']);
  for (const id of ['group/mixed', 'group/self', 'group/a', 'group/b', 'group/empty-inside', 'group/nothing']) assert.equal(Object.hasOwn(names, id), false, id);
});

test('a name equal to the asked ID is not in the result, and a prototype key is only an ID', () => {
  assert.deepEqual(sameNames({ ids: ['plain', 'group/only', 'constructor', '__proto__/m'], groups: { 'group/only': ['plain'] } }), { 'group/only': 'plain', '__proto__/m': 'm' });
  assert.deepEqual(sameNames({}), {});
});

// What `magpie group show <ref>` of Magpie 0.1.1330 prints: a real group of this machine, and one made in a home directory of its own
// with members at an effort and fast, a pattern that matches and one that matches nothing, and two rules.
const fixture = name => readFileSync(new URL(`../../fixtures/magpie/${name}.txt`, import.meta.url), 'utf8');

test('the members of `magpie group show`: those of the models section, in order, whatever labels follow them', () => {
  assert.deepEqual(groupMembers(fixture('group-show-ds-flash'), 'group/ds-flash'), ['opencode-zen/deepseek-v4.1-flash-free', 'macmini2/opencode-zen/deepseek-v4.1-flash-free', 'rig/opencode-zen/deepseek-v4.1-flash-free',
    'workbuddy-ai/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash', 'rig/workbuddy/deepseek-v4.1-flash', 'rig/opencode-go/deepseek-v4.1-flash', 'macmini2/opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash']);
  const text = '  Outer  group/outer\n  routing   manual  every request to a/x; magpie group pick outer <model> picks another\n  stays     off\n  models    1 a/x:fast#acct ●  A · x\n            2 group/inner  routing group Inner · order · b/y\n            3 b/y:low+high  not served now, skipped\n  levels    low, high  offered\n';
  assert.deepEqual(groupMembers(text, 'group/outer'), ['a/x:fast#acct', 'group/inner', 'b/y:low+high']);
  assert.deepEqual(groupMembers('  5 Ultra  group/ultra\n  routing   order\n  models    none now\n', 'group/ultra'), []);
});

test('the routing rules after the models are not members; a pattern that matches nothing keeps the group from being taken apart', () => {
  const text = fixture('group-show-rules-patterns');
  assert.match(text, /rules {5}1 tokens[^\n]*\n {12}2 tokens/, 'the fixture has two rules, the second on a line like a member\'s');
  assert.match(text, /patterns {2}pa\/\*  3 models\n {12}zz\/\*  matches nothing now/);
  assert.equal(groupMembers(text, 'group/t1'), null, 'zz/* matches nothing now');
  const matching = text.replace('zz/*  matches nothing now', 'zz/*  2 models');
  assert.deepEqual(groupMembers(matching, 'group/t1'), ['pa/alpha', 'pc/gpt-6.1-sol:high:fast', 'pb/beta:high', 'pa/gamma', 'pa/beta']);
  assert.deepEqual(groupMembers(text.replace(/^ {2}patterns.*\n {12}zz.*\n/m, ''), 'group/t1'), ['pa/alpha', 'pc/gpt-6.1-sol:high:fast', 'pb/beta:high', 'pa/gamma', 'pa/beta']);
});

test('output that is not what Magpie prints is not read: another group, a removed or found one, odd lines, numbers out of order, a listed pattern', () => {
  const ok = '  G  group/g\n  routing   order\n  models    1 a/x  A\n            2 b/x  B\n';
  assert.deepEqual(groupMembers(ok, 'group/g'), ['a/x', 'b/x']);
  for (const [text, ref] of [[ok, 'group/other'], ['', 'group/g'], ['magpie: no group "g"', 'group/g'], ['  G  group/g  removed · magpie group restore g\n  models    1 a/x\n', 'group/g'],
    ['  G  auto/g  found by magpie\n  models    1 a/x\n', 'auto/g'], ['  G  group/g\n  routing   order\n', 'group/g'], ['  G  group/g\n  models    2 a/x\n', 'group/g'],
    ['  G  group/g\n  models    1 a/x\n            3 b/x\n', 'group/g'], ['  G  group/g\n  models    1 a/*\n', 'group/g'], ['  G  group/g\n  models    a/x\n', 'group/g'],
    ['  G  group/g\n  note      two\n lines\n  models    1 a/x\n', 'group/g']]) assert.equal(groupMembers(text, ref), null, text);
});
