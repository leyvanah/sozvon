// Tests for framing: the cut the sender makes and the fill a receiver
// chooses.  (Sozvon)
//
// Run with:  node --test static/test/
//
// The drawing itself (filter.js, galene.js) needs a browser; what is checked
// here is the arithmetic both sides rely on -- that a cut has the shape asked
// for, stays inside the picture, keeps the face, and that a tile is filled
// only when that costs a margin.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const F = require('../framing.js');

/**
 * @param {{x: number, y: number, w: number, h: number}} c
 * @param {number} w
 * @param {number} h
 */
function inside(c, w, h) {
    assert.ok(c.x >= 0 && c.y >= 0, `cut starts outside: ${JSON.stringify(c)}`);
    assert.ok(c.x + c.w <= w && c.y + c.h <= h,
              `cut ends outside ${w}x${h}: ${JSON.stringify(c)}`);
}

test('formats by setting value, and anything else is no cut', () => {
    assert.strictEqual(F.aspectOf('16:9'), 16 / 9);
    assert.strictEqual(F.aspectOf('9:16'), 9 / 16);
    assert.strictEqual(F.aspectOf('1:1'), 1);
    assert.strictEqual(F.aspectOf('camera'), null);
    assert.strictEqual(F.aspectOf(''), null);
    assert.strictEqual(F.aspectOf('toString'), null);
});

test('no format sends the whole picture', () => {
    assert.deepStrictEqual(F.crop(640, 480, null),
                           {x: 0, y: 0, w: 640, h: 480});
});

test('every format, from every usual camera, has its shape and fits', () => {
    let cams = [[640, 480], [1280, 720], [1920, 1080], [480, 640], [720, 1280]];
    for(let [w, h] of cams) {
        for(let name of Object.keys(F.ASPECTS)) {
            let a = F.aspectOf(name);
            let c = F.crop(w, h, a);
            inside(c, w, h);
            assert.ok(c.w % 2 === 0 && c.h % 2 === 0,
                      `odd size ${c.w}x${c.h} for ${name} from ${w}x${h}`);
            // as near the shape as even sizes allow
            assert.ok(Math.abs(c.w / c.h - a) < 0.02,
                      `${name} from ${w}x${h} came out ${c.w}x${c.h}`);
            // the largest such cut: it touches two opposite edges
            assert.ok(c.w === w || c.h === h,
                      `${name} from ${w}x${h} is smaller than it need be`);
        }
    }
});

test('the format the camera already has is not cut', () => {
    assert.deepStrictEqual(F.crop(1280, 720, 16 / 9),
                           {x: 0, y: 0, w: 1280, h: 720});
    assert.deepStrictEqual(F.crop(640, 480, 4 / 3),
                           {x: 0, y: 0, w: 640, h: 480});
});

test('a cut across is centred', () => {
    // 9:16 out of 4:3: equal margins left and right
    let c = F.crop(640, 480, 9 / 16);
    assert.deepStrictEqual(c, {x: 185, y: 0, w: 270, h: 480});
});

test('a cut top and bottom takes more from the chest than the forehead', () => {
    let c = F.crop(640, 480, 16 / 9);
    assert.strictEqual(c.h, 360);
    let top = c.y, bottom = 480 - c.y - c.h;
    assert.ok(top < bottom, `top ${top}, bottom ${bottom}`);
    // and the assumed face height is still inside, with room above it
    assert.ok(c.y < F.FOCUS.y * 480 - 60);
});

test('turning a quarter swaps the upright size, and the cut is upright', () => {
    // a phone held upright: the sensor gives 640x480 lying down
    let g = F.geometry(640, 480, 90, null);
    assert.strictEqual(g.uw, 480);
    assert.strictEqual(g.uh, 640);
    assert.deepStrictEqual(g.crop, {x: 0, y: 0, w: 480, h: 640});

    let p = F.geometry(640, 480, 270, 9 / 16);
    assert.strictEqual(p.crop.h, 640);
    assert.strictEqual(p.crop.w, 360);

    let s = F.geometry(640, 480, 180, 1);
    assert.strictEqual(s.uw, 640);
    assert.deepStrictEqual([s.crop.w, s.crop.h], [480, 480]);
});

test('odd rotations are normalised', () => {
    assert.strictEqual(F.geometry(640, 480, 450, null).rot, 90);
    assert.strictEqual(F.geometry(640, 480, -90, null).rot, 270);
    assert.strictEqual(F.geometry(640, 480, 360, null).rot, 0);
});

