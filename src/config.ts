/* Configuration, from environment variables only (the repository is public: no secrets in code). */
import path from "node:path";

export interface Config {
  apiKey: string;
  clientId: string;
  /** optional: with it the token endpoint is called with HTTP Basic client authentication, without it plain PKCE */
  clientSecret: string | null;
  redirectUri: string;
  port: number;
  host: string;
  dataDir: string;
}

export class ConfigError extends Error {}

/** A redirect URI on the loopback address is not served by this server: the user pastes the failed address instead. */
export function isLoopbackRedirect(uri: string): boolean {
  const h = new URL(uri).hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

/** The path on this server that Spotify's redirect lands on (when the redirect URI points here). */
export function callbackPath(uri: string): string {
  return new URL(uri).pathname || "/callback";
}

export const MIN_KEY_LENGTH = 64;
const PRINTABLE = /^[\x21-\x7e]+$/; // visible ASCII: safe in a header and in HTTP Basic

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.WAVELET_API_KEY ?? "";
  if (!apiKey) throw new ConfigError("WAVELET_API_KEY is not set (it must be at least 64 characters)");
  if (apiKey.length < MIN_KEY_LENGTH)
    throw new ConfigError(`WAVELET_API_KEY is too short: at least ${MIN_KEY_LENGTH} characters are required`);
  if (!PRINTABLE.test(apiKey)) throw new ConfigError("WAVELET_API_KEY must be printable ASCII without spaces");
  const clientId = (env.SPOTIFY_CLIENT_ID ?? "").trim();
  if (!clientId) throw new ConfigError("SPOTIFY_CLIENT_ID is not set");
  const clientSecret = (env.SPOTIFY_CLIENT_SECRET ?? "").trim() || null;
  if (clientSecret !== null && !PRINTABLE.test(clientSecret)) throw new ConfigError("SPOTIFY_CLIENT_SECRET must be printable ASCII");
  const redirectUri = (env.SPOTIFY_REDIRECT_URI ?? "").trim() || "http://127.0.0.1:8888/callback";
  let ru: URL;
  try {
    ru = new URL(redirectUri);
  } catch {
    throw new ConfigError("SPOTIFY_REDIRECT_URI is not a URL");
  }
  if (ru.protocol !== "http:" && ru.protocol !== "https:") throw new ConfigError("SPOTIFY_REDIRECT_URI must be http(s)");
  const portText = (env.PORT ?? "").trim() || "3000";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new ConfigError(`PORT is not a port number: ${portText}`);
  const host = (env.HOST ?? "").trim() || "0.0.0.0";
  const dataDir = path.resolve((env.DATA_DIR ?? "").trim() || "./data");
  return { apiKey, clientId, clientSecret, redirectUri, port, host, dataDir };
}
