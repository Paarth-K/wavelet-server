/* The admin page: status, Spotify linking (paste the failed redirect address), the geometry. Plain HTML, no scripts. */
import type { App } from "./app.js";
import { isLoopbackRedirect } from "./config.js";
import { GEO_LIMITS, type Geo } from "./state.js";

export const VERSION = "1.0.0";

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtMs = (ms: number) => {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function ago(then: number | null, now: number): string {
  if (then === null) return "never";
  const d = Math.max(0, (now - then) / 1000);
  if (d < 90) return `${Math.floor(d)} s ago`;
  if (d < 5400) return `${Math.floor(d / 60)} min ago`;
  return new Date(then).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const CSS = `
body{font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#f6f6f4;color:#1d1d1f}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.sub{color:#6e6e73}p.sub{margin:0 0 16px}
section{background:#fff;border:1px solid #e3e3e0;border-radius:10px;padding:14px 16px}
table{border-collapse:collapse;width:100%}td{padding:4px 0;vertical-align:top}td:first-child{color:#6e6e73;width:9.5em}
ol{margin:4px 0;padding-left:1.4em}code{font:13px ui-monospace,Menlo,monospace;background:#f0f0ed;padding:1px 4px;border-radius:4px;word-break:break-all}
.ok{color:#1a7f37}.warn{color:#b35900}
.flash{padding:10px 14px;border-radius:8px;margin:0 0 16px}.flash.ok{background:#e7f5ea;color:#1d1d1f}.flash.err{background:#fdecea}
input[type=text],input[type=number]{font:inherit;padding:6px 8px;border:1px solid #c9c9c5;border-radius:6px;box-sizing:border-box}
input[type=text]{width:100%}input[type=number]{width:7em}
button,.button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid #1d1d1f;background:#1d1d1f;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.quiet{background:#fff;color:#1d1d1f;border-color:#c9c9c5}
.geo label{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 0}
.row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
p{margin:6px 0}
`;

const GEO_LABELS: Record<keyof Geo, string> = {
  s3_left_mm: "S3 left edge vs main left edge (mm)",
  gap_mm: "Gap, S3 bottom to main top (mm)",
  drop_ms: "Drop duration (ms)",
  exit_ms: "Exit duration (ms)",
  back: "Ease back (overshoot)",
};

export function renderAdmin(app: App): string {
  const st = app.state.snapshot();
  const p = app.poller;
  const now = app.clock.wall();
  const out: string[] = [];
  out.push(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>Wavelet server</title><style>${CSS}</style></head><body><main>`,
    `<h1>Wavelet server</h1><p class=sub>${esc(VERSION)} &middot; <a href="/">refresh</a></p>`,
  );
  if (app.flash) {
    out.push(`<div class="flash ${app.flash.kind}">${esc(app.flash.text)}</div>`);
    app.flash = null;
  }

  const linked = app.auth.linked;
  out.push("<section><table>");
  out.push(`<tr><td>Spotify</td><td>${linked ? "<span class=ok>linked</span>" : "<span class=warn>not linked</span>"}</td></tr>`);
  const tr = st.track;
  if (tr) {
    out.push(
      `<tr><td>Now ${st.playing ? "playing" : "paused"}</td><td><b>${esc(tr.title)}</b><br>${esc(tr.artist)}<br>` +
        `<span class=sub>${fmtMs(tr.progress_ms)} / ${fmtMs(tr.duration_ms)}</span></td></tr>`,
    );
  } else out.push("<tr><td>Now playing</td><td>nothing</td></tr>");
  if (st.queue.length) {
    const items = st.queue.map((q) => `<li>${esc(q.title)} <span class=sub>&middot; ${esc(q.artist)}</span></li>`).join("");
    out.push(`<tr><td>Up next</td><td><ol>${items}</ol></td></tr>`);
  } else out.push("<tr><td>Up next</td><td>nothing</td></tr>");
  out.push(`<tr><td>Last poll</td><td>${esc(ago(p.lastPollWall, now))} (${esc(p.lastResult)})</td></tr>`);
  if (p.backoffUntilWall !== null && p.backoffUntilWall > now)
    out.push(`<tr><td>Backoff</td><td class=warn>${esc(p.backoffReason)}, next try in ${Math.ceil((p.backoffUntilWall - now) / 1000)} s</td></tr>`);
  else out.push("<tr><td>Backoff</td><td>none</td></tr>");
  out.push(`<tr><td>State version</td><td>${st.v} <span class=sub>(changed ${esc(ago(app.state.changedWall, now))})</span></td></tr>`);
  const c = app.covers.stats();
  out.push(
    `<tr><td>Covers</td><td>${c.cached} in memory${c.busy ? `, ${c.busy} in progress` : ""}${c.failed ? `, ${c.failed} failed` : ""}</td></tr>`,
  );
  out.push(`<tr><td>Spotify calls</td><td>${p.calls} since start</td></tr>`);
  out.push("</table></section>");

  const csrf = `<input type=hidden name=csrf value="${esc(app.csrf)}">`;
  out.push("<h2>Spotify</h2><section>");
  if (!linked && !isLoopbackRedirect(app.cfg.redirectUri)) {
    out.push(
      `<p><a class=button href="${esc(app.auth.authorizeUrl())}" rel="noreferrer">Link Spotify</a></p>` +
        "<p>Approve, and Spotify brings you back to this page.</p>",
    );
  } else if (!linked) {
    out.push(
      `<ol><li><a class=button href="${esc(app.auth.authorizeUrl())}" target=_blank rel="noopener noreferrer">Link Spotify</a> (opens a new tab)</li>` +
        `<li>Approve. The browser then fails to open <code>${esc(app.cfg.redirectUri)}</code>: that is expected.</li>` +
        "<li>Copy that whole address from the address bar and paste it here:</li></ol>",
      `<form method=post action="/link">${csrf}<input type=text name=url autocomplete=off ` +
        `placeholder="${esc(app.cfg.redirectUri)}?code=...&amp;state=..."><div class=row><button>Finish linking</button></div></form>`,
    );
  } else {
    out.push(
      "<p>Linked. The refresh token is kept in <code>token.json</code> in the data directory.</p>",
      `<form method=post action="/unlink" class=row>${csrf}<button class=quiet>Unlink</button></form>`,
    );
  }
  out.push("</section>");

  out.push(`<h2>Geometry</h2><section><form method=post action="/geo" class=geo>${csrf}`);
  for (const k of Object.keys(GEO_LIMITS) as (keyof Geo)[]) {
    const [int, lo, hi] = GEO_LIMITS[k];
    out.push(
      `<label>${esc(GEO_LABELS[k])} <input type=number name=${k} value="${esc(st.geo[k])}" min="${lo}" max="${hi}" step="${int ? "1" : "0.01"}" required></label>`,
    );
  }
  out.push("<div class=row><button>Save</button></div></form></section>");
  out.push("</main></body></html>");
  return out.join("");
}
