/* Polling Spotify, frugally: the development-mode quota is shared by the whole developer account.
 *
 * Playing: every 3 s, plus a poll at the predicted end of the track (+300 ms), then 1 s and 2 s after that while Spotify
 * still reports the old track. Paused or idle: every 5 s for 10 minutes after the last playback, then every 15 s.
 * The queue: when the current track changes, and every 30 s while playing. */
import type { App } from "./app.js";
import { CURRENTLY_PLAYING_URL, Item, NotLinked, QUEUE_URL, RateLimited, TransientError, errorCode, parseItem, rateLimited } from "./spotify.js";
import { HttpResult, NetworkError, errName, jsonOf, log, request } from "./util.js";

type Kind = "tick" | "end" | "follow" | "idle";

export class Poller {
  static readonly TICK_MS = 3000;
  static readonly END_SLACK_MS = 300;
  static readonly IDLE_FAST_MS = 5000;
  static readonly IDLE_SLOW_MS = 15000;
  static readonly IDLE_FAST_FOR_MS = 10 * 60 * 1000;
  static readonly QUEUE_EVERY_MS = 30000;
  static readonly QUEUE_LEN = 6;
  static readonly NET_BACKOFF_MS = [5000, 10000, 20000, 30000];
  static readonly QUOTA_FIRST_MS = 60_000;
  static readonly QUOTA_MAX_MS = 30 * 60 * 1000;
  static readonly UNLINKED_WAIT_MS = 30000;

