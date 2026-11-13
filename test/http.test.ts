import assert from "node:assert/strict";
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer, stateJson } from "../src/http.js";
import { makeVariants } from "../src/texture.js";
import { COVER_URL, type Harness, hit, makeApp, play, track } from "./helpers.js";

describe("HTTP", () => {
  let h: Harness;
  let srv: http.Server;
  let port: number;
  let key: string;
  const basic = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;

  beforeEach(async () => {
    h = makeApp({ realClock: true });
    key = h.cfg.apiKey;
    srv = createServer(h.app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as { port: number }).port;
  });
  afterEach(async () => {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    await h.cleanup();
  });
  const api = (p: string, headers: Record<string, string> = {}) => hit(port, "GET", p, { "X-Wavelet-Key": key, ...headers });

  it("serves /healthz without auth", async () => {
    const r = await hit(port, "GET", "/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), "ok");
    assert.equal(r.headers["content-length"], "2");
    assert.equal(r.headers.connection, "close");
  });

  it("answers 401 with nothing else on every other route without the key", async () => {
    const wrong = key.slice(0, -1) + (key.endsWith("a") ? "b" : "a");
    for (const [method, p] of [
      ["GET", "/api/state"],
      ["GET", "/api/state?v=1&wait=5"],
      ["GET", "/api/img/0123456789abcdef/home"],
      ["GET", "/api/nope"],
      ["GET", "/"],
      ["POST", "/link"],
      ["POST", "/unlink"],
      ["POST", "/geo"],
      ["POST", "/bright"],
      ["GET", "/nope"],
      ["GET", "/favicon.ico"],
    ]) {
      const admin = ["/", "/link", "/unlink", "/geo", "/bright"].includes(p);
      for (const headers of [
        {},
        { "X-Wavelet-Key": wrong },
        { Authorization: basic("wavelet", wrong) },
        { Authorization: basic("wavelet", "") },
        { Authorization: "Bearer " + key },
        { "X-Forwarded-For": "127.0.0.1", "X-Forwarded-User": "wavelet", "X-Forwarded-Proto": "https" },
        // the key in the wrong place does not count either
        p.startsWith("/api/") ? { Authorization: basic("x", key) } : { "X-Wavelet-Key": key },
      ] as Record<string, string>[]) {
        const r = await hit(port, method, p, headers, method === "POST" ? "csrf=x" : undefined);
        assert.equal(r.status, 401, `${method} ${p} ${JSON.stringify(Object.keys(headers))}`);
        assert.equal(r.body.length, 0);
        assert.equal(r.headers["content-length"], "0");
        if (admin) assert.match(String(r.headers["www-authenticate"]), /^Basic /);
        else assert.equal(r.headers["www-authenticate"], undefined);
      }
    }
  });

  it("serves the state with the key, and the admin page with the key as Basic password (any user)", async () => {
    let r = await api("/api/state");
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers["content-length"]), r.body.length);
    assert.equal(r.headers.connection, "close");
    assert.match(String(r.headers["content-type"]), /^application\/json/);
    const j = JSON.parse(r.body.toString());
    assert.deepEqual(Object.keys(j), ["v", "server_ms", "linked", "playing", "track", "queue", "geo"]);
    assert.ok(Math.abs(j.server_ms - Date.now()) < 5000);
    assert.ok(r.body.toString().includes('"gap_mm":14.0'), "floats keep their decimal point");
    assert.deepEqual(j.geo, { s3_left_mm: -1.5, gap_mm: 14, drop_ms: 1000, exit_ms: 420, back: 1.2, s3_level: 16 });
    for (const user of ["wavelet", "anyone", ""]) {
      r = await hit(port, "GET", "/", { Authorization: basic(user, key) });
      assert.equal(r.status, 200);
      const page = r.body.toString();
      assert.ok(page.includes("State version"));
      assert.ok(!page.includes(key), "the page never shows the key");
      assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    }
  });

  it("caps request bodies at 8 KB", async () => {
    const r = await hit(port, "POST", "/geo", { Authorization: basic("w", key), "Content-Type": "application/x-www-form-urlencoded" }, "x=" + "a".repeat(9000));
    assert.equal(r.status, 413);
  });

  it("admin forms: CSRF token, geometry, unlink", async () => {
    const auth = { Authorization: basic("w", key), "Content-Type": "application/x-www-form-urlencoded" };
    const v = h.app.state.v;
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const geo = { s3_left_mm: "-2.25", gap_mm: "13", drop_ms: "900", exit_ms: "400", back: "1.1" };
    let r = await hit(port, "POST", "/geo", auth, form({ csrf: "stale", ...geo }));
    assert.equal(r.status, 303);
    assert.equal(h.app.state.v, v, "no CSRF token, no change");
    r = await hit(port, "POST", "/geo", auth, form({ csrf: h.app.csrf, ...geo, back: "99" }));
    assert.equal(h.app.state.v, v, "out of range");
    r = await hit(port, "POST", "/geo", auth, form({ csrf: h.app.csrf, ...geo }));
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    assert.equal(h.app.state.v, v + 1);
    const s = (await api("/api/state")).body.toString();
    assert.ok(s.includes('"geo":{"s3_left_mm":-2.25,"gap_mm":13.0,"drop_ms":900,"exit_ms":400,"back":1.1,"s3_level":16}'), s);
    assert.ok(fs.existsSync(path.join(h.dir, "geo.json")));
    // brightness: its own form, keeps the geometry; whole numbers 1..16 only
    for (const bad of ["0", "17", "8.5", ""]) {
      await hit(port, "POST", "/bright", auth, form({ csrf: h.app.csrf, s3_level: bad }));
      assert.equal(h.app.state.geo.s3_level, 16, `refused ${JSON.stringify(bad)}`);
    }
    r = await hit(port, "POST", "/bright", auth, form({ csrf: h.app.csrf, s3_level: "9" }));
    assert.equal(r.status, 303);
    assert.equal(h.app.state.v, v + 2);
    const s2 = (await api("/api/state")).body.toString();
    assert.ok(s2.includes('"geo":{"s3_left_mm":-2.25,"gap_mm":13.0,"drop_ms":900,"exit_ms":400,"back":1.1,"s3_level":9}'), s2);
    r = await hit(port, "POST", "/geo", auth, form({ csrf: h.app.csrf, ...geo, gap_mm: "15" }));
    assert.equal(h.app.state.geo.s3_level, 9, "saving the geometry keeps the brightness");
    const page0 = (await hit(port, "GET", "/", auth)).body.toString();
    assert.ok(page0.includes("<button name=s3_level value=9 class=on aria-pressed=true>9</button>"), "the page marks the level");
    assert.equal(h.app.auth.linked, true);
    await hit(port, "POST", "/unlink", auth, form({ csrf: h.app.csrf }));
    assert.equal(h.app.auth.linked, false);
    assert.equal(fs.existsSync(path.join(h.dir, "token.json")), false);
    const page = (await hit(port, "GET", "/", auth)).body.toString();
    assert.ok(page.includes("Link Spotify") && page.includes("https://accounts.spotify.com/authorize?"));
  });

  it("long-polls: returns at once on another version, waits on the current one, wakes on a change", async () => {
    const v = JSON.parse((await api("/api/state")).body.toString()).v;
    let t = performance.now();
    let j = JSON.parse((await api(`/api/state?v=${v - 1}&wait=10`)).body.toString());
    assert.ok(performance.now() - t < 1000);
    assert.equal(j.v, v);
    t = performance.now();
    j = JSON.parse((await api(`/api/state?v=${v}&wait=1`)).body.toString());
    assert.ok(performance.now() - t >= 950, "waited the full second");
    assert.equal(j.v, v);

    t = performance.now();
    let done = false;
    const waiting = api(`/api/state?v=${v}&wait=20`).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(done, false, "returned before any change");
    assert.equal((await hit(port, "GET", "/healthz")).status, 200, "other requests are not blocked");
    play(h.fake, "t1", 0);
    await h.app.poller.pollOnce(); // the poller is not blocked either
    const r = await waiting;
    assert.ok(performance.now() - t < 3000);
    j = JSON.parse(r.body.toString());
    assert.equal(j.v, v + 1);
    assert.equal(j.track.id, "t1");
    assert.equal(j.track.title, "Song t1");
  });

  it("caps wait at 25 s", async () => {
    const v = h.app.state.v;
    const t = performance.now();
    const p = api(`/api/state?v=${v}&wait=1000`);
    await new Promise((r) => setTimeout(r, 200));
    h.app.setGeo({ ...h.app.state.geo, back: 1.3 });
    await p;
    assert.ok(performance.now() - t < 2000);
    assert.equal(stateJson(h.app.state.snapshot()).includes('"back":1.3'), true);
  });

  it("serves textures: every variant, raw bytes, downloaded once, from disk after a restart", async () => {
    assert.equal((await api("/api/img/0123456789abcdef/home")).status, 404);
    play(h.fake, "t1", 0);
    h.fake.queue = [track("q1", { artUrl: "https://i.scdn.co/image/cover-b" })];
    await h.app.poller.pollOnce();
    const key = h.app.state.snapshot().track!.art!;
    let body: Buffer = Buffer.alloc(0);
    for (const [name, size] of [["home", 41344], ["flight", 25088], ["sq160", 51200], ["sq36", 2592]] as const) {
      const r = await api(`/api/img/${key}/${name}`);
      assert.equal(r.status, 200, name);
      assert.equal(r.headers["content-type"], "application/octet-stream");
      assert.equal(Number(r.headers["content-length"]), size);
      assert.equal(r.body.length, size);
      body = r.body;
    }
    assert.ok(body.equals(makeVariants(h.fake.jpeg).sq36));
    const qkey = h.app.state.snapshot().queue[0].art!;
    assert.equal((await api(`/api/img/${qkey}/sq36`)).body.length, 2592);
    assert.equal((await api(`/api/img/${key}/huge`)).status, 404);
    assert.equal((await api("/api/img/..%2F..%2Fetc/home")).status, 404);
    assert.equal(h.fake.count(COVER_URL), 1, "downloaded once");
    assert.ok(fs.existsSync(path.join(h.dir, "covers", `${key}.jpg`)));
    h.app.covers.cache.clear();
    const n = h.fake.calls.length;
    assert.equal((await api(`/api/img/${key}/home`)).status, 200);
    assert.equal(h.fake.calls.length, n, "from disk, no download");
  });

  it("answers 503 with Retry-After while a texture is still being made", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = h.fake.fetch;
    h.app.covers.want("00000000000000aa", "https://i.scdn.co/image/slow");
    // the download above already went to the fake; make a slow one instead
    (h.app as unknown as { fetch: typeof orig }).fetch = async (u: string, i?: RequestInit) => {
      if (u.includes("/slow2")) await gate;
      return orig(u, i);
    };
    h.app.covers.want("00000000000000bb", "https://i.scdn.co/image/slow2");
    const t = performance.now();
    const r = await (async () => {
      const got = h.app.covers.get("00000000000000bb", "home", 300);
      return got;
    })();
    assert.equal(r.status, 503);
    assert.ok(performance.now() - t >= 250);
    release();
    const r2 = await h.app.covers.get("00000000000000bb", "home");
    assert.equal(r2.status, 200);
  });
});
