import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Poller } from "../src/poller.js";
import { CURRENTLY_PLAYING_URL, QUEUE_URL } from "../src/spotify.js";
import { DEFAULT_GEO } from "../src/state.js";
import { artKey } from "../src/texture.js";
import { COVER_URL, type Harness, json, makeApp, play, track } from "./helpers.js";

describe("state and polling", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeApp();
  });
  afterEach(async () => {
    await h.cleanup();
  });
  const poll = () => h.app.poller.pollOnce();
  const adv = (ms: number) => h.fakeClock.advance(ms);

  it("bumps the version only on changes worth showing", async () => {
    const s = h.app.state;
    h.fake.queue = [track("q1"), track("q2")];
    play(h.fake, "t1", 10_000);
    let v = s.v;
    await poll();
    assert.equal(s.v, v + 1, "new track");
    let snap = s.snapshot();
    assert.equal(snap.linked, true);
    assert.equal(snap.playing, true);
    assert.equal(snap.track?.id, "t1");
    assert.equal(snap.track?.artist, "Artist A, Artist B");
    assert.equal(snap.track?.art, artKey(COVER_URL));
    assert.deepEqual(snap.queue.map((q) => q.id), ["q1", "q2"]);
    assert.deepEqual(Object.keys(snap.queue[0]).sort(), ["art", "artist", "duration_ms", "id", "title"]);

    v = s.v;
    adv(3000);
    play(h.fake, "t1", 13_000);
    await poll();
    assert.equal(s.v, v, "same track");
    adv(1500);
    assert.equal(s.snapshot().track?.progress_ms, 14_500, "progress extrapolated at reply time");

    adv(1500);
    play(h.fake, "t1", 16_800);
    await poll();
    assert.equal(s.v, v, "small drift (0.8 s)");

    adv(3000);
    play(h.fake, "t1", 29_800);
    await poll();
    assert.equal(s.v, v + 1, "a 10 s seek");

    v = s.v;
    adv(3000);
    play(h.fake, "t1", 32_800, { playing: false });
    await poll();
    assert.equal(s.v, v + 1, "pause");
    assert.equal(s.snapshot().playing, false);
    adv(5000);
    assert.equal(s.snapshot().track?.progress_ms, 32_800, "paused progress stays put");
    await poll();
    assert.equal(s.v, v + 1, "still paused");
    adv(5000);
    play(h.fake, "t1", 32_800);
    await poll();
    assert.equal(s.v, v + 2, "resume");

    // a queue change, caught by the 30 s queue poll while playing
    v = s.v;
    let nq = h.fake.count(QUEUE_URL);
    h.fake.queue = [track("q1"), track("qX"), track("q2")];
    adv(3000);
    play(h.fake, "t1", 35_800);
    await poll();
    assert.equal(h.fake.count(QUEUE_URL), nq, "queue not due yet");
    assert.equal(s.v, v);
    adv(28_000);
    play(h.fake, "t1", 63_800);
    await poll();
    assert.equal(h.fake.count(QUEUE_URL), nq + 1);
    assert.equal(s.v, v + 1, "queue ids changed");
    assert.deepEqual(s.snapshot().queue.map((q) => q.id), ["q1", "qX", "q2"]);
    adv(31_000);
    play(h.fake, "t1", 94_800);
    await poll();
    assert.equal(s.v, v + 1, "same queue ids: no bump");

    // a new track: one bump, with its queue read in the same pass
    v = s.v;
    nq = h.fake.count(QUEUE_URL);
    h.fake.queue = [track("qX"), track("q2")];
    adv(3000);
    play(h.fake, "q1", 500);
    await poll();
    assert.equal(s.v, v + 1, "new track");
    assert.equal(h.fake.count(QUEUE_URL), nq + 1);
    assert.deepEqual(s.snapshot().queue.map((q) => q.id), ["qX", "q2"]);

    // nothing loaded (204)
    v = s.v;
    h.fake.player = null;
    adv(3000);
    await poll();
    assert.equal(s.v, v + 1);
    snap = s.snapshot();
    assert.equal(snap.track, null);
    assert.equal(snap.playing, false);
    assert.deepEqual(snap.queue, []);

    // geometry
    v = s.v;
    h.app.setGeo({ ...DEFAULT_GEO, gap_mm: 12.5 });
    assert.equal(s.v, v + 1);
    assert.equal(s.snapshot().geo.gap_mm, 12.5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "geo.json"), "utf8")).gap_mm, 12.5);
    h.app.setGeo({ ...DEFAULT_GEO, gap_mm: 12.5 });
    assert.equal(s.v, v + 1, "same geometry again: no bump");
  });

  it("replaying the same track counts as a seek", async () => {
    play(h.fake, "t1", 298_000);
    await poll();
    const v = h.app.state.v;
    adv(3000);
    play(h.fake, "t1", 1000);
    await poll();
    assert.equal(h.app.state.v, v + 1);
  });

  it("keeps the first six queue items", async () => {
    h.fake.queue = Array.from({ length: 10 }, (_, n) => track(`q${n}`));
    play(h.fake, "t1", 0);
    await poll();
    assert.deepEqual(h.app.state.snapshot().queue.map((q) => q.id), ["q0", "q1", "q2", "q3", "q4", "q5"]);
  });

  it("reads episodes (show name, show image when the episode has none)", async () => {
    h.fake.player = {
      is_playing: true, progress_ms: 1000, currently_playing_type: "episode",
      item: { type: "episode", id: "e1", name: "Episode One", duration_ms: 3_600_000, images: [],
        show: { name: "The Show", images: [{ url: "https://i.scdn.co/image/show", width: 640, height: 640 }] } },
    };
    await poll();
    const t = h.app.state.snapshot().track!;
    assert.deepEqual([t.title, t.artist, t.art], ["Episode One", "The Show", artKey("https://i.scdn.co/image/show")]);
  });

  it("art is null without an image; local files use their uri", async () => {
    play(h.fake, "t1", 0);
    const item = (h.fake.player!.item as Record<string, unknown>);
    (item.album as { images: unknown[] }).images = [];
    item.id = null;
    item.uri = "spotify:local:a:b:c:180";
    await poll();
    const t = h.app.state.snapshot().track!;
    assert.equal(t.art, null);
    assert.equal(t.id, "spotify:local:a:b:c:180");
  });

  it("polls on the protocol's cadence", async () => {
    const p = h.app.poller;
    play(h.fake, "t1", 100_000);
    assert.equal(await poll(), 3000);
    adv(3000);
    play(h.fake, "t1", 298_000);
    assert.equal(await poll(), 2300, "the predicted end + 300 ms");
    assert.equal(p.kind, "end");
    adv(2300);
    play(h.fake, "t1", 300_000);
    assert.equal(await poll(), 1000, "still the old track: 1 s after the end poll");
    assert.equal(p.kind, "follow");
    adv(1000);
    assert.equal(await poll(), 1000, "and 2 s after it");
    adv(1000);
    assert.equal(await poll(), 3000, "then the normal cadence");
    adv(3000);
    assert.equal(await poll(), 3000);
    adv(3000);
    play(h.fake, "t2", 1000, { dur: 200_000 });
    assert.equal(await poll(), 3000);
    adv(3000);
    play(h.fake, "t2", 199_000, { dur: 200_000 });
    assert.equal(await poll(), 1300);
    adv(1300);
    play(h.fake, "t3", 200);
    assert.equal(await poll(), 3000, "an end poll that finds the next track goes straight back");
    adv(3000);
    play(h.fake, "t3", 3200, { playing: false });
    assert.equal(await poll(), 5000, "paused: 5 s");
    adv(590_000);
    assert.equal(await poll(), 5000);
    adv(15_000);
    assert.equal(await poll(), 15_000, "10 minutes after playback: 15 s");
    h.fake.player = null;
    adv(15_000);
    assert.equal(await poll(), 15_000);
  });

  it("backs off on QUOTA_EXCEEDED 60 s doubling to 30 min, and honours Retry-After", async () => {
    const quota = () => json(429, { error: { status: 429, reason: "QUOTA_EXCEEDED" } });
    play(h.fake, "t1", 0);
    const delays = [];
    for (let k = 0; k < 7; k++) {
      h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: quota });
      delays.push(await h.app.poller.step());
    }
    assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
    assert.equal(await h.app.poller.step(), 3000, "success resets it");
    h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: quota });
    assert.equal(await h.app.poller.step(), 60_000);
    h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: () => new Response("", { status: 429, headers: { "Retry-After": "7" } }) });
    assert.equal(await h.app.poller.step(), 7000, "a plain 429: Retry-After");
    h.fake.script.push({
      prefix: CURRENTLY_PLAYING_URL,
      answer: () => json(429, { error: { reason: "QUOTA_EXCEEDED" } }, { "Retry-After": "500" }),
    });
    assert.equal(await h.app.poller.step(), 500_000, "a quota 429 with a longer Retry-After: the longer");
  });

  it("backs off 5, 10, 20, 30 s on network errors", async () => {
    play(h.fake, "t1", 0);
    const delays = [];
    for (let k = 0; k < 5; k++) {
      h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: new TypeError("fetch failed") });
      delays.push(await h.app.poller.step());
    }
    assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000]);
    assert.equal(await h.app.poller.step(), 3000);
    h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: new TypeError("fetch failed") });
    assert.equal(await h.app.poller.step(), 5000);
    h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: () => new Response("oops", { status: 502 }) });
    assert.equal(await h.app.poller.step(), 10000, "5xx counts as trouble too");
  });

  it("refreshes the token once on a 401 and retries", async () => {
    play(h.fake, "t1", 0);
    await poll();
    assert.equal(h.fake.nTokens, 1);
    h.fake.script.push({ prefix: CURRENTLY_PLAYING_URL, answer: () => json(401, { error: { status: 401 } }) });
    adv(3000);
    play(h.fake, "t1", 3000);
    await poll();
    assert.equal(h.fake.nTokens, 2);
    assert.equal(h.app.state.snapshot().track?.id, "t1");
  });

  it("saves a rotated refresh token; invalid_grant unlinks", async () => {
    h.fake.tokenAnswer = () => json(200, { access_token: "AT9", expires_in: 3600, refresh_token: "RT1" });
    play(h.fake, "t1", 0);
    await poll();
    const tokenFile = path.join(h.dir, "token.json");
    assert.equal(JSON.parse(fs.readFileSync(tokenFile, "utf8")).refresh_token, "RT1");
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    h.fake.tokenAnswer = () => json(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
    h.app.auth.accessToken = null;
    const v = h.app.state.v;
    assert.equal(await h.app.poller.step(), Poller.UNLINKED_WAIT_MS);
    assert.equal(h.app.auth.linked, false);
    assert.equal(fs.existsSync(tokenFile), false);
    const snap = h.app.state.snapshot();
    assert.equal(snap.linked, false);
    assert.equal(snap.track, null);
    assert.ok(snap.v > v, "the linked flag change bumps");
  });

  it("does not call Spotify while unlinked", async () => {
    h.app.unlink();
    const n = h.fake.calls.length;
    assert.equal(await h.app.poller.step(), Poller.UNLINKED_WAIT_MS);
    assert.equal(h.fake.calls.length, n);
  });
});
