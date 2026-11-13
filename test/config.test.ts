import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../src/config.js";
import { hit, testKey } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(env: Record<string, string>, untilLine?: RegExp): Promise<{ code: number | null; out: string; err: string; port?: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    let port: number | undefined;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", async (c) => {
      out += c;
      const m = untilLine && untilLine.exec(out);
      if (m && port === undefined) {
        port = Number(m[1]);
        const r = await hit(port, "GET", "/healthz");
        out += `\n[healthz ${r.status}]`;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (c) => (err += c));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, port });
    });
  });
}

describe("configuration", () => {
  const base = { WAVELET_API_KEY: "k".repeat(64), SPOTIFY_CLIENT_ID: "cid" };

  it("reads the environment, with defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.port, 3000);
    assert.equal(c.clientSecret, null);
    assert.equal(c.redirectUri, "http://127.0.0.1:8888/callback");
    assert.equal(c.dataDir, path.resolve("./data"));
    const d = loadConfig({ ...base, PORT: "9001", DATA_DIR: "/tmp/w", SPOTIFY_REDIRECT_URI: "http://127.0.0.1:9999/cb" });
    assert.deepEqual([d.port, d.dataDir, d.redirectUri], [9001, "/tmp/w", "http://127.0.0.1:9999/cb"]);
    assert.equal(loadConfig({ ...base, SPOTIFY_CLIENT_SECRET: " s3cret " }).clientSecret, "s3cret");
  });

  it("refuses a missing or short key, or no client id", () => {
    assert.throws(() => loadConfig({ SPOTIFY_CLIENT_ID: "cid" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, WAVELET_API_KEY: "k".repeat(63) }), /at least 64/);
    assert.throws(() => loadConfig({ ...base, WAVELET_API_KEY: "k".repeat(60) + " abc" }), ConfigError);
    assert.throws(() => loadConfig({ WAVELET_API_KEY: base.WAVELET_API_KEY }), /SPOTIFY_CLIENT_ID/);
    assert.throws(() => loadConfig({ ...base, PORT: "eighty" }), /PORT/);
    assert.throws(() => loadConfig({ ...base, SPOTIFY_REDIRECT_URI: "myapp://cb" }), /http/);
  });

  it("the server will not start without WAVELET_API_KEY", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavelet-cfg-"));
    try {
      let r = await run({ SPOTIFY_CLIENT_ID: "cid", DATA_DIR: dir, PORT: "0" });
      assert.equal(r.code, 1);
      assert.match(r.err, /WAVELET_API_KEY/);
      assert.equal(r.out, "");
      r = await run({ SPOTIFY_CLIENT_ID: "cid", DATA_DIR: dir, PORT: "0", WAVELET_API_KEY: "Zq7tooShortKeyXy" });
      assert.equal(r.code, 1);
      assert.match(r.err, /at least 64/);
      assert.ok(!r.err.includes("Zq7tooShortKeyXy"), "the key itself is never printed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts with a good configuration and stops on SIGTERM", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavelet-cfg-"));
    const key = testKey();
    try {
      const r = await run({ SPOTIFY_CLIENT_ID: "cid", DATA_DIR: dir, PORT: "0", HOST: "127.0.0.1", WAVELET_API_KEY: key }, /on http:\/\/127\.0\.0\.1:(\d+)/);
      assert.ok(r.port && r.port > 0, r.out + r.err);
      assert.match(r.out, /\[healthz 200\]/);
      assert.equal(r.code, 0);
      assert.ok(!(r.out + r.err).includes(key), "the key is never logged");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