test('a tile narrower than the picture is filled while the cut is a margin', () => {
    // 4:3 picture on a 1:1 stage keeps 75% of the width
    let d = F.tile(600, 600, 640, 480);
    assert.strictEqual(d.fit, 'fill');
    assert.strictEqual(d.position, '50% 50%');
    // 16:9 on a phone held upright keeps a quarter: show it whole
    assert.strictEqual(F.tile(390, 844, 1280, 720).fit, 'fit');
});

test('a tile wider than the picture is filled, weighted to keep the forehead', () => {
    // 4:3 on 16:9: keeps exactly 75% of the height
    let d = F.tile(1600, 900, 640, 480);
    assert.strictEqual(d.fit, 'fill');
    let above = parseFloat(d.position.split(' ')[1]);
    assert.ok(above < 50, `cut ${above}% above, expected less than half`);
    // a portrait picture on a landscape stage would lose the face: whole
    assert.strictEqual(F.tile(1600, 900, 480, 640).fit, 'fit');
    assert.strictEqual(F.tile(1600, 900, 720, 1280).fit, 'fit');
});

test('the weighted position puts the face in the middle of what is seen', () => {
    let d = F.tile(1600, 900, 640, 480);
    let above = parseFloat(d.position.split(' ')[1]) / 100;
    let keep = (640 / 480) / (1600 / 900);
    let seen = above * (1 - keep) + keep / 2;
    assert.ok(Math.abs(seen - F.FOCUS.y) < 0.002, `centre of view at ${seen}`);
});

test('a shared screen, auto-framing off, or unknown sizes: the whole picture', () => {
    assert.strictEqual(F.tile(600, 600, 640, 480, {screen: true}).fit, 'fit');
    assert.strictEqual(F.tile(600, 600, 640, 480, {enabled: false}).fit, 'fit');
    assert.strictEqual(F.tile(0, 600, 640, 480).fit, 'fit');
    assert.strictEqual(F.tile(600, 600, 0, 0).fit, 'fit');
    // the same shape needs no decision
    assert.strictEqual(F.tile(1280, 720, 640, 360).fit, 'fit');
});

test('adapting picks the format nearest the far end\'s screen', () => {
    // a laptop camera (4:3) seen on an upright phone: 9:16
    assert.strictEqual(F.adapt(390 / 760, 4 / 3), '9:16');
    // seen on a wide-screen laptop: 16:9, a quarter of the height cut
    assert.strictEqual(F.adapt(1.7, 4 / 3), '16:9');
    // on a tablet held upright: 3:4
    assert.strictEqual(F.adapt(0.74, 4 / 3), '3:4');
    // on a square-ish window: 1:1
    assert.strictEqual(F.adapt(1.05, 4 / 3), '1:1');
});

test('adapting never widens a picture past the face', () => {
    // an upright phone picture (3:4) seen on a laptop: at most 1:1, never
    // the strip through the eyes that 16:9 would be
    assert.strictEqual(F.adapt(16 / 9, 3 / 4), '1:1');
    assert.strictEqual(F.adapt(4 / 3, 3 / 4), '1:1');
    // a 9:16 picture cannot be widened at all beyond 3:4
    assert.strictEqual(F.adapt(16 / 9, 9 / 16), '3:4');
    // narrowing is always allowed: the face is in the middle across
    assert.strictEqual(F.adapt(9 / 16, 16 / 9), '9:16');
});

test('adapting keeps its format until another fits clearly better', () => {
    // between 1:1 and 4:3 the nearer one wins from nothing...
    assert.strictEqual(F.adapt(1.17, 4 / 3), '4:3');
    // ...but a picture already 1:1 stays 1:1 that close to the line
    assert.strictEqual(F.adapt(1.17, 4 / 3, '1:1'), '1:1');
    // and changes once the screen is clearly 4:3
    assert.strictEqual(F.adapt(1.3, 4 / 3, '1:1'), '4:3');
    // a current format that is no longer allowed is not kept
    assert.strictEqual(F.adapt(16 / 9, 3 / 4, '16:9'), '1:1');
});

test('adapting with nothing known chooses nothing', () => {
    assert.strictEqual(F.adapt(0, 4 / 3), null);
    assert.strictEqual(F.adapt(1.5, 0), null);
    assert.strictEqual(F.adapt(NaN, 4 / 3), null);
});
