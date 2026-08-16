#!/usr/bin/env node
'use strict';

// Exercise the deployer against a real server, without Electron in the way.
//
//   node scripts/test-deploy.js --host 1.2.3.4 --password s3cret \
//        --tls self-signed --ip 1.2.3.4 --mirror file:///artifacts \
//        --version v0.0.0-test1
//
// Point it at a throwaway machine.  It installs and starts a service.

const { Deployer } = require('../src/deploy/deployer');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

if (!args.host) {
  console.error('usage: test-deploy.js --host HOST [--port N] [--user root]');
  console.error('       [--password PW | --key FILE] [--tls MODE] [--domain D]');
  console.error('       [--ip ADDR] [--mirror URL] [--version V] [--group G]');
  process.exit(2);
}

const fs = require('fs');

const d = new Deployer({
  host: args.host,
  port: args.port ? Number(args.port) : 22,
  username: args.user || 'root',
  password: args.password,
  privateKey: args.key ? fs.readFileSync(args.key) : undefined,
  passphrase: args.passphrase,
  verifyHostKey: async (info) => {
    // Trust on first use, printing what is being trusted -- the same
    // decision the app puts in front of the user.
    console.log(`  host key ${info.fingerprint} (accepted for this test)`);
    return true;
  },
  onEvent: (e) => {
    if (e.type === 'phase') console.log(`* ${e.phase}`);
    if (e.type === 'stage') {
      console.log(`  [${e.index}/${e.total}] ${e.stage} -- ${e.message || ''}`);
    }
  },
});

(async () => {
  const t0 = Date.now();
  try {
    console.log(`connecting to ${args.host}:${args.port || 22} ...`);
    await d.connect();
    const result = await d.deploy({
      tlsMode: args.tls || 'self-signed',
      domain: args.domain,
      ip: args.ip,
      mirror: args.mirror,
      version: args.version,
      group: args.group || 'meet',
      adminUser: args.adminUser || 'operator',
      adminPassword: args.adminPassword,
      port: args.httpsPort,
    });
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\ntook ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    console.error(`\nFAILED (${e.code || 'error'}): ${e.message}`);
    if (e.detail) console.error('--- detail ---\n' + e.detail);
    process.exitCode = 1;
  } finally {
    d.disconnect();
  }
})();
