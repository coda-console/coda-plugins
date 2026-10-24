// mihomo's controller, where this machine has one: the interface its TUN is (what goes out of it went through mihomo),
// and whether it took a connection from one of this machine's ports, to where and through what.
const ask = async (controller, secret, path) => {
  const response = await fetch(new URL(path, controller), { headers: secret ? { authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`mihomo 回答 ${response.status}`);
  return response.json();
};

// The TUN's interface (`utun1`, `mihomo-tun`), or null when mihomo runs without one.
export async function tunDevice(controller, secret) {
  const { tun } = await ask(controller, secret, '/configs');
  return tun?.enable && tun.device ? tun.device : null;
}

// What mihomo has of the connection from local `port`: taken or not, and where it is going through what when taken.
export async function connectionFrom(controller, secret, port) {
  const { connections = [] } = await ask(controller, secret, '/connections');
  const found = connections.find(c => Number(c.metadata?.sourcePort) === port);
  if (!found) return { taken: false };
  const { host, destinationIP, destinationPort } = found.metadata;
  return { taken: true, to: `${host || destinationIP}:${destinationPort}`, chains: found.chains ?? [], rule: found.rule ?? null };
}
