import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AuthError, TOKEN_URL } from "../src/spotify.js";
import { type Harness, json, makeApp } from "./helpers.js";

describe("Spotify linking (PKCE)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeApp({ linked: false });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("builds the authorize URL and finishes from the pasted redirect", async () => {
    const auth = h.app.auth;
    assert.equal(auth.linked, false);
    const url = auth.authorizeUrl();
    assert.ok(url.startsWith("https://accounts.spotify.com/authorize?"));
    assert.ok(url.includes("scope=user-read-currently-playing%20user-read-playback-state"));
    const q = new URL(url).searchParams;
    assert.equal(q.get("client_id"), "test-client-id");
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("redirect_uri"), "http://127.0.0.1:8888/callback");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("scope"), "user-read-currently-playing user-read-playback-state");
    const chal = createHash("sha256").update(auth.pending!.verifier).digest("base64url");
    assert.equal(q.get("code_challenge"), chal);
    assert.ok(auth.pending!.verifier.length >= 43 && auth.pending!.verifier.length <= 128);
    assert.equal(auth.authorizeUrl(), url, "the same link until it is used");
    const state = q.get("state")!;

    await assert.rejects(auth.complete("http://127.0.0.1:8888/callback?code=abc&state=wrong"), AuthError);
    await assert.rejects(auth.complete(`http://127.0.0.1:8888/callback?error=access_denied&state=${state}`), AuthError);
    await assert.rejects(auth.complete("nonsense"), AuthError);
    assert.equal(h.fake.nTokens, 0);

    const seen: Record<string, string> = {};
    h.fake.tokenAnswer = () => json(200, { access_token: "AT1", refresh_token: "RTnew", expires_in: 3600 });
    await auth.complete(`  http://127.0.0.1:8888/callback?code=THECODE&state=${state}  `);
    const call = h.fake.calls.at(-1)!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, TOKEN_URL);
    for (const [k, v] of new URLSearchParams(call.body)) seen[k] = v;
    assert.deepEqual(seen, {
      grant_type: "authorization_code",
      code: "THECODE",
      redirect_uri: "http://127.0.0.1:8888/callback",
      client_id: "test-client-id",
      code_verifier: seen.code_verifier,
    });
    assert.equal(createHash("sha256").update(seen.code_verifier).digest("base64url"), chal);
    assert.equal(auth.linked, true);
    const file = path.join(h.dir, "token.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { refresh_token: "RTnew" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(auth.pending, null);
    await assert.rejects(auth.complete(`http://127.0.0.1:8888/callback?code=THECODE&state=${state}`), AuthError, "single use");
  });

  it("refreshes with grant_type=refresh_token and the client id only", async () => {
    h.fake.tokenAnswer = () => json(200, { access_token: "AT1", refresh_token: "RT5", expires_in: 3600 });
    const url = h.app.auth.authorizeUrl();
    await h.app.auth.complete(`http://127.0.0.1:8888/callback?code=C&state=${new URL(url).searchParams.get("state")}`);
    h.fake.tokenAnswer = null;
    await h.app.auth.access(true);
    const body = Object.fromEntries(new URLSearchParams(h.fake.calls.at(-1)!.body));
    assert.deepEqual(body, { grant_type: "refresh_token", refresh_token: "RT5", client_id: "test-client-id" });
  });
});
