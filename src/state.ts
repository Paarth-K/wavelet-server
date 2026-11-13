/* The versioned state the boards long-poll (protocol.md, "GET /api/state"). */
import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { Item } from "./spotify.js";
import type { Clock } from "./util.js";

export interface Geo {
  s3_left_mm: number;
  gap_mm: number;
  drop_ms: number;
  exit_ms: number;
  back: number;
}

export const DEFAULT_GEO: Geo = { s3_left_mm: -1.5, gap_mm: 14.0, drop_ms: 1000, exit_ms: 420, back: 1.2 };

/** name: [integer?, min, max] */
export const GEO_LIMITS: Record<keyof Geo, [boolean, number, number]> = {
  s3_left_mm: [false, -60, 60],
  gap_mm: [false, 0, 200],
  drop_ms: [true, 100, 10000],
  exit_ms: [true, 0, 5000],
  back: [false, 0, 5],
};

export function cleanGeo(raw: unknown): Geo {
  const g = { ...DEFAULT_GEO };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULT_GEO) as (keyof Geo)[]) {
      const v = Number((raw as Record<string, unknown>)[k]);
      const [int, lo, hi] = GEO_LIMITS[k];
      if (Number.isFinite(v) && v >= lo && v <= hi) g[k] = int ? Math.round(v) : v;
    }
  }
  return g;
}

export interface TrackOut extends Item {
  progress_ms: number;
}

export interface Snapshot {
  v: number;
  server_ms: number;
  linked: boolean;
  playing: boolean;
  track: TrackOut | null;
  queue: Item[];
  geo: Geo;
}

export class State extends EventEmitter {
  static readonly SEEK_MS = 2000;
  /** starts at random, so a board holding a version from before a restart is very unlikely to match by accident */
  v = randomInt(1, 1_000_000);
  linked = false;
  playing = false;
  track: Item | null = null;
  queue: Item[] = [];
  geo: Geo;
  changedWall: number;
  private progressMs = 0; // at progressMono
  private progressMono: number;

  constructor(private readonly clock: Clock, geo: Geo) {
    super();
    this.setMaxListeners(0);
    this.geo = { ...geo };
    this.progressMono = clock.mono();
    this.changedWall = clock.wall();
  }

  private bump(): void {
    this.v += 1;
    this.changedWall = this.clock.wall();
    this.emit("change");
  }

  private progressAt(mono: number): number {
    if (!this.track) return 0;
    let p = this.progressMs;
    if (this.playing) p += Math.trunc(mono - this.progressMono);
    const d = this.track.duration_ms;
    if (d > 0) p = Math.min(p, d);
    return Math.max(0, p);
  }

  setLinked(linked: boolean): void {
    let changed = linked !== this.linked;
    this.linked = linked;
    if (!linked && (this.track || this.queue.length || this.playing)) {
      this.track = null;
      this.queue = [];
      this.playing = false;
      changed = true;
    }
    if (changed) this.bump();
  }

  /** One reading of the player (and, if given, of the queue). Returns whether the version moved. */
  updatePlayer(playing: boolean, track: Item | null, progressMs: number, atMono: number, queue: Item[] | null): boolean {
    let changed = !this.linked;
    this.linked = true;
    const oldId = this.track?.id ?? null;
    const newId = track?.id ?? null;
    if (oldId !== newId || playing !== this.playing) changed = true;
    else if (track && Math.abs(progressMs - this.progressAt(atMono)) > State.SEEK_MS) changed = true;
    if (queue !== null) {
      const a = queue.map((q) => q.id).join("\u0000");
      const b = this.queue.map((q) => q.id).join("\u0000");
      if (a !== b || queue.length !== this.queue.length) changed = true;
      this.queue = queue;
    }
    this.track = track;
    this.playing = playing;
    this.progressMs = track ? Math.trunc(progressMs) : 0;
    this.progressMono = atMono;
    if (changed) this.bump();
    return changed;
  }

  setGeo(geo: Geo): void {
    const same = (Object.keys(DEFAULT_GEO) as (keyof Geo)[]).every((k) => geo[k] === this.geo[k]);
    if (!same) {
      this.geo = { ...geo };
      this.bump();
    }
  }

  snapshot(): Snapshot {
    const t = this.track;
    return {
      v: this.v,
      server_ms: Math.trunc(this.clock.wall()),
      linked: this.linked,
      playing: this.playing,
      track: t
        ? { id: t.id, title: t.title, artist: t.artist, duration_ms: t.duration_ms, progress_ms: this.progressAt(this.clock.mono()), art: t.art }
        : null,
      queue: this.queue.map((q) => ({ id: q.id, title: q.title, artist: q.artist, duration_ms: q.duration_ms, art: q.art })),
      geo: { ...this.geo },
    };
  }

  /** The state: at once if its version differs from v, else after the next change or timeoutMs. */
  wait(v: number | null, timeoutMs: number, signal?: AbortSignal): Promise<Snapshot> {
    if (v === null || v !== this.v || timeoutMs <= 0) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("change", done);
        signal?.removeEventListener("abort", done);
        resolve(this.snapshot());
      };
      const timer = setTimeout(done, timeoutMs);
      this.on("change", done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
