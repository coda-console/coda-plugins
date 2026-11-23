// 头像裁剪：本地选的图放进 1:1 方框，拖动平移（Pointer Events，鼠标与触控都走它）、滑块缩放 1.0×–3.0×，
// 导出 512×512 的压缩图。图片只经 URL.createObjectURL 读进来，换图、清除时回收地址。
import { BLOB_MAX_BYTES } from '../lib/avatar.mjs';
import { h } from './dom.mjs';

export const OUTPUT_SIZE = 512;
const VIEW = 440, MIN_ZOOM = 1, MAX_ZOOM = 3;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const toBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

/** 先试 WebP 0.86；浏览器不会编 WebP（退回别的格式或给 null）或超限，就用 JPEG 0.86，仍超限降到 0.72。 */
export async function encodeAvatar(canvas) {
  const webp = await toBlob(canvas, 'image/webp', 0.86);
  if (webp?.type === 'image/webp' && webp.size <= BLOB_MAX_BYTES) return webp;
  for (const quality of [0.86, 0.72]) {
    const jpeg = await toBlob(canvas, 'image/jpeg', quality);
    if (jpeg && jpeg.size <= BLOB_MAX_BYTES) return jpeg;
  }
  throw new Error('图片压缩后仍超过 5 MiB，请换一张');
}

/** onChange 在画面变化（载入、拖动、缩放、清除）后调用，给实时预览用。 */
export function createCropper({ onChange } = {}) {
  let crop = null, url = null, drag = null, loading = 0;
  const canvas = h('canvas', { class: 'crop-canvas', width: VIEW, height: VIEW });
  const zoomText = h('span', { class: 'mono zoom-value' }, '1.0×');
  const zoom = h('input', { type: 'range', min: MIN_ZOOM, max: MAX_ZOOM, step: '0.01', value: '1', 'aria-label': '缩放',
    oninput: e => { if (crop) { crop.zoom = clamp(Number(e.target.value), MIN_ZOOM, MAX_ZOOM); draw(); } } });
  const box = h('div', { class: 'crop-box', role: 'img', 'aria-label': '拖动调整头像位置',
    onpointerdown: e => {
      if (!crop) return;
      box.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: crop.x, oy: crop.y, ratio: VIEW / (box.clientWidth || VIEW) };
      box.className = 'crop-box dragging';
    },
    onpointermove: e => {
      if (!drag || e.pointerId !== drag.id) return;
      crop.x = drag.ox + (e.clientX - drag.x) * drag.ratio;
      crop.y = drag.oy + (e.clientY - drag.y) * drag.ratio;
      draw();
    },
    onpointerup: end, onpointercancel: end,
  }, canvas, h('div', { class: 'crop-grid', 'aria-hidden': 'true' }));
  function end() { drag = null; box.className = 'crop-box'; }

  // 图按「铺满方框」缩放后再乘 zoom；平移限制在不露出空白的范围里。
  function layout(size) {
    const { img } = crop, scale = Math.max(size / img.naturalWidth, size / img.naturalHeight) * crop.zoom;
    const width = img.naturalWidth * scale, height = img.naturalHeight * scale;
    return { scale, width, height, x: (size - width) / 2 + crop.x * (size / VIEW), y: (size - height) / 2 + crop.y * (size / VIEW) };
  }
  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, VIEW, VIEW);
    if (crop) {
      const { width, height } = layout(VIEW);
      crop.x = clamp(crop.x, -(width - VIEW) / 2, (width - VIEW) / 2);
      crop.y = clamp(crop.y, -(height - VIEW) / 2, (height - VIEW) / 2);
      const at = layout(VIEW);
      ctx.drawImage(crop.img, at.x, at.y, at.width, at.height);
      zoomText.textContent = `${crop.zoom.toFixed(1)}×`;
    }
    onChange?.();
  }

  // 换一张：先回收上一张的地址；读的途中又换了或清除了，就不再用这张。
  async function load(file) {
    clear();
    const mine = ++loading, img = new Image();
    url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('读不出这张图片，请换一张')); img.src = url; });
    } catch (e) { if (mine === loading) clear(); throw e; }
    if (mine !== loading) return false;
    crop = { img, zoom: MIN_ZOOM, x: 0, y: 0 };
    zoom.value = String(MIN_ZOOM);
    draw();
    return true;
  }
  function reset() {
    if (!crop) return;
    Object.assign(crop, { zoom: MIN_ZOOM, x: 0, y: 0 });
    zoom.value = String(MIN_ZOOM);
    draw();
  }
  function clear() {
    loading++;
    if (url) URL.revokeObjectURL(url);
    url = null; crop = null; drag = null;
    box.className = 'crop-box';
    zoom.value = String(MIN_ZOOM); zoomText.textContent = '1.0×';
    draw();
  }
  // 方框里看到的部分画到 512×512 上（先铺白底，JPEG 没有透明）；画面在调用时就定下，之后再换图不影响这次导出。
  function exportBlob() {
    const out = document.createElement('canvas');
    out.width = OUTPUT_SIZE; out.height = OUTPUT_SIZE;
    const ctx = out.getContext('2d'), at = layout(OUTPUT_SIZE);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.drawImage(crop.img, at.x, at.y, at.width, at.height);
    return encodeAvatar(out);
  }

  return { box, canvas, zoom, zoomText, load, reset, clear, export: exportBlob, get ready() { return Boolean(crop); } };
}