  // schedule
  kind: Kind = "tick"; // what the poll about to run is for
  private firedAt = 0;
  private endId: string | null = null; // the track the next "end" poll is for
  private endSpent: string | null = null; // the track whose end (and follow-ups) were polled already
  private followups: number[] = [];
  lastPlay: number;
  // queue
  queueDue = true;
  private lastQueue = -1e12;
  private queueItems: { item: Item; url: string | null }[] = [];
  // backoff
  private netFails = 0;
  private quotaMs = 0;
  // for the admin page
  lastPollWall: number | null = null;
  lastResult = "not yet";
  backoffUntilWall: number | null = null;
  backoffReason = "";
  calls = 0;
  // the loop
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private wakeUp: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly app: App) {
    this.lastPlay = app.clock.mono(); // start counts as activity: the fast idle cadence for the first 10 minutes
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    await this.loop;
  }

  wake(): void {
    this.wakeUp?.();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let delay: number;
      try {
        delay = await this.step();
      } catch (e) {
        log.error(`poller: unexpected error: ${errName(e)}`);
        delay = 10000;
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        this.wakeUp = () => {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.wakeUp = null;
          resolve();
        };
        this.timer = setTimeout(() => this.wakeUp?.(), delay);
      });
    }
  }

  /** One poll (if linked); returns the delay to the next one, in ms. */
  async step(): Promise<number> {
    const app = this.app;
    if (!app.auth.linked) {
      app.state.setLinked(false);
      this.lastResult = "not linked";
      this.backoffUntilWall = null;
      this.backoffReason = "";
      return Poller.UNLINKED_WAIT_MS;
    }
    let delay: number;
    try {
      delay = await this.pollOnce();
    } catch (e) {
      if (e instanceof NotLinked) {
        app.state.setLinked(false);
        this.lastResult = "not linked (Spotify refused the refresh token)";
        return Poller.UNLINKED_WAIT_MS;
      }
      if (e instanceof RateLimited) {
        const raMs = e.retryAfterS === null ? null : e.retryAfterS * 1000;
        if (e.quota) {
          this.quotaMs = this.quotaMs ? Math.min(Poller.QUOTA_MAX_MS, this.quotaMs * 2) : Poller.QUOTA_FIRST_MS;
          return this.backoff(Math.max(this.quotaMs, raMs ?? 0), "quota exceeded (429)");
        }
        return this.backoff(Math.min(3_600_000, Math.max(1000, raMs ?? 5000)), "rate limited (429)");
      }
      if (e instanceof NetworkError || e instanceof TransientError || e instanceof SyntaxError) {
        const d = Poller.NET_BACKOFF_MS[Math.min(this.netFails, Poller.NET_BACKOFF_MS.length - 1)];
        this.netFails++;
        return this.backoff(d, `${e.constructor.name}: ${e.message}`);
      }
      throw e;
    }
    this.netFails = 0;
    this.quotaMs = 0;
    this.backoffUntilWall = null;
    this.backoffReason = "";
    return delay;
  }

  private backoff(delayMs: number, reason: string): number {
    log.warn(`spotify: ${reason}; next try in ${Math.round(delayMs / 1000)} s`);
    this.lastResult = reason;
    this.backoffUntilWall = this.app.clock.wall() + delayMs;
    this.backoffReason = reason;
    this.kind = "tick";
    return delayMs;
  }

  private async api(url: string): Promise<HttpResult> {
    const auth = this.app.auth;
    const get = async (tok: string) => {
      this.calls++;
      return request(this.app.fetch, "GET", url, { headers: { Authorization: `Bearer ${tok}` }, timeoutMs: 10000 });
    };
    let res = await get(await auth.access());
    if (res.status === 401) res = await get(await auth.access(true));
    if (res.status === 429) throw rateLimited(res);
    if (res.status === 200 || res.status === 204) return res;
    const what = url.split("/v1")[1]?.split("?")[0] ?? url;
    throw new TransientError(`${what}: HTTP ${res.status} ${errorCode(res)}`);
  }

  /** Read the player (and the queue when due), apply it, and return the delay to the next poll. */
  async pollOnce(): Promise<number> {
    const { state, clock, covers } = this.app;
    const kind = this.kind;
    const t0 = clock.mono();
    this.firedAt = t0;
    const res = await this.api(CURRENTLY_PLAYING_URL);
    const t1 = clock.mono();
    const at = (t0 + t1) / 2;
    let playing = false;
    let track: Item | null = null;
    let url: string | null = null;
    let progress = 0;
    if (res.status === 200 && res.body.length) {
      const j = jsonOf(res) as Record<string, unknown> | null;
      if (!j || typeof j !== "object") throw new TransientError("currently-playing: not JSON");
      playing = j.is_playing === true;
      const p = parseItem(j.item);
      if (p) ({ item: track, url } = p);
      progress = Math.max(0, Math.trunc(Number(j.progress_ms) || 0));
    }
    this.lastPollWall = clock.wall();
    this.lastResult = `HTTP ${res.status}`;

    if ((state.track?.id ?? null) !== (track?.id ?? null)) this.queueDue = true;
    let queue: Item[] | null = null;
    let queueError: unknown = null;
    if (!track) {
      queue = [];
      this.queueDue = false;
      this.queueItems = [];
    } else if (this.queueDue || (playing && t1 - this.lastQueue >= Poller.QUEUE_EVERY_MS)) {
      try {
        queue = await this.readQueue();
        this.queueDue = false;
        this.lastQueue = clock.mono();
      } catch (e) {
        if (e instanceof NotLinked) throw e;
        queueError = e;
      }
    }
    // one update, so a song change and its new queue arrive under one version
    state.updatePlayer(playing, track, progress, at, queue);

    if (track && url) covers.want(track.art, url);
    for (const q of this.queueItems) if (q.url) covers.want(q.item.art, q.url);

    if (queueError) throw queueError;
    const remaining = track ? Math.max(0, track.duration_ms - progress) : 0;
    return this.schedule(kind, t1, playing && track !== null, track?.id ?? null, remaining);
  }

  private async readQueue(): Promise<Item[]> {
    const res = await this.api(QUEUE_URL);
    const items: { item: Item; url: string | null }[] = [];
    if (res.status === 200 && res.body.length) {
      const j = jsonOf(res) as { queue?: unknown } | null;
      if (!j || typeof j !== "object") throw new TransientError("queue: not JSON");
      for (const it of Array.isArray(j.queue) ? j.queue : []) {
        const p = parseItem(it);
        if (p) items.push(p);
        if (items.length >= Poller.QUEUE_LEN) break;
      }
    }
    this.queueItems = items;
    return items.map((p) => p.item);
  }

  private schedule(kind: Kind, now: number, playing: boolean, id: string | null, remainingMs: number): number {
    if (!playing) {
      this.followups = [];
      this.endId = null;
      this.endSpent = null;
      this.kind = "idle";
      return now - this.lastPlay < Poller.IDLE_FAST_FOR_MS ? Poller.IDLE_FAST_MS : Poller.IDLE_SLOW_MS;
    }
    this.lastPlay = now;
    if ((kind === "end" || kind === "follow") && id === this.endId) {
      // the predicted end has passed and Spotify still reports the same track
      if (kind === "end") {
        this.followups = [this.firedAt + 1000, this.firedAt + 2000];
        this.endSpent = id;
      }
      if (this.followups.length && remainingMs < Poller.TICK_MS + 2000) {
        this.kind = "follow";
        return Math.max(50, this.followups.shift()! - now);
      }
    }
    this.followups = [];
    if (id === this.endSpent && remainingMs < 5000) {
      this.kind = "tick"; // its end was polled already; the regular cadence picks up the change
      return Poller.TICK_MS;
    }
    this.endSpent = null;
    this.endId = id;
    const endIn = remainingMs + Poller.END_SLACK_MS;
    if (endIn < Poller.TICK_MS) {
      this.kind = "end";
      return Math.max(50, endIn);
    }
    this.kind = "tick";
    return Poller.TICK_MS;
  }
}
