// The pet's page in Coda: puts her on the desktop as a floating window (Coda's docs/plugins.md「浮窗」), or asks the module
// to put her away, and says what she sees of Coda.
import { Bridge } from 'coda-view://lib/v1/bridge.js';

const coda = window.coda, bridge = new Bridge();
const toggle = document.getElementById('toggle'), status = document.getElementById('status');
let onDesk = false;

bridge.on('status', d => {
  onDesk = d.onDesk;
  toggle.textContent = onDesk ? '收起' : '放到桌面上';
  toggle.className = onDesk ? 'quiet' : '';
  status.textContent = `${d.running ? `${d.running} 个 Agent 在跑` : '没有 Agent 在跑'}，${d.waiting.length ? `${d.waiting.length} 件事等你` : '没有事等你'}`;
});
toggle.addEventListener('click', async () => {
  if (onDesk) return bridge.send({ type: 'put-away' });
  try { await coda.open({ view: 'pet', presentation: 'float' }); }
  catch (e) { status.textContent = e.message; }
});
bridge.send({ type: 'hello' });
