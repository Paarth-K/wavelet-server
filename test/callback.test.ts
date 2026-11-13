import assert from "node:assert/strict";
import type http from "node:http";
import { afterEach, describe, it } from "node:test";
import { createServer } from "../src/http.js";
import { TOKEN_URL } from "../src/spotify.js";
import { type Harness, hit, json, makeApp } from "./helpers.js";

const REDIRECT = "https://wavelet.example.com/callback";

describe("client secret and the /callback route", () => {
  let h: Harness;
  let srv: http.Server | null = null;
  let port = 0;
  const basic = (pw: string) => `Basic ${Buffer.from(`me:${pw}`).toString("base64")}`;
  async function serve(opts: Parameters<typeof makeApp>[0]) {
    h = makeApp(opts);
    srv = createServer(h.app);
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    port = (srv.address() as { port: number }).port;
  }
  afterEach(async () => {
    if (srv) {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv!.close(() => r()));
      srv = null;
    }
    await h.cleanup();
  });

  it("with a secret: HTTP Basic client auth on exchange and refresh, PKCE kept", async () => {
    await serve({ linked: false, clientSecret: "the-secret" });
    const url = h.app.auth.authorizeUrl();
    const q = new URL(url).searchParams;
    assert.equal(q.get("code_challenge_method"), "S256", "the S256 challenge stays in the authorize URL");
    h.fake.tokenAnswer = () => json(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600 });
    await h.app.auth.complete(`http://127.0.0.1:8888/callback?code=C&state=${q.get("state")}`);
    let call = h.fake.calls.at(-1)!;
    assert.equal(call.url, TOKEN_URL);
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from("test-client-id:the-secret").toString("base64")}`);
    let body = Object.fromEntries(new URLSearchParams(call.body));
    assert.deepEqual(Object.keys(body).sort(), ["code", "code_verifier", "grant_type", "redirect_uri"]);
    h.fake.tokenAnswer = null;
    await h.app.auth.access(true);
    call = h.fake.calls.at(-1)!;
    assert.ok(call.headers.Authorization.startsWith("Basic "));
    body = Object.fromEntries(new URLSearchParams(call.body));
    assert.deepEqual(body, { grant_type: "refresh_token", refresh_token: "RT1" });
  });

  it("without a secret: no Authorization header, client_id in the form", async () => {
    await serve({ linked: false });
    const q = new URL(h.app.auth.authorizeUrl()).searchParams;
    h.fake.tokenAnswer = () => json(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600 });
    await h.app.auth.complete(`?code=C&state=${q.get("state")}`);
    const call = h.fake.calls.at(-1)!;
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(new URLSearchParams(call.body).get("client_id"), "test-client-id");
  });

  it("GET /callback needs the admin auth, checks state, links and returns to the page", async () => {
    await serve({ linked: false, redirectUri: REDIRECT });
    const key = h.cfg.apiKey;
    let r = await hit(port, "GET", "/callback?code=C&state=x");
    assert.equal(r.status, 401);
    assert.match(String(r.headers["www-authenticate"]), /^Basic /);
    // the page links straight to Spotify, no paste box
    const page = (await hit(port, "GET", "/", { Authorization: basic(key) })).body.toString();
    assert.ok(page.includes("Link Spotify") && !page.includes('name=url'));
    const q = new URL(h.app.auth.authorizeUrl()).searchParams;
    assert.equal(q.get("redirect_uri"), REDIRECT);
    // a wrong state: back to the page with an error, not linked
    r = await hit(port, "GET", "/callback?code=C&state=wrong", { Authorization: basic(key) });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    assert.equal(h.app.auth.linked, false);
    assert.equal(h.fake.nTokens, 0);
    // the real one
    h.fake.tokenAnswer = () => json(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600 });
    r = await hit(port, "GET", `/callback?code=THECODE&state=${q.get("state")}`, { Authorization: basic(key) });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    assert.equal(h.app.auth.linked, true);
    const body = new URLSearchParams(h.fake.calls.at(-1)!.body);
    assert.equal(body.get("code"), "THECODE");
    assert.equal(body.get("redirect_uri"), REDIRECT);
    const after = (await hit(port, "GET", "/", { Authorization: basic(key) })).body.toString();
    assert.ok(after.includes("Spotify linked."));
    // Spotify reporting a refusal
    r = await hit(port, "GET", "/callback?error=access_denied&state=s", { Authorization: basic(key) });
    assert.equal(r.status, 303);
  });

  it("the default loopback redirect keeps the paste box", async () => {
    await serve({ linked: false });
    const page = (await hit(port, "GET", "/", { Authorization: basic(h.cfg.apiKey) })).body.toString();
    assert.ok(page.includes("name=url") && page.includes("target=_blank"));
  });
});
