/* Cover textures (protocol.md, "GET /api/img/<key>/<variant>").
 *
 * The cover's centred square spans disc coordinates [-RM, RM] on both axes. Texel (i, j) of a variant is the exact area
 * average of the source pixels under disc x0 + [i, i + 1) / res, y0 + [j, j + 1) / res (edge pixels of the square repeated
 * past it), then reduced to little-endian RGB565 with the protocol's 4 x 4 ordered dither. */
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";

export const RM = 123.9; // 118 * 1.05

export interface VariantSpec {
  w: number;
  h: number;
  res: number; // texels per disc unit
  x0: number;
  y0: number;
}

export const VARIANTS = {
  home: { w: 152, h: 136, res: 0.8, x0: -65, y0: -45 },
  flight: { w: 112, h: 112, res: 112 / 247.8, x0: -RM, y0: -RM },
  sq160: { w: 160, h: 160, res: 160 / 247.8, x0: -RM, y0: -RM },
  sq36: { w: 36, h: 36, res: 36 / 247.8, x0: -RM, y0: -RM },
} as const satisfies Record<string, VariantSpec>;

export type VariantName = keyof typeof VARIANTS;
export const VARIANT_NAMES = Object.keys(VARIANTS) as VariantName[];

export function isVariant(name: string): name is VariantName {
  return Object.prototype.hasOwnProperty.call(VARIANTS, name);
}

/** A variant as served: "<name>" (raw RGB565, dithered) or "<name>.jpg" (the same texels before the dither, as a JPEG). */
export function isServedVariant(name: string): boolean {
  return isVariant(name.endsWith(".jpg") ? name.slice(0, -4) : name);
}

/** The JPEG form: quality 92, no chroma subsampling (jpeg-js encodes 4:4:4), about a fifth of the raw size. The display
 * decodes it and applies the same dither itself. */
export const JPEG_QUALITY = 92;
export function encodeJpeg(im: RgbImage): Buffer {
  const n = im.width * im.height, rgba = Buffer.alloc(n * 4);
  for (let k = 0, s = 0, d = 0; k < n; k++, s += 3, d += 4) { rgba[d] = im.data[s]; rgba[d + 1] = im.data[s + 1]; rgba[d + 2] = im.data[s + 2]; rgba[d + 3] = 255; }
  return Buffer.from(jpeg.encode({ data: rgba, width: im.width, height: im.height }, JPEG_QUALITY).data);
}

export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

/** RGB, 3 bytes per pixel, rows top to bottom. */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function artKey(url: string): string {
  return createHash("sha1").update(url, "utf8").digest("hex").slice(0, 16);
}

export const KEY_RE = /^[0-9a-f]{16}$/;

/** The pixels whose [k, k + 1) overlaps [a, b), with the overlap as weight; indices clamped to [0, n - 1]. */
function axisWeights(a: number, b: number, n: number): { idx: number[]; wt: number[]; sum: number } {
  const idx: number[] = [];
  const wt: number[] = [];
  let sum = 0;
  for (let k = Math.floor(a); k < b; k++) {
    const ov = Math.min(b, k + 1) - Math.max(a, k);
    if (ov <= 0) continue;
    idx.push(k < 0 ? 0 : k >= n ? n - 1 : k);
    wt.push(ov);
    sum += ov;
  }
  return { idx, wt, sum };
}

/** A cover reduced to its centred square, in RGB. */
export class Cover {
  readonly side: number;
  private readonly ox: number;
  private readonly oy: number;

  constructor(private readonly img: RgbImage) {
    if (img.width < 1 || img.height < 1) throw new Error("empty image");
    if (img.data.length !== img.width * img.height * 3) throw new Error("image data has the wrong size");
    this.side = Math.min(img.width, img.height);
    this.ox = Math.floor((img.width - this.side) / 2);
    this.oy = Math.floor((img.height - this.side) / 2);
  }

