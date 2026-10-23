#!/usr/bin/env node
'use strict';

// Runs the port-mapping code against the real router of this network, from
// the command line, without the app.
//
//   node scripts/portmap.js            look only: find the router, ask its
//                                      outside address, ask the internet
//                                      ours, and say what kind of connection
//                                      this is.  Changes nothing.
//   node scripts/portmap.js --map      also forward Sozvon's ports here,
//                                      print what the router did, and remove
//                                      them again on Ctrl+C (or after
//                                      --hold seconds).
//
// Options:  --https-port N (8443)  --udp-port N (8443)  --no-turn
//           --methods upnp,pcp,natpmp  --hold N  --no-outside
//
// --map changes the router's configuration.  Ask whoever owns the router
// first.

const upnp = require('../src/host/upnp');
const natpmp = require('../src/host/natpmp');
const netaddr = require('../src/host/netaddr');
const { PortMapper, sozvonPorts } = require('../src/host/portmap');

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

async function look() {
  console.log('-- default gateway');
  const g = await netaddr.defaultGateway();
  console.log(g ? `   ${g.gateway}${g.interface ? ` via ${g.interface}` : ''}` : '   none found');

  console.log('-- UPnP (SSDP search on every IPv4 interface)');
  const found = await upnp.discover();
  if (found.length === 0) console.log('   no answer');
  let router;
  for (const f of found) {
    console.log(`   ${f.location}  from ${f.from} (searched via ${f.via || 'default'}), ${f.server}`);
    try {
      const gw = await upnp.Gateway.connect(f.location);
      console.log(`   service ${gw.serviceType}`);
      console.log(`   we are ${gw.localAddress}; router's outside address ${gw.externalAddress}`);
      router = router || gw.externalAddress;
    } catch (e) {
      console.log(`   ${e.code}: ${e.message}`);
    }
  }

  if (g) {
    console.log(`-- NAT-PMP at ${g.gateway}`);
    try {
      const a = await natpmp.natpmpExternalAddress(g.gateway);
      console.log(`   outside address ${a.externalAddress}, epoch ${a.epoch}`);
      router = router || a.externalAddress;
    } catch (e) {
      console.log(`   ${e.code}: ${e.message}`);
    }
  }

  let observed = [];
  if (!has('--no-outside')) {
    console.log(`-- outside observers (${netaddr.OBSERVERS.join(', ')})`);
    observed = await netaddr.observedAddresses();
    console.log(`   ${observed.join(', ') || 'no answer'}`);
  }
  const a = netaddr.assess({ router, observed });
  console.log(`-- verdict: ${a.verdict}\n   ${a.detail}`);
}

async function map() {
  const ports = sozvonPorts({
    httpsPort: Number(opt('--https-port', 8443)),
    udpPort: Number(opt('--udp-port', 8443)),
    turn: !has('--no-turn'),
  });
  const pm = new PortMapper({
    ports,
    methods: opt('--methods', 'upnp,pcp,natpmp').split(','),
    description: 'Sozvon test',
    log: (l) => console.log(`   ${l}`),
  });
  const s = await pm.start();
  console.log(JSON.stringify(s, null, 2));
  const stop = async () => {
    console.log('-- removing the mappings');
    await pm.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  const hold = Number(opt('--hold', 0));
  if (hold > 0) setTimeout(stop, hold * 1000);
  else console.log('-- holding; Ctrl+C removes them');
}

(has('--map') ? map() : look()).catch((e) => {
  console.error(e);
  process.exit(1);
});
