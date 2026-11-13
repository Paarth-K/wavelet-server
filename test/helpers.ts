/* Test fixtures: a synthetic cover, an independent brute-force area average, a fake clock and a fake Spotify. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { App } from "../src/app.js";
import type { Config } from "../src/config.js";
import { CURRENTLY_PLAYING_URL, QUEUE_URL, TOKEN_URL } from "../src/spotify.js";
import type { RgbImage } from "../src/texture.js";
import { type Clock, log, systemClock } from "../src/util.js";

log.quiet = true;

export const COVER_URL = "https://i.scdn.co/image/cover-a";
export const SQUARE = { x0: 300, y0: 200, x1: 420, y1: 320 }; // the sharp flat square, exclusive ends
export const SQUARE_RGB = [250, 20, 90];

/** 640 x 640 (or w x h): red ramps left to right, green top to bottom, blue constant, plus a sharp flat square. */
export function syntheticCover(w = 640, h = 640): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      const inSq = x >= SQUARE.x0 && x < SQUARE.x1 && y >= SQUARE.y0 && y < SQUARE.y1;
      data[p] = inSq ? SQUARE_RGB[0] : Math.round((x * 255) / (w - 1));
      data[p + 1] = inSq ? SQUARE_RGB[1] : Math.round((y * 255) / (h - 1));
      data[p + 2] = inSq ? SQUARE_RGB[2] : 100;
    }
  return { width: w, height: h, data };
}

export function encodeJpeg(img: RgbImage, quality = 92): Buffer {
  const rgba = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    rgba[4 * i] = img.data[3 * i];
    rgba[4 * i + 1] = img.data[3 * i + 1];
    rgba[4 * i + 2] = img.data[3 * i + 2];
    rgba[4 * i + 3] = 255;
  }
  return jpeg.encode({ width: img.width, height: img.height, data: rgba }, quality).data;
}

/** Independent restatement of protocol.md: texel (i, j) covers disc x0 + [i, i+1)/res, y0 + [j, j+1)/res, and the
 *  cover's square [0, side) spans disc [-123.9, 123.9]. Returns the source rectangle in pixels. */
export const SPECS: Record<string, [number, number, number, number, number]> = {
  home: [152, 136, 0.8, -65, -45],
  flight: [112, 112, 112 / 247.8, -123.9, -123.9],
  sq160: [160, 160, 160 / 247.8, -123.9, -123.9],
  sq36: [36, 36, 36 / 247.8, -123.9, -123.9],
};
export function texelRect(variant: string, i: number, j: number, side = 640): [number, number, number, number] {
  const [, , res, x0, y0] = SPECS[variant];
  const px = (d: number) => ((d + 123.9) * side) / 247.8;
  return [px(x0 + i / res), px(x0 + (i + 1) / res), px(y0 + j / res), px(y0 + (j + 1) / res)];
}

/** Exact 2-D area average of the pixels under [u0, u1) x [v0, v1), edge pixels repeated outside. */
export function boxAverage(img: RgbImage, u0: number, u1: number, v0: number, v1: number): [number, number, number] {
  const acc = [0, 0, 0];
  let tot = 0;
  for (let y = Math.floor(v0); y < v1; y++) {
    const oy = Math.min(v1, y + 1) - Math.max(v0, y);
    if (oy <= 0) continue;
    const yc = Math.min(img.height - 1, Math.max(0, y));
    for (let x = Math.floor(u0); x < u1; x++) {
      const ox = Math.min(u1, x + 1) - Math.max(u0, x);
      if (ox <= 0) continue;
      const xc = Math.min(img.width - 1, Math.max(0, x));
      const w = ox * oy;
      const p = (yc * img.width + xc) * 3;
      acc[0] += img.data[p] * w;
      acc[1] += img.data[p + 1] * w;
      acc[2] += img.data[p + 2] * w;
      tot += w;
    }
  }
  return [acc[0] / tot, acc[1] / tot, acc[2] / tot];
}

