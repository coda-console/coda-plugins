// 在 Node 里跑插件页面（view/app.mjs）用的最小假 DOM：只够 h() 建节点（含 SVG）、读文字、点按钮、收发 message 事件，
// 外加画布的空壳（getContext 什么都不画，toBlob 交给 FakeNode.encode）。写 innerHTML 一类直接抛错，页面用了就测得出来。
let loaded = 0;

export class FakeNode {
  constructor(tag) { Object.assign(this, { tag, children: [], attrs: {}, listeners: {}, style: {}, className: '', _text: '', hidden: false, disabled: false, value: '' }); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  focus() {}
  click() { this.fire('click'); }
  setPointerCapture() {}
  getContext() { return (this.context ??= new Proxy({}, { get: (ctx, key) => ctx[key] ?? (() => {}) })); }
  toBlob(done, type, quality) { setImmediate(() => done(FakeNode.encode(type, quality))); }
  set innerHTML(_) { throw new Error('innerHTML is not allowed'); }
  set outerHTML(_) { throw new Error('outerHTML is not allowed'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML is not allowed'); }
  get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event }); }
}
// 画布导出的图：默认按要的格式给 1 KiB；测试可以换掉它（比如模拟不会编 WebP 的浏览器）。
FakeNode.encode = type => new Blob([new Uint8Array(1024)], { type });

export const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
export const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject })); return d; };

// 装好 window / document / 全局 message 目标，再加载页面；返回读写页面的小工具。每次都是一份新的页面实例。
export async function openPage(t, path, coda) {
  const root = new FakeNode('div'), target = new EventTarget();
  const saved = Object.fromEntries(['window', 'document', 'addEventListener', 'removeEventListener', 'setInterval'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, {
    window: { coda }, document: { getElementById: () => root, createElement: tag => new FakeNode(tag), createElementNS: (ns, tag) => Object.assign(new FakeNode(tag), { namespaceURI: ns }), visibilityState: 'visible' },
    addEventListener: (...args) => target.addEventListener(...args), removeEventListener: (...args) => target.removeEventListener(...args), setInterval: () => 0,
  });
  t.after(() => { for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; });
  await import(`${new URL(`../../${path}`, import.meta.url).href}?page=${++loaded}`);
  const all = (pred, node = root, found = []) => { if (pred(node)) found.push(node); for (const c of node.children) if (typeof c !== 'string') all(pred, c, found); return found; };
  return {
    root, all,
    text: () => root.textContent,
    button: label => all(n => n.tag === 'button' && n.textContent === label)[0],
    reply: (data, machine) => target.dispatchEvent(Object.assign(new Event('message'), { data, machine })),
    dispatch: (type, props = {}) => target.dispatchEvent(Object.assign(new Event(type), props)),
  };
}
