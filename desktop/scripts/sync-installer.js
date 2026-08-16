#!/usr/bin/env node
'use strict';

// Copy the server installer into resources/, where electron-builder can
// package it.
//
// contrib/install.sh is the single source: the same script a person runs by
// hand, the one the Android app bundles, and the one that is actually tested.
// Keeping a second copy under version control here would let the two drift
// apart silently -- so the copy is generated and git-ignored instead.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'contrib', 'install.sh');
const destDir = path.join(__dirname, '..', 'resources');
const dest = path.join(destDir, 'install.sh');

if (!fs.existsSync(src)) {
  console.error(`sync-installer: ${src} not found.`);
  console.error('Run this from a full checkout of the Sozvon repository.');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
// Normalise the line endings on the way: this file is executed by /bin/sh on
// a Linux server, and CRLF would break it on its own shebang.
const script = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(dest, script, { encoding: 'utf8' });
console.log(`sync-installer: ${path.relative(process.cwd(), dest)} <- contrib/install.sh`);
