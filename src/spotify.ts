/* Spotify: sign-in with PKCE (no client secret), token refresh, and parsing of tracks and episodes. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App } from "./app.js";
import { artKey } from "./texture.js";
import { HttpResult, jsonOf, log, readJson, request, writePrivate } from "./util.js";

export const API = "https://api.spotify.com/v1";
export const CURRENTLY_PLAYING_URL = `${API}/me/player/currently-playing?additional_types=track,episode`;
export const QUEUE_URL = `${API}/me/player/queue`;
export const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SCOPES = "user-read-currently-playing user-read-playback-state";

export class NotLinked extends Error {
  constructor() {
    super("not linked");
  }
}
export class RateLimited extends Error {
  constructor(readonly retryAfterS: number | null, readonly quota: boolean) {
    super(quota ? "429 QUOTA_EXCEEDED" : "429");
  }
}
export class TransientError extends Error {}
export class AuthError extends Error {}

export function retryAfterS(res: HttpResult): number | null {
  const h = res.headers.get("retry-after");
  if (h === null || h.trim() === "") return null;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function rateLimited(res: HttpResult): RateLimited {
  return new RateLimited(retryAfterS(res), res.body.includes("QUOTA_EXCEEDED"));
}

export function errorCode(res: HttpResult): string {
  const j = jsonOf(res) as { error?: unknown } | null;
  if (!j || typeof j !== "object") return "";
  const e = j.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { reason?: unknown; message?: unknown };
    return String(o.reason ?? o.message ?? "");
  }
  return "";
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function sameText(a: string, b: string): boolean {
  // constant time whatever the lengths: compare digests
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

interface Pending {
  verifier: string;
  state: string;
  at: number;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export class SpotifyAuth {
  static readonly PENDING_TTL_MS = 30 * 60 * 1000;
  refreshToken: string | null = null;
  accessToken: string | null = null;
  private accessUntil = 0;
  pending: Pending | null = null;
  private readonly file: string;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly app: App) {
    this.file = path.join(app.cfg.dataDir, "token.json");
    const j = readJson(this.file) as { refresh_token?: unknown } | undefined;
    if (j && typeof j.refresh_token === "string" && j.refresh_token) this.refreshToken = j.refresh_token;
  }

  get linked(): boolean {
    return this.refreshToken !== null;
  }

  private save(): void {
    if (this.refreshToken) writePrivate(this.file, JSON.stringify({ refresh_token: this.refreshToken }) + "\n");
    else fs.rmSync(this.file, { force: true });
  }

  authorizeUrl(): string {
    const now = this.app.clock.mono();
    if (!this.pending || now - this.pending.at > SpotifyAuth.PENDING_TTL_MS)
      this.pending = { verifier: b64url(randomBytes(48)), state: b64url(randomBytes(16)), at: now };
    const challenge = b64url(createHash("sha256").update(this.pending.verifier, "ascii").digest());
    const q = new URLSearchParams({
      client_id: this.app.cfg.clientId,
      response_type: "code",
      redirect_uri: this.app.cfg.redirectUri,
      code_challenge_method: "S256",
      code_challenge: challenge,
      scope: SCOPES,
      state: this.pending.state,
    });
    return `${AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`;
  }

  /** Finish linking from the pasted (failed) redirect address. */
  async complete(pasted: string): Promise<void> {
    const text = (pasted ?? "").trim();
    const qi = text.indexOf("?");
    let query = qi >= 0 ? text.slice(qi + 1) : text;
    const hash = query.indexOf("#");
    if (hash >= 0) query = query.slice(0, hash);
    return this.completeFromQuery(new URLSearchParams(query));
  }

  /** Finish linking from the redirect's query (code, state, or error): pasted, or landing on this server's callback. */
  async completeFromQuery(params: URLSearchParams): Promise<void> {
    if (params.get("error")) throw new AuthError(`Spotify said: ${params.get("error")}`);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) throw new AuthError("That address has no code and state in it. Paste the whole address from the address bar.");
    const p = this.pending;
    if (!p || !sameText(state, p.state))
      throw new AuthError("That sign-in is not the latest one from this page. Use the link on this page again.");
    if (this.app.clock.mono() - p.at > SpotifyAuth.PENDING_TTL_MS) {
      this.pending = null;
      throw new AuthError("That sign-in link expired. Use the new link on this page.");
    }
    let res: HttpResult;
    try {
      res = await this.postToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.app.cfg.redirectUri,
        client_id: this.app.cfg.clientId,
        code_verifier: p.verifier,
      });
    } catch {
      throw new AuthError("Could not reach Spotify. Try again.");
    }
    if (res.status !== 200) throw new AuthError(`Spotify refused the code (HTTP ${res.status} ${errorCode(res)}). Use the link again.`);
    const j = (jsonOf(res) ?? {}) as TokenAnswer;
    if (!j.refresh_token || !j.access_token) throw new AuthError("Spotify's answer had no tokens.");
    this.pending = null;
    this.take(j);
    this.save();
    log.info("Spotify linked");
    this.app.onLinked();
  }

  unlink(): void {
    this.refreshToken = null;
    this.accessToken = null;
    this.accessUntil = 0;
    this.save();
    log.info("Spotify unlinked");
  }

  /** The token endpoint. With a client secret: HTTP Basic client authentication (the client id moves from the form to
   *  the header); without one: PKCE, the client id in the form. A code_verifier is sent either way when there is one. */
  private postToken(form: Record<string, string>): Promise<HttpResult> {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    const { clientId, clientSecret } = this.app.cfg;
    const body = { ...form };
    if (clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
      delete body.client_id;
    }
    return request(this.app.fetch, "POST", TOKEN_URL, { headers, body: new URLSearchParams(body).toString(), timeoutMs: 15000 });
  }

  private take(j: TokenAnswer): void {
    this.accessToken = j.access_token!;
    const life = Number(j.expires_in) || 3600;
    this.accessUntil = this.app.clock.mono() + Math.max(60, life - 60) * 1000;
    if (j.refresh_token) this.refreshToken = j.refresh_token;
  }

  /** A valid access token, refreshed when it has expired (or when forced, after a 401). */
  async access(forceRefresh = false): Promise<string> {
    if (!this.refreshToken) throw new NotLinked();
    if (!forceRefresh && this.accessToken && this.app.clock.mono() < this.accessUntil) return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const rt = this.refreshToken;
    if (!rt) throw new NotLinked();
    const res = await this.postToken({ grant_type: "refresh_token", refresh_token: rt, client_id: this.app.cfg.clientId });
    if (res.status === 200) {
      const j = (jsonOf(res) ?? {}) as TokenAnswer;
      if (!j.access_token) throw new TransientError("token refresh: no access token in the answer");
      if (this.refreshToken !== rt) throw new NotLinked(); // unlinked meanwhile
      this.take(j);
      if (this.refreshToken !== rt) this.save();
      return this.accessToken!;
    }
    if (res.status === 400 && errorCode(res) === "invalid_grant") {
      log.warn("Spotify refused the refresh token (invalid_grant): needs linking again");
      this.refreshToken = null;
      this.accessToken = null;
      this.save();
      throw new NotLinked();
    }
    if (res.status === 429) throw rateLimited(res);
    throw new TransientError(`token refresh: HTTP ${res.status} ${errorCode(res)}`);
  }
}

