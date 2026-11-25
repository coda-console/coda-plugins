import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// 弹层的留白只能扣一次：宽屏 .scrim 用 padding 留边（border-box，百分比是 padding 内的内容盒），
// 子级 .dialog 的 max-height 再 calc(100% - …) 就会把上下留白白白扣两遍（20px 的 padding 加 40px 的扣减，弹层少 80px）。
const css = readFileSync(new URL('../../../plugins/friends/view/style.css', import.meta.url), 'utf8');
const rules = text => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
const wide = css.slice(css.indexOf('@media (min-width: 680px)'));
const rule = (text, selector) => rules(text).filter(r => r.selector === selector);
const declared = (text, selector, prop) => rule(text, selector).map(r => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(r.body)?.[1].trim()).filter(Boolean).at(-1);

test('宽屏：.scrim 有 padding 时，.dialog 不再用 calc 扣一次留白', () => {
  assert.ok(wide.startsWith('@media (min-width: 680px)'), '找不到宽屏分支');
  assert.match(declared(wide, '.scrim', 'padding') ?? '', /^\d+px$/, '宽屏 .scrim 用 padding 留边');
  assert.equal(declared(wide, '.dialog', 'max-height'), '100%');
});

test('窄屏：抽屉的顶部留白只扣一次，.scrim 自己没有 padding', () => {
  const narrow = css.slice(0, css.indexOf('@media (min-width: 680px)'));
  assert.equal(declared(narrow, '.scrim', 'padding'), undefined);
  assert.equal(declared(narrow, '.dialog', 'max-height'), 'calc(100% - 24px)');
});

test('弹层正文是可收缩的滚动区，底部安全区仍在', () => {
  const narrow = css.slice(0, css.indexOf('@media (min-width: 680px)'));
  assert.equal(declared(narrow, '.dlg-body', 'min-height'), '0');
  assert.equal(declared(narrow, '.dlg-body', 'overflow-y'), 'auto');
  assert.match(declared(narrow, '.dlg-body:last-child', 'padding-bottom'), /env\(safe-area-inset-bottom/);
});
