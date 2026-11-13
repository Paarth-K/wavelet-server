/* The app: configuration, state, Spotify sign-in, covers and the poller, wired together. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { Covers } from "./covers.js";
import { Poller } from "./poller.js";
import { SpotifyAuth } from "./spotify.js";
import { State, cleanGeo, type Geo } from "./state.js";
import { type Clock, type FetchFn, readJson, systemClock, writePrivate } from "./util.js";

export interface AppOptions {
  clock?: Clock;
  fetch?: FetchFn;
}

export class App {
  readonly clock: Clock;
  readonly fetch: FetchFn;
  readonly state: State;
  readonly auth: SpotifyAuth;
  readonly covers: Covers;
  readonly poller: Poller;
  readonly csrf = randomBytes(16).toString("hex");
  flash: { kind: "ok" | "err"; text: string } | null = null;
  private readonly geoFile: string;

  constructor(readonly cfg: Config, opts: AppOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    this.geoFile = path.join(cfg.dataDir, "geo.json");
    this.state = new State(this.clock, cleanGeo(readJson(this.geoFile)));
    this.auth = new SpotifyAuth(this);
    this.state.linked = this.auth.linked;
    this.covers = new Covers(this);
    this.poller = new Poller(this);
  }

  onLinked(): void {
    this.poller.kind = "tick";
    this.poller.queueDue = true;
    this.poller.lastPlay = this.clock.mono();
    this.poller.wake();
  }

  unlink(): void {
    this.auth.unlink();
    this.state.setLinked(false);
  }

  setGeo(geo: Geo): void {
    writePrivate(this.geoFile, JSON.stringify(geo, null, 2) + "\n");
    this.state.setGeo(geo);
  }

  async close(): Promise<void> {
    await this.poller.stop();
    await this.covers.idle();
  }
}