  /** The variant's texels in RGB (before the dither). */
  rgb(name: VariantName): RgbImage {
    const { w, h, res, x0, y0 } = VARIANTS[name];
    const s = this.side;
    const scale = s / (2 * RM); // source pixels per disc unit
    const toPx = (d: number) => (d + RM) * scale;
    const cols = [];
    for (let i = 0; i < w; i++) cols.push(axisWeights(toPx(x0 + i / res), toPx(x0 + (i + 1) / res), s));
    const rows = [];
    for (let j = 0; j < h; j++) rows.push(axisWeights(toPx(y0 + j / res), toPx(y0 + (j + 1) / res), s));

    // which source rows are needed at all
    const need = new Uint8Array(s);
    for (const r of rows) for (const y of r.idx) need[y] = 1;

    // horizontal pass: for each needed source row, the weighted sums under every texel column
    const src = this.img.data;
    const stride = this.img.width * 3;
    const tmp = new Float64Array(s * w * 3);
    for (let y = 0; y < s; y++) {
      if (!need[y]) continue;
      const rowBase = (this.oy + y) * stride + this.ox * 3;
      const tBase = y * w * 3;
      for (let i = 0; i < w; i++) {
        const c = cols[i];
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < c.idx.length; k++) {
          const p = rowBase + c.idx[k] * 3;
          const wt = c.wt[k];
          r += src[p] * wt;
          g += src[p + 1] * wt;
          b += src[p + 2] * wt;
        }
        const t = tBase + i * 3;
        tmp[t] = r;
        tmp[t + 1] = g;
        tmp[t + 2] = b;
      }
    }

    // vertical pass and normalisation
    const out = new Uint8Array(w * h * 3);
    for (let j = 0; j < h; j++) {
      const rw = rows[j];
      for (let i = 0; i < w; i++) {
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < rw.idx.length; k++) {
          const t = (rw.idx[k] * w + i) * 3;
          const wt = rw.wt[k];
          r += tmp[t] * wt;
          g += tmp[t + 1] * wt;
          b += tmp[t + 2] * wt;
        }
        const area = rw.sum * cols[i].sum;
        const o = (j * w + i) * 3;
        out[o] = Math.min(255, Math.round(r / area));
        out[o + 1] = Math.min(255, Math.round(g / area));
        out[o + 2] = Math.min(255, Math.round(b / area));
      }
    }
    return { width: w, height: h, data: out };
  }

  variant(name: VariantName): Buffer {
    const im = this.rgb(name);
    return ditherRgb565(im.data, im.width, im.height);
  }
}

/** RGB888 -> little-endian RGB565 with the protocol's dither:
 *  t = BAYER[j & 3][i & 3]; r += t >> 1; g += t >> 2; b += t >> 1; clamp to 255; v = (r >> 3) << 11 | (g >> 2) << 5 | (b >> 3) */
export function ditherRgb565(rgb: Uint8Array, w: number, h: number): Buffer {
  if (rgb.length !== w * h * 3) throw new Error(`expected ${w * h * 3} bytes of RGB, got ${rgb.length}`);
  const out = Buffer.alloc(w * h * 2);
  let p = 0, o = 0;
  for (let j = 0; j < h; j++) {
    const brow = BAYER[j & 3];
    for (let i = 0; i < w; i++) {
      const t = brow[i & 3];
      const r = Math.min(255, rgb[p] + (t >> 1));
      const g = Math.min(255, rgb[p + 1] + (t >> 2));
      const b = Math.min(255, rgb[p + 2] + (t >> 1));
      const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
      out[o] = v & 0xff;
      out[o + 1] = v >> 8;
      p += 3;
      o += 2;
    }
  }
  return out;
}

export function decodeJpeg(data: Uint8Array): RgbImage {
  const im = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  const n = im.width * im.height;
  const rgb = new Uint8Array(n * 3);
  for (let k = 0, s = 0, d = 0; k < n; k++, s += 4, d += 3) {
    rgb[d] = im.data[s];
    rgb[d + 1] = im.data[s + 1];
    rgb[d + 2] = im.data[s + 2];
  }
  return { width: im.width, height: im.height, data: rgb };
}

export type Variants = Record<string, Buffer>; // "home", "home.jpg", ...

export function makeVariants(jpegData: Uint8Array): Variants {
  const cover = new Cover(decodeJpeg(jpegData));
  const out = {} as Variants;
  for (const name of VARIANT_NAMES) { out[name] = cover.variant(name); out[`${name}.jpg`] = encodeJpeg(cover.rgb(name)); }
  return out;
}
