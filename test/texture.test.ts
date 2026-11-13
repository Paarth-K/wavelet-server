import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Cover, VARIANT_NAMES, artKey, decodeJpeg, ditherRgb565, makeVariants } from "../src/texture.js";
import { COVER_URL, SPECS, boxAverage, encodeJpeg, refRgb565, syntheticCover, texelRect } from "./helpers.js";

const img = syntheticCover();
const cover = new Cover(img);

describe("textures", () => {
  it("has the protocol's sizes in bytes", () => {
    const v = makeVariants(encodeJpeg(img));
    const sizes = Object.fromEntries(Object.entries(v).map(([k, b]) => [k, b.length]));
    assert.deepEqual(sizes, { home: 41344, flight: 25088, sq160: 51200, sq36: 2592 });
    for (const n of VARIANT_NAMES) {
      const [w, h] = SPECS[n];
      const rgb = cover.rgb(n);
      assert.equal(rgb.width, w);
      assert.equal(rgb.height, h);
    }
  });

  it("every texel equals a brute-force area average (edge pixels repeated)", () => {
    for (const n of VARIANT_NAMES) {
      const [w, h] = SPECS[n];
      const rgb = cover.rgb(n);
      let ties = 0;
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const want = boxAverage(img, ...texelRect(n, i, j));
          for (let c = 0; c < 3; c++) {
            const got = rgb.data[(j * w + i) * 3 + c];
            const d = Math.abs(got - want[c]);
            assert.ok(d <= 0.5 + 1e-6, `${n} (${i},${j}) ch${c}: got ${got} want ${want[c].toFixed(3)}`);
            // away from an exact .5 tie (where float noise may round either way) it must be the rounded average
            const frac = want[c] - Math.floor(want[c]);
            if (Math.abs(frac - 0.5) > 1e-6) assert.equal(got, Math.round(want[c]), `${n} (${i},${j}) ch${c}`);
            else ties++;
          }
        }
      assert.ok(ties < w * h * 3, `${n}: every channel was a tie, nothing was checked exactly`);
    }
  });

  it("places the geometry exactly (spot checks against hand-computed footprints)", () => {
    // home texel (0, 0) covers disc [-65, -63.75) x [-45, -43.75), i.e. pixels [152.12, 155.35) x [203.78, 207.01)
    // (58.9 * 640 / 247.8 = 152.12): left of the square, so on the red ramp, red ~ (centre - 0.5) * 255 / 639
    const rgb = cover.rgb("home");
    const [u0, u1, v0, v1] = texelRect("home", 0, 0);
    assert.ok(Math.abs(u0 - 152.12) < 0.01 && Math.abs(u1 - 155.35) < 0.01, `${u0} ${u1}`);
    assert.ok(Math.abs(v0 - 203.78) < 0.01 && Math.abs(v1 - 207.01) < 0.01, `${v0} ${v1}`);
    assert.ok(Math.abs(rgb.data[0] - (((u0 + u1) / 2 - 0.5) * 255) / 639) <= 1);
    // the last home column/row reach disc 125 > 123.9: partly past the cover, so they read the repeated edge
    const [a0, a1, b0, b1] = texelRect("home", 151, 135);
    assert.ok(a1 > 640 && b1 > 640 && a0 < 640 && b0 < 640);
    const p = (135 * 152 + 151) * 3;
    assert.equal(rgb.data[p], 255);
    assert.equal(rgb.data[p + 1], 255);
    // sq36 centre texels straddle the square: the mix follows the overlap
    const sq = cover.rgb("sq36");
    const flat = (i: number, j: number) => Array.from(sq.data.slice((j * 36 + i) * 3, (j * 36 + i) * 3 + 3));
    const want = boxAverage(img, ...texelRect("sq36", 16, 12)).map(Math.round);
    assert.deepEqual(flat(16, 12), want);
  });

  it("uses the centred square of a non-square cover", () => {
    const sq = syntheticCover();
    for (const [w, h, ox, oy] of [
      [700, 640, 30, 0],
      [640, 701, 0, 30],
    ]) {
      const big = { width: w, height: h, data: new Uint8Array(w * h * 3) };
      for (let k = 0; k < big.data.length; k++) big.data[k] = (k * 2654435761) >>> 24; // noise outside the square
      for (let y = 0; y < 640; y++)
        big.data.set(sq.data.subarray(y * 640 * 3, (y + 1) * 640 * 3), ((y + oy) * w + ox) * 3);
      const c = new Cover(big);
      for (const n of VARIANT_NAMES) assert.ok(c.variant(n).equals(cover.variant(n)), `${w}x${h} ${n}`);
    }
  });

  it("decodes JPEG and makes the same textures as from the decoded pixels", () => {
    const j = encodeJpeg(img);
    const v = makeVariants(j);
    const c = new Cover(decodeJpeg(j));
    for (const n of VARIANT_NAMES) assert.ok(v[n].equals(c.variant(n)));
  });

  it("dithers known values", () => {
    const u16 = (b: Buffer, n: number) => b[2 * n] | (b[2 * n + 1] << 8);
    assert.ok(ditherRgb565(new Uint8Array(48).fill(255), 4, 4).equals(Buffer.alloc(32, 0xff)));
    assert.ok(ditherRgb565(new Uint8Array(48), 4, 4).equals(Buffer.alloc(32))); // t >> 1 <= 7, t >> 2 <= 3: never a step
    // (1, 2, 1): only t = 15 (i = 0, j = 3) lifts every channel one step: 0x0821
    const px121 = new Uint8Array(48);
    for (let k = 0; k < 16; k++) px121.set([1, 2, 1], 3 * k);
    let out = ditherRgb565(px121, 4, 4);
    assert.equal(u16(out, 12), 0x0821);
    assert.deepEqual([out[24], out[25]], [0x21, 0x08]); // little-endian
    assert.equal(u16(out, 0), 0);
    // (250, 250, 250): t = 0 -> 0xFFDF (green 62); t = 15 clamps to 255 everywhere -> 0xFFFF
    out = ditherRgb565(new Uint8Array(48).fill(250), 4, 4);
    assert.equal(u16(out, 0), 0xffdf);
    assert.equal(u16(out, 12), 0xffff);
    // t = 8 (i = 1, j = 0): r + 4, g + 2, b + 4 on (4, 2, 4) -> one step each
    const px424 = new Uint8Array(48);
    for (let k = 0; k < 16; k++) px424.set([4, 2, 4], 3 * k);
    out = ditherRgb565(px424, 4, 4);
    assert.equal(u16(out, 1), 0x0821);
    assert.equal(u16(out, 0), 0);
  });

  it("dithers exactly like the formula on random pixels", () => {
    const w = 13, h = 9;
    const rgb = new Uint8Array(w * h * 3);
    let s = 12345;
    for (let k = 0; k < rgb.length; k++) rgb[k] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
    const out = ditherRgb565(rgb, w, h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const p = 3 * (j * w + i), n = 2 * (j * w + i);
        assert.equal(out[n] | (out[n + 1] << 8), refRgb565(rgb[p], rgb[p + 1], rgb[p + 2], i, j), `(${i},${j})`);
      }
  });

  it("a variant is its area average, dithered", () => {
    for (const n of VARIANT_NAMES) {
      const rgb = cover.rgb(n);
      const out = cover.variant(n);
      for (const [i, j] of [
        [0, 0],
        [5, 7],
        [rgb.width - 1, rgb.height - 1],
        [20, 3],
      ]) {
        const p = 3 * (j * rgb.width + i), q = 2 * (j * rgb.width + i);
        assert.equal(out[q] | (out[q + 1] << 8), refRgb565(rgb.data[p], rgb.data[p + 1], rgb.data[p + 2], i, j));
      }
    }
  });

  it("is fast enough", () => {
    const t = performance.now();
    const im = cover.rgb("home");
    ditherRgb565(im.data, 152, 136);
    assert.ok(performance.now() - t < 100);
  });

  it("art key = first 16 hex of sha1(url)", () => {
    assert.equal(artKey(COVER_URL), createHash("sha1").update(COVER_URL).digest("hex").slice(0, 16));
  });
});