// ---- tracks and episodes

export interface Item {
  id: string;
  title: string;
  artist: string;
  duration_ms: number;
  art: string | null;
}

interface SpotifyImage {
  url?: string;
  width?: number | null;
  height?: number | null;
}

export function largestImage(images: unknown): string | null {
  let best: string | null = null;
  let bestArea = -1;
  if (!Array.isArray(images)) return null;
  for (const im of images as SpotifyImage[]) {
    if (!im || typeof im !== "object" || !im.url) continue;
    const area = (im.width ?? 0) * (im.height ?? 0);
    if (area > bestArea) {
      best = im.url;
      bestArea = area;
    }
  }
  return best;
}

/** A Spotify track or episode -> the public item and its cover URL. */
export function parseItem(item: unknown): { item: Item; url: string | null } | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, any>;
  const id = it.id || it.uri; // local files have no id
  if (!id || typeof id !== "string") return null;
  let artist: string;
  let url: string | null;
  if (it.type === "episode") {
    const show = (it.show ?? {}) as Record<string, unknown>;
    artist = typeof show.name === "string" ? show.name : "";
    url = largestImage(it.images) ?? largestImage(show.images);
  } else {
    const artists = Array.isArray(it.artists) ? it.artists : [];
    artist = artists
      .map((a: unknown) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
      .filter((n: unknown): n is string => typeof n === "string" && n !== "")
      .join(", ");
    url = largestImage(it.album?.images);
  }
  return {
    item: {
      id,
      title: typeof it.name === "string" ? it.name : "",
      artist,
      duration_ms: Math.max(0, Math.trunc(Number(it.duration_ms) || 0)),
      art: url ? artKey(url) : null,
    },
    url,
  };
}
