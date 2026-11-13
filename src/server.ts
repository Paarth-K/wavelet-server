/* Entry point: configuration from the environment, then the HTTP server and the poller. */
import { App } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { VERSION } from "./admin.js";
import { createServer } from "./http.js";
import { log } from "./util.js";

function main(): void {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`wavelet-server: ${e.message}. Not starting.`);
      process.exit(1);
    }
    throw e;
  }
  const app = new App(cfg);
  const srv = createServer(app);
  srv.on("error", (e) => {
    console.error(`wavelet-server: ${e.message}`);
    process.exit(1);
  });
  srv.listen(cfg.port, cfg.host, () => {
    const addr = srv.address();
    const port = addr && typeof addr === "object" ? addr.port : cfg.port;
    log.info(`wavelet server ${VERSION} on http://${cfg.host}:${port} (data ${cfg.dataDir}, Spotify ${app.auth.linked ? "linked" : "not linked"})`);
    app.poller.start();
  });
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: stopping`);
    srv.close();
    srv.closeAllConnections();
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main();
