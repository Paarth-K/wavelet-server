import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { VARIANTS, VARIANT_NAMES, decodeJpeg, makeVariants } from "../src/texture.js";

/* a synthetic 640 px cover: smooth ramps and a sharp-edged square, as a JPEG */
function cover(): Uint8Array {
  const w = 640, h = 640, d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, sq = x > 200 && x < 420 && y > 250 && y < 470;
    d[o] = sq ? 230 : (x * 255) / w; d[o + 1] = sq ? 30 : (y * 255) / h; d[o + 2] = sq ? 40 : 128; d[o + 3] = 255;
  }
  return jpeg.encode({ data: d, width: w, height: h }, 95).data;
}

test("each variant also comes as a 4:4:4 JPEG of the same size, close to the raw texels, and much smaller", () => {
  const v = makeVariants(cover());
  for (const name of VARIANT_NAMES) {
    const j = v[`${name}.jpg`]; assert.ok(j, name);
    const sof = j.indexOf(Buffer.from([0xff, 0xc0])); assert.ok(sof > 0, "baseline SOF0");
    assert.equal(j[sof + 9], 3, "three components");
    for (let c = 0; c < 3; c++) assert.equal(j[sof + 11 + c * 3], 0x11, "no chroma subsampling");
    const im = decodeJpeg(j); const spec = VARIANTS[name];
    assert.equal(im.width, spec.w); assert.equal(im.height, spec.h);
    /* against the raw RGB565 (dithered): mean error within a few levels */
    const raw = v[name]; let err = 0;
    for (let k = 0; k < spec.w * spec.h; k++) {
      const p = raw[2 * k] | (raw[2 * k + 1] << 8), r = ((p >> 11) & 31) * 255 / 31, g = ((p >> 5) & 63) * 255 / 63, b = (p & 31) * 255 / 31;
      err += Math.abs(im.data[3 * k] - r) + Math.abs(im.data[3 * k + 1] - g) + Math.abs(im.data[3 * k + 2] - b);
    }
    assert.ok(err / (spec.w * spec.h * 3) < 6, `${name}: mean error ${err / (spec.w * spec.h * 3)}`);
    if (name !== "sq36") assert.ok(j.length < raw.length / 3, `${name}: ${j.length} vs ${raw.length}`);
  }
});