export function refRgb565(r: number, g: number, b: number, i: number, j: number): number {
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const t = bayer[j & 3][i & 3];
  r = Math.min(255, r + (t >> 1));
  g = Math.min(255, g + (t >> 2));
  b = Math.min(255, b + (t >> 1));
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

export class FakeClock implements Clock {
  w = 1_731_500_000_000;
  m = 1_000_000;
  wall() {
    return this.w;
  }
  mono() {
    return this.m;
  }
  advance(ms: number) {
    this.w += ms;
    this.m += ms;
  }
}

export function track(id: string, opts: { dur?: number; artUrl?: string } = {}) {
  const art = opts.artUrl ?? COVER_URL;
  return {
    type: "track",
    id,
    name: `Song ${id}`,
    duration_ms: opts.dur ?? 300_000,
    artists: [{ name: "Artist A" }, { name: "Artist B" }],
    album: {
      images: [
        { url: `${art}-64`, width: 64, height: 64 },
        { url: art, width: 640, height: 640 },
        { url: `${art}-300`, width: 300, height: 300 },
      ],
    },
  };
}

type Answer = Response | Error | (() => Response);

/** Stands in for fetch: the token endpoint, the player, the queue and the cover CDN. Anything else fails the test. */
export class FakeSpotify {
  player: Record<string, unknown> | null = null; // null -> 204
  queue: unknown[] = [];
  calls: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
  script: { prefix: string; answer: Answer }[] = []; // used once each, before the defaults
  tokenAnswer: (() => Response) | null = null;
  jpeg = encodeJpeg(syntheticCover());
  nTokens = 0;

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push({ method: init.method ?? "GET", url, headers, body: typeof init.body === "string" ? init.body : "" });
    const n = this.script.findIndex((s) => url.startsWith(s.prefix));
    if (n >= 0) {
      const [s] = this.script.splice(n, 1);
      if (s.answer instanceof Error) throw s.answer;
      return typeof s.answer === "function" ? s.answer() : s.answer;
    }
    if (url === TOKEN_URL) {
      this.nTokens++;
      if (this.tokenAnswer) return this.tokenAnswer();
      return json(200, { access_token: `AT${this.nTokens}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === CURRENTLY_PLAYING_URL) {
      if (!String(headers.Authorization ?? "").startsWith("Bearer AT")) throw new Error("no bearer token");
      return this.player === null ? new Response(null, { status: 204 }) : json(200, this.player);
    }
    if (url === QUEUE_URL) return json(200, { currently_playing: null, queue: this.queue });
    if (url.startsWith("https://i.scdn.co/")) return new Response(new Uint8Array(this.jpeg), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    throw new Error(`a test tried to reach ${url}`);
  };

  count(url: string): number {
    return this.calls.filter((c) => c.url === url).length;
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function testKey(): string {
  return randomBytes(48).toString("base64url") + "-test-only"; // generated per run: no key lives in the repository
}

export interface Harness {
  app: App;
  fake: FakeSpotify;
  clock: FakeClock | Clock;
  fakeClock: FakeClock;
  cfg: Config;
  dir: string;
  cleanup(): Promise<void>;
}

export function makeApp(opts: { linked?: boolean; realClock?: boolean; clientSecret?: string; redirectUri?: string } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavelet-test-"));
  if (opts.linked !== false) fs.writeFileSync(path.join(dir, "token.json"), JSON.stringify({ refresh_token: "RT0" }));
  const cfg: Config = {
    apiKey: testKey(),
    clientId: "test-client-id",
    clientSecret: opts.clientSecret ?? null,
    redirectUri: opts.redirectUri ?? "http://127.0.0.1:8888/callback",
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
  };
  const fake = new FakeSpotify();
  const fakeClock = new FakeClock();
  const clock = opts.realClock ? systemClock : fakeClock;
  const app = new App(cfg, { clock, fetch: fake.fetch });
  return {
    app,
    fake,
    clock,
    fakeClock,
    cfg,
    dir,
    async cleanup() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function play(fake: FakeSpotify, id: string, progress: number, opts: { playing?: boolean; dur?: number } = {}) {
  fake.player = { is_playing: opts.playing ?? true, progress_ms: progress, item: track(id, { dur: opts.dur }), currently_playing_type: "track" };
}

export interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A raw HTTP request (no cookies, no automatic auth), so tests see exactly what the server sends. */
export function hit(port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}
