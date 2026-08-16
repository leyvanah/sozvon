// Build Windows .ico from assets/icon.svg
// Outputs assets/icon.ico with sizes 16, 32, 48, 64, 128, 256
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const toIco = require('to-ico');

const SIZES = [16, 32, 48, 64, 128, 256];
const SRC = path.join(__dirname, '..', 'assets', 'icon.svg');
// The mark is a hairline drawing: at 48px and below its line falls under a
// pixel and the icon renders as an empty rounded square, so the small entries
// come from a cut with the line widened.  Both are generated from the one
// master by contrib/build-mark-assets.py.
const SRC_SMALL = path.join(__dirname, '..', 'assets', 'icon-small.svg');
const SMALL_UP_TO = 48;
const OUT = path.join(__dirname, '..', 'assets', 'icon.ico');

(async () => {
  const buf = fs.readFileSync(SRC);
  const bufSmall = fs.readFileSync(SRC_SMALL);
  const pngs = await Promise.all(SIZES.map(async (s) => {
    return await sharp(s <= SMALL_UP_TO ? bufSmall : buf, { density: 384 })
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }));
  const ico = await toIco(pngs);
  fs.writeFileSync(OUT, ico);
  console.log(`Wrote ${OUT} (${ico.length} bytes, sizes ${SIZES.join(',')})`);
})().catch(e => { console.error(e); process.exit(1); });
