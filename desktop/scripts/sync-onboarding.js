#!/usr/bin/env node
'use strict';

// Copy the first-run onboarding into src/renderer/onboarding/, where the app
// shows it and electron-builder packages it.
//
// onboarding/ at the repository root is the single source: the Android app
// copies the very same files into its assets.  A second tracked copy here
// would let the two apps' first screens drift apart, so this one is
// generated and git-ignored -- the way sync-installer.js treats install.sh.
//
// Under src/renderer/ on purpose: that directory is what the preload and the
// main process recognise as the app's own pages (see OUR_PAGES in main.js),
// and only those are handed the app's controls.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'onboarding');
const dest = path.join(__dirname, '..', 'src', 'renderer', 'onboarding');

// What the page needs at run time.  The tests and the README stay behind.
const SKIP = new Set(['test', 'README.md']);

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error(`sync-onboarding: ${src} not found.`);
  console.error('Run this from a full checkout of the Sozvon repository.');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(src)) {
  if (SKIP.has(name)) continue;
  const from = path.join(src, name);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(dest, name));
  n++;
}
console.log(`sync-onboarding: ${path.relative(process.cwd(), dest)} <- onboarding/ (${n} files)`);
