// The pet's page in Coda: puts her on the desktop as a floating window (Coda's docs/plugins.md「浮窗」), or asks the module
// to put her away, and says what she sees of Coda. On an iPhone she floats over Coda's pages instead.
import { Bridge } from 'coda-view://lib/v1/bridge.js';

const coda = window.coda, bridge = new Bridge(), phone = coda.platform === 'ios';
const toggle = document.getElementById('toggle'), status = document.getElementById('status');
const out = phone ? '放出来' : '放到桌面上';
let onDesk = false;
if (phone) {
  document.getElementById('about').textContent = '浮在 Coda 的每一页上陪你：平时是贴边的悬浮球，Agent 在跑时球上的三色环在转，有事等你时角上是数字，点球直接去处理。'
    + '没事时点球她就出来，拖起来能扔到别处，点她会开心，双击或放着不管一会儿就缩回球里；长按是菜单。';
  toggle.textContent = out;
}

bridge.on('status', d => {
  onDesk = d.onDesk;
  toggle.textContent = onDesk ? '收起' : out;
  toggle.className = onDesk ? 'quiet' : '';
  status.textContent = `${d.running ? `${d.running} 个 Agent 在跑` : '没有 Agent 在跑'}，${d.waiting.length ? `${d.waiting.length} 件事等你` : '没有事等你'}`;
});
toggle.addEventListener('click', async () => {
  if (onDesk) return bridge.send({ type: 'put-away' });
  try { await coda.open({ view: 'pet', presentation: 'float' }); }
  catch (e) { status.textContent = e.message; }
});
bridge.send({ type: 'hello' });
