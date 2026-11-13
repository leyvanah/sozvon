#!/usr/bin/env node
'use strict';

// Hosts Sozvon on this computer from the command line: what the app's "host
// on this computer" mode will do, without the app, so each step can be run
// and watched on a real machine.
//
//   node scripts/host-here.js --binary PATH --static DIR --dir DIR [options]
//
//   --public-ip IP   the router's public address; default: ask the router
//                    (UPnP / NAT-PMP) and the outside, and refuse unless
//                    they agree that this is a white IP
//   --map            forward the ports on the router (changes the router's
//                    configuration: ask its owner first)
//   --insecure       plain HTTP and no certificate (local testing only)
//   --http-port N    (8443)
//
// Ctrl+C stops the server and removes the mappings it made.  A change of
// this computer's IPv4 addresses restarts the server (its media socket is
// bound per address) and redoes the mappings.

const os = require('os');

const netaddr = require('../src/host/netaddr');
const upnp = require('../src/host/upnp');
const natpmp = require('../src/host/natpmp');
const { PortMapper, sozvonPorts } = require('../src/host/portmap');
const { ServerProcess, serverArgs } = require('../src/host/server');

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

async function routerAddress() {
  try {
    const gw = await upnp.findGateway();
    return gw.externalAddress;
  } catch (_) { /* try NAT-PMP */ }
  const g = await netaddr.defaultGateway();
  if (!g) return undefined;
  try {
    return (await natpmp.natpmpExternalAddress(g.gateway)).externalAddress;
  } catch (_) {
    return undefined;
  }
}

function addresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address).sort().join(',');
}

async function main() {
  const binary = opt('--binary');
  const staticDir = opt('--static');
  const dir = opt('--dir');
  if (!binary || !staticDir || !dir) {
    console.error('usage: host-here.js --binary PATH --static DIR --dir DIR [--public-ip IP] [--map] [--insecure]');
    process.exit(2);
  }
  const httpsPort = Number(opt('--http-port', 8443));

  let publicIP = opt('--public-ip');
  if (!publicIP && !has('--insecure')) {
    const router = await routerAddress();
    const observed = await netaddr.observedAddresses();
    const a = netaddr.assess({ router, observed });
    console.log(`connection: ${a.verdict} -- ${a.detail}`);
    if (a.verdict !== 'white') process.exit(1);
    publicIP = a.publicAddress;
  }

  const args = serverArgs({
    dir, staticDir, publicIP, httpsPort,
    letsencrypt: !has('--insecure'),
    extra: has('--insecure') ? ['-insecure'] : [],
  });
  console.log(`starting ${binary} ${args.join(' ')}`);
  const server = new ServerProcess({ binary, args, dir });
  server.on('line', (l) => console.log(`  server: ${l}`));
  server.start();

  let mapper = null;
  if (has('--map')) {
    mapper = new PortMapper({
      ports: sozvonPorts({ httpsPort }),
      log: (l) => console.log(`  portmap: ${l}`),
    });
    mapper.on('state', (s) => console.log(`  portmap: ${s.method || 'none'} ok=${s.ok} ` +
      s.ports.map((p) => `${p.protocol}/${p.externalPort}:${p.ok ? 'ok' : p.code}`).join(' ')));
    await mapper.start();
  }

  let seen = addresses();
  const watch = setInterval(() => {
    const now = addresses();
    if (now === seen) return;
    console.log(`addresses changed (${seen} -> ${now}); restarting the server`);
    seen = now;
    server.restart();
  }, 5000);

  process.on('SIGINT', async () => {
    clearInterval(watch);
    console.log('stopping');
    await server.stop();
    if (mapper) await mapper.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
