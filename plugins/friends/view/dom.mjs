// 好友页建节点的小工具：只用 DOM API（createElement / createElementNS / textContent），不拼 HTML。
const SVG_NS = 'http://www.w3.org/2000/svg';

const present = children => children.flat().filter(c => c !== null && c !== undefined && c !== false);

function build(node, attrs, children) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...present(children));
  return node;
}

/** replaceChildren，但跳过 null / undefined / false（原生的会把它们当文字插进去）。 */
export const fill = (node, ...children) => node.replaceChildren(...present(children));
export const h = (tag, attrs = {}, ...children) => build(document.createElement(tag), attrs, children);
export const svg = (tag, attrs = {}, ...children) => build(document.createElementNS(SVG_NS, tag), attrs, children);

/** 5×5 几何纹（identiconPattern 的格子）画成矢量 SVG，颜色随 currentColor。 */
export const identiconSvg = grid => svg('svg', { viewBox: '-1 -1 7 7', 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' },
  grid.flatMap((row, r) => row.map((on, c) => (on ? svg('rect', { x: c, y: r, width: 1, height: 1, fill: 'currentColor' }) : null))));
