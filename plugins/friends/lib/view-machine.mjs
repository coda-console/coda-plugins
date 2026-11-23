// 页面选机器与发消息的纯逻辑：多台机器都提供这页时，页面须指明消息发往哪台。不碰 Coda 的 Node API；页面和单测都加载它。

export function reachableMachines(coda) {
  const list = Array.isArray(coda?.machines) ? coda.machines : [coda?.machine];
  const seen = new Set();
  return list.filter(m => {
    if (typeof m?.id !== 'string' || !m.id || m.unreachable || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export function pickMachine(coda, savedId) {
  const ids = reachableMachines(coda).map(m => m.id);
  if (typeof savedId === 'string' && ids.includes(savedId)) return savedId;
  const own = coda?.machine?.id;
  if (ids.includes(own)) return own;
  return ids[0] ?? own ?? null;
}

// 入队瞬间固定目标机器与代际（getEpoch，调用方每次选机自增）；轮到它发送时选择已变，就整条丢弃，不发往新机器、也不报错。
// 发送失败交给 onError(error, msg, machine, epoch)，不吞；只收当前目标机器的回包。send 返回的 Promise 以「是否发出」收尾。
export function createMachineBridge({ coda, getMachine, getEpoch, onMessage, onError, targetWindow = globalThis }) {
  let chain = Promise.resolve();
  const send = msg => {
    const machine = getMachine(), epoch = getEpoch?.();
    chain = chain.then(async () => {
      if (getMachine() !== machine || getEpoch?.() !== epoch) return false;
      try { await coda.postMessage(msg, machine ? { machine } : undefined); return true; } catch (error) { onError(error, msg, machine, epoch); return false; }
    });
    return chain;
  };
  const listener = event => {
    const d = event.data;
    if (!(d && typeof d === 'object' && typeof d.type === 'string')) return;
    const current = getMachine();
    if (event.machine?.id && current && event.machine.id !== current) return;
    onMessage(d, event);
  };
  targetWindow.addEventListener('message', listener);
  return { send, dispose: () => targetWindow.removeEventListener('message', listener) };
}
