/* Covers: each downloaded once, every variant made eagerly; decoded variants in an LRU, the original JPEG on disk. */
import fs from "node:fs";
import path from "node:path";
import type { App } from "./app.js";
import { KEY_RE, isVariant, makeVariants, type Variants } from "./texture.js";
import { errName, log, request, writePrivate } from "./util.js";

export class Covers {
  static readonly LRU_KEYS = 40;
  static readonly DISK_KEEP = 500;
  static readonly RETRY_FAILED_MS = 60_000;
  static readonly RETRY_ON_ASK_MS = 10_000;
  static readonly MAX_BYTES = 8 * 1024 * 1024;
  static readonly WORKERS = 3;

  readonly dir: string;
  private readonly urls = new Map<string, string>(); // everything seen this run
  readonly cache = new Map<string, Variants>(); // insertion order = LRU order
  private readonly busy = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, number>(); // key -> mono ms of the failure
  private readonly queue: (() => void)[] = [];
  private running = 0;

  constructor(private readonly app: App) {
    this.dir = path.join(app.cfg.dataDir, "covers");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.jpg`);
  }

  private touch(key: string): Variants | undefined {
    const v = this.cache.get(key);
    if (v) {
      this.cache.delete(key);
      this.cache.set(key, v);
    }
    return v;
  }

  /** Called for every key in the state: makes its textures if they aren't ready. */
  want(key: string | null, url: string | null): void {
    if (!key || !KEY_RE.test(key)) return;
    if (url) this.urls.set(key, url);
    if (this.touch(key)) return;
    this.start(key);
  }

  private start(key: string): Promise<void> | undefined {
    const b = this.busy.get(key);
    if (b) return b;
    const f = this.failed.get(key);
    if (f !== undefined && this.app.clock.mono() - f < Covers.RETRY_FAILED_MS) return undefined;
    const p = this.slot().then(() => this.work(key)).finally(() => {
      this.busy.delete(key);
      this.running--;
      this.queue.shift()?.();
    });
    this.busy.set(key, p);
    return p;
  }

  /** at most WORKERS covers at a time */
  private slot(): Promise<void> {
    if (this.running < Covers.WORKERS) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.queue.push(() => {
        this.running++;
        resolve();
      }),
    );
  }

  private async work(key: string): Promise<void> {
    const t0 = performance.now();
    let how = "";
    try {
      const file = this.file(key);
      let jpeg: Buffer;
      if (fs.existsSync(file)) {
        jpeg = fs.readFileSync(file);
        how = "disk";
      } else {
        const url = this.urls.get(key);
        if (!url) throw new Error("no url known");
        const res = await request(this.app.fetch, "GET", url, { timeoutMs: 20000, maxBytes: Covers.MAX_BYTES });
        if (res.status !== 200 || !res.body.length) throw new Error(`HTTP ${res.status}`);
        jpeg = res.body;
        how = `download ${Math.round(jpeg.length / 1024)} KB`;
      }
      const t1 = performance.now();
      const variants = makeVariants(jpeg);
      const t2 = performance.now();
      if (how !== "disk") {
        writePrivate(file, jpeg);
        this.prune();
      }
      this.failed.delete(key);
      this.cache.set(key, variants);
      while (this.cache.size > Covers.LRU_KEYS) this.cache.delete(this.cache.keys().next().value as string);
      log.info(`cover ${key}: ${how} ${Math.round(t1 - t0)} ms, textures ${Math.round(t2 - t1)} ms`);
    } catch (e) {
      log.warn(`cover ${key} failed: ${errName(e)}`);
      if (how === "disk") fs.rmSync(this.file(key), { force: true }); // unreadable cache file: fetch again next time
      this.failed.set(key, this.app.clock.mono());
    }
  }

  private prune(): void {
    try {
      const names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".jpg"));
      if (names.length <= Covers.DISK_KEEP) return;
      const files = names
        .map((n) => path.join(this.dir, n))
        .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      for (const f of files.slice(0, files.length - Covers.DISK_KEEP)) fs.rmSync(f.p, { force: true });
    } catch {
      /* best effort */
    }
  }

  /** 200 with the texture; 404 unknown key or variant (or it can't be made); 503 still in the making after timeoutMs. */
  async get(key: string, variant: string, timeoutMs = 10_000): Promise<{ status: 200 | 404 | 503; body?: Buffer }> {
    if (!isVariant(variant) || !KEY_RE.test(key)) return { status: 404 };
    const hit = this.touch(key);
    if (hit) return { status: 200, body: hit[variant] };
    if (!this.urls.has(key) && !fs.existsSync(this.file(key))) return { status: 404 };
    const f = this.failed.get(key);
    if (f !== undefined && !this.busy.has(key) && this.app.clock.mono() - f >= Covers.RETRY_ON_ASK_MS)
      this.failed.delete(key); // a board is asking: one more try now (at most every 10 s)
    const p = this.start(key);
    if (p) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)));
      await Promise.race([p, timeout]);
      clearTimeout(timer);
    }
    const done = this.touch(key);
    if (done) return { status: 200, body: done[variant] };
    return this.busy.has(key) ? { status: 503 } : { status: 404 };
  }

  /** resolves once no cover is being made (tests, shutdown) */
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.allSettled([...this.busy.values()]);
  }

  stats(): { cached: number; busy: number; failed: number } {
    return { cached: this.cache.size, busy: this.busy.size, failed: this.failed.size };
  }
}
