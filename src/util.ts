/* Plumbing shared by the rest: a clock (tests replace it), an HTTP client over an injectable fetch, files, logging. */
import fs from "node:fs";
import path from "node:path";

export interface Clock {
  /** epoch milliseconds */
  wall(): number;
  /** monotonic milliseconds */
  mono(): number;
}

export const systemClock: Clock = {
  wall: () => Date.now(),
  mono: () => performance.now(),
};

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** Network trouble (DNS, connect, TLS, timeout, a broken body): the request may be retried later. */
export class NetworkError extends Error {}

export async function request(
  fetchFn: FetchFn,
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method,
      headers: opts.headers,
      body: opts.body,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
  } catch (e) {
    throw new NetworkError(errName(e));
  }
  let body: Buffer;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new NetworkError("reading the body: " + errName(e));
  }
  if (opts.maxBytes !== undefined && body.length > opts.maxBytes) throw new NetworkError("answer too large");
  return { status: res.status, headers: res.headers, body };
}

export function errName(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause ? ` (${String((cause as { code: unknown }).code)})` : "";
    return `${e.name}: ${e.message}${code}`;
  }
  return String(e);
}

export function jsonOf(res: HttpResult): unknown {
  if (!res.body.length) return null;
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch {
    return null;
  }
}

/** Whether dir sits on its own mount (a volume) rather than the container's own disk, which a redeploy wipes: some
 *  directory from dir up to (not including) / is on a different device from its parent. null when it can't tell. */
export function onVolume(dir: string): boolean | null {
  try {
    for (let d = path.resolve(dir); d !== path.dirname(d); d = path.dirname(d)) {
      if (fs.statSync(d).dev !== fs.statSync(path.dirname(d)).dev) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/** Atomic write, readable by the owner only. */
export function writePrivate(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log.warn(`${file}: unreadable (${errName(e)})`);
    return undefined;
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Never pass tokens, codes or the API key to these. */
export const log = {
  quiet: false,
  info(msg: string) {
    if (!log.quiet) console.log(`${stamp()} INFO ${msg}`);
  },
  warn(msg: string) {
    if (!log.quiet) console.warn(`${stamp()} WARN ${msg}`);
  },
  error(msg: string) {
    if (!log.quiet) console.error(`${stamp()} ERROR ${msg}`);
  },
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
