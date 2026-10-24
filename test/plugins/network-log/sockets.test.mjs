// The 网络记录 plugin reading the system's TCP table, from rows as macOS's netstat and nettop and Linux's ss print them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interfaceOf, parseNetstat, parseNettop, parseSs } from '../../../plugins/network-log/lib/sockets.mjs';

const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0      0  192.168.31.120.51882   10.255.255.1.443       SYN_SENT               0            0  131072  131072             curl:16965  00104 00000008 000000000000cefd 00000081 04000900      1      0 000001
tcp6       0      0  fd44:530e:4335::.51008 fd44:530e:4335::.49476 ESTABLISHED       165994        37253  325463  143352 CoreDeviceServic:3703   00182 00000008 0000000000009873 00100001 04080900      2      0 000000
tcp4       0      0  198.18.0.1.60014       198.18.0.56.443        SYN_SENT               0            0  131072  131072 Google Chrome He:812    00104 00000008 000000000000cf01 00000081 04000900      1      0 000001
tcp4       0      0  *.22                   *.*                    LISTEN                 0            0  131072  131072          launchd:1      00180 00000006 0000000000000001 00000000 00000800      1      0 000001
`;

test('netstat rows: state, both ends and the process, a name with spaces too; listening ones left out', () => {
  assert.deepEqual(parseNetstat(NETSTAT), [
    { state: 'connecting', local: { ip: '192.168.31.120', port: 51882 }, remote: { ip: '10.255.255.1', port: 443 }, process: 'curl', pid: 16965 },
    { state: 'connected', local: { ip: 'fd44:530e:4335::', port: 51008 }, remote: { ip: 'fd44:530e:4335::', port: 49476 }, process: 'CoreDeviceServic', pid: 3703 },
    { state: 'connecting', local: { ip: '198.18.0.1', port: 60014 }, remote: { ip: '198.18.0.56', port: 443 }, process: 'Google Chrome He', pid: 812 },
  ]);
});

test('ss rows: a process only where this user may see it, IPv6 in brackets, listening ones left out', () => {
  const rows = parseSs([
    'SYN-SENT 0      1      192.168.1.6:58716 10.255.255.1:443 users:(("curl",pid=404629,fd=5))',
    'ESTAB    0      0      [2408:8207::1]:51000 [2606:50c0:8000::154]:443',
    'LISTEN   0      4096   100.109.38.77:8443 0.0.0.0:*',
  ].join('\n'));
  assert.deepEqual(rows, [
    { state: 'connecting', local: { ip: '192.168.1.6', port: 58716 }, remote: { ip: '10.255.255.1', port: 443 }, process: 'curl', pid: 404629 },
    { state: 'connected', local: { ip: '2408:8207::1', port: 51000 }, remote: { ip: '2606:50c0:8000::154', port: 443 }, process: null, pid: null },
  ]);
});

test('nettop flows: whole addresses, IPv4 with a colon and IPv6 with a dot, and the interface each goes out of', () => {
  const flows = parseNettop([
    'time,,interface,state,bytes_in,bytes_out',
    '00:54:13.821765,curl.84115,,,0,0',
    '00:54:13.820685,tcp4 192.168.31.120:57456<->10.255.255.1:443,en0,SynSent,0,0',
    '00:54:13.707619,tcp6 fd44:530e:4335::2.50918<->fd44:530e:4335::1.62478,utun10,Established,44382,29698',
    '00:54:13.704337,tcp6 fd44:530e:4335::2.50916<->*.*,utun10,Listen,,',
  ].join('\n'));
  assert.deepEqual(flows, [
    { local: { ip: '192.168.31.120', port: 57456 }, remote: { ip: '10.255.255.1', port: 443 }, iface: 'en0', state: 'SynSent' },
    { local: { ip: 'fd44:530e:4335::2', port: 50918 }, remote: { ip: 'fd44:530e:4335::1', port: 62478 }, iface: 'utun10', state: 'Established' },
  ]);
});

test('the interface of a local address: exact, an IPv6 address cut short by the start it keeps, or not known', () => {
  const interfaces = { en0: [{ address: '192.168.31.120' }, { address: 'fe80::1%en0' }], utun1: [{ address: '198.18.0.1' }], utun10: [{ address: 'fd44:530e:4335::2' }] };
  assert.equal(interfaceOf('198.18.0.1', interfaces), 'utun1');
  assert.equal(interfaceOf('fe80::1', interfaces), 'en0');
  assert.equal(interfaceOf('fd44:530e:4335::', interfaces), 'utun10');
  assert.equal(interfaceOf('10.0.0.9', interfaces), null);
});
