import { Bridge } from 'coda-view://lib/v1/bridge.js';

const bridge = new Bridge();
bridge.on('result', message => {
  document.getElementById('status').textContent = message.text;
});
