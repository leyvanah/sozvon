// electron-builder afterPack hook: ad-hoc sign the macOS app.
//
// There is no Developer ID certificate yet, so the app cannot be signed for
// real.  It still has to be signed somehow: Apple silicon runs no unsigned
// code, and Electron's own ad-hoc signature, which the downloaded binary
// carries, stops matching the moment the app's resources and Info.plist are
// added -- macOS then calls the app "damaged" instead of merely unverified.
// electron-builder 25 cannot do this itself (mac.identity "-" is looked up
// in the keychain, found missing, and signing is skipped), so it is done
// here, after packaging and before the .dmg is made from the result.
//
// The release workflow checks the outcome with `codesign --verify --strict`
// and `Signature=adhoc` on what comes out of the .dmg.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  // --deep reaches the helper apps and frameworks inside; ad-hoc signing
  // needs no entitlements while the hardened runtime is off.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
