// Build the app's icons from assets/icon.svg.
//
//   assets/icon.ico          Windows: taskbar, shortcut, installer, tray
//                            (sizes 16, 32, 48, 64, 128, 256)
//   assets/icon.png          macOS and Linux: electron-builder turns it into
//                            the .icns and the Linux icon set, and Linux uses
//                            it for the window (1024 px)
//   assets/tray.png          Linux tray (32 px)
//   assets/trayTemplate.png  macOS menu bar, 1x and 2x.  "Template" in the
//   assets/trayTemplate@2x.png  name is what makes macOS treat it as a mask
//                            and paint it in the menu bar's own colour.
//
// An .ico is no use outside Windows: nativeImage cannot read one on macOS or
// Linux and hands back an empty image, so a tray built from it is there but
// invisible -- and with "minimise to tray" on, the window it hides cannot be
// got back.  Hence a PNG for every platform that is not Windows.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const toIco = require('to-ico');

const ASSETS = path.join(__dirname, '..', 'assets');
const SIZES = [16, 32, 48, 64, 128, 256];
const SRC = path.join(ASSETS, 'icon.svg');
// The mark is a hairline drawing: at 48px and below its line falls under a
// pixel and the icon renders as an empty rounded square, so the small entries
// come from a cut with the line widened.  Both are generated from the one
// master by contrib/build-mark-assets.py.
const SRC_SMALL = path.join(ASSETS, 'icon-small.svg');
const SMALL_UP_TO = 48;
// The bare mark, without the plate: a menu-bar icon is a silhouette.  The
// app bar's copy, which is drawn for exactly this kind of size.
const SRC_MARK = path.join(__dirname, '..', 'src', 'renderer', 'mark.svg');

const clear = { r: 0, g: 0, b: 0, alpha: 0 };

function render(src, size, widen = 0) {
  let svg = fs.readFileSync(src);
  if (widen) svg = widened(svg.toString('utf8'), widen);
  return sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: clear })
    .png()
    .toBuffer();
}

// The mark at menu-bar size has the hairline problem the .ico has, and no
// widened cut to fall back on, so it is widened here: a stroke of the given
// width (in the mark's own units, 590 tall) around its outline, and the view
// box grown by as much so nothing is clipped.
function widened(svg, w) {
  const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!m || !svg.includes('<path fill="#000"'))
    throw new Error('mark.svg is not shaped as expected; check widened()');
  return Buffer.from(svg
    .replace('<path fill="#000"',
      `<path fill="#000" stroke="#000" stroke-width="${w}" stroke-linejoin="round"`)
    .replace(m[0], `viewBox="${-w / 2} ${-w / 2} ${+m[1] + w} ${+m[2] + w}"`));
}

function write(name, buf) {
  const out = path.join(ASSETS, name);
  fs.writeFileSync(out, buf);
  console.log(`Wrote ${out} (${buf.length} bytes)`);
}

(async () => {
  const pngs = await Promise.all(SIZES.map((s) =>
    render(s <= SMALL_UP_TO ? SRC_SMALL : SRC, s)));
  write('icon.ico', await toIco(pngs));

  write('icon.png', await render(SRC, 1024));
  write('tray.png', await render(SRC_SMALL, 32));
  // 16 and 32 px canvases, the mark standing in their full height and
  // widened until its line is about a pixel and a half.
  write('trayTemplate.png', await render(SRC_MARK, 16, 40));
  write('trayTemplate@2x.png', await render(SRC_MARK, 32, 24));
})().catch(e => { console.error(e); process.exit(1); });
