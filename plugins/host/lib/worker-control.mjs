import { request } from 'node:http';

// A token-authenticated loopback control channel identifies the worker; a recycled PID never authorizes a signal.
export function controlWorker(record, action = 'status') {
  if (!record.control) return Promise.resolve(false);
  return new Promise(resolve => {
    const req = request({ hostname: '127.0.0.1', port: record.control.port, path: `/${action}`, method: 'POST',
      headers: { authorization: `Bearer ${record.control.token}` }, timeout: 2000 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false)); req.end();
  });
}
