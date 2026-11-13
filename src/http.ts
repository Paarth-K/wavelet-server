/* The HTTP front. Every route but /healthz needs the API key: /api/* in the X-Wavelet-Key header, the admin page as the
 * password of HTTP Basic (any user name). Auth looks only at the request's own headers, never at X-Forwarded-*. */
import http from "node:http";
import { renderAdmin } from "./admin.js";
import type { App } from "./app.js";
import { callbackPath } from "./config.js";
import { AuthError, sameText } from "./spotify.js";
import { GEO_LIMITS, type Geo, type Snapshot } from "./state.js";
import { errName, log } from "./util.js";

export const MAX_BODY = 8 * 1024;
export const MAX_WAIT_S = 25;
const ADMIN_POSTS = new Set(["/link", "/unlink", "/geo"]);
const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

type Res = http.ServerResponse;

function send(req: http.IncomingMessage, res: Res, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
    Connection: "close",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(req.method === "HEAD" ? undefined : buf);
}

const text = (req: http.IncomingMessage, res: Res, status: number, body: string, extra: Record<string, string> = {}) =>
  send(req, res, status, body, "text/plain; charset=utf-8", extra);

/** JSON as protocol.md shows it: UTF-8, and the geometry's float fields always with a decimal point (14.0, not 14). */
export function stateJson(s: Snapshot): string {
  const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
  const g = s.geo;
  const geo = `{"s3_left_mm":${f(g.s3_left_mm)},"gap_mm":${f(g.gap_mm)},"drop_ms":${Math.round(g.drop_ms)},"exit_ms":${Math.round(g.exit_ms)},"back":${f(g.back)}}`;
  const rest = JSON.stringify({ v: s.v, server_ms: s.server_ms, linked: s.linked, playing: s.playing, track: s.track, queue: s.queue });
  return `${rest.slice(0, -1)},"geo":${geo}}`;
}

function header(req: http.IncomingMessage, name: string): string {
  const h = req.headers[name];
  return Array.isArray(h) ? h.join(",") : (h ?? "");
}

function apiKeyOk(app: App, req: http.IncomingMessage): boolean {
  return sameText(header(req, "x-wavelet-key"), app.cfg.apiKey);
}

function basicOk(app: App, req: http.IncomingMessage): boolean {
  const m = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header(req, "authorization"));
  if (!m) return sameText("", app.cfg.apiKey); // same work either way
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return sameText(colon >= 0 ? decoded.slice(colon + 1) : "", app.cfg.apiKey);
}

class TooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY) return Promise.reject(new TooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        req.removeAllListeners("data");
        req.pause();
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createHandler(app: App) {
  // Spotify's redirect lands on /callback (and on the redirect URI's own path, when it points at this server)
  const callbacks = new Set(["/callback", callbackPath(app.cfg.redirectUri)].filter((p) => p !== "/" && !p.startsWith("/api/") && p !== "/healthz" && !ADMIN_POSTS.has(p)));
  const adminPaths = new Set(["/", ...ADMIN_POSTS, ...callbacks]);
  return async (req: http.IncomingMessage, res: Res): Promise<void> => {
    const raw = req.url ?? "/";
    const qi = raw.indexOf("?");
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    const method = req.method ?? "GET";
    res.on("finish", () => {
      if (res.statusCode >= 400 || !(path.startsWith("/api/") || path === "/healthz"))
        log.info(`${req.socket.remoteAddress ?? "-"} ${method} ${path} ${res.statusCode}`);
    });
    try {
      if (path === "/healthz") {
        if (method !== "GET" && method !== "HEAD") return text(req, res, 405, "", { Allow: "GET, HEAD" });
        return text(req, res, 200, "ok");
      }
      if (path.startsWith("/api/")) {
        if (!apiKeyOk(app, req)) return text(req, res, 401, "");
        if (method !== "GET" && method !== "HEAD") return text(req, res, 405, "", { Allow: "GET" });
        if (path === "/api/state") return await apiState(app, req, res, query);
        const m = /^\/api\/img\/([^/]+)\/([^/]+)$/.exec(path);
        if (m) {
          const r = await app.covers.get(m[1], m[2]);
          if (r.status === 200) return send(req, res, 200, r.body!, "application/octet-stream");
          if (r.status === 503) return text(req, res, 503, "still being made", { "Retry-After": "2" });
          return text(req, res, 404, "unknown image");
        }
        return text(req, res, 404, "not found");
      }
      const admin = adminPaths.has(path);
      if (!basicOk(app, req)) return text(req, res, 401, "", admin ? { "WWW-Authenticate": 'Basic realm="Wavelet", charset="UTF-8"' } : {});
      if (!admin) return text(req, res, 404, "not found");
      if (path === "/") {
        if (method !== "GET" && method !== "HEAD") return text(req, res, 405, "", { Allow: "GET" });
        return send(req, res, 200, renderAdmin(app), "text/html; charset=utf-8", {
          "Content-Security-Policy": ADMIN_CSP,
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        });
      }
      if (callbacks.has(path)) {
        if (method !== "GET") return text(req, res, 405, "", { Allow: "GET" });
        return await spotifyCallback(app, req, res, query);
      }
      if (method !== "POST") return text(req, res, 405, "", { Allow: "POST" });
      return await adminPost(app, req, res, path);
    } catch (e) {
      if (e instanceof TooLarge) return text(req, res, 413, "too large");
      log.error(`${method} ${path}: ${errName(e)}`);
      text(req, res, 500, "internal error");
    }
  };
}

async function apiState(app: App, req: http.IncomingMessage, res: Res, q: URLSearchParams): Promise<void> {
  const vText = q.get("v");
  const v = vText !== null && /^-?\d+$/.test(vText.trim()) ? Number(vText) : null;
  let wait = Number(q.get("wait") ?? 0);
  if (!Number.isFinite(wait)) wait = 0;
  wait = Math.max(0, Math.min(MAX_WAIT_S, wait));
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const snap = await app.state.wait(v, wait * 1000, ac.signal);
  send(req, res, 200, stateJson(snap), "application/json; charset=utf-8");
}

/** Spotify's redirect, when SPOTIFY_REDIRECT_URI points at this server: the state check stands in for the CSRF token. */
async function spotifyCallback(app: App, req: http.IncomingMessage, res: Res, q: URLSearchParams): Promise<void> {
  try {
    await app.auth.completeFromQuery(q);
    app.flash = { kind: "ok", text: "Spotify linked." };
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    app.flash = { kind: "err", text: e.message };
  }
  send(req, res, 303, "", "text/plain; charset=utf-8", { Location: "/", "Referrer-Policy": "no-referrer" });
}

async function adminPost(app: App, req: http.IncomingMessage, res: Res, path: string): Promise<void> {
  const form = new URLSearchParams(await readBody(req));
  const back = () => send(req, res, 303, "", "text/plain; charset=utf-8", { Location: "/" });
  if (!sameText(form.get("csrf") ?? "", app.csrf)) {
    app.flash = { kind: "err", text: "That form was stale. Try again." };
    return back();
  }
  if (path === "/link") {
    try {
      await app.auth.complete(form.get("url") ?? "");
      app.flash = { kind: "ok", text: "Spotify linked." };
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      app.flash = { kind: "err", text: e.message };
    }
  } else if (path === "/unlink") {
    app.unlink();
    app.flash = { kind: "ok", text: "Spotify unlinked." };
  } else if (path === "/geo") {
    const geo = {} as Geo;
    for (const k of Object.keys(GEO_LIMITS) as (keyof Geo)[]) {
      const [int, lo, hi] = GEO_LIMITS[k];
      const t = (form.get(k) ?? "").trim();
      const val = t === "" ? NaN : Number(t);
      if (!Number.isFinite(val) || val < lo || val > hi) {
        app.flash = { kind: "err", text: `Geometry not saved: ${k} must be a number within ${lo} .. ${hi}.` };
        return back();
      }
      geo[k] = int ? Math.round(val) : val;
    }
    app.setGeo(geo);
    app.flash = { kind: "ok", text: `Geometry saved (state version ${app.state.v}).` };
  }
  return back();
}

export function createServer(app: App): http.Server {
  const handler = createHandler(app);
  const srv = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => void handler(req, res));
  srv.headersTimeout = 10_000;
  srv.requestTimeout = 30_000; // the whole request must arrive by then (long-polls wait after it has)
  srv.keepAliveTimeout = 1_000;
  return srv;
}
